import { lazy, memo, Suspense, useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
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
import ConnectDialog from "./components/ConnectDialog";
import DeviceCard from "./components/DeviceCard";
import PlaybackBar from "./components/PlaybackBar";

// 懒加载重型页面组件，避免启动时加载 Three.js / uPlot / tanstack-table
const ChartsPage = lazy(() => import("./charts"));
const SessionsPage = lazy(() => import("./pages/SessionsPage"));
const RobotScene = lazy(() => import("./RobotScene"));
const PCCCharts = lazy(() => import("./PCCCharts"));
import type {
  AuthSession,
  ConnectDeviceRequest,
  ConnectionProfile,
  DeviceConnectionRecord,
  DeviceRuntimeStatusView,
  LogEntry,
  LogLevel,
  LegacyMigrationPreview,
  LegacyMigrationReport,
  LiveLatest,
  PageKey,
  PlaybackStatus,
  RecorderStatus,
  Role,
  RuntimeSnapshot,
  SerialPortDescriptor,
  SessionInfo,
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

function makeFallbackSnapshot(): RuntimeSnapshot {
  return {
    appInfo: {
      name: "SoftUI",
      version: "0.1.0",
      backend: "Rust + Tauri 2",
      frontend: "React + TypeScript",
      platform: navigator.platform,
    },
    theme: "dark",
    connection: {
      state: "idle",
      activeProfileId: "sim-default",
      activeProfileName: "Simulator",
      profiles: [],
      ports: [],
      handshakeStep: "awaiting connection",
      handshakeProgress: 0,
      lastMessage: "Starting...",
    },
    dashboard: {
      deviceCount: 0,
      connectedDevices: 0,
      currentSession: "",
      sampleRateHz: 0,
      frameRateHz: 0,
      activeProfile: "sim-default",
      lastError: null,
    },
    live: { selectedDeviceId: "", latest: null },
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
      targetAngles: [0, 0],
      captured: false,
      steps: [],
    },
    playback: {
      activeSessionId: "",
      speed: 1,
      cursorMs: 0,
      durationMs: 0,
      sessions: [],
    },
    playbackMode: false,
    controlProfiles: [],
    filterProfiles: [],
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
      storedFrames: 0,
      liveCapacity: 0,
      totalFrames: 0,
      droppedFrames: 0,
      frameRateHz: 0,
      deviceCount: 0,
      pendingCommands: 0,
      sentCommands: 0,
      protocolErrors: 0,
      reconnectAttempts: 0,
      emergencyLatched: false,
      lastError: null,
    },
    controlRuntime: {
      pid: { kp: 0, ki: 0, kd: 0, deadbandDeg: 0, integralLimit: 0, outputLimit: 0, samplePeriodMs: 0 },
      cycle: { enabled: false, lowerAngleDeg: 0, upperAngleDeg: 0, toleranceDeg: 0, dwellMs: 0, maxCycles: 0 },
      phase: "idle",
      active: false,
      allowed: false,
      reason: "",
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
  type MonitorPane = "all" | "bend";

  const [pane, setPane] = useState<WorkspacePane>("overview");
  const [monitorPane, setMonitorPane] = useState<MonitorPane>("all");
  const [motorDraft, setMotorDraft] = useState<MotorCommandDraft>({ motorId: 1, positionMm: 0, velocityMmPerSec: 10, accelerationMmPerSec2: 3 });
  const [motorInlineTargets, setMotorInlineTargets] = useState<Record<number, number>>({});
  const [sensorDraft, setSensorDraft] = useState({ sensorId: 1, calibrationValue: 0 });
  const [bendDraft, setBendDraft] = useState({ direction1: 0, angle1Deg: snapshot.calibration.targetAngles[0], direction2: 0, angle2Deg: Math.min(snapshot.calibration.targetAngles[1], 70) });
  const [pidDraft, setPidDraft] = useState({ kp: 0.5, ki: 0.01, kd: 0.01 });
  const [activeControlEnabled, setActiveControlEnabled] = useState(false);
  const [cycleLifeEnabled, setCycleLifeEnabled] = useState(false);
  const [cycleCount, setCycleCount] = useState(0);
  const [cycleLowThreshold, setCycleLowThreshold] = useState(4);
  const [cycleHighThreshold, setCycleHighThreshold] = useState(10);
  const [cycleTargetPosition, setCycleTargetPosition] = useState(-7);
  const [cycleLastTrigger, setCycleLastTrigger] = useState<"low" | "high" | null>(null);
  const [sensorThreshold, setSensorThreshold] = useState(10);
  const [commandStatus, setCommandStatus] = useState<{ tone: "ok" | "warn" | "error"; message: string } | null>(null);

  const latestFrame = snapshot.live.latest;
  const motors = latestFrame?.motors ?? [];
  const sensors = latestFrame?.sensors ?? [];
  const selectedSensor = sensors.find((sensor) => sensor.id === sensorDraft.sensorId) ?? sensors[0];
  const activeSession = snapshot.playback.sessions.find((session) => session.id === snapshot.playback.activeSessionId) ?? snapshot.playback.sessions[0];
  const progress = clamp((snapshot.playback.cursorMs / Math.max(snapshot.playback.durationMs, 1)) * 100, 0, 100);
  const isSystemEnabled = latestFrame?.systemEnabled ?? false;
  const sections = [
    { key: "overview" as const, icon: Activity, title: "监控" },
    { key: "table" as const, icon: Table2, title: "监控数据" },
    { key: "control" as const, icon: SlidersHorizontal, title: "控制" },
    { key: "history" as const, icon: Play, title: "回放" },
  ];
  const directionOptions = [
    { label: "上", value: 0 },
    { label: "右", value: 1 },
    { label: "下", value: 2 },
    { label: "左", value: 3 },
  ];
  const monitorTabs: Array<{ key: MonitorPane; label: string }> = [
    { key: "all", label: "电机与压力" },
    { key: "bend", label: "柔性臂运动" },
  ];

  const notifyCommand = useCallback((message: string, tone: "ok" | "warn" | "error" = "ok") => {
    setCommandStatus({ tone, message });
  }, []);

  const runSystemControl = useCallback(async (action: SystemControlAction) => {
    if (action === "disable" || action === "emergencyStop") {
      setActiveControlEnabled(false);
      setCycleLifeEnabled(false);
    }
    try {
      await onSystemControl(action);
      setCommandStatus({ tone: "ok", message: action === "enable" ? "系统已使能" : action === "disable" ? "系统已失能" : "紧急停止已发送" });
    } catch (err) {
      setCommandStatus({ tone: "error", message: err instanceof Error ? err.message : "命令失败" });
    }
  }, [onSystemControl]);

  const runMotorCommand = useCallback(async (command: MotorCommandDraft, message = "电机命令已发送") => {
    try {
      await onSendMotor(command);
      setCommandStatus({ tone: "ok", message });
    } catch (err) {
      setCommandStatus({ tone: "error", message: err instanceof Error ? err.message : "命令失败" });
    }
  }, [onSendMotor]);

  const runWorkspaceCommand = useCallback(async (command: WorkspaceCommand, payload?: WorkspaceCommandPayload, message = "命令已发送") => {
    try {
      await onWorkspaceCommand(command, payload);
      setCommandStatus({ tone: "ok", message });
    } catch (err) {
      setCommandStatus({ tone: "error", message: err instanceof Error ? err.message : "命令失败" });
    }
  }, [onWorkspaceCommand]);

  useEffect(() => {
    if (!activeControlEnabled || !isSystemEnabled) return;
    runWorkspaceCommand("activeTick", undefined, "主动控制 tick 已发送");
    const timer = window.setInterval(() => onWorkspaceCommand("activeTick"), 200);
    return () => window.clearInterval(timer);
  }, [activeControlEnabled, isSystemEnabled, onWorkspaceCommand, runWorkspaceCommand, snapshot.live.selectedDeviceId]);

  useEffect(() => {
    if (activeControlEnabled && !isSystemEnabled) setActiveControlEnabled(false);
  }, [activeControlEnabled, isSystemEnabled]);

  useEffect(() => {
    if (!cycleLifeEnabled || !isSystemEnabled || !latestFrame) return;
    const sensorValue = latestFrame.sensors[0]?.filtered[0];
    if (sensorValue == null) return;
    if (sensorValue >= cycleHighThreshold && cycleLastTrigger !== "high") {
      runMotorCommand({ motorId: 1, positionMm: 0, velocityMmPerSec: 10, accelerationMmPerSec2: 3 }, "循环寿命：高阈值触发，电机回收");
      setCycleLastTrigger("high");
      if (cycleLastTrigger === "low") setCycleCount((count) => count + 1);
    } else if (sensorValue <= cycleLowThreshold && cycleLastTrigger !== "low") {
      runMotorCommand({ motorId: 1, positionMm: cycleTargetPosition, velocityMmPerSec: 10, accelerationMmPerSec2: 3 }, "循环寿命：低阈值触发，电机伸出");
      setCycleLastTrigger("low");
    }
  }, [cycleHighThreshold, cycleLastTrigger, cycleLifeEnabled, cycleLowThreshold, cycleTargetPosition, isSystemEnabled, latestFrame, runMotorCommand]);

  useEffect(() => {
    if (pane !== "table" || monitorPane !== "bend") return;
    const video = document.getElementById("arm-camera") as HTMLVideoElement | null;
    if (!video || !navigator.mediaDevices?.getUserMedia) return;
    let stream: MediaStream | null = null;
    navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false })
      .then((s) => { stream = s; video.srcObject = s; })
      .catch(() => { video.style.display = "none"; });
    return () => { if (stream) stream.getTracks().forEach((track) => track.stop()); };
  }, [pane, monitorPane]);

  const sensorMax = sensors.reduce((max, sensor) => Math.max(max, sensor.filtered[0]), 0);
  const sensorAlarmCount = sensors.filter((sensor) => sensor.filtered[0] >= sensorThreshold).length;

  return (
    <div className="workspace-page">
      <div className="workspace-tabs" role="tablist" aria-label="workspace sections">
        {sections.map((section) => {
          const Icon = section.icon;
          return <button key={section.key} type="button" className={`workspace-tab ${pane === section.key ? "active" : ""}`} onClick={() => setPane(section.key)}><Icon size={15} /><span>{section.title}</span></button>;
        })}
      </div>

      {pane === "overview" ? (
        <div className="page-grid workspace-grid workspace-overview-grid">
          <Panel title="设备管理器" subtitle="workspace" icon={Cable} wide>
            <div className="workspace-split">
              <div className="workspace-list">
                <div className="stack-item"><span>连接状态</span><strong>{snapshot.connection.state}</strong></div>
                <div className="stack-item"><span>当前设备</span><strong>{snapshot.live.selectedDeviceId || "无"}</strong></div>
                <div className="stack-item"><span>采样 / 帧率</span><strong>{snapshot.dashboard.sampleRateHz} Hz / {snapshot.dashboard.frameRateHz} fps</strong></div>
                <div className="stack-item"><span>协议 / 帧号</span><strong>{latestFrame ? `${latestFrame.protocolVersion} / #${latestFrame.sequence}` : "无数据"}</strong></div>
                <div className="progress-track"><div className="progress-fill" style={{ width: `${snapshot.connection.handshakeProgress}%` }} /></div>
              </div>
              <div className="workspace-list">
                <div className="status-strip compact">
                  <div className="status-strip-item"><span className="status-strip-label">电机</span><strong>{motors.length} 路</strong></div>
                  <div className="status-strip-item"><span className="status-strip-label">传感器</span><strong>{sensors.length} 路</strong></div>
                  <div className="status-strip-item"><span className="status-strip-label">系统</span><Badge tone={isSystemEnabled ? "ok" : "warn"}>{isSystemEnabled ? "已使能" : "未使能"}</Badge></div>
                </div>
                <div className="mini-grid compact">
                  <article className="mini-card"><div className="mini-title">第一段角度</div><div className="mini-value">{latestFrame?.bend.section1.angleDeg.toFixed(1) ?? "--"}°</div><div className="mini-sub">目标 {latestFrame?.bend.section1.targetAngleDeg.toFixed(1) ?? "--"}°</div></article>
                  <article className="mini-card"><div className="mini-title">第二段角度</div><div className="mini-value">{latestFrame?.bend.section2.angleDeg.toFixed(1) ?? "--"}°</div><div className="mini-sub">目标 {latestFrame?.bend.section2.targetAngleDeg.toFixed(1) ?? "--"}°</div></article>
                </div>
                <div className="button-stack">
                  <button type="button" className="ghost-btn full" onClick={onRefreshSerialPorts}><RefreshCw size={16} /><span>扫描串口</span></button>
                  <button type="button" className="ghost-btn full" onClick={onOpenConnectDialog}><Wifi size={16} /><span>连接新设备</span></button>
                </div>
              </div>
            </div>
          </Panel>

          <Panel title="串口发现" subtitle="transport" icon={Cable} wide>
            {connectionError ? <div className="connection-error"><AlertTriangle size={14} /><span>{connectionError}</span></div> : null}
            {connectedDevices.length > 0 ? <div className="device-grid" style={{ marginBottom: 10 }}>{connectedDevices.map((dev) => <DeviceCard key={dev.deviceId} device={dev} runtimeStatus={deviceStatuses[dev.deviceId] ?? null} onDisconnect={onDisconnectDevice} />)}</div> : null}
            <button type="button" className="ghost-btn full" onClick={onOpenConnectDialog} style={{ marginBottom: 10 }}><Wifi size={16} /><span>连接新设备</span></button>
            <div className="port-list">
              {serialPorts.length === 0 ? <div className="port-card"><div><strong>未发现真实串口</strong><span>{serialPortsError ?? "可继续使用 Simulator；连接硬件后点击刷新串口。"}</span></div><Badge tone="warn">无串口</Badge></div> : serialPorts.map((port) => <div className="port-card" key={port.portName}><div><strong>{port.portName}</strong><span>{port.description ?? port.product ?? "Serial port"} · {port.manufacturer ?? port.portType}</span></div><div className="port-meta"><Badge tone={port.likelyAvailable ? "ok" : "warn"}>{port.portType.toUpperCase()}</Badge>{port.vid != null && port.pid != null ? <span>VID {port.vid.toString(16).padStart(4, "0").toUpperCase()} / PID {port.pid.toString(16).padStart(4, "0").toUpperCase()}</span> : <span>{port.likelyAvailable ? "可用" : "已过滤"}</span>}</div></div>)}
            </div>
          </Panel>
        </div>
      ) : null}

      {pane === "table" ? (
        <div className="page-grid workspace-grid workspace-monitor-grid">
          <Panel title="设备监控数据" subtitle="DeviceTab monitor" icon={Eye} wide>
            <div className="monitor-tabs" role="tablist" aria-label="device monitor tabs">
              {monitorTabs.map((tab) => <button key={tab.key} type="button" className={`monitor-tab ${monitorPane === tab.key ? "active" : ""}`} onClick={() => setMonitorPane(tab.key)}>{tab.label}</button>)}
            </div>

            {monitorPane === "all" ? <div className="monitor-card-grid">
              {motors.map((motor) => <article className="monitor-card" key={`motor-${motor.id}`}><div className="monitor-card-head"><strong>电机 {motor.id}</strong><Badge tone={motor.running ? "ok" : "warn"}>{motor.running ? "运行" : "停止"}</Badge></div><div className="metric-grid two"><span>位移</span><strong>{motor.positionMm.toFixed(2)} mm</strong><span>速度</span><strong>{motor.velocityMmPerSec.toFixed(2)} mm/s</strong><span>加速度</span><strong>{motor.accelerationMmPerSec2.toFixed(2)} mm/s²</strong><span>目标</span><strong>{motor.targetPositionMm.toFixed(2)} mm</strong></div></article>)}
              {sensors.map((sensor) => <article className="monitor-card" key={`sensor-${sensor.id}`}><div className="monitor-card-head"><strong>压力传感器 {sensor.id}</strong><Badge tone={sensor.quality === "ok" ? "ok" : "warn"}>{sensor.quality}</Badge></div><div className="sensor-axis-grid">{sensor.alias.map((axis, index) => <div key={axis}><span>{axis}</span><strong>{sensor.filtered[index].toFixed(2)} {sensor.unit}</strong><small>raw {sensor.raw[index].toFixed(2)}</small></div>)}</div></article>)}
              {motors.length === 0 && sensors.length === 0 ? <div className="panel-empty">暂无实时监控数据，请先连接设备或启动模拟器。</div> : null}
            </div> : null}

            {monitorPane === "bend" ? <div className="bend-panel-layout">
              <div className="bend-status-grid">
                <div className="scene-wrap">
                  <RobotScene section1AngleDeg={latestFrame?.bend.section1.angleDeg ?? 0} section2AngleDeg={latestFrame?.bend.section2.angleDeg ?? 0} section1Direction={latestFrame?.bend.section1.direction ?? "up"} section2Direction={latestFrame?.bend.section2.direction ?? "up"} />
                </div>
                <div className="bend-right-col">
                  <div className="right-top-row">
                    <div className="command-form threshold-controls"><label><span>阈值 (N)</span><input type="number" step={0.1} value={sensorThreshold} onChange={(event) => setSensorThreshold(Number(event.target.value))} /></label><div className="threshold-summary"><span>最高值</span><strong>{sensorMax.toFixed(2)} N</strong></div><div className="threshold-summary"><span>报警点</span><strong>{sensorAlarmCount}</strong></div></div>
                    <svg className="sensor-threshold-disk" viewBox="0 0 260 260" role="img" aria-label="sensor threshold overview"><circle cx="130" cy="130" r="126" className="sensor-disk-bg" /><circle cx="130" cy="130" r="108" className="sensor-disk-ring" /><text x="130" y="122" textAnchor="middle" className="sensor-disk-value">{sensorMax.toFixed(1)}N</text><text x="130" y="146" textAnchor="middle" className="sensor-disk-label">max</text>{sensors.map((sensor, index) => { const angle = (Math.PI * 2 * index) / Math.max(sensors.length, 1) - Math.PI / 2; const x = 130 + Math.cos(angle) * 108; const y = 130 + Math.sin(angle) * 108; const value = sensor.filtered[0]; const ratio = sensorThreshold > 0 ? value / sensorThreshold : 0; const tone = ratio >= 1 ? "alarm" : ratio >= 0.75 ? "warn" : "ok"; return <g key={sensor.id}><circle cx={x} cy={y} r="24" className={`sensor-node ${tone}`} /><text x={x} y={y + 6} textAnchor="middle" className="sensor-node-label">{sensor.id}</text></g>; })}</svg>
                  </div>
                  <div className="camera-feed-wrap"><video id="arm-camera" className="camera-feed" autoPlay muted playsInline /></div>
                </div>
              </div>
              <PCCCharts section1AngleDeg={latestFrame?.bend.section1.angleDeg ?? 0} section2AngleDeg={latestFrame?.bend.section2.angleDeg ?? 0} />
            </div> : null}
          </Panel>
        </div>
      ) : null}

      {pane === "control" ? (
        <div className="device-control-grid">
          <Panel title="1. 系统操作权限" subtitle="DeviceTab" icon={Activity} wide>
            <div className="status-strip">
              <div className="status-strip-item"><span className="status-strip-label">连接状态</span><Badge tone={snapshot.connection.state === "ready" ? "ok" : snapshot.connection.state === "error" ? "error" : "warn"}>{snapshot.connection.state === "ready" ? "已连接" : snapshot.connection.state === "idle" ? "空闲" : snapshot.connection.state === "connecting" ? "连接中" : snapshot.connection.state === "error" ? "错误" : snapshot.connection.state}</Badge></div>
              <div className="status-strip-item"><span className="status-strip-label">使能状态</span><Badge tone={isSystemEnabled ? "ok" : "warn"}>{isSystemEnabled ? "已使能" : "已失能"}</Badge></div>
              <div className="status-strip-item"><span className="status-strip-label">设备</span><strong>{snapshot.live.selectedDeviceId || "无"}</strong></div>
              {commandStatus ? <Badge tone={commandStatus.tone}>{commandStatus.message}</Badge> : null}
              <div className="status-strip-actions"><button type="button" className="ghost-btn" onClick={() => runSystemControl("enable")}><CheckCircle2 size={15} /><span>启动控制系统</span></button><button type="button" className="ghost-btn" onClick={() => runSystemControl("disable")}><PauseCircle size={15} /><span>关闭控制系统</span></button><button type="button" className="ghost-btn danger" onClick={() => runSystemControl("emergencyStop")}><AlertTriangle size={15} /><span>紧急停止</span></button></div>
            </div>
          </Panel>

          <Panel title="2. 臂体弯曲控制" subtitle="DeviceTab" icon={ArrowRightLeft} wide>
            <div className="bend-control-layout">
              {[1, 2].map((section) => <div className="bend-section-card" key={section}><div className="command-form-title">第{section === 1 ? "一" : "二"}段弯曲</div><label className="inline-input"><span>角度</span><input type="number" min={0} max={section === 1 ? 90 : 70} step={0.1} value={section === 1 ? bendDraft.angle1Deg : bendDraft.angle2Deg} onChange={(event) => setBendDraft((draft) => section === 1 ? { ...draft, angle1Deg: clamp(Number(event.target.value), 0, 90) } : { ...draft, angle2Deg: clamp(Number(event.target.value), 0, 70) })} /><span>°</span></label><div className="bend-direction-grid">{directionOptions.map((direction) => <button key={`${section}-${direction.value}`} type="button" className={`ghost-btn ${(section === 1 ? bendDraft.direction1 : bendDraft.direction2) === direction.value ? "active" : ""}`} onClick={() => setBendDraft((draft) => section === 1 ? { ...draft, direction1: direction.value } : { ...draft, direction2: direction.value })}>{direction.label}</button>)}</div></div>)}
              <div className="bend-action-card"><button type="button" className="primary-btn full" onClick={() => runWorkspaceCommand("bend", bendDraft, "已发送臂体弯曲命令")}>臂体弯曲</button><button type="button" className="ghost-btn full" onClick={() => { setBendDraft((draft) => ({ ...draft, angle1Deg: 0, angle2Deg: 0 })); runWorkspaceCommand("home", undefined, "已发送一键归中命令"); }}>一键归中</button><button type="button" className={`ghost-btn full ${activeControlEnabled ? "active" : ""}`} onClick={() => { const next = !activeControlEnabled; setActiveControlEnabled(next); notifyCommand(next ? "主动控制已开启，每 200ms 发送 tick" : "主动控制已停止", next ? "ok" : "warn"); }} disabled={!isSystemEnabled}>{activeControlEnabled ? "停止主动控制" : "主动控制"}</button></div>
              <div className="pid-grid">{(["kp", "ki", "kd"] as const).map((key) => <label key={key}><span>{key.toUpperCase()}</span><input type="number" step={0.01} value={pidDraft[key]} onChange={(event) => setPidDraft((draft) => ({ ...draft, [key]: Number(event.target.value) }))} /></label>)}</div>
            </div>
          </Panel>

          <Panel title="3. 电机控制" subtitle="DeviceTab" icon={ArrowRightLeft} wide>
            <div className="motor-inline-bar"><label><span>电机 ID</span><select value={motorDraft.motorId} onChange={(event) => setMotorDraft((draft) => ({ ...draft, motorId: Number(event.target.value) }))}>{motors.map((motor) => <option key={motor.id} value={motor.id}>{motor.id}</option>)}</select></label><label><span>位移 mm</span><input type="number" min={-80} max={80} step={0.1} value={motorDraft.positionMm} onChange={(event) => setMotorDraft((draft) => ({ ...draft, positionMm: clamp(Number(event.target.value), -80, 80) }))} /></label><label><span>速度</span><input type="number" min={0} step={0.1} value={motorDraft.velocityMmPerSec} onChange={(event) => setMotorDraft((draft) => ({ ...draft, velocityMmPerSec: Number(event.target.value) }))} /></label><label><span>加速度</span><input type="number" min={0} step={0.1} value={motorDraft.accelerationMmPerSec2} onChange={(event) => setMotorDraft((draft) => ({ ...draft, accelerationMmPerSec2: Number(event.target.value) }))} /></label><button type="button" className="ghost-btn" onClick={() => runMotorCommand(motorDraft)}><ArrowRightLeft size={14} /><span>发至电机</span></button></div>
            <div className="motor-control-grid embedded">{motors.map((motor) => <article className="motor-control-card" key={motor.id}><div className="motor-control-head"><strong>电机 {motor.id}</strong><Badge tone={motor.running ? "ok" : "warn"}>{motor.running ? "运行" : "停止"}</Badge></div><div className="motor-control-values"><div><span>当前位置</span><strong>{motor.positionMm.toFixed(1)} mm</strong></div><div><span>速度</span><strong>{motor.velocityMmPerSec.toFixed(1)} mm/s</strong></div></div><input type="number" step={0.1} className="motor-target-input" value={motorInlineTargets[motor.id] ?? motor.targetPositionMm} onChange={(event) => setMotorInlineTargets((prev) => ({ ...prev, [motor.id]: Number(event.target.value) }))} /><div className="motor-control-actions"><button type="button" className="ghost-btn" onClick={() => setMotorDraft((draft) => ({ ...draft, motorId: motor.id }))}><span>选中</span></button><button type="button" className="ghost-btn" onClick={() => runMotorCommand({ motorId: motor.id, positionMm: motorInlineTargets[motor.id] ?? motor.targetPositionMm, velocityMmPerSec: Math.max(motor.velocityMmPerSec, 1), accelerationMmPerSec2: Math.max(motor.accelerationMmPerSec2, 1) })}><ArrowRightLeft size={14} /><span>发送目标</span></button></div></article>)}</div>
          </Panel>

          <Panel title="4. 压力数据监控 / 校准" subtitle="DeviceTab" icon={CheckCircle2}>
            <div className="command-form"><span className="command-form-title">校准参数</span><label><span>压力传感器 ID</span><select value={sensorDraft.sensorId} onChange={(event) => setSensorDraft((draft) => ({ ...draft, sensorId: Number(event.target.value) }))}>{sensors.map((sensor) => <option key={sensor.id} value={sensor.id}>{sensor.id}</option>)}</select></label><label><span>校准值 N</span><input type="number" step={0.01} value={sensorDraft.calibrationValue} onChange={(event) => setSensorDraft((draft) => ({ ...draft, calibrationValue: Number(event.target.value) }))} /></label><button type="button" className="ghost-btn full" onClick={() => runWorkspaceCommand("calibrateSensor", sensorDraft, "已发送传感器校准命令")}><CheckCircle2 size={15} /><span>校准传感器</span></button></div>
            {selectedSensor ? <div className="sensor-axis-grid compact">{selectedSensor.alias.map((axis, index) => <div key={axis}><span>{axis}</span><strong>{selectedSensor.filtered[index].toFixed(2)} {selectedSensor.unit}</strong><small>raw {selectedSensor.raw[index].toFixed(2)}</small></div>)}</div> : null}
          </Panel>

          <Panel title="循环寿命检测" subtitle="frontend loop" icon={Activity}>
            <div className="cycle-life-grid"><div className="cycle-count"><span>循环次数</span><strong>{cycleCount}</strong></div><label><span>低阈值</span><input type="number" step={0.1} value={cycleLowThreshold} onChange={(event) => setCycleLowThreshold(Number(event.target.value))} /></label><label><span>高阈值</span><input type="number" step={0.1} value={cycleHighThreshold} onChange={(event) => setCycleHighThreshold(Number(event.target.value))} /></label><label><span>伸出位移</span><input type="number" step={0.1} value={cycleTargetPosition} onChange={(event) => setCycleTargetPosition(Number(event.target.value))} /></label><button type="button" className={`ghost-btn full ${cycleLifeEnabled ? "active" : ""}`} disabled={!isSystemEnabled} onClick={() => { const next = !cycleLifeEnabled; setCycleLifeEnabled(next); notifyCommand(next ? "循环寿命检测已开启" : "循环寿命检测已停止", next ? "ok" : "warn"); }}>{cycleLifeEnabled ? "停止循环寿命检测" : "循环寿命检测"}</button><button type="button" className="ghost-btn full" onClick={() => { setCycleCount(0); setCycleLastTrigger(null); }}>重置计数</button><div className="cycle-feedback"><span>反馈值</span><strong>{latestFrame?.sensors[0]?.filtered[0].toFixed(2) ?? "--"} N</strong></div></div>
          </Panel>
        </div>
      ) : null}

      {pane === "history" ? (
        <div className="page-grid workspace-grid">
          <Panel title="会话与回放" subtitle="workspace" icon={Play} wide><div className="timeline"><div className="timeline-bar"><div className="timeline-fill" style={{ width: `${progress}%` }} /></div><div className="timeline-meta"><span>{isoFull(snapshot.playback.cursorMs)}</span><span>{snapshot.playback.speed.toFixed(1)}x</span><span>{snapshot.playback.durationMs / 1000}s</span></div></div><div className="mini-info">当前会话：<strong>{activeSession?.name}</strong></div></Panel>
          <Panel title="会话列表" subtitle="workspace" icon={Database}><div className="stack-list">{snapshot.playback.sessions.map((session) => <div className="stack-item" key={session.id}><span>{session.name}</span><strong>{session.recordCount.toLocaleString()} 条记录</strong></div>)}</div></Panel>
          <Panel title="最近日志" subtitle="workspace" icon={Logs} wide><div className="log-list compact">{snapshot.logs.slice(0, 4).map((entry) => <div className="log-row" key={entry.id}><Badge tone={toneForLevel(entry.level)}>{entry.level.toUpperCase()}</Badge><span className="log-scope">{entry.scope}</span><span className="log-message">{entry.message}</span></div>)}</div></Panel>
        </div>
      ) : null}
    </div>
  );
}

