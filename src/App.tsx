import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Fingerprint, CheckCircle2 } from "lucide-react";
import { HashRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";

import "./App.css";
import { pageTitles, routeToPage } from "./app/navigation";
import ConnectDialog from "./components/ConnectDialog";
import { AppFooter } from "./components/layout/AppFooter";
import { GlobalStatusBar } from "./components/layout/GlobalStatusBar";
import { SidebarNav } from "./components/layout/SidebarNav";
import PlaybackBar from "./components/PlaybackBar";
import { DashboardPage } from "./pages/DashboardPage";
import { LogsPage } from "./pages/LogsPage";
import { SettingsPage } from "./pages/SettingsPage";
import {
  WorkspacePage,
  type MotorCommandDraft,
  type SystemControlAction,
  type WorkspaceCommand,
  type WorkspaceCommandPayload,
} from "./pages/WorkspacePage";
import { resetLayout } from "./state/layoutStore";
import { applyTheme, writeThemePreference } from "./state/themeStore";
import { angleDegToCurvaturePerM, curvaturePerMToAngleDeg, DEFAULT_DYNAMICS_CONFIG } from "./dynamics/svcModel";

// 懒加载重型页面组件，避免启动时加载 Three.js / uPlot / tanstack-table
const ChartsPage = lazy(() => import("./charts"));
const SessionsPage = lazy(() => import("./pages/SessionsPage"));
import type {
  AuthSession,
  ConnectDeviceRequest,
  ConnectionProfile,
  DeviceConnectionRecord,
  DeviceRuntimeStatusView,
  LogEntry,
  LegacyMigrationPreview,
  LegacyMigrationReport,
  LiveLatest,
  PlaybackStatus,
  RecorderStatus,
  Role,
  RuntimeSnapshot,
  SerialPortDescriptor,
  SessionInfo,
  ThemeMode,
  UserAccount,
} from "./softuiTypes";

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
      pid: { kp: 0, ki: 0, kd: 0, deadbandCurvaturePerM: 0, integralLimit: 0, outputLimit: 0, samplePeriodMs: 0 },
      cycle: { enabled: false, lowerCurvaturePerM: 0, upperCurvaturePerM: 0, toleranceCurvaturePerM: 0, dwellMs: 0, maxCycles: 0 },
      phase: "idle",
      active: false,
      allowed: false,
      reason: "",
      targetCurvaturePerM: 0,
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

  // 全局急停锁存：任一已连接设备锁存即视为全局锁存。
  const latchedDeviceIds = useMemo(
    () => Object.entries(deviceStatuses)
      .filter(([, status]) => status.emergencyLatched)
      .map(([deviceId]) => deviceId),
    [deviceStatuses],
  );
  const emergencyLatched = snapshot.runtimeDiagnostics.emergencyLatched || latchedDeviceIds.length > 0;

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

  const openConnectDialog = useCallback(() => {
    setConnectionError(null);
    setConnectDialogOpen(true);
  }, []);

  // 把权威主题落到 <html data-theme>，供 styles/*.css 的 token 使用。
  useEffect(() => {
    applyTheme(snapshot.theme);
  }, [snapshot.theme]);

  // 新壳层不再有全局标题栏，页面标题落到窗口标题上。
  useEffect(() => {
    document.title = `${pageTitles[currentPage]} · SoftUI 上位机`;
  }, [currentPage]);

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

  // 清掉持久化的卡片布局，下次进入页面会回落到默认布局。
  const resetLayouts = useCallback(() => {
    const username = snapshot.authSession.username || "default";
    resetLayout(username, "dashboard");
    resetLayout(username, "workspace-monitor");
  }, [snapshot.authSession.username]);

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
    writeThemePreference(snapshot.authSession.username, nextTheme);
    // 乐观落地：set_theme 要往返一次 IPC，不提前切换的话页面底色会滞后一拍。
    applyTheme(nextTheme);
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
  }, [snapshot.authSession.username, snapshot.theme]);

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
    const section1CommandCurvature = payload.section1CurvaturePerM ?? angleDegToCurvaturePerM(targetAngles[0], DEFAULT_DYNAMICS_CONFIG.segmentLengthM[0]);
    const section2CommandCurvature = payload.section2CurvaturePerM ?? angleDegToCurvaturePerM(targetAngles[1], DEFAULT_DYNAMICS_CONFIG.segmentLengthM[1]);
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
          // Legacy protocol boundary: hardware command still accepts bend angle, while UI/model uses curvature.
          angle1Deg: curvaturePerMToAngleDeg(section1CommandCurvature, DEFAULT_DYNAMICS_CONFIG.segmentLengthM[0]),
          direction2: payload.direction2 ?? 0,
          angle2Deg: curvaturePerMToAngleDeg(section2CommandCurvature, DEFAULT_DYNAMICS_CONFIG.segmentLengthM[1]),
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
      void import("./SVCCharts");
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
    <div className={`app-shell${sidebarCollapsed ? " is-sidebar-collapsed" : ""} theme-${snapshot.theme}`}>
      <SidebarNav
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((collapsed) => !collapsed)}
      />
      <GlobalStatusBar
        currentDeviceLabel={snapshot.live.selectedDeviceId || "未选择设备"}
        connectionLabel={snapshot.connection.state}
        currentUserLabel={snapshot.authSession.username}
        systemEnabled={snapshot.live.latest === null ? null : snapshot.live.latest.systemEnabled}
        recording={recorderStatus.active}
        emergencyLatched={emergencyLatched}
        theme={snapshot.theme}
        onEmergencyStop={() => void submitSystemControl("emergencyStop")}
        onToggleTheme={() => void toggleTheme()}
        onLogout={() => void logoutUser()}
      />

      <main className="app-content">
        <div className="app-page-content">
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

          <Suspense fallback={<div className="page-loading">加载中...</div>}>
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route
              path="/dashboard"
              element={
                <DashboardPage
                  snapshot={snapshot}
                  connectedDevices={connectedDevices}
                  deviceStatuses={deviceStatuses}
                  recorderStatus={recorderStatus}
                  sessions={sessions}
                />
              }
            />
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
                  onOpenConnectDialog={openConnectDialog}
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
            <Route path="/logs" element={<LogsPage snapshot={snapshot} onExportDiagnostics={exportDiagnostics} />} />
            <Route
              path="/settings"
              element={
                <SettingsPage
                  snapshot={snapshot}
                  users={users}
                  recorderStatus={recorderStatus}
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
                  onResetLayouts={resetLayouts}
                />
              }
            />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
          </Suspense>

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

      <AppFooter
        items={[
          `采样 ${snapshot.dashboard.sampleRateHz} Hz`,
          `帧率 ${snapshot.dashboard.frameRateHz} fps`,
          `命令队列 ${snapshot.runtimeDiagnostics.pendingCommands}`,
          `存储帧 ${snapshot.runtimeDiagnostics.storedFrames}/${snapshot.runtimeDiagnostics.liveCapacity}`,
        ]}
      />
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
