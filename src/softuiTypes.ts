export type ChartChannelType = "motor" | "bend" | "sensor";

export type ThemeMode = "dark" | "light";

/* ---- 卡片布局系统 ---- */

/**
 * 卡片尺寸：`列数 x 行数`，每一维都是 1~4 格。
 *
 * 用模板字面量类型而不是枚举，是为了让「拖到 3x2」这种自由尺寸也能直接表达 ——
 * 上限由 `MAX_CARD_SPAN` 和容器列数共同约束，见 state/layoutStore.ts。
 */
export type CardSize = `${1 | 2 | 3 | 4}x${1 | 2 | 3 | 4}`;

/** 可持久化布局的页面。 */
export type LayoutPage =
  | "dashboard"
  | "workspace-monitor"
  | "workspace-manual"
  | "workspace-automatic"
  /** 后台管理页：每栏一张卡，可拖动/缩放 ✓（**每个管理员各自一份** ✓）*/
  | "admin";

export interface CardPlacement {
  id: string;
  size: CardSize;
  visible: boolean;
}

/** 布局数据结构版本。卡片集合有增删时递增，见 state/layoutStore.ts。 */
/**
 * 布局数据结构版本（**卡片集合有增减时必须递增** ✓）
 * v3 → v4：后台新增 `registration` 卡片 ✓
 */
export type LayoutSchemaVersion = 5;

export interface PageLayout {
  schemaVersion: LayoutSchemaVersion;
  cards: CardPlacement[];
}

/** 总览页卡片。id 与参考实现保持一致，便于将来接拖拽/缩放。 */
export type DashboardCardId =
  | "connection"
  | "sampling"
  | "recording"
  | "alerts"
  | "deviceHealth"
  | "recentSessions"
  | "recentEvents";

/** 设备工作台「监控」标签的卡片。 */
export type MonitorCardId =
  | "deviceState"
  | "commandQueue"
  | "motorSummary"
  | "sensorSummary"
  | "model3d"
  | "camera"
  | "armCharts"
  | "recentAlerts";

/** 设备工作台「控制」标签的卡片。 */
export type ManualCardId =
  | "curvatureDrag"
  | "motorControl"
  | "systemControl";

/** 设备工作台「参数调整」标签的卡片。 */
export type AutomaticCardId =
  | "modelPackage"
  | "sensorMonitor"
  | "pidControl"
  | "cycleLife"
  /** 策略编排：按工况自动切换模型 ✓ */
  | "policyRules"
  /** 动作库：拖动记录末端点 → 存成动作 ✓ */
  | "motionLibrary"
  /** 典型臂形标定：把臂驱动到已知名义形状，人工量角校验模型 ✓ */
  | "shapeCalibration"
  /** 驱动丝识别：单丝点动 → 观察弯曲方向，判断电机线序 ✓ */
  | "tendonIdentify";

export type PageKey =
  | "Dashboard"
  | "Workspace"
  | "Charts"
  | "Logs"
  | "Settings"
  | "Model"
  | "Sessions";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "handshaking"
  | "ready"
  | "enabled"
  | "disabled"
  | "emergencyStopped"
  | "reconnecting"
  | "error"
  | "closed";
export type FrameQuality = "ok" | "warning" | "invalid";
export type LogLevel = "info" | "warn" | "error" | "debug";
export type Role = "admin" | "operator" | "maintainer";
export type Permission =
  | "viewDashboard"
  | "connectDevice"
  | "sendMotionCommand"
  | "runCalibration"
  | "runCycleLife"
  | "manageSessions"
  | "viewDiagnostics"
  | "manageSettings"
  | "manageUsers";

export interface MotorState {
  id: number;
  positionMm: number;
  velocityMmPerSec: number;
  accelerationMmPerSec2: number;
  running: boolean;
  targetPositionMm: number;
}

