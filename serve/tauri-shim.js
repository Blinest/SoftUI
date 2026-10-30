/*
 * SoftUI 浏览器桥接桩（tauri-shim）v3 —— 带模拟设备
 *
 * v2 解决的是"白屏"：桩返回 undefined 会让 setSnapshot(undefined) 崩渲染。
 * v3 解决的是"没数据"：这里实现一个**确定性**的 6 腱连续体机械臂仿真，
 * 让曲线、三维位姿、仪表盘真正动起来。
 *
 * 确定性是关键：帧按绝对时间 t 解析计算，不靠累加状态。
 * 好处是无漂移、可任意回看窗口、录制时能直接把区间重算出来。
 *
 * 物理口径与仓库 src/dynamics/svcModel.ts 对齐：
 *   - 6 根腱，cableIndex 0..5，电机 id 1..6，传感器 id 1..6，轴 0
 *   - A 组（偶索引）方位角 0°/120°/240°，B 组（奇索引）60°/180°/300°
 *   - 腱位移 δ = -κ·R·cos(φ-α)，R = cableRadiusM = 0.006 m
 *   - 腱张力 f = max(0, base + amp·cos(φ-α))，量级与 forceBaseN/forceAmpN 一致
 *   - 段长 SEGMENT_LENGTH_M = 0.2225887，弯曲角 = κ·L
 *
 * 还实现了录制（开始/暂停/继续/停止）与回放（加载/播放/暂停/步进/变速）。
 */