const Sidebar = memo(function Sidebar({
  sidebarCollapsed, connectionState, activeProfileName, sampleRateHz, onToggleSidebar
}: {
  sidebarCollapsed: boolean; connectionState: string;
  activeProfileName: string; sampleRateHz: number; onToggleSidebar: () => void;
}) {
  const statusTone = connectionState === "ready" ? "ok" : connectionState === "error" ? "error" : "warn";
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark"><Fingerprint size={18} /></div>
        <div className="brand-copy">
          <div className="brand-title">SoftUI</div>
          <div className="brand-subtitle">桌面控制台</div>
        </div>
        <button type="button" className="sidebar-toggle" onClick={onToggleSidebar}
          title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"} aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}>
          <ChevronRight size={16} />
        </button>
      </div>
      <nav className="nav">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink key={item.path} to={item.path} title={item.title}
              className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
              <span className="nav-icon"><Icon size={16} /></span>
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
          <Badge tone={statusTone}>{connectionState}</Badge>
          <span>{activeProfileName}</span>
        </div>
        <div className="side-stat">
          <Activity size={16} />
          <span>采样 {sampleRateHz} Hz</span>
        </div>
        <div className="side-stat">
          <SquareTerminal size={16} />
          <span>Rust + Tauri 2</span>
        </div>
      </section>
    </aside>
  );
});