/** 一路压力通道（**只有两个数**，不是三轴传感器）。
 *
 * 固件口径：`x` = **实际值**（未经滤波的读数），`y` = **滤波值**；每路 4 字节。
 * 旧固件每路 6 字节（多一个保留位），解析器两种步长都接受。
 *
 * ⚠️ 这与指令集文档 §5.1 的写法相反（文档写 x=滤波、y=原始），以固件实际报文为准。
 */
export interface SensorState {
  id: number;
  /** 实际值：未经滤波的读数。 */
  rawValue: number;
  /** 滤波值。 */
  filteredValue: number;
  unit: string;
  quality: FrameQuality;
}

export interface BendState {
  angleDeg: number;
  targetAngleDeg: number;
  direction: "up" | "right" | "down" | "left";
  quality: FrameQuality;
}

export interface SectionCurvatureState {
  curvaturePerM: number;
  directionDeg: number;
}

export interface MotorDynamicsState {
  id: number;
  positionMm: number;
  velocityMmPerSec: number;
  accelerationMmPerSec2: number;
}

export interface SensorDynamicsState {
  id: number;
  /** 滤波 + 通道平衡后的张力（N）。一路通道只有一个值，不再分轴。 */
  forceN: number;
}

export interface DynamicsInput {
  deviceId: string;
  timestampMs: number;
  dtMs: number;
  motors: MotorDynamicsState[];
  sensors: SensorDynamicsState[];
  sections: SectionCurvatureState[];
}

export interface CurvatureProfile {
  sMm: number[];
  kxPerM: number[];
  kyPerM: number[];
  kappaAbsPerM: number[];
}

export interface DynamicsTipPose {
  positionM: [number, number, number];
}

export interface DynamicsDiagnostics {
  frameValid: boolean;
  maxCurvaturePerM: number;
  allForcesFinite: boolean;
  forceMaxN: number;
  inputMode?: "curvature" | "legacyAngleDerived";
  legacyAngleDerived?: boolean;
}

export interface DynamicsOutput {
  deviceId: string;
  timestampMs: number;
  sections: SectionCurvatureState[];
  tendonForcesN: [number, number, number, number, number, number];
  curvature: CurvatureProfile;
  tipPose: DynamicsTipPose;
  diagnostics: DynamicsDiagnostics;
}

export interface DeviceSnapshot {
  deviceId: string;
  connectionId: string;
  receivedAtMs: number;
  sequence: number;
  protocolVersion: string;
  systemEnabled: boolean;
  motors: MotorState[];
  sensors: SensorState[];
  bend: {
    section1: BendState;
    section2: BendState;
  };
  quality: {
    status: FrameQuality;
    latencyMs: number;
    droppedFrames: number;
    checksumOk: boolean;
  };
}

export interface ConnectionProfile {
  id: string;
  name: string;
  port: string;
  baudRate: number;
  dataBits: 7 | 8;
  parity: "none" | "even" | "odd";
  stopBits: 1 | 2;
  flowControl: "none" | "software" | "hardware";
  autoReconnect: boolean;
}

export interface SerialPortDescriptor {
  portName: string;
  portType: "usb" | "bluetooth" | "pci" | "unknown" | string;
  description?: string | null;
  manufacturer?: string | null;
  product?: string | null;
  serialNumber?: string | null;
  vid?: number | null;
  pid?: number | null;
  likelyAvailable: boolean;
  /**
   * 是否为用户**刚在浏览器端口选择框里选中**的那个。
   *
   * 浏览器那层弹窗是显示系统端口名（COM3/COM5）的，而网页本身拿不到 ——
   * 所以这一次选择是"哪一个才是我的设备"的唯一可靠依据，界面上要据此预选。
   */
  picked?: boolean;
}

export interface DeviceConnectionRecord {
  deviceId: string;
  connectionId: string;
  portName: string;
  baudRate: number;
  state: ConnectionState;
  connectedAtMs: number;
}