(function () {
  if (window.__TAURI_INTERNALS__) return; // 真实 Tauri 环境不覆盖

  var FORCE_LOGIN = /[?&]login=1\b/.test(location.search);
  var SEGMENT_LENGTH_M = 0.2225887;
  var CABLE_RADIUS_M = 0.006;
  var FRAME_INTERVAL_MS = 10;      // 100 Hz
  var CAPACITY = 3000;             // 30 秒环形缓冲
  var DEG = 180 / Math.PI;
  var seq = 0;
  var lastCalls = [];

  /* ── 腱几何 ── */
  var ALPHA = [0, 60, 120, 180, 240, 300].map(function (d) { return (d * Math.PI) / 180; });

  /* 每个腱的激励相位（两组错开，形成平面内扫掠 + 扭转） */
  var PHASE = [0.0, 0.6, 1.2, 1.8, 2.4, 3.0];

  function nowMs() { return Date.now(); }

  /* ── 曲率激励：两段不同周期，产生持续的、非重复的形态 ── */
  function curvatureAt(section, tSec) {
    if (section === 1) {
      // 6.0 s 周期，幅度 1.50 1/m
      var k1 = 0.75 + 0.75 * Math.sin((2 * Math.PI * tSec) / 6.0);
      var phi1 = (2 * Math.PI * tSec) / 9.0;
      return { kappa: k1, phi: phi1 };
    }
    // 4.7 s 周期，幅度 1.20 1/m，方向反着转
    var k2 = 0.6 + 0.6 * Math.sin((2 * Math.PI * tSec) / 4.7 + 1.1);
    var phi2 = -(2 * Math.PI * tSec) / 7.3 + 0.7;
    return { kappa: k2, phi: phi2 };
  }

  /* 张力幅度与位移缩放：用仓库真实推导链反解标定出来的。
   *
   * 踩过的坑（实测数据）：位移与张力**反号**时，模型里这两项会互相抵消 ——
   * 力幅度从 24N 加到 40N，κ 反而从 2.47 降到 1.89，末端位移始终卡在 443~445mm
   * （总长 445mm），等于臂体根本不弯，三维视图看着就是不动。
   *
   * 同号后标定结果：base=0、amp=20N、dscale=0.3 → κmax 0.30~1.65 1/m
   * （模型 60N 档上限约 1.73，留了余量），末端扫掠 92.7mm，肉眼可见。 */
  var FORCE_AMP_N = 20.0;
  var DISP_SCALE = 0.3;

  /* 某根腱在时刻 t 的位移（mm）与张力（N） */
  function tendonAt(cableIndex, tSec, section) {
    var c = curvatureAt(section, tSec);
    var a = ALPHA[cableIndex] + PHASE[cableIndex] + c.phi;
    var cosA = Math.cos(a);
    var dispMm = c.kappa * CABLE_RADIUS_M * cosA * 1000 * DISP_SCALE;  // 米 → 毫米
    var forceN = Math.max(0, FORCE_AMP_N * cosA);                      // 张力恒非负
    return { dispMm: dispMm, forceN: forceN, cosA: cosA };
  }

  function motorAt(cableIndex, tSec, section) {
    var h = 0.005;
    var p0 = tendonAt(cableIndex, tSec - h, section).dispMm;
    var p1 = tendonAt(cableIndex, tSec + h, section).dispMm;
    var v = (p1 - p0) / (2 * h);                                // mm/s
    var p0b = tendonAt(cableIndex, tSec - 2 * h, section).dispMm;
    var p1b = tendonAt(cableIndex, tSec + 2 * h, section).dispMm;
    var a = (p1b - 2 * tendonAt(cableIndex, tSec, section).dispMm + p0b) / (4 * h * h);
    return { pos: tendonAt(cableIndex, tSec, section).dispMm, vel: v, acc: a };
  }

  function noise(seed) {
    // 确定性伪随机，避免每帧抖动导致曲线毛刺不一致
    var x = Math.sin(seed * 12.9898) * 43758.5453;
    return (x - Math.floor(x)) - 0.5;
  }

  var T0 = nowMs();
  function makeFrame(tMs) {
    var tSec = (tMs - T0) / 1000;
    var motors = [];
    var sensors = [];
    for (var c = 0; c < 6; c++) {
      // 前 3 根张力腱主要驱动第 1 段，后 3 根叠加驱动第 2 段
      var section = c % 2 === 0 ? 1 : 2;
      var m = motorAt(c, tSec, section);
      motors.push({
        id: c + 1,
        positionMm: m.pos,
        velocityMmPerSec: m.vel,
        accelerationMmPerSec2: m.acc,
        running: true,
        targetPositionMm: m.pos,
      });
      var t = tendonAt(c, tSec, section);
      var n = noise(tMs / FRAME_INTERVAL_MS + c * 17) * 0.6;
      var f = t.forceN;
      sensors.push({
        id: c + 1,
        // 与真实状态帧一样只给两个数：rawValue = 原始值，filteredValue = 滤波+平衡后。
        rawValue: f + n * 2,
        filteredValue: f + n,
        unit: "N",
        quality: "ok",
      });
    }

    var k1 = curvatureAt(1, tSec);
    var k2 = curvatureAt(2, tSec);
    var ang1 = k1.kappa * SEGMENT_LENGTH_M * DEG;
    var ang2 = k2.kappa * SEGMENT_LENGTH_M * DEG;
    function dirOf(phi) {
      var d = ((phi * DEG) % 360 + 360) % 360;
      if (d < 45 || d >= 315) return "right";
      if (d < 135) return "down";
      if (d < 225) return "left";
      return "up";
    }

    return {
      deviceId: "serial:SIM-01",
      connectionId: "conn-sim-01",
      receivedAtMs: tMs,
      sequence: Math.floor((tMs - T0) / FRAME_INTERVAL_MS),
      protocolVersion: "SIM-V1",
      systemEnabled: true,
      motors: motors,
      sensors: sensors,
      bend: {
        section1: { angleDeg: ang1, targetAngleDeg: ang1, direction: dirOf(k1.phi), quality: "ok" },
        section2: { angleDeg: ang2, targetAngleDeg: ang2, direction: dirOf(k2.phi), quality: "ok" },
      },
      quality: { status: "ok", latencyMs: 3, droppedFrames: 0, checksumOk: true },
    };
  }

  /* ── 录制 / 回放状态 ── */
  var connected = true;
  var sessions = [];                  // SessionInfo[]
  var recFrames = [];                 // 录制中的帧
  var recorder = { active: false, sessionId: "", sessionName: "", paused: false, startMs: 0, pausedMs: 0, pauseStartMs: 0 };
  var playback = { active: false, sessionId: "", playing: false, speed: 1, cursorMs: 0, frames: [], lastTick: 0 };

  function pushLog(level, scope, message) {
    snapshot.logs = [
      { id: ++seq, level: level, scope: scope, message: message, timestampMs: nowMs() },
    ].concat(snapshot.logs).slice(0, 200);
  }

  /* ── 当前该出哪一帧：回放中则取回放帧，否则走实时仿真 ── */
  function liveFrameAt(tMs) {
    if (playback.active && playback.frames.length > 0) {
      var idx = Math.round(playback.cursorMs / FRAME_INTERVAL_MS);
      idx = Math.max(0, Math.min(playback.frames.length - 1, idx));
      return playback.frames[idx];
    }
    return makeFrame(tMs);
  }

  function advancePlayback() {
    if (!playback.active || !playback.playing) return;
    var now = nowMs();
    if (playback.lastTick) {
      playback.cursorMs += (now - playback.lastTick) * playback.speed;
    }
    playback.lastTick = now;
    var dur = playback.frames.length * FRAME_INTERVAL_MS;
    if (playback.cursorMs >= dur) {
      playback.cursorMs = dur;
      playback.playing = false;
    }
  }

  function playbackStatus() {
    var dur = playback.frames.length * FRAME_INTERVAL_MS;
    var idx = Math.round(playback.cursorMs / FRAME_INTERVAL_MS);
    idx = Math.max(0, Math.min(Math.max(playback.frames.length - 1, 0), idx));
    return {
      active: playback.active,
      sessionId: playback.sessionId,
      playing: playback.playing,
      speed: playback.speed,
      cursorMs: playback.cursorMs,
      durationMs: dur,
      cursorPct: dur > 0 ? (playback.cursorMs / dur) * 100 : 0,
      totalFrames: playback.frames.length,
      currentFrameIdx: idx,
    };
  }

  function liveStats() {
    var elapsed = Math.max(0, (nowMs() - T0) / 1000);
    var total = Math.floor(elapsed * (1000 / FRAME_INTERVAL_MS));
    return {
      storedFrames: Math.min(CAPACITY, total),
      capacity: CAPACITY,
      totalFrames: total,
      droppedFrames: 0,
      frameRateHz: playback.active ? playback.speed * (1000 / FRAME_INTERVAL_MS) : 1000 / FRAME_INTERVAL_MS,
    };
  }

  function defaultLogs() {
    var t = nowMs();
    return [
      { id: 3, level: "info", scope: "device", message: "模拟设备 serial:SIM-01 已就绪，100 Hz 出帧", timestampMs: t },
      { id: 2, level: "info", scope: "connection", message: "模拟器握手完成", timestampMs: t - 6000, deviceId: "serial:SIM-01" },
      { id: 1, level: "info", scope: "boot", message: "SoftUI 网页预览模式就绪", timestampMs: t - 12000 },
    ];
  }

  function makeSnapshot() {
    var stats = liveStats();
    var frame = makeFrame(nowMs());
    var state = connected ? "ready" : "idle";
    return {
      appInfo: {
        name: "SoftUI",
        version: "0.1.0",
        backend: "Browser simulator (no Rust)",
        frontend: "React + TypeScript",
        platform: navigator.platform || "web",
      },
      theme: "dark",
      connection: {
        state: state,
        activeProfileId: "sim-default",
        activeProfileName: "Simulator",
        profiles: [
          { id: "sim-default", name: "Simulator (100 Hz)", port: "SIM-01", baudRate: 115200, dataBits: 8, parity: "none", stopBits: 1, flowControl: "none", autoReconnect: true },
        ],
        ports: ["SIM-01"],
        handshakeStep: connected ? "online" : "awaiting connection",
        handshakeProgress: connected ? 100 : 0,
        lastMessage: connected ? "模拟数据流：100 Hz" : "已断开",
      },
      dashboard: {
        deviceCount: connected ? 1 : 0,
        connectedDevices: connected ? 1 : 0,
        currentSession: recorder.active ? recorder.sessionName : "",
        sampleRateHz: Math.round(stats.frameRateHz),
        frameRateHz: Math.round(stats.frameRateHz),
        activeProfile: "sim-default",
        lastError: null,
      },
      live: { selectedDeviceId: connected ? "serial:SIM-01" : "", latest: connected ? frame : null },
      model: {
        id: "default-continuum",
        name: "Default continuum robot",
        modelPath: "resources/models/default_robot.glb",
        section1MaxAngleDeg: 78,
        section2MaxAngleDeg: 64,
        section1Node: "section_1_root",
        section2Node: "section_2_root",
      },
      calibration: { selectedSection: "section1", targetAngles: [0, 0], captured: false, steps: [] },
      playback: {
        activeSessionId: playback.sessionId,
        speed: playback.speed,
        cursorMs: playback.cursorMs,
        durationMs: playback.frames.length * FRAME_INTERVAL_MS,
        sessions: [],
      },
      playbackMode: playback.active,
      controlProfiles: [],
      filterProfiles: [],
      logs: snapshot ? snapshot.logs : defaultLogs(),
      settings: {
        theme: snapshot ? snapshot.settings.theme : "dark",
        workspaceDensity: "comfortable",
        saveLayoutOnExit: true,
        autoReconnect: true,
        diagnosticsLevel: "info",
        dataDirectory: "experiment_data",
        modelDirectory: "resources/models",
      },
      runtimeDiagnostics: {
        storedFrames: stats.storedFrames,
        liveCapacity: stats.capacity,
        totalFrames: stats.totalFrames,
        droppedFrames: stats.droppedFrames,
        frameRateHz: Math.round(stats.frameRateHz),
        deviceCount: connected ? 1 : 0,
        pendingCommands: 0,
        sentCommands: 0,
        protocolErrors: 0,
        reconnectAttempts: 0,
        emergencyLatched: false,
        lastError: null,
      },
      controlRuntime: {
        pid: { kp: 0.8, ki: 0.05, kd: 0.02, deadbandCurvaturePerM: 0.02, integralLimit: 5, outputLimit: 10, samplePeriodMs: 10 },
        cycle: { enabled: false, lowerCurvaturePerM: 0.2, upperCurvaturePerM: 1.4, toleranceCurvaturePerM: 0.05, dwellMs: 500, maxCycles: 100 },
        phase: "idle", active: false, allowed: connected, reason: connected ? "" : "设备未连接",
        targetCurvaturePerM: 0, pidOutput: 0, motorDeltaMm: 0, cyclesCompleted: 0,
      },
      authSession: {
        authenticated: !FORCE_LOGIN,
        username: FORCE_LOGIN ? "" : "web-preview",
        role: "admin",
        permissions: [],
        mustChangePassword: false,
      },
    };
  }

  var snapshot = makeSnapshot();

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function frameWindow(count) {
    var n = Math.max(1, Math.min(CAPACITY, count || 240));
    var out = [];
    var end = playback.active ? playback.cursorMs : nowMs() - T0;
    for (var i = n - 1; i >= 0; i--) {
      var tRel = end - i * FRAME_INTERVAL_MS;
      if (playback.active) {
        var idx = Math.max(0, Math.min(playback.frames.length - 1, Math.round(tRel / FRAME_INTERVAL_MS)));
        out.push(playback.frames[idx]);
      } else {
        out.push(makeFrame(T0 + tRel));
      }
    }
    return out;
  }

  var EMPTY_LISTS = ["list_users", "list_clients", "list_serial_ports", "list_connection_profiles", "read_session_frames", "playback_get_window", "playback_commands"];

  var HANDLERS = {
    bootstrap_state: function () { return clone(snapshot); },
    tick_snapshot: function () { return clone(snapshot); },

    login: function () {
      snapshot.authSession = { authenticated: true, username: "web-preview", role: "admin", permissions: [], mustChangePassword: false };
      // 形状必须与后端 `auth::LoginResult` 一致，否则仿真模式下页面取不到 session
      return {
        token: "sim-" + nowMs(),
        session: clone(snapshot.authSession),
        deviceLimit: 0,
        activeDevices: 1,
      };
    },
    logout: function () {
      snapshot.authSession = { authenticated: false, username: "", role: "operator", permissions: [], mustChangePassword: false };
      return null;
    },
    current_auth_session: function () { return clone(snapshot.authSession); },
    change_password: function () { return null; },

    /* ── 实时数据 ── */
    fetch_live_latest: function () {
      if (!connected) return { selectedDeviceId: "", latest: null, stats: liveStats() };
      return { selectedDeviceId: "serial:SIM-01", latest: liveFrameAt(nowMs()), stats: liveStats() };
    },
    fetch_live_stats: function () { return liveStats(); },
    fetch_live_window: function (args) {
      if (!connected) return [];
      return frameWindow(args && args.count);
    },

    /* ── 设备 ── */
    list_connected_devices: function () {
      if (!connected) return [];
      return [{ deviceId: "serial:SIM-01", connectionId: "conn-sim-01", portName: "SIM-01", baudRate: 115200, state: "ready", connectedAtMs: T0 }];
    },
    device_runtime_status: function () {
      var s = liveStats();
      return {
        state: connected ? "ready" : "idle",
        controlEnabled: true,
        receivedFrames: s.totalFrames,
        protocolErrors: 0,
        sentCommands: 0,
        pendingCommands: 0,
        reconnectAttempts: 0,
        lastFrameMs: nowMs(),
        lastCommandMs: nowMs(),
        commandHighWatermark: 0,
        emergencyLatched: false,
        lastError: null,
        lastErrorCode: null,
      };
    },
    connect_device: function () { connected = true; pushLog("info", "connection", "设备已连接 (SIM-01)"); return clone(makeSnapshot()); },
    disconnect_device: function () { connected = false; pushLog("warn", "connection", "设备已断开"); return clone(makeSnapshot()); },
    toggle_connection: function () { connected = !connected; return clone(makeSnapshot()); },
    list_serial_ports: function () {
      return [{ portName: "SIM-01", portType: "virtual", description: "SoftUI 模拟设备", manufacturer: "SoftUI", product: "Continuum Simulator", serialNumber: "SIM-0001", vid: null, pid: null, likelyAvailable: true }];
    },

    /* ── 录制 ── */
    start_recording: function () {
      var t = nowMs();
      recorder = {
        active: true, paused: false, startMs: t, pausedMs: 0, pauseStartMs: 0,
        sessionId: "sim-" + t,
        sessionName: "模拟录制 " + new Date(t).toLocaleTimeString("zh-CN", { hour12: false }),
      };
      recFrames = [];
      pushLog("info", "recorder", "开始录制：" + recorder.sessionName);
      return clone(makeSnapshot());
    },
    stop_recording: function () {
      if (!recorder.active) return clone(snapshot);
      var end = nowMs();
      var frameCount = Math.max(1, Math.floor((end - recorder.startMs - recorder.pausedMs) / FRAME_INTERVAL_MS));
      var info = {
        id: recorder.sessionId,
        name: recorder.sessionName,
        startTime: new Date(recorder.startMs).toISOString(),
        endTime: new Date(end).toISOString(),
        deviceId: "serial:SIM-01",
        frameCount: frameCount,
        fileSize: frameCount * 420,
        filePath: "experiment_data/" + recorder.sessionId + ".sim",
        operator: "web-preview",
        notes: "网页预览模式下由浏览器仿真生成的会话",
        tags: ["simulated"],
        deviceIds: ["serial:SIM-01"],
      };
      sessions = [info].concat(sessions);
      pushLog("info", "recorder", "录制结束，共 " + frameCount + " 帧");
      recorder.active = false;
      recorder.paused = false;
      return clone(makeSnapshot());
    },
    pause_recording: function () {
      if (recorder.active && !recorder.paused) {
        recorder.paused = true;
        recorder.pauseStartMs = nowMs();
        pushLog("info", "recorder", "录制已暂停");
      }
      return clone(snapshot);
    },
    resume_recording: function () {
      if (recorder.active && recorder.paused) {
        recorder.paused = false;
        recorder.pausedMs += nowMs() - recorder.pauseStartMs;
        pushLog("info", "recorder", "录制已继续");
      }
      return clone(snapshot);
    },
    recorder_status: function () {
      if (!recorder.active) {
        return { active: false, sessionId: "", sessionName: "", frameCount: 0, elapsedSecs: 0, paused: false };
      }
      var pausedExtra = recorder.paused ? nowMs() - recorder.pauseStartMs : 0;
      var elapsed = (nowMs() - recorder.startMs - recorder.pausedMs - pausedExtra) / 1000;
      return {
        active: true,
        sessionId: recorder.sessionId,
        sessionName: recorder.sessionName,
        frameCount: Math.max(0, Math.floor((elapsed * 1000) / FRAME_INTERVAL_MS)),
        elapsedSecs: Math.max(0, elapsed),
        paused: recorder.paused,
      };
    },
    list_sessions: function () { return clone(sessions); },
    delete_session: function (args) {
      sessions = sessions.filter(function (s) { return s.id !== (args && args.id); });
      pushLog("warn", "session", "已删除会话 " + (args && args.id));
      return clone(makeSnapshot());
    },
    rename_session: function (args) {
      sessions = sessions.map(function (s) {
        return s.id === (args && args.id) ? Object.assign({}, s, { name: (args && args.name) || s.name }) : s;
      });
      return clone(makeSnapshot());
    },
    update_session_metadata: function () { return clone(makeSnapshot()); },

    /* ── 回放：直接从确定性仿真重算区间，不需要真存盘 ── */
    playback_load: function (args) {
      var id = args && args.sessionId;
      var info = null;
      for (var i = 0; i < sessions.length; i++) { if (sessions[i].id === id) { info = sessions[i]; break; } }
      if (!info) return playbackStatus();
      var frames = [];
      var startMs = Date.parse(info.startTime);
      for (var k = 0; k < info.frameCount; k++) {
        frames.push(makeFrame(startMs + k * FRAME_INTERVAL_MS));
      }
      playback = { active: true, sessionId: id, playing: false, speed: 1, cursorMs: 0, frames: frames, lastTick: 0 };
      pushLog("info", "playback", "已加载回放：" + info.name + "（" + frames.length + " 帧）");
      return playbackStatus();
    },
    playback_play: function () { advancePlayback(); playback.playing = true; playback.lastTick = nowMs(); return playbackStatus(); },
    playback_pause: function () { advancePlayback(); playback.playing = false; return playbackStatus(); },
    playback_stop: function () {
      playback = { active: false, sessionId: "", playing: false, speed: 1, cursorMs: 0, frames: [], lastTick: 0 };
      return playbackStatus();
    },
    playback_step_frame: function (args) {
      advancePlayback();
      playback.cursorMs += ((args && args.delta) || 1) * FRAME_INTERVAL_MS;
      playback.cursorMs = Math.max(0, Math.min(playback.frames.length * FRAME_INTERVAL_MS, playback.cursorMs));
      return playbackStatus();
    },
    playback_seek: function (args) {
      advancePlayback();
      playback.cursorMs = Math.max(0, Math.min(playback.frames.length * FRAME_INTERVAL_MS, (args && args.cursorMs) || 0));
      return playbackStatus();
    },
    playback_set_speed: function (args) {
      advancePlayback();
      var sp = (args && args.speed) || 1;
      playback.speed = sp > 0 ? sp : 1;
      playback.lastTick = nowMs();
      return playbackStatus();
    },
    playback_status: function () { advancePlayback(); return playbackStatus(); },
    playback_get_frame: function () { advancePlayback(); return liveFrameAt(nowMs()); },
    playback_recent_window: function (args) { return frameWindow((args && args.count) || 240); },

    /* ── 其它 ── */
    model_status: function () { return clone(snapshot.model); },
    set_theme: function (args) {
      var t = args && args.theme;
      if (t === "light" || t === "dark" || t === "system") {
        snapshot.theme = t;
        snapshot.settings.theme = t;
      }
      return clone(snapshot);
    },
    export_session_csv: function () { return "experiment_data/export.csv"; },
    export_chart_csv: function () { return "experiment_data/chart.csv"; },
    export_diagnostics_bundle: function () { return "experiment_data/diagnostics.zip"; },
    submit_system_control: function () { return clone(makeSnapshot()); },
  };

  /* ── 真后端优先，仿真兜底 ──────────────────────────────────────────
   * Rust 侧 serve 模式暴露 POST /rpc，语义与 Tauri 的 invoke 一一对应。
   * 关键区别：**只有传输层失败才退回仿真**。后端返回的 {ok:false} 是
   * 业务错误（比如密码错），必须原样抛出去，否则登录失败会被仿真掩盖。 */
  var backend = { mode: "unknown", rust: 0, sim: 0, errors: 0, lastError: "" };

  /**
   * 本机解析模式下，用**本机**的计数器纠正后端返回的统计。
   *
   * 为什么必须纠正：`P1_LOCAL_PARSE` 打开时字节**不出浏览器**，后端一帧都收不到 ——
   * 它返回的 `receivedFrames / storedFrames` 结构上恒为 0 ✗。
   * 但界面上「协议 / 帧号」取的是本地快照（正常递增 ✓），「接收帧」「存储帧」取的却是
   * 后端 ✗ —— 于是出现"帧号在涨、两个计数不动"的怪象 ✓。
   * 统计口径必须和解析口径一致：谁在解析，就用谁的数。
   */
  function patchLocalStats(cmd, data) {
    if (!P1_LOCAL_PARSE || !wsActive || !data || typeof data !== "object") return data;
    var local = localStats();
    if (cmd === "device_runtime_status" && typeof data.receivedFrames === "number") {
      data.receivedFrames = local.totalFrames;
      data.protocolErrors = local.droppedFrames;
      if ("unknownFrames" in data) data.unknownFrames = wsUnknownFrames;
      if ("state" in data && local.totalFrames > 0 && data.state === "handshaking") {
        data.state = "ready"; // 本地已经解出帧了，就不该再显示"握手"
      }
    }
    // ⚠️ 「握手中」这个字样来自 **`device.state`**（DeviceCard 直接读连接记录里的
    // state），不是 runtimeStatus.state —— 只改后者界面上没有任何变化。
    // 设备记录、快照里的 connection 都要一起按本机解析结果纠正。
    var devices = Array.isArray(data)
      ? data
      : Array.isArray(data.devices)
        ? data.devices
        : null;
    if (devices) {
      for (var i = 0; i < devices.length; i += 1) {
        var d = devices[i];
        if (d && d.state === "handshaking" && local.totalFrames > 0) d.state = "ready";
      }
    }
    if (data.connection && data.connection.state === "handshaking" && local.totalFrames > 0) {
      data.connection = Object.assign({}, data.connection, { state: "ready" });
    }
    if (data.runtimeDiagnostics && typeof data.runtimeDiagnostics === "object") {
      data.runtimeDiagnostics = Object.assign({}, data.runtimeDiagnostics, {
        storedFrames: local.storedFrames,
        totalFrames: local.totalFrames,
        droppedFrames: local.droppedFrames,
      });
    }
    return data;
  }

  function simInvoke(cmd, args) {
    var out;
    if (Object.prototype.hasOwnProperty.call(HANDLERS, cmd)) {
      try {
        out = HANDLERS[cmd](args, cmd);
        if (out && typeof out === "object" && out.runtimeDiagnostics) {
          out.logs = snapshot.logs;
          out.settings = snapshot.settings;
          out.theme = snapshot.theme;
          snapshot = out;
        }
      } catch (e) {
        console.warn("[tauri-shim] handler 出错:", cmd, e);
        out = null;
      }
    } else if (EMPTY_LISTS.indexOf(cmd) >= 0) {
      out = [];
    } else {
      out = clone(snapshot);
    }
    return out;
  }

  /* 这些命令只在服务端有意义，**绝不能**退回浏览器仿真：
   * 仿真根本不认识它们，只能返回一个快照副本 —— 调用方会以为"成功了"，
   * 实际这次数据变更被静默丢弃（实测踩到过：网络一抖，同步就永久停在旧值）。
   * 只有真正的界面渲染类命令（bootstrap_state / fetch_live_* 等）才该有兜底。 */
  var NO_FALLBACK_CMDS = {
    ui_publish: 1, ui_state: 1, ui_wait: 1,
    drag_publish: 1, drag_latest: 1,
    sync_poll: 1, sync_emit: 1, sync_hello: 1,
    webserial_open: 1, webserial_push: 1, webserial_take_tx: 1, webserial_close: 1,
    simulator_start: 1, simulator_stop: 1,
  };

  /* ── 会话 token：每台设备一份 ──────────────────────────────────────
   * 后端按 token 区分设备，所以必须存**在本机** localStorage 里 ——
   * 存服务端就又变回"全局一份会话"了。同一台设备刷新页面保持登录，
   * 换一台设备各自独立登录：这就是"多设备访问权限"的落点。
   * ───────────────────────────────────────────────────────────────── */
  var TOKEN_KEY = "softui:sessionToken";

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (error) { return ""; }
  }

  function setToken(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (error) { /* 隐私模式下写不了：退化为"每次打开都要重新登录" */ }
  }

  var reregistering = null;

  /** 把"浏览器已开好、但网关重启后丢了登记"的串口重新登记一遍。并发调用只登记一次。 */
  function reregisterDevice() {
    if (!wsActive || !wsActive.port) return Promise.reject(new Error("本端没有已打开的串口"));
    if (!reregistering) {
      reregistering = doRpc(
        "webserial_open",
        {
          portName: wsActive.name,
          baudRate: wsActive.baudRate || 115200,
          clientId: SYNC_ID,
          deviceName: DEVICE_NAME,
        },
        true,
      ).then(
        function (record) { reregistering = null; return record; },
        function (error) { reregistering = null; throw error; },
      );
    }
    return reregistering;
  }

  /**
   * **RPC 耗时统计** ✓ —— 用来回答"指令为什么慢"✗。
   *
   * 控制台：`__SOFTUI_WS__.rpcStats()` → 返回最近 60 条的耗时统计 ✓。
   * 关键判读：如果 `send_*` 类命令的耗时远高于平均值 ✓，
   * 就是**请求排队**（源站 HTTP/1.1 并发被轮询占满 ✓）；
   * 如果耗时正常但界面反应慢 ✓，那是**主线程被渲染阻塞** ✓，两条路完全不同 ✓。
   */
  var RPC_SAMPLES = [];
  function recordRpc(cmd, ms, ok) {
    RPC_SAMPLES.push({ cmd: cmd, ms: ms, ok: ok, at: nowMs() });
    if (RPC_SAMPLES.length > 60) RPC_SAMPLES.shift();
  }

  function doRpc(cmd, args, noFallback, retry) {
    var startedAt = (window.performance && performance.now) ? performance.now() : Date.now();
    lastCalls.push({ cmd: cmd, args: args, at: nowMs() });
    if (lastCalls.length > 200) lastCalls.shift();

    var headers = { "content-type": "application/json" };
    var token = getToken();
    if (token) headers["x-softui-token"] = token;

    return fetch("/rpc", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ cmd: cmd, args: args || {} }),
    })
      .then(function (resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.json();
      })
      .then(function (payload) {
        if (payload && payload.ok === true) {
          backend.mode = "rust";
          backend.rust += 1;
          return patchLocalStats(cmd, payload.data);
        }
        var appError = new Error((payload && payload.error) || "后端返回失败");
        appError.__appError = true;
        throw appError;
      })
      .then(function (value) {
        recordRpc(cmd, ((window.performance && performance.now) ? performance.now() : Date.now()) - startedAt, true);
        return value;
      })
      .catch(function (error) {
        recordRpc(cmd, ((window.performance && performance.now) ? performance.now() : Date.now()) - startedAt, false);
        if (error && error.__appError) {
          backend.errors += 1;
          // ★ 后端说"找不到这个设备"时补救一次。
          //
          // 典型场景：浏览器已把 Web Serial 端口开好（deviceId = 前端传的 deviceName，
          // 如 `TDCR_v1`），但**网关重启过** —— 设备登记存在网关内存里，重启即丢，
          // 而浏览器还记着旧 id。于是每条指令都发向一个后端不认识的设备，报
          // `DeviceNotFound`。表现极隐蔽：界面一切正常，指令全不生效，目标值永远是 --。
          //
          // 补救很简单：浏览器手里还握着那个 SerialPort，重新调一次 webserial_open
          // 就能把登记补回去，再把原命令重发一次（只补一次，避免死循环）。
          if (!retry && wsActive && /DeviceNotFound/.test(String(error.message || ""))) {
            return reregisterDevice().then(function () {
              return doRpc(cmd, args, noFallback, true);
            });
          }
          throw error;
        }
        // 服务端专属命令：把失败如实抛出去，让调用方重试，而不是假装成功
        if (noFallback || NO_FALLBACK_CMDS[cmd]) {
          backend.errors += 1;
          backend.lastError = String((error && error.message) || error);
          throw error;
        }
        // 传输层失败（Rust 服务没起、网络断）→ 退回浏览器仿真，界面不至于白掉
        backend.mode = "sim";
        backend.sim += 1;
        backend.lastError = String((error && error.message) || error);
        return simInvoke(cmd, args);
      });
  }

  /* 曲线页每 100ms 要一份 240 帧、约 464KB 的窗口，而隧道的上行带宽实测只有
   * 约 250 KB/s（本地直连 Rust 只要 22ms，经隧道要 1.96s）。照原样发请求会
   * 越堆越多，最后把浏览器连接池塞满 —— 表现就是曲线页假死。
   *
   * 这里做「在途合并」：上一份还没回来就直接把上次的结果给出去，
   * 于是降级成「有多少带宽刷多少帧」，而不是堆死。
   * 想减少单次体积：地址后加 ?win=60（3 秒窗口，约 126KB）。 */
  /* ── 串口列表改走本机（Web Serial），不再枚举服务器的串口 ──────────
   * 原先 list_serial_ports 打到 Rust 后端，列出来的是**服务器**上的串口，
   * 对"控制我面前的设备"这件事没有意义。这里改成浏览器的 Web Serial API：
   * 列的是**你本机**已授权的串口。
   *
   * 两个硬约束：
   *   1. Web Serial 只在 Chrome / Edge（桌面版）+ 安全上下文可用，
   *      所以必须 HTTPS —— 这个站点经 Cloudflare 已经是 HTTPS，满足。
   *   2. 未经授权的端口读不到，必须由用户手势触发 requestPort() 弹窗选择。
   *      "扫描串口"按钮的点击就是那个手势，所以首次扫描会弹浏览器的端口选择框。
   *      想再添加一个已授权端口：地址后加 ?addport=1 再点扫描。
   * ─────────────────────────────────────────────────────────────── */
  var wsPorts = [];
  /** 用户在**浏览器弹窗**里选中的那个 SerialPort。它是"哪一个才是我的设备"的唯一可靠依据。 */
  var wsPicked = null;
  var FORCE_PICK = /[?&]addport=1\b/.test(location.search);

  /* Web Serial 不会暴露系统端口名（COM3 / /dev/ttyUSB0），
   * SerialPort.getInfo() 只有 usbVendorId / usbProductId —— 这是浏览器
   * 刻意隐藏的（防指纹追踪）。所以这里用 VID 反查厂商/芯片型号，
   * 给出一个能认得出的名字，比 "webserial:0" 有用得多。 */
  var USB_VENDORS = {
    0x1a86: "沁恒 WCH（CH340/CH341）",
    0x0483: "STMicroelectronics",
    0x10c4: "Silicon Labs（CP210x）",
    0x0403: "FTDI",
    0x067b: "Prolific（PL2303）",
    0x2341: "Arduino",
    0x2e8a: "Raspberry Pi Pico",
    0x1a40: "Terminus",
    0x04d8: "Microchip",
    0x03eb: "Atmel",
    0x1546: "u-blox",
    0x1b1c: "Corsair",
    0x239a: "Adafruit",
    0x303a: "Espressif（ESP32）",
    0x1915: "Nordic",
  };

  function hex4(value) {
    return "0x" + value.toString(16).padStart(4, "0");
  }

  function wsDescribe(port, index) {
    var info = {};
    try { info = (port.getInfo && port.getInfo()) || {}; } catch (e) { info = {}; }
    var vid = typeof info.usbVendorId === "number" ? info.usbVendorId : null;
    var pid = typeof info.usbProductId === "number" ? info.usbProductId : null;

    var picked = port === wsPicked;
    var label = "本机串口 " + (index + 1);
    if (vid !== null) {
      var vendor = USB_VENDORS[vid] || ("厂商 " + hex4(vid));
      label += " · " + vendor;
      if (pid !== null) label += " [" + hex4(vid) + ":" + hex4(pid) + "]";
    } else {
      label += "（非 USB 串口，浏览器不提供端口号）";
    }

    // ★ 标出"刚在浏览器弹窗里选中的那个"。浏览器弹窗**是显示 COM 号的**，
    //   而 getPorts() 拿不到端口号 —— 所以用户在那一次选择里看到的信息最多，
    //   必须在界面上把这个身份保留下来（否则两个同型号 CH340 完全无从分辨）。
    if (picked) label = "★ " + label + "（刚在浏览器弹窗中选择）";

    return {
      picked: picked,
      portName: "webserial:" + index,
      portType: "usb",
      description: label,
      manufacturer: vid !== null ? (USB_VENDORS[vid] || hex4(vid)) : null,
      product: pid !== null ? hex4(pid) : null,
      serialNumber: null,
      vid: vid,
      pid: pid,
      likelyAvailable: true,
    };
  }

  /* ?wsdebug=1 时把原始信息打到控制台：排查"设备在别的工具里能看到、
   * 这里却看不到"时，先确认浏览器到底拿到了几个端口、各自 vid/pid 是什么。 */
  function wsDumpPorts() {
    try {
      console.info("[webserial] 浏览器当前可见的已授权端口：" + wsPorts.length + " 个");
      wsPorts.forEach(function (port, index) {
        var info = {};
        try { info = (port.getInfo && port.getInfo()) || {}; } catch (e) { info = {}; }
        console.info(
          "  #" + index + " vid=" + (info.usbVendorId !== undefined ? hex4(info.usbVendorId) : "无") +
          " pid=" + (info.usbProductId !== undefined ? hex4(info.usbProductId) : "无") +
          (port === wsPicked ? "   ← 刚在弹窗中选中" : "")
        );
      });
      console.info(
        "[webserial] 若这里没有你的设备：Web Serial 只能拿到**已授权**端口。" +
        "点「扫描串口」会弹浏览器的端口选择框（那一层才有 COM 号）；" +
        "列表里没有目标设备，通常是：端口被别的串口工具占用 / 设备未插好 / " +
        "该端口不是 USB 串口（浏览器不提供端口号）。"
      );
    } catch (error) {
      console.warn("[webserial] 端口转储失败:", error);
    }
  }

  function syncWsPorts(ports) {
    wsPorts = ports.slice();
    window.__SOFTUI_WS_PORTS__ = wsPorts;   // 供后续真正做本地 I/O 时取用
    return wsPorts.map(wsDescribe);
  }

  /* 角色判定：没有 Web Serial 就是观察端（手机浏览器都没有这个 API）。
   * 观察端只做显示与指令下发，串口由电脑端提供 —— 这是刻意的架构，
   * 不该在界面上表现成"功能不可用"的错误。 */
  var IS_TOUCH = "ontouchstart" in window || (navigator.maxTouchPoints || 0) > 0;
  var OBSERVER = !navigator.serial;

  var DEVICE_NAME = (/[?&]device=([A-Za-z0-9_.-]{1,32})/.exec(location.search) || [])[1] || "TDCR_v1";
  var wsHasGranted = false;

  /**
   * @param forcePick 强制弹出浏览器的端口选择框。
   *
   * Web Serial 的坑：`requestPort()` 只在**还没授权过任何端口**时才会自动弹窗；
   * 一旦授权过，`getPorts()` 就直接返回旧的，界面再也拿不到"选新端口"的机会 ✗。
   * 想换设备必须显式强制弹窗（原来只能靠地址栏 `?addport=1`，界面上没法发现）。
   */
  function listLocalSerialPorts(forcePick) {
    if (!navigator.serial || typeof navigator.serial.getPorts !== "function") {
      var why = window.isSecureContext === false
        ? "当前不是安全上下文（Web Serial 要求 HTTPS 或 localhost）。"
        : OBSERVER && IS_TOUCH
          ? "本端为观察端：串口由电脑端提供。这里可以看实时数据、下发控制指令，不需要在本端接设备。"
          : "当前浏览器不支持 Web Serial —— 请用桌面版 Chrome 或 Edge。";
      return Promise.reject(new Error(why));
    }

    // 关键：requestPort() 必须在用户点击的**同一个同步调用栈**里发起。
    // 中间只要夹一个 await，Chrome 就判定"用户手势已失效"而静默什么都不弹 ——
    // 表现就是点了「扫描串口」毫无反应。所以首次扫描时这里同步把选择框弹出。
    var pick = null;
    if (!wsHasGranted || FORCE_PICK || forcePick) {
      try {
        // ⚠️ requestPort() 的**返回值必须留着**。
        // 浏览器弹窗里是显示 COM 号的，而 getPorts() 拿不到端口号 ——
        // 用户在弹窗里那一次选择，是"哪一个才是我的设备"的唯一可靠依据。
        // 原来这里把返回值丢了、只用 getPorts() 的累积列表，于是界面上列出的顺序
        // 与用户刚选的完全无关；两个同型号 CH340 时根本没法分辨，只能靠猜。
        pick = navigator.serial.requestPort().then(function (port) {
          wsPicked = port;
          return port;
        });
      } catch (error) {
        pick = Promise.reject(error);
      }
    }

    var merge = function (granted) {
      var list = granted.slice();
      // 把刚选中的那个排到最前：界面默认就指向它，不必在几条同名条目里再猜一次。
      if (wsPicked) {
        var at = list.indexOf(wsPicked);
        if (at >= 0) list.splice(at, 1);
        // 即使不在 getPorts() 里也放最前 —— 用户刚授权过，它必定可用
        list.unshift(wsPicked);
      }
      wsHasGranted = list.length > 0;
      wsPorts = list;
      window.__SOFTUI_WS_PORTS__ = wsPorts;
      if (wsPorts.length === 0) {
        throw new Error(
          "没有选中任何串口。点「扫描串口」后浏览器会弹出端口选择框，" +
          "请在列表里选中你的设备并确认。" +
          "（弹窗里显示的是系统端口名如 COM3；网页本身拿不到这个名字，" +
          "所以必须在这一步选对。）"
        );
      }
      if (/[?&]wsdebug=1\b/.test(location.search)) wsDumpPorts();
      return wsPorts.map(wsDescribe);
    };

    if (pick) {
      // 用户取消或手势失效 → 退回已授权列表；仍为空就给出可读原因
      return pick
        .then(function () { return navigator.serial.getPorts(); })
        .catch(function () { return navigator.serial.getPorts(); })
        .then(merge);
    }
    return navigator.serial.getPorts().then(merge);
  }

  /* ── Web Serial 泵：前端只搬字节，协议解析留在 Rust ────────────────
   * RX：串口读到的原始字节批量推给后端 webserial_push
   * TX：定时向后端 webserial_take_tx 取命令字节，写进真实串口
   *
   * 这样 send_motor_command / send_curvature_command 等命令照旧发给后端，
   * 后端编码成帧后进 TX 队列，由这里落到设备上。
   * 好处是协议实现只有 Rust 一份，不会两边分叉。
   * ─────────────────────────────────────────────────────────────── */
  var wsActive = null;
  var wsRxBuf = [];

  var WS_SEQ = 0;             // 接收块序号：后端按它去重，重试因此是安全的
  var wsPushPending = null;   // 待发送/重试中的块
  var wsFlushTimer = null;    // 接收侧的定时冲刷
  var wsSyncTimer = null;     // 本机 → 后端的帧上报（10Hz）

  function wsFlushRx() {
    if (!wsActive || !wsActive.running) return;
    if (wsPushPending) return; // 上一块还在重试，先攒着
    if (wsRxBuf.length === 0) return;
    var bytes = wsRxBuf.slice();
    wsRxBuf = [];
    wsPushPending = { name: wsActive.name, seq: ++WS_SEQ, bytes: bytes, tries: 0 };
    sendRxChunk();
  }

  /**
   * 送出一块接收字节，失败就带**同一个 seq** 重试。
   *
   * 原来是把缓冲清空后才发、失败直接扔 —— 一次网络抖动就凭空截断一帧，
   * 后端表现为 InvalidChecksum。实测曾出现 131 个校验错 / 43 个有效帧。
   * 现在后端按 seq 去重，重复到达会被忽略，所以重试不会让数据重复。
   */
  function sendRxChunk() {
    var chunk = wsPushPending;
    if (!chunk) return;
    doRpc("webserial_push", { portName: chunk.name, seq: chunk.seq, bytes: chunk.bytes }, true)
      .then(function () {
        wsPushPending = null;
        if (wsRxBuf.length) wsFlushRx();
      })
      .catch(function (error) {
        chunk.tries += 1;
        if (chunk.tries % 10 === 1) {
          console.warn("[webserial] 推字节失败，重试中:", error && error.message);
        }
        setTimeout(sendRxChunk, 150);
      });
  }

  /**
   * 取后端待发命令 —— **挂起式长轮询**，替代原来每 20ms 一次的轮询。
   *
   * 原来 wsPumpTick 每 20ms 发两个请求（take_tx + 可能的 push），
   * 等于 100 req/s；在往返 100ms 的隧道上必然大面积失败，
   * 而接收字节又恰好在同一个循环里发 —— 失败就连带把字节丢掉。
   * 改成挂起后，空闲时链路上只有一个未完成的请求。
   */
  /**
   * 连续失败计数 ✓ —— 端口已关却还在重试时 ✓，**退避**并最终**停下** ✗。
   *
   * 原来失败后立刻重试 ✓ → 端口关了就是每秒几十条 `webserial 端口未打开`✗
   * → 控制台刷屏 ✓、还白白打满 RPC 链路 ✗（本 bug ✓）。
   */
  var wsTxFailures = 0;
  var wsTxTimer = null;

  /**
   * **串口收发统计** ✓ —— 用来区分"没发出去"还是"没收到"✗。
   * 控制台执行 `__SOFTUI_WS__.stats()` 即可 ✓。
   */
  var wsStats = { txBytes: 0, rxBytes: 0, lastTxAt: 0, lastRxAt: 0, writeErrors: 0, readErrors: 0 };

  function wsTxLoop() {
    if (!wsActive || !wsActive.running) return;
    doRpc("webserial_wait_tx", { portName: wsActive.name, timeoutMs: 300 }, true)
      .then(function (bytes) {
        if (!wsActive || !wsActive.running) return;
        if (!bytes || bytes.length === 0) return;
        var writable = wsActive.port.writable;
        if (!writable) return;
        var writer = writable.getWriter();
        return writer
          .write(new Uint8Array(bytes))
          .then(
            function () {
              writer.releaseLock();
              wsStats.txBytes += bytes.length;
              wsStats.lastTxAt = Date.now();
            },
            function (error) {
              try { writer.releaseLock(); } catch (ignored) {}
              wsStats.writeErrors += 1;
              console.warn("[webserial] 写串口失败:", error && error.message);
            },
          );
      })
      .catch(function (error) {
        wsTxFailures += 1;
        if (!wsActive || !wsActive.running) return;
        // 前 2 次照常提示 ✓，之后**只提示一次**再静默 ✗
        if (wsTxFailures <= 2) {
          console.warn("[webserial] 取命令失败:", error && error.message);
        } else if (wsTxFailures === 3) {
          console.warn("[webserial] 连续失败，暂停发送通道（重连接口会恢复）✗");
        }
        /**
         * ⚠ **绝不能用"停循环"当错误处理** ✗ —— 这是"点按钮要等 10 秒"甚至
         * "再也发不出去"的根因 ✓：
         *   · 长轮询偶发失败 → 计数累到 5 → `running = false` → **发送通道永久关闭** ✗
         *   · 命令照常进后端缓冲 ✓，但**没有人来拉**✗ → 只能刷新页面才恢复 ✗
         * 现在：只记数、只提示，循环照跑 ✓（长轮询失败本来就是"这 5 秒没命令"✓）。
         */
        if (wsTxFailures === 5) {
          console.warn("[webserial] 取命令连续失败 5 次，继续重试（不再停循环）");
        }
      })
      .then(function () {
        if (!wsActive || !wsActive.running) return;
        // 成功一次就清零 ✓；失败则**指数退避** ✓（200ms × 2^n，上限 8 秒 ✓）
        if (wsTxFailures === 0) {
          wsTxLoop();
          return;
        }
        /**
         * **退避上限 8s → 400ms** ✗ —— 8 秒退避正是"点完等 10 秒才动"的来源 ✓：
         *   命令进后端缓冲后要等下一轮轮询才被拉走 ✓ → 抖动一次就拖 8 秒 ✗。
         *   取命令的长轮询本来就是空闲等待 ✓，失败多半是隧道抖动 ✓，
         *   用 100/200/400ms 快速重试即可 ✓。
         */
        var delay = Math.min(400, 100 * Math.pow(2, wsTxFailures - 1));
        wsTxTimer = window.setTimeout(function () {
          if (wsActive && wsActive.running) wsTxLoop();
        }, delay);
      });
  }

  /**
   * 只有在**真的解出过一帧有效数据**之后，才把当前波特率记为"上次可用"。
   *
   * 原来是在 `wsConnect` 成功后就记 ✗ —— 于是"连上了但速率不对"这种情形会把
   * 错速率固化进 localStorage ✓，下次刷新自动重连又用回它 ✓，症状和这次一模一样
   * （一直停在「握手」、帧表全空），非常难看出来。
   */
  /** 连接成功 / 重连时清零失败计数 ✓ */
  function resetTxFailures() {
    wsTxFailures = 0;
    if (wsTxTimer) {
      window.clearTimeout(wsTxTimer);
      wsTxTimer = null;
    }
  }

  function markBaudVerified() {
    if (!wsActive || wsActive.baudVerified) return;
    wsActive.baudVerified = true;
    try {
      window.localStorage.setItem("softui.baud", String(wsActive.baudRate));
    } catch (ignored) {}
  }

  function wsStartRead() {
    if (!wsActive) return;
    (function reopen() {
      if (!wsActive || !wsActive.running) return;
      var port = wsActive.port;
      if (!port.readable) {
        setTimeout(reopen, 200);
        return;
      }
      var reader = port.readable.getReader();
      /**
       * **把 reader 挂到会话上** ✓ —— 断开时必须 `cancel()` 它 ✓。
       * 只调 `port.close()` 不行 ✗：有活动 reader 锁时 close 会**抛错或挂起** ✓
       * → 端口保持打开 ✓ → 刷新后仍被占着 ✓（"一直被 webserial:0 占着"本 bug ✓）。
       */
      if (wsActive) wsActive.reader = reader;
      (function pump() {
        reader
          .read()
          .then(function (result) {
            if (!wsActive || !wsActive.running || result.done) {
              if (wsActive && wsActive.reader === reader) wsActive.reader = null;
              try { reader.releaseLock(); } catch (ignored) {}
              return;
            }
            var value = result.value;
            if (value && value.length) {
              wsStats.rxBytes += value.length;
              wsStats.lastRxAt = Date.now();
              /**
               * **兜底补建解析器** ✓ —— 协议模块可能比连接晚到 ✓。
               * 不补的话就要一直走"推原始字节给后端"那条路 ✗ → 协议错误疯长 ✗。
               */
              if (!wsCodec && window.__SOFTUI_PROTOCOL__) {
                wsCodec = new window.__SOFTUI_PROTOCOL__.FrameParser();
              }
              if (P1_LOCAL_PARSE && wsCodec) {
                // 本机解析：字节不出浏览器，解析结果直接进本地环形缓冲
                wsCodec.pushBytes(value).forEach(function (decoded) {
                  if (decoded && decoded.ok) {
                    wsStats.parsedFrames = (wsStats.parsedFrames || 0) + 1;
                  } else {
                    wsStats.parseErrors = (wsStats.parseErrors || 0) + 1;
                  }
                  if (!decoded.ok) {
                    // 校验错时解析器只前进 1 字节重找帧头，所以这里是"噪声字节数"的近似；
                    // 长度对不上之类的真解析异常也一并记进去，徽标上能看到。
                    wsErrors += 1;
                    return;
                  }
                  var message = decoded.ok;
                  /**
                   * **本地自证：收到合法协议帧** ✓ —— 这是"才允许向后端登记"的门槛 ✓。
                   * （见 `wsConnect` 里的 `waitForProtocol` ✓）
                   */
                  if (wsActive && !wsActive.protocolVerified) {
                    wsActive.protocolVerified = true;
                  }
                  if (message.kind === "status") {
                    markBaudVerified();
                    wsFrameSeq += 1;
                    var snap = buildSnapshot(message, wsFrameSeq);
                    wsLastFrame = snap;
                    wsDirtyFrame = snap; // 等 10Hz 上报
                    wsRing.push(snap);
                    if (wsRing.length > WS_CAPACITY) {
                      wsRing.splice(0, wsRing.length - WS_CAPACITY);
                    }
                    return;
                  }
                  // 张力感知帧（500ms 一帧）与标定事件帧（事件触发）：
                  // 与状态帧不是同一个节拍，不能塞进 wsRing。
                  if (message.kind === "calibration") {
                    wsLastCalibration = message;
                    wsCalibrationEvents += 1;
                    return;
                  }
                  if (message.kind === "handshake") {
                    wsHandshake = message;
                    return;
                  }
                  // 预留设备 / 未知功能码：解析内核不认识但不报错，计数即可。
                  wsUnknownFrames += 1;
                });
              } else {
                for (var i = 0; i < value.length; i += 1) wsRxBuf.push(value[i]);
                if (wsRxBuf.length >= 4096) wsFlushRx();
              }
            }
            pump();
          })
          .catch(function () {
            if (wsActive && wsActive.reader === reader) wsActive.reader = null;
            try { reader.releaseLock(); } catch (ignored) {}
          });
      })();
    })();
  }

  /* ── A. 前端本地解析（P1）────────────────────────────────────────────
   * 串口字节在**本机**解析成 DeviceSnapshot：
   *   - 本机渲染零往返（fetch_live_latest / fetch_live_window 直接答本地环形缓冲）
   *   - 只把解析好的帧按 10Hz 上报给后端，供其它端和录制使用
   * 字段映射与后端 make_device_frame / adapt_* 逐条对齐（"同构"），
   * 避免本机与后端出现两份略有差异的视图。
   * 开关：出错可置 false 回退到"原始字节推送"老路径。
   * ──────────────────────────────────────────────────────────────── */
  // 可在地址栏加 ?p1=0 回退到"原始字节推送 + 后端解析"的老路径。
  // 老路径的完整代码都保留着（wsRxBuf / wsFlushRx / rpcInvoke 的代理分支），
  // 所以这个开关是把整条链路切回去，而不是只关一半。
  var P1_LOCAL_PARSE = !/[?&]p1=0\b/.test(location.search);
  var WS_CAPACITY = 600;
  // 帧解析器：V1（0xBB）与 V2（0x55 + 设备ID）混流都认，与 Rust 的 FrameParser 逐条对齐。
  var wsCodec = window.__SOFTUI_PROTOCOL__ ? new window.__SOFTUI_PROTOCOL__.FrameParser() : null;
  var wsRing = [];
  var wsLastFrame = null;
  var wsFrameSeq = 0;
  var wsErrors = 0;
  var wsDirtyFrame = null;
  // 指令集 V2 的另外两类上行帧。界面暂时没有对应面板，但**必须收下来**：
  // 否则以后做面板时会回头怀疑「到底有没有收到」，而那时候串口现场未必还在。
  var wsLastCalibration = null;
  var wsHandshake = null;
  var wsCalibrationEvents = 0;
  var wsUnknownFrames = 0;

  function adaptMotor(id, motor) {
    return {
      id: id,
      positionMm: motor.positionMm,
      velocityMmPerSec: motor.velocityMmPerSec,
      accelerationMmPerSec2: motor.accelerationMmPerSec2,
      running: motor.status !== 0,
      targetPositionMm: motor.positionMm + 1.5,
    };
  }

  /* 固件口径：状态帧里每路是**一路压力通道**，只有两个数 ——
   * x = 实际值（未经滤波的读数），y = 滤波值。每路 4 字节。
   * （旧固件是 6 字节、多一个保留位 z；解析器两种步长都接受。）
   *
   * 字段名必须与后端 `adapt_sensor` 逐字一致：本机解析与后端解析都是
   * `DeviceSnapshot.sensors` 的产出方，两边形状一旦分叉，同一份环形缓冲里
   * 就会出现两种帧结构，图表和 CSV 都会莫名其妙地缺列。 */
  function adaptSensor(id, sensor, seq) {
    return {
      id: id,
      // 固件口径：x = 实际值（未滤波），y = 滤波值。
      // 与后端 adapt_sensor 逐字对齐 —— 这两处是 DeviceSnapshot.sensors 的唯二产出方，
      // 形状或映射一旦分叉，同一份环形缓冲里就会出现两种语义的帧。
      rawValue: sensor.x,
      filteredValue: sensor.y,
      unit: "N",
      quality: seq % 15 === 0 ? "warning" : "ok",
    };
  }

  function adaptBend(angleDeg, direction, seq) {
    return {
      angleDeg: angleDeg,
      targetAngleDeg: angleDeg + 4.0,
      direction: direction,
      quality: seq % 17 === 0 ? "warning" : "ok",
    };
  }

  function buildSnapshot(status, seq) {
    return {
      deviceId: DEVICE_NAME,
      connectionId: "webserial",
      receivedAtMs: Date.now(),
      sequence: seq,
      // 下位机上电发 V1，收到 `AA 09 01 02` 后切 V2 —— 显示的必须是**实际在跑**的那个。
      protocolVersion: wsCodec && wsCodec.lastVersion() >= 2 ? "V2 (0x55)" : "Legacy V1 (0xBB)",
      systemEnabled: status.systemState !== 0,
      motors: status.motors.map(function (m, i) { return adaptMotor(i + 1, m); }),
      sensors: status.sensors.map(function (s, i) { return adaptSensor(i + 1, s, seq); }),
      bend: {
        section1: adaptBend(status.bendAngle1Deg, "up", seq),
        section2: adaptBend(status.bendAngle2Deg, "right", seq),
      },
      quality: {
        status: wsErrors === 0 ? "ok" : "warning",
        latencyMs: 0,
        droppedFrames: wsErrors,
        checksumOk: wsErrors === 0,
      },
    };
  }

  function localStats() {
    return {
      storedFrames: wsRing.length,
      capacity: WS_CAPACITY,
      totalFrames: wsFrameSeq,
      droppedFrames: wsErrors,
      frameRateHz: 0, // 由后端帧率兜底；本机不额外计时，避免再引一个定时器
    };
  }

  /* 把解析好的帧按 10Hz 上报：本机不需要高频，其它端看的是"趋势"。 */
  function wsSyncUp() {
    // **未登记不上报** ✓ —— 后端还没有这台设备 ✓，推上去只会报"未知设备"✗
    if (!P1_LOCAL_PARSE || !wsActive || !wsActive.registered || !wsDirtyFrame) return;
    var frame = wsDirtyFrame;
    wsDirtyFrame = null;
    doRpc("frame_ingest", { frame: frame }, true).catch(function () { /* 下个周期不重试，遥测允许丢单帧 */ });
  }

  /* ── 页面卸载时清理串口通道 ──────────────────────────────────────────
   * Web Serial 的端口对象属于**当前页面**，刷新/关闭即释放。但后端不知道，
   * 于是留下一个永远收不到字节的"僵尸设备"：界面显示已连接，实际没数据，
   * 新加入的端也跟着看不到任何东西（实测踩到过，排查了很久）。
   * 用 sendBeacon 发一个 keepalive 请求关掉它 —— 普通 fetch 在卸载时会
   * 被浏览器取消，sendBeacon 不会。
   * ─────────────────────────────────────────────────────────────────── */
  /* ── D. 指令直发（本机模式）──────────────────────────────────────
   * 为什么 ✗：写入原来要"前端 → 后端排队 → 浏览器拉取 → 写串口"✓，
   * 源站 HTTP/1.1 + Cloudflare 隧道下，一条指令排队十几秒 ✗（实测 ✓）。
   * 而**读取早就是本机直连**了 ✓，只有写入绕了远路 ✗。
   * 现在：持有串口的那一端直接编码 + 写串口 ✓ → ms 级 ✓；
   * 不持有串口的端（手机 / 另一台电脑）仍走后端排队 ✓。
   * ─────────────────────────────────────────────────────────────── */

  /** 下行帧：`AA func LEN [data] SUM` ✓ */
  function encodeDownFrame(func, data) {
    var frame = [0xAA, func & 0xff, data.length];
    for (var i = 0; i < data.length; i += 1) frame.push(data[i] & 0xff);
    var sum = 0;
    for (var j = 0; j < frame.length; j += 1) sum = (sum + frame[j]) & 0xff;
    frame.push(sum);
    return frame;
  }

  function be16(value) {
    return [(value >> 8) & 0xff, value & 0xff];
  }

  function toI16(value, factor) {
    var scaled = Math.round(value * factor);
    if (!isFinite(scaled) || scaled < -32768 || scaled > 32767) {
      throw new Error("数值超出协议范围：" + value);
    }
    return scaled < 0 ? scaled + 0x10000 : scaled;
  }

  function toU16(value, factor) {
    var scaled = Math.round(value * factor);
    if (!isFinite(scaled) || scaled < 0 || scaled > 65535) {
      throw new Error("速度超出协议范围：" + value);
    }
    return scaled;
  }

  /** **直接写串口** ✓ —— 本端持有端口时返回 true ✓，否则 false（调用方回退走后端 ✓）。*/
  function toHex(bytes) {
    return bytes
      .map(function (b) { return (b < 16 ? "0" : "") + b.toString(16).toUpperCase(); })
      .join("");
  }

  /**
   * **直接写串口** ✓ —— 返回本次实际写出的**帧 hex** ✓，失败返回 `""` ✓。
   *
   * 返回 hex 是为了让调用方把它送去后端**只记录不发送**（`control_frame_log`）✓：
   * 后端据此更新 `control_enabled` / 审计 / 会话录制 ✓，但**不会再发一遍** ✓。
   */
  function sendDirect(bytes) {
    if (!wsActive || !wsActive.running || !wsActive.port || !wsActive.port.writable) {
      return "";
    }
    try {
      var writer = wsActive.port.writable.getWriter();
      writer
        .write(Uint8Array.from(bytes))
        .then(
          function () {
            wsStats.txBytes += bytes.length;
            wsStats.lastTxAt = Date.now();
            writer.releaseLock();
          },
          function (error) {
            wsStats.writeErrors += 1;
            console.warn("[webserial] 直发写串口失败:", error && error.message);
            try { writer.releaseLock(); } catch (ignored) {}
          },
        );
      return toHex(bytes);
    } catch (error) {
      console.warn("[webserial] 直发异常:", error && error.message);
      return "";
    }
  }

  /** 系统控制：使能 `0x01` / 急停 `0x02` / 失能 `0x00`，无数据段 ✓ */
  function directSystemControl(action) {
    var func = action === "enable" ? 0x01 : action === "emergencyStop" ? 0x02 : 0x00;
    return sendDirect(encodeDownFrame(func, []));
  }

  /**
   * **多电机同步位移 `0x11`** ✓ —— 六路**绝对目标位移（mm，带符号）** ✓。
   *
   * 绝对量 ⇒ 幂等 ⇒ 重复发送无害 ✓（相对位移的 `0x10` 不行 ✗）。
   * 动作组播放、曲率/位姿下发都走这条 ✓。
   */
  function directMultiMotor(positionsMm, startAddress) {
    var list = positionsMm || [];
    if (list.length === 0) return "";
    if (list.length > 6) list = list.slice(0, 6);
    var data = [list.length, startAddress || 1];
    for (var i = 0; i < list.length; i += 1) {
      var value = Number(list[i]);
      if (!isFinite(value)) return "";
      var scaled = Math.round(value * 100);          // 0.01mm
      if (scaled < -32768 || scaled > 32767) return "";
      if (scaled < 0) scaled += 0x10000;
      data = data.concat(be16(scaled));
    }
    return sendDirect(encodeDownFrame(0x11, data));
  }

  /** 一键归零：多电机同步位移帧 `0x11`，六路目标位移全 0 ✓ */
  function directHome(motorCount, startAddress) {
    var count = motorCount || 6;
    var zeros = [];
    for (var i = 0; i < count; i += 1) zeros.push(0);
    return directMultiMotor(zeros, startAddress || 1);
  }

  /** 单电机定位 `0x10`：`addr dir dist(2) vel(2)` ✓ */
  function directMotorCommand(motorId, positionMm, velocityMmPerSec) {
    var direction = positionMm >= 0 ? 0 : 1;
    var distance = toI16(Math.abs(positionMm), 100);   // ×0.01mm
    var velocity = toU16(Math.abs(velocityMmPerSec || 5), 100); // ×0.01mm/s
    var data = [motorId, direction]
      .concat(be16(distance))
      .concat(be16(velocity));
    return sendDirect(encodeDownFrame(0x10, data));
  }

  /**
   * **强制释放所有本机串口** ✓ —— 兜底手段 ✓。
   *
   * 什么时候用 ✗：上一次异常退出 / 多个标签页 / 旧版本没释放干净 ✓ →
   * 浏览器认为端口"仍在打开"✓ → 怎么连都报占用 ✓（现场表现 ✓）。
   * 这里把所有已知 port 对象的 reader 取消掉再 close ✓，并清掉本地会话 ✓。
   * 控制台调用：`__SOFTUI_WS__.forceRelease()` ✓
   */
  function forceRelease() {
    var targets = [];
    if (wsActive && wsActive.port) targets.push(wsActive.port);
    (wsPorts || []).forEach(function (port) { if (targets.indexOf(port) < 0) targets.push(port); });
    var reader = wsActive && wsActive.reader ? wsActive.reader : null;
    wsActive = null;
    var jobs = targets.map(function (port) {
      var cancel = reader
        ? Promise.resolve(reader.cancel()).catch(function () {})
        : Promise.resolve();
      return cancel
        .then(function () {
          try { if (reader) reader.releaseLock(); } catch (ignored) {}
        })
        .then(function () { return Promise.resolve(port.close()).catch(function () {}); })
        .then(function () { return { ok: true }; });
    });
    var granted = (navigator.serial && navigator.serial.getPorts)
      ? navigator.serial.getPorts().catch(function () { return []; })
      : Promise.resolve([]);
    return granted.then(function (list) {
      (list || []).forEach(function (port) {
        try { Promise.resolve(port.close()).catch(function () {}); } catch (ignored) {}
      });
      return Promise.all(jobs).then(function () {
        wsPorts = [];
        wsHasGranted = false;
        window.__SOFTUI_WS_PORTS__ = [];
        console.info("[webserial] 已尝试强制释放 " + (targets.length + (list || []).length) + " 个端口句柄");
        return { released: targets.length + (list || []).length };
      });
    });
  }

  window.__SOFTUI_WS__ = {
    /* **指令直发** ✓ —— 返回 true 表示"本机已直接写串口"✓，false 表示"本端没有串口，走后端"✓ */
    directSystemControl: directSystemControl,
    directHome: directHome,
    directMultiMotor: directMultiMotor,
    directMotorCommand: directMotorCommand,
    /** 本端是否持有可用串口（决定直发 / 转发）*/
    isLocal: function () {
      return Boolean(wsActive && wsActive.running && wsActive.port && wsActive.port.writable);
    },
    forceRelease: forceRelease,
    /** 端口状态 + 收发统计 ✓（诊断"握手一直不动"用 ✓）*/
    /** **RPC 耗时统计** ✓ —— 按命令聚合：次数 / 中位 / 最大 ✓ */
    rpcStats: function () {
      var byCmd = {};
      RPC_SAMPLES.forEach(function (item) {
        var entry = byCmd[item.cmd] || (byCmd[item.cmd] = { n: 0, ms: [], failed: 0 });
        entry.n += 1;
        entry.ms.push(item.ms);
        if (!item.ok) entry.failed += 1;
      });
      var out = {};
      Object.keys(byCmd).forEach(function (cmd) {
        var list = byCmd[cmd].ms.slice().sort(function (a, b) { return a - b; });
        out[cmd] = {
          calls: byCmd[cmd].n,
          failed: byCmd[cmd].failed,
          medianMs: Math.round(list[Math.floor(list.length / 2)]),
          maxMs: Math.round(list[list.length - 1]),
        };
      });
      return out;
    },
    stats: function () {
      return {
        opened: Boolean(wsActive),
        portName: wsActive ? wsActive.name : null,
        baudRate: wsActive ? wsActive.baudRate : null,
        readable: Boolean(wsActive && wsActive.port && wsActive.port.readable),
        writable: Boolean(wsActive && wsActive.port && wsActive.port.writable),
        txBytes: wsStats.txBytes,
        rxBytes: wsStats.rxBytes,
        // **解析侧可见** ✓ —— 判断"收到字节但解析不出帧"用
        hasCodec: Boolean(wsCodec),
        parsedFrames: wsStats.parsedFrames || 0,
        parseErrors: wsStats.parseErrors || 0,
        protocolVerified: Boolean(wsActive && wsActive.protocolVerified),
        registered: Boolean(wsActive && wsActive.registered),
        writeErrors: wsStats.writeErrors,
        lastTxMs: wsStats.lastTxAt ? Date.now() - wsStats.lastTxAt : null,
        lastRxMs: wsStats.lastRxAt ? Date.now() - wsStats.lastRxAt : null,
      };
    },
  };

  window.addEventListener("pagehide", function () {
    if (!wsActive) return;
    var name = wsActive.name;
    wsActive.running = false;
    try {
      var payload = JSON.stringify({ cmd: "webserial_close", args: { portName: name } });
      navigator.sendBeacon("/rpc", new Blob([payload], { type: "application/json" }));
    } catch (error) {
      /* 卸载阶段尽力而为，失败就算了 */
    }
  });

  /**
   * **协议探针窗口（ms）** ✓ —— 打开端口后先本地解析，拿到**合法帧**才向后端登记 ✓。
   *
   * 为什么要把顺序倒过来 ✗：原来"先 `webserial_open` 登记、再开始收数据" ✓ →
   * 端口能开、但设备不回帧（波特率错 / 选错 COM 口 / 接线问题）时 ✓，
   * 后端里就留下一条**永远握手不上的幽灵设备** ✗ → 界面一直"握手中" ✓、
   * 设备列表里挂着用不了的东西 ✗（现场现象 ✓）。
   *
   * 现在：**前端先自证"我听到的是 SoftUI 设备"** ✓，然后才发 `webserial_open` ✓。
   * 探针窗口内一个合法帧都没有 → 直接断开并报出可执行的排查方向 ✓。
   */
  var PROTOCOL_PROBE_MS = 4000;

  /**
   * ⚠ **清掉历史调试开关** ✗ —— `softui.skipProtocolCheck` 是排查期临时加的 ✓，
   * 留着会让协议探针被永久绕过 ✓ → "一连接就握手、永远不推进"✗（现场现象 ✓）。
   * 每次加载清一次 ✓，需要时再显式设置 ✓。
   */
  try {
    window.localStorage.removeItem("softui.skipProtocolCheck");
    window.localStorage.removeItem("softui.autoReconnect");
  } catch (ignored) {}

  function wsConnect(index, baudRate, retried) {
    if (wsActive) {
      return wsDisconnect("").then(function () { return wsConnect(index, baudRate, retried); });
    }
    var port = wsPorts[index];
    if (!port) {
      return Promise.reject(new Error("找不到本机串口 " + index + "，请先点「扫描串口」重新选择。"));
    }
    var baud = baudRate || 115200;
    var name = "webserial:" + index;

    /** **向后端登记** ✓ —— 只有协议验证通过（或明示跳过）才会走到这里 ✓ */
    function registerWithBackend() {
      return doRpc("webserial_open", {
        portName: name,
        baudRate: baud,
        clientId: SYNC_ID,
        deviceName: DEVICE_NAME,
      }).then(function (record) {
        if (wsActive) wsActive.registered = true;
        return record;
      });
    }

    /** **等第一帧合法协议** ✓（超时就拒绝，让用户去查硬件 ✓）*/
    function waitForProtocol() {
      var skip = false;
      try {
        skip = window.localStorage.getItem("softui.skipProtocolCheck") === "1";
      } catch (ignored) {}
      // 老路径（`?p1=0`）没有本地解析 ✓ → 无法自证 ✓ → 直接登记（保持旧行为 ✓）
      if (skip || !P1_LOCAL_PARSE || !wsCodec) return Promise.resolve();
      return new Promise(function (resolve, reject) {
        var startedAt = Date.now();
        var timer = setInterval(function () {
          if (!wsActive || !wsActive.running) {
            clearInterval(timer);
            reject(new Error("串口已关闭"));
            return;
          }
          if (wsActive.protocolVerified) {
            clearInterval(timer);
            resolve();
            return;
          }
          if (Date.now() - startedAt > PROTOCOL_PROBE_MS) {
            clearInterval(timer);
            reject(new Error(
              "已打开 " + name + " @" + baud + "，但 " + PROTOCOL_PROBE_MS / 1000 +
                " 秒内没有收到任何合法协议帧（累计收到 " + wsStats.rxBytes + " 字节）。\n" +
                "排查顺序：① 波特率是否与设备一致 ② 是否选错了 COM 口（两个 CH340 在列表里同名）③ 设备是否上电、TX/RX 是否接反。\n" +
                "确认要跳过校验：localStorage.setItem(\"softui.skipProtocolCheck\", \"1\") 后重试。"
            ));
          }
        }, 100);
      });
    }

    return port
      .open({ baudRate: baud })
      .then(function () {
        // **先建会话、先收数据** ✓ —— 注意此时 `registered` 还是 false ✓
        wsActive = {
          index: index,
          name: name,
          port: port,
          baudRate: baud,
          running: true,
          registered: false,
          protocolVerified: false,
        };
        /**
         * ⚠ 原来写的是 `if (wsCodec && window.__SOFTUI_PROTOCOL__)` ✗ ——
         * 首次连接时 `wsCodec` 就是 null ✓ → 条件永远为假 → **本地解析从未启用**✗ →
         * 所有字节都被 `webserial_push` 推给后端解析 ✓ → 后端那份解析器
         * 面对半包 / 粘包会不断记"协议错误"✗（现场"协议错误疯长"✓）。
         * 只要协议模块在，就重建一个干净的解析器 ✓。
         */
        if (window.__SOFTUI_PROTOCOL__) {
          wsCodec = new window.__SOFTUI_PROTOCOL__.FrameParser();
        }
        wsStartRead();
        return waitForProtocol();
      })
      .then(function () {
        return registerWithBackend();
      })
      .then(function (record) {
        resetTxFailures();   // **重连成功 → 清失败计数** ✓（否则退避会一直卡着 ✗）
        wsPushPending = null;
        WS_SEQ = 0;
        wsRing = [];
        wsLastFrame = null;
        wsFrameSeq = 0;
        wsErrors = 0;
        wsDirtyFrame = null;
        wsLastCalibration = null;
        wsHandshake = null;
        wsCalibrationEvents = 0;
        wsUnknownFrames = 0;
        if (!wsSyncTimer) wsSyncTimer = setInterval(wsSyncUp, 2000); // 2s —— 只给后端留档，界面不吃它
        wsTxLoop(); // 命令：挂起式长轮询，不再 20ms 一轮
        if (wsFlushTimer) clearInterval(wsFlushTimer);
        wsFlushTimer = setInterval(wsFlushRx, 100); // 接收：有数据才发，100ms 一拍
        // **记住这次用的是哪条口** ✓ —— 下次（且只有开了自动重连时）按指纹找回 ✓
        try {
          window.localStorage.setItem("softui.lastPortKey", portKey(port));
          window.localStorage.setItem("softui.baud", String(baud));
        } catch (ignored) {}
        console.info("[webserial] 已打开本机串口 " + name + " @ " + baud + "（协议已验证 ✓）");
        return record;
      })
      .catch(function (error) {
        var errName = (error && error.name) || "";
        // 端口被判定为"仍打开" → 强关一次再重试
        if (!retried && errName === "InvalidStateError") {
          return Promise.resolve(port.close()).catch(function () {})
            .then(function () { return new Promise(function (r) { setTimeout(r, 150); }); })
            .then(function () { return wsConnect(index, baudRate, true); });
        }
        // 失败收尾：把已开的端口和后端登记都清掉（本端没登记就只在本地关）
        var wasRegistered = Boolean(wsActive && wsActive.registered);
        var reader = wsActive && wsActive.reader ? wsActive.reader : null;
        if (wsActive) wsActive.running = false;
        wsActive = null;
        var release = reader
          ? Promise.resolve(reader.cancel()).catch(function () {}).then(function () {
              try { reader.releaseLock(); } catch (ignored) {}
            })
          : Promise.resolve();
        return release
          .then(function () {
            if (wasRegistered) return doRpc("webserial_close", { portName: name }).catch(function () {});
            return null;
          })
          .then(function () { return Promise.resolve(port.close()).catch(function () {}); })
          .then(function () {
            var msg = (error && error.message) ? error.message : String(error);
            if (error && error.__appError) throw error;   // 后端业务错误原样抛
            throw new Error("打开本机串口失败：" + msg);
          });
      });
  }

  function wsDisconnect(deviceId) {
    if (!wsActive) {
      return Promise.resolve({
        deviceId: deviceId, connectionId: "webserial", portName: "",
        baudRate: 115200, state: "idle", connectedAtMs: Date.now(),
      });
    }
    var name = wsActive.name;
    var port = wsActive.port;
    var reader = wsActive.reader || null;
    wsActive.running = false;
    if (wsFlushTimer) { clearInterval(wsFlushTimer); wsFlushTimer = null; }
    if (wsSyncTimer) { clearInterval(wsSyncTimer); wsSyncTimer = null; }
    wsPushPending = null;
    wsSyncUp(); // 断开前把最后一帧送出去
    wsFlushRx();
    wsActive = null;
    /**
     * ⚠ **必须按顺序释放** ✗：`reader.cancel()` → `releaseLock()` → `port.close()` ✓。
     * 只关端口 ✗ → reader 还锁着 readable ✓ → close 抛错又被 catch 吞掉 ✓ →
     * 端口其实一直开着 ✓ → "一直被占着、连不上别的口"✗（本 bug ✓）。
     */
    var releaseReader = reader
      ? Promise.resolve(reader.cancel())
          .catch(function () {})
          .then(function () {
            try { reader.releaseLock(); } catch (ignored) {}
          })
      : Promise.resolve();
    /** 任何一步都**最多等 1.5 秒** ✓ —— 挂住就等于端口永远放不掉 ✗ */
    function withTimeout(promise, ms) {
      return Promise.race([
        promise.catch(function () {}),
        new Promise(function (resolve) { setTimeout(resolve, ms); }),
      ]);
    }
    return withTimeout(releaseReader, 1500)
      .then(function () {
        return withTimeout(doRpc("webserial_close", { portName: name }), 1500);
      })
      .then(function () {
        return withTimeout(port.close(), 1500);
      })
      .then(function () {
        console.info("[webserial] 已关闭 " + name);
        return {
          deviceId: deviceId, connectionId: "webserial", portName: name,
          baudRate: 115200, state: "idle", connectedAtMs: Date.now(),
        };
      });
  }

  /* ── 多端同步客户端 ────────────────────────────────────────────────
   * 数据本来就是服务端共享的，这里只补 UI 层的同步：
   *   - 每秒上报 "我是谁 / 停在哪一页"，换取在线端列表和别人的动作
   *   - 开了 ?sync=1 时，别人切页会带动本端一起切（"一端操作、多端跟随"）
   * 默认不开自动跟随：多人同时看不同页是正常需求，强制跟随反而烦人。
   * ─────────────────────────────────────────────────────────────── */
  var SYNC_ID = (function () {
    try {
      var key = "softui:clientId";
      var existing = sessionStorage.getItem(key);
      if (!existing) {
        existing = "c" + Math.random().toString(36).slice(2, 10);
        sessionStorage.setItem(key, existing);
      }
      return existing;
    } catch (error) {
      return "c" + Math.random().toString(36).slice(2, 10);
    }
  })();
  var SYNC_LABEL =
    window.matchMedia && window.matchMedia("(max-width: 640px)").matches ? "手机" : "桌面";
  var SYNC_ON = /[?&]sync=1\b/.test(location.search);
  var SYNC_SEQ = 0;
  var SYNC_CLIENTS = 0;
  var SYNC_SOURCE = null;
  var SYNC_LAST_PAGE = null;
  var syncBusy = false;

  function syncTick() {
    if (syncBusy) return;
    syncBusy = true;
    var path = location.pathname;
    doRpc("sync_poll", { clientId: SYNC_ID, label: SYNC_LABEL, page: path, since: SYNC_SEQ })
      .then(function (res) {
        if (!res) return;
        if (typeof res.seq === "number") SYNC_SEQ = res.seq;
        SYNC_CLIENTS = (res.clients || []).length;
        SYNC_SOURCE = res.source || null;

        (res.events || []).forEach(function (event) {
          if (!event || event.from === SYNC_ID) return;
          if (event.type === "page" && SYNC_ON && typeof event.page === "string") {
            var link = document.querySelector('a.sidebar-nav-link[href="' + event.page + '"]');
            if (link) link.click();
          }
        });

        if (SYNC_LAST_PAGE === null) {
          SYNC_LAST_PAGE = path; // 首帧只记录，不广播
        } else if (SYNC_ON && path !== SYNC_LAST_PAGE) {
          SYNC_LAST_PAGE = path;
          doRpc("sync_emit", { clientId: SYNC_ID, event: { type: "page", page: path } }).catch(
            function () {},
          );
        }
      })
      .catch(function () {})
      .then(function () {
        syncBusy = false;
      });
  }

  /** **多端同步轮询 1s → 3s** ✓ —— 只是"谁在哪一页"的信息 ✓，不必秒级 ✓ */
  setInterval(syncTick, 3000);
  setTimeout(syncTick, 800);

  /* ── 通用 UI 状态同步 ────────────────────────────────────────────────
   * 前端状态（拖动目标 / 末端位姿草稿 / 电机草稿…）各自只活在安装它的浏览器里，
   * 别的端无从得知。这里统一走一条按键单槽通道：
   *   本端改 → softui:local-ui  → ui_publish(key, 最新值)
   *   别端改 → ui_state 轮询    → softui:remote-ui(key, 值)
   * 换一个 key 就能同步一种新状态，不用再改传输层。
   *
   * 速率自适应：有人在动时 50ms，空闲 1s —— 拖动是连续流，空闲时不该占带宽。
   * 自己写的那份按 from 跳过，天然防回环。
   * ─────────────────────────────────────────────────────────────────── */
  /* 模拟设备是否在线：徽标上的「模拟数据」按钮据此显示开/关。 */
  var SIM_ON = null;

  function refreshSimState() {
    doRpc("list_connected_devices", {})
      .then(function (devices) {
        SIM_ON = Array.isArray(devices)
          ? devices.some(function (d) { return d.portName === "simulator"; })
          : null;
      })
      .catch(function () {});
  }

  var UI_SEEN = {};          // key -> 已应用的 seq
  var UI_REMOTE = {};        // key -> 最近一次收到的别端值（用于补发）
  var UI_LOCAL = {};         // key -> 本端是否改过（改过就不再用远端值覆盖）
  var UI_PUB = 0;            // 本端发布次数
  var UI_RECV = 0;           // 收到别端次数
  var UI_TOTAL = 0;          // 后端当前拥有的槽位数（进度分母）
  var UI_LAST_RECV_AT = 0;   // 最近一次收到远端值的时刻
  var UI_BOOST_UNTIL = 0;

  /* 本端改动的发送策略：**合并 + 限频**。
   *
   * 原来每个 pointermove 都发一次完整状态。拖动是 60Hz，而隧道上行只有
   * 约 250KB/s —— 一份拖动目标是几 KB，请求立刻在队列里堆起来，
   * 最后一帧要排队好几秒才发出去，对端拿到的自然是旧值（"值不一致"的根因）。
   *
   * 现在：按键只保留最新待发值，最多 25Hz 发一次，且同一 key 在途时跳过。
   * 于是队列永远最多积压一份，**最后一帧一定会被发出去**，
   * 不会因为"中间那些没人看"而丢掉终点值。 */
  var UI_PENDING = {};
  var UI_INFLIGHT = {};
  var UI_FLUSH_TIMER = null;

  function scheduleFlush() {
    if (UI_FLUSH_TIMER) return;
    UI_FLUSH_TIMER = setTimeout(flushUi, 40); // 上限 25Hz
  }

  function flushUi() {
    UI_FLUSH_TIMER = null;
    Object.keys(UI_PENDING).forEach(function (key) {
      // 允许最多 2 个在途：原来只放 1 个，发送速率被往返时延卡死在 1/RTT。
      // 放 2 个能把有效速率翻倍，又不会让队列无限堆积（仍然只积压最新值）。
      if ((UI_INFLIGHT[key] || 0) >= 2) return;
      var payload = UI_PENDING[key];
      delete UI_PENDING[key];
      UI_INFLIGHT[key] = (UI_INFLIGHT[key] || 0) + 1;
      UI_PUB += 1;
      doRpc("ui_publish", { clientId: SYNC_ID, key: key, payload: payload }).then(
        function () {
          UI_INFLIGHT[key] -= 1;
          if (Object.prototype.hasOwnProperty.call(UI_PENDING, key)) scheduleFlush();
        },
        function (error) {
          UI_INFLIGHT[key] -= 1;
          // 失败必须把值放回队列重试。原来发之前就 delete 掉、失败又不管，
          // 一次网络抖动就让这次改动**永久丢失** —— 对端停在旧值上，
          // 必须手动再动一次才同步（这就是"显示已同步但数据是上一轮的"根因）。
          // 期间如果用户已经改了新值，用新值，别用旧的覆盖。
          if (!Object.prototype.hasOwnProperty.call(UI_PENDING, key)) {
            UI_PENDING[key] = payload;
          }
          console.warn("[softui] 同步发布失败，已排队重试:", key, error && error.message);
          scheduleFlush();
        },
      );
    });
  }

  window.addEventListener("softui:local-ui", function (event) {
    UI_BOOST_UNTIL = Date.now() + 1500;
    var detail = (event && event.detail) || {};
    if (!detail.key) return;
    UI_PENDING[detail.key] = detail.payload === undefined ? null : detail.payload;
    UI_LOCAL[detail.key] = true; // 本端改过这个键，补发时不再用远端值覆盖它
    scheduleFlush();
  });

  var UI_GLOBAL_SEQ = 0;

  function uiTick() {
    // 长轮询：后端有新值会立刻返回，没值最多挂 20 秒再回来。
    // 接收延迟因此从"最多一个轮询周期 + 往返"降到"一次单程"。
    doRpc("ui_wait", { since: UI_GLOBAL_SEQ, timeoutMs: 20000 })
      .then(function (res) {
        if (res && typeof res.seq === "number") UI_GLOBAL_SEQ = res.seq;
        var entries = (res && res.entries) || {};
        // 进度分母：后端当前真实持有的槽位数（排除纯信号键）
        var counted = Object.keys(entries).filter(function (key) {
          return key !== "deviceChange" && key !== UI_RESYNC_KEY;
        }).length;
        if (counted > UI_TOTAL) UI_TOTAL = counted;
        Object.keys(entries).forEach(function (key) {
          var entry = entries[key];
          if (!entry || entry.from === SYNC_ID) return;
          if (UI_SEEN[key] === entry.seq) return;
          UI_SEEN[key] = entry.seq;
          UI_LAST_RECV_AT = Date.now();
          // 别端请求重发：本端组件把自己的当前状态再发布一遍
          if (key === UI_RESYNC_KEY) {
            window.dispatchEvent(new CustomEvent("softui:ui-republish"));
            return;
          }
          UI_REMOTE[key] = entry.payload;
          UI_RECV += 1;
          UI_BOOST_UNTIL = Date.now() + 1200;
          window.dispatchEvent(
            new CustomEvent("softui:remote-ui", { detail: { key: key, payload: entry.payload } }),
          );
        });
      })
      .catch(function () {})
      .catch(function () {
        // 长轮询失败（后端重启等）：退避 1 秒再试，不要打爆服务
        return new Promise(function (resolve) { setTimeout(resolve, 1000); });
      })
      .then(function () {
        // 就地判断：调度这一刻是否还有人在动。
        // 最小间隔 30ms —— 长轮询一旦立刻返回（后端异常、seq 落后、代理瞬断），
        // 不加下限就会退化成毫秒级忙轮询，把服务端打满。宁可慢一点也不能打爆。
        var fast = Date.now() < UI_BOOST_UNTIL;
        setTimeout(uiTick, fast ? 30 : 1000);
      });
  }

  /**
   * 补发：组件挂载时主动要一次当前远端状态。
   *
   * 为什么必须补发：桩在页面加载后约 900ms 就开始派发远端值，而 WorkspacePage
   * 要等登录完成、再切到工作台才挂载 —— 那时的派发全被丢掉了。
   * 表现就是"新设备打开看不到当前状态，必须旧设备再动一次才同步"。
   *
   * 只补发**本端没改过**的键，避免把用户的新操作覆盖回旧值。
   */
  var UI_RESYNC_KEY = "resyncRequest";

  window.addEventListener("softui:ui-resync", function () {
    // ① 先用本地缓存的远端值补一遍
    Object.keys(UI_REMOTE).forEach(function (key) {
      if (UI_LOCAL[key]) return;
      window.dispatchEvent(
        new CustomEvent("softui:remote-ui", { detail: { key: key, payload: UI_REMOTE[key] } }),
      );
    });
    // ② 再请其它端重新发布一次。
    //    为什么必要：同步槽位是**纯内存**的，网关一重启就全没了。
    //    这时新加入的端从后端什么都拿不到，只有老端重新发布才能补齐 ——
    //    否则必须手动去碰每一个控件，这正是"更新好几次才对"的来源。
    doRpc("ui_publish", {
      clientId: SYNC_ID,
      key: UI_RESYNC_KEY,
      payload: Date.now(),
    }).catch(function () {});
  });

  setTimeout(uiTick, 300); // 早一点开始拉，少一点"打开后空等"

  /* ── 刷新后自动重连串口 ─────────────────────────────────────────────
   * 刷新会丢掉 `wsActive`（本端没有打开的端口），而设备登记在**网关内存**里 ——
   * 于是界面还显示着设备、每条指令却报 `DeviceNotFound("TDCR_v1")`，
   * 表现是"拖了没反应、目标值永远是 --"。实测就是卡在这里。
   *
   * `port.open()` **不需要用户手势**（只有 `requestPort()` 需要），所以能自动补回来。
   * **只在恰好授权过一个端口时自动连** —— 多端口时无法判断该连哪个，
   * 宁可让操作员自己选，也不能连错设备。
   */
  /**
   * **端口的物理指纹** ✓ —— Web Serial 拿不到 COM 号 ✗，
   * 但 `getInfo()` 有 USB 的 VID/PID ✓（同型号会撞车 ✓，但足以区分"是不是上次那条"✓）。
   */
  function portKey(port) {
    try {
      var info = port && port.getInfo ? port.getInfo() : {};
      var vid = info.usbVendorId == null ? 0 : info.usbVendorId;
      var pid = info.usbProductId == null ? 0 : info.usbProductId;
      return vid + ":" + pid;
    } catch (ignored) {
      return "0:0";
    }
  }

  /**
   * **清理残留的浏览器串口登记** ✓ —— 页面一加载就做一次 ✓。
   *
   * 场景：上一次会话异常退出（关标签 / 崩溃 / 旧版本没注销 ✓）→ 后端还留着
   * `webserial:N` 的登记 ✓ → 界面里挂着一条**根本用不了的设备** ✓，
   * 后端还会每秒尝试"重连"它 ✓（本 bug ✓）。
   *
   * 只注销**当前不是 ready/enabled** 的那些 ✓ —— 别的设备（手机）正在用的不动 ✗。
   */
  setTimeout(function () {
    if (wsActive) return;
    doRpc("list_connected_devices", {})
      .then(function (list) {
        (list || []).forEach(function (item) {
          var portName = String((item && item.portName) || "");
          var state = String((item && item.state) || "");
          if (portName.indexOf("webserial:") !== 0) return;
          if (state === "ready" || state === "enabled") return;
          doRpc("webserial_close", { portName: portName }).catch(function () {});
          console.info("[webserial] 已注销残留登记 " + portName + "（state=" + state + "）");
        });
      })
      .catch(function () {});
  }, 1500);

  /**
   * **不做任何自动重连** ✗ —— 用户明确要求"不许自己连串口" ✓。
   *
   * 历史教训（三次）：只要浏览器里授权过端口 ✓，就总有一段逻辑会把它 `open()` 掉 ✗ →
   * 表现是"一刷新就自动连上、而且连的不一定是我要的那条"✗，
   * 并且会留下"已连接但收不到数据"的僵尸设备 ✓（接收帧卡住 ✓）。
   *
   * 现在：**连不连、连哪条，完全由操作员点** ✓（「扫描串口」→ 选一行 → 连接 ✓）。
   * 需要自动补连的场景（比如移动端断线重连）请显式调用 `__SOFTUI_WS__.reconnect()`
   * 一类的能力，而不是默认行为 ✓。
   */

  var windowInFlight = null;
  var windowLast = null;

  function windowOverride() {
    var m = /[?&]win=(\d+)/.exec(location.search);
    if (!m) return 0;
    var n = parseInt(m[1], 10);
    return n >= 10 && n <= 600 ? n : 0;
  }

  function rpcInvoke(cmd, args) {
    /* 登录：把设备身份补进请求，并把后端签发的 token 存到本机。
     * 为什么放在桩里而不是页面里：token 的读写只应有一个地方（这里），
     * 页面只管调用命令，不必知道传输层凭据的存在。 */
    if (cmd === "login") {
      var req = (args && args.request) || {};
      if (!req.clientId) req.clientId = SYNC_ID;
      if (!req.label) req.label = SYNC_LABEL;
      args = Object.assign({}, args, { request: req });
      return doRpc(cmd, args).then(function (result) {
        if (result && result.token) setToken(result.token);
        return result;
      });
    }

    /* 登出：无论后端成功与否，本机凭证都必须清掉 ——
     * 否则会出现"点了登出、状态是未登录，可下次请求又带着旧 token 进去了"。 */
    if (cmd === "logout") {
      return doRpc(cmd, args).then(
        function (result) { setToken(""); return result; },
        function (error) { setToken(""); throw error; },
      );
    }

    // 串口枚举走本机，且必须同步发起以保留"用户手势"（requestPort 的硬性要求）
    if (cmd === "list_serial_ports") return listLocalSerialPorts(Boolean(args && args.forcePick));

    // 拥有串口的那一端直接答本地数据：零往返、零下行流量
    if (P1_LOCAL_PARSE && wsActive && wsCodec) {
      if (cmd === "fetch_live_latest") {
        return Promise.resolve({
          selectedDeviceId: DEVICE_NAME,
          latest: wsLastFrame,
          stats: localStats(),
        });
      }
      if (cmd === "fetch_live_window") {
        var n = Math.max(1, Math.min(WS_CAPACITY, (args && args.count) || 240));
        return Promise.resolve(wsRing.slice(-n));
      }
    }

    // 本机串口的连接/断开由前端处理：真实串口在用户机器上，后端够不着
    if (cmd === "connect_device") {
      var req = (args && args.request) || {};
      var pn = String(req.portName || "");
      if (pn.indexOf("webserial:") === 0) {
        /**
         * ⚠ **不要 `|| 0` 回退** ✗ —— 索引解析不出来时回退到 0 ✓
         * 就是"悄悄连上第一条端口"✗（正是"自动连了别的口"的来源之一 ✓）。
         * 解析失败 / 索引失效一律报错 ✓，让操作员重新扫描选口 ✓。
         */
        var wsIndex = parseInt(pn.slice(10), 10);
        if (!Number.isFinite(wsIndex) || wsIndex < 0) {
          return Promise.reject(new Error("串口索引无效（" + pn + "），请点「扫描串口」重新选择。"));
        }
        return wsConnect(wsIndex, req.baudRate);
      }
      return doRpc(cmd, args);
    }
    if (cmd === "disconnect_device") {
      var did = String((args && args.deviceId) || "");
      if (did.indexOf("webserial:") === 0 || wsActive) return wsDisconnect(did);
      return doRpc(cmd, args);
    }
    if (cmd !== "fetch_live_window") return doRpc(cmd, args);

    var override = windowOverride();
    var nextArgs = args || {};
    if (override) nextArgs = Object.assign({}, nextArgs, { count: override });

    if (windowInFlight) return Promise.resolve(windowLast || []);
    windowInFlight = doRpc(cmd, nextArgs)
      .then(function (frames) {
        windowLast = frames;
        return frames;
      })
      .catch(function (error) {
        windowInFlight = null;
        throw error;
      })
      .then(function (frames) {
        windowInFlight = null;
        return frames;
      });
    return windowInFlight;
  }

  window.__TAURI_INTERNALS__ = {
    invoke: function (cmd, args) {
      return rpcInvoke(cmd, args);
    },
    transformCallback: function (callback, once) {
      var id = ++seq;
      window["_" + id] = function (payload) {
        callback(payload);
        if (once) delete window["_" + id];
      };
      return id;
    },
    unregisterCallback: function (id) { delete window["_" + id]; },
    convertFileSrc: function (p) { return p; },
    __shim: true,
  };

  window.__SOFTUI_SHIM__ = {
    version: 11.1,
    calls: function () { return lastCalls.slice(); },
    snapshot: function () { return clone(snapshot); },
  };

  /* ── 可见的版本与实时帧计数器 ──
   * 存在的意义：让"数据到底有没有在动"变成肉眼可判断的事，
   * 不用开控制台猜。计数器在跳 = 仿真在送帧；不动 = 桩没加载或被浏览器缓存了旧版。
   * 用 ?badge=0 关掉。 */
  /* ── 状态徽标：默认收缩成小球，避免遮挡内容 ────────────────────────
   * 常驻的横条会压住右下角的界面元素（尤其是工作台的卡片）。改成：
   *   - 默认显示一个 16px 小圆球，颜色即状态（绿=真后端 / 黄=仿真兜底 / 灰=未知）
   *   - 点球展开完整信息与「模拟数据」按钮，展开后 6 秒无操作自动收回
   *   - 鼠标移出面板 1.2 秒后收回，不用手动点
   * ─────────────────────────────────────────────────────────────── */
  function mountBadge() {
    if (/[?&]badge=0\b/.test(location.search)) return;

    var el = document.createElement("div");
    el.id = "softui-shim-badge";
    el.style.cssText = [
      "position:fixed", "right:10px", "bottom:10px", "z-index:2147483647",
      "font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace",
      "letter-spacing:.2px",
    ].join(";");

    var ball = document.createElement("button");
    ball.type = "button";
    ball.title = "运行状态（点击展开）";
    ball.setAttribute("aria-label", "展开运行状态");
    ball.style.cssText =
      "pointer-events:auto;cursor:pointer;display:block;margin-left:auto;" +
      "width:16px;height:16px;padding:0;border-radius:50%;" +
      "border:1px solid rgba(255,255,255,.45);background:#8b949e;" +
      "box-shadow:0 2px 8px rgba(0,0,0,.35);transition:opacity 160ms ease";

    var panel = document.createElement("div");
    panel.style.cssText =
      "display:none;align-items:center;padding:6px 10px;border-radius:8px;" +
      "background:rgba(16,18,24,.82);color:#e6e8ef;pointer-events:auto;" +
      "border:1px solid rgba(255,255,255,.14);white-space:nowrap";

    var label = document.createElement("span");
    var simButton = document.createElement("button");
    simButton.type = "button";
    simButton.style.cssText =
      "margin-left:8px;cursor:pointer;font:inherit;padding:1px 7px;" +
      "border-radius:4px;color:inherit;background:transparent;" +
      "border:1px solid rgba(255,255,255,.28)";
    simButton.addEventListener("click", function () {
      var next = SIM_ON ? "simulator_stop" : "simulator_start";
      simButton.disabled = true;
      simButton.textContent = "切换中…";
      doRpc(next, {})
        .then(function (value) {
          SIM_ON = !!value;
          refreshSimState();
          window.dispatchEvent(new CustomEvent("softui:ui-resync"));
        })
        .catch(function (error) {
          console.warn("[softui] 切换模拟数据失败:", error && error.message);
        })
        .then(function () {
          simButton.disabled = false;
        });
    });
    panel.appendChild(label);
    panel.appendChild(simButton);
    el.appendChild(ball);
    el.appendChild(panel);

    var hideTimer = null;
    function collapse() {
      panel.style.display = "none";
      ball.style.display = "block";
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    }
    function expand() {
      ball.style.display = "none";
      panel.style.display = "inline-flex";
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(collapse, 6000); // 展开后 6 秒无操作自动收回
    }
    ball.addEventListener("click", function (event) {
      event.stopPropagation();
      expand();
    });
    panel.addEventListener("mouseenter", function () {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    });
    panel.addEventListener("mouseleave", function () {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(collapse, 1200);
    });
    collapse();

    refreshSimState();
    (document.body || document.documentElement).appendChild(el);

    setInterval(function () {
      // 小球颜色直接表达状态，不用展开也能看出后端是否正常
      var color = backend.mode === "rust"
        ? "#3fb950"
        : backend.mode === "sim"
          ? "#d29922"
          : "#8b949e";

      var role = OBSERVER ? "观察端" : "数据源端";
      var parseMode = P1_LOCAL_PARSE ? "本机解析" : "后端解析";
      // 协议版本与新帧计数都照实显示：出问题时一眼分出是「协商没成」还是
      // 「压根没收到张力帧」，不用回去翻控制台。
      var proto = wsActive && wsCodec
        ? " · " + (wsCodec.lastVersion() >= 2 ? "V2" : "V1")
        : "";
      // **张力感知帧已移除** ✓ —— 只保留状态帧里的张力通道数据 ✓，徽标不再显示 τ 计数 ✓
      var telemetry = wsCalibrationEvents > 0 || wsUnknownFrames > 0
        ? " · ⊙" + wsCalibrationEvents + " · ?" + wsUnknownFrames
        : "";
      var src = SYNC_SOURCE
        ? (SYNC_SOURCE.self ? " · 本端供数" : " · 源:" + (SYNC_SOURCE.label || SYNC_SOURCE.clientId))
        : " · 无串口";
      var multi = SYNC_CLIENTS > 0 ? " · 多端" + SYNC_CLIENTS + (SYNC_ON ? "(跟随)" : "") : "";

      if (backend.mode === "rust") {
        var applied = 0;
        Object.keys(UI_SEEN).forEach(function (key) {
          if (key !== "deviceChange" && key !== UI_RESYNC_KEY) applied += 1;
        });
        // 用"距上次收到远端值多久"代替"已同步/未同步"：
        // 前者是事实，后者只是"经手过的键数够了"，容易在数据陈旧时误报正常。
        var sinceRecv = UI_LAST_RECV_AT ? (Date.now() - UI_LAST_RECV_AT) / 1000 : -1;
        var pending = Object.keys(UI_PENDING).length;
        var syncLabel = UI_TOTAL === 0
          ? ""
          : " · " + applied + "/" + UI_TOTAL +
            (sinceRecv < 0 ? "" : " · " + (sinceRecv < 10 ? sinceRecv.toFixed(1) + "s前" : "空转" + Math.round(sinceRecv) + "s")) +
            (pending > 0 ? " · 待发" + pending : "");
        label.textContent = "Rust · " + role + " · " + parseMode + proto + src + multi + syncLabel + telemetry;
        // 同步中让小球半透明呼吸，一眼看出在干活
        ball.style.opacity = sinceRecv >= 0 && sinceRecv < 1.5 ? "0.55" : "1";
      } else if (backend.mode === "sim") {
        label.textContent = "后端 浏览器仿真（Rust 不可达）· 仿真 " + backend.sim + " 次";
        ball.style.opacity = "1";
      } else {
        label.textContent = "等待后端…";
        ball.style.opacity = "1";
      }

      simButton.textContent =
        SIM_ON === null ? "模拟数据 ?" : SIM_ON ? "模拟数据 开" : "模拟数据 关";
      ball.style.background = color;
    }, 200);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountBadge);
  } else {
    mountBadge();
  }

  console.warn("[tauri-shim v11.1] 网页预览模式：内置 6 腱连续体机械臂仿真（100 Hz），录制与回放可用。");
})();