const Topbar = memo(function Topbar({
  theme, currentPage, recorderStatus, connectionState, username,
  onToggleTheme, onRefresh, onToggleConnection, onToggleRecording, onLogout
}: {
  theme: ThemeMode; currentPage: PageKey; recorderStatus: RecorderStatus;
  connectionState: string; username: string;
  onToggleTheme: () => void; onRefresh: () => void; onToggleConnection: () => void;
  onToggleRecording: () => void; onLogout: () => void;
}) {
  return (
    <header className="topbar">
      <div className="headline">
        <div className="section-label">SoftUI</div>
        <h1>{pageTitles[currentPage]}</h1>
        <p>{pageDescriptions[currentPage]}</p>
      </div>
      <div className="actions">
        <button type="button" className="ghost-btn" onClick={onToggleTheme}>
          {theme === "dark" ? <SunMedium size={16} /> : <MoonStar size={16} />}
          <span>{theme === "dark" ? "浅色" : "深色"}</span>
        </button>
        <button type="button" className="ghost-btn" onClick={onRefresh}>
          <RefreshCw size={16} /><span>刷新</span>
        </button>
        <button type="button"
          className={`primary-btn ${connectionState === "ready" ? "is-live" : "is-idle"}`}
          onClick={onToggleConnection}>
          <Wifi size={16} />
          <span>{connectionState === "ready" ? "断开" : "连接"}</span>
        </button>
        <button type="button" className="ghost-btn">
          <Save size={16} /><span>保存布局</span>
        </button>
        <button type="button"
          className={`primary-btn ${recorderStatus.active ? "is-recording" : "is-idle"}`}
          onClick={onToggleRecording}>
          <Activity size={16} />
          <span>{recorderStatus.active ? `⏹ ${recorderStatus.frameCount}帧 ${recorderStatus.elapsedSecs}s` : "录制"}</span>
        </button>
        <button type="button" className="ghost-btn" onClick={onLogout}>
          <Fingerprint size={16} /><span>退出 {username}</span>
        </button>
      </div>
    </header>
  );
});

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
  const authenticated = snapshot.authSession.authenticated && !snapshot.authSession.mustChangePassword;

  const fetchSnapshot = useCallback(async (mode: "bootstrap_state" | "tick_snapshot" = "bootstrap_state") => {
    try {
      const next = await invoke<RuntimeSnapshot>(mode);
      setSnapshot(next);
    } catch (invokeError) {
      console.error(invokeError);
    }
  }, []);

  // 首次挂载时从后端获取真实状态（包括 authSession）
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

  // 串口枚举较慢（Windows 可能 2-5 秒），仅保留手动刷新，首次不自动枚举
  // 用户点击"扫描串口"时触发 refreshSerialPorts

  // 轻量实时更新：非曲线页高频拉取最新帧 + 统计，只更新 live/dashboard 字段，
  // 避免整份快照往返与全树重渲染。
  const fetchLiveLatest = useCallback(async () => {
    try {
      const next = await invoke<LiveLatest>("fetch_live_latest");
      setSnapshot((prev) => ({
        ...prev,
        live: { selectedDeviceId: next.selectedDeviceId, latest: next.latest },
        dashboard: {
          ...prev.dashboard,
          sampleRateHz: Math.round(next.stats.frameRateHz),
          frameRateHz: Math.round(next.stats.frameRateHz),
        },
        runtimeDiagnostics: {
          ...prev.runtimeDiagnostics,
          storedFrames: next.stats.storedFrames,
          liveCapacity: next.stats.capacity,
          totalFrames: next.stats.totalFrames,
          droppedFrames: next.stats.droppedFrames,
          frameRateHz: next.stats.frameRateHz,
        },
        connection:
          next.latest != null
            ? { ...prev.connection, state: "ready", activeProfileName: "Serial runtime", lastMessage: "Serial stream active" }
            : prev.connection,
      }));
    } catch (invokeError) {
      console.error(invokeError);
    }
  }, []);

  // 轻量实时更新：各页面统一 500ms 拉取最新帧 + 统计。
  // 曲线页的高频曲线数据由 ChartsPage 独立调用 fetch_live_window(100ms) 获取。
  useEffect(() => {
    if (!authenticated) return;
    let pending = false;
    const timer = window.setInterval(() => {
      if (pending) return;
      pending = true;
      void fetchLiveLatest().finally(() => {
        pending = false;
      });
    }, 500);
    return () => window.clearInterval(timer);
  }, [fetchLiveLatest, authenticated]);

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

  // 1秒轮询已连接设备 — 未认证时不启动
  useEffect(() => {
    if (!authenticated) return;
    const interval = setInterval(() => { void refreshConnectedDevices(); }, 1000);
    return () => clearInterval(interval);
  }, [refreshConnectedDevices, authenticated]);

  // Load connection profiles
  const refreshConnectionProfiles = useCallback(async () => {
    try {
      const profiles = await invoke<ConnectionProfile[]>("list_connection_profiles");
      setConnectionProfiles(profiles);
    } catch { /* ignore */ }
  }, []);

  // 连接配置和用户列表在登录后加载
  useEffect(() => {
    if (!authenticated) return;
    void refreshConnectionProfiles();
  }, [refreshConnectionProfiles, authenticated]);

  const refreshUsers = useCallback(async () => {
    try {
      const list = await invoke<UserAccount[]>("list_users");
      setUsers(list);
    } catch {
      setUsers([]);
    }
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    void refreshUsers();
  }, [refreshUsers, snapshot.authSession.username, snapshot.authSession.role, authenticated]);

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
    } catch (invokeError) {
      setAuthError(invokeError instanceof Error ? invokeError.message : String(invokeError));
    } finally {
      setAuthBusy(false);
    }
  }, [applyAuthSession]);

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

  // Poll recorder status and sessions list every 2 seconds — 未认证时不启动
  useEffect(() => {
    if (!authenticated) return;
    const interval = setInterval(async () => {
      try {
        const status = await invoke<RecorderStatus>("recorder_status");
        setRecorderStatus(status);
        const list = await invoke<SessionInfo[]>("list_sessions");
        setSessions(list);
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(interval);
  }, [authenticated]);

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

  // 懒加载页面预取：挂载后在空闲时间提前加载各页面 chunk，
  // 避免首次点击侧边栏时阻塞在动态 import 解析上。
  useEffect(() => {
    let cancelled = false;
    const prefetch = () => {
      if (cancelled) return;
      void import("./charts");
      void import("./pages/SessionsPage");
      void import("./RobotScene");
      void import("./PCCCharts");
    };
    const idleWindow = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (idleWindow.requestIdleCallback) {
      const idle = idleWindow.requestIdleCallback(prefetch, { timeout: 2000 });
      return () => {
        cancelled = true;
        idleWindow.cancelIdleCallback?.(idle);
      };
    }
    const timer = window.setTimeout(prefetch, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

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
      <Sidebar sidebarCollapsed={sidebarCollapsed}
        connectionState={snapshot.connection.state} activeProfileName={snapshot.connection.activeProfileName}
        sampleRateHz={snapshot.dashboard.sampleRateHz}
        onToggleSidebar={() => setSidebarCollapsed((collapsed) => !collapsed)} />
      <main className={`workspace ${currentPage === "Dashboard" ? "with-summary" : "without-summary"}`}>
        <Topbar theme={snapshot.theme} currentPage={currentPage} recorderStatus={recorderStatus}
          connectionState={snapshot.connection.state} username={snapshot.authSession.username}
          onToggleTheme={toggleTheme} onRefresh={() => void fetchSnapshot("tick_snapshot")}
          onToggleConnection={toggleConnection} onToggleRecording={toggleRecording}
          onLogout={logoutUser} />

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
          <Suspense fallback={<div className="page-loading">加载中...</div>}>
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
          </Suspense>

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
  const latestFrame = snapshot.live.latest;
  const motors = latestFrame?.motors ?? [];
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
            <span>{latestFrame?.deviceId ?? "无数据"}</span>
            <span><Badge tone={latestFrame?.systemEnabled ? "ok" : "warn"}>{latestFrame?.systemEnabled ? "已使能" : "空闲"}</Badge></span>
            <span>{latestFrame ? `#${latestFrame.sequence}` : "--"}</span>
            <span>{latestFrame ? `${latestFrame.quality.latencyMs} ms` : "--"}</span>
          </div>
        </div>

        <div className="mini-grid">
          {motors.map((motor) => (
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
            <div className="health-value">{latestFrame?.quality.status ?? "—"}</div>
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