export interface ControlProfile {
  id: string;
  name: string;
  enabled: boolean;
  cycleLifeEnabled: boolean;
  thresholdLow: number;
  thresholdHigh: number;
  cyclePeriodMs: number;
}

export interface FilterProfile {
  id: string;
  name: string;
  enabled: boolean;
  windowSize: number;
  exponentialAlpha: number;
}

export interface ModelProfile {
  id: string;
  name: string;
  modelPath: string;
  section1MaxAngleDeg: number;
  section2MaxAngleDeg: number;
  section1Node: string;
  section2Node: string;
}

export interface LogEntry {
  id: number;
  level: LogLevel;
  scope: string;
  message: string;
  timestampMs: number;
  deviceId?: string | null;
  frameHex?: string | null;
}

export interface SessionMetadata {
  operator: string;
  notes: string;
  tags: string[];
  deviceIds: string[];
  connectionProfileId: string;
  controlProfileId: string;
  filterProfileId: string;
}
export interface SessionEntry {
  id: string;
  name: string;
  startTime: string;
  endTime: string | null;
  operator: string;
  deviceIds: string[];
  recordCount: number;
}

export interface SessionInfo {
  id: string;
  name: string;
  startTime: string;
  endTime: string | null;
  deviceId: string;
  frameCount: number;
  fileSize: number;
  filePath: string;
  operator?: string;
  notes?: string;
  tags?: string[];
  deviceIds?: string[];
}

export interface ConnectDeviceRequest {
  portName: string;
  baudRate?: number;
  dataBits?: number;
  parity?: string;
  stopBits?: number;
  flowControl?: string;
  timeoutMs?: number;
}

export interface DeviceRuntimeStatusView {
  state: string;
  /** 操作员是否点过「启动控制系统」（后端 `RuntimeStatus::control_enabled`）。 */
  controlEnabled?: boolean;
  receivedFrames: number;
  protocolErrors: number;
  sentCommands: number;
  pendingCommands: number;
  reconnectAttempts: number;
  lastFrameMs: number;
  lastCommandMs: number;
  commandHighWatermark: number;
  emergencyLatched: boolean;
  lastError?: string | null;
  lastErrorCode?: string | null;
}

export interface DiagnosticsSummary {
  storedFrames: number;
  liveCapacity: number;
  totalFrames: number;
  droppedFrames: number;
  frameRateHz: number;
  deviceCount: number;
  pendingCommands: number;
  sentCommands: number;
  protocolErrors: number;
  reconnectAttempts: number;
  emergencyLatched: boolean;
  lastError?: string | null;
}

/** 与后端 `fetch_live_latest` 返回对应：最新一帧 + 环形缓冲统计。 */
export interface LiveLatest {
  selectedDeviceId: string;
  latest: DeviceSnapshot | null;
  stats: {
    storedFrames: number;
    capacity: number;
    totalFrames: number;
    droppedFrames: number;
    frameRateHz: number;
  };
}

/** 曲线数据结构（`fetch_live_window` / 历史会话 → `chartsFromFrames`）。 */
export interface ChartSection {
  windowSize: number;
  timestamps: number[];
  channels: Array<{
    name: string;
    unit: string;
    channelType: string;
    channelIndex: number;
    points: number[];
  }>;
}

export type CycleLifePhase =
  | "idle"
  | "movingUpper"
  | "holdingUpper"
  | "movingLower"
  | "holdingLower"
  | "complete"
  | "stopped";

export interface PidConfig {
  kp: number;
  ki: number;
  kd: number;
  deadbandCurvaturePerM: number;
  integralLimit: number;
  outputLimit: number;
  samplePeriodMs: number;
}

export interface CycleLifeConfig {
  enabled: boolean;
  lowerCurvaturePerM: number;
  upperCurvaturePerM: number;
  toleranceCurvaturePerM: number;
  dwellMs: number;
  maxCycles: number;
}

