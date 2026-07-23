import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  AlertTriangle,
  ArrowRightLeft,
  BarChart3,
  Cable,
  CheckCircle2,
  ChevronRight,
  Cpu,
  Database,
  Eye,
  Fingerprint,
  LayoutDashboard,
  ListChecks,
  Logs,
  MoonStar,
  PauseCircle,
  Play,
  RefreshCw,
  Save,
  Settings2,
  SlidersHorizontal,
  SquareTerminal,
  SunMedium,
  Table2,
  Wifi,
} from "lucide-react";
import { HashRouter, NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";

import "./App.css";
import ChartsPage from "./charts";
import ConnectDialog from "./components/ConnectDialog";
import DeviceCard from "./components/DeviceCard";
import PlaybackBar from "./components/PlaybackBar";
import SessionsPage from "./pages/SessionsPage";
import type {
  CalibrationStep,
  AuthSession,
  ConnectDeviceRequest,
  ConnectionProfile,
  DeviceConnectionRecord,
  DeviceRuntimeStatusView,
  DeviceSnapshot,
  LogEntry,
  LogLevel,
  LegacyMigrationPreview,
  LegacyMigrationReport,
  PageKey,
  MotorState,
  PlaybackStatus,
  RecorderStatus,
  Role,
  RuntimeSnapshot,
  SerialPortDescriptor,
  SessionInfo,
  SensorState,
  ThemeMode,
  UserAccount,
} from "./softuiTypes";

type NavItem = {
  key: PageKey;
  path: string;
  icon: LucideIcon;
  title: string;
  subtitle: string;
};

const navItems: NavItem[] = [
  { key: "Dashboard", path: "/dashboard", icon: LayoutDashboard, title: "总览", subtitle: "运行概况" },
  { key: "Workspace", path: "/workspace", icon: Cpu, title: "设备工作区", subtitle: "串口 / 状态 / 控制" },
  { key: "Charts", path: "/charts", icon: BarChart3, title: "曲线分析", subtitle: "实时与历史曲线" },
  { key: "Sessions", path: "/sessions", icon: Database, title: "会话与记录", subtitle: "录制与导出" },
  { key: "Logs", path: "/logs", icon: Logs, title: "日志管理", subtitle: "诊断与审计" },
  { key: "Settings", path: "/settings", icon: Settings2, title: "设置", subtitle: "路径与主题" },
];

const pageDescriptions: Record<PageKey, string> = {
  Dashboard: "查看设备、采样、会话和最近异常。",
  Workspace: "把串口、设备状态、实时表格、控制和回放放到同一工作区。",
  Charts: "查看电机、传感器和弯曲曲线。",
  Sessions: "录制实验数据、管理会话和导出 CSV。",
  Logs: "筛选运行日志和审计记录。",
  Settings: "调整主题、路径和布局偏好。",
  Model: "打开 3D 窗口壳子，后续再接模型内容。",
};

const pageTitles: Record<PageKey, string> = {
  Dashboard: "总览",
  Workspace: "设备工作区",
  Charts: "曲线分析",
  Sessions: "会话与记录",
  Logs: "日志管理",
  Settings: "设置",
  Model: "3D 窗口",
};

function routeToPage(pathname: string): PageKey {
  if (pathname.startsWith("/workspace")) return "Workspace";
  if (pathname.startsWith("/connection")) return "Workspace";
  if (pathname.startsWith("/live-table")) return "Workspace";
  if (pathname.startsWith("/charts")) return "Charts";
  if (pathname.startsWith("/model")) return "Model";
  if (pathname.startsWith("/calibration")) return "Workspace";
  if (pathname.startsWith("/playback")) return "Workspace";
  if (pathname.startsWith("/logs")) return "Logs";
  if (pathname.startsWith("/sessions")) return "Sessions";
  if (pathname.startsWith("/settings")) return "Settings";
  return "Dashboard";
}

function isoShort(ms: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

function isoFull(ms: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function toneForLevel(level: LogLevel) {
  switch (level) {
    case "warn":
      return "warn";
    case "error":
      return "error";
    case "debug":
      return "neutral";
    default:
      return "info";
  }
}

function makeDefaultLogs(): LogEntry[] {
  const now = Date.now();
  return [
    { id: 1, level: "info", scope: "boot", message: "SoftUI 运行时就绪", timestampMs: now },
    {
      id: 2,
      level: "info",
      scope: "connection",
      message: "模拟器握手完成",
      timestampMs: now - 8_000,
      deviceId: "softui-sim-01",
    },
    {
      id: 3,
      level: "warn",
      scope: "device",
      message: "使用模拟传输，等待选择串口",
      timestampMs: now - 16_000,
      deviceId: "softui-sim-01",
      frameHex: "BB 02 10 01 00 00 00 00 00 23",
    },
    {
      id: 4,
      level: "debug",
      scope: "stream",
      message: "实时快照已刷新",
      timestampMs: now - 24_000,
      deviceId: "softui-sim-01",
      frameHex: "BB 02 10 01 00 00 01 00 00 24",
    },
    {
      id: 5,
      level: "error",
      scope: "audit",
      message: "诊断包尚未导出",
      timestampMs: now - 32_000,
    },
  ];
}

function makeFallbackMotor(id: number, seed: number): MotorState {
  return {
    id,
    positionMm: 23.4 + seed * 0.8 + id * 0.9,
    velocityMmPerSec: 7.2 + seed * 0.35 + (id % 3) * 0.25,
    accelerationMmPerSec2: 2.0 + (id % 4) * 0.18,
    running: true,
    targetPositionMm: 25.0 + seed * 0.8 + id * 0.9,
  };
}

function makeFallbackSensor(id: number, seed: number): SensorState {
  return {
    id,
    raw: [31.5 + id * 0.4 + seed * 0.2, 17.2 + id * 0.25 + seed * 0.15, 11.1 + id * 0.18 + seed * 0.1],
    filtered: [30.9 + id * 0.35 + seed * 0.16, 16.8 + id * 0.2 + seed * 0.1, 10.7 + id * 0.14 + seed * 0.08],
    alias: ["X", "Y", "Z"],
    unit: "N",
    quality: "ok",
  };
}

function makeFallbackFrame(sequence: number, receivedAtMs: number, bend1: number, bend2: number): DeviceSnapshot {
  return {
    deviceId: "softui-sim-01",
    connectionId: "conn-01",
    receivedAtMs,
    sequence,
    protocolVersion: "Legacy V1",
    systemEnabled: true,
    motors: Array.from({ length: 6 }, (_, index) => makeFallbackMotor(index + 1, sequence / 120 + index * 0.3)),
    sensors: Array.from({ length: 6 }, (_, index) => makeFallbackSensor(index + 1, sequence / 150 + index * 0.18)),
    bend: {
      section1: { angleDeg: bend1, targetAngleDeg: bend1 + 4, direction: "up", quality: "ok" },
      section2: { angleDeg: bend2, targetAngleDeg: bend2 + 5, direction: "right", quality: "ok" },
    },
    quality: { status: "ok", latencyMs: sequence % 2 === 0 ? 18 : 19, droppedFrames: 0, checksumOk: true },
  };
}

function makeFallbackSnapshot(): RuntimeSnapshot {
  const now = Date.now();
  const frames: DeviceSnapshot[] = [
    makeFallbackFrame(1201, now, 31, 22),
    makeFallbackFrame(1200, now - 80, 30, 21),
  ];

  return {
    appInfo: {
      name: "SoftUI",
      version: "0.1.0",
      backend: "Rust + Tauri 2",
      frontend: "React + TypeScript + Three.js",
      platform: navigator.platform,
    },
    theme: "dark",
    connection: {
      state: "ready",
      activeProfileId: "sim-default",
      activeProfileName: "Simulator",
      profiles: [
        { id: "sim-default", name: "Simulator", port: "SIM", baudRate: 115200, dataBits: 8, parity: "none", stopBits: 1, flowControl: "none", autoReconnect: true },
        { id: "serial-legacy", name: "Legacy USB", port: "COM3", baudRate: 9600, dataBits: 8, parity: "none", stopBits: 1, flowControl: "none", autoReconnect: false },
      ],
      ports: ["COM3", "COM4", "ttyUSB0", "ttyACM0"],
      handshakeStep: "frame verification",
      handshakeProgress: 100,
      lastMessage: "Simulator stream active",
    },
    dashboard: {
      deviceCount: 2,
      connectedDevices: 1,
      currentSession: "session-20260714-002",
      sampleRateHz: 100,
      frameRateHz: 30,
      activeProfile: "sim-default",
      lastError: null,
    },
    live: { selectedDeviceId: "softui-sim-01", frames },
    charts: {
      windowSize: 96,
      channels: Array.from({ length: 6 }, (_, index) => ({
        name: `Motor ${index + 1}`,
        unit: "mm",
        channelType: "motor",
        channelIndex: index + 1,
        points: Array.from({ length: 96 }, (_, pointIndex) => {
          const x = pointIndex / (8 + index) + index * 0.35;
          return 0.5 + Math.sin(x) * (0.2 - index * 0.015) + Math.cos(x * 0.8) * (0.12 - index * 0.01);
        }),
      })),
    },
    model: {
      id: "default-continuum",
      name: "Default continuum robot",
      modelPath: "resources/models/default_robot.glb",
      section1MaxAngleDeg: 78,
      section2MaxAngleDeg: 64,
      section1Node: "section_1_root",
      section2Node: "section_2_root",
    },
    calibration: {
      selectedSection: "section1",
      targetAngles: [29, 24],
      captured: false,
      steps: [
        { id: 1, label: "Zero reference", done: true, active: true },
        { id: 2, label: "Upper segment", done: true, active: false },
        { id: 3, label: "Lower segment", done: false, active: false },
        { id: 4, label: "Positive bend", done: false, active: false },
        { id: 5, label: "Save profile", done: false, active: false },
      ],
    },
    playback: {
      activeSessionId: "session-20260714-002",
      speed: 1,
      cursorMs: 18000,
      durationMs: 126000,
      sessions: [
        { id: "session-20260714-001", name: "Bench verification", startTime: "2026-07-14T09:15:00+08:00", endTime: "2026-07-14T09:38:00+08:00", operator: "research", deviceIds: ["softui-sim-01"], recordCount: 18420 },
        { id: "session-20260714-002", name: "Closed-loop test", startTime: "2026-07-14T11:20:00+08:00", endTime: null, operator: "research", deviceIds: ["softui-sim-01"], recordCount: 9480 },
      ],
    },
    playbackMode: false,
    controlProfiles: [
      { id: "cycle-life", name: "Cycle life", enabled: true, cycleLifeEnabled: true, thresholdLow: 12, thresholdHigh: 48, cyclePeriodMs: 1250 },
      { id: "manual-safe", name: "Manual safe mode", enabled: false, cycleLifeEnabled: false, thresholdLow: 8, thresholdHigh: 42, cyclePeriodMs: 1500 },
    ],
    filterProfiles: [
      { id: "median-3", name: "Median 3", enabled: true, windowSize: 3, exponentialAlpha: 0.45 },
      { id: "ema", name: "EMA", enabled: true, windowSize: 5, exponentialAlpha: 0.32 },
    ],
    logs: makeDefaultLogs(),
    settings: {
      theme: "dark",
      workspaceDensity: "comfortable",
      saveLayoutOnExit: true,
      autoReconnect: true,
      diagnosticsLevel: "info",
      dataDirectory: "experiment_data",
      modelDirectory: "resources/models",
    },
    runtimeDiagnostics: {
      storedFrames: frames.length,
      liveCapacity: 120,
      totalFrames: frames.length,
      droppedFrames: 0,
      frameRateHz: 30,
      deviceCount: 1,
      pendingCommands: 0,
      sentCommands: 0,
      protocolErrors: 0,
      reconnectAttempts: 0,
      emergencyLatched: false,
      lastError: null,
    },
    controlRuntime: {
      pid: {
        kp: 0.35,
        ki: 0.04,
        kd: 0.08,
        deadbandDeg: 0.2,
        integralLimit: 30,
        outputLimit: 8,
        samplePeriodMs: 50,
      },
      cycle: {
        enabled: false,
        lowerAngleDeg: 12,
        upperAngleDeg: 48,
        toleranceDeg: 1,
        dwellMs: 250,
        maxCycles: 0,
      },
      phase: "idle",
      active: false,
      allowed: false,
      reason: "cycle life inactive",
      targetAngleDeg: 0,
      pidOutput: 0,
      motorDeltaMm: 0,
      cyclesCompleted: 0,
    },
    authSession: {
      authenticated: false,
      username: "",
      role: "operator",
      permissions: [],
      mustChangePassword: false,
    },
  };
}

function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "ok" | "warn" | "error" | "info" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

function StatCard({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone: "blue" | "green" | "amber" | "neutral" }) {
  return (
    <article className={`stat-card ${tone}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint ? <div className="stat-hint">{hint}</div> : null}
    </article>
  );
}

function Panel({
  title,
  subtitle,
  icon: Icon,
  action,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <section className={`panel ${wide ? "wide" : ""}`}>
      <div className="panel-head">
        <div>
          <div className="panel-kicker">{subtitle}</div>
          <h2>{title}</h2>
        </div>
        <div className="panel-action">
          {action ?? (Icon ? <Icon size={16} /> : null)}
        </div>
      </div>
      {children}
    </section>
  );
}

function LoginPage({
  theme,
  error,
  busy,
  mustChangePassword,
  onLogin,
  onChangePassword,
}: {
  theme: ThemeMode;
  error: string | null;
  busy: boolean;
  mustChangePassword: boolean;
  onLogin: (username: string, password: string) => Promise<void>;
  onChangePassword: (oldPassword: string, newPassword: string) => Promise<void>;
}) {
  const [username, setUsername] = useState(() => localStorage.getItem("softui:lastUsername") ?? "admin");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const submitLogin = async (event: FormEvent) => {
    event.preventDefault();
    await onLogin(username, password);
  };

  const submitPasswordChange = async (event: FormEvent) => {
    event.preventDefault();
    await onChangePassword(password, newPassword);
    setPassword("");
    setNewPassword("");
  };

  return (
    <div className={`login-shell theme-${theme}`}>
      <section className="login-panel">
        <div className="brand-mark login-mark">
          <Fingerprint size={22} />
        </div>
        <div>
          <div className="section-label">SoftUI</div>
          <h1>上位机登录</h1>
          <p>请先完成本地认证，再进入设备控制工作区。</p>
        </div>

        {!mustChangePassword ? (
          <form className="auth-form" onSubmit={submitLogin}>
            <label>
              <span>用户名</span>
              <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
            </label>
            <label>
              <span>密码</span>
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
            </label>
            {error ? <div className="auth-error">{error}</div> : null}
            <button type="submit" className="primary-btn full" disabled={busy || !username.trim() || !password}>
              <CheckCircle2 size={16} />
              <span>{busy ? "登录中" : "登录"}</span>
            </button>
            <div className="auth-hint">首次安装默认管理员为 admin / admin123，登录后必须修改密码。</div>
          </form>
        ) : (
          <form className="auth-form" onSubmit={submitPasswordChange}>
            <label>
              <span>当前密码</span>
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
            </label>
            <label>
              <span>新密码</span>
              <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" />
            </label>
            {error ? <div className="auth-error">{error}</div> : null}
            <button type="submit" className="primary-btn full" disabled={busy || !password || newPassword.length < 8}>
              <CheckCircle2 size={16} />
              <span>{busy ? "提交中" : "修改密码并进入"}</span>
            </button>
          </form>
        )}
      </section>
    </div>
  );
}

type WorkspacePane = "overview" | "table" | "control" | "history";
type SystemControlAction = "enable" | "disable" | "emergencyStop";
type WorkspaceCommand = "home" | "calibrateSensor" | "bend" | "activeTick";
type MotorCommandDraft = {
  motorId: number;
  positionMm: number;
  velocityMmPerSec: number;
  accelerationMmPerSec2: number;
};
type WorkspaceCommandPayload = {
  sensorId?: number;
  calibrationValue?: number;
  direction1?: number;
  angle1Deg?: number;
  direction2?: number;
  angle2Deg?: number;
};

function WorkspacePage({
  snapshot,
  serialPorts,
  serialPortsError,
  connectedDevices,
  deviceStatuses,
  connectionError,
  onOpenConnectDialog,
  onDisconnectDevice,
  onRefreshSerialPorts,
  onSystemControl,
  onSendMotor,
  onWorkspaceCommand,
}: {
  snapshot: RuntimeSnapshot;
  serialPorts: SerialPortDescriptor[];
  serialPortsError: string | null;
  connectedDevices: DeviceConnectionRecord[];
  deviceStatuses: Record<string, DeviceRuntimeStatusView>;
  connectionError: string | null;
  onOpenConnectDialog: () => void;
  onDisconnectDevice: (deviceId: string) => void;
  onRefreshSerialPorts: () => void;
  onSystemControl: (action: SystemControlAction) => void;
  onSendMotor: (command: MotorCommandDraft) => void;
  onWorkspaceCommand: (command: WorkspaceCommand, payload?: WorkspaceCommandPayload) => void;
}) {
  const [pane, setPane] = useState<WorkspacePane>("overview");
  const [motorDraft, setMotorDraft] = useState<MotorCommandDraft>({
    motorId: 1,
    positionMm: 0,
    velocityMmPerSec: 10,
    accelerationMmPerSec2: 3,
  });
  const [motorInlineTargets, setMotorInlineTargets] = useState<Record<number, number>>({});
  const [sensorDraft, setSensorDraft] = useState({ sensorId: 1, calibrationValue: 0 });
  const [bendDraft, setBendDraft] = useState({
    direction1: 0,
    angle1Deg: snapshot.calibration.targetAngles[0],
    direction2: 0,
    angle2Deg: snapshot.calibration.targetAngles[1],
  });
  const latestFrame = snapshot.live.frames[0];
  const activeSession = snapshot.playback.sessions.find((session) => session.id === snapshot.playback.activeSessionId) ?? snapshot.playback.sessions[0];
  const progress = clamp((snapshot.playback.cursorMs / Math.max(snapshot.playback.durationMs, 1)) * 100, 0, 100);
  const motorRows = snapshot.live.frames.flatMap((frame) =>
    frame.motors.map((motor) => ({
      frame,
      motor,
    })),
  );
  const sensorRows = snapshot.live.frames.flatMap((frame) =>
    frame.sensors.map((sensor) => ({
      frame,
      sensor,
    })),
  );
  const sections = [
    { key: "overview" as const, icon: Activity, title: "监控" },
    { key: "table" as const, icon: Table2, title: "表格" },
    { key: "control" as const, icon: SlidersHorizontal, title: "控制" },
    { key: "history" as const, icon: Play, title: "回放" },
  ];

  return (
    <div className="workspace-page">
      <div className="workspace-tabs" role="tablist" aria-label="workspace sections">
        {sections.map((section) => {
          const Icon = section.icon;
          return (
            <button
              key={section.key}
              type="button"
              className={`workspace-tab ${pane === section.key ? "active" : ""}`}
              onClick={() => setPane(section.key)}
            >
              <Icon size={15} />
              <span>{section.title}</span>
            </button>
          );
        })}
      </div>

      {pane === "overview" ? (
        <div className="page-grid workspace-grid workspace-overview-grid">
          <Panel title="系统操作" subtitle="workspace" icon={Cable} wide>
            <div className="workspace-split">
              <div className="workspace-list">
                <div className="stack-item">
                  <span>连接状态</span>
                  <strong>{snapshot.connection.state}</strong>
                </div>
                <div className="stack-item">
                  <span>当前设备</span>
                  <strong>{snapshot.live.selectedDeviceId}</strong>
                </div>
                <div className="stack-item">
                  <span>采样 / 帧率</span>
                  <strong>
                    {snapshot.dashboard.sampleRateHz} Hz / {snapshot.dashboard.frameRateHz} fps
                  </strong>
                </div>
                <div className="stack-item">
                  <span>握手阶段</span>
                  <strong>{snapshot.connection.handshakeStep}</strong>
                </div>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${snapshot.connection.handshakeProgress}%` }} />
                </div>
              </div>
              <div className="workspace-list">
                <div className="stack-item">
                  <span>真实串口</span>
                  <strong>{serialPorts.length} 个</strong>
                </div>
                <div className="stack-item">
                  <span>扫描状态</span>
                  <strong>{serialPortsError ?? "ready"}</strong>
                </div>
                <div className="button-stack">
                  <button type="button" className="ghost-btn full" onClick={onRefreshSerialPorts}>
                    <RefreshCw size={16} />
                    <span>扫描串口</span>
                  </button>
                  <button type="button" className="ghost-btn full" onClick={onOpenConnectDialog}>
                    <Wifi size={16} />
                    <span>连接新设备</span>
                  </button>
                  <button type="button" className="ghost-btn full" onClick={() => onSystemControl(snapshot.connection.state === "ready" ? "disable" : "enable")}>
                    <CheckCircle2 size={16} />
                    <span>使能 / 失能</span>
                  </button>
                  <button type="button" className="ghost-btn full" onClick={() => onSystemControl("emergencyStop")}>
                    <AlertTriangle size={16} />
                    <span>紧急停止</span>
                  </button>
                </div>
              </div>
            </div>
          </Panel>

          <Panel title="串口发现" subtitle="transport" icon={Cable} wide>
            {connectionError ? (
              <div className="connection-error">
                <AlertTriangle size={14} />
                <span>{connectionError}</span>
              </div>
            ) : null}

            {connectedDevices.length > 0 ? (
              <div className="device-grid" style={{ marginBottom: 10 }}>
                {connectedDevices.map((dev) => (
                  <DeviceCard
                    key={dev.deviceId}
                    device={dev}
                    runtimeStatus={deviceStatuses[dev.deviceId] ?? null}
                    onDisconnect={onDisconnectDevice}
                  />
                ))}
              </div>
            ) : null}

            <button type="button" className="ghost-btn full" onClick={onOpenConnectDialog} style={{ marginBottom: 10 }}>
              <Wifi size={16} />
              <span>连接新设备</span>
            </button>

            <div className="port-list">
              {serialPorts.length === 0 ? (
                <div className="port-card">
                  <div>
                    <strong>未发现真实串口</strong>
                    <span>可继续使用 Simulator；连接硬件后点击刷新串口。</span>
                  </div>
                  <Badge tone="warn">无串口</Badge>
                </div>
              ) : (
                serialPorts.map((port) => (
                  <div className="port-card" key={port.portName}>
                    <div>
                      <strong>{port.portName}</strong>
                      <span>
                        {port.description ?? port.product ?? "Serial port"} · {port.manufacturer ?? port.portType}
                      </span>
                    </div>
                    <div className="port-meta">
                      <Badge tone={port.likelyAvailable ? "ok" : "warn"}>{port.portType.toUpperCase()}</Badge>
                      {port.vid != null && port.pid != null ? (
                        <span>
                          VID {port.vid.toString(16).padStart(4, "0").toUpperCase()} / PID{" "}
                          {port.pid.toString(16).padStart(4, "0").toUpperCase()}
                        </span>
                      ) : (
                        <span>{port.likelyAvailable ? "可用" : "已过滤"}</span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </Panel>
        </div>
      ) : null}

      {pane === "table" ? (
        <div className="page-grid workspace-grid workspace-table-grid">
          <Panel title="电机快照" subtitle="workspace" icon={Table2} wide>
            <div className="data-table scroll">
              <div className="data-row head">
                <span>时间</span>
                <span>帧号</span>
                <span>对象</span>
                <span>位置</span>
                <span>速度</span>
                <span>状态</span>
              </div>
              {motorRows.slice(0, 6).map(({ frame, motor }) => (
                <div className="data-row" key={`${frame.sequence}-${motor.id}`}>
                  <span>{isoShort(frame.receivedAtMs)}</span>
                  <span>#{frame.sequence}</span>
                  <span>电机 {motor.id}</span>
                  <span>{motor.positionMm.toFixed(2)} mm</span>
                  <span>{motor.velocityMmPerSec.toFixed(2)} mm/s</span>
                  <span>
                    <Badge tone={frame.quality.status === "ok" ? "ok" : "warn"}>{frame.quality.status}</Badge>
                  </span>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="传感器快照" subtitle="workspace" icon={Eye} wide>
            <div className="data-table scroll">
              <div className="data-row head">
                <span>时间</span>
                <span>帧号</span>
                <span>对象</span>
                <span>X</span>
                <span>Y</span>
                <span>Z</span>
              </div>
              {sensorRows.slice(0, 6).map(({ frame, sensor }) => (
                <div className="data-row" key={`${frame.sequence}-sensor-${sensor.id}`}>
                  <span>{isoShort(frame.receivedAtMs)}</span>
                  <span>#{frame.sequence}</span>
                  <span>传感器 {sensor.id}</span>
                  <span>{sensor.filtered[0].toFixed(2)}</span>
                  <span>{sensor.filtered[1].toFixed(2)}</span>
                  <span>{sensor.filtered[2].toFixed(2)}</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      ) : null}

      {pane === "control" ? (
        <div className="page-grid workspace-grid workspace-control-grid">
          <Panel title="系统状态" subtitle="工作区" icon={Activity} wide>
            <div className="status-strip">
              <div className="status-strip-item">
                <span className="status-strip-label">连接状态</span>
                <Badge tone={snapshot.connection.state === "ready" ? "ok" : snapshot.connection.state === "error" ? "error" : "warn"}>
                  {snapshot.connection.state === "ready" ? "已连接" : snapshot.connection.state === "idle" ? "空闲" : snapshot.connection.state === "connecting" ? "连接中" : snapshot.connection.state === "error" ? "错误" : snapshot.connection.state}
                </Badge>
              </div>
              <div className="status-strip-item">
                <span className="status-strip-label">使能状态</span>
                <Badge tone={latestFrame.systemEnabled ? "ok" : "warn"}>
                  {latestFrame.systemEnabled ? "已使能" : "已失能"}
                </Badge>
              </div>
              <div className="status-strip-item">
                <span className="status-strip-label">设备</span>
                <strong>{snapshot.live.selectedDeviceId}</strong>
              </div>
              <div className="status-strip-actions">
                <button type="button" className="ghost-btn" onClick={() => onSystemControl("enable")}>
                  <CheckCircle2 size={15} />
                  <span>使能</span>
                </button>
                <button type="button" className="ghost-btn" onClick={() => onSystemControl("disable")}>
                  <PauseCircle size={15} />
                  <span>失能</span>
                </button>
                <button type="button" className="ghost-btn" onClick={() => onSystemControl("emergencyStop")}>
                  <AlertTriangle size={15} />
                  <span>紧急停止</span>
                </button>
              </div>
            </div>
          </Panel>

          <Panel title="电机控制与状态" subtitle="工作区" icon={ArrowRightLeft} wide>
            <div className="motor-inline-bar">
              <label>
                <span>通道</span>
                <input type="number" min={1} max={6} value={motorDraft.motorId}
                  onChange={(event) => setMotorDraft((draft) => ({ ...draft, motorId: Number(event.target.value) }))} />
              </label>
              <label>
                <span>目标 mm</span>
                <input type="number" step={0.1} value={motorDraft.positionMm}
                  onChange={(event) => setMotorDraft((draft) => ({ ...draft, positionMm: Number(event.target.value) }))} />
              </label>
              <label>
                <span>速度</span>
                <input type="number" min={0} step={0.1} value={motorDraft.velocityMmPerSec}
                  onChange={(event) => setMotorDraft((draft) => ({ ...draft, velocityMmPerSec: Number(event.target.value) }))} />
              </label>
              <label>
                <span>加速度</span>
                <input type="number" min={0} step={0.1} value={motorDraft.accelerationMmPerSec2}
                  onChange={(event) => setMotorDraft((draft) => ({ ...draft, accelerationMmPerSec2: Number(event.target.value) }))} />
              </label>
              <button type="button" className="ghost-btn" onClick={() => onSendMotor(motorDraft)}>
                <ArrowRightLeft size={14} />
                <span>发送</span>
              </button>
            </div>
            <div className="motor-control-grid">
              {latestFrame.motors.map((motor) => (
                <article className="motor-control-card" key={motor.id}>
                  <div className="motor-control-head">
                    <strong>电机 {motor.id}</strong>
                    <Badge tone={motor.running ? "ok" : "warn"}>{motor.running ? "运行" : "停止"}</Badge>
                  </div>
                  <div className="motor-control-values">
                    <div>
                      <span>当前位置</span>
                      <strong>{motor.positionMm.toFixed(1)} mm</strong>
                    </div>
                    <div>
                      <span>目标位置</span>
                      <input
                        type="number" step={0.1}
                        className="motor-target-input"
                        value={motorInlineTargets[motor.id] ?? motor.targetPositionMm}
                        onChange={(event) => setMotorInlineTargets((prev) => ({ ...prev, [motor.id]: Number(event.target.value) }))}
                      />
                    </div>
                  </div>
                  <div className="motor-control-actions">
                    <button type="button" className="ghost-btn"
                      onClick={() => onSendMotor({ motorId: motor.id, positionMm: motorInlineTargets[motor.id] ?? motor.targetPositionMm, velocityMmPerSec: Math.max(motor.velocityMmPerSec, 1), accelerationMmPerSec2: Math.max(motor.accelerationMmPerSec2, 1) })}>
                      <ArrowRightLeft size={14} />
                      <span>发送</span>
                    </button>
                    <button type="button" className="ghost-btn" onClick={() => onSystemControl("disable")}>
                      <PauseCircle size={14} />
                      <span>停机</span>
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </Panel>

          <Panel title="传感器校准" subtitle="工作区" icon={CheckCircle2}>
            <div className="command-form">
              <span className="command-form-title">校准参数</span>
              <label>
                <span>传感器</span>
                <input type="number" min={1} max={6} value={sensorDraft.sensorId}
                  onChange={(event) => setSensorDraft((draft) => ({ ...draft, sensorId: Number(event.target.value) }))} />
              </label>
              <label>
                <span>校准值</span>
                <input type="number" step={0.01} value={sensorDraft.calibrationValue}
                  onChange={(event) => setSensorDraft((draft) => ({ ...draft, calibrationValue: Number(event.target.value) }))} />
              </label>
              <button type="button" className="ghost-btn full" onClick={() => onWorkspaceCommand("calibrateSensor", sensorDraft)}>
                <CheckCircle2 size={15} />
                <span>发送校准</span>
              </button>
            </div>
            <div className="workspace-list" style={{ marginTop: 12 }}>
              {snapshot.calibration.steps.map((step: CalibrationStep) => (
                <div className={`step-item ${step.done ? "done" : ""} ${step.active ? "active" : ""}`} key={step.id}>
                  <span className="step-index">{step.id}</span>
                  <div className="step-copy">
                    <strong>{step.label}</strong>
                    <span>{step.done ? "已完成" : step.active ? "进行中" : "待处理"}</span>
                  </div>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="弯曲与主动控制" subtitle="工作区" icon={ArrowRightLeft}>
            <div className="command-form">
              <span className="command-form-title">弯曲命令</span>
              <label>
                <span>方向1</span>
                <select value={bendDraft.direction1}
                  onChange={(event) => setBendDraft((draft) => ({ ...draft, direction1: Number(event.target.value) }))}>
                  <option value={0}>上</option>
                  <option value={1}>下</option>
                  <option value={2}>左</option>
                  <option value={3}>右</option>
                </select>
              </label>
              <label>
                <span>角度1</span>
                <input type="number" min={0} max={90} step={0.1} value={bendDraft.angle1Deg}
                  onChange={(event) => setBendDraft((draft) => ({ ...draft, angle1Deg: Number(event.target.value) }))} />
              </label>
              <label>
                <span>方向2</span>
                <select value={bendDraft.direction2}
                  onChange={(event) => setBendDraft((draft) => ({ ...draft, direction2: Number(event.target.value) }))}>
                  <option value={0}>上</option>
                  <option value={1}>下</option>
                  <option value={2}>左</option>
                  <option value={3}>右</option>
                </select>
              </label>
              <label>
                <span>角度2</span>
                <input type="number" min={0} max={90} step={0.1} value={bendDraft.angle2Deg}
                  onChange={(event) => setBendDraft((draft) => ({ ...draft, angle2Deg: Number(event.target.value) }))} />
              </label>
              <button type="button" className="ghost-btn full" onClick={() => onWorkspaceCommand("bend", bendDraft)}>
                <ArrowRightLeft size={15} />
                <span>发送弯曲</span>
              </button>
            </div>
            <div className="button-stack" style={{ marginTop: 12 }}>
              <button type="button" className="ghost-btn full" onClick={() => onWorkspaceCommand("home")}>
                <ArrowRightLeft size={16} />
                <span>一键归中</span>
              </button>
              <button type="button" className="ghost-btn full" onClick={() => onWorkspaceCommand("activeTick")}>
                <Activity size={16} />
                <span>主动控制</span>
              </button>
            </div>
          </Panel>
        </div>
      ) : null}

      {pane === "history" ? (
        <div className="page-grid workspace-grid">
          <Panel title="会话与回放" subtitle="workspace" icon={Play} wide>
            <div className="timeline">
              <div className="timeline-bar">
                <div className="timeline-fill" style={{ width: `${progress}%` }} />
              </div>
              <div className="timeline-meta">
                <span>{isoFull(snapshot.playback.cursorMs)}</span>
                <span>{snapshot.playback.speed.toFixed(1)}x</span>
                <span>{snapshot.playback.durationMs / 1000}s</span>
              </div>
            </div>
            <div className="mini-info">
              当前会话：<strong>{activeSession?.name}</strong>
            </div>
          </Panel>

          <Panel title="会话列表" subtitle="workspace" icon={Database}>
            <div className="stack-list">
              {snapshot.playback.sessions.map((session) => (
                <div className="stack-item" key={session.id}>
                  <span>{session.name}</span>
                  <strong>{session.recordCount.toLocaleString()} 条记录</strong>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="最近日志" subtitle="workspace" icon={Logs} wide>
            <div className="log-list compact">
              {snapshot.logs.slice(0, 4).map((entry) => (
                <div className="log-row" key={entry.id}>
                  <Badge tone={toneForLevel(entry.level)}>{entry.level.toUpperCase()}</Badge>
                  <span className="log-scope">{entry.scope}</span>
                  <span className="log-message">{entry.message}</span>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      ) : null}
    </div>
  );
}

function AppShell() {
  const location = useLocation();
  const currentPage = routeToPage(location.pathname);
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>(makeFallbackSnapshot);
  const [serialPorts, setSerialPorts] = useState<SerialPortDescriptor[]>([]);
  const [serialPortsError, setSerialPortsError] = useState<string | null>(null);
  const [connectedDevices, setConnectedDevices] = useState<DeviceConnectionRecord[]>([]);
  const [deviceStatuses, setDeviceStatuses] = useState<Record<string, DeviceRuntimeStatusView>>({});
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionProfiles, setConnectionProfiles] = useState<ConnectionProfile[]>([]);
  const [recorderStatus, setRecorderStatus] = useState<RecorderStatus>({ active: false, sessionId: "", sessionName: "", frameCount: 0, elapsedSecs: 0, paused: false });
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [playbackStatus, setPlaybackStatus] = useState<PlaybackStatus | null>(null);
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [diagnosticsPath, setDiagnosticsPath] = useState("");
  const [migrationSource, setMigrationSource] = useState("");
  const [migrationPreview, setMigrationPreview] = useState<LegacyMigrationPreview | null>(null);
  const [migrationReport, setMigrationReport] = useState<LegacyMigrationReport | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const fetchSnapshot = useCallback(async (mode: "bootstrap_state" | "tick_snapshot" = "bootstrap_state") => {
    try {
      const next = await invoke<RuntimeSnapshot>(mode);
      setSnapshot(next);
    } catch (invokeError) {
      console.error(invokeError);
    }
  }, []);

  useEffect(() => {
    void fetchSnapshot("bootstrap_state");
  }, [fetchSnapshot]);

  const refreshSerialPorts = useCallback(async () => {
    try {
      const ports = await invoke<SerialPortDescriptor[]>("list_serial_ports");
      setSerialPorts(ports);
      setSerialPortsError(null);
    } catch (invokeError) {
      setSerialPorts([]);
      setSerialPortsError(invokeError instanceof Error ? invokeError.message : "Unable to scan serial ports");
    }
  }, []);

  useEffect(() => {
    void refreshSerialPorts();
  }, [refreshSerialPorts]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void fetchSnapshot("tick_snapshot");
    }, 1000);
    return () => window.clearInterval(timer);
  }, [fetchSnapshot]);

  // Poll connected devices list
  const refreshConnectedDevices = useCallback(async () => {
    try {
      const devices = await invoke<DeviceConnectionRecord[]>("list_connected_devices");
      setConnectedDevices(devices);

      // Fetch runtime status for each device (skip simulator)
      const statuses: Record<string, DeviceRuntimeStatusView> = {};
      for (const d of devices) {
        if (d.deviceId.startsWith("serial:")) {
          try {
            const s = await invoke<DeviceRuntimeStatusView>("device_runtime_status", { deviceId: d.deviceId });
            statuses[d.deviceId] = s;
          } catch { /* ignore */ }
        }
      }
      setDeviceStatuses(statuses);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const interval = setInterval(() => { void refreshConnectedDevices(); }, 1000);
    return () => clearInterval(interval);
  }, [refreshConnectedDevices]);

  // Load connection profiles
  const refreshConnectionProfiles = useCallback(async () => {
    try {
      const profiles = await invoke<ConnectionProfile[]>("list_connection_profiles");
      setConnectionProfiles(profiles);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void refreshConnectionProfiles();
  }, [refreshConnectionProfiles]);

  const refreshUsers = useCallback(async () => {
    try {
      const list = await invoke<UserAccount[]>("list_users");
      setUsers(list);
    } catch {
      setUsers([]);
    }
  }, []);

  useEffect(() => {
    void refreshUsers();
  }, [refreshUsers, snapshot.authSession.username, snapshot.authSession.role]);

  const applyAuthSession = useCallback((session: AuthSession) => {
    setSnapshot((prev) => ({ ...prev, authSession: session }));
  }, []);

  const loginUser = useCallback(async (username: string, password: string) => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const session = await invoke<AuthSession>("login", {
        request: { username: username.trim(), password },
      });
      localStorage.setItem("softui:lastUsername", username.trim());
      applyAuthSession(session);
      if (!session.mustChangePassword) {
        await fetchSnapshot("tick_snapshot");
        await refreshUsers();
      }
    } catch (invokeError) {
      setAuthError(invokeError instanceof Error ? invokeError.message : String(invokeError));
    } finally {
      setAuthBusy(false);
    }
  }, [applyAuthSession, fetchSnapshot, refreshUsers]);

  const changeOwnPasswordAfterLogin = useCallback(async (oldPassword: string, newPassword: string) => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      await invoke("change_password", {
        request: { username: null, oldPassword, newPassword },
      });
      const session = await invoke<AuthSession>("current_auth_session");
      applyAuthSession(session);
      await fetchSnapshot("tick_snapshot");
      await refreshUsers();
    } catch (invokeError) {
      setAuthError(invokeError instanceof Error ? invokeError.message : String(invokeError));
    } finally {
      setAuthBusy(false);
    }
  }, [applyAuthSession, fetchSnapshot, refreshUsers]);

  const logoutUser = useCallback(async () => {
    try {
      const session = await invoke<AuthSession>("logout");
      applyAuthSession(session);
      setUsers([]);
    } catch (invokeError) {
      console.error(invokeError);
    }
  }, [applyAuthSession]);

  const createUserAccount = useCallback(async (username: string, password: string, role: Role) => {
    await invoke<UserAccount>("create_user", {
      request: { username: username.trim(), password, role },
    });
    await refreshUsers();
  }, [refreshUsers]);

  const resetUserPassword = useCallback(async (username: string, newPassword: string) => {
    await invoke("change_password", {
      request: { username, oldPassword: null, newPassword },
    });
    await refreshUsers();
  }, [refreshUsers]);

  const setUserDisabled = useCallback(async (username: string, disabled: boolean) => {
    await invoke<UserAccount>("set_user_disabled", { username, disabled });
    await refreshUsers();
  }, [refreshUsers]);

  const handleConnectDevice = useCallback(async (request: ConnectDeviceRequest) => {
    await invoke("connect_device", { request });
    setConnectionError(null);
    await refreshConnectedDevices();
  }, [refreshConnectedDevices]);

  const handleDisconnectDevice = useCallback(async (deviceId: string) => {
    try {
      await invoke("disconnect_device", { deviceId });
      await refreshConnectedDevices();
    } catch (e) {
      console.error(e);
    }
  }, [refreshConnectedDevices]);

  const handleSaveProfile = useCallback(async (profile: ConnectionProfile) => {
    await invoke("save_connection_profile", { profile });
    await refreshConnectionProfiles();
  }, [refreshConnectionProfiles]);

  const handleDeleteProfile = useCallback(async (id: string) => {
    await invoke("delete_connection_profile", { id });
    await refreshConnectionProfiles();
  }, [refreshConnectionProfiles]);

  const toggleTheme = useCallback(async () => {
    const nextTheme: ThemeMode = snapshot.theme === "dark" ? "light" : "dark";
    try {
      const next = await invoke<RuntimeSnapshot>("set_theme", { theme: nextTheme });
      setSnapshot((prev) => ({
        ...next,
        authSession: next.authSession.authenticated ? next.authSession : prev.authSession,
      }));
    } catch {
      setSnapshot((prev) => ({
        ...prev,
        theme: nextTheme,
        settings: { ...prev.settings, theme: nextTheme },
      }));
    }
  }, [snapshot.theme]);

  const exportDiagnostics = useCallback(async () => {
    try {
      const path = await invoke<string>("export_diagnostics_bundle");
      setDiagnosticsPath(path);
    } catch (invokeError) {
      setDiagnosticsPath(invokeError instanceof Error ? invokeError.message : String(invokeError));
    }
  }, []);

  const previewMigration = useCallback(async () => {
    if (!migrationSource.trim()) return;
    try {
      const preview = await invoke<LegacyMigrationPreview>("preview_legacy_migration", {
        sourceDir: migrationSource.trim(),
        targetDir: null,
      });
      setMigrationPreview(preview);
      setMigrationReport(null);
    } catch (invokeError) {
      setMigrationPreview({
        sourceDir: migrationSource.trim(),
        targetDir: "",
        exists: false,
        userFiles: 0,
        configFiles: 0,
        csvFiles: 0,
        logFiles: 0,
        skippedFiles: 0,
        warnings: [invokeError instanceof Error ? invokeError.message : String(invokeError)],
      });
    }
  }, [migrationSource]);

  const runMigration = useCallback(async () => {
    if (!migrationSource.trim()) return;
    try {
      const report = await invoke<LegacyMigrationReport>("run_legacy_migration", {
        sourceDir: migrationSource.trim(),
        targetDir: null,
      });
      setMigrationReport(report);
      setMigrationPreview(report.preview);
      await fetchSnapshot("tick_snapshot");
    } catch (invokeError) {
      setMigrationReport(null);
      setMigrationPreview({
        sourceDir: migrationSource.trim(),
        targetDir: "",
        exists: false,
        userFiles: 0,
        configFiles: 0,
        csvFiles: 0,
        logFiles: 0,
        skippedFiles: 0,
        warnings: [invokeError instanceof Error ? invokeError.message : String(invokeError)],
      });
    }
  }, [fetchSnapshot, migrationSource]);

  const toggleRecording = useCallback(async () => {
    if (recorderStatus.active) {
      await invoke<SessionInfo>("stop_recording");
    } else {
      await invoke<SessionInfo>("start_recording");
    }
    const status = await invoke<RecorderStatus>("recorder_status");
    setRecorderStatus(status);
    const list = await invoke<SessionInfo[]>("list_sessions");
    setSessions(list);
  }, [recorderStatus.active]);

  const pauseRecording = useCallback(async () => {
    try {
      await invoke("pause_recording");
      const status = await invoke<RecorderStatus>("recorder_status");
      setRecorderStatus(status);
    } catch { /* ignore */ }
  }, []);

  const resumeRecording = useCallback(async () => {
    try {
      await invoke("resume_recording");
      const status = await invoke<RecorderStatus>("recorder_status");
      setRecorderStatus(status);
    } catch { /* ignore */ }
  }, []);

  const deleteSession = useCallback(async (id: string) => {
    try {
      await invoke("delete_session", { id });
      const list = await invoke<SessionInfo[]>("list_sessions");
      setSessions(list);
    } catch { /* ignore */ }
  }, []);

  const renameSession = useCallback(async (id: string, name: string) => {
    try {
      await invoke("rename_session", { id, name });
      const list = await invoke<SessionInfo[]>("list_sessions");
      setSessions(list);
    } catch { /* ignore */ }
  }, []);

  const exportCsv = useCallback(async (id: string) => {
    try {
      const path = await invoke<string>("export_session_csv", { id, outputPath: null });
      console.log("CSV exported to:", path);
    } catch (e) { console.error(e); }
  }, []);

  const loadPlayback = useCallback(async (id: string) => {
    try {
      const status = await invoke<PlaybackStatus>("playback_load", { sessionId: id });
      setPlaybackStatus(status);
    } catch (e) { console.error(e); }
  }, []);

  const playbackPlayPause = useCallback(async () => {
    if (!playbackStatus) return;
    try {
      const status = playbackStatus.playing
        ? await invoke<PlaybackStatus>("playback_pause")
        : await invoke<PlaybackStatus>("playback_play");
      setPlaybackStatus(status);
    } catch (e) { console.error(e); }
  }, [playbackStatus]);

  const playbackStop = useCallback(async () => {
    try {
      await invoke<PlaybackStatus>("playback_stop");
      setPlaybackStatus(null);
    } catch (e) { console.error(e); }
  }, []);

  const playbackSeek = useCallback(async (ms: number) => {
    try {
      const status = await invoke<PlaybackStatus>("playback_seek", { ms });
      setPlaybackStatus(status);
    } catch (e) { console.error(e); }
  }, []);

  const playbackSetSpeed = useCallback(async (speed: number) => {
    try {
      const status = await invoke<PlaybackStatus>("playback_set_speed", { speed });
      setPlaybackStatus(status);
    } catch (e) { console.error(e); }
  }, []);

  // Poll recorder status and sessions list every 2 seconds
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const status = await invoke<RecorderStatus>("recorder_status");
        setRecorderStatus(status);
        const list = await invoke<SessionInfo[]>("list_sessions");
        setSessions(list);
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  // Poll playback status at 100ms when playback is active
  useEffect(() => {
    if (!playbackStatus?.active) return;
    const interval = setInterval(async () => {
      try {
        const status = await invoke<PlaybackStatus>("playback_status");
        setPlaybackStatus(status);
        if (!status.active) {
          setPlaybackStatus(null);
        }
      } catch {
        setPlaybackStatus(null);
      }
    }, 100);
    return () => clearInterval(interval);
  }, [playbackStatus?.active]);

  const toggleConnection = useCallback(async () => {
    // Open the connect dialog instead of the old toggle behavior
    setConnectionError(null);
    setConnectDialogOpen(true);
  }, []);

  const submitSystemControl = useCallback(async (action: SystemControlAction) => {
    try {
      const next = await invoke<RuntimeSnapshot>("submit_system_control", {
        request: {
          deviceId: snapshot.live.selectedDeviceId,
          action,
        },
      });
      setSnapshot(next);
    } catch (invokeError) {
      console.error(invokeError);
    }
  }, [snapshot.live.selectedDeviceId]);

  const sendMotorCommand = useCallback(async (command: MotorCommandDraft) => {
    try {
      const next = await invoke<RuntimeSnapshot>("send_motor_command", {
        request: {
          deviceId: snapshot.live.selectedDeviceId,
          motorId: command.motorId,
          positionMm: command.positionMm,
          velocityMmPerSec: Math.max(command.velocityMmPerSec, 1),
          accelerationMmPerSec2: Math.max(command.accelerationMmPerSec2, 1),
        },
      });
      setSnapshot(next);
    } catch (invokeError) {
      console.error(invokeError);
    }
  }, [snapshot.live.selectedDeviceId]);

  const submitWorkspaceCommand = useCallback(async (command: WorkspaceCommand, payload: WorkspaceCommandPayload = {}) => {
    const deviceId = snapshot.live.selectedDeviceId;
    const targetAngles = snapshot.calibration.targetAngles;
    const commandMap: Record<WorkspaceCommand, { name: string; request: Record<string, unknown> }> = {
      home: {
        name: "send_home_command",
        request: { deviceId, motorCount: 6, startAddress: 1 },
      },
      calibrateSensor: {
        name: "calibrate_sensor",
        request: {
          deviceId,
          sensorId: payload.sensorId ?? 1,
          calibrationValue: payload.calibrationValue ?? 0,
        },
      },
      bend: {
        name: "send_bend_command",
        request: {
          deviceId,
          direction1: payload.direction1 ?? 0,
          angle1Deg: payload.angle1Deg ?? targetAngles[0],
          direction2: payload.direction2 ?? 0,
          angle2Deg: payload.angle2Deg ?? targetAngles[1],
        },
      },
      activeTick: {
        name: "send_active_control_tick",
        request: { deviceId },
      },
    };
    const selected = commandMap[command];

    try {
      const next = await invoke<RuntimeSnapshot>(selected.name, { request: selected.request });
      setSnapshot(next);
    } catch (invokeError) {
      console.error(invokeError);
    }
  }, [snapshot.calibration.targetAngles, snapshot.live.selectedDeviceId]);

  const statusTone = snapshot.connection.state === "ready" ? "ok" : snapshot.connection.state === "error" ? "error" : "warn";
  if (!snapshot.authSession.authenticated || snapshot.authSession.mustChangePassword) {
    return (
      <LoginPage
        theme={snapshot.theme}
        error={authError}
        busy={authBusy}
        mustChangePassword={snapshot.authSession.authenticated && snapshot.authSession.mustChangePassword}
        onLogin={loginUser}
        onChangePassword={changeOwnPasswordAfterLogin}
      />
    );
  }

  return (
    <div className={`shell theme-${snapshot.theme} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Fingerprint size={18} />
          </div>
          <div className="brand-copy">
            <div className="brand-title">SoftUI</div>
            <div className="brand-subtitle">桌面控制台</div>
          </div>
          <button
            type="button"
            className="sidebar-toggle"
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
            title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
            aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
          >
            <ChevronRight size={16} />
          </button>
        </div>

        <nav className="nav">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink key={item.path} to={item.path} title={item.title} className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
                <span className="nav-icon">
                  <Icon size={16} />
                </span>
                <span className="nav-text">
                  <span className="nav-title">{item.title}</span>
                  <span className="nav-subtitle">{item.subtitle}</span>
                </span>
                <ChevronRight size={14} />
              </NavLink>
            );
          })}
        </nav>

        <section className="sidebar-card">
          <div className="section-label">运行状态</div>
          <div className="side-stat">
            <Badge tone={statusTone}>{snapshot.connection.state}</Badge>
            <span>{snapshot.connection.activeProfileName}</span>
          </div>
          <div className="side-stat">
            <Activity size={16} />
            <span>采样 {snapshot.dashboard.sampleRateHz} Hz</span>
          </div>
          <div className="side-stat">
            <SquareTerminal size={16} />
            <span>{snapshot.appInfo.backend}</span>
          </div>
        </section>
      </aside>

      <main className={`workspace ${currentPage === "Dashboard" ? "with-summary" : "without-summary"}`}>
        <header className="topbar">
          <div className="headline">
            <div className="section-label">SoftUI</div>
            <h1>{pageTitles[currentPage]}</h1>
            <p>{pageDescriptions[currentPage]}</p>
          </div>

          <div className="actions">
            <button type="button" className="ghost-btn" onClick={toggleTheme}>
              {snapshot.theme === "dark" ? <SunMedium size={16} /> : <MoonStar size={16} />}
              <span>{snapshot.theme === "dark" ? "浅色" : "深色"}</span>
            </button>
            <button type="button" className="ghost-btn" onClick={() => void fetchSnapshot("tick_snapshot")}>
              <RefreshCw size={16} />
              <span>刷新</span>
            </button>
            <button type="button" className={`primary-btn ${snapshot.connection.state === "ready" ? "is-live" : "is-idle"}`} onClick={toggleConnection}>
              <Wifi size={16} />
              <span>{snapshot.connection.state === "ready" ? "断开" : "连接"}</span>
            </button>
            <button type="button" className="ghost-btn">
              <Save size={16} />
              <span>保存布局</span>
            </button>
            <button type="button" className={`primary-btn ${recorderStatus.active ? "is-recording" : "is-idle"}`} onClick={toggleRecording}>
              <Activity size={16} />
              <span>{recorderStatus.active ? `⏹ ${recorderStatus.frameCount}帧 ${recorderStatus.elapsedSecs}s` : "录制"}</span>
            </button>
            <button type="button" className="ghost-btn" onClick={logoutUser}>
              <Fingerprint size={16} />
              <span>退出 {snapshot.authSession.username}</span>
            </button>
          </div>
        </header>

        {currentPage === "Dashboard" ? (
          <section className="summary-grid">
            <StatCard label="设备" value={`${snapshot.dashboard.deviceCount}`} hint={`${snapshot.dashboard.connectedDevices} 台在线`} tone="blue" />
            <StatCard label="会话" value={snapshot.dashboard.currentSession} hint="当前会话" tone="green" />
            <StatCard label="采样" value={`${snapshot.dashboard.sampleRateHz} Hz`} hint={`帧率 ${snapshot.dashboard.frameRateHz} fps`} tone="amber" />
            <StatCard label="最新错误" value={snapshot.dashboard.lastError ?? "无"} hint={snapshot.connection.lastMessage} tone="neutral" />
          </section>
        ) : null}

        {playbackStatus?.active ? (
          <PlaybackBar
            status={playbackStatus}
            onPlayPause={playbackPlayPause}
            onStop={playbackStop}
            onSeek={playbackSeek}
            onStepForward={() => {}}
            onStepBackward={() => {}}
            onSetSpeed={playbackSetSpeed}
          />
        ) : null}

        <div className="page-body">
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<DashboardPage snapshot={snapshot} />} />
            <Route
              path="/workspace"
              element={
                <WorkspacePage
                  snapshot={snapshot}
                  serialPorts={serialPorts}
                  serialPortsError={serialPortsError}
                  connectedDevices={connectedDevices}
                  deviceStatuses={deviceStatuses}
                  connectionError={connectionError}
                  onOpenConnectDialog={() => { setConnectionError(null); setConnectDialogOpen(true); }}
                  onDisconnectDevice={handleDisconnectDevice}
                  onRefreshSerialPorts={refreshSerialPorts}
                  onSystemControl={submitSystemControl}
                  onSendMotor={sendMotorCommand}
                  onWorkspaceCommand={submitWorkspaceCommand}
                />
              }
            />
            <Route path="/connection" element={<Navigate to="/workspace" replace />} />
            <Route path="/live-table" element={<Navigate to="/workspace" replace />} />
            <Route path="/charts" element={<ChartsPage snapshot={snapshot} />} />
            <Route path="/sessions" element={
              <SessionsPage
                sessions={sessions}
                recorderStatus={recorderStatus}
                onToggleRecording={toggleRecording}
                onPauseRecording={pauseRecording}
                onResumeRecording={resumeRecording}
                onDeleteSession={deleteSession}
                onRenameSession={renameSession}
                onExportCsv={exportCsv}
                onLoadPlayback={loadPlayback}
              />
            } />
            <Route path="/model" element={<Navigate to="/workspace" replace />} />
            <Route path="/calibration" element={<Navigate to="/workspace" replace />} />
            <Route path="/playback" element={<Navigate to="/workspace" replace />} />
            <Route path="/logs" element={<LogsPage snapshot={snapshot} />} />
            <Route
              path="/settings"
              element={
                <SettingsPage
                  snapshot={snapshot}
                  users={users}
                  diagnosticsPath={diagnosticsPath}
                  migrationSource={migrationSource}
                  migrationPreview={migrationPreview}
                  migrationReport={migrationReport}
                  onToggleTheme={toggleTheme}
                  onExportDiagnostics={exportDiagnostics}
                  onMigrationSourceChange={setMigrationSource}
                  onPreviewMigration={previewMigration}
                  onRunMigration={runMigration}
                  onCreateUser={createUserAccount}
                  onResetUserPassword={resetUserPassword}
                  onSetUserDisabled={setUserDisabled}
                />
              }
            />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>

          {/* Connect Dialog */}
          <ConnectDialog
            open={connectDialogOpen}
            ports={serialPorts}
            profiles={connectionProfiles}
            onConnect={handleConnectDevice}
            onSaveProfile={handleSaveProfile}
            onDeleteProfile={handleDeleteProfile}
            onRefreshPorts={refreshSerialPorts}
            onClose={() => setConnectDialogOpen(false)}
          />
        </div>

      </main>
    </div>
  );
}

function DashboardPage({ snapshot }: { snapshot: RuntimeSnapshot }) {
  const latestFrame = snapshot.live.frames[0];
  return (
    <div className="page-grid dashboard-grid">
      <Panel title="设备工作台" subtitle="dashboard" icon={Database} wide>
        <div className="data-table">
          <div className="data-row head">
            <span>设备</span>
            <span>状态</span>
            <span>帧号</span>
            <span>延迟</span>
          </div>
          <div className="data-row">
            <span>{latestFrame.deviceId}</span>
            <span><Badge tone={latestFrame.systemEnabled ? "ok" : "warn"}>{latestFrame.systemEnabled ? "已使能" : "空闲"}</Badge></span>
            <span>#{latestFrame.sequence}</span>
            <span>{latestFrame.quality.latencyMs} ms</span>
          </div>
        </div>

        <div className="mini-grid">
          {latestFrame.motors.map((motor) => (
            <article className="mini-card" key={motor.id}>
              <div className="mini-title">电机 {motor.id}</div>
              <div className="mini-value">{motor.positionMm.toFixed(1)} mm</div>
              <div className="mini-sub">{motor.velocityMmPerSec.toFixed(1)} mm/s</div>
            </article>
          ))}
        </div>
      </Panel>

      <Panel title="会话概览" subtitle="dashboard" icon={ListChecks}>
        <div className="stack-list">
          <div className="stack-item">
            <span>会话</span>
            <strong>{snapshot.dashboard.currentSession}</strong>
          </div>
          <div className="stack-item">
            <span>配置</span>
            <strong>{snapshot.connection.activeProfileName}</strong>
          </div>
          <div className="stack-item">
            <span>模型</span>
            <strong>{snapshot.model.name}</strong>
          </div>
        </div>
      </Panel>

      <Panel title="最近事件" subtitle="dashboard" icon={Logs}>
        <div className="log-list compact">
          {snapshot.logs.slice(0, 4).map((entry) => (
            <div className="log-row" key={entry.id}>
              <Badge tone={toneForLevel(entry.level)}>{entry.level.toUpperCase()}</Badge>
              <span className="log-scope">{entry.scope}</span>
              <span className="log-message">{entry.message}</span>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="连接健康" subtitle="dashboard" icon={Wifi} wide>
        <div className="health-strip">
          <div>
            <div className="section-label">连接状态</div>
            <div className="health-value">{snapshot.connection.state}</div>
          </div>
          <div>
            <div className="section-label">握手进度</div>
            <div className="health-value">{snapshot.connection.handshakeProgress}%</div>
          </div>
          <div>
            <div className="section-label">帧质量</div>
            <div className="health-value">{latestFrame.quality.status}</div>
          </div>
          <div>
            <div className="section-label">Live buffer</div>
            <div className="health-value">{snapshot.runtimeDiagnostics.storedFrames}/{snapshot.runtimeDiagnostics.liveCapacity}</div>
          </div>
          <div>
            <div className="section-label">Pending queue</div>
            <div className="health-value">{snapshot.runtimeDiagnostics.pendingCommands}</div>
          </div>
          <div>
            <div className="section-label">Protocol errors</div>
            <div className="health-value">{snapshot.runtimeDiagnostics.protocolErrors}</div>
          </div>
          <div>
            <div className="section-label">E-stop latch</div>
            <div className="health-value">{snapshot.runtimeDiagnostics.emergencyLatched ? "yes" : "no"}</div>
          </div>
          <div>
            <div className="section-label">Control</div>
            <div className="health-value">{snapshot.controlRuntime.active ? snapshot.controlRuntime.phase : "inactive"}</div>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function LogsPage({ snapshot }: { snapshot: RuntimeSnapshot }) {
  return (
    <Panel title="日志" subtitle="诊断" icon={Logs} wide>
      <div className="log-list">
        {snapshot.logs.map((entry) => (
          <div className="log-row" key={entry.id}>
            <Badge tone={toneForLevel(entry.level)}>{entry.level.toUpperCase()}</Badge>
            <span className="log-time">{isoShort(entry.timestampMs)}</span>
            <span className="log-scope">{entry.scope}</span>
            <span className="log-message">{entry.message}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function SettingsPage({
  snapshot,
  users,
  diagnosticsPath,
  migrationSource,
  migrationPreview,
  migrationReport,
  onToggleTheme,
  onExportDiagnostics,
  onMigrationSourceChange,
  onPreviewMigration,
  onRunMigration,
  onCreateUser,
  onResetUserPassword,
  onSetUserDisabled,
}: {
  snapshot: RuntimeSnapshot;
  users: UserAccount[];
  diagnosticsPath: string;
  migrationSource: string;
  migrationPreview: LegacyMigrationPreview | null;
  migrationReport: LegacyMigrationReport | null;
  onToggleTheme: () => void;
  onExportDiagnostics: () => void;
  onMigrationSourceChange: (value: string) => void;
  onPreviewMigration: () => void;
  onRunMigration: () => void;
  onCreateUser: (username: string, password: string, role: Role) => Promise<void>;
  onResetUserPassword: (username: string, newPassword: string) => Promise<void>;
  onSetUserDisabled: (username: string, disabled: boolean) => Promise<void>;
}) {
  const migrationTotal = migrationPreview
    ? migrationPreview.userFiles + migrationPreview.configFiles + migrationPreview.csvFiles + migrationPreview.logFiles
    : 0;
  const canManageUsers = snapshot.authSession.permissions.includes("manageUsers");
  const [newUsername, setNewUsername] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserRole, setNewUserRole] = useState<Role>("operator");
  const [resetUsername, setResetUsername] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [accountMessage, setAccountMessage] = useState("");

  const runAccountAction = async (action: () => Promise<void>, successMessage: string) => {
    setAccountMessage("");
    try {
      await action();
      setAccountMessage(successMessage);
    } catch (invokeError) {
      setAccountMessage(invokeError instanceof Error ? invokeError.message : String(invokeError));
    }
  };

  const submitCreateUser = async (event: FormEvent) => {
    event.preventDefault();
    await runAccountAction(async () => {
      await onCreateUser(newUsername, newUserPassword, newUserRole);
      setNewUsername("");
      setNewUserPassword("");
      setNewUserRole("operator");
    }, "用户已创建");
  };

  const submitResetPassword = async (event: FormEvent) => {
    event.preventDefault();
    await runAccountAction(async () => {
      await onResetUserPassword(resetUsername, resetPassword);
      setResetPassword("");
    }, "密码已重置");
  };

  return (
    <div className="page-grid settings-grid">
      <Panel title="应用配置" subtitle="settings" icon={Settings2} wide>
        <div className="settings-stack">
          <div className="stack-item">
            <span>主题</span>
            <strong>{snapshot.settings.theme}</strong>
          </div>
          <div className="stack-item">
            <span>界面密度</span>
            <strong>{snapshot.settings.workspaceDensity}</strong>
          </div>
          <div className="stack-item">
            <span>数据目录</span>
            <strong>{snapshot.settings.dataDirectory}</strong>
          </div>
          <div className="stack-item">
            <span>模型目录</span>
            <strong>{snapshot.settings.modelDirectory}</strong>
          </div>
          <div className="stack-item">
            <span>自动重连</span>
            <strong>{snapshot.settings.autoReconnect ? "启用" : "关闭"}</strong>
          </div>
          <div className="stack-item">
            <span>诊断级别</span>
            <strong>{snapshot.settings.diagnosticsLevel}</strong>
          </div>
        </div>
      </Panel>

      <Panel title="账户与权限" subtitle="auth" icon={Fingerprint}>
        <div className="settings-stack">
          <div className="stack-item">
            <span>当前用户</span>
            <strong>{snapshot.authSession.authenticated ? snapshot.authSession.username : "未登录"}</strong>
          </div>
          <div className="stack-item">
            <span>角色</span>
            <strong>{snapshot.authSession.role}</strong>
          </div>
          <div className="stack-item">
            <span>用户数量</span>
            <strong>{users.length || "无权限查看"}</strong>
          </div>
          {canManageUsers ? (
            <>
              <div className="settings-user-list">
                {users.map((user) => (
                  <div className="settings-user-row" key={user.username}>
                    <div className="settings-user-main">
                      <strong>{user.username}</strong>
                      <span>{user.role}{user.mustChangePassword ? " / 需改密" : ""}</span>
                    </div>
                    <Badge tone={user.disabled ? "error" : "ok"}>{user.disabled ? "停用" : "启用"}</Badge>
                    <button
                      type="button"
                      className="ghost-btn"
                      onClick={() => void runAccountAction(
                        () => onSetUserDisabled(user.username, !user.disabled),
                        user.disabled ? "用户已启用" : "用户已停用",
                      )}
                      disabled={user.username === snapshot.authSession.username}
                    >
                      <span>{user.disabled ? "启用" : "停用"}</span>
                    </button>
                  </div>
                ))}
              </div>

              <form className="account-form" onSubmit={submitCreateUser}>
                <label>
                  <span>新用户</span>
                  <input value={newUsername} onChange={(event) => setNewUsername(event.target.value)} placeholder="operator_1" />
                </label>
                <label>
                  <span>初始密码</span>
                  <input type="password" value={newUserPassword} onChange={(event) => setNewUserPassword(event.target.value)} />
                </label>
                <label>
                  <span>角色</span>
                  <select value={newUserRole} onChange={(event) => setNewUserRole(event.target.value as Role)}>
                    <option value="operator">operator</option>
                    <option value="maintainer">maintainer</option>
                    <option value="admin">admin</option>
                  </select>
                </label>
                <button type="submit" className="primary-btn full" disabled={!newUsername.trim() || newUserPassword.length < 8}>
                  <CheckCircle2 size={16} />
                  <span>创建用户</span>
                </button>
              </form>

              <form className="account-form" onSubmit={submitResetPassword}>
                <label>
                  <span>重置用户</span>
                  <select value={resetUsername} onChange={(event) => setResetUsername(event.target.value)}>
                    <option value="">选择用户</option>
                    {users.map((user) => (
                      <option value={user.username} key={user.username}>{user.username}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>新密码</span>
                  <input type="password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} />
                </label>
                <button type="submit" className="ghost-btn full" disabled={!resetUsername || resetPassword.length < 8}>
                  <Save size={16} />
                  <span>重置密码</span>
                </button>
              </form>
            </>
          ) : (
            <div className="settings-result">当前角色没有用户管理权限。</div>
          )}
          {accountMessage ? <div className="settings-result">{accountMessage}</div> : null}
        </div>
      </Panel>

      <Panel title="诊断导出" subtitle="diagnostics" icon={PauseCircle}>
        <div className="button-stack">
          <button type="button" className="ghost-btn full" onClick={onToggleTheme}>
            <SunMedium size={16} />
            <span>切换主题</span>
          </button>
          <button type="button" className="ghost-btn full" onClick={onExportDiagnostics}>
            <Cpu size={16} />
            <span>导出诊断包</span>
          </button>
        </div>
        {diagnosticsPath ? <div className="settings-result">{diagnosticsPath}</div> : null}
      </Panel>

      <Panel title="旧版迁移" subtitle="migration" icon={Database} wide>
        <div className="migration-form">
          <label>
            <span>旧版目录</span>
            <input
              type="text"
              value={migrationSource}
              onChange={(event) => onMigrationSourceChange(event.target.value)}
              placeholder="例如 D:\\...\\SoftUI"
            />
          </label>
          <button type="button" className="ghost-btn" onClick={onPreviewMigration}>
            <Eye size={16} />
            <span>预览</span>
          </button>
          <button type="button" className="primary-btn" onClick={onRunMigration} disabled={!migrationPreview?.exists}>
            <Database size={16} />
            <span>执行迁移</span>
          </button>
        </div>

        {migrationPreview ? (
          <div className="migration-summary">
            <div><span>用户</span><strong>{migrationPreview.userFiles}</strong></div>
            <div><span>配置</span><strong>{migrationPreview.configFiles}</strong></div>
            <div><span>CSV</span><strong>{migrationPreview.csvFiles}</strong></div>
            <div><span>日志</span><strong>{migrationPreview.logFiles}</strong></div>
            <div><span>可迁移</span><strong>{migrationTotal}</strong></div>
            <div><span>跳过</span><strong>{migrationPreview.skippedFiles}</strong></div>
          </div>
        ) : null}

        {migrationPreview?.warnings.length ? (
          <div className="settings-warning">
            {migrationPreview.warnings.slice(0, 3).map((warning) => (
              <span key={warning}>{warning}</span>
            ))}
          </div>
        ) : null}

        {migrationReport ? <div className="settings-result">报告：{migrationReport.reportPath}</div> : null}
      </Panel>
    </div>
  );
}

function App() {
  return (
    <HashRouter>
      <AppShell />
    </HashRouter>
  );
}

export default App;
