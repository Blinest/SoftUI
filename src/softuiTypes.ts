export type ChartChannelType = "motor" | "bend" | "sensor";

export type ThemeMode = "dark" | "light";

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

export interface SensorState {
  id: number;
  raw: [number, number, number];
  filtered: [number, number, number];
  alias: [string, string, string];
  unit: string;
  quality: FrameQuality;
}

export interface BendState {
  angleDeg: number;
  targetAngleDeg: number;
  direction: "up" | "right" | "down" | "left";
  quality: FrameQuality;
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
  deadbandDeg: number;
  integralLimit: number;
  outputLimit: number;
  samplePeriodMs: number;
}

export interface CycleLifeConfig {
  enabled: boolean;
  lowerAngleDeg: number;
  upperAngleDeg: number;
  toleranceDeg: number;
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
  targetAngleDeg: number;
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
}

export interface LegacyMigrationPreview {
  sourceDir: string;
  targetDir: string;
  exists: boolean;
  userFiles: number;
  configFiles: number;
  csvFiles: number;
  logFiles: number;
  skippedFiles: number;
  warnings: string[];
}

export interface LegacyMigrationReport {
  preview: LegacyMigrationPreview;
  copiedFiles: number;
  reportPath: string;
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
    frames: DeviceSnapshot[];
  };
  charts: {
    windowSize: number;
    channels: Array<{
      name: string;
      unit: string;
      channelType: string;
      channelIndex: number;
      points: number[];
    }>;
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