export interface ControlRuntimeStatus {
  pid: PidConfig;
  cycle: CycleLifeConfig;
  phase: CycleLifePhase;
  active: boolean;
  allowed: boolean;
  reason?: string | null;
  targetCurvaturePerM: number;
  pidOutput: number;
  motorDeltaMm: number;
  cyclesCompleted: number;
}

export interface AuthSession {
  authenticated: boolean;
  username: string;
  role: Role;
  permissions: Permission[];
  mustChangePassword: boolean;
}

export interface UserAccount {
  username: string;
  role: Role;
  disabled: boolean;
  mustChangePassword: boolean;
  /** 自助注册后等待管理员审批。为 true 时不能登录。 */
  pending: boolean;
  /** 允许同时在线的设备台数，0 = 不限。后台可按账号收紧。 */
  maxDevices: number;
}

/** 自助注册开关。默认 `approval`：注册后需管理员审批。 */
export type RegistrationMode = "closed" | "approval" | "open";

/** 后台「设备访问」列表的一行：一台已登录的设备。 */
export interface ClientSessionView {
  /** token 前缀。踢下线用它定位，后端不下发完整 token。 */
  sessionId: string;
  username: string;
  role: Role;
  label: string;
  clientId: string;
  ip: string;
  userAgent: string;
  createdAtMs: number;
  lastSeenMs: number;
  online: boolean;
}

/**
 * `login` 的返回值。
 *
 * token 由桥接桩写进 localStorage 并随每次请求带回，页面只接管 `session` ——
 * 页面不需要知道传输层凭据的存在。
 */
export interface LoginResult {
  token: string;
  session: AuthSession;
  deviceLimit: number;
  activeDevices: number;
}

export interface RecorderStatus {
  active: boolean;
  sessionId: string;
  sessionName: string;
  frameCount: number;
  elapsedSecs: number;
  paused: boolean;
}

export interface PlaybackState {
  activeSessionId: string;
  speed: number;
  cursorMs: number;
  durationMs: number;
  sessions: SessionEntry[];
}

export interface PlaybackStatus {
  active: boolean;
  sessionId: string;
  playing: boolean;
  speed: number;
  cursorMs: number;
  durationMs: number;
  cursorPct: number;
  totalFrames: number;
  currentFrameIdx: number;
}

export interface CalibrationStep {
  id: number;
  label: string;
  done: boolean;
  active: boolean;
}

export interface CalibrationState {
  selectedSection: "section1" | "section2";
  targetAngles: [number, number];
  captured: boolean;
  steps: CalibrationStep[];
}

export interface DashboardState {
  deviceCount: number;
  connectedDevices: number;
  currentSession: string;
  sampleRateHz: number;
  frameRateHz: number;
  activeProfile: string;
  lastError: string | null;
}

export interface SettingsState {
  theme: ThemeMode;
  workspaceDensity: "comfortable" | "dense";
  saveLayoutOnExit: boolean;
  autoReconnect: boolean;
  diagnosticsLevel: "info" | "debug";
  dataDirectory: string;
  modelDirectory: string;
}

export interface AppInfo {
  name: string;
  version: string;
  backend: string;
  frontend: string;
  platform: string;
}

export interface RuntimeSnapshot {
  appInfo: AppInfo;
  theme: ThemeMode;
  connection: {
    state: ConnectionState;
    activeProfileId: string;
    activeProfileName: string;
    profiles: ConnectionProfile[];
    ports: string[];
    handshakeStep: string;
    handshakeProgress: number;
    lastMessage: string;
  };
  dashboard: DashboardState;
  live: {
    selectedDeviceId: string;
    latest: DeviceSnapshot | null;
  };
  model: ModelProfile;
  calibration: CalibrationState;
  playback: PlaybackState;
  playbackMode: boolean;
  controlProfiles: ControlProfile[];
  filterProfiles: FilterProfile[];
  logs: LogEntry[];
  settings: SettingsState;
  runtimeDiagnostics: DiagnosticsSummary;
  controlRuntime: ControlRuntimeStatus;
  authSession: AuthSession;
}
