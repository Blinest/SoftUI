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
        raw: [f + n * 2, 0, 0],
        filtered: [f + n, 0, 0],
        alias: ["F" + (c + 1), "-", "-"],
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

  var EMPTY_LISTS = ["list_users", "list_serial_ports", "list_connection_profiles", "read_session_frames", "playback_get_window", "playback_commands"];

  var HANDLERS = {
    bootstrap_state: function () { return clone(snapshot); },
    tick_snapshot: function () { return clone(snapshot); },

    login: function () {
      snapshot.authSession = { authenticated: true, username: "web-preview", role: "admin", permissions: [], mustChangePassword: false };
      return clone(snapshot.authSession);
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
    preview_legacy_migration: function () { return null; },
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

  function doRpc(cmd, args) {
    lastCalls.push({ cmd: cmd, args: args, at: nowMs() });
    if (lastCalls.length > 200) lastCalls.shift();

    return fetch("/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
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
          return payload.data;
        }
        var appError = new Error((payload && payload.error) || "后端返回失败");
        appError.__appError = true;
        throw appError;
      })
      .catch(function (error) {
        if (error && error.__appError) {
          backend.errors += 1;
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

    var label = "本机串口 " + (index + 1);
    if (vid !== null) {
      var vendor = USB_VENDORS[vid] || ("厂商 " + hex4(vid));
      label += " · " + vendor;
      if (pid !== null) label += " [" + hex4(vid) + ":" + hex4(pid) + "]";
    } else {
      label += "（非 USB 串口，浏览器不提供端口号）";
    }

    return {
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

  function syncWsPorts(ports) {
    wsPorts = ports.slice();
    window.__SOFTUI_WS_PORTS__ = wsPorts;   // 供后续真正做本地 I/O 时取用
    return wsPorts.map(wsDescribe);
  }

  var DEVICE_NAME = (/[?&]device=([A-Za-z0-9_.-]{1,32})/.exec(location.search) || [])[1] || "TDCR_v1";
  var wsHasGranted = false;

  function listLocalSerialPorts() {
    if (!navigator.serial || typeof navigator.serial.getPorts !== "function") {
      var why = window.isSecureContext === false
        ? "当前不是安全上下文（Web Serial 要求 HTTPS 或 localhost）。"
        : "当前浏览器不支持 Web Serial —— 请用桌面版 Chrome 或 Edge。";
      return Promise.reject(new Error(why));
    }

    // 关键：requestPort() 必须在用户点击的**同一个同步调用栈**里发起。
    // 中间只要夹一个 await，Chrome 就判定"用户手势已失效"而静默什么都不弹 ——
    // 表现就是点了「扫描串口」毫无反应。所以首次扫描时这里同步把选择框弹出。
    var pick = null;
    if (!wsHasGranted || FORCE_PICK) {
      try {
        pick = navigator.serial.requestPort();
      } catch (error) {
        pick = Promise.reject(error);
      }
    }

    var merge = function (granted) {
      wsHasGranted = granted.length > 0;
      wsPorts = granted.slice();
      window.__SOFTUI_WS_PORTS__ = wsPorts;
      if (granted.length === 0) {
        throw new Error(
          "没有选中任何串口。点「扫描串口」后浏览器会弹出端口选择框，" +
          "请在列表里选中你的设备（Windows 上通常显示为 COM3）并确认。"
        );
      }
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
  var wsPumpTimer = null;

  function wsFlushRx() {
    if (!wsActive || wsRxBuf.length === 0) return;
    var bytes = wsRxBuf;
    wsRxBuf = [];
    doRpc("webserial_push", { portName: wsActive.name, bytes: bytes }).catch(function (e) {
      console.warn("[webserial] 推字节失败:", e && e.message);
    });
  }

  function wsPumpTick() {
    if (!wsActive || !wsActive.running) return;
    wsFlushRx();
    doRpc("webserial_take_tx", { portName: wsActive.name })
      .then(function (bytes) {
        if (!bytes || bytes.length === 0 || !wsActive || !wsActive.running) return;
        var writable = wsActive.port.writable;
        if (!writable) return;
        var writer = writable.getWriter();
        return writer
          .write(new Uint8Array(bytes))
          .then(function () { writer.releaseLock(); })
          .catch(function (e) {
            try { writer.releaseLock(); } catch (ignored) {}
            console.warn("[webserial] 写串口失败:", e && e.message);
          });
      })
      .catch(function () { /* 后端暂时不可达，下一拍再试 */ });
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
      (function pump() {
        reader
          .read()
          .then(function (result) {
            if (!wsActive || !wsActive.running || result.done) {
              try { reader.releaseLock(); } catch (ignored) {}
              return;
            }
            var value = result.value;
            if (value && value.length) {
              for (var i = 0; i < value.length; i += 1) wsRxBuf.push(value[i]);
              // 攒到一定量就先发，避免等下一拍造成延迟
              if (wsRxBuf.length >= 4096) wsFlushRx();
            }
            pump();
          })
          .catch(function () {
            try { reader.releaseLock(); } catch (ignored) {}
          });
      })();
    })();
  }

  function wsConnect(index, baudRate) {
    var port = wsPorts[index];
    if (!port) {
      return Promise.reject(new Error("找不到本机串口 " + index + "，请先点「扫描串口」重新选择。"));
    }
    var baud = baudRate || 115200;
    var name = "webserial:" + index;
    return port
      .open({ baudRate: baud })
      .then(function () {
        return doRpc("webserial_open", {
          portName: name,
          baudRate: baud,
          // 设备显示名。Web Serial 拿不到 COM 号，这里给一个业务上有意义的名字，
          // 界面和录制会话里就用它标识设备。
          deviceName: DEVICE_NAME,
        });
      })
      .then(function (record) {
        wsActive = { index: index, name: name, port: port, running: true };
        wsStartRead();
        if (wsPumpTimer) clearInterval(wsPumpTimer);
        wsPumpTimer = setInterval(wsPumpTick, 20);
        console.info("[webserial] 已打开本机串口 " + name + " @ " + baud);
        return record;
      })
      .catch(function (error) {
        var msg = (error && error.message) ? error.message : String(error);
        throw new Error("打开本机串口失败：" + msg);
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
    wsActive.running = false;
    if (wsPumpTimer) { clearInterval(wsPumpTimer); wsPumpTimer = null; }
    wsFlushRx();
    wsActive = null;
    return doRpc("webserial_close", { portName: name })
      .catch(function () {})
      .then(function () {
        return port.close().catch(function () {});
      })
      .then(function () {
        console.info("[webserial] 已关闭 " + name);
        return {
          deviceId: deviceId, connectionId: "webserial", portName: name,
          baudRate: 115200, state: "idle", connectedAtMs: Date.now(),
        };
      });
  }

  var windowInFlight = null;
  var windowLast = null;

  function windowOverride() {
    var m = /[?&]win=(\d+)/.exec(location.search);
    if (!m) return 0;
    var n = parseInt(m[1], 10);
    return n >= 10 && n <= 600 ? n : 0;
  }

  function rpcInvoke(cmd, args) {
    // 串口枚举走本机，且必须同步发起以保留"用户手势"（requestPort 的硬性要求）
    if (cmd === "list_serial_ports") return listLocalSerialPorts();

    // 本机串口的连接/断开由前端处理：真实串口在用户机器上，后端够不着
    if (cmd === "connect_device") {
      var req = (args && args.request) || {};
      var pn = String(req.portName || "");
      if (pn.indexOf("webserial:") === 0) {
        return wsConnect(parseInt(pn.slice(10), 10) || 0, req.baudRate);
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
    version: 5.3,
    calls: function () { return lastCalls.slice(); },
    snapshot: function () { return clone(snapshot); },
  };

  /* ── 可见的版本与实时帧计数器 ──
   * 存在的意义：让"数据到底有没有在动"变成肉眼可判断的事，
   * 不用开控制台猜。计数器在跳 = 仿真在送帧；不动 = 桩没加载或被浏览器缓存了旧版。
   * 用 ?badge=0 关掉。 */
  function mountBadge() {
    if (/[?&]badge=0\b/.test(location.search)) return;
    var el = document.createElement("div");
    el.id = "softui-shim-badge";
    el.style.cssText = [
      "position:fixed", "right:10px", "bottom:10px", "z-index:2147483647",
      "padding:6px 10px", "border-radius:8px",
      "background:rgba(16,18,24,.82)", "color:#e6e8ef",
      "font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace",
      "border:1px solid rgba(255,255,255,.14)", "pointer-events:none",
      "letter-spacing:.2px", "white-space:nowrap",
    ].join(";");
    (document.body || document.documentElement).appendChild(el);

    setInterval(function () {
      var ws = !navigator.serial
        ? "不可用"
        : (window.isSecureContext === false ? "需HTTPS" : "可用/" + wsPorts.length + "口");
      if (backend.mode === "rust") {
        el.textContent = "后端 Rust · " + backend.rust + " 次 · Web Serial " + ws;
        el.style.borderColor = "rgba(80,200,120,.55)";
      } else if (backend.mode === "sim") {
        el.textContent = "后端 浏览器仿真（Rust 不可达）· 仿真 " + backend.sim + " 次";
        el.style.borderColor = "rgba(230,170,60,.55)";
      } else {
        el.textContent = "等待后端…";
      }
    }, 200);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountBadge);
  } else {
    mountBadge();
  }

  console.warn("[tauri-shim v5.3] 网页预览模式：内置 6 腱连续体机械臂仿真（100 Hz），录制与回放可用。");
})();
