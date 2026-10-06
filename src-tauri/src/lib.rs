pub mod auth;
pub mod control;
pub mod device;
pub mod dynamics;
pub mod kappatable;
pub mod live;
pub mod migration;
pub mod model;
pub mod playback;
pub mod posetable;
pub mod profiles;
pub mod protocol;
pub mod session;
pub mod storage;
pub mod tablecore;
pub mod transport;

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
#[cfg(feature = "desktop")]
use tauri::{Manager, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    name: String,
    version: String,
    backend: String,
    frontend: String,
    platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ThemeMode {
    Dark,
    Light,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ConnectionState {
    Idle,
    Connecting,
    Handshaking,
    Ready,
    Disabled,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum FrameQuality {
    Ok,
    Warning,
    Invalid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum LogLevel {
    Info,
    Warn,
    Error,
    Debug,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MotorState {
    id: u32,
    position_mm: f64,
    velocity_mm_per_sec: f64,
    acceleration_mm_per_sec2: f64,
    running: bool,
    target_position_mm: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SensorState {
    id: u32,
    raw: [f64; 3],
    filtered: [f64; 3],
    alias: [String; 3],
    unit: String,
    quality: FrameQuality,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BendState {
    angle_deg: f64,
    target_angle_deg: f64,
    direction: String,
    quality: FrameQuality,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceSnapshot {
    device_id: String,
    connection_id: String,
    received_at_ms: u64,
    sequence: u64,
    protocol_version: String,
    system_enabled: bool,
    motors: Vec<MotorState>,
    sensors: Vec<SensorState>,
    bend: BendSnapshot,
    quality: FrameStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BendSnapshot {
    section1: BendState,
    section2: BendState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrameStatus {
    status: FrameQuality,
    latency_ms: u64,
    dropped_frames: u64,
    checksum_ok: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionProfile {
    id: String,
    name: String,
    port: String,
    baud_rate: u32,
    data_bits: u8,
    parity: String,
    stop_bits: u8,
    flow_control: String,
    auto_reconnect: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControlProfile {
    id: String,
    name: String,
    enabled: bool,
    cycle_life_enabled: bool,
    threshold_low: f64,
    threshold_high: f64,
    cycle_period_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilterProfile {
    id: String,
    name: String,
    enabled: bool,
    window_size: u32,
    exponential_alpha: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelProfile {
    id: String,
    name: String,
    model_path: String,
    section1_max_angle_deg: f64,
    section2_max_angle_deg: f64,
    section1_node: String,
    section2_node: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogEntry {
    id: u64,
    level: LogLevel,
    scope: String,
    message: String,
    timestamp_ms: u64,
    device_id: Option<String>,
    frame_hex: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionEntry {
    id: String,
    name: String,
    start_time: String,
    end_time: Option<String>,
    operator: String,
    device_ids: Vec<String>,
    record_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaybackState {
    active_session_id: String,
    speed: f64,
    cursor_ms: u64,
    duration_ms: u64,
    sessions: Vec<SessionEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalibrationStep {
    id: u32,
    label: String,
    done: bool,
    active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CalibrationState {
    selected_section: String,
    target_angles: [f64; 2],
    captured: bool,
    steps: Vec<CalibrationStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DashboardState {
    device_count: u32,
    connected_devices: u32,
    current_session: String,
    sample_rate_hz: u32,
    frame_rate_hz: u32,
    active_profile: String,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsState {
    theme: ThemeMode,
    workspace_density: String,
    save_layout_on_exit: bool,
    auto_reconnect: bool,
    diagnostics_level: String,
    data_directory: String,
    model_directory: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsSummary {
    stored_frames: usize,
    live_capacity: usize,
    total_frames: u64,
    dropped_frames: u64,
    frame_rate_hz: f64,
    device_count: usize,
    pending_commands: usize,
    sent_commands: u64,
    protocol_errors: u64,
    reconnect_attempts: u32,
    emergency_latched: bool,
    last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSnapshot {
    app_info: AppInfo,
    theme: ThemeMode,
    connection: ConnectionSection,
    dashboard: DashboardState,
    live: LiveSection,
    model: ModelProfile,
    calibration: CalibrationState,
    playback: PlaybackState,
    playback_mode: bool,
    control_profiles: Vec<ControlProfile>,
    filter_profiles: Vec<FilterProfile>,
    logs: Vec<LogEntry>,
    settings: SettingsState,
    runtime_diagnostics: DiagnosticsSummary,
    control_runtime: control::ControlStatus,
    auth_session: auth::AuthSession,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionSection {
    state: ConnectionState,
    active_profile_id: String,
    active_profile_name: String,
    profiles: Vec<ConnectionProfile>,
    ports: Vec<String>,
    handshake_step: String,
    handshake_progress: u8,
    last_message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LiveSection {
    selected_device_id: String,
    latest: Option<DeviceSnapshot>,
}

/// 轻量实时响应：最新一帧 + 环形缓冲统计，供非曲线页高频轮询。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveLatest {
    selected_device_id: String,
    latest: Option<DeviceSnapshot>,
    stats: live::FrameStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedState {
    theme: ThemeMode,
    connected: bool,
    active_profile_id: String,
    sequence: u64,
    logs: Vec<LogEntry>,
    settings: SettingsState,
    playback_cursor_ms: u64,
}

struct RuntimeStore {
    path: PathBuf,
    data: Mutex<PersistedState>,
}

impl RuntimeStore {
    fn load(path: PathBuf) -> Self {
        let data = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<PersistedState>(&raw).ok())
            .unwrap_or_else(default_persisted_state);

        Self {
            path,
            data: Mutex::new(data),
        }
    }

    fn snapshot(&self) -> RuntimeSnapshot {
        let data = self.data.lock().expect("runtime state poisoned");
        build_snapshot(&data)
    }

    fn mutate<F>(&self, mutator: F) -> RuntimeSnapshot
    where
        F: FnOnce(&mut PersistedState),
    {
        let mut data = self.data.lock().expect("runtime state poisoned");
        mutator(&mut data);
        let snapshot = build_snapshot(&data);
        let _ = self.persist_locked(&data);
        snapshot
    }

    fn persist_locked(&self, data: &PersistedState) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let raw = serde_json::to_string_pretty(data).map_err(|err| err.to_string())?;
        fs::write(&self.path, raw).map_err(|err| err.to_string())
    }
}

/// 组装一帧的**标定附加量** (写入录制 CSV 的尾部列)。
///
/// 三个来源:
///   * `tau_n`    ← `DynamicsOutput.tendon_forces_n`, 单位已是 N (见 dynamics.rs)
///   * `dl_mm`    ← 电机位置 = 丝位移 (电机行程即丝位移), 符号约定: 负 = 收丝
///   * `kappa`    ← `DynamicsOutput.curvature`, 从解算网格线性重采样到
///                  `CALIB_KAPPA_POINTS` 个**等弧长**点, 存体坐标 (kx, ky)
///
/// 解算结果缺失时返回全空行 —— 只记原始帧, 不让录制失败。
fn make_calib_row(
    frame: &DeviceSnapshot,
    out: Option<&dynamics::DynamicsOutput>,
) -> session::CalibRow {
    let mut row = session::CalibRow::default();

    // ── 实测张力: 优先用解算输出 (已做映射/滤波), 否则退回传感器 filtered 原值 ──
    if let Some(o) = out {
        for i in 0..6 {
            let v = o.tendon_forces_n[i];
            if v.is_finite() {
                row.tau_n[i] = Some(v);
            }
        }
    } else {
        for i in 0..6 {
            if let Some(s) = frame.sensors.get(i) {
                let v = s.filtered[0];
                if v.is_finite() {
                    row.tau_n[i] = Some(v);
                }
            }
        }
    }

    // ── 实测丝位移: 电机行程即丝位移 (motor id i ↔ cable i-1) ──
    for c in 0..6u32 {
        if let Some(m) = frame.motors.iter().find(|m| m.id == c + 1) {
            if m.position_mm.is_finite() {
                row.dl_mm[c as usize] = Some(m.position_mm);
            }
        }
    }

    // ── 沿臂曲率: 从解算网格线性重采样到 20 个等弧长点 ──
    if let Some(o) = out {
        let prof = &o.curvature;
        let n = prof.s_mm.len();
        if n >= 2 && prof.kx_per_m.len() == n && prof.ky_per_m.len() == n {
            let s0 = prof.s_mm[0];
            let s1 = prof.s_mm[n - 1];
            row.kappa.reserve(session::CALIB_KAPPA_POINTS);
            for k in 0..session::CALIB_KAPPA_POINTS {
                // 端点均匀铺满: k=0 -> s0, k=N-1 -> s1
                let t = if session::CALIB_KAPPA_POINTS > 1 {
                    k as f64 / (session::CALIB_KAPPA_POINTS - 1) as f64
                } else {
                    0.0
                };
                let s = s0 + t * (s1 - s0);
                row.kappa.push(sample_curve(prof, s));
            }
        }
    }
    row
}

/// 在弧长 s 处线性插值曲率 (kx, ky); 越界取端点。返回 None 表示该点无数值。
fn sample_curve(prof: &dynamics::CurvatureProfile, s: f64) -> Option<(f64, f64)> {
    let n = prof.s_mm.len();
    if n < 2 || !s.is_finite() {
        return None;
    }
    if s <= prof.s_mm[0] {
        return Some((prof.kx_per_m[0], prof.ky_per_m[0]));
    }
    if s >= prof.s_mm[n - 1] {
        return Some((prof.kx_per_m[n - 1], prof.ky_per_m[n - 1]));
    }
    // 解算网格是单调递增的, 二分找区间
    let mut lo = 0usize;
    let mut hi = n - 1;
    while hi - lo > 1 {
        let mid = (lo + hi) / 2;
        if prof.s_mm[mid] <= s {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    let span = prof.s_mm[hi] - prof.s_mm[lo];
    let w = if span.abs() < 1e-12 {
        0.0
    } else {
        (s - prof.s_mm[lo]) / span
    };
    let kx = prof.kx_per_m[lo] + w * (prof.kx_per_m[hi] - prof.kx_per_m[lo]);
    let ky = prof.ky_per_m[lo] + w * (prof.ky_per_m[hi] - prof.ky_per_m[lo]);
    if kx.is_finite() && ky.is_finite() {
        Some((kx, ky))
    } else {
        None
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn default_theme() -> ThemeMode {
    ThemeMode::Dark
}

fn default_settings() -> SettingsState {
    SettingsState {
        theme: default_theme(),
        workspace_density: "comfortable".to_string(),
        save_layout_on_exit: true,
        auto_reconnect: true,
        diagnostics_level: "info".to_string(),
        data_directory: "experiment_data".to_string(),
        model_directory: "resources/models".to_string(),
    }
}

fn default_persisted_state() -> PersistedState {
    PersistedState {
        theme: default_theme(),
        connected: true,
        active_profile_id: "sim-default".to_string(),
        sequence: 42,
        logs: vec![
            log_entry(
                1,
                LogLevel::Info,
                "boot",
                "SoftUI runtime ready",
                None,
                None,
            ),
            log_entry(
                2,
                LogLevel::Info,
                "connection",
                "Simulator handshake completed",
                Some("softui-sim-01"),
                None,
            ),
            log_entry(
                3,
                LogLevel::Warn,
                "device",
                "Using simulated transport until a serial port is selected",
                Some("softui-sim-01"),
                Some("BB 02 10 01 00 00 00 00 00 23"),
            ),
        ],
        settings: default_settings(),
        playback_cursor_ms: 18_000,
    }
}

fn log_entry(
    id: u64,
    level: LogLevel,
    scope: &str,
    message: &str,
    device_id: Option<&str>,
    frame_hex: Option<&str>,
) -> LogEntry {
    LogEntry {
        id,
        level,
        scope: scope.to_string(),
        message: message.to_string(),
        timestamp_ms: now_ms(),
        device_id: device_id.map(|value| value.to_string()),
        frame_hex: frame_hex.map(|value| value.to_string()),
    }
}

fn adapt_motor(id: u32, motor: &protocol::MotorData) -> MotorState {
    MotorState {
        id,
        position_mm: motor.position_mm,
        velocity_mm_per_sec: motor.velocity_mm_per_sec,
        acceleration_mm_per_sec2: motor.acceleration_mm_per_sec2,
        running: motor.status != 0,
        target_position_mm: motor.position_mm + 1.5,
    }
}

fn adapt_sensor(id: u32, sensor: &protocol::SensorData, seq: u64) -> SensorState {
    let raw = [sensor.x, sensor.y, sensor.z];
    let filtered = [raw[0] * 0.96, raw[1] * 0.95, raw[2] * 0.94];
    SensorState {
        id,
        raw,
        filtered,
        alias: ["X".to_string(), "Y".to_string(), "Z".to_string()],
        unit: "N".to_string(),
        quality: if seq % 15 == 0 {
            FrameQuality::Warning
        } else {
            FrameQuality::Ok
        },
    }
}

fn adapt_bend(angle_deg: f64, direction: &str, seq: u64) -> BendState {
    BendState {
        angle_deg,
        target_angle_deg: angle_deg + 4.0,
        direction: direction.to_string(),
        quality: if seq % 17 == 0 {
            FrameQuality::Warning
        } else {
            FrameQuality::Ok
        },
    }
}

fn make_frame(seq: u64, connected: bool) -> DeviceSnapshot {
    if !connected {
        // 未连接时直接生成最小帧，跳过模拟器 handshake
        let motors = (0..6)
            .map(|i| adapt_motor((i + 1) as u32, &protocol::MotorData {
                position_mm: 0.0, velocity_mm_per_sec: 0.0,
                acceleration_mm_per_sec2: 0.0, status: 0,
            }))
            .collect::<Vec<_>>();
        let sensors = (0..6)
            .map(|i| adapt_sensor((i + 1) as u32, &protocol::SensorData { x: 0.0, y: 0.0, z: 0.0 }, seq))
            .collect::<Vec<_>>();
        return DeviceSnapshot {
            device_id: "softui-sim-01".to_string(),
            connection_id: "conn-01".to_string(),
            received_at_ms: now_ms(),
            sequence: seq,
            protocol_version: "Legacy V1".to_string(),
            system_enabled: false,
            motors,
            sensors,
            bend: BendSnapshot {
                section1: adapt_bend(0.0, "up", seq),
                section2: adapt_bend(0.0, "right", seq),
            },
            quality: FrameStatus {
                status: FrameQuality::Warning,
                latency_ms: 52,
                dropped_frames: seq / 240,
                checksum_ok: true,
            },
        };
    }
    let simulator = transport::SimulatorTransport::with_seed(seq).expect("simulator should start");
    let mut runtime = device::DeviceRuntime::new(simulator);
    let status = runtime
        .handshake()
        .expect("simulated runtime should handshake");
    let quality = FrameQuality::Ok;
    let motors = status
        .motors
        .iter()
        .enumerate()
        .map(|(index, motor)| adapt_motor((index + 1) as u32, motor))
        .collect::<Vec<_>>();
    let sensors = status
        .sensors
        .iter()
        .enumerate()
        .map(|(index, sensor)| adapt_sensor((index + 1) as u32, sensor, seq))
        .collect::<Vec<_>>();
    DeviceSnapshot {
        device_id: "softui-sim-01".to_string(),
        connection_id: "conn-01".to_string(),
        received_at_ms: now_ms(),
        sequence: seq,
        protocol_version: "Legacy V1".to_string(),
        system_enabled: connected && status.system_state != 0,
        motors,
        sensors,
        bend: BendSnapshot {
            section1: adapt_bend(status.bend_angle1_deg, "up", seq),
            section2: adapt_bend(status.bend_angle2_deg, "right", seq),
        },
        quality: FrameStatus {
            status: quality,
            latency_ms: 18,
            dropped_frames: seq / 240,
            checksum_ok: true,
        },
    }
}

fn make_device_frame(
    record: &device::DeviceConnectionRecord,
    status: &protocol::DeviceStatus,
    runtime: &device::RuntimeStatus,
    seq: u64,
) -> DeviceSnapshot {
    let motors = status
        .motors
        .iter()
        .enumerate()
        .map(|(index, motor)| adapt_motor((index + 1) as u32, motor))
        .collect::<Vec<_>>();
    let sensors = status
        .sensors
        .iter()
        .enumerate()
        .map(|(index, sensor)| adapt_sensor((index + 1) as u32, sensor, seq))
        .collect::<Vec<_>>();

    DeviceSnapshot {
        device_id: record.device_id.clone(),
        connection_id: record.connection_id.clone(),
        received_at_ms: now_ms(),
        sequence: seq,
        protocol_version: "Legacy V1".to_string(),
        system_enabled: status.system_state != 0,
        motors,
        sensors,
        bend: BendSnapshot {
            section1: adapt_bend(status.bend_angle1_deg, "up", seq),
            section2: adapt_bend(status.bend_angle2_deg, "right", seq),
        },
        quality: FrameStatus {
            status: if runtime.protocol_errors == 0 {
                FrameQuality::Ok
            } else {
                FrameQuality::Warning
            },
            latency_ms: 0,
            dropped_frames: runtime.protocol_errors,
            checksum_ok: runtime.protocol_errors == 0,
        },
    }
}

fn overlay_live_frames(snapshot: &mut RuntimeSnapshot, live_frames: &[DeviceSnapshot]) {
    let Some(first) = live_frames.first() else {
        return;
    };

    snapshot.live.selected_device_id = first.device_id.clone();
    snapshot.live.latest = live_frames.first().cloned();
    snapshot.dashboard.device_count = live_frames.len() as u32;
    snapshot.dashboard.connected_devices = live_frames
        .iter()
        .filter(|frame| frame.system_enabled)
        .count() as u32;
    snapshot.dashboard.last_error = None;
    snapshot.connection.state = ConnectionState::Ready;
    snapshot.connection.active_profile_id = "serial-runtime".to_string();
    snapshot.connection.active_profile_name = "Serial runtime".to_string();
    snapshot.connection.handshake_step = "live serial frames".to_string();
    snapshot.connection.handshake_progress = 100;
    snapshot.connection.last_message = "Serial stream active".to_string();
}



fn empty_live_stats() -> live::FrameStats {
    live::FrameStats {
        stored_frames: 0,
        capacity: 0,
        total_frames: 0,
        dropped_frames: 0,
        frame_rate_hz: 0.0,
    }
}

fn diagnostics_summary(
    live_stats: &live::FrameStats,
    runtimes: &[(String, device::RuntimeStatus)],
) -> DiagnosticsSummary {
    DiagnosticsSummary {
        stored_frames: live_stats.stored_frames,
        live_capacity: live_stats.capacity,
        total_frames: live_stats.total_frames,
        dropped_frames: live_stats.dropped_frames,
        frame_rate_hz: live_stats.frame_rate_hz,
        device_count: runtimes.len(),
        pending_commands: runtimes
            .iter()
            .map(|(_, status)| status.pending_commands)
            .sum(),
        sent_commands: runtimes
            .iter()
            .map(|(_, status)| status.sent_commands)
            .sum(),
        protocol_errors: runtimes
            .iter()
            .map(|(_, status)| status.protocol_errors)
            .sum(),
        reconnect_attempts: runtimes
            .iter()
            .map(|(_, status)| status.reconnect_attempts)
            .sum(),
        emergency_latched: runtimes.iter().any(|(_, status)| status.emergency_latched),
        last_error: runtimes
            .iter()
            .rev()
            .find_map(|(_, status)| status.last_error.clone()),
    }
}

fn apply_diagnostics_summary(
    snapshot: &mut RuntimeSnapshot,
    live_stats: &live::FrameStats,
    runtimes: &[(String, device::RuntimeStatus)],
) {
    let summary = diagnostics_summary(live_stats, runtimes);
    snapshot.dashboard.frame_rate_hz = summary.frame_rate_hz.round() as u32;
    snapshot.dashboard.sample_rate_hz = summary.frame_rate_hz.round() as u32;
    if let Some(error) = &summary.last_error {
        snapshot.dashboard.last_error = Some(error.clone());
    }
    snapshot.runtime_diagnostics = summary;
}

fn make_connection_section(data: &PersistedState) -> ConnectionSection {
    let profiles = vec![
        ConnectionProfile {
            id: "sim-default".to_string(),
            name: "Simulator".to_string(),
            port: "SIM".to_string(),
            baud_rate: 115_200,
            data_bits: 8,
            parity: "none".to_string(),
            stop_bits: 1,
            flow_control: "none".to_string(),
            auto_reconnect: true,
        },
        ConnectionProfile {
            id: "serial-9600".to_string(),
            name: "Legacy USB".to_string(),
            port: "COM3".to_string(),
            baud_rate: 9_600,
            data_bits: 8,
            parity: "none".to_string(),
            stop_bits: 1,
            flow_control: "none".to_string(),
            auto_reconnect: false,
        },
    ];

    let active = profiles
        .iter()
        .find(|profile| profile.id == data.active_profile_id)
        .unwrap_or(&profiles[0]);

    ConnectionSection {
        state: if data.connected {
            ConnectionState::Ready
        } else {
            ConnectionState::Idle
        },
        active_profile_id: active.id.clone(),
        active_profile_name: active.name.clone(),
        profiles,
        ports: vec![
            "COM3".to_string(),
            "COM4".to_string(),
            "ttyUSB0".to_string(),
            "ttyACM0".to_string(),
        ],
        handshake_step: if data.connected {
            "frame verification".to_string()
        } else {
            "awaiting connection".to_string()
        },
        handshake_progress: if data.connected { 100 } else { 0 },
        last_message: if data.connected {
            "Simulator stream active".to_string()
        } else {
            "Connection paused".to_string()
        },
    }
}

fn make_control_profiles() -> Vec<ControlProfile> {
    vec![
        ControlProfile {
            id: "cycle-life".to_string(),
            name: "Cycle life".to_string(),
            enabled: true,
            cycle_life_enabled: true,
            threshold_low: 12.0,
            threshold_high: 48.0,
            cycle_period_ms: 1_250,
        },
        ControlProfile {
            id: "manual".to_string(),
            name: "Manual safe mode".to_string(),
            enabled: false,
            cycle_life_enabled: false,
            threshold_low: 8.0,
            threshold_high: 42.0,
            cycle_period_ms: 1_500,
        },
    ]
}

fn make_filter_profiles() -> Vec<FilterProfile> {
    vec![
        FilterProfile {
            id: "m3".to_string(),
            name: "Median 3".to_string(),
            enabled: true,
            window_size: 3,
            exponential_alpha: 0.45,
        },
        FilterProfile {
            id: "ema".to_string(),
            name: "EMA".to_string(),
            enabled: true,
            window_size: 5,
            exponential_alpha: 0.32,
        },
    ]
}

fn make_model_profile() -> ModelProfile {
    ModelProfile {
        id: "default-continuum".to_string(),
        name: "Default continuum robot".to_string(),
        model_path: "resources/models/default_robot.glb".to_string(),
        section1_max_angle_deg: 78.0,
        section2_max_angle_deg: 64.0,
        section1_node: "section_1_root".to_string(),
        section2_node: "section_2_root".to_string(),
    }
}

fn make_calibration_state(seq: u64, connected: bool) -> CalibrationState {
    let labels = [
        "Zero reference",
        "Upper segment",
        "Lower segment",
        "Positive bend",
        "Save profile",
    ];
    CalibrationState {
        selected_section: if seq % 2 == 0 {
            "section1".to_string()
        } else {
            "section2".to_string()
        },
        target_angles: [28.0 + (seq as f64 % 8.0), 22.0 + (seq as f64 % 6.0)],
        captured: connected && seq % 3 == 0,
        steps: labels
            .iter()
            .enumerate()
            .map(|(index, label)| CalibrationStep {
                id: (index + 1) as u32,
                label: (*label).to_string(),
                done: connected && index < 2,
                active: index == 0,
            })
            .collect(),
    }
}

fn make_playback_state(data: &PersistedState) -> PlaybackState {
    let sessions = vec![
        SessionEntry {
            id: "session-20260714-001".to_string(),
            name: "Bench verification".to_string(),
            start_time: "2026-07-14T09:15:00+08:00".to_string(),
            end_time: Some("2026-07-14T09:38:00+08:00".to_string()),
            operator: "research".to_string(),
            device_ids: vec!["softui-sim-01".to_string()],
            record_count: 18_420,
        },
        SessionEntry {
            id: "session-20260714-002".to_string(),
            name: "Closed-loop test".to_string(),
            start_time: "2026-07-14T11:20:00+08:00".to_string(),
            end_time: None,
            operator: "research".to_string(),
            device_ids: vec!["softui-sim-01".to_string()],
            record_count: 9_480,
        },
    ];

    PlaybackState {
        active_session_id: "session-20260714-002".to_string(),
        speed: 1.0,
        cursor_ms: data.playback_cursor_ms,
        duration_ms: 126_000,
        sessions,
    }
}

fn build_snapshot(data: &PersistedState) -> RuntimeSnapshot {
    let seq = data.sequence;
    let frame = make_frame(seq, data.connected);
    let app_info = AppInfo {
        name: "SoftUI".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        backend: "Rust + Tauri 2".to_string(),
        frontend: "React + TypeScript + Three.js".to_string(),
        platform: format!("{} / {}", std::env::consts::OS, std::env::consts::ARCH),
    };

    let logs = data.logs.iter().rev().cloned().take(24).collect::<Vec<_>>();
    let dashboard = DashboardState {
        device_count: 2,
        connected_devices: if data.connected { 1 } else { 0 },
        current_session: "session-20260714-002".to_string(),
        sample_rate_hz: 100,
        frame_rate_hz: if data.connected { 30 } else { 12 },
        active_profile: data.active_profile_id.clone(),
        last_error: if data.connected {
            None
        } else {
            Some("Simulator paused".to_string())
        },
    };

    RuntimeSnapshot {
        app_info,
        theme: data.theme.clone(),
        connection: make_connection_section(data),
        dashboard,
        live: LiveSection {
            selected_device_id: frame.device_id.clone(),
            latest: Some(frame),
        },
        model: make_model_profile(),
        calibration: make_calibration_state(seq, data.connected),
        playback: make_playback_state(data),
        playback_mode: false,
        control_profiles: make_control_profiles(),
        filter_profiles: make_filter_profiles(),
        logs,
        settings: data.settings.clone(),
        runtime_diagnostics: diagnostics_summary(&empty_live_stats(), &[]),
        control_runtime: control::ControlStatus::default(),
        auth_session: auth::AuthSession::default(),
    }
}

/* ── 请求上下文：把「这次请求属于哪台设备」从传输层带到命令层 ────────────
 * 为什么用线程局部：`run_server` 是**一个连接一个线程**，且一个请求的全部
 * 处理（含 `ui_wait` / `webserial_wait_tx` 这类挂起式长轮询）都在该线程内
 * 同步完成，所以"当前请求的 token"天然是线程私有的，不会串台。
 *
 * 这么做换来的好处很大：74 个命令函数的签名**一个字都不用改** ——
 * 它们照旧拿 `State<'_, AppState>`，而 `AppState::session()` 能解析出
 * 本设备自己的会话。若改成给每个命令加 token 参数，改动面会覆盖 74 处
 * 调用与 dispatch 分发，既啰嗦又容易漏。
 * ──────────────────────────────────────────────────────────────────── */
#[cfg(not(feature = "desktop"))]
mod request_ctx {
    use std::cell::RefCell;

    thread_local! {
        static TOKEN: RefCell<Option<String>> = const { RefCell::new(None) };
        static CLIENT_IP: RefCell<String> = const { RefCell::new(String::new()) };
        static USER_AGENT: RefCell<String> = const { RefCell::new(String::new()) };
    }

    pub fn set(token: Option<String>, client_ip: String, user_agent: String) {
        TOKEN.with(|slot| *slot.borrow_mut() = token);
        CLIENT_IP.with(|slot| *slot.borrow_mut() = client_ip);
        USER_AGENT.with(|slot| *slot.borrow_mut() = user_agent);
    }

    pub fn token() -> Option<String> {
        TOKEN.with(|slot| slot.borrow().clone())
    }

    pub fn client_ip() -> String {
        CLIENT_IP.with(|slot| slot.borrow().clone())
    }

    pub fn user_agent() -> String {
        USER_AGENT.with(|slot| slot.borrow().clone())
    }
}

/// 当前请求的设备信息（IP / UA），用于后台的「设备访问」列表。
fn request_meta() -> (String, String) {
    #[cfg(not(feature = "desktop"))]
    {
        (request_ctx::client_ip(), request_ctx::user_agent())
    }
    #[cfg(feature = "desktop")]
    {
        ("local".to_string(), "tauri-desktop".to_string())
    }
}

impl AppState {
    /// 解析「本次请求」所属的会话。
    ///
    /// - **server 模式**：按请求头里的 token 查会话；**没有 token 就是未登录**。
    ///   这里绝不能退回那份全局单会话，否则"一人登录、全体放行"会原样复现。
    /// - **桌面模式**：没有 token 概念，仍用那份进程内单会话（单机语义不变）。
    ///
    /// 注意 `resolve()` 会顺带刷新 `last_seen_ms`，而后台列表的「最近活动」
    /// 就来自它 —— 前端每 500ms 一次的 `bootstrap_state` 天然就是心跳，
    /// 不需要再开一条独立通道。
    fn session(&self) -> auth::AuthSession {
        #[cfg(not(feature = "desktop"))]
        {
            match request_ctx::token() {
                Some(token) => self
                    .sessions
                    .resolve(&token)
                    .unwrap_or_else(auth::AuthSession::signed_out),
                None => auth::AuthSession::signed_out(),
            }
        }
        #[cfg(feature = "desktop")]
        {
            self.local_session
                .lock()
                .map(|session| session.clone())
                .unwrap_or_else(|_| auth::AuthSession::signed_out())
        }
    }
}

struct AppState {
    store: RuntimeStore,
    profile_store: profiles::ProfileStore,
    devices: Arc<Mutex<device::DeviceRegistry>>,
    live_ring: Arc<Mutex<live::LiveDataRing>>,
    recorder: Arc<Mutex<session::SessionRecorder>>,
    playback: Arc<Mutex<playback::PlaybackEngine>>,
    control_runtime: Arc<Mutex<control::ControlRuntime>>,
    dynamics_runtime: Arc<Mutex<dynamics::DynamicsRuntime>>,
    /// 桌面单机模式的那份进程内会话。server 模式下**不使用**（改为按 token 的
    /// `sessions`），保留它只为让桌面版行为与改造前完全一致。
    #[cfg(feature = "desktop")]
    local_session: Arc<Mutex<auth::AuthSession>>,
    /// 按设备隔离的会话注册表：server 模式的主路径。
    sessions: auth::SessionStore,
    auth_store: auth::AuthStore,
    sqlite: storage::SqliteStore,
    worker_stop: Arc<AtomicBool>,
    last_synced_log_id: Arc<AtomicUsize>,
    last_log_sync_ms: Arc<AtomicUsize>,
}

impl AppState {
    pub fn new(path: PathBuf) -> Self {
        // 启动时**不再**自动播种模拟设备：模拟数据改由界面上的
        // 「模拟数据」按钮显式开启。自动播种会让"真实设备出问题"和
        // "本来就没设备"都悄悄变成"有数据"，操作员分不清真假。
        let devices = Arc::new(Mutex::new(device::DeviceRegistry::new()));
        let session_dir = path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("sessions");
        let profile_path = path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("connection-profiles.json");
        let auth_path = path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("auth-users.json");
        let sqlite_path = path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("softui.sqlite3");
        // 会话落盘：网关每次部署都要重启，不持久化的话所有端都得重新登录。
        let sessions_path = path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("sessions.json");
        Self {
            store: RuntimeStore::load(path),
            profile_store: profiles::ProfileStore::load(profile_path),
            devices,
            live_ring: Arc::new(Mutex::new(live::LiveDataRing::new(600))),
            recorder: Arc::new(Mutex::new(session::SessionRecorder::new(session_dir))),
            playback: Arc::new(Mutex::new(playback::PlaybackEngine::new())),
            control_runtime: Arc::new(Mutex::new(control::ControlRuntime::default())),
            dynamics_runtime: Arc::new(Mutex::new(dynamics::DynamicsRuntime::default())),
            #[cfg(feature = "desktop")]
            local_session: Arc::new(Mutex::new(auth::AuthSession::default())),
            sessions: auth::SessionStore::load(sessions_path),
            auth_store: auth::AuthStore::load(auth_path),
            sqlite: storage::SqliteStore::new(sqlite_path),
            worker_stop: Arc::new(AtomicBool::new(false)),
            last_synced_log_id: Arc::new(AtomicUsize::new(0)),
            last_log_sync_ms: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn snapshot(&self) -> RuntimeSnapshot {
        let mut snapshot = self.store.snapshot();
        // 日志落库节流：最多 1s 一次，避免 10Hz 热路径下高频 SQLite 写入。
        let now = now_ms();
        let last = self.last_log_sync_ms.load(Ordering::Relaxed) as u64;
        if now.saturating_sub(last) >= 1_000 {
            if self
                .last_log_sync_ms
                .compare_exchange(
                    last as usize,
                    now as usize,
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                )
                .is_ok()
            {
                self.sync_logs_to_sqlite();
            }
        }
        if let Ok(control) = self.control_runtime.lock() {
            snapshot.control_runtime = control.status();
        }
        // 会话必须按「本次请求的设备」解析，不能再用那份全局单会话。
        snapshot.auth_session = self.session();

        // 回放激活：用**回放帧**灌满快照，并跳过实时环。
        if let Ok(pb) = self.playback.lock() {
            if pb.status().active {
                // ⚠ 必须走 `overlay_live_frames`：设备工作区读数与曲线都由它填充。
                //   原来只手写 `live.latest` 然后直接 return —— 曲线/读数拿不到回放帧，
                //   表现就是「开始回放后，工作区和曲线还是实时数据（其实是空的）」。
                let window: Vec<DeviceSnapshot> =
                    pb.frame_window(240).into_iter().cloned().collect();
                let frame = window.last().cloned().or_else(|| pb.current_frame().cloned());
                if let Some(frame) = frame {
                    snapshot.playback_mode = true;
                    if let Ok(mut control) = self.control_runtime.lock() {
                        control.stop("playback mode blocks active control");
                        snapshot.control_runtime = control.status();
                    }
                    overlay_live_frames(&mut snapshot, &window);
                    snapshot.live.selected_device_id = frame.device_id.clone();
                    snapshot.live.latest = Some(frame.clone());
                    snapshot.dashboard.device_count = 1;
                    snapshot.dashboard.connected_devices = 1;
                    snapshot.dashboard.last_error = None;
                    snapshot.connection.state = ConnectionState::Ready;

                    return snapshot;
                }
            }
        }

        let mut live_stats = empty_live_stats();
        if let Ok(ring) = self.live_ring.lock() {
            live_stats = ring.stats();
            let live_frames = ring.latest_per_device();
            overlay_live_frames(&mut snapshot, &live_frames);
        }
        if let Ok(devices) = self.devices.lock() {
            let runtimes = devices.runtime_statuses();
            apply_diagnostics_summary(&mut snapshot, &live_stats, &runtimes);
        }
        snapshot
    }

    fn tick(&self) -> RuntimeSnapshot {
        let now = now_ms();

        // Advance playback cursor if playing
        if let Ok(mut pb) = self.playback.lock() {
            pb.tick(now);
        }

        // 轻量只读快照：不写盘、不写 SQLite、不构建曲线，
        // 保持 10Hz 高频轮询下没有落盘/序列化重负载。
        self.snapshot()
    }

    fn toggle_connection(&self) -> RuntimeSnapshot {
        let _ = self.store.mutate(|data| {
            data.connected = !data.connected;
            let level = if data.connected {
                LogLevel::Info
            } else {
                LogLevel::Warn
            };
            data.sequence = data.sequence.saturating_add(1);
            data.logs.push(log_entry(
                data.sequence,
                level,
                "connection",
                if data.connected {
                    "Connection resumed"
                } else {
                    "Connection paused"
                },
                Some("softui-sim-01"),
                None,
            ));
        });
        self.snapshot()
    }

    fn set_theme(&self, theme: ThemeMode) -> RuntimeSnapshot {
        let _ = self.store.mutate(|data| {
            data.theme = theme;
            data.settings.theme = data.theme.clone();
            data.sequence = data.sequence.saturating_add(1);
            data.logs.push(log_entry(
                data.sequence,
                LogLevel::Info,
                "settings",
                "Theme updated",
                None,
                None,
            ));
        });
        self.snapshot()
    }

    fn update_settings(&self, settings: SettingsState) -> RuntimeSnapshot {
        let _ = self.store.mutate(|data| {
            data.theme = settings.theme.clone();
            data.settings = settings;
            data.sequence = data.sequence.saturating_add(1);
            data.logs.push(log_entry(
                data.sequence,
                LogLevel::Info,
                "settings",
                "Settings updated",
                None,
                None,
            ));
        });
        self.snapshot()
    }

    /// 诊断包**内容**。只读、不落盘。
    ///
    /// 原来这里会往 `data/diagnostics/softui-diagnostics-*/` 写 5 个 JSON 文件并
    /// 返回目录路径 —— 于是每次导出都在服务器上留一份（容器磁盘本来就紧张），
    /// 用户还得进服务器把文件拷出来。现在只把内容返回给前端，由浏览器直接存文件。
    fn diagnostics_bundle(&self) -> serde_json::Value {
        let snapshot = self.snapshot();
        // 注意顺序：前四个是 clone，最后整体 move，避免 owner 被提前移走
        serde_json::json!({
            "appInfo": snapshot.app_info,
            "logs": snapshot.logs,
            "settings": snapshot.settings,
            "runtimeDiagnostics": snapshot.runtime_diagnostics,
            "snapshot": snapshot,
        })
    }

    /// 增量同步新增日志到 SQLite，避免每次全量重放（热路径下开销大）。
    /// 只同步 id 大于上次同步点的条目；`id` 为 0（引导期）时视为已入库跳过。
    /// 同时把内存日志裁剪到上限，防止只读快照路径下无限增长。
    fn sync_logs_to_sqlite(&self) {
        let logs = self
            .store
            .data
            .lock()
            .map(|mut data| {
                if data.logs.len() > 120 {
                    let drain = data.logs.len() - 120;
                    data.logs.drain(0..drain);
                }
                data.logs.clone()
            })
            .unwrap_or_default();
        let mut high_water = self.last_synced_log_id.load(Ordering::Relaxed);
        let mut dirty = false;
        for entry in logs {
            if entry.id == 0 || entry.id as usize <= high_water {
                continue;
            }
            let _ = self.sqlite.insert_log(&storage::LogRow {
                id: entry.id,
                timestamp_ms: entry.timestamp_ms,
                level: log_level_key(&entry.level).to_string(),
                scope: entry.scope,
                message: entry.message,
                device_id: entry.device_id,
                frame_hex: entry.frame_hex,
            });
            if entry.id as usize > high_water {
                high_water = entry.id as usize;
                dirty = true;
            }
        }
        if dirty {
            self.last_synced_log_id.store(high_water, Ordering::Relaxed);
        }
    }

    fn record_session_info(&self, info: &session::SessionInfo) {
        let _ = self.sqlite.upsert_session(&session_info_row(info, None));
    }
}

impl Drop for AppState {
    fn drop(&mut self) {
        self.worker_stop.store(true, Ordering::SeqCst);
        if let Ok(mut devices) = self.devices.lock() {
            devices.disconnect_all();
        }
    }
}

fn log_level_key(level: &LogLevel) -> &'static str {
    match level {
        LogLevel::Info => "info",
        LogLevel::Warn => "warn",
        LogLevel::Error => "error",
        LogLevel::Debug => "debug",
    }
}

fn session_info_row(
    info: &session::SessionInfo,
    operator_override: Option<String>,
) -> storage::SessionRow {
    storage::SessionRow {
        id: info.id.clone(),
        name: info.name.clone(),
        start_time: info.start_time.clone(),
        end_time: info.end_time.clone(),
        operator: operator_override.or_else(|| info.operator.clone()),
        notes: info.notes.clone(),
        tags_json: serde_json::to_string(&info.tags.clone().unwrap_or_default())
            .unwrap_or_else(|_| "[]".to_string()),
        device_ids_json: serde_json::to_string(&info.device_ids.clone().unwrap_or_default())
            .unwrap_or_else(|_| "[]".to_string()),
        record_count: info.frame_count,
        csv_path: info.file_path.clone(),
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectDeviceRequest {
    port_name: String,
    baud_rate: Option<u32>,
    data_bits: Option<u8>,
    parity: Option<String>,
    stop_bits: Option<u8>,
    flow_control: Option<String>,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum SystemControlActionRequest {
    Disable,
    Enable,
    EmergencyStop,
}

impl SystemControlActionRequest {
    fn protocol_action(&self) -> protocol::SystemControlAction {
        match self {
            Self::Disable => protocol::SystemControlAction::Disable,
            Self::Enable => protocol::SystemControlAction::Enable,
            Self::EmergencyStop => protocol::SystemControlAction::EmergencyStop,
        }
    }

    fn label(&self) -> &'static str {
        match self {
            Self::Disable => "control disabled",
            Self::Enable => "control enabled",
            Self::EmergencyStop => "emergency stop",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemControlRequest {
    device_id: Option<String>,
    action: SystemControlActionRequest,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MotorControlRequest {
    device_id: Option<String>,
    motor_id: u8,
    position_mm: f64,
    velocity_mm_per_sec: Option<f64>,
    acceleration_mm_per_sec2: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HomeCommandRequest {
    device_id: Option<String>,
    motor_count: Option<u8>,
    start_address: Option<u8>,
}

/// 多电机同步位移指令（0x04）请求体。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MultiMotorCommandRequest {
    device_id: Option<String>,
    /// 起始电机地址（1 基），默认 1
    start_address: Option<u8>,
    /// 各电机目标位移（mm，带符号）；下标 0 对应 `start_address`
    positions_mm: Vec<f64>,
}

/// 运行时导入的模型包：`(文件名, 表)`。为空时用内置默认。
static IMPORTED_MODEL: std::sync::OnceLock<
    std::sync::Mutex<Option<(String, std::sync::Arc<model::ModelTables>)>>,
> = std::sync::OnceLock::new();
static DEFAULT_MODEL: std::sync::OnceLock<std::sync::Arc<model::ModelTables>> = std::sync::OnceLock::new();

fn imported_slot() -> &'static std::sync::Mutex<Option<(String, std::sync::Arc<model::ModelTables>)>> {
    IMPORTED_MODEL.get_or_init(|| std::sync::Mutex::new(None))
}

/// 已导入模型的 Arc 快照（没有导入则为 `None`）。
fn imported_tables() -> Option<std::sync::Arc<model::ModelTables>> {
    imported_slot()
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|(_, tables)| std::sync::Arc::clone(tables)))
}

/// 持久化文件：与可执行文件同目录的 `model.tdcrmodel`。
fn persisted_model_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join("model.tdcrmodel"))
}

/// 从磁盘载入上次导入的模型包（没有或损坏则安静跳过）。
fn try_load_persisted_model() {
    let Some(path) = persisted_model_path() else { return };
    let Ok(bytes) = std::fs::read(&path) else { return };
    if let Ok(tables) = model::ModelTables::from_bundle(&bytes) {
        let name = path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("model.{}", model::EXTENSION));
        if let Ok(mut guard) = imported_slot().lock() {
            *guard = Some((name, std::sync::Arc::new(tables)));
        }
    }
}

/// 当前生效的模型表：导入的优先，否则内置默认。
fn current_model() -> std::sync::Arc<model::ModelTables> {
    if let Some(tables) = imported_tables() {
        return tables;
    }
    // 首次取用时尝试载入上次导入的模型包（每个进程只试一次）。
    static TRIED_PERSISTED: std::sync::Once = std::sync::Once::new();
    TRIED_PERSISTED.call_once(try_load_persisted_model);
    if let Some(tables) = imported_tables() {
        return tables;
    }
    std::sync::Arc::clone(
        DEFAULT_MODEL.get_or_init(|| std::sync::Arc::new(model::ModelTables::builtin())),
    )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelStatus {
    /// `builtin` 或 `imported`
    source: String,
    name: Option<String>,
    summary: String,
    bundle_bytes: usize,
    persisted_path: Option<String>,
    /// UI 侧运动范围上限（1/m）：当前生效模型 κ 表的覆盖边界，由表数据扫出。
    kappa_limit_per_m: f64,
}

fn model_status_of() -> ModelStatus {
    let imported = imported_slot()
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|(name, tables)| (name.clone(), tables.summary())));
    let (source, name, summary) = match imported {
        Some((name, summary)) => ("imported".to_string(), Some(name), summary),
        None => ("builtin".to_string(), None, current_model().summary()),
    };
    ModelStatus {
        source,
        name,
        summary,
        bundle_bytes: model::DEFAULT_BUNDLE.len(),
        persisted_path: persisted_model_path().map(|path| path.to_string_lossy().to_string()),
        kappa_limit_per_m: current_model().kappa_limit_per_m,
    }
}

/// 查询当前模型（只读）。
#[cfg_attr(feature = "desktop", tauri::command)]
fn model_status() -> ModelStatus {
    model_status_of()
}

/// 导入模型包（`.tdcrmodel`）。校验通过后写入可执行文件同目录并立即生效。
#[cfg_attr(feature = "desktop", tauri::command)]
fn import_model(bytes: Vec<u8>, name: Option<String>) -> Result<ModelStatus, String> {
    let tables = model::ModelTables::from_bundle(&bytes)
        .map_err(|error| format!("模型包无效：{error:?}"))?;
    let label = name.unwrap_or_else(|| format!("model.{}", model::EXTENSION));

    if let Some(path) = persisted_model_path() {
        std::fs::write(&path, &bytes).map_err(|error| format!("写入模型文件失败：{error}"))?;
    }
    if let Ok(mut guard) = imported_slot().lock() {
        *guard = Some((label, std::sync::Arc::new(tables)));
    }
    Ok(model_status_of())
}

/// 恢复内置默认模型（并删除已持久化的模型文件）。
#[cfg_attr(feature = "desktop", tauri::command)]
fn reset_model() -> Result<ModelStatus, String> {
    if let Ok(mut guard) = imported_slot().lock() {
        *guard = None;
    }
    if let Some(path) = persisted_model_path() {
        let _ = std::fs::remove_file(path);
    }
    Ok(model_status_of())
}

/// 只读的形状查询请求（3D 预览用，不下发）。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TipPoseShapeRequest {
    position_mm: [f64; 3],
    roll: f64,
    pitch: f64,
    yaw: f64,
    table_gauge_n: Option<u8>,
}

/// 表中最接近的真实形状（12 段 κx/κy）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TipPoseShapeResponse {
    nearest_distance: f64,
    covered: bool,
    degraded: bool,
    segment_count: usize,
    segment_length_mm: f64,
    total_length_mm: f64,
    kx_per_m: Vec<f64>,
    ky_per_m: Vec<f64>,
    kappa_abs_per_m: Vec<f64>,
    phi_rad: Vec<f64>,
    displacement_mm: Vec<f64>,
}

/// 末端位姿 → 表中最接近的**真实形状**（只读，供 3D 预览渲染）。
///
/// 取的是**最近表点的 0 阶形状**，不做插值：预览必须显示表里真实存在的解，
/// 否则会出现「预览一个形状、发下去另一个」。
#[cfg_attr(feature = "desktop", tauri::command)]
fn lookup_tip_pose_shape(request: TipPoseShapeRequest) -> Result<TipPoseShapeResponse, String> {
    let kind = match request.table_gauge_n.unwrap_or(60) {
        40 => posetable::PoseTableKind::Limit40n,
        _ => posetable::PoseTableKind::Limit60n,
    };
    let query = posetable::encode_rpy_mm(
        request.position_mm,
        request.roll,
        request.pitch,
        request.yaw,
    );
    let model_tables = current_model();
    let shape = model_tables
        .pose(kind)
        .lookup_shape(&query)
        .map_err(|error| format!("{error:?}"))?;

    let nodes = posetable::N_SHAPE_NODES;
    let mut kx_per_m = Vec::with_capacity(nodes);
    let mut ky_per_m = Vec::with_capacity(nodes);
    let mut kappa_abs_per_m = Vec::with_capacity(nodes);
    let mut phi_rad = Vec::with_capacity(nodes);
    for node in 0..nodes {
        let kx = shape.kappa[node * 2] as f64;
        let ky = shape.kappa[node * 2 + 1] as f64;
        kx_per_m.push(kx);
        ky_per_m.push(ky);
        kappa_abs_per_m.push((kx * kx + ky * ky).sqrt());
        phi_rad.push(ky.atan2(kx));
    }

    Ok(TipPoseShapeResponse {
        nearest_distance: shape.nearest_distance,
        covered: shape.covered,
        degraded: shape.degraded,
        segment_count: nodes,
        segment_length_mm: posetable::L_TOTAL_MM / nodes as f64,
        total_length_mm: posetable::L_TOTAL_MM,
        kx_per_m,
        ky_per_m,
        kappa_abs_per_m,
        phi_rad,
        displacement_mm: shape.displacement_mm.to_vec(),
    })
}
/// 末端位姿 → 0x04 多电机同步指令 的请求体（全阶 Cosserat 位姿查表）。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TipPoseCommandRequest {
    device_id: Option<String>,
    /// 起始电机地址（1 基），默认 1
    start_address: Option<u8>,
    /// 末端位置（mm）
    position_mm: [f64; 3],
    /// 末端姿态 roll / pitch / yaw（rad，ZYX 内旋）
    roll: f64,
    pitch: f64,
    yaw: f64,
    /// 查表档位 40 / 60，默认 60
    table_gauge_n: Option<u8>,
}

/// 曲率 → 6 肌腱位移 → 0x04 多电机同步指令 的请求体。
///
/// `segment_curvature_per_m` / `segment_direction_rad` 直接取自拖拽预览的
/// `BackboneOutput.segmentCurvaturePerM` / `segmentDirectionRad`。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CurvatureCommandRequest {
    device_id: Option<String>,
    /// 起始电机地址（1 基），默认 1
    start_address: Option<u8>,
    /// 两段曲率大小 κ（1/m）
    segment_curvature_per_m: [f64; 2],
    /// 两段弯曲方向 φ（rad）
    segment_direction_rad: [f64; 2],
    /// 全阶 Cosserat 查表档位：40 或 60（张力上限 N），默认 60
    table_gauge_n: Option<u8>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SensorCalibrationRequest {
    device_id: Option<String>,
    sensor_id: u8,
    calibration_value: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BendCommandRequest {
    device_id: Option<String>,
    direction1: u8,
    angle1_deg: f64,
    direction2: u8,
    angle2_deg: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveControlRequest {
    device_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CycleLifeStartRequest {
    config: Option<control::CycleLifeConfig>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CommandSafety {
    Connected,
    Enabled,
}

fn frame_hex(frame: &[u8]) -> String {
    frame
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}

fn send_frame_to_device(
    state: &State<'_, AppState>,
    device_id: &str,
    frame: &[u8],
    priority: device::CommandPriority,
) -> Result<(), String> {
    if !device_id.starts_with("serial:") {
        return Ok(());
    }

    let mut devices = state
        .devices
        .lock()
        .map_err(|_| "device registry poisoned".to_string())?;
    devices
        .send_command(device_id, frame, priority)
        .map_err(|error| format!("{error:?}"))?;
    Ok(())
}

fn runtime_allows_command(status: &device::RuntimeStatus, safety: CommandSafety) -> bool {
    if status.emergency_latched || status.state == device::DeviceConnectionState::EmergencyStopped {
        return false;
    }
    let connected = matches!(
        status.state,
        device::DeviceConnectionState::Ready | device::DeviceConnectionState::Enabled
    );
    match safety {
        CommandSafety::Connected => connected,
        CommandSafety::Enabled => {
            // 放行依据：操作员点过「启动控制系统」（`control_enabled`），或下位机状态帧自己
            // 报了 `system_state != 0`。只看状态帧是不够的 —— 下位机不回写时（STM32 的
            // CR.state 恒 0）按钮就永远发不出去，而操作员的使能意图是明确的。
            connected
                && (status.control_enabled
                    || status
                        .last_status
                        .as_ref()
                        .map(|latest| latest.system_state != 0)
                        .unwrap_or(false))
        }
    }
}

fn snapshot_allows_command(snapshot: &RuntimeSnapshot, safety: CommandSafety) -> bool {
    let connected = snapshot.connection.state == ConnectionState::Ready;
    match safety {
        CommandSafety::Connected => connected,
        CommandSafety::Enabled => {
            connected
                && snapshot
                    .live
                    .latest
                    .as_ref()
                    .map(|frame| frame.system_enabled)
                    .unwrap_or(false)
        }
    }
}

fn guard_command_allowed(
    state: &State<'_, AppState>,
    device_id: &str,
    safety: CommandSafety,
) -> Result<(), String> {
    let required_permission = match safety {
        CommandSafety::Connected => auth::Permission::ConnectDevice,
        CommandSafety::Enabled => auth::Permission::SendMotionCommand,
    };
    {
        let auth_session = state.session();
        auth::require_permission(&auth_session, required_permission)?;
    }

    if device_id.starts_with("serial:") {
        let devices = state
            .devices
            .lock()
            .map_err(|_| "device registry poisoned".to_string())?;
        let runtime = devices
            .runtime_status(device_id)
            .map_err(|error| format!("{error:?}"))?;
        if runtime_allows_command(&runtime, safety) {
            return Ok(());
        }
    } else if snapshot_allows_command(&state.snapshot(), safety) {
        return Ok(());
    }

    let message = match safety {
        CommandSafety::Connected => "设备未连接或未就绪：请先在左栏连接设备并等待状态帧",
        CommandSafety::Enabled => {
            "设备未使能，运动指令被拒绝：请先到「自动控制 → 系统操作」点「启动控制系统」再下发"
        }
    };
    record_control_failure(state, device_id, message);
    Err(message.to_string())
}

fn selected_device_id(device_id: Option<String>) -> String {
    device_id.unwrap_or_else(|| "softui-sim-01".to_string())
}

fn guard_permission(
    state: &State<'_, AppState>,
    permission: auth::Permission,
) -> Result<(), String> {
    let auth_session = state.session();
    auth::require_permission(&auth_session, permission)
}

fn current_username(state: &State<'_, AppState>) -> Option<String> {
    let session = state.session();
    if session.authenticated {
        Some(session.username)
    } else {
        None
    }
}

/// 记录一次**被拒绝/失败**的控制指令。
///
/// 为什么需要它：成功的指令会留下 `* command sent` 记录，失败的**什么都没有** —— 前端可能只
/// 显示一句「命令失败」，现场就只能猜是没使能、曲率超表还是串口问题。把原因同时写进
/// Logs 页与 `softui-state.json`，排查时直接看日志即可。
fn record_control_failure(state: &State<'_, AppState>, device_id: &str, message: &str) {
    let message = format!("指令被拒绝：{message}");
    let _ = state.store.mutate(|data| {
        data.sequence = data.sequence.saturating_add(1);
        data.logs.push(log_entry(
            data.sequence,
            LogLevel::Warn,
            "control",
            &message,
            Some(device_id),
            None,
        ));
    });
}

fn record_control_command<T: Serialize>(
    state: &State<'_, AppState>,
    device_id: &str,
    command: &str,
    frame_hex: &str,
    payload: &T,
) {
    // 录制中：指令同步写进会话 sidecar，回放时才能复盘「控制指令变化」。
    if let Ok(mut recorder) = state.recorder.lock() {
        recorder.record_command(now_ms(), command.to_string(), frame_hex.to_string());
    }

    let username = current_username(state);
    let _ = state.sqlite.insert_control_command(
        now_ms(),
        username.as_deref(),
        device_id,
        command,
        frame_hex,
        payload,
    );
}

fn audit_control_frame(
    state: State<'_, AppState>,
    device_id: String,
    message: &'static str,
    frame: Vec<u8>,
    safety: CommandSafety,
) -> Result<RuntimeSnapshot, String> {
    guard_command_allowed(&state, &device_id, safety)?;
    send_frame_to_device(&state, &device_id, &frame, device::CommandPriority::Normal)?;
    let frame_hex = frame_hex(&frame);
    record_control_command(
        &state,
        &device_id,
        message,
        &frame_hex,
        &serde_json::json!({ "message": message }),
    );
    // ⚠ 不能把 `store.mutate()` 的返回值直接当快照发回前端：
    //   `build_snapshot()` 里 `auth_session` 固定是 `AuthSession::default()`（未登录），
    //   前端拿到后会立刻跳回登录页。`AppState::snapshot()` 才负责把 auth / 控制运行态 /
    //   实时环 / 诊断摘要填齐。下面三处命令返回值都遵循这一条。
    state.store.mutate(|data| {
        data.sequence = data.sequence.saturating_add(1);
        data.logs.push(log_entry(
            data.sequence,
            LogLevel::Info,
            "control",
            message,
            Some(&device_id),
            Some(&frame_hex),
        ));
    });
    Ok(state.snapshot())
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn app_info() -> AppInfo {
    AppInfo {
        name: "SoftUI".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        backend: "Rust + Tauri 2".to_string(),
        frontend: "React + TypeScript + Three.js".to_string(),
        platform: format!("{} / {}", std::env::consts::OS, std::env::consts::ARCH),
    }
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn current_auth_session(state: State<'_, AppState>) -> Result<auth::AuthSession, String> {
    // 按 token 解析：每台设备拿到的是**自己**的会话，不再共用同一份。
    Ok(state.session())
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn login(
    state: State<'_, AppState>,
    request: auth::LoginRequest,
) -> Result<auth::LoginResult, String> {
    let username = request.username.trim().to_string();
    let client_id = request
        .client_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown-device")
        .to_string();
    let label = request
        .label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("未命名设备")
        .to_string();

    // 设备数上限：这就是后台「管理设备的访问」可调的那一档。
    // 达到上限时**直接拒绝**，而不是悄悄顶掉别人的会话 —— 否则现场就会
    // "用着用着突然被踢下线"，却不知道是谁干的。
    let limit = state.auth_store.max_devices(&username);
    if limit > 0 {
        let active = state.sessions.active_count_for_user(&username) as u32;
        if active >= limit {
            return Err(format!(
                "该账号已达到 {limit} 台设备在线上限（当前 {active} 台）。\
                 请在其它设备上退出，或让管理员在「后台管理 → 设备访问」里踢下线。"
            ));
        }
    }

    let session = state.auth_store.login(request)?;
    let (ip, user_agent) = request_meta();
    let token = state.sessions.create(&session, client_id, label, ip, user_agent)?;

    // 桌面模式同步刷新那份单会话，保持单机语义不变
    #[cfg(feature = "desktop")]
    {
        if let Ok(mut local) = state.local_session.lock() {
            *local = session.clone();
        }
    }

    state.store.mutate(|data| {
        data.sequence = data.sequence.saturating_add(1);
        data.logs.push(log_entry(
            data.sequence,
            LogLevel::Info,
            "auth",
            "User logged in",
            Some(&session.username),
            None,
        ));
    });

    let active_devices = state.sessions.active_count_for_user(&session.username) as u32;
    Ok(auth::LoginResult {
        token,
        session,
        device_limit: limit,
        active_devices,
    })
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn logout(state: State<'_, AppState>) -> Result<auth::AuthSession, String> {
    let previous = state.session().username.clone();
    // server：只踢掉**本设备**这一条会话，其它设备照常使用
    #[cfg(not(feature = "desktop"))]
    {
        if let Some(token) = request_ctx::token() {
            let _ = state.sessions.revoke(&token);
        }
    }
    // 桌面：清空那份单会话
    #[cfg(feature = "desktop")]
    {
        if let Ok(mut local) = state.local_session.lock() {
            *local = auth::AuthSession::signed_out();
        }
    }
    state.store.mutate(|data| {
        data.sequence = data.sequence.saturating_add(1);
        data.logs.push(log_entry(
            data.sequence,
            LogLevel::Info,
            "auth",
            "User logged out",
            Some(&previous),
            None,
        ));
    });
    Ok(auth::AuthSession::signed_out())
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn list_users(state: State<'_, AppState>) -> Result<Vec<auth::UserAccount>, String> {
    guard_permission(&state, auth::Permission::ManageUsers)?;
    Ok(state.auth_store.list_users())
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn create_user(
    state: State<'_, AppState>,
    request: auth::CreateUserRequest,
) -> Result<auth::UserAccount, String> {
    guard_permission(&state, auth::Permission::ManageUsers)?;
    let account = state.auth_store.create_user(request)?;
    let username = account.username.clone();
    state.store.mutate(|data| {
        data.sequence = data.sequence.saturating_add(1);
        data.logs.push(log_entry(
            data.sequence,
            LogLevel::Info,
            "auth",
            "User created",
            Some(&username),
            None,
        ));
    });
    Ok(account)
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn change_password(
    state: State<'_, AppState>,
    request: auth::ChangePasswordRequest,
) -> Result<(), String> {
    let auth_session = state.session();
    let target_username = request
        .username
        .clone()
        .unwrap_or_else(|| auth_session.username.clone());
    state.auth_store.change_password(&auth_session, request)?;

    // 会话记录才是 `must_change_password` 的真源，改密成功要同步清掉。
    state.sessions.mark_password_changed(&target_username);
    // 管理员重置**别人**密码时，把那个账号的所有设备踢下线：
    // 否则旧口令签发出去的 token 还能继续用，重置就形同虚设。
    if target_username != auth_session.username {
        state.sessions.revoke_user(&target_username);
    }
    // 桌面模式那份单会话也要同步，不然界面还停在"必须改密"页
    #[cfg(feature = "desktop")]
    if target_username == auth_session.username {
        if let Ok(mut local) = state.local_session.lock() {
            local.must_change_password = false;
        }
    }
    state.store.mutate(|data| {
        data.sequence = data.sequence.saturating_add(1);
        data.logs.push(log_entry(
            data.sequence,
            LogLevel::Info,
            "auth",
            "Password changed",
            Some(&auth_session.username),
            None,
        ));
    });
    Ok(())
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn set_user_disabled(
    state: State<'_, AppState>,
    username: String,
    disabled: bool,
) -> Result<auth::UserAccount, String> {
    guard_permission(&state, auth::Permission::ManageUsers)?;
    let account = state.auth_store.set_disabled(username, disabled)?;
    // 禁用账号必须连带踢掉它所有设备上的会话。否则"禁用"只挡住了**下一次**
    // 登录，已经登录的端会一直用到 token 过期（7 天）为止。
    if disabled {
        state.sessions.revoke_user(&account.username);
    }
    let log_username = account.username.clone();
    state.store.mutate(|data| {
        data.sequence = data.sequence.saturating_add(1);
        data.logs.push(log_entry(
            data.sequence,
            LogLevel::Warn,
            "auth",
            if disabled {
                "User disabled"
            } else {
                "User enabled"
            },
            Some(&log_username),
            None,
        ));
    });
    Ok(account)
}

/* ── 后台管理：设备访问控制 ───────────────────────────────────────────
 * 部署实录「已知问题 1」的根治部分。下面四个命令是**后台管理页唯一的写入面**，
 * 全部要求 `ManageUsers` 权限（只有 Admin 角色有），所以非管理员连列表都看不到。
 * ──────────────────────────────────────────────────────────────────── */

/// 当前持有会话的设备列表（在线的排前面，其次按最近活动倒序）。
#[cfg_attr(feature = "desktop", tauri::command)]
fn list_clients(state: State<'_, AppState>) -> Result<Vec<auth::ClientSessionView>, String> {
    guard_permission(&state, auth::Permission::ManageUsers)?;
    Ok(state.sessions.list())
}

/// 按 `session_id`（token 前缀）踢掉**一台**设备。
#[cfg_attr(feature = "desktop", tauri::command)]
fn revoke_client(state: State<'_, AppState>, session_id: String) -> Result<usize, String> {
    guard_permission(&state, auth::Permission::ManageUsers)?;
    let removed = state.sessions.revoke(&session_id)?;
    state.store.mutate(|data| {
        data.sequence = data.sequence.saturating_add(1);
        data.logs.push(log_entry(
            data.sequence,
            LogLevel::Warn,
            "auth",
            "Client session revoked",
            Some(&session_id),
            None,
        ));
    });
    Ok(removed)
}

/// 踢掉某个账号的**全部**设备。
#[cfg_attr(feature = "desktop", tauri::command)]
fn revoke_user_sessions(state: State<'_, AppState>, username: String) -> Result<usize, String> {
    guard_permission(&state, auth::Permission::ManageUsers)?;
    let removed = state.sessions.revoke_user(&username);
    state.store.mutate(|data| {
        data.sequence = data.sequence.saturating_add(1);
        data.logs.push(log_entry(
            data.sequence,
            LogLevel::Warn,
            "auth",
            "All sessions of user revoked",
            Some(&username),
            None,
        ));
    });
    Ok(removed)
}

/// 设置账号允许同时在线的设备台数（0 = 不限）。
#[cfg_attr(feature = "desktop", tauri::command)]
fn set_user_device_limit(
    state: State<'_, AppState>,
    username: String,
    max_devices: u32,
) -> Result<auth::UserAccount, String> {
    guard_permission(&state, auth::Permission::ManageUsers)?;
    state.auth_store.set_max_devices(&username, max_devices)
}

/* ── 自助注册 ─────────────────────────────────────────────────────────
 * 注册是**匿名**入口（要求登录就没法注册了），所以这里不加权限校验。
 * 安全性由三件事保证：
 *   1) 注册开关（关闭 / 待审批 / 直接通过）
 *   2) 匿名限流 —— 按**客户端 IP**，按用户名限流换名就绕过了
 *   3) 默认"待管理员审批"，审批前连登录都过不了
 * ──────────────────────────────────────────────────────────────────── */

/// 当前注册开关。登录页用它决定是否显示「注册」入口。
#[cfg_attr(feature = "desktop", tauri::command)]
fn registration_mode(state: State<'_, AppState>) -> auth::RegistrationMode {
    state.auth_store.registration_mode()
}

/// 自助注册。成功后账号处于「待审批」，需管理员在后台通过。
#[cfg_attr(feature = "desktop", tauri::command)]
fn register(
    state: State<'_, AppState>,
    request: auth::RegisterRequest,
) -> Result<auth::UserAccount, String> {
    let (ip, _) = request_meta();
    let client_key = if ip.trim().is_empty() {
        "unknown".to_string()
    } else {
        ip
    };
    let account = state.auth_store.register(request, &client_key)?;
    let username = account.username.clone();
    let pending = account.pending;
    state.store.mutate(|data| {
        data.sequence = data.sequence.saturating_add(1);
        data.logs.push(log_entry(
            data.sequence,
            LogLevel::Info,
            "auth",
            if pending {
                "Self registration pending approval"
            } else {
                "Self registration"
            },
            Some(&username),
            None,
        ));
    });
    Ok(account)
}

/// 自助：查看**本账号**在哪些设备上登录着（前台「我的账号」用）。
#[cfg_attr(feature = "desktop", tauri::command)]
fn list_my_sessions(state: State<'_, AppState>) -> Result<Vec<auth::ClientSessionView>, String> {
    let session = state.session();
    if !session.authenticated {
        return Err("请先登录".to_string());
    }
    Ok(state.sessions.list_for_user(&session.username))
}

/// 自助：把**本账号**的某台设备踢下线（例如在别人电脑上忘了退出）。
/// 只要求"已登录"，不要求管理员权限；归属校验在 `revoke_owned` 里。
#[cfg_attr(feature = "desktop", tauri::command)]
fn revoke_my_session(state: State<'_, AppState>, session_id: String) -> Result<usize, String> {
    let session = state.session();
    if !session.authenticated {
        return Err("请先登录".to_string());
    }
    state.sessions.revoke_owned(&session_id, &session.username)
}

/// 修改账号角色。改动会**立即**同步到该账号已登录的设备上。
#[cfg_attr(feature = "desktop", tauri::command)]
fn set_user_role(
    state: State<'_, AppState>,
    username: String,
    role: auth::Role,
) -> Result<auth::UserAccount, String> {
    guard_permission(&state, auth::Permission::ManageUsers)?;
    let account = state.auth_store.set_role(&username, role)?;
    // 关键：光改用户表不够，还得刷已登录会话里的角色快照，
    // 否则被降级的人会拿旧角色一直用到会话过期。
    let updated_sessions = state.sessions.update_role(&account.username, role);
    let note = format!("{} -> {:?}（同步 {} 条会话）", account.username, role, updated_sessions);
    state.store.mutate(|data| {
        data.sequence = data.sequence.saturating_add(1);
        data.logs.push(log_entry(
            data.sequence,
            LogLevel::Warn,
            "auth",
            "User role changed",
            Some(&note),
            None,
        ));
    });
    Ok(account)
}

/// 删除账号：连同它所有设备上的会话一起清掉。
#[cfg_attr(feature = "desktop", tauri::command)]
fn delete_user(state: State<'_, AppState>, username: String) -> Result<(), String> {
    guard_permission(&state, auth::Permission::ManageUsers)?;
    // 不能删掉自己：会话还活着但账号没了，会留下一个状态诡异的"幽灵登录"
    if state.session().username == username {
        return Err("不能删除当前正在登录的账号".to_string());
    }
    state.auth_store.delete_user(&username)?;
    // 账号没了，token 也必须立刻失效，否则旧凭证还能继续用
    state.sessions.revoke_user(&username);
    state.store.mutate(|data| {
        data.sequence = data.sequence.saturating_add(1);
        data.logs.push(log_entry(
            data.sequence,
            LogLevel::Warn,
            "auth",
            "User deleted",
            Some(&username),
            None,
        ));
    });
    Ok(())
}

/// 管理员审批通过某个待审批账号。
#[cfg_attr(feature = "desktop", tauri::command)]
fn approve_user(
    state: State<'_, AppState>,
    username: String,
) -> Result<auth::UserAccount, String> {
    guard_permission(&state, auth::Permission::ManageUsers)?;
    let account = state.auth_store.approve(&username)?;
    let log_username = account.username.clone();
    state.store.mutate(|data| {
        data.sequence = data.sequence.saturating_add(1);
        data.logs.push(log_entry(
            data.sequence,
            LogLevel::Info,
            "auth",
            "User approved",
            Some(&log_username),
            None,
        ));
    });
    Ok(account)
}

/// 待审批人数：后台首页要显示，管理员才知道有没有人排队。
#[cfg_attr(feature = "desktop", tauri::command)]
fn pending_user_count(state: State<'_, AppState>) -> Result<usize, String> {
    guard_permission(&state, auth::Permission::ManageUsers)?;
    Ok(state.auth_store.pending_count())
}

/// 设置注册开关（关闭 / 待审批 / 直接通过）。
#[cfg_attr(feature = "desktop", tauri::command)]
fn set_registration_mode(
    state: State<'_, AppState>,
    mode: auth::RegistrationMode,
) -> Result<auth::RegistrationMode, String> {
    guard_permission(&state, auth::Permission::ManageUsers)?;
    let applied = state.auth_store.set_registration_mode(mode)?;
    state.store.mutate(|data| {
        data.sequence = data.sequence.saturating_add(1);
        data.logs.push(log_entry(
            data.sequence,
            LogLevel::Warn,
            "auth",
            "Registration mode changed",
            Some(&format!("{applied:?}")),
            None,
        ));
    });
    Ok(applied)
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn bootstrap_state(state: State<'_, AppState>) -> RuntimeSnapshot {
    state.snapshot()
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn tick_snapshot(state: State<'_, AppState>) -> RuntimeSnapshot {
    state.tick()
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn toggle_connection(state: State<'_, AppState>) -> RuntimeSnapshot {
    state.toggle_connection()
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn set_theme(state: State<'_, AppState>, theme: ThemeMode) -> RuntimeSnapshot {
    state.set_theme(theme)
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn update_settings(
    state: State<'_, AppState>,
    settings: SettingsState,
) -> Result<RuntimeSnapshot, String> {
    guard_permission(&state, auth::Permission::ManageSettings)?;
    Ok(state.update_settings(settings))
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn diagnostics_bundle(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    guard_permission(&state, auth::Permission::ViewDiagnostics)?;
    Ok(state.diagnostics_bundle())
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn preview_legacy_migration(
    state: State<'_, AppState>,
    source_dir: String,
    target_dir: Option<String>,
) -> Result<migration::LegacyMigrationPreview, String> {
    guard_permission(&state, auth::Permission::ManageSettings)?;
    let target = target_dir.map(PathBuf::from).unwrap_or_else(|| {
        state
            .store
            .path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("legacy-migrations")
    });
    Ok(migration::preview_legacy_migration(
        PathBuf::from(source_dir),
        target,
    ))
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn run_legacy_migration(
    state: State<'_, AppState>,
    source_dir: String,
    target_dir: Option<String>,
) -> Result<migration::LegacyMigrationReport, String> {
    guard_permission(&state, auth::Permission::ManageSettings)?;
    let target = target_dir.map(PathBuf::from).unwrap_or_else(|| {
        state
            .store
            .path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("legacy-migrations")
    });
    let report = migration::run_legacy_migration(PathBuf::from(source_dir), target)?;
    let report_path = report.report_path.clone();
    state.store.mutate(|data| {
        data.sequence = data.sequence.saturating_add(1);
        data.logs.push(log_entry(
            data.sequence,
            LogLevel::Info,
            "migration",
            "Legacy data migration completed",
            Some(&report_path),
            None,
        ));
    });
    Ok(report)
}

/* ── Web Serial 桥接命令 ─────────────────────────────────────────────
 * 前端用浏览器的 Web Serial 打开**用户本机**串口，把原始字节推给后端；
 * 后端把要下发的命令排进 tx 等前端来取。协议解析全部留在 Rust。
 * ─────────────────────────────────────────────────────────────────── */

/// 每端口的接收序号水位，用于给 `webserial_push` 去重。
///
/// 前端失败会带**同一个 seq** 重试；这里按 seq 忽略重复到达，
/// 重试因此是安全的 —— 既不会丢字节，也不会把同一块喂两遍给解码器。
#[cfg(not(feature = "desktop"))]
#[derive(Default)]
struct WsMeta {
    last_seq: u64,
    gaps: u64,
    duplicates: u64,
}

#[cfg(not(feature = "desktop"))]
fn ws_meta() -> &'static Mutex<std::collections::HashMap<String, WsMeta>> {
    static META: std::sync::OnceLock<Mutex<std::collections::HashMap<String, WsMeta>>> =
        std::sync::OnceLock::new();
    META.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

static WS_BUFFERS: std::sync::OnceLock<
    Mutex<std::collections::HashMap<String, (transport::WsRx, transport::WsTx)>>,
> = std::sync::OnceLock::new();

fn ws_buffers(
) -> &'static Mutex<std::collections::HashMap<String, (transport::WsRx, transport::WsTx)>> {
    WS_BUFFERS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/* ── 多端同步 ────────────────────────────────────────────────────────
 * 数据和设备状态本来就集中在 Rust 进程里（环形缓冲、设备表、录制、动力学），
 * 所以"多端看到同一份数据"是天然成立的。这一层补的是另外两件事：
 *   1. 有哪些端在线、各自停在哪一页
 *   2. 把 UI 动作（切页）广播给其它端，实现"一端操作、多端跟随"
 *
 * 只做轮询，不引入长连接：现有前端本来就是轮询模型，1 秒一次足够。
 * ─────────────────────────────────────────────────────────────────── */

/* ── 拖动实时同步 ────────────────────────────────────────────────────
 * 三维拖动编辑的目标形状只存在于**发起端的 React 状态**里，从来没进过后端，
 * 所以别的端看不到（实测：手机端拖动，电脑端毫无反应）。
 *
 * 为什么不用 sync_emit 的事件队列：拖动是 20~50 Hz 的连续流，
 * 走事件队列会把 100 条缓冲瞬间冲满，而且每个端都要回放几十条旧值。
 * 这里只需要"最新值"：单槽存储 + 带序号，谁需要谁高频来取。
 * ─────────────────────────────────────────────────────────────────── */

/* ── 通用 UI 状态同步通道 ────────────────────────────────────────────
 * 前端状态（拖动目标、末端位姿草稿、电机草稿…）原来各自只活在安装它的
 * 浏览器里，别的端无从得知。每加一个功能就接一根线不可维护，
 * 所以这里做**按键单槽**：
 *   - key 决定是哪个状态（"drag" / "tip" / "motor"…）
 *   - 每个 key 只保留最新值 + 序号，不需要事件队列（拖动是 20~50Hz 连续流）
 *   - 客户端按 key 的序号判断"有没有新值"，且跳过自己写的那份，天然防回环
 * 新增一个同步状态只需换一个 key，后端不用改。
 * ─────────────────────────────────────────────────────────────────── */

#[cfg(not(feature = "desktop"))]
#[derive(Default, Clone)]
struct UiEntry {
    payload: serde_json::Value,
    from: String,
    seq: u64,
    at_ms: u64,
}

#[cfg(not(feature = "desktop"))]
#[derive(Default)]
struct UiSyncState {
    seq: u64,
    entries: std::collections::HashMap<String, UiEntry>,
}

#[cfg(not(feature = "desktop"))]
static UI_SYNC: std::sync::OnceLock<Mutex<UiSyncState>> = std::sync::OnceLock::new();

#[cfg(not(feature = "desktop"))]
fn ui_sync_lock() -> &'static Mutex<UiSyncState> {
    UI_SYNC.get_or_init(|| Mutex::new(UiSyncState::default()))
}

#[cfg(not(feature = "desktop"))]
fn ui_cv() -> &'static (Mutex<()>, std::sync::Condvar) {
    static CV: std::sync::OnceLock<(Mutex<()>, std::sync::Condvar)> = std::sync::OnceLock::new();
    CV.get_or_init(|| (Mutex::new(()), std::sync::Condvar::new()))
}

/// 长轮询：有新值立刻返回，没有就挂到超时（默认 20 秒）。
///
/// 这一条替代了原来 1 秒一次的 `ui_state` 轮询 —— 接收侧的延迟从
/// "最多等一个轮询周期 + 一次往返"降到"一次单程"。
/// 为什么不直接上 WebSocket：本场景的瓶颈是"接收要等轮询"和"发送排队"，
/// 长轮询 + 有限并发发送就能拿到绝大部分收益，而 WS 要自己实现握手
/// （SHA-1 / base64）、帧编解码和广播，且一旦写错会直接打断现有推送。
#[cfg(not(feature = "desktop"))]
fn ui_wait(since: u64, timeout_ms: u64) -> Result<serde_json::Value, String> {
    let (lock, cv) = ui_cv();
    let mut guard = lock.lock().map_err(|_| "ui wait poisoned".to_string())?;
    let deadline = std::time::Instant::now()
        + std::time::Duration::from_millis(timeout_ms.clamp(1_000, 30_000));
    loop {
        let current = ui_sync_lock()
            .lock()
            .map_err(|_| "ui sync poisoned".to_string())?
            .seq;
        if current > since {
            break;
        }
        let now = std::time::Instant::now();
        if now >= deadline {
            break;
        }
        let (next_guard, _timed_out) = cv
            .wait_timeout(guard, deadline - now)
            .map_err(|_| "ui wait poisoned".to_string())?;
        guard = next_guard;
    }
    drop(guard);
    ui_snapshot()
}

/// 设备接入/断开时往 UI 同步通道塞一个事件，让所有端**立刻**拉一次。
///
/// 不广播的话，别的端只能等自己的轮询周期（设备列表 1s、实时帧 500ms），
/// 这段时间里界面还停在旧设备上，看起来就是"接入后没同步"。
#[cfg(not(feature = "desktop"))]
fn notify_device_change() {
    let _ = ui_publish(
        "server".to_string(),
        "deviceChange".to_string(),
        serde_json::json!(now_ms()),
    );
}

#[cfg(feature = "desktop")]
fn notify_device_change() {}

/* 关于"槽位要不要过期"的最终结论：**一律不过期**。
 *
 * 我在这里先后错过两次：
 *   ① 一刀切 30 秒过期 → 新设备拉不到末端位姿、PID 等持久设置
 *   ② 只让 drag 5 秒过期 → 新设备拉不到拖动目标，臂体停在初始形状
 *
 * 根因是我想当然地把 dragTarget 当成了"一次进行中的拖动"。它不是 ——
 * 这个应用里 dragTarget 是**持久状态**：松手后依然存在，要靠「清空目标」
 * 按钮或关掉「拖动编辑」才清掉，两者都会显式发布 null。
 *
 * 所以过期机制本身就是多余的：每个键都有明确的清空路径，
 * 客户端崩溃留下的陈旧值也与"用户上次设的目标"在语义上一致。
 * 真需要清理时，由客户端显式发布 null 即可。
 */

#[cfg(not(feature = "desktop"))]
fn ui_publish(client_id: String, key: String, payload: serde_json::Value) -> Result<u64, String> {
    let mut state = ui_sync_lock().lock().map_err(|_| "ui sync poisoned".to_string())?;
    state.seq = state.seq.saturating_add(1);
    let seq = state.seq;
    state.entries.insert(
        key,
        UiEntry { payload, from: client_id, seq, at_ms: now_ms() },
    );
    drop(state);
    // 唤醒所有挂着的长轮询：新值到了，立刻推出去
    ui_cv().1.notify_all();
    Ok(seq)
}

#[cfg(not(feature = "desktop"))]
fn ui_snapshot() -> Result<serde_json::Value, String> {
    let state = ui_sync_lock().lock().map_err(|_| "ui sync poisoned".to_string())?;
    let now = now_ms();
    let mut entries = serde_json::Map::new();
    for (key, entry) in state.entries.iter() {
        // 不过期：保证新加入的端一定能拿到当前完整状态（见上面的说明）。
        entries.insert(
            key.clone(),
            serde_json::json!({
                "payload": entry.payload,
                "from": entry.from,
                "seq": entry.seq,
                "ageMs": now.saturating_sub(entry.at_ms),
            }),
        );
    }
    Ok(serde_json::json!({ "seq": state.seq, "entries": entries }))
}

#[cfg(not(feature = "desktop"))]
#[derive(Default)]
struct DragState {
    seq: u64,
    from: Option<String>,
    payload: serde_json::Value,
    at_ms: u64,
}

#[cfg(not(feature = "desktop"))]
static DRAG: std::sync::OnceLock<Mutex<DragState>> = std::sync::OnceLock::new();

#[cfg(not(feature = "desktop"))]
fn drag_state() -> &'static Mutex<DragState> {
    DRAG.get_or_init(|| Mutex::new(DragState::default()))
}

#[cfg(not(feature = "desktop"))]
fn drag_publish(client_id: String, payload: serde_json::Value) -> Result<u64, String> {
    let mut state = drag_state().lock().map_err(|_| "drag poisoned".to_string())?;
    state.seq = state.seq.saturating_add(1);
    state.from = Some(client_id);
    state.payload = payload;
    state.at_ms = now_ms();
    Ok(state.seq)
}

#[cfg(not(feature = "desktop"))]
fn drag_latest() -> Result<serde_json::Value, String> {
    let state = drag_state().lock().map_err(|_| "drag poisoned".to_string())?;
    // 超过 5 秒没更新就当作拖动已结束，避免别的端卡在最后一帧预览上
    let stale = state.at_ms == 0 || now_ms().saturating_sub(state.at_ms) > 5_000;
    Ok(serde_json::json!({
        "seq": state.seq,
        "from": state.from,
        "ageMs": if state.at_ms == 0 { 0 } else { now_ms().saturating_sub(state.at_ms) },
        "payload": if stale { serde_json::Value::Null } else { state.payload.clone() },
    }))
}

#[cfg(not(feature = "desktop"))]
#[derive(Default)]
struct SyncState {
    /// (client_id, label, page, last_seen_ms)
    clients: Vec<(String, String, String, u64)>,
    /// (seq, event)
    events: Vec<(u64, serde_json::Value)>,
    seq: u64,
    /// 当前掌握串口的那一端。手机端据此显示"数据来自谁"。
    source_id: Option<String>,
}

#[cfg(not(feature = "desktop"))]
static SYNC: std::sync::OnceLock<Mutex<SyncState>> = std::sync::OnceLock::new();

#[cfg(not(feature = "desktop"))]
fn sync_state() -> &'static Mutex<SyncState> {
    SYNC.get_or_init(|| Mutex::new(SyncState::default()))
}

#[cfg(not(feature = "desktop"))]
fn sync_prune(state: &mut SyncState) {
    let now = now_ms();
    // 15 秒没心跳就当作下线，避免刷新页面后留下幽灵端
    state.clients.retain(|client| now.saturating_sub(client.3) < 15_000);
}

#[cfg(not(feature = "desktop"))]
fn sync_touch(state: &mut SyncState, client_id: &str, label: &str, page: &str) {
    let now = now_ms();
    if let Some(client) = state.clients.iter_mut().find(|c| c.0 == client_id) {
        client.1 = label.to_string();
        if !page.is_empty() {
            client.2 = page.to_string();
        }
        client.3 = now;
    } else {
        state
            .clients
            .push((client_id.to_string(), label.to_string(), page.to_string(), now));
    }
}

#[cfg(not(feature = "desktop"))]
fn sync_set_source(client_id: Option<String>) {
    if let Ok(mut state) = sync_state().lock() {
        state.source_id = client_id;
    }
}

#[cfg(not(feature = "desktop"))]
fn sync_hello(client_id: String, label: String) -> Result<u64, String> {
    let mut state = sync_state().lock().map_err(|_| "sync poisoned".to_string())?;
    sync_prune(&mut state);
    sync_touch(&mut state, &client_id, &label, "");
    Ok(state.seq)
}

#[cfg(not(feature = "desktop"))]
fn sync_poll(
    client_id: String,
    label: String,
    page: String,
    since: u64,
) -> Result<serde_json::Value, String> {
    let mut state = sync_state().lock().map_err(|_| "sync poisoned".to_string())?;
    sync_prune(&mut state);
    sync_touch(&mut state, &client_id, &label, &page);

    let clients: Vec<serde_json::Value> = state
        .clients
        .iter()
        .map(|(id, label, page, last_seen)| {
            serde_json::json!({
                "clientId": id,
                "label": label,
                "page": page,
                "ageMs": now_ms().saturating_sub(*last_seen),
                "self": *id == client_id,
            })
        })
        .collect();
    let events: Vec<serde_json::Value> = state
        .events
        .iter()
        .filter(|(seq, _)| *seq > since)
        .map(|(_, event)| event.clone())
        .collect();

    let source = match &state.source_id {
        Some(id) => {
            let label = state
                .clients
                .iter()
                .find(|client| client.0 == *id)
                .map(|client| client.1.clone())
                .unwrap_or_default();
            serde_json::json!({ "clientId": id, "label": label, "self": *id == client_id })
        }
        None => serde_json::Value::Null,
    };

    Ok(serde_json::json!({
        "seq": state.seq,
        "clients": clients,
        "events": events,
        "source": source,
    }))
}

#[cfg(not(feature = "desktop"))]
fn sync_emit(client_id: String, mut event: serde_json::Value) -> Result<u64, String> {
    let mut state = sync_state().lock().map_err(|_| "sync poisoned".to_string())?;
    sync_prune(&mut state);
    // 来源由后端盖章，不信前端传的，避免自回环判断被伪造
    if let serde_json::Value::Object(ref mut map) = event {
        map.insert("from".to_string(), serde_json::Value::String(client_id));
    }
    state.seq = state.seq.saturating_add(1);
    let seq = state.seq;
    state.events.push((seq, event));
    // 只留最近 100 条，防止长期运行内存增长
    while state.events.len() > 100 {
        state.events.remove(0);
    }
    Ok(seq)
}

/* ── 模拟数据开关 ────────────────────────────────────────────────────
 * 显式开关，替代原来的"自动补回"。按钮在界面右下角的运行状态徽标上。
 * ─────────────────────────────────────────────────────────────────── */

/* ── 前端解析后的帧直接灌入 ──────────────────────────────────────────
 * P1 的核心接口：串口字节由**拥有串口的那台浏览器**自己解析，只把解析好的
 * DeviceSnapshot 按低频（10Hz 左右）送上来。
 *
 * 为什么不再送原始字节：实测那条路的代价是"下行 0.8 MB/s + 上行原始字节"，
 * 而且字节一旦在链路上被截断就整帧校验失败（曾出现 131 错 / 43 好帧）。
 * 解析放在本机后，本机渲染零往返；这里只负责让**其它端和录制**照旧能看到数据。
 *
 * 后处理逻辑与 spawn_device_poller 里的逐条一致（动力学 / 控制 / 录制 / 环形缓冲）。
 * ⚠ 两份实现目前是重复的，抽成共用函数需要动轮询线程（风险更高），留作后续重构。
 * ─────────────────────────────────────────────────────────────────── */

#[cfg_attr(feature = "desktop", tauri::command)]
fn frame_ingest(state: State<'_, AppState>, frame: DeviceSnapshot) -> Result<u64, String> {
    let sequence = frame.sequence;

    let runtime = {
        let devices = state
            .devices
            .lock()
            .map_err(|_| "device registry poisoned".to_string())?;
        if !devices.list().iter().any(|r| r.device_id == frame.device_id) {
            return Err(format!("未知设备：{}", frame.device_id));
        }
        devices
            .runtime_status(&frame.device_id)
            .map_err(|error| format!("{error:?}"))?
    };

    let is_playback = state
        .playback
        .lock()
        .map(|p| p.status().active)
        .unwrap_or(false);

    let dynamics_result = state
        .dynamics_runtime
        .lock()
        .map_err(|_| "dynamics poisoned".to_string())
        .and_then(|mut dynamics| dynamics.step_frame(&frame, 50).map_err(|e| format!("{e:?}")))
        .ok();

    if let Ok(mut control) = state.control_runtime.lock() {
        let safety = control::SafetyInput {
            connected: matches!(
                runtime.state,
                device::DeviceConnectionState::Ready | device::DeviceConnectionState::Enabled
            ),
            enabled: frame.system_enabled,
            emergency_latched: runtime.emergency_latched,
            playback_mode: is_playback,
        };
        let dynamics_input = dynamics::dynamics_input_from_frame(&frame, 50);
        let feedback = control::ControlFeedback {
            target_curvature_per_m: dynamics_input
                .sections
                .first()
                .map(|section| section.curvature_per_m)
                .unwrap_or(0.0),
            dynamics_input,
            dynamics_output: dynamics_result.clone(),
            pressure: frame
                .sensors
                .first()
                .map(|sensor| sensor.filtered[2])
                .unwrap_or(0.0),
        };
        control.step_cycle(feedback, safety, 50);
    }

    if !is_playback {
        if let Ok(mut recorder) = state.recorder.lock() {
            let rec_status = recorder.status();
            recorder.write_frame_calib(&frame, &make_calib_row(&frame, dynamics_result.as_ref()));
            if rec_status.active && !rec_status.paused {
                let _ = state.sqlite.insert_snapshot(
                    &rec_status.session_id,
                    frame.sequence,
                    frame.received_at_ms,
                    &frame.device_id,
                    &frame,
                );
                if let Some(output) = &dynamics_result {
                    let _ = state.sqlite.insert_dynamics_output(
                        &rec_status.session_id,
                        frame.sequence,
                        frame.received_at_ms,
                        &frame.device_id,
                        output,
                    );
                }
            }
        }
    }

    if let Ok(mut ring) = state.live_ring.lock() {
        ring.push(frame);
    }
    Ok(sequence)
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn simulator_start(state: State<'_, AppState>) -> Result<bool, String> {
    let mut devices = state
        .devices
        .lock()
        .map_err(|_| "device registry poisoned".to_string())?;
    if devices.has_simulator() {
        return Ok(true);
    }
    devices
        .seed_simulator()
        .map_err(|error| format!("{error:?}"))?;
    drop(devices);
    notify_device_change();
    Ok(true)
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn simulator_stop(state: State<'_, AppState>) -> Result<bool, String> {
    let mut devices = state
        .devices
        .lock()
        .map_err(|_| "device registry poisoned".to_string())?;
    devices.remove_simulator();
    drop(devices);
    if let Ok(mut ring) = state.live_ring.lock() {
        ring.clear(); // 别让模拟帧留在缓冲里冒充真实数据
    }
    notify_device_change();
    Ok(false)
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn webserial_open(
    state: State<'_, AppState>,
    port_name: String,
    baud_rate: Option<u32>,
    device_name: Option<String>,
    client_id: Option<String>,
) -> Result<device::DeviceConnectionRecord, String> {
    let (rx, tx) = {
        let mut map = ws_buffers()
            .lock()
            .map_err(|_| "webserial buffer poisoned".to_string())?;
        map.remove(&port_name);
        let rx: transport::WsRx = Arc::new(Mutex::new(std::collections::VecDeque::new()));
        let tx: transport::WsTx = Arc::new(Mutex::new(Vec::new()));
        map.insert(port_name.clone(), (rx.clone(), tx.clone()));
        (rx, tx)
    };
    let mut devices = state
        .devices
        .lock()
        .map_err(|_| "device registry poisoned".to_string())?;
    let record = devices
        .open_webserial(&port_name, baud_rate.unwrap_or(115_200), device_name, rx, tx)
        .map_err(|error| format!("{error:?}"))?;
    // 真实设备上来了，把模拟设备摘掉，避免两个数据源同时喂图表
    devices.remove_simulator();
    // 关键：还要清掉环形缓冲里残留的模拟帧。否则真实设备万一不发数据
    // （波特率不对、接线问题），界面会继续显示这些旧模拟帧，
    // 让人把假数据当成真数据 —— 那比白屏危险得多。
    if let Ok(mut ring) = state.live_ring.lock() {
        ring.clear();
    }
    // 记下是谁在供数据：手机端据此显示"数据来自电脑端"
    sync_set_source(client_id);
    notify_device_change();
    Ok(record)
}

/// 前端把从串口读到的原始字节推进来。返回本次接受的字节数。
#[cfg_attr(feature = "desktop", tauri::command)]
fn webserial_push(
    port_name: String,
    bytes: Vec<u8>,
    seq: Option<u64>,
) -> Result<serde_json::Value, String> {
    if let Some(value) = seq {
        let mut meta = ws_meta()
            .lock()
            .map_err(|_| "webserial meta poisoned".to_string())?;
        let entry = meta.entry(port_name.clone()).or_default();
        if value <= entry.last_seq {
            entry.duplicates = entry.duplicates.saturating_add(1);
            return Ok(serde_json::json!({
                "accepted": 0, "duplicate": true,
                "gaps": entry.gaps, "duplicates": entry.duplicates,
            }));
        }
        // 序号跳变 = 中间有块没到。解码器会靠扫描帧头自愈，这里只记账，
        // 让"丢了多少次"变成可观测的数字，而不是悄悄变成校验错误。
        if value > entry.last_seq.saturating_add(1) {
            entry.gaps = entry.gaps.saturating_add(1);
        }
        entry.last_seq = value;
    }

    let map = ws_buffers()
        .lock()
        .map_err(|_| "webserial buffer poisoned".to_string())?;
    let (rx, _) = map
        .get(&port_name)
        .ok_or_else(|| format!("webserial 端口未打开：{port_name}"))?;
    let mut guard = rx.lock().map_err(|_| "webserial rx poisoned".to_string())?;
    let accepted = bytes.len();
    guard.extend(bytes);
    // 防止前端异常刷数据把内存撑爆：只保留最近 256 KB
    while guard.len() > 256 * 1024 {
        guard.pop_front();
    }
    let (gaps, duplicates) = ws_meta()
        .lock()
        .map(|meta| {
            let entry = meta.get(&port_name);
            (
                entry.map(|e| e.gaps).unwrap_or(0),
                entry.map(|e| e.duplicates).unwrap_or(0),
            )
        })
        .unwrap_or((0, 0));
    Ok(serde_json::json!({
        "accepted": accepted, "duplicate": false, "gaps": gaps, "duplicates": duplicates,
    }))
}

/// 待发命令的**长轮询**：有字节立刻返回，没有就挂到超时。
///
/// 替代前端原来每 20ms 一次的 `webserial_take_tx` —— 那是 50 req/s，
/// 在往返 100ms 的隧道上必然大面积失败，而失败又会连带丢掉接收字节
/// （实测 131 个校验错 vs 43 个有效帧，就是这么来的）。
/// 改成挂起式之后，空闲时连接上只有一个未完成的请求。
#[cfg_attr(feature = "desktop", tauri::command)]
fn webserial_wait_tx(
    port_name: String,
    timeout_ms: Option<u64>,
) -> Result<Vec<u8>, String> {
    let deadline = std::time::Instant::now()
        + std::time::Duration::from_millis(timeout_ms.unwrap_or(15_000).clamp(1_000, 30_000));
    loop {
        {
            let map = ws_buffers()
                .lock()
                .map_err(|_| "webserial buffer poisoned".to_string())?;
            let (_, tx) = map
                .get(&port_name)
                .ok_or_else(|| format!("webserial 端口未打开：{port_name}"))?;
            let mut guard = tx.lock().map_err(|_| "webserial tx poisoned".to_string())?;
            if !guard.is_empty() {
                return Ok(std::mem::take(&mut *guard));
            }
        }
        if std::time::Instant::now() >= deadline {
            return Ok(Vec::new());
        }
        // 5ms 轮询足够快（远比往返时延小），又不必引入 Condvar 的锁序问题
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

/// 前端取走后端要下发的命令字节。
#[cfg_attr(feature = "desktop", tauri::command)]
fn webserial_take_tx(port_name: String) -> Result<Vec<u8>, String> {
    let map = ws_buffers()
        .lock()
        .map_err(|_| "webserial buffer poisoned".to_string())?;
    let (_, tx) = map
        .get(&port_name)
        .ok_or_else(|| format!("webserial 端口未打开：{port_name}"))?;
    let mut guard = tx.lock().map_err(|_| "webserial tx poisoned".to_string())?;
    Ok(std::mem::take(&mut *guard))
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn webserial_close(state: State<'_, AppState>, port_name: String) -> Result<(), String> {
    if let Ok(mut map) = ws_buffers().lock() {
        map.remove(&port_name);
    }
    if let Ok(mut meta) = ws_meta().lock() {
        meta.remove(&port_name);
    }
    let mut devices = state
        .devices
        .lock()
        .map_err(|_| "device registry poisoned".to_string())?;
    devices
        .close_webserial(&port_name)
        .map_err(|error| format!("{error:?}"))?;
    // 真实设备全断了：只清掉数据源标记，**不再自动补回模拟设备**。
    // 要不要看模拟数据由操作员按「模拟数据」按钮决定 ——
    // 否则真实设备一断就悄悄变成假数据，操作员不知道自己在看什么。
    if !devices.has_real_device() {
        sync_set_source(None);
    }
    notify_device_change();
    Ok(())
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn list_serial_ports() -> Result<Vec<transport::SerialPortDescriptor>, String> {
    transport::list_serial_ports().map_err(|error| format!("{error:?}"))
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn list_connected_devices(
    state: State<'_, AppState>,
) -> Result<Vec<device::DeviceConnectionRecord>, String> {
    let devices = state
        .devices
        .lock()
        .map_err(|_| "device registry poisoned".to_string())?;
    Ok(devices.list())
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn connect_device(
    state: State<'_, AppState>,
    request: ConnectDeviceRequest,
) -> Result<device::DeviceConnectionRecord, String> {
    guard_permission(&state, auth::Permission::ConnectDevice)?;

    let config = transport::SerialConnectionConfig {
        port_name: request.port_name,
        baud_rate: request.baud_rate.unwrap_or(9_600),
        data_bits: request.data_bits.unwrap_or(8),
        parity: request.parity.unwrap_or_else(|| "none".to_string()),
        stop_bits: request.stop_bits.unwrap_or(1),
        flow_control: request.flow_control.unwrap_or_else(|| "none".to_string()),
        timeout_ms: request.timeout_ms.unwrap_or(50),
    };
    let port_name = config.port_name.clone();
    let baud_rate = config.baud_rate;
    let mut devices = state
        .devices
        .lock()
        .map_err(|_| "device registry poisoned".to_string())?;
    let record = devices
        .connect_serial(config)
        .map_err(|error| format!("{error:?}"))?;
    let device_id = record.device_id.clone();
    drop(devices);

    // Log the connection event
    state.store.mutate(|data| {
        data.sequence = data.sequence.saturating_add(1);
        data.logs.push(log_entry(
            data.sequence,
            LogLevel::Info,
            "connection",
            &format!("Connected to {} at {} baud", port_name, baud_rate),
            Some(&device_id),
            None,
        ));
    });

    Ok(record)
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn disconnect_device(
    state: State<'_, AppState>,
    device_id: String,
) -> Result<device::DeviceConnectionRecord, String> {
    let mut devices = state
        .devices
        .lock()
        .map_err(|_| "device registry poisoned".to_string())?;
    let record = devices
        .disconnect(&device_id)
        .map_err(|error| format!("{error:?}"))?;
    drop(devices);

    if let Ok(mut ring) = state.live_ring.lock() {
        ring.clear();
    }

    // Log the disconnection event
    let device_id_clone = device_id.clone();
    state.store.mutate(|data| {
        data.sequence = data.sequence.saturating_add(1);
        data.logs.push(log_entry(
            data.sequence,
            LogLevel::Info,
            "connection",
            &format!("Disconnected {}", device_id_clone),
            Some(&device_id),
            None,
        ));
    });

    Ok(record)
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn fetch_live_window(state: State<'_, AppState>, count: u32) -> Vec<DeviceSnapshot> {
    // ⚠ 回放激活时曲线必须来自**回放帧**。这两个命令原来直接读实时环，
    //   于是「点了播放，工作区/曲线还在跑模拟数据」—— 它们绕过了回放引擎。
    if let Ok(pb) = state.playback.lock() {
        if pb.status().active {
            return pb.frame_window(count as usize).into_iter().cloned().collect();
        }
    }
    state
        .live_ring
        .lock()
        .map(|ring| ring.window(count as usize))
        .unwrap_or_default()
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn fetch_live_stats(state: State<'_, AppState>) -> live::FrameStats {
    state
        .live_ring
        .lock()
        .map(|ring| ring.stats())
        .unwrap_or_else(|_| live::FrameStats {
            stored_frames: 0,
            capacity: 0,
            total_frames: 0,
            dropped_frames: 0,
            frame_rate_hz: 0.0,
        })
}

/// 轻量实时响应：最新一帧 + 环形缓冲统计。供总览/工作区等页面高频轮询，
/// 只序列化一个帧与统计，远小于整份 RuntimeSnapshot。
#[cfg_attr(feature = "desktop", tauri::command)]
fn fetch_live_latest(state: State<'_, AppState>) -> LiveLatest {
    // 回放激活：工作区读数取回放游标那一帧（同上，必须绕开实时环）。
    let ring_stats = state
        .live_ring
        .lock()
        .map(|ring| ring.stats())
        .unwrap_or_else(|_| empty_live_stats());
    if let Ok(pb) = state.playback.lock() {
        if pb.status().active {
            if let Some(frame) = pb.current_frame().cloned() {
                return LiveLatest {
                    selected_device_id: frame.device_id.clone(),
                    latest: Some(frame),
                    stats: ring_stats,
                };
            }
        }
    }
    let mut latest: Option<DeviceSnapshot> = None;
    let mut stats = live::FrameStats {
        stored_frames: 0,
        capacity: 0,
        total_frames: 0,
        dropped_frames: 0,
        frame_rate_hz: 0.0,
    };
    if let Ok(ring) = state.live_ring.lock() {
        stats = ring.stats();
        latest = ring.latest_per_device().into_iter().next();
    }
    let selected_device_id = latest
        .as_ref()
        .map(|frame| frame.device_id.clone())
        .unwrap_or_default();
    LiveLatest {
        selected_device_id,
        latest,
        stats,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceRuntimeStatusView {
    state: device::DeviceConnectionState,
    received_frames: u64,
    protocol_errors: u64,
    sent_commands: u64,
    pending_commands: usize,
    reconnect_attempts: u32,
    last_frame_ms: u64,
    last_command_ms: u64,
    command_high_watermark: usize,
    emergency_latched: bool,
    last_error: Option<String>,
    last_error_code: Option<String>,
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn device_runtime_status(
    state: State<'_, AppState>,
    device_id: String,
) -> Result<DeviceRuntimeStatusView, String> {
    let devices = state
        .devices
        .lock()
        .map_err(|_| "device registry poisoned".to_string())?;
    let runtime = devices
        .runtime_status(&device_id)
        .map_err(|error| format!("{error:?}"))?;
    Ok(DeviceRuntimeStatusView {
        state: runtime.state,
        received_frames: runtime.received_frames,
        protocol_errors: runtime.protocol_errors,
        sent_commands: runtime.sent_commands,
        pending_commands: runtime.pending_commands,
        reconnect_attempts: runtime.reconnect_attempts,
        last_frame_ms: runtime.last_frame_ms,
        last_command_ms: runtime.last_command_ms,
        command_high_watermark: runtime.command_high_watermark,
        emergency_latched: runtime.emergency_latched,
        last_error: runtime.last_error,
        last_error_code: runtime.last_error_code,
    })
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn submit_system_control(
    state: State<'_, AppState>,
    request: SystemControlRequest,
) -> Result<RuntimeSnapshot, String> {
    let device_id = request
        .device_id
        .clone()
        .unwrap_or_else(|| "softui-sim-01".to_string());
    let frame = protocol::encode_system_control_command(request.action.protocol_action())
        .map_err(|error| format!("{error:?}"))?;

    let priority = if matches!(request.action, SystemControlActionRequest::EmergencyStop) {
        device::CommandPriority::Emergency
    } else {
        device::CommandPriority::Normal
    };

    if device_id.starts_with("serial:")
        && matches!(request.action, SystemControlActionRequest::Disable)
    {
        if let Ok(mut devices) = state.devices.lock() {
            let _ = devices.mark_control_enabled(&device_id, false);
        }
    }

    send_frame_to_device(&state, &device_id, &frame, priority)?;

    if device_id.starts_with("serial:") {
        if let Ok(mut devices) = state.devices.lock() {
            match request.action {
                SystemControlActionRequest::Enable => {
                    let _ = devices.mark_control_enabled(&device_id, true);
                }
                SystemControlActionRequest::EmergencyStop => {
                    let _ = devices.mark_emergency_stopped(&device_id);
                    if let Ok(mut control) = state.control_runtime.lock() {
                        control.stop("emergency stop latched");
                    }
                }
                SystemControlActionRequest::Disable => {
                    if let Ok(mut control) = state.control_runtime.lock() {
                        control.stop("device control is not enabled");
                    }
                }
            }
        }
    } else if matches!(
        request.action,
        SystemControlActionRequest::Disable | SystemControlActionRequest::EmergencyStop
    ) {
        if let Ok(mut control) = state.control_runtime.lock() {
            control.stop(request.action.label());
        }
    }

    let frame_hex = frame_hex(&frame);
    record_control_command(
        &state,
        &device_id,
        request.action.label(),
        &frame_hex,
        &request,
    );
    state.store.mutate(|data| {
        data.sequence = data.sequence.saturating_add(1);
        match request.action {
            SystemControlActionRequest::Enable => data.connected = true,
            SystemControlActionRequest::Disable | SystemControlActionRequest::EmergencyStop => {
                data.connected = false
            }
        }

        let level = if matches!(request.action, SystemControlActionRequest::EmergencyStop) {
            LogLevel::Warn
        } else {
            LogLevel::Info
        };
        data.logs.push(log_entry(
            data.sequence,
            level,
            "control",
            request.action.label(),
            Some(&device_id),
            Some(&frame_hex),
        ));
    });
    Ok(state.snapshot())
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn send_motor_command(
    state: State<'_, AppState>,
    request: MotorControlRequest,
) -> Result<RuntimeSnapshot, String> {
    let device_id = request
        .device_id
        .clone()
        .unwrap_or_else(|| "softui-sim-01".to_string());

    guard_command_allowed(&state, &device_id, CommandSafety::Enabled)?;

    let frame = protocol::encode_motor_command(
        request.motor_id,
        request.position_mm,
        request.velocity_mm_per_sec.unwrap_or(10.0),
        request.acceleration_mm_per_sec2.unwrap_or(3.0),
    )
    .map_err(|error| format!("{error:?}"))?;

    send_frame_to_device(&state, &device_id, &frame, device::CommandPriority::Normal)?;
    let frame_hex = frame_hex(&frame);
    record_control_command(
        &state,
        &device_id,
        "motor command sent",
        &frame_hex,
        &request,
    );
    state.store.mutate(|data| {
        data.sequence = data.sequence.saturating_add(1);
        data.logs.push(log_entry(
            data.sequence,
            LogLevel::Info,
            "control",
            "motor command sent",
            Some(&device_id),
            Some(&frame_hex),
        ));
    });
    Ok(state.snapshot())
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn send_home_command(
    state: State<'_, AppState>,
    request: HomeCommandRequest,
) -> Result<RuntimeSnapshot, String> {
    let device_id = selected_device_id(request.device_id);
    let frame = protocol::encode_home_command(
        request.motor_count.unwrap_or(6),
        request.start_address.unwrap_or(1),
    )
    .map_err(|error| format!("{error:?}"))?;
    audit_control_frame(
        state,
        device_id,
        "home command sent",
        frame,
        CommandSafety::Enabled,
    )
}

/// 多电机同步位移：一次下发一组目标位移，速度由下位机按位移比例分配。
#[cfg_attr(feature = "desktop", tauri::command)]
fn send_multi_motor_command(
    state: State<'_, AppState>,
    request: MultiMotorCommandRequest,
) -> Result<RuntimeSnapshot, String> {
    let frame = protocol::encode_multi_motor_command(
        request.start_address.unwrap_or(1),
        &request.positions_mm,
    )
    .map_err(|error| format!("{error:?}"))?;
    let device_id = selected_device_id(request.device_id);
    audit_control_frame(
        state,
        device_id,
        "multi-motor command sent",
        frame,
        CommandSafety::Enabled,
    )
}

/// 曲率 → 电机位移：**纯走全阶 Cosserat 查表**（超范围报错，无内置解析回退），
/// 再走 0x04 多电机同步指令下发。
#[cfg_attr(feature = "desktop", tauri::command)]
fn send_curvature_command(
    state: State<'_, AppState>,
    request: CurvatureCommandRequest,
) -> Result<RuntimeSnapshot, String> {
    let device_id = selected_device_id(request.device_id.clone());
    // 1) 全阶 Cosserat 查表：曲率 → 6 丝位移
    let kind = match request.table_gauge_n.unwrap_or(60) {
        40 => kappatable::KappaTableKind::Limit40n,
        _ => kappatable::KappaTableKind::Limit60n,
    };
    let model_tables = current_model();
    let table = model_tables.kappa(kind);
    let query = kappatable::features_from_segments(
        request.segment_curvature_per_m,
        request.segment_direction_rad,
    );
    let lookup = match table.lookup(query) {
        Ok(lookup) => lookup,
        Err(error) => {
            let message = format!("曲率查表失败：{error:?}");
            record_control_failure(&state, &device_id, &message);
            return Err(message);
        }
    };

    // 2) 纯查表：超出覆盖范围直接报错，不再退回解析 PCC 模型。
    //    把「查的是什么」和「表能覆盖到哪」一起报出来 —— 否则现场只会看到一句「命令失败」，
    //    既不知道是没使能、串口错，还是曲率太大。
    if !lookup.covered {
        let message = format!(
            "曲率超出 κ 表覆盖范围：查询 κ=[{:.2}, {:.2}] 1/m，最近邻距离 {:.2} > {:.1}。\
             表内两段 κ 上限约 {:.1} / {:.1} 1/m（{} 表），请把目标曲率调小后重试",
            request.segment_curvature_per_m[0].abs(),
            request.segment_curvature_per_m[1].abs(),
            lookup.nearest_distance,
            kappatable::COVERAGE_RADIUS_PER_M,
            kappatable::SEGMENT_A_MAX_KAPPA_PER_M,
            kappatable::SEGMENT_B_MAX_KAPPA_PER_M,
            kind.label(),
        );
        record_control_failure(&state, &device_id, &message);
        return Err(message);
    }
    let positions_mm = lookup.displacement_mm;

    let frame = protocol::encode_multi_motor_command(
        request.start_address.unwrap_or(1),
        &positions_mm,
    )
    .map_err(|error| format!("{error:?}"))?;

    audit_control_frame(
        state,
        device_id,
        "curvature command sent",
        frame,
        CommandSafety::Enabled,
    )
}

/// 末端位姿 → 电机位移：走**全阶 Cosserat 位姿查表**（`ik_table.PoseTable` 口径），
/// 再经 0x04 多电机同步指令下发。取代原先「位姿 → 两段曲率 → 0x05 角度」的内置 PCC 链路。
#[cfg_attr(feature = "desktop", tauri::command)]
fn send_tip_pose_command(
    state: State<'_, AppState>,
    request: TipPoseCommandRequest,
) -> Result<RuntimeSnapshot, String> {
    let kind = match request.table_gauge_n.unwrap_or(60) {
        40 => posetable::PoseTableKind::Limit40n,
        _ => posetable::PoseTableKind::Limit60n,
    };
    let query = posetable::encode_rpy_mm(
        request.position_mm,
        request.roll,
        request.pitch,
        request.yaw,
    );
    let model_tables = current_model();
    let device_id = selected_device_id(request.device_id.clone());
    let lookup = match model_tables.pose(kind).lookup(&query) {
        Ok(lookup) => lookup,
        Err(error) => {
            let message = format!("位姿查表失败：{error:?}");
            record_control_failure(&state, &device_id, &message);
            return Err(message);
        }
    };
    if !lookup.covered {
        let message = format!(
            "位姿超出 Cosserat 位姿表覆盖范围：最近邻距离 {:.1} > {:.0}，请把末端目标移回可达空间内",
            lookup.nearest_distance,
            posetable::COVERAGE_RADIUS,
        );
        record_control_failure(&state, &device_id, &message);
        return Err(message);
    }

    let frame = protocol::encode_multi_motor_command(
        request.start_address.unwrap_or(1),
        &lookup.displacement_mm,
    )
    .map_err(|error| format!("{error:?}"))?;

    audit_control_frame(
        state,
        device_id,
        "tip pose command sent",
        frame,
        CommandSafety::Enabled,
    )
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn calibrate_sensor(
    state: State<'_, AppState>,
    request: SensorCalibrationRequest,
) -> Result<RuntimeSnapshot, String> {
    guard_permission(&state, auth::Permission::RunCalibration)?;

    let device_id = selected_device_id(request.device_id);
    let frame = protocol::encode_sensor_calibration(request.sensor_id, request.calibration_value)
        .map_err(|error| format!("{error:?}"))?;
    audit_control_frame(
        state,
        device_id,
        "sensor calibration sent",
        frame,
        CommandSafety::Connected,
    )
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn send_bend_command(
    state: State<'_, AppState>,
    request: BendCommandRequest,
) -> Result<RuntimeSnapshot, String> {
    let device_id = selected_device_id(request.device_id);
    let frame = protocol::encode_bend_command(
        request.direction1,
        request.angle1_deg,
        request.direction2,
        request.angle2_deg,
    )
    .map_err(|error| format!("{error:?}"))?;
    audit_control_frame(
        state,
        device_id,
        "bend command sent",
        frame,
        CommandSafety::Enabled,
    )
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn send_active_control_tick(
    state: State<'_, AppState>,
    request: ActiveControlRequest,
) -> Result<RuntimeSnapshot, String> {
    let device_id = selected_device_id(request.device_id);
    let frame = protocol::encode_active_control_tick();
    audit_control_frame(
        state,
        device_id,
        "active control tick sent",
        frame,
        CommandSafety::Enabled,
    )
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn control_runtime_status(state: State<'_, AppState>) -> Result<control::ControlStatus, String> {
    state
        .control_runtime
        .lock()
        .map_err(|_| "control runtime poisoned".to_string())
        .map(|control| control.status())
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn update_pid_control(
    state: State<'_, AppState>,
    config: control::PidConfig,
) -> Result<control::ControlStatus, String> {
    guard_permission(&state, auth::Permission::ManageSettings)?;

    state
        .control_runtime
        .lock()
        .map_err(|_| "control runtime poisoned".to_string())
        .map(|mut control| control.update_pid(config))
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn configure_cycle_life(
    state: State<'_, AppState>,
    config: control::CycleLifeConfig,
) -> Result<control::ControlStatus, String> {
    guard_permission(&state, auth::Permission::ManageSettings)?;

    state
        .control_runtime
        .lock()
        .map_err(|_| "control runtime poisoned".to_string())
        .map(|mut control| control.configure_cycle(config))
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn start_cycle_life(
    state: State<'_, AppState>,
    request: CycleLifeStartRequest,
) -> Result<RuntimeSnapshot, String> {
    guard_permission(&state, auth::Permission::RunCycleLife)?;

    {
        let mut control = state
            .control_runtime
            .lock()
            .map_err(|_| "control runtime poisoned".to_string())?;
        control.start_cycle(request.config);
    }

    state.store.mutate(|data| {
        data.sequence = data.sequence.saturating_add(1);
        data.logs.push(log_entry(
            data.sequence,
            LogLevel::Info,
            "control",
            "cycle life started",
            Some("control-runtime"),
            None,
        ));
    });
    Ok(state.snapshot())
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn stop_cycle_life(
    state: State<'_, AppState>,
    reason: Option<String>,
) -> Result<RuntimeSnapshot, String> {
    guard_permission(&state, auth::Permission::RunCycleLife)?;

    let reason = reason.unwrap_or_else(|| "cycle life stopped".to_string());
    {
        let mut control = state
            .control_runtime
            .lock()
            .map_err(|_| "control runtime poisoned".to_string())?;
        control.stop(reason.clone());
    }

    state.store.mutate(|data| {
        data.sequence = data.sequence.saturating_add(1);
        data.logs.push(log_entry(
            data.sequence,
            LogLevel::Info,
            "control",
            &reason,
            Some("control-runtime"),
            None,
        ));
    });
    Ok(state.snapshot())
}

// ── Dynamics commands ──

#[cfg_attr(feature = "desktop", tauri::command)]
fn dynamics_status(state: State<'_, AppState>) -> Result<dynamics::DynamicsStatus, String> {
    state
        .dynamics_runtime
        .lock()
        .map_err(|_| "dynamics runtime poisoned".to_string())
        .map(|runtime| runtime.status())
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn compute_live_dynamics(state: State<'_, AppState>) -> Result<dynamics::DynamicsOutput, String> {
    let status = state
        .dynamics_runtime
        .lock()
        .map_err(|_| "dynamics runtime poisoned".to_string())?
        .status();
    status
        .last_output
        .ok_or_else(|| "no dynamics output computed yet; wait for device frames".to_string())
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn compute_dynamics_snapshot(state: State<'_, AppState>) -> Result<dynamics::DynamicsOutput, String> {
    let frame = state
        .live_ring
        .lock()
        .map_err(|_| "live ring poisoned".to_string())?
        .latest()
        .ok_or_else(|| "no device snapshot available for dynamics computation".to_string())?;

    state
        .dynamics_runtime
        .lock()
        .map_err(|_| "dynamics runtime poisoned".to_string())?
        .step_frame(&frame, 50)
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn update_dynamics_config(
    state: State<'_, AppState>,
    config: dynamics::DynamicsConfig,
) -> Result<dynamics::DynamicsStatus, String> {
    guard_permission(&state, auth::Permission::ManageSettings)?;
    state
        .dynamics_runtime
        .lock()
        .map_err(|_| "dynamics runtime poisoned".to_string())?
        .update_config(config)
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn reset_dynamics(state: State<'_, AppState>) -> Result<dynamics::DynamicsStatus, String> {
    guard_permission(&state, auth::Permission::ManageSettings)?;
    Ok(state
        .dynamics_runtime
        .lock()
        .map_err(|_| "dynamics runtime poisoned".to_string())?
        .reset())
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn start_recording(
    state: State<'_, AppState>,
    name: Option<String>,
) -> Result<session::SessionInfo, String> {
    guard_permission(&state, auth::Permission::ManageSessions)?;
    let name = name.unwrap_or_else(|| {
        use std::time::{SystemTime, UNIX_EPOCH};
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        format!("录制-{}", ts)
    });
    let mut info = state
        .recorder
        .lock()
        .map_err(|_| "recorder poisoned".to_string())?
        .start(name)?;
    let operator = state.session().username;
    info.operator = Some(operator.clone());
    state
        .sqlite
        .upsert_session(&session_info_row(&info, Some(operator)))?;
    Ok(info)
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn stop_recording(state: State<'_, AppState>) -> Result<session::SessionInfo, String> {
    guard_permission(&state, auth::Permission::ManageSessions)?;
    let info = state
        .recorder
        .lock()
        .map_err(|_| "recorder poisoned".to_string())?
        .stop()?;
    state.record_session_info(&info);
    Ok(info)
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn pause_recording(state: State<'_, AppState>) -> Result<(), String> {
    guard_permission(&state, auth::Permission::ManageSessions)?;
    state
        .recorder
        .lock()
        .map_err(|_| "recorder poisoned".to_string())?
        .pause()
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn resume_recording(state: State<'_, AppState>) -> Result<(), String> {
    guard_permission(&state, auth::Permission::ManageSessions)?;
    state
        .recorder
        .lock()
        .map_err(|_| "recorder poisoned".to_string())?
        .resume()
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn recorder_status(state: State<'_, AppState>) -> session::RecorderStatus {
    state
        .recorder
        .lock()
        .map(|r| r.status())
        .unwrap_or_else(|_| session::RecorderStatus {
            active: false,
            paused: false,
            session_id: String::new(),
            session_name: String::new(),
            frame_count: 0,
            elapsed_secs: 0,
        })
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn list_sessions(state: State<'_, AppState>) -> Vec<session::SessionInfo> {
    let sessions = state
        .recorder
        .lock()
        .map(|r| r.list_sessions())
        .unwrap_or_default();
    for info in &sessions {
        state.record_session_info(info);
    }
    sessions
}

// ── Playback commands ──

#[cfg_attr(feature = "desktop", tauri::command)]
fn playback_load(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<playback::PlaybackStatus, String> {
    guard_permission(&state, auth::Permission::ManageSessions)?;
    // ⚠ 回放会接管实时帧（`playback_mode`），录制就收不到新数据了。
    //   这是个静默陷阱（实测踩到：录着录着点了回放，数据再也不增长），直接拦下来。
    if let Ok(rec) = state.recorder.lock() {
        if rec.is_active() {
            return Err(
                "正在录制中：请先停止录制再加载回放（回放会接管实时数据，录制将收不到新帧）"
                    .to_string(),
            );
        }
    }
    let csv_path = {
        let rec = state
            .recorder
            .lock()
            .map_err(|_| "recorder poisoned".to_string())?;
        rec.session_csv_path(&session_id)
            .ok_or_else(|| "会话 CSV 文件不存在".to_string())?
    };
    let mut pb = state
        .playback
        .lock()
        .map_err(|_| "playback poisoned".to_string())?;
    pb.load(session_id, &csv_path)?;
    Ok(pb.status())
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn playback_play(state: State<'_, AppState>) -> Result<playback::PlaybackStatus, String> {
    guard_permission(&state, auth::Permission::ManageSessions)?;
    let mut pb = state
        .playback
        .lock()
        .map_err(|_| "playback poisoned".to_string())?;
    pb.play();
    Ok(pb.status())
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn playback_pause(state: State<'_, AppState>) -> Result<playback::PlaybackStatus, String> {
    guard_permission(&state, auth::Permission::ManageSessions)?;
    let mut pb = state
        .playback
        .lock()
        .map_err(|_| "playback poisoned".to_string())?;
    pb.pause();
    Ok(pb.status())
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn playback_stop(state: State<'_, AppState>) -> Result<playback::PlaybackStatus, String> {
    guard_permission(&state, auth::Permission::ManageSessions)?;
    let mut pb = state
        .playback
        .lock()
        .map_err(|_| "playback poisoned".to_string())?;
    pb.stop();
    let status = pb.status();
    pb.unload();
    Ok(status)
}

/// 单帧步进：`delta` = ±1（或 ±N）。步进会自动暂停播放。
#[cfg_attr(feature = "desktop", tauri::command)]
fn playback_step_frame(
    state: State<'_, AppState>,
    delta: i64,
) -> Result<playback::PlaybackStatus, String> {
    guard_permission(&state, auth::Permission::ManageSessions)?;
    let mut pb = state
        .playback
        .lock()
        .map_err(|_| "playback poisoned".to_string())?;
    pb.step_frame(delta);
    Ok(pb.status())
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn playback_seek(state: State<'_, AppState>, ms: u64) -> Result<playback::PlaybackStatus, String> {
    guard_permission(&state, auth::Permission::ManageSessions)?;
    let mut pb = state
        .playback
        .lock()
        .map_err(|_| "playback poisoned".to_string())?;
    pb.seek_to_ms(ms);
    Ok(pb.status())
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn playback_set_speed(
    state: State<'_, AppState>,
    speed: f64,
) -> Result<playback::PlaybackStatus, String> {
    guard_permission(&state, auth::Permission::ManageSessions)?;
    let mut pb = state
        .playback
        .lock()
        .map_err(|_| "playback poisoned".to_string())?;
    pb.set_speed(speed);
    Ok(pb.status())
}

/// 游标之前 `window_ms` 毫秒内的设备帧（「最近 N 分钟」的原始数据）。
#[cfg_attr(feature = "desktop", tauri::command)]
fn playback_recent_window(
    state: State<'_, AppState>,
    window_ms: u64,
) -> Result<Vec<DeviceSnapshot>, String> {
    let pb = state
        .playback
        .lock()
        .map_err(|_| "playback poisoned".to_string())?;
    Ok(pb.frames_in_window(window_ms).into_iter().cloned().collect())
}

/// 当前回放会话记录的控制指令（配合 `playback_status` 的游标切窗口）。
#[cfg_attr(feature = "desktop", tauri::command)]
fn playback_commands(
    state: State<'_, AppState>,
) -> Result<Vec<session::SessionCommandRow>, String> {
    let pb = state
        .playback
        .lock()
        .map_err(|_| "playback poisoned".to_string())?;
    Ok(pb.commands().to_vec())
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn playback_status(state: State<'_, AppState>) -> playback::PlaybackStatus {
    // ⚠ 播放的**推进**挂在这里。
    //
    // 原来推进只挂在 `AppState::tick()`（= `tick_snapshot`）上，而前端除了登录/
    // 迁移后根本不轮询它 —— 于是游标不动，表现就是「点播放界面不刷新，只有单帧
    // 步进时才动」。本命令在播放期间被前端每 100ms 轮询，是最可靠的推进点。
    //
    // `tick` 用绝对时间算游标（`started_at_real + speed`），重复调用不会叠加。
    state
        .playback
        .lock()
        .map(|mut p| {
            p.tick(now_ms());
            p.status()
        })
        .unwrap_or_else(|_| playback::PlaybackStatus {
            active: false,
            session_id: String::new(),
            playing: false,
            speed: 1.0,
            cursor_ms: 0,
            duration_ms: 0,
            cursor_pct: 0.0,
            total_frames: 0,
            current_frame_idx: 0,
        })
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn playback_get_frame(state: State<'_, AppState>) -> Option<DeviceSnapshot> {
    state
        .playback
        .lock()
        .ok()
        .and_then(|p| p.current_frame().cloned())
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn playback_get_window(state: State<'_, AppState>, count: u32) -> Vec<DeviceSnapshot> {
    state
        .playback
        .lock()
        .map(|p| {
            p.frame_window(count as usize)
                .into_iter()
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

// ── Session management commands ──

#[cfg_attr(feature = "desktop", tauri::command)]
fn delete_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    guard_permission(&state, auth::Permission::ManageSessions)?;
    state
        .recorder
        .lock()
        .map_err(|_| "recorder poisoned".to_string())?
        .delete_session(&id)?;
    state.sqlite.delete_session(&id)
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn rename_session(state: State<'_, AppState>, id: String, name: String) -> Result<(), String> {
    guard_permission(&state, auth::Permission::ManageSessions)?;
    state
        .recorder
        .lock()
        .map_err(|_| "recorder poisoned".to_string())?
        .rename_session(&id, &name)?;
    if let Ok(recorder) = state.recorder.lock() {
        if let Some(info) = recorder
            .list_sessions()
            .into_iter()
            .find(|session| session.id == id)
        {
            state.record_session_info(&info);
        }
    }
    Ok(())
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn update_session_metadata(
    state: State<'_, AppState>,
    id: String,
    meta: session::SessionMetadata,
) -> Result<(), String> {
    guard_permission(&state, auth::Permission::ManageSessions)?;
    state
        .recorder
        .lock()
        .map_err(|_| "recorder poisoned".to_string())?
        .update_metadata(&id, &meta)?;
    if let Ok(recorder) = state.recorder.lock() {
        if let Some(info) = recorder
            .list_sessions()
            .into_iter()
            .find(|session| session.id == id)
        {
            state.record_session_info(&info);
        }
    }
    Ok(())
}




#[cfg_attr(feature = "desktop", tauri::command)]
fn read_session_frames(
    state: State<'_, AppState>,
    id: String,
    max_count: Option<u32>,
) -> Result<Vec<DeviceSnapshot>, String> {
    guard_permission(&state, auth::Permission::ManageSessions)?;
    let rec = state
        .recorder
        .lock()
        .map_err(|_| "recorder poisoned".to_string())?;
    let csv_path = rec
        .session_csv_path(&id)
        .ok_or_else(|| "会话 CSV 文件不存在".to_string())?;
    drop(rec); // release lock before I/O

    let max = max_count.unwrap_or(5000).min(5000) as usize;
    let sqlite_frames = state
        .sqlite
        .read_snapshot_json(&id, max)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|raw| serde_json::from_str::<DeviceSnapshot>(&raw).ok())
        .collect::<Vec<_>>();
    let mut frames = if sqlite_frames.is_empty() {
        session::read_session_csv(&csv_path)?
    } else {
        sqlite_frames
    };
    if frames.len() > max {
        // Downsample evenly
        let step = frames.len() / max;
        frames = frames.into_iter().step_by(step).collect();
    }
    Ok(frames)
}

// ── Connection profile commands ──

#[cfg_attr(feature = "desktop", tauri::command)]
fn list_connection_profiles(state: State<'_, AppState>) -> Vec<profiles::ConnectionProfile> {
    state.profile_store.list()
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn save_connection_profile(
    state: State<'_, AppState>,
    profile: profiles::ConnectionProfile,
) -> Result<profiles::ConnectionProfile, String> {
    guard_permission(&state, auth::Permission::ManageSettings)?;
    state.profile_store.save(profile)
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn delete_connection_profile(state: State<'_, AppState>, id: String) -> Result<(), String> {
    guard_permission(&state, auth::Permission::ManageSettings)?;
    state.profile_store.delete(&id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trunc2(value: f64) -> f64 {
        (value * 100.0).trunc() / 100.0
    }

    #[test]
    fn simulated_snapshot_uses_legacy_protocol_status() {
        let seq = 64;
        let simulator = transport::SimulatorTransport::with_seed(seq).expect("simulator");
        let mut runtime = device::DeviceRuntime::new(simulator);
        let protocol_status = runtime.handshake().expect("status");
        let snapshot = make_frame(seq, true);

        assert_eq!(snapshot.protocol_version, "Legacy V1");
        assert!(snapshot.system_enabled);
        assert_eq!(snapshot.motors.len(), protocol_status.motors.len());
        assert_eq!(snapshot.sensors.len(), protocol_status.sensors.len());
        assert_eq!(
            snapshot.motors[0].position_mm,
            trunc2(protocol_status.motors[0].position_mm)
        );
        assert_eq!(
            snapshot.sensors[0].raw[0],
            protocol_status.sensors[0].x
        );
        assert_eq!(
            snapshot.bend.section1.angle_deg,
            trunc2(protocol_status.bend_angle1_deg)
        );
        assert!(snapshot.quality.checksum_ok);
    }

    #[test]
    fn runtime_snapshot_contains_protocol_backed_live_frame() {
        let data = default_persisted_state();
        let snapshot = build_snapshot(&data);

        assert_eq!(snapshot.live.selected_device_id, "softui-sim-01");
        let latest = snapshot.live.latest.expect("latest frame");
        assert_eq!(latest.motors.len(), 6);
        assert_eq!(latest.sensors.len(), 6);
    }

    #[test]
    fn frame_hex_formats_protocol_bytes_for_audit_logs() {
        assert_eq!(frame_hex(&[0xAA, 0x02, 0x00, 0xAC]), "AA 02 00 AC");
    }

    #[test]
    fn selected_device_defaults_to_simulator() {
        assert_eq!(selected_device_id(None), "softui-sim-01");
        assert_eq!(
            selected_device_id(Some("serial:COM8".to_string())),
            "serial:COM8"
        );
    }

    #[test]
    fn newly_exposed_control_commands_have_legacy_frames() {
        let home = protocol::encode_home_command(2, 1).expect("home");
        let sensor = protocol::encode_sensor_calibration(2, -3.25).expect("sensor");
        let bend = protocol::encode_bend_command(0, 12.34, 3, 56.78).expect("bend");
        let active = protocol::encode_active_control_tick();

        assert_eq!(frame_hex(&home), "AA 04 06 02 01 00 00 00 00 B7");
        assert_eq!(frame_hex(&sensor), "BB 03 03 02 FE BB 7C");
        assert_eq!(frame_hex(&bend), "AA 05 06 00 04 D2 03 16 2E D2");
        assert_eq!(frame_hex(&active), "AA 06 02 02 00 B4");
    }

    #[test]
    fn simulator_motion_commands_require_enabled_snapshot() {
        let mut data = default_persisted_state();
        data.connected = false;
        let disabled = build_snapshot(&data);

        assert!(!snapshot_allows_command(
            &disabled,
            CommandSafety::Connected
        ));
        assert!(!snapshot_allows_command(&disabled, CommandSafety::Enabled));

        data.connected = true;
        let enabled = build_snapshot(&data);

        assert!(snapshot_allows_command(&enabled, CommandSafety::Connected));
        assert!(snapshot_allows_command(&enabled, CommandSafety::Enabled));
    }

    #[test]
    fn serial_motion_commands_require_device_enabled_feedback() {
        let mut runtime = device::RuntimeStatus {
            state: device::DeviceConnectionState::Ready,
            last_status: Some(protocol::DeviceStatus {
                num_motors: 0,
                num_sensors: 0,
                motors: vec![],
                sensors: vec![],
                bend_angle1_deg: 0.0,
                bend_angle2_deg: 0.0,
                system_state: 0,
            }),
            received_frames: 1,
            protocol_errors: 0,
            sent_commands: 0,
            pending_commands: 0,
            reconnect_attempts: 0,
            last_frame_ms: 0,
            last_command_ms: 0,
            command_high_watermark: 0,
            emergency_latched: false,
            control_enabled: false,
            last_error: None,
            last_error_code: None,
        };

        assert!(runtime_allows_command(&runtime, CommandSafety::Connected));
        assert!(!runtime_allows_command(&runtime, CommandSafety::Enabled));

        runtime.last_status.as_mut().expect("status").system_state = 1;
        assert!(runtime_allows_command(&runtime, CommandSafety::Enabled));

        runtime.emergency_latched = true;
        assert!(!runtime_allows_command(&runtime, CommandSafety::Connected));
        assert!(!runtime_allows_command(&runtime, CommandSafety::Enabled));
        runtime.emergency_latched = false;

        runtime.state = device::DeviceConnectionState::Reconnecting;
        assert!(!runtime_allows_command(&runtime, CommandSafety::Connected));
        assert!(!runtime_allows_command(&runtime, CommandSafety::Enabled));
    }

    #[test]
    fn live_serial_frames_override_simulator_snapshot() {
        let data = default_persisted_state();
        let mut snapshot = build_snapshot(&data);
        let record = device::DeviceConnectionRecord {
            device_id: "serial:COM7".to_string(),
            connection_id: "conn-serial-1".to_string(),
            port_name: "COM7".to_string(),
            baud_rate: 9_600,
            state: device::DeviceConnectionState::Ready,
            connected_at_ms: 1,
        };
        let protocol_status = protocol::DeviceStatus {
            num_motors: 1,
            num_sensors: 1,
            motors: vec![protocol::MotorData {
                position_mm: 12.0,
                velocity_mm_per_sec: 3.0,
                acceleration_mm_per_sec2: 1.0,
                status: 1,
            }],
            sensors: vec![protocol::SensorData {
                x: 1.0,
                y: 2.0,
                z: 3.0,
            }],
            bend_angle1_deg: 4.0,
            bend_angle2_deg: 5.0,
            system_state: 1,
        };
        let runtime_status = device::RuntimeStatus {
            state: device::DeviceConnectionState::Ready,
            last_status: Some(protocol_status.clone()),
            received_frames: 1,
            protocol_errors: 0,
            sent_commands: 0,
            pending_commands: 0,
            reconnect_attempts: 0,
            last_frame_ms: 0,
            last_command_ms: 0,
            command_high_watermark: 0,
            emergency_latched: false,
            control_enabled: false,
            last_error: None,
            last_error_code: None,
        };
        let live = vec![make_device_frame(
            &record,
            &protocol_status,
            &runtime_status,
            88,
        )];

        overlay_live_frames(&mut snapshot, &live);

        assert_eq!(snapshot.live.selected_device_id, "serial:COM7");
        let latest = snapshot.live.latest.expect("latest frame");
        assert_eq!(latest.motors.len(), 1);
        assert_eq!(snapshot.dashboard.connected_devices, 1);
        assert_eq!(snapshot.connection.active_profile_name, "Serial runtime");
    }

    #[test]
    fn diagnostics_summary_aggregates_live_and_runtime_state() {
        let stats = live::FrameStats {
            stored_frames: 12,
            capacity: 120,
            total_frames: 44,
            dropped_frames: 2,
            frame_rate_hz: 19.6,
        };
        let runtime = device::RuntimeStatus {
            state: device::DeviceConnectionState::EmergencyStopped,
            last_status: None,
            received_frames: 10,
            protocol_errors: 3,
            sent_commands: 5,
            pending_commands: 2,
            reconnect_attempts: 1,
            last_frame_ms: 100,
            last_command_ms: 110,
            command_high_watermark: 4,
            emergency_latched: true,
            control_enabled: false,
            last_error: Some("checksum failed".to_string()),
            last_error_code: Some("PROTOCOL_FRAME".to_string()),
        };

        let summary = diagnostics_summary(&stats, &[("serial:COM7".to_string(), runtime)]);

        assert_eq!(summary.stored_frames, 12);
        assert_eq!(summary.total_frames, 44);
        assert_eq!(summary.pending_commands, 2);
        assert_eq!(summary.protocol_errors, 3);
        assert!(summary.emergency_latched);
        assert_eq!(summary.last_error.as_deref(), Some("checksum failed"));
    }
}

/// 后台设备轮询线程：桌面模式和 HTTP 网关模式共用，避免两份实现走偏。
fn spawn_device_poller(app_state: &AppState) {
    // 先把需要的 Arc 克隆出来，线程里不再借用 app_state。
    let app_state = app_state;
    let bg_devices = app_state.devices.clone();
    let bg_dynamics = app_state.dynamics_runtime.clone();
    let bg_live_ring = app_state.live_ring.clone();
    let bg_recorder = app_state.recorder.clone();
    let bg_playback = app_state.playback.clone();
    let bg_control = app_state.control_runtime.clone();
    let bg_sqlite = app_state.sqlite.clone();
    let bg_worker_stop = app_state.worker_stop.clone();


    std::thread::Builder::new()
        .name("device-poller".into())
        .spawn(move || {
            let mut seq: u64 = 0;
            while !bg_worker_stop.load(Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_millis(50));
                let results = match bg_devices.lock() {
                    Ok(mut d) => d.poll_all(),
                    Err(_) => continue,
                };
                for result in &results {
                    if let Some(error) = &result.error {
                        let _ = bg_sqlite.insert_log(&storage::LogRow {
                            id: now_ms(),
                            timestamp_ms: now_ms(),
                            level: "error".to_string(),
                            scope: "serial".to_string(),
                            message: result
                                .error_code
                                .as_deref()
                                .map(|code| format!("{code}: {error}"))
                                .unwrap_or_else(|| error.clone()),
                            device_id: Some(result.record.device_id.clone()),
                            frame_hex: None,
                        });
                    }
                    if let Some(status) = &result.status {
                        seq = seq.saturating_add(1);
                        let frame =
                            make_device_frame(&result.record, status, &result.runtime, seq);
                        // Skip recording during playback
                        let is_playback = bg_playback
                            .lock()
                            .map(|p| p.status().active)
                            .unwrap_or(false);
                        let dynamics_result = bg_dynamics
                            .lock()
                            .map_err(|_| ())
                            .and_then(|mut dynamics| dynamics.step_frame(&frame, 50).map_err(|_| ()))
                            .ok();
                        if let Ok(mut control) = bg_control.lock() {
                            let safety = control::SafetyInput {
                                connected: matches!(
                                    result.runtime.state,
                                    device::DeviceConnectionState::Ready
                                        | device::DeviceConnectionState::Enabled
                                ),
                                enabled: frame.system_enabled,
                                emergency_latched: result.runtime.emergency_latched,
                                playback_mode: is_playback,
                            };
                            let dynamics_input = dynamics::dynamics_input_from_frame(&frame, 50);
                            let feedback = control::ControlFeedback {
                                target_curvature_per_m: dynamics_input
                                    .sections
                                    .first()
                                    .map(|section| section.curvature_per_m)
                                    .unwrap_or(0.0),
                                dynamics_input,
                                dynamics_output: dynamics_result.clone(),
                                pressure: frame
                                    .sensors
                                    .first()
                                    .map(|sensor| sensor.filtered[2])
                                    .unwrap_or(0.0),
                            };
                            control.step_cycle(feedback, safety, 50);
                        }
                        if !is_playback {
                            if let Ok(mut rec) = bg_recorder.lock() {
                                let rec_status = rec.status();
                                rec.write_frame_calib(
                                    &frame,
                                    &make_calib_row(&frame, dynamics_result.as_ref()),
                                );
                                if rec_status.active && !rec_status.paused {
                                    let _ = bg_sqlite.insert_snapshot(
                                        &rec_status.session_id,
                                        frame.sequence,
                                        frame.received_at_ms,
                                        &frame.device_id,
                                        &frame,
                                    );
                                    if let Some(output) = &dynamics_result {
                                        let _ = bg_sqlite.insert_dynamics_output(
                                            &rec_status.session_id,
                                            frame.sequence,
                                            frame.received_at_ms,
                                            &frame.device_id,
                                            output,
                                        );
                                    }
                                }
                            }
                        }
                        if let Ok(mut ring) = bg_live_ring.lock() {
                            ring.push(frame);
                        }
                    }
                }
            }
        })
        .expect("failed to spawn device poller");
}

#[cfg(feature = "desktop")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let state_path = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir())
                .join("softui-state.json");
            let app_state = AppState::new(state_path);
            spawn_device_poller(&app_state);
            app.manage(app_state);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            bootstrap_state,
            change_password,
            connect_device,
            create_user,
            current_auth_session,
            delete_session,
            delete_connection_profile,
            device_runtime_status,
            disconnect_device,
            diagnostics_bundle,
            fetch_live_latest,
            fetch_live_window,
            fetch_live_stats,
            list_connected_devices,
            list_connection_profiles,
            list_serial_ports,
            list_sessions,
            list_users,
            list_clients,
            list_my_sessions,
            login,
            import_model,
            lookup_tip_pose_shape,
            model_status,
            reset_model,
            logout,
            calibrate_sensor,
            configure_cycle_life,
            compute_dynamics_snapshot,
            compute_live_dynamics,
            control_runtime_status,
            dynamics_status,
            playback_get_frame,
            playback_get_window,
            playback_load,
            playback_pause,
            playback_play,
            playback_commands,
            playback_recent_window,
            playback_seek,
            playback_step_frame,
            playback_set_speed,
            playback_status,
            playback_stop,
            pause_recording,
            read_session_frames,
            recorder_status,
            rename_session,
            reset_dynamics,
            resume_recording,
            send_active_control_tick,
            send_bend_command,
            send_curvature_command,
            send_home_command,
            send_motor_command,
            send_multi_motor_command,
            send_tip_pose_command,
            save_connection_profile,
            preview_legacy_migration,
            run_legacy_migration,
            set_user_disabled,
            set_user_device_limit,
            set_user_role,
            delete_user,
            set_registration_mode,
            approve_user,
            pending_user_count,
            register,
            registration_mode,
            revoke_client,
            revoke_my_session,
            revoke_user_sessions,
            start_recording,
            stop_recording,
            start_cycle_life,
            stop_cycle_life,
            submit_system_control,
            tick_snapshot,
            toggle_connection,
            update_dynamics_config,
            update_pid_control,
            update_session_metadata,
            update_settings,
            set_theme
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}



/* ── server 模式：无 GUI 的 HTTP 网关 ─────────────────────────────────
 * 前端原来走 Tauri IPC：invoke(cmd, args)。
 * 这里换成 POST /rpc  {"cmd":"...","args":{...}}，复用同一批命令函数。
 *
 * 为什么不需要 WebSocket：前端全程轮询（fetch_live_latest 500ms、
 * fetch_live_window 100ms），没有任何事件订阅，请求-响应模型就够。
 *
 * 为什么手写 HTTP/1.1 而不用 axum+tokio：只要一个端点，引入它们会多出
 * 上百个依赖和几百 MB 磁盘，而本机磁盘紧张。std 足够。
 * ──────────────────────────────────────────────────────────────────── */

#[cfg(not(feature = "desktop"))]
#[derive(Clone, Copy)]
pub struct State<'a, T>(pub &'a T);

#[cfg(not(feature = "desktop"))]
impl<'a, T> std::ops::Deref for State<'a, T> {
    type Target = T;
    fn deref(&self) -> &T {
        self.0
    }
}

/// `device_id` → `deviceId`。Tauri 会把 JS 的 camelCase 映射到 Rust 的
/// snake_case，网关必须做同样的事，否则这些参数一律反序列化失败。
#[cfg(not(feature = "desktop"))]
fn to_camel(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut upper = false;
    for ch in name.chars() {
        if ch == '_' {
            upper = true;
            continue;
        }
        if upper {
            out.extend(ch.to_uppercase());
            upper = false;
        } else {
            out.push(ch);
        }
    }
    out
}

#[cfg(not(feature = "desktop"))]
fn arg_value<'a>(args: &'a serde_json::Value, name: &str) -> Option<&'a serde_json::Value> {
    if let Some(v) = args.get(name) {
        return Some(v);
    }
    let camel = to_camel(name);
    if camel != name {
        args.get(&camel)
    } else {
        None
    }
}

#[cfg(not(feature = "desktop"))]
fn arg<T: serde::de::DeserializeOwned>(args: &serde_json::Value, name: &str) -> Result<T, String> {
    let v = arg_value(args, name).ok_or_else(|| format!("缺少参数 `{name}`"))?;
    serde_json::from_value(v.clone()).map_err(|e| format!("参数 `{name}` 解析失败：{e}"))
}

#[cfg(not(feature = "desktop"))]
fn arg_opt<T: serde::de::DeserializeOwned>(
    args: &serde_json::Value,
    name: &str,
) -> Result<Option<T>, String> {
    match arg_value(args, name) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(v) => serde_json::from_value(v.clone())
            .map(Some)
            .map_err(|e| format!("参数 `{name}` 解析失败：{e}")),
    }
}

/// 命令分发：74 个分支与 `#[tauri::command]` 函数一一对应。
#[cfg(not(feature = "desktop"))]
fn dispatch(
    state: &AppState,
    cmd: &str,
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let st = State(state);
    match cmd {
        "model_status" => {
            serde_json::to_value(model_status()).map_err(|e| e.to_string())
        }
        "import_model" => {
            let bytes: Vec<u8> = arg(args, "bytes")?;
            let name: Option<String> = arg_opt(args, "name")?;
            import_model(bytes, name).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "reset_model" => {
            reset_model().and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "lookup_tip_pose_shape" => {
            let request: TipPoseShapeRequest = arg(args, "request")?;
            lookup_tip_pose_shape(request).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "app_info" => {
            serde_json::to_value(app_info()).map_err(|e| e.to_string())
        }
        "current_auth_session" => {
            current_auth_session(st).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "login" => {
            let request: auth::LoginRequest = arg(args, "request")?;
            login(st, request).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "logout" => {
            logout(st).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "list_users" => {
            list_users(st).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "create_user" => {
            let request: auth::CreateUserRequest = arg(args, "request")?;
            create_user(st, request).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "change_password" => {
            let request: auth::ChangePasswordRequest = arg(args, "request")?;
            change_password(st, request).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "set_user_disabled" => {
            let username: String = arg(args, "username")?;
            let disabled: bool = arg(args, "disabled")?;
            set_user_disabled(st, username, disabled).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "list_clients" => {
            list_clients(st).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "revoke_client" => {
            let session_id: String = arg(args, "session_id")?;
            revoke_client(st, session_id).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "revoke_user_sessions" => {
            let username: String = arg(args, "username")?;
            revoke_user_sessions(st, username).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "set_user_device_limit" => {
            let username: String = arg(args, "username")?;
            let max_devices: u32 = arg(args, "max_devices")?;
            set_user_device_limit(st, username, max_devices).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "set_user_role" => {
            let username: String = arg(args, "username")?;
            let role: auth::Role = arg(args, "role")?;
            set_user_role(st, username, role).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "delete_user" => {
            let username: String = arg(args, "username")?;
            delete_user(st, username).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "registration_mode" => {
            serde_json::to_value(registration_mode(st)).map_err(|e| e.to_string())
        }
        "list_my_sessions" => {
            list_my_sessions(st).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "revoke_my_session" => {
            let session_id: String = arg(args, "session_id")?;
            revoke_my_session(st, session_id).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "register" => {
            let request: auth::RegisterRequest = arg(args, "request")?;
            register(st, request).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "approve_user" => {
            let username: String = arg(args, "username")?;
            approve_user(st, username).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "pending_user_count" => {
            pending_user_count(st).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "set_registration_mode" => {
            let mode: auth::RegistrationMode = arg(args, "mode")?;
            set_registration_mode(st, mode).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "bootstrap_state" => {
            serde_json::to_value(bootstrap_state(st)).map_err(|e| e.to_string())
        }
        "tick_snapshot" => {
            serde_json::to_value(tick_snapshot(st)).map_err(|e| e.to_string())
        }
        "toggle_connection" => {
            serde_json::to_value(toggle_connection(st)).map_err(|e| e.to_string())
        }
        "set_theme" => {
            let theme: ThemeMode = arg(args, "theme")?;
            serde_json::to_value(set_theme(st, theme)).map_err(|e| e.to_string())
        }
        "update_settings" => {
            let settings: SettingsState = arg(args, "settings")?;
            update_settings(st, settings).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "diagnostics_bundle" => {
            diagnostics_bundle(st).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "preview_legacy_migration" => {
            let source_dir: String = arg(args, "source_dir")?;
            let target_dir: Option<String> = arg_opt(args, "target_dir")?;
            preview_legacy_migration(st, source_dir, target_dir).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "run_legacy_migration" => {
            let source_dir: String = arg(args, "source_dir")?;
            let target_dir: Option<String> = arg_opt(args, "target_dir")?;
            run_legacy_migration(st, source_dir, target_dir).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "list_serial_ports" => {
            list_serial_ports().and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "list_connected_devices" => {
            list_connected_devices(st).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "connect_device" => {
            let request: ConnectDeviceRequest = arg(args, "request")?;
            connect_device(st, request).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "disconnect_device" => {
            let device_id: String = arg(args, "device_id")?;
            disconnect_device(st, device_id).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "fetch_live_window" => {
            let count: u32 = arg(args, "count")?;
            serde_json::to_value(fetch_live_window(st, count)).map_err(|e| e.to_string())
        }
        "fetch_live_stats" => {
            serde_json::to_value(fetch_live_stats(st)).map_err(|e| e.to_string())
        }
        "fetch_live_latest" => {
            serde_json::to_value(fetch_live_latest(st)).map_err(|e| e.to_string())
        }
        "device_runtime_status" => {
            let device_id: String = arg(args, "device_id")?;
            device_runtime_status(st, device_id).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "submit_system_control" => {
            let request: SystemControlRequest = arg(args, "request")?;
            submit_system_control(st, request).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "send_motor_command" => {
            let request: MotorControlRequest = arg(args, "request")?;
            send_motor_command(st, request).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "send_home_command" => {
            let request: HomeCommandRequest = arg(args, "request")?;
            send_home_command(st, request).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "send_multi_motor_command" => {
            let request: MultiMotorCommandRequest = arg(args, "request")?;
            send_multi_motor_command(st, request).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "send_curvature_command" => {
            let request: CurvatureCommandRequest = arg(args, "request")?;
            send_curvature_command(st, request).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "send_tip_pose_command" => {
            let request: TipPoseCommandRequest = arg(args, "request")?;
            send_tip_pose_command(st, request).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "calibrate_sensor" => {
            let request: SensorCalibrationRequest = arg(args, "request")?;
            calibrate_sensor(st, request).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "send_bend_command" => {
            let request: BendCommandRequest = arg(args, "request")?;
            send_bend_command(st, request).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "send_active_control_tick" => {
            let request: ActiveControlRequest = arg(args, "request")?;
            send_active_control_tick(st, request).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "control_runtime_status" => {
            control_runtime_status(st).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "update_pid_control" => {
            let config: control::PidConfig = arg(args, "config")?;
            update_pid_control(st, config).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "configure_cycle_life" => {
            let config: control::CycleLifeConfig = arg(args, "config")?;
            configure_cycle_life(st, config).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "start_cycle_life" => {
            let request: CycleLifeStartRequest = arg(args, "request")?;
            start_cycle_life(st, request).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "stop_cycle_life" => {
            let reason: Option<String> = arg_opt(args, "reason")?;
            stop_cycle_life(st, reason).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "dynamics_status" => {
            dynamics_status(st).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "compute_live_dynamics" => {
            compute_live_dynamics(st).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "compute_dynamics_snapshot" => {
            compute_dynamics_snapshot(st).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "update_dynamics_config" => {
            let config: dynamics::DynamicsConfig = arg(args, "config")?;
            update_dynamics_config(st, config).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "reset_dynamics" => {
            reset_dynamics(st).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "start_recording" => {
            let name: Option<String> = arg_opt(args, "name")?;
            start_recording(st, name).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "stop_recording" => {
            stop_recording(st).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "pause_recording" => {
            pause_recording(st).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "resume_recording" => {
            resume_recording(st).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "recorder_status" => {
            serde_json::to_value(recorder_status(st)).map_err(|e| e.to_string())
        }
        "list_sessions" => {
            serde_json::to_value(list_sessions(st)).map_err(|e| e.to_string())
        }
        "playback_load" => {
            let session_id: String = arg(args, "session_id")?;
            playback_load(st, session_id).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "playback_play" => {
            playback_play(st).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "playback_pause" => {
            playback_pause(st).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "playback_stop" => {
            playback_stop(st).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "playback_step_frame" => {
            let delta: i64 = arg(args, "delta")?;
            playback_step_frame(st, delta).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "playback_seek" => {
            let ms: u64 = arg(args, "ms")?;
            playback_seek(st, ms).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "playback_set_speed" => {
            let speed: f64 = arg(args, "speed")?;
            playback_set_speed(st, speed).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "playback_recent_window" => {
            let window_ms: u64 = arg(args, "window_ms")?;
            playback_recent_window(st, window_ms).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "playback_commands" => {
            playback_commands(st).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "playback_status" => {
            serde_json::to_value(playback_status(st)).map_err(|e| e.to_string())
        }
        "playback_get_frame" => {
            serde_json::to_value(playback_get_frame(st)).map_err(|e| e.to_string())
        }
        "playback_get_window" => {
            let count: u32 = arg(args, "count")?;
            serde_json::to_value(playback_get_window(st, count)).map_err(|e| e.to_string())
        }
        "delete_session" => {
            let id: String = arg(args, "id")?;
            delete_session(st, id).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "rename_session" => {
            let id: String = arg(args, "id")?;
            let name: String = arg(args, "name")?;
            rename_session(st, id, name).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "update_session_metadata" => {
            let id: String = arg(args, "id")?;
            let meta: session::SessionMetadata = arg(args, "meta")?;
            update_session_metadata(st, id, meta).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "read_session_frames" => {
            let id: String = arg(args, "id")?;
            let max_count: Option<u32> = arg_opt(args, "max_count")?;
            read_session_frames(st, id, max_count).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "list_connection_profiles" => {
            serde_json::to_value(list_connection_profiles(st)).map_err(|e| e.to_string())
        }
        "save_connection_profile" => {
            let profile: profiles::ConnectionProfile = arg(args, "profile")?;
            save_connection_profile(st, profile).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "delete_connection_profile" => {
            let id: String = arg(args, "id")?;
            delete_connection_profile(st, id).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "webserial_open" => {
            let port_name: String = arg(args, "port_name")?;
            let baud_rate: Option<u32> = arg_opt(args, "baud_rate")?;
            let device_name: Option<String> = arg_opt(args, "device_name")?;
            let client_id: Option<String> = arg_opt(args, "client_id")?;
            webserial_open(st, port_name, baud_rate, device_name, client_id)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "webserial_push" => {
            let port_name: String = arg(args, "port_name")?;
            let bytes: Vec<u8> = arg(args, "bytes")?;
            let seq: Option<u64> = arg_opt(args, "seq")?;
            webserial_push(port_name, bytes, seq)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "webserial_wait_tx" => {
            let port_name: String = arg(args, "port_name")?;
            let timeout_ms: Option<u64> = arg_opt(args, "timeout_ms")?;
            webserial_wait_tx(port_name, timeout_ms)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "webserial_take_tx" => {
            let port_name: String = arg(args, "port_name")?;
            webserial_take_tx(port_name)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "webserial_close" => {
            let port_name: String = arg(args, "port_name")?;
            webserial_close(st, port_name)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "sync_hello" => {
            let client_id: String = arg(args, "client_id")?;
            let label: String = arg(args, "label")?;
            sync_hello(client_id, label)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "sync_poll" => {
            let client_id: String = arg(args, "client_id")?;
            let label: String = arg(args, "label")?;
            let page: String = arg(args, "page")?;
            let since: u64 = arg(args, "since")?;
            sync_poll(client_id, label, page, since)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "sync_emit" => {
            let client_id: String = arg(args, "client_id")?;
            let event: serde_json::Value = arg(args, "event")?;
            sync_emit(client_id, event)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "drag_publish" => {
            let client_id: String = arg(args, "client_id")?;
            let payload: serde_json::Value = arg(args, "payload")?;
            drag_publish(client_id, payload)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "drag_latest" => {
            drag_latest().and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "ui_publish" => {
            let client_id: String = arg(args, "client_id")?;
            let key: String = arg(args, "key")?;
            let payload: serde_json::Value = arg(args, "payload")?;
            ui_publish(client_id, key, payload)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "ui_state" => {
            ui_snapshot().and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "ui_wait" => {
            let since: u64 = arg(args, "since")?;
            let timeout_ms: Option<u64> = arg_opt(args, "timeout_ms")?;
            ui_wait(since, timeout_ms.unwrap_or(20_000))
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "simulator_start" => {
            simulator_start(st).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "simulator_stop" => {
            simulator_stop(st).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "frame_ingest" => {
            let frame: DeviceSnapshot = arg(args, "frame")?;
            frame_ingest(st, frame).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        other => Err(format!("未知命令：{other}")),
    }
}

#[cfg(not(feature = "desktop"))]
fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

#[cfg(not(feature = "desktop"))]
fn write_json(stream: &mut std::net::TcpStream, status: u16, body: &str) {
    use std::io::Write;
    let head = format!(
        "HTTP/1.1 {status} OK\r\n\
         Content-Type: application/json; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         Cache-Control: no-store\r\n\r\n",
        body.as_bytes().len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

#[cfg(not(feature = "desktop"))]
fn handle_rpc(stream: &mut std::net::TcpStream, state: &Arc<AppState>) {
    use std::io::Read;
    let mut buf: Vec<u8> = Vec::with_capacity(8192);
    let mut tmp = [0u8; 16384];
    let header_end = loop {
        match stream.read(&mut tmp) {
            Ok(0) => return,
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
            Err(_) => return,
        }
        if let Some(pos) = find_header_end(&buf) {
            break pos + 4;
        }
        if buf.len() > 128 * 1024 {
            return;
        }
    };

    let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split(' ');
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");
    let mut content_length = 0usize;
    let mut token: Option<String> = None;
    let mut client_ip = String::new();
    let mut user_agent = String::new();
    for line in lines {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let value = v.trim();
        if k.eq_ignore_ascii_case("content-length") {
            content_length = value.parse().unwrap_or(0);
        } else if k.eq_ignore_ascii_case("x-softui-token") {
            if !value.is_empty() {
                token = Some(value.to_string());
            }
        } else if k.eq_ignore_ascii_case("x-softui-client-ip") {
            // 真实客户端 IP 由 Node 网关从 CF-Connecting-IP 透传进来：
            // Rust 只看到 127.0.0.1，拿不到公网来源。
            client_ip = value.to_string();
        } else if k.eq_ignore_ascii_case("user-agent") {
            user_agent = value.to_string();
        }
    }
    // 把「这次请求属于哪台设备」放进线程局部上下文：命令层不必改签名
    // 就能解析出本设备自己的会话（见 `AppState::session`）。
    request_ctx::set(token, client_ip, user_agent);

    if method == "GET" && path == "/health" {
        return write_json(
            stream,
            200,
            "{\"ok\":true,\"data\":{\"status\":\"up\",\"mode\":\"server\"}}",
        );
    }
    if method != "POST" || path != "/rpc" {
        return write_json(stream, 200, "{\"ok\":false,\"error\":\"only POST /rpc\"}");
    }

    let mut body = buf[header_end..].to_vec();
    while body.len() < content_length {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => body.extend_from_slice(&tmp[..n]),
            Err(_) => break,
        }
    }

    let parsed: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(error) => {
            let payload = serde_json::json!({ "ok": false, "error": format!("请求体不是合法 JSON：{error}") });
            return write_json(stream, 200, &payload.to_string());
        }
    };
    let cmd = parsed.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
    let args = parsed
        .get("args")
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    let payload = match dispatch(state, cmd, &args) {
        Ok(data) => serde_json::json!({ "ok": true, "data": data }),
        Err(error) => serde_json::json!({ "ok": false, "error": error }),
    };
    write_json(stream, 200, &payload.to_string());
}

/// server 模式入口：绑定 127.0.0.1:8787，只暴露 POST /rpc 与 GET /health。
#[cfg(not(feature = "desktop"))]
pub fn run_server() {
    let addr = std::env::var("SOFTUI_ADDR").unwrap_or_else(|_| "127.0.0.1:8787".to_string());
    let state_path = std::env::var("SOFTUI_STATE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("softui-state.json"));

    let app_state = Arc::new(AppState::new(state_path));
    spawn_device_poller(&app_state);

    let listener = match std::net::TcpListener::bind(&addr) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("[softui-server] 无法绑定 {addr}：{error}");
            std::process::exit(1);
        }
    };
    println!("[softui-server] 监听 http://{addr}  (POST /rpc, GET /health)");

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let shared = app_state.clone();
                std::thread::spawn(move || {
                    let mut stream = stream;
                    let _ = stream.set_nodelay(true);
                    handle_rpc(&mut stream, &shared);
                });
            }
            Err(_) => continue,
        }
    }
}
