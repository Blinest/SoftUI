pub mod auth;
pub mod control;
pub mod device;
pub mod dynamics;
pub mod kappatable;
pub mod live;
pub mod model;
pub mod playback;
pub mod posetable;
pub mod profiles;
pub mod protocol;
pub mod session;
pub mod storage;
pub mod tablecore;
pub mod vctable;
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

/// 一路张力通道。
///
/// 指令集里这不是「三轴传感器」，状态帧的每个 `x/y/z` 三元组其实是**一条通道**：
///   x = 滤波 + 通道平衡后的张力，y = 原始值，z = 保留（不参与任何展示）。
/// 所以这里只有「滤波值 / 原始值」两个数，没有第三轴。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SensorState {
    id: u32,
    /// 原始值：未经滤波与通道平衡。
    raw_value: f64,
    /// 滤波 + 通道平衡后的张力。
    filtered_value: f64,
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
    /// 软删除标记（回收站）✓ —— 老状态文件没有这两个字段，按"未删除"读入 ✓。
    #[serde(default)]
    deleted: bool,
    #[serde(default)]
    deleted_at_ms: u64,
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
                let v = s.filtered_value;
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
        deleted: false,
        deleted_at_ms: 0,
    }
}

fn adapt_motor(id: u32, motor: &protocol::MotorData) -> MotorState {
    MotorState {
        id,
        position_mm: motor.position_mm,
        velocity_mm_per_sec: motor.velocity_mm_per_sec,
        acceleration_mm_per_sec2: motor.acceleration_mm_per_sec2,
        running: motor.status != 0,
        // ⚠️ 报文里**没有**电机目标字段（MotorData 只有 位置/速度/加速度/状态），
        // 这是一个**硬编码占位**，不是真实目标。界面已不再显示它（改用后端回传的
        // 真实下发目标），但字段还在类型里，留给需要"近似目标"的旧消费方。
        target_position_mm: motor.position_mm + 1.5,
    }
}

fn adapt_sensor(id: u32, sensor: &protocol::SensorData, seq: u64) -> SensorState {
    SensorState {
        id,
        // 固件的口径：**x = 压力传感器的实际值（未滤波），y = 滤波值**。
        //
        // ⚠️ 这与指令集文档 §5.1 的写法相反（文档写的是 x=滤波、y=原始）。以固件实际
        // 报文为准 —— 文档那条我已在笔记里提出来待确认。
        //
        // 下面两行是整个上位机里**唯一**做这个映射的地方（前端桩的 adaptSensor 是同源
        // 副本，两边必须一起改）。映射写错的表现很难查：数值看着都正常，只是"滤波"和
        // "实际"两列互换了，而滤波值本来就贴近实际值，肉眼几乎看不出。
        raw_value: sensor.x,
        filtered_value: sensor.y,
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

/// 上行协议版本的展示文案。
///
/// 下位机上电默认发 V1（`0xBB`），上位机发过 `AA 09 01 02` 之后切 V2（`0x55` + 设备 ID）。
/// 界面上必须显示**实际在跑**的那个 —— 旧实现把 "Legacy V1" 写死，协商成功之后
/// 仍然显示 V1，等于把唯一的协议状态指示也变成了假信息。
fn protocol_version_label(version: u8) -> String {
    if version >= 2 {
        "V2 (0x55)".to_string()
    } else {
        "Legacy V1 (0xBB)".to_string()
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
            .map(|i| adapt_sensor((i + 1) as u32, &protocol::SensorData { x: 0.0, y: 0.0 }, seq))
            .collect::<Vec<_>>();
        return DeviceSnapshot {
            device_id: "softui-sim-01".to_string(),
            connection_id: "conn-01".to_string(),
            received_at_ms: now_ms(),
            sequence: seq,
            protocol_version: "未连接".to_string(),
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
        protocol_version: protocol_version_label(runtime.status().protocol_version),
        system_enabled: connected && status.system_state != 0,
        motors,
        sensors,
        bend: BendSnapshot {
            section1: adapt_bend(status.scale, "up", seq),
            section2: adapt_bend(status.arm_bend, "right", seq),
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
        // 实际在跑的协议版本：下位机上电发 V1，收到 `AA 09 01 02` 后切 V2。
        protocol_version: protocol_version_label(runtime.protocol_version),
        system_enabled: status.system_state != 0,
        motors,
        sensors,
        bend: BendSnapshot {
            section1: adapt_bend(status.scale, "up", seq),
            section2: adapt_bend(status.arm_bend, "right", seq),
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
/// **AI 配置**（DeepSeek ✓）—— 存在服务器上 ✓，**前端永远拿不到 Key** ✓。
///
/// 为什么不在前端调 API ✗：前端代码是公开的 ✓，Key 会泄露 ✓。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiConfig {
    api_key: String,
    #[serde(default = "default_ai_base_url")]
    base_url: String,
    #[serde(default = "default_ai_model")]
    model: String,
}

fn default_ai_base_url() -> String {
    "https://api.deepseek.com/chat/completions".to_string()
}

fn default_ai_model() -> String {
    "deepseek-chat".to_string()
}

fn ai_config_path() -> Option<std::path::PathBuf> {
    let root = std::env::var("SOFTUI_STATE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("softui-state.json"));
    Some(root.parent()?.join("ai-config.json"))
}

/// 读配置 ✓（没有文件时回落到环境变量 ✓，方便部署 ✓）
fn read_ai_config() -> Result<AiConfig, String> {
    if let Some(path) = ai_config_path() {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(config) = serde_json::from_str::<AiConfig>(&text) {
                if !config.api_key.is_empty() {
                    return Ok(config);
                }
            }
        }
    }
    let key = std::env::var("DEEPSEEK_API_KEY").unwrap_or_default();
    if key.is_empty() {
        return Err("还没有配置 AI：请在 data/ai-config.json 写入 {\"apiKey\":\"sk-…\"} 或设置 DEEPSEEK_API_KEY".to_string());
    }
    Ok(AiConfig {
        api_key: key,
        base_url: default_ai_base_url(),
        model: default_ai_model(),
    })
}

/// 保存 AI 配置 ✓（前端只传 Key ✓，不回传 ✗）
fn save_ai_config(api_key: String, base_url: Option<String>, model: Option<String>) -> Result<bool, String> {
    let path = ai_config_path().ok_or_else(|| "无法定位配置目录".to_string())?;
    let config = AiConfig {
        api_key,
        base_url: base_url.unwrap_or_else(default_ai_base_url),
        model: model.unwrap_or_else(default_ai_model),
    };
    let text = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
    std::fs::write(path, text).map_err(|error| format!("写入失败：{error}"))?;
    Ok(true)
}

/// 只告诉前端"配没配"✓，**不返回 Key** ✗
fn ai_config_status() -> serde_json::Value {
    match read_ai_config() {
        Ok(config) => serde_json::json!({
            "configured": true,
            "model": config.model,
            "baseUrl": config.base_url,
        }),
        Err(_) => serde_json::json!({ "configured": false }),
    }
}

/// **按账号的 Key 表** ✓ —— `data/ai-keys.json`：`{ "user1": "sk-…", … }`
///
/// 为什么按账号 ✗：Key 是**账号的配额** ✓，混用会让 A 用掉 B 的额度 ✗。
/// 没单独配的账号回落到全局 Key ✓（`ai-config.json` 或环境变量 ✓）。
fn ai_keys_path() -> Option<std::path::PathBuf> {
    let root = std::env::var("SOFTUI_STATE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("softui-state.json"));
    Some(root.parent()?.join("ai-keys.json"))
}

/// 某个账号自己的 Key + 模型 ✓（**互不干扰** ✗ —— 不再覆盖全局配置 ✓）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiUserKey {
    api_key: String,
    #[serde(default = "default_ai_model")]
    model: String,
    #[serde(default)]
    base_url: Option<String>,
}

fn read_ai_key_map() -> std::collections::HashMap<String, AiUserKey> {
    ai_keys_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<std::collections::HashMap<String, AiUserKey>>(&text).ok())
        .unwrap_or_default()
}

fn write_ai_key_map(map: &std::collections::HashMap<String, AiUserKey>) -> Result<(), String> {
    let path = ai_keys_path().ok_or_else(|| "无法定位配置目录".to_string())?;
    let text = serde_json::to_string_pretty(map).map_err(|error| error.to_string())?;
    std::fs::write(&path, text).map_err(|error| format!("写入失败：{error}"))?;
    Ok(())
}

/// 给某个账号设 Key ✓（空字符串 = 删除该账号的 Key ✓）
#[cfg_attr(feature = "desktop", tauri::command)]
fn set_ai_key(
    username: String,
    api_key: String,
    model: Option<String>,
    base_url: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut map = read_ai_key_map();
    if api_key.trim().is_empty() {
        map.remove(&username);
    } else {
        map.insert(
            username.clone(),
            AiUserKey {
                api_key,
                model: model.unwrap_or_else(default_ai_model),
                base_url,
            },
        );
    }
    write_ai_key_map(&map)?;
    Ok(serde_json::json!({ "ok": true, "username": username }))
}

/// 某个账号**有没有配自己的 Key** ✓（不返回 Key 本身 ✗）
#[cfg_attr(feature = "desktop", tauri::command)]
fn ai_key_status(username: String) -> serde_json::Value {
    let map = read_ai_key_map();
    let own = map.get(&username).filter(|item| !item.api_key.is_empty());
    let global = read_ai_config().is_ok();
    serde_json::json!({
        "username": username,
        "hasOwnKey": own.is_some(),
        "hasGlobalKey": global,
        // 有自己配置时**报自己的模型** ✓（前端用来回填下拉 ✓）
        "model": own.map(|item| item.model.clone()),
    })
}

/// `anchor` 用的系统提示 ✓（把"规则"讲死 ✓，AI 只负责翻译 ✗）
const AI_POLICY_SYSTEM_PROMPT: &str = r#"你是 SoftUI 柔性臂的**策略编排助手**。把用户的话翻译成 JSON 配置。

## 输出格式（只输出 JSON ✓，不要解释 ✗）
{
  "name": "方案名",
  "timeline": [
    { "kind": "action" | "switch-model" | "wait", "actionId": "…", "modelId": "…", "durationSec": 10, "note": "…" }
  ],
  "interrupts": [
    { "trigger": "tension-spike", "thresholdN": 5, "windowMs": 2000, "targetKind": "model" | "action", "targetId": "…", "resume": true, "note": "…" }
  ]
}

## 规则
1. **只能使用 context 里列出的 id** ✓，不要编造 ✗
2. timeline 是**顺序执行** ✓，durationSec = 这一段持续多少秒
3. 中断**优先于**时间线 ✓，命中时时间线暂停
4. 用户没提的字段用默认：windowMs=2000、resume=true、durationSec=10
5. durationSec 必须 > 0 且 ≤ 3600
"#;

/// **AI 生成策略** ✓ —— 调 DeepSeek ✓，返回**原始 JSON 文本** ✓
/// （校验在前端做 ✓：前端才知道最新的模型/动作列表 ✓）
///
/// 注意：内部用的是 `reqwest::blocking`，**不能**直接注册成 Tauri 命令
/// （会卡住 IPC/界面线程）—— 桌面端入口是下面那个 `async` 包装。
fn ai_compose_policy_blocking(
    prompt: String,
    context: serde_json::Value,
    username: Option<String>,
) -> Result<serde_json::Value, String> {
    // ⚠ **先看账号自己的** ✓ —— 原来是 `read_ai_config()?` 先跑 ✗，
    //   全局没配就直接报错 ✓，**账号配了也没用**✗（本次 bug ✓）。
    let own = username
        .as_deref()
        .and_then(|name| read_ai_key_map().get(name).cloned())
        .filter(|item| !item.api_key.trim().is_empty());

    let config = if let Some(own) = own {
        AiConfig {
            api_key: own.api_key,
            // 账号没填接口地址就用默认 ✓
            base_url: own
                .base_url
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(default_ai_base_url),
            model: own.model,
        }
    } else {
        // 账号没配 → 才回落到全局 ✓
        read_ai_config()?
    };
    let context_text = serde_json::to_string(&context).unwrap_or_else(|_| "{}".to_string());
    let body = serde_json::json!({
        "model": config.model,
        "messages": [
            { "role": "system", "content": AI_POLICY_SYSTEM_PROMPT },
            { "role": "user", "content": format!("可用清单：{context_text}\n\n用户需求：{prompt}") }
        ],
        "response_format": { "type": "json_object" },
        "temperature": 0.2
    });

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|error| format!("创建请求失败：{error}"))?;

    let response = client
        .post(&config.base_url)
        .bearer_auth(&config.api_key)
        .json(&body)
        .send()
        .map_err(|error| format!("请求失败：{error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().unwrap_or_default();
        return Err(format!("接口返回 {status}：{}", text.chars().take(300).collect::<String>()));
    }

    let payload: serde_json::Value = response.json().map_err(|error| format!("解析失败：{error}"))?;
    let content = payload
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str())
        .ok_or_else(|| "响应里没有 content".to_string())?;

    // 有些模型会包 ```json … ``` ✓ —— 剥掉 ✓
    let trimmed = content.trim();
    let json_text = if let Some(rest) = trimmed.strip_prefix("```json") {
        rest.trim_end_matches("```").trim()
    } else if let Some(rest) = trimmed.strip_prefix("```") {
        rest.trim_end_matches("```").trim()
    } else {
        trimmed
    };

    serde_json::from_str::<serde_json::Value>(json_text)
        .map_err(|error| format!("返回的不是合法 JSON：{error}"))
}

/// 桌面端命令入口：把阻塞的 HTTP 调用丢到阻塞线程池，避免卡住界面。
#[cfg(feature = "desktop")]
#[tauri::command]
async fn ai_compose_policy(
    prompt: String,
    context: serde_json::Value,
    username: Option<String>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ai_compose_policy_blocking(prompt, context, username)
    })
    .await
    .map_err(|error| format!("AI 任务执行失败：{error}"))?
}

/// **界面共享数据**目录（`<状态目录>/ui-store`）✓。
///
/// 动作库 / 策略编排原来存在 `localStorage` ✗ —— 那是**每个浏览器一份** ✗，
/// 多端（手机 ✓ 电脑 ✓ 平板 ✓）就完全不同步 ✗。
/// 现在落到服务器上的 JSON 文件 ✓，所有端读同一份 ✓。
fn ui_store_dir() -> Option<std::path::PathBuf> {
    let root = std::env::var("SOFTUI_STATE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("softui-state.json"));
    let dir = root.parent()?.join("ui-store");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// 命名空间白名单 ✓ —— 不接受任意名字 ✗（防路径穿越 ✓）。
const UI_STORE_NAMESPACES: [&str; 5] = ["motion-actions", "policy-schemes", "policy-log", "log-hidden", "ui-prefs"];

fn ui_store_path(namespace: &str) -> Result<std::path::PathBuf, String> {
    if !UI_STORE_NAMESPACES.contains(&namespace) {
        return Err(format!("未知的数据命名空间：{namespace}"));
    }
    let dir = ui_store_dir().ok_or_else(|| "无法定位数据目录".to_string())?;
    Ok(dir.join(format!("{namespace}.json")))
}

/// 待审批的一条改动 ✓。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingUiChange {
    /// 文件名（不含扩展名）✓
    id: String,
    namespace: String,
    /// 谁提交的（用户名 ✓）
    submitted_by: String,
    submitted_at: String,
    /// 一句话摘要 ✓（"动作库：3 个动作"✓）
    summary: String,
    /// 改动内容 ✓
    data: serde_json::Value,
    /// **有变化的条目 id** ✓ —— 和正式数据对比得出 ✓。
    /// 审批弹窗只列这些 ✓（已同步没动的不要出现 ✗）
    #[serde(default)]
    changed_ids: Vec<String>,
}

fn pending_dir() -> Result<std::path::PathBuf, String> {
    let dir = ui_store_dir()
        .ok_or_else(|| "无法定位数据目录".to_string())?
        .join("pending");
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建待审批目录失败：{error}"))?;
    Ok(dir)
}

/// 提交一条待审批改动 ✓（非 admin 保存时走这里 ✓）。
#[cfg_attr(feature = "desktop", tauri::command)]
fn submit_ui_store(
    namespace: String,
    data: serde_json::Value,
    submitted_by: String,
) -> Result<PendingUiChange, String> {
    // 先校验命名空间合法 ✓（非法名字不落盘 ✗）
    ui_store_path(&namespace)?;
    let dir = pending_dir()?;

    // ⚠ **同一用户 + 同一命名空间只保留最新一条** ✓
    // 原来每提交一次就新建一个文件 ✗ —— 前端 500ms 去抖自动保存 ✓，
    // 用户改十几下就堆十几条待审批 ✗（实测出现 12 条 ✗）。
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(existing) = serde_json::from_str::<PendingUiChange>(&text) {
                    if existing.namespace == namespace && existing.submitted_by == submitted_by {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
        }
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let id = format!("{stamp}-{namespace}");
    let summary = summarize_change(&namespace, &data);
    let changed_ids = changed_entry_ids(&namespace, &data);
    let change = PendingUiChange {
        id: id.clone(),
        namespace,
        submitted_by,
        submitted_at: format!("{stamp}"),
        summary,
        data,
        changed_ids,
    };
    let text = serde_json::to_string_pretty(&change).map_err(|error| error.to_string())?;
    std::fs::write(dir.join(format!("{id}.json")), text)
        .map_err(|error| format!("写入待审批失败：{error}"))?;
    Ok(change)
}

/// 给审批人看的摘要 ✓ —— **和当前正式数据对比** ✓，说明"加了什么/删了什么"。
///
/// 原来只报"3 项"✗ —— 审批人根本看不出是新增还是删除 ✗。
fn summarize_change(namespace: &str, data: &serde_json::Value) -> String {
    // 读当前正式数据 ✓（没有就当空 ✓）
    let current = ui_store_path(namespace)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .unwrap_or(serde_json::Value::Null);

    // 动作库：按 id 对比 ✓
    if let (Some(new_items), Some(old_items)) = (data.as_array(), current.as_array()) {
        let key_of = |value: &serde_json::Value| {
            value
                .get("id")
                .and_then(|id| id.as_str())
                .unwrap_or("")
                .to_string()
        };
        let name_of = |value: &serde_json::Value| {
            let base = value
                .get("name")
                .and_then(|name| name.as_str())
                .unwrap_or("(未命名)")
                .to_string();
            // 带上**采样点数** ✓ —— 审批人据此判断动作大小 ✓
            match value.get("points").and_then(|points| points.as_array()) {
                Some(points) => format!("{base}（{} 点）", points.len()),
                None => base,
            }
        };
        let old_ids: std::collections::HashMap<String, String> =
            old_items.iter().map(|item| (key_of(item), name_of(item))).collect();
        let new_ids: std::collections::HashMap<String, String> =
            new_items.iter().map(|item| (key_of(item), name_of(item))).collect();

        let added: Vec<String> = new_ids
            .iter()
            .filter(|(id, _)| !old_ids.contains_key(*id))
            .map(|(_, name)| name.clone())
            .collect();
        let removed: Vec<String> = old_ids
            .iter()
            .filter(|(id, _)| !new_ids.contains_key(*id))
            .map(|(_, name)| name.clone())
            .collect();
        let modified = new_ids
            .iter()
            .filter(|(id, _)| old_ids.contains_key(*id))
            .count();

        let mut parts: Vec<String> = Vec::new();
        if !added.is_empty() {
            parts.push(format!("新增 {} 个：{}", added.len(), preview_names(&added)));
        }
        if !removed.is_empty() {
            parts.push(format!("删除 {} 个：{}", removed.len(), preview_names(&removed)));
        }
        if modified > 0 {
            parts.push(format!("修改 {modified} 个"));
        }
        if parts.is_empty() {
            return format!("{} 个动作（无实质变化）", new_items.len());
        }
        return parts.join(" · ");
    }

    // 策略编排：报方案数与规则数 ✓
    if let Some(schemes) = data.get("schemes").and_then(|value| value.as_array()) {
        let old_count = current
            .get("schemes")
            .and_then(|value| value.as_array())
            .map(|items| items.len())
            .unwrap_or(0);
        let rules: usize = schemes
            .iter()
            .map(|scheme| {
                scheme
                    .get("rules")
                    .and_then(|value| value.as_array())
                    .map(|items| items.len())
                    .unwrap_or(0)
            })
            .sum();
        let names: Vec<String> = schemes
            .iter()
            .filter_map(|scheme| scheme.get("name").and_then(|name| name.as_str()).map(String::from))
            .collect();
        return format!(
            "{} 个方案（原 {old_count}）· 共 {rules} 条规则 · {}",
            schemes.len(),
            preview_names(&names)
        );
    }

    summarize_value(data)
}

/// 找出**和当前正式数据不同**的条目 id ✓。
///
/// 不做这个的话 ✗：整个数组都进审批 ✓ → 已同步的没改过的也出现在待审批里 ✗
/// （用户看到"上传一次又冒出一堆"✗）。
fn changed_entry_ids(namespace: &str, data: &serde_json::Value) -> Vec<String> {
    // 两种形状 ✓：动作库是数组 ✓，方案库是 `{ schemes: [...] }` ✓（原来只认数组 ✗）
    let items_value = if data.is_array() {
        data.clone()
    } else if let Some(schemes) = data.get("schemes") {
        schemes.clone()
    } else {
        return Vec::new();
    };
    let Some(new_items) = items_value.as_array() else {
        return Vec::new();
    };
    let current = ui_store_path(namespace)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
    let old_items: Vec<serde_json::Value> = current
        .as_ref()
        .and_then(|value| {
            if value.is_array() {
                value.as_array().cloned()
            } else {
                value.get("schemes").and_then(|schemes| schemes.as_array()).cloned()
            }
        })
        .unwrap_or_default();

    let key_of = |value: &serde_json::Value| {
        value
            .get("id")
            .and_then(|id| id.as_str())
            .unwrap_or("")
            .to_string()
    };

    let mut changed: Vec<String> = Vec::new();
    for item in new_items {
        let id = key_of(item);
        if id.is_empty() {
            continue;
        }
        match old_items.iter().find(|old| key_of(old) == id) {
            // 新增 ✓ 或内容变了 ✓（用 JSON 文本比较 ✓，够用 ✓）
            None => changed.push(id),
            Some(old) => {
                if serde_json::to_string(old).ok() != serde_json::to_string(item).ok() {
                    changed.push(id);
                }
            }
        }
    }
    // 被删掉的：在旧数据里有、新数据里没有 ✓（用 "deleted:<id>" 前缀标记 ✓）
    let new_ids: Vec<String> = new_items.iter().map(key_of).collect();
    for old in &old_items {
        let id = key_of(old);
        if !id.is_empty() && !new_ids.contains(&id) {
            changed.push(format!("deleted:{id}"));
        }
    }
    changed
}

/// 名字太多就截断 ✓（弹窗里看不下 ✗）
fn preview_names(names: &[String]) -> String {
    let limit = 3;
    if names.len() <= limit {
        return names.join("、");
    }
    format!("{}…等 {} 个", names[..limit].join("、"), names.len())
}

/// 给前端看的摘要 ✓（不用复杂逻辑 ✓，能看到条数就够 ✓）
fn summarize_value(data: &serde_json::Value) -> String {
    match data {
        serde_json::Value::Array(items) => format!("{} 项", items.len()),
        serde_json::Value::Object(map) => {
            if let Some(schemes) = map.get("schemes").and_then(|value| value.as_array()) {
                return format!("{} 个方案", schemes.len());
            }
            format!("{} 个字段", map.len())
        }
        _ => "单项".to_string(),
    }
}

/// 列出所有待审批 ✓（按提交时间倒序 ✓）。
#[cfg_attr(feature = "desktop", tauri::command)]
fn list_pending_ui_store() -> Result<Vec<PendingUiChange>, String> {
    let dir = pending_dir()?;
    let mut items: Vec<PendingUiChange> = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|error| format!("读取失败：{error}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(change) = serde_json::from_str::<PendingUiChange>(&text) {
                items.push(change);
            }
        }
    }
    items.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(items)
}

/// **按条目批准** ✓ —— 只把选中的那几条写进正式数据，其余继续待批 ✓。
///
/// 为什么需要 ✗：一条待审批里打包了**整个数组** ✓，一次批准等于全批 ✗；
/// 审批人想"这个留下、那个驳回"就做不到 ✓。
#[cfg_attr(feature = "desktop", tauri::command)]
fn approve_ui_store_entry(
    id: String,
    entry_id: String,
) -> Result<Vec<PendingUiChange>, String> {
    let dir = pending_dir()?;
    let path = dir.join(format!("{id}.json"));
    let text = std::fs::read_to_string(&path).map_err(|_| format!("找不到待审批项：{id}"))?;
    let mut change: PendingUiChange =
        serde_json::from_str(&text).map_err(|error| format!("解析失败：{error}"))?;

    let namespace = change.namespace.clone();
    let official = ui_store_path(&namespace)?;
    let mut official_data: serde_json::Value = std::fs::read_to_string(&official)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(serde_json::Value::Array(Vec::new()));

    // ① 从待审批里**取出**这条 ✓（动作库是数组 ✓，方案库是 `{schemes:[…]}` ✓）
    let is_scheme_payload = !change.data.is_array() && change.data.get("schemes").is_some();
    let mut picked: Option<serde_json::Value> = None;
    {
        let items = if is_scheme_payload {
            change.data.get_mut("schemes").and_then(|value| value.as_array_mut())
        } else {
            change.data.as_array_mut()
        };
        if let Some(items) = items {
            if let Some(index) = items.iter().position(|item| {
                item.get("id").and_then(|value| value.as_str()) == Some(entry_id.as_str())
            }) {
                picked = Some(items.remove(index));
            }
        }
    }
    let Some(picked) = picked else {
        return Err(format!("待审批里没有条目：{entry_id}"));
    };

    // ② 写进正式数据 ✓（同 id 覆盖 ✓，没有就追加 ✓）
    if is_scheme_payload {
        if !official_data.is_object() {
            official_data = serde_json::json!({ "schemes": [], "activeId": "" });
        }
        if let Some(items) = official_data
            .get_mut("schemes")
            .and_then(|value| value.as_array_mut())
        {
            match items.iter().position(|item| {
                item.get("id").and_then(|value| value.as_str()) == Some(entry_id.as_str())
            }) {
                Some(index) => items[index] = picked,
                None => items.push(picked),
            }
        }
    } else {
        if !official_data.is_array() {
            official_data = serde_json::Value::Array(Vec::new());
        }
        if let Some(items) = official_data.as_array_mut() {
            match items.iter().position(|item| {
                item.get("id").and_then(|value| value.as_str()) == Some(entry_id.as_str())
            }) {
                Some(index) => items[index] = picked,
                None => items.push(picked),
            }
        }
    }

    // ⚠ **从待审批的 changed_ids 里移除**已批准的这条 ✗
    // 不移的话 ✓：后面驳回时会把整批 id 都写进驳回通知 ✗
    // → 用户界面**所有条目**都显示"已驳回"✗（这就是本次 bug ✓）
    change.changed_ids.retain(|id| id != &entry_id);
    let text_out = serde_json::to_string_pretty(&official_data).map_err(|e| e.to_string())?;
    std::fs::write(&official, text_out).map_err(|error| format!("写入失败：{error}"))?;

    // ③ 待审批里还剩不剩条目 ✓
    let remaining = if is_scheme_payload {
        change
            .data
            .get("schemes")
            .and_then(|value| value.as_array())
            .map(|items| items.len())
            .unwrap_or(0)
    } else {
        change.data.as_array().map(|items| items.len()).unwrap_or(0)
    };
    if remaining == 0 {
        let _ = std::fs::remove_file(&path);
    } else {
        let text = serde_json::to_string_pretty(&change).map_err(|e| e.to_string())?;
        std::fs::write(&path, text).map_err(|error| format!("回写失败：{error}"))?;
    }

    list_pending_ui_store()
}

/// 批准 ✓ —— 把内容写入正式文件，再删掉待审批。
#[cfg_attr(feature = "desktop", tauri::command)]
fn approve_ui_store(id: String) -> Result<Vec<PendingUiChange>, String> {
    let dir = pending_dir()?;
    let path = dir.join(format!("{id}.json"));
    let text = std::fs::read_to_string(&path).map_err(|_| format!("找不到待审批项：{id}"))?;
    let change: PendingUiChange =
        serde_json::from_str(&text).map_err(|error| format!("解析失败：{error}"))?;
    set_ui_store(change.namespace, change.data)?;
    std::fs::remove_file(&path).map_err(|error| format!("删除待审批失败：{error}"))?;
    list_pending_ui_store()
}

/// 一条**驳回通知** ✓ —— 让提交者知道"我的改动被驳回了"。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RejectionNotice {
    id: String,
    namespace: String,
    submitted_by: String,
    summary: String,
    rejected_at: String,
    /// **被驳回的条目 id** ✓ —— 前端据此把对应动作标成"已驳回" ✓
    #[serde(default)]
    entry_ids: Vec<String>,
}

fn rejections_path() -> Result<std::path::PathBuf, String> {
    Ok(ui_store_dir()
        .ok_or_else(|| "无法定位数据目录".to_string())?
        .join("rejections.json"))
}

fn read_rejections() -> Vec<RejectionNotice> {
    rejections_path()
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Vec<RejectionNotice>>(&text).ok())
        .unwrap_or_default()
}

fn write_rejections(items: &[RejectionNotice]) -> Result<(), String> {
    let path = rejections_path()?;
    let text = serde_json::to_string_pretty(items).map_err(|error| error.to_string())?;
    std::fs::write(path, text).map_err(|error| format!("写入失败：{error}"))
}

/// 读驳回通知 ✓（前端轮询 ✓）
#[cfg_attr(feature = "desktop", tauri::command)]
fn list_rejections() -> Vec<RejectionNotice> {
    read_rejections()
}

/// **清空某命名空间的驳回通知** ✓ —— 提交者一改动就调 ✓
/// （标记是"上一次被驳回"✓，改了就不该再挂着 ✗）
#[cfg_attr(feature = "desktop", tauri::command)]
fn clear_rejections(namespace: String) -> Vec<RejectionNotice> {
    let mut items = read_rejections();
    items.retain(|item| item.namespace != namespace);
    let _ = write_rejections(&items);
    items
}

/// 前端确认已读 ✓ → 删掉通知 ✓
#[cfg_attr(feature = "desktop", tauri::command)]
fn acknowledge_rejection(id: String) -> Vec<RejectionNotice> {
    let mut items = read_rejections();
    items.retain(|item| item.id != id);
    let _ = write_rejections(&items);
    items
}

/// 驳回 ✓ —— 只删掉待审批，不动正式文件。
#[cfg_attr(feature = "desktop", tauri::command)]
fn reject_ui_store(id: String) -> Result<Vec<PendingUiChange>, String> {
    let dir = pending_dir()?;
    let path = dir.join(format!("{id}.json"));
    if path.exists() {
        // 先读出来 ✓ —— 要记下"谁提交的、改了什么"✓ 才能通知他 ✓
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(change) = serde_json::from_str::<PendingUiChange>(&text) {
                let mut notices = read_rejections();
                notices.push(RejectionNotice {
                    id: format!("{}-reject", change.id),
                    namespace: change.namespace,
                    submitted_by: change.submitted_by,
                    summary: change.summary,
                    rejected_at: change.submitted_at,
                    entry_ids: change.changed_ids.clone(),
                });
                // 只留最近 50 条 ✓（不无限增长 ✗）
                if notices.len() > 50 {
                    let keep = notices.len() - 50;
                    notices.drain(0..keep);
                }
                write_rejections(&notices)?;
            }
        }
        std::fs::remove_file(&path).map_err(|error| format!("删除失败：{error}"))?;
    }
    list_pending_ui_store()
}

/// 读共享数据 ✓（文件不存在返回 `null` ✓，不是错误 ✓）。
#[cfg_attr(feature = "desktop", tauri::command)]
fn get_ui_store(namespace: String) -> Result<serde_json::Value, String> {
    let path = ui_store_path(&namespace)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<serde_json::Value>(&text)
            .map_err(|error| format!("解析失败：{error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::Value::Null),
        Err(error) => Err(format!("读取失败：{error}")),
    }
}

/// 写共享数据 ✓ —— **先写临时文件再 rename** ✓（避免写一半断电留下坏文件 ✗）。
#[cfg_attr(feature = "desktop", tauri::command)]
fn set_ui_store(namespace: String, data: serde_json::Value) -> Result<serde_json::Value, String> {
    let path = ui_store_path(&namespace)?;
    let text = serde_json::to_string_pretty(&data).map_err(|error| error.to_string())?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text).map_err(|error| format!("写入失败：{error}"))?;
    std::fs::rename(&temp, &path).map_err(|error| format!("提交失败：{error}"))?;
    // 回读一次 ✓ —— 让前端确认"服务端看到的就是它写的" ✓
    get_ui_store(namespace)
}

/// 模型库目录（`<状态目录>/models`）。
///
/// 原来只有一个"导入槽"（可执行文件旁的 `model.tdcrmodel`）✗ —— 只能存一个，
/// 做不了增删改查。现在改成目录，可以并存多个 ✓。
fn models_dir() -> Option<std::path::PathBuf> {
    let root = std::env::var("SOFTUI_STATE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("softui-state.json"));
    let dir = root.parent()?.join("models");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// 把旧 desktop 构建落错位置（`%TEMP%\models`）的模型搬到 `<状态目录>/models`。
///
/// 只复制、不删除：如果同机还有 server 实例在用临时目录，删掉会把它的模型弄丢 ✗。
#[cfg(feature = "desktop")]
fn migrate_legacy_models(state_path: &std::path::Path) {
    let Some(dir) = state_path.parent().map(|parent| parent.join("models")) else {
        return;
    };
    let legacy = std::env::temp_dir().join("models");
    if legacy == dir || !legacy.is_dir() {
        return;
    }
    let _ = std::fs::create_dir_all(&dir);
    let Ok(entries) = std::fs::read_dir(&legacy) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name() else { continue };
        let target = dir.join(name);
        if target.exists() {
            continue;
        }
        let _ = std::fs::copy(&path, &target);
    }
}

/// 模型库条目（内建预设 + 用户导入的）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelLibraryEntry {
    /// 内建预设用 preset id；用户模型用文件名（不含扩展名）。
    id: String,
    /// 显示名（内建 = 预设 label；用户 = sidecar 里的名字，否则文件名）。
    name: String,
    bundle_bytes: usize,
    summary: String,
    kappa_limit_per_m: f64,
    kappa_limit_by_direction: [f64; 8],
    /// 内建模型**不可删除** ✓。
    builtin: bool,
    /// 当前是否生效。
    selected: bool,
    /// 用户在导入时填写的臂体参数（内建模型为 null ✓）。
    params: Option<ModelParams>,
    /// 臂总长（mm）✓ —— 轨迹规划必须用它 ✗（写死 400 会让别的模型整体偏差 ✗）
    /// 内建模型来自预设常量 ✓，用户模型来自参数里的臂长 ✓（没填就是 None ✓）。
    total_length_mm: Option<f64>,
}

/// 用户模型的显示名 sidecar（`<file>.name`）—— 重命名只改这里，不动包内容 ✓。
fn model_name_path(model_file: &std::path::Path) -> std::path::PathBuf {
    let mut name = model_file.as_os_str().to_os_string();
    name.push(".name");
    std::path::PathBuf::from(name)
}

/// 模型包的**臂体参数**（用户在导入时填 ✓，存在 sidecar 里 ✓）。
///
/// 为什么不写进 `.tdcrmodel` ✗：那是**标定数据**（二进制、有 MAGIC 校验 ✓），
/// 改格式会牵连 Rust 解析器和所有旧包 ✗。sidecar 只是**管理用的说明信息** ✓。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelParams {
    /// 臂长（mm）—— 导入时从包内带出 ✓
    length_mm: Option<f64>,
    /// 臂体外径（mm）
    outer_diameter_mm: Option<f64>,
    /// 臂体壁厚（mm）
    wall_thickness_mm: Option<f64>,
    /// 驱动丝半径（mm）
    drive_wire_radius_mm: Option<f64>,
    /// 额定尖端力（N）—— 标定/选型用的说明值 ✓（不参与下发计算 ✗）
    tip_force_n: Option<f64>,
    /// 材料（自由文本 / 下拉选填 ✓）
    material: Option<String>,
    /// 标定日期（YYYY-MM-DD）
    calibrated_at: Option<String>,
    /// 重量（g）
    weight_g: Option<f64>,
    /// 备注
    note: Option<String>,
}

fn model_params_path(model_file: &std::path::Path) -> std::path::PathBuf {
    let mut name = model_file.as_os_str().to_os_string();
    name.push(".params.json");
    std::path::PathBuf::from(name)
}

fn read_model_params(model_file: &std::path::Path) -> Option<ModelParams> {
    let text = std::fs::read_to_string(model_params_path(model_file)).ok()?;
    serde_json::from_str(&text).ok()
}

/// 保存模型参数：内建模型不支持（它们编译在二进制里 ✓，没有 sidecar ✗）。
/// 内建模型的参数文件（`builtin-<preset id>.params.json` ✓）。
///
/// 内建模型**没有 .tdcrmodel 文件** ✗（编译在二进制里 ✓），所以 sidecar 要独立取名 ✓。
fn builtin_params_path(preset_id: &str) -> Option<std::path::PathBuf> {
    Some(models_dir()?.join(format!("builtin-{preset_id}.params.json")))
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn save_model_params(id: String, params: ModelParams) -> Result<Vec<ModelLibraryEntry>, String> {
    let text = serde_json::to_string_pretty(&params).map_err(|e| e.to_string())?;
    // 内建模型：写 `builtin-<id>.params.json` ✓（原来直接拒绝 ✗）
    if model::PRESETS.iter().any(|preset| preset.id == id) {
        let path = builtin_params_path(&id).ok_or_else(|| "无法定位模型库目录".to_string())?;
        std::fs::write(&path, text).map_err(|e| format!("写入参数失败：{e}"))?;
        return list_models();
    }
    let path = user_model_path(&id).ok_or_else(|| "非法的模型 id".to_string())?;
    if !path.exists() {
        return Err(format!("模型不存在：{id}"));
    }
    std::fs::write(model_params_path(&path), text).map_err(|e| format!("写入参数失败：{e}"))?;
    list_models()
}

/// 列出模型库：内建预设 + 目录里的 `.tdcrmodel`。
#[cfg_attr(feature = "desktop", tauri::command)]
fn list_models() -> Result<Vec<ModelLibraryEntry>, String> {
    let current = current_model();
    let current_bytes = current.bundle_bytes;
    let mut out: Vec<ModelLibraryEntry> = Vec::new();

    for preset in model::PRESETS {
        // 内建模型加载失败必须**报出来** ✗ —— 静默跳过会让模型"凭空消失"✗
        let tables = model::ModelTables::from_preset(preset)
            .map_err(|error| format!("内建模型 {} 加载失败：{error:?}", preset.id))?;
        {
            out.push(ModelLibraryEntry {
                id: preset.id.to_string(),
                name: preset.name.to_string(),
                bundle_bytes: tables.bundle_bytes,
                summary: tables.summary(),
                kappa_limit_per_m: tables.kappa_limit_per_m,
                kappa_limit_by_direction: tables.kappa_limit_by_direction(),
                builtin: true,
                selected: tables.bundle_bytes == current_bytes,
                params: builtin_params_path(&preset.id)
                    .and_then(|path| {
                        serde_json::from_str::<ModelParams>(&std::fs::read_to_string(path).ok()?).ok()
                    }),
                total_length_mm: Some(preset.total_length_mm),
            });
        }
    }

    if let Some(dir) = models_dir() {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("tdcrmodel") {
                    continue;
                }
                let Ok(bytes) = std::fs::read(&path) else { continue };
                let Ok(tables) = model::ModelTables::from_bundle(&bytes) else { continue };
                let stem = path
                    .file_stem()
                    .map(|v| v.to_string_lossy().to_string())
                    .unwrap_or_else(|| "未命名".to_string());
                let name = std::fs::read_to_string(model_name_path(&path))
                    .ok()
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
                    .unwrap_or_else(|| stem.clone());
                out.push(ModelLibraryEntry {
                    id: stem,
                    name,
                    bundle_bytes: tables.bundle_bytes,
                    summary: tables.summary(),
                    kappa_limit_per_m: tables.kappa_limit_per_m,
                    kappa_limit_by_direction: tables.kappa_limit_by_direction(),
                    builtin: false,
                    selected: tables.bundle_bytes == current_bytes,
                    params: read_model_params(&path),
                    total_length_mm: read_model_params(&path).and_then(|p| p.length_mm),
                });
            }
        }
    }
    Ok(out)
}

/// 用户模型的**文件名**（不含扩展名）→ 路径。
fn user_model_path(id: &str) -> Option<std::path::PathBuf> {
    // 只允许安全字符，避免 `../` 之类的路径穿越 ✗
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '(' | ')' | ' '))
        || id.contains("..")
    {
        return None;
    }
    Some(models_dir()?.join(format!("{id}.tdcrmodel")))
}

/// 当前选中模型的记录文件（`<模型库>/.selected`）。
///
/// **只记 id** ✓ —— 内建预设不该往模型库里复制包 ✗；重启时按这个 id 恢复 ✓。
fn selection_path() -> Option<std::path::PathBuf> {
    Some(models_dir()?.join(".selected"))
}

fn remember_selection(id: &str) {
    if let Some(path) = selection_path() {
        let _ = std::fs::write(path, id);
    }
}

fn recall_selection() -> Option<String> {
    let path = selection_path()?;
    let value = std::fs::read_to_string(path).ok()?.trim().to_string();
    if value.is_empty() { None } else { Some(value) }
}

/// 删除用户模型。**内建模型不可删** ✓；**当前生效的也不删** ✓（避免正在用的模型消失）。
#[cfg_attr(feature = "desktop", tauri::command)]
fn delete_model(id: String) -> Result<Vec<ModelLibraryEntry>, String> {
    if model::PRESETS.iter().any(|preset| preset.id == id) {
        return Err("内建模型不能删除".to_string());
    }
    let path = user_model_path(&id).ok_or_else(|| "非法的模型 id".to_string())?;
    if !path.exists() {
        return Err(format!("模型不存在：{id}"));
    }
    if list_models()?.iter().any(|entry| entry.id == id && entry.selected) {
        return Err("这个模型正在使用中，请先切换到其它模型再删除".to_string());
    }
    std::fs::remove_file(&path).map_err(|error| format!("删除失败：{error}"))?;
    let _ = std::fs::remove_file(model_name_path(&path));
    list_models()
}

/// 重命名用户模型（只改 sidecar，不动包内容 ✓）。
#[cfg_attr(feature = "desktop", tauri::command)]
fn rename_model(id: String, name: String) -> Result<Vec<ModelLibraryEntry>, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("名称不能为空".to_string());
    }
    if model::PRESETS.iter().any(|preset| preset.id == id) {
        return Err("内建模型不能重命名".to_string());
    }
    let path = user_model_path(&id).ok_or_else(|| "非法的模型 id".to_string())?;
    if !path.exists() {
        return Err(format!("模型不存在：{id}"));
    }
    std::fs::write(model_name_path(&path), trimmed).map_err(|error| format!("重命名失败：{error}"))?;
    list_models()
}

/// 导出模型包（base64）—— 内建的可导出 ✓（只读）。
#[cfg_attr(feature = "desktop", tauri::command)]
fn export_model(id: String) -> Result<String, String> {
    let bytes = if let Some(preset) = model::PRESETS.iter().find(|preset| preset.id == id) {
        preset.bundle.to_vec()
    } else {
        let path = user_model_path(&id).ok_or_else(|| "非法的模型 id".to_string())?;
        std::fs::read(&path).map_err(|error| format!("读取失败：{error}"))?
    };
    Ok(base64_encode(&bytes))
}

/// base64 解码（导入用）。非法字符/长度错误一律报错，不猜 ✗。
fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lut = [255u8; 256];
    for (index, byte) in TABLE.iter().enumerate() {
        lut[*byte as usize] = index as u8;
    }
    let trimmed = input.trim();
    if trimmed.len() % 4 != 0 {
        return Err("base64 长度不是 4 的倍数".to_string());
    }
    let mut out = Vec::with_capacity(trimmed.len() / 4 * 3);
    for chunk in trimmed.as_bytes().chunks(4) {
        let mut acc = 0u32;
        let mut pad = 0usize;
        for (slot, byte) in chunk.iter().enumerate() {
            if *byte == b'=' {
                pad += 1;
                acc <<= 6;
            } else {
                let value = lut[*byte as usize];
                if value == 255 {
                    return Err(format!("base64 含非法字符：{:?}", *byte as char));
                }
                acc = (acc << 6) | value as u32;
                let _ = slot;
            }
        }
        if pad > 2 {
            return Err("base64 填充错误".to_string());
        }
        out.push((acc >> 16) as u8);
        if pad < 2 {
            out.push((acc >> 8) as u8);
        }
        if pad < 1 {
            out.push(acc as u8);
        }
    }
    Ok(out)
}

/// 从 base64 导入模型（前端上传走这条 ✓ —— `Vec<u8>` 走 JSON 会被放大 3 倍以上 ✗）。
#[cfg_attr(feature = "desktop", tauri::command)]
fn import_model_base64(data: String, name: Option<String>) -> Result<ModelStatus, String> {
    let bytes = base64_decode(&data)?;
    if bytes.is_empty() {
        return Err("模型包内容为空".to_string());
    }
    import_model(bytes, name)
}

fn persisted_model_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join("model.tdcrmodel"))
}

/// 从磁盘载入上次导入的模型包（没有或损坏则安静跳过）。
fn try_load_persisted_model() {
    // ① 优先按 `.selected` 里记的 id 恢复 ✓（内建预设**不复制包**，只记 id）
    if let Some(id) = recall_selection() {
        if let Some(preset) = model::ModelPreset::find(&id) {
            if let Ok(tables) = model::ModelTables::from_preset(preset) {
                if let Ok(mut guard) = imported_slot().lock() {
                    *guard = Some((preset.name.to_string(), std::sync::Arc::new(tables)));
                }
                return;
            }
        }
        if let Some(path) = user_model_path(&id) {
            if let Ok(bytes) = std::fs::read(&path) {
                if let Ok(tables) = model::ModelTables::from_bundle(&bytes) {
                    let name = std::fs::read_to_string(model_name_path(&path))
                        .ok()
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| id.clone());
                    if let Ok(mut guard) = imported_slot().lock() {
                        *guard = Some((name, std::sync::Arc::new(tables)));
                    }
                    return;
                }
            }
        }
        // 记的模型没了（被删/被移走）→ 安静回落到内建默认 ✓
    }

    // ② 老路径兼容：可执行文件旁的 `model.tdcrmodel`
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
    /// **这是 8 个方向的最小值**（保守口径 ✓，保留兼容）。
    kappa_limit_per_m: f64,
    /// 8 个方向各自的覆盖上限（0°, 45°, … 315°）。
    /// 宽的方位可达 ~1.9，窄的仍是 ~1.0 —— 消费侧可用它按方位放宽 ✓。
    kappa_limit_by_direction: [f64; 8],
}

fn model_status_of() -> ModelStatus {
    let imported = imported_slot()
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|(name, tables)| (name.clone(), tables.summary())));
    let (source, name, summary) = match imported {
        Some((name, summary)) => ("imported".to_string(), Some(name), summary),
        None => (
            "builtin".to_string(),
            // 内置也有名字 ✓（原来 None ✗ → UI 显示空 ✓）
            Some(model::PRESETS[0].name.to_string()),
            current_model().summary(),
        ),
    };
    ModelStatus {
        source,
        name,
        summary,
        bundle_bytes: current_model().bundle_bytes,
        persisted_path: persisted_model_path().map(|path| path.to_string_lossy().to_string()),
        kappa_limit_per_m: current_model().kappa_limit_per_m,
        kappa_limit_by_direction: current_model().kappa_limit_by_direction(),
    }
}

/// 查询当前模型（只读）。
#[cfg_attr(feature = "desktop", tauri::command)]
fn model_status() -> ModelStatus {
    model_status_of()
}

/// 可选模型包的信息（供 UI 下拉列表）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]

pub struct ModelPresetInfo {
    pub id: String,
    pub name: String,
    /// 该包支持的两档张力上限（N）。
    pub gauges: Vec<u8>,
    pub active: bool,
}

/// 某个模型 id 支持的张力档位 ✓（导入的模型也要能推出来 ✓）。
fn preset_tensions_for_id(id: &str) -> Vec<u8> {
    if let Some(preset) = model::ModelPreset::find(id) {
        return preset_tensions(preset);
    }
    // 导入的模型：从已加载的表**真实档位**推 ✓（新格式读 `META.tau_max` ✓）
    current_model().tension_limits()
}

fn preset_tensions(preset: &model::ModelPreset) -> Vec<u8> {
    // **以模型自身表的真实档位为准** ✓ —— `preset.gauges` 是旧结构（固定两档 ✗），
    // 新模型只有 20N ✓，按它算会显示成 `[20, 40]` ✗。
    let actual = model::ModelTables::from_preset(preset)
        .map(|tables| tables.tension_limits())
        .unwrap_or_else(|_| vec![20]);
    let mut out = actual;
    out.dedup();
    out
}

fn model_preset_is_active(preset: &model::ModelPreset) -> bool {
    match imported_slot()
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|(label, _)| label.clone()))
    {
        Some(label) => label == preset.name,
        // 没有导入过 = 用的是内置包 ✓（现在只剩一条 ✓）
        None => preset.id == model::PRESETS[0].id,
    }
}

/// 由**驱动丝位移**反查表内形状（12 节点 κ）。
///
/// 3D 显示用它替代正向 SDM：SDM 与全阶 Cosserat 表是两套模型，同一组位移
/// 反推出的形状能差 2 倍以上；而"显示要和表一致"只能直接读表。
#[cfg_attr(feature = "desktop", tauri::command)]
fn shape_from_displacements(displacement_mm: Vec<f64>) -> Result<Vec<f64>, String> {
    if displacement_mm.len() != 6 {
        return Err(format!(
            "需要 6 个驱动丝位移，收到 {} 个",
            displacement_mm.len()
        ));
    }
    let mut input = [0.0f64; 6];
    input.copy_from_slice(&displacement_mm);
    let model = current_model();

    // **新模型优先** ✓ —— 直接用 `KTB1` 的 `dL_mm` 反查 ✓。
    //
    // 为什么必须走这里 ✗：新模型的老字段（`pose_40` 等）是**用内置旧臂包垫的**✗，
    // 拿旧臂的表去反查新臂的位移 ✓ → 形状完全不对 ✓ → **使能后臂体狂抖** ✗（本 bug ✓）。
    if let Some(vc) = model.vc.as_ref() {
        let (shape, distance) = vc
            .shape_12x2_interpolated(input)
            .ok_or_else(|| "新模型的位移表为空".to_string())?;
        let nodes = 12.0_f64;
        let mut out: Vec<f64> = shape.iter().map(|value| *value as f64).collect();
        out.push(distance);
        out.push(model.total_length_mm / nodes);
        return Ok(out);
    }

    let table = model
        .display_pose()
        .map_err(|error| format!("位姿表不可用：{error:?}"))?;
    let (shape, distance) = table
        .shape_nearest_by_displacement(input)
        .ok_or_else(|| "当前模型的形状表为空".to_string())?;
    // 返回 12×2 的扁平数组；末尾依次是"最近邻距离"和"每段长度(mm)"。
    // 段长必须跟着模型走 —— 旧臂 445.2、新臂 400，写死会让另一个模型的显示整体缩放偏差。
    let nodes = posetable::N_SHAPE_NODES.max(1) as f64;
    // 臂长按**当前模型的名字**反查预设：旧臂 445.2、新臂 400。
    // 写死任意一个，另一个模型的显示就会整体缩放偏差约 10%。
    let total_length_mm = imported_slot()
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|(label, _)| label.clone()))
        .and_then(|label| {
            model::PRESETS
                .iter()
                .find(|preset| preset.name == label)
                .map(|preset| preset.total_length_mm)
        })
        .unwrap_or(model.total_length_mm);
    let mut out: Vec<f64> = shape.iter().map(|value| *value as f64).collect();
    out.push(distance);
    out.push(total_length_mm / nodes);
    Ok(out)
}

/// **模型下拉列表** ✓ —— 和管理页「模型库」**同源** ✗。
///
/// 原来只列 `PRESETS`（2 个内置 ✗）→ 导入的模型在管理页看得见、卡片里看不见 ✗（本 bug ✓）。
/// 现在改为**遍历 `list_models()`** ✓：内置 + 已导入 ✓，一个入口 ✓。
#[cfg_attr(feature = "desktop", tauri::command)]
fn list_model_presets() -> Vec<ModelPresetInfo> {
    let current = current_model();
    let current_bytes = current.bundle_bytes;

    match list_models() {
        Ok(entries) => entries
            .into_iter()
            .map(|entry| ModelPresetInfo {
                // `summary` 是字符串描述 ✓ —— 档位从模型本身推 ✗
                gauges: preset_tensions_for_id(&entry.id),
                active: entry.bundle_bytes == current_bytes,
                id: entry.id,
                name: entry.name,
            })
            .collect(),
        // 兜底：加载失败时至少别让下拉空掉 ✓
        Err(_) => model::PRESETS
            .iter()
            .map(|preset| ModelPresetInfo {
                id: preset.id.to_string(),
                name: preset.name.to_string(),
                gauges: {
                    let mut list = preset_tensions(preset);
                    list.dedup();
                    list
                },
                active: model_preset_is_active(preset),
            })
            .collect(),
    }
}

/// 选中一个模型包：内置那条走 `reset_model`（清除导入），其余复用 `import_model`
/// —— 校验、落盘、热加载、状态返回全都是现成的，不另造一套持久化。
fn select_model_preset(id: String) -> Result<ModelStatus, String> {
    // 内建预设
    if let Some(preset) = model::ModelPreset::find(&id) {
        if preset.id == "v1-legacy" {
            remember_selection(&preset.id);
            return reset_model();
        }
        // 臂长不在这里覆盖：`shape_from_displacements` 会按当前模型的**名字**反查预设拿长度。
        // **不落库** ✓：预设已经被编译进二进制，再存一份只会产生重复条目 ✗
        remember_selection(&preset.id);
        return import_model_inner(preset.bundle.to_vec(), Some(preset.name.to_string()), false);
    }
    // 模型库里的用户模型：按文件名加载 ✓（原来只能选内建预设 ✗，
    // 导致"导入的模型切不过去"✗）
    let path = user_model_path(&id).ok_or_else(|| format!("未知模型：{id}"))?;
    let bytes = std::fs::read(&path).map_err(|error| format!("读取模型失败：{error}"))?;
    let name = std::fs::read_to_string(model_name_path(&path))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| id.clone());
    remember_selection(&id);
    import_model_inner(bytes, Some(name), false)
}

/// 选中模型（前端调用的命令名是 `select_model`，实现复用 `select_model_preset`）。
#[cfg(feature = "desktop")]
#[tauri::command]
fn select_model(id: String) -> Result<ModelStatus, String> {
    select_model_preset(id)
}

/// 导入模型包（`.tdcrmodel`）。校验通过后写入模型库并立即生效。
#[cfg_attr(feature = "desktop", tauri::command)]
fn import_model(bytes: Vec<u8>, name: Option<String>) -> Result<ModelStatus, String> {
    import_model_inner(bytes, name, true)
}

/// `persist = false` 时不写入模型库 ✓。
///
/// 内建预设**不能**落库 ✗ —— 原来选一次预设就往模型库写一份副本，
/// 越选越多（用户视角就是"模型重复了"✗）。
fn import_model_inner(
    bytes: Vec<u8>,
    name: Option<String>,
    persist: bool,
) -> Result<ModelStatus, String> {
    let tables = model::ModelTables::from_bundle(&bytes)
        .map_err(|error| format!("模型包无效：{error:?}"))?;
    let mut label = name.unwrap_or_else(|| format!("model.{}", model::EXTENSION));
    // 前端传的是 `file.name`（**带** `.tdcrmodel`），这里再拼一次扩展名会得到
    // `xxx.tdcrmodel.tdcrmodel`（实测）。统一去掉尾部扩展名：文件是 `xxx.tdcrmodel`，
    // 显示名是 `xxx`。
    let suffix = format!(".{}", model::EXTENSION);
    if label.to_ascii_lowercase().ends_with(&suffix) {
        label.truncate(label.len() - suffix.len());
        if label.trim().is_empty() {
            label = "model".to_string();
        }
    }

    // 写入**模型库目录**（原来写可执行文件旁 ✗ —— 只能存一个、且和状态目录不在一起）
    if persist {
        if let Some(dir) = models_dir() {
        let raw_stem: String = label
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '(' | ')' | ' ') { c } else { '_' })
            .collect();
        // 中文/日文名的净化结果会退化成一串 `_` ✗（测试导入-新臂 → ____-__ ✗），
        // 两个中文名还会**互相覆盖** ✗。可读字符太少就用时间戳兜底 ✓，显示名仍是原文 ✓。
        let readable = raw_stem.chars().filter(|c| c.is_ascii_alphanumeric()).count();
        let stem = if readable >= 3 {
            raw_stem
        } else {
            format!(
                "model-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0)
            )
        };
        let file = dir.join(format!("{stem}.tdcrmodel"));
        std::fs::write(&file, &bytes).map_err(|error| format!("写入模型文件失败：{error}"))?;
            let _ = std::fs::write(model_name_path(&file), &label);
        }
    }
    if let Ok(mut guard) = imported_slot().lock() {
        *guard = Some((label, std::sync::Arc::new(tables)));
    }
    Ok(model_status_of())
}

/* ── 数据导出：模型包 ─────────────────────────────────────────────────
 * 模型包是二进制（`.tdcrmodel`，431 KB）。若直接把 `Vec<u8>` 交给 serde，
 * 会被编成几十万个数字的 JSON 数组（体积膨胀 3 倍以上），所以这里传 base64。
 * ──────────────────────────────────────────────────────────────────── */

/// 标准 base64 编码（RFC 4648）。项目不引第三方依赖，所以手写一份。
/// 这里只需要**编码** —— 导出没有回传路径，不需要解码。
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((triple >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(triple & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// 当前生效模型包的原始字节：导入过就取落盘那份，否则取编译进的内置包。
fn current_model_bundle_bytes() -> Vec<u8> {
    if imported_tables().is_some() {
        if let Some(path) = persisted_model_path() {
            if let Ok(bytes) = std::fs::read(&path) {
                if !bytes.is_empty() {
                    return bytes;
                }
            }
        }
    }
    model::DEFAULT_BUNDLE.to_vec()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelBundleExport {
    file_name: String,
    /// `builtin` 或 `imported`
    source: String,
    byte_len: usize,
    data_base64: String,
}

/// 导出当前模型包（供保存到本地，或交给别的系统）。
/// 权限与诊断包同一档：包里是完整的标定查表数据，不是随便能拿的。
#[cfg_attr(feature = "desktop", tauri::command)]
fn export_model_bundle(state: State<'_, AppState>) -> Result<ModelBundleExport, String> {
    guard_permission(&state, auth::Permission::ViewDiagnostics)?;
    let bytes = current_model_bundle_bytes();
    let status = model_status_of();
    Ok(ModelBundleExport {
        file_name: format!("softui-model-{}.{}", status.source, model::EXTENSION),
        source: status.source,
        byte_len: bytes.len(),
        data_base64: base64_encode(&bytes),
    })
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
    // 档位必须**显式**解析：原来 `_ => Limit60n` 会把 20N 之类的值悄悄兜到 60 档。
    let model_for_gauge = current_model();
    let gauge = request
        .table_gauge_n
        .unwrap_or_else(|| model_for_gauge.default_tension());
    let kind = posetable::PoseTableKind::from_tension(gauge)
        .ok_or_else(|| format!("不支持的张力档位：{gauge}N（可选 20/40/60）"))?;
    let query = posetable::encode_rpy_mm(
        request.position_mm,
        request.roll,
        request.pitch,
        request.yaw,
    );
    let model_tables = current_model();
    let shape = model_tables
        .pose(kind)
        .map_err(|error| format!("位姿表档位不可用：{error:?}"))?
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

/// 没有任何真实设备时占位的演示帧 id（见 `make_frame`）。
const DEMO_DEVICE_ID: &str = "softui-sim-01";

/// 这个 device_id 在本机设备表里吗？也就是：它有一条能真正收到字节的传输通道。
///
/// ⚠️ **不能再用 `device_id.starts_with("serial:")` 判断。** 那是"只有服务器本机串口"
/// 时代留下的条件，而现在有三种传输、id 命名各不相同：
///   · 服务器本机串口  `serial:{port_name}`（如 `serial:COM3`）
///   · **Web Serial   `{deviceName}`**（如 `TDCR_v1`）—— 网页端实际用的就是这一种
///   · 内置模拟设备    `simulator:0`
/// 按前缀判断会让**后两种设备的每一条指令都被静默丢弃**（`send_frame_to_device` 直接
/// `Ok(())`），而审计日志照样记"已发送" —— 现场表现为"点了没反应、设备永不确认"，
/// 而且查日志一切正常。这是实测踩到过的坑。
fn device_has_transport(state: &State<'_, AppState>, device_id: &str) -> bool {
    state
        .devices
        .lock()
        .map(|devices| devices.contains(device_id))
        .unwrap_or(false)
}

fn send_frame_to_device(
    state: &State<'_, AppState>,
    device_id: &str,
    frame: &[u8],
    priority: device::CommandPriority,
) -> Result<(), String> {
    let mut devices = state
        .devices
        .lock()
        .map_err(|_| "device registry poisoned".to_string())?;
    match devices.send_command(device_id, frame, priority) {
        Ok(_) => Ok(()),
        // 演示帧不是真实设备：接受但不下发，让没有硬件时界面仍能完整演练。
        Err(device::DeviceRuntimeError::DeviceNotFound(_)) if device_id == DEMO_DEVICE_ID => Ok(()),
        // 其余"找不到设备"一律**报错**，不再假装成功 ——
        // 静默成功会让"其实没发出去"和"发出去但设备没响应"完全无法区分。
        Err(error) => Err(format!("{error:?}")),
    }
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

    if device_has_transport(&state, device_id) {
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


/* ── Web Serial 桥接命令 ─────────────────────────────────────────────
 * 前端用浏览器的 Web Serial 打开**用户本机**串口，把原始字节推给后端；
 * 后端把要下发的命令排进 tx 等前端来取。协议解析全部留在 Rust。
 * ─────────────────────────────────────────────────────────────────── */

/// 每端口的接收序号水位，用于给 `webserial_push` 去重。
///
/// 前端失败会带**同一个 seq** 重试；这里按 seq 忽略重复到达，
/// 重试因此是安全的 —— 既不会丢字节，也不会把同一块喂两遍给解码器。
#[derive(Default)]
struct WsMeta {
    last_seq: u64,
    gaps: u64,
    duplicates: u64,
}

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

/// desktop 只有单窗口，没有多端同步表，数据源标记无处可放 —— 空实现。
#[cfg(feature = "desktop")]
fn sync_set_source(_client_id: Option<String>) {}

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

    /**
     * **帧到了就等价于握手成功** ✓ —— 先推进状态再取 `runtime` ✓，
     * 这样后面的安全判定拿到的是 `Ready` 而不是 `Handshaking` ✓。
     * （`P1` 本地解析模式下后端收不到原始字节 ✗，握手态只能由帧驱动 ✓）
     */
    if let Ok(mut devices) = state.devices.lock() {
        devices.note_frame(&frame.device_id);
        // **接收帧计数**也由这条路径推进 ✓（`P1` 模式下后端读不到原始字节 ✓）
        devices.note_ingested_frame(&frame.device_id);
    }

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
                .map(|sensor| sensor.filtered_value)
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
    // ── 指令集 V2：多设备上行 ──
    /// 上行协议版本：1 = Legacy V1（`0xBB`），2 = V2（`0x55` + 设备 ID）。
    protocol_version: u8,
    /// 是否已回过版本协商（`AA 09 01 02`）。
    protocol_negotiated: bool,
    tension_frames: u64,
    calibration_events: u64,
    unknown_frames: u64,
    last_tension: Option<protocol::TensionFrame>,
    last_calibration: Option<protocol::CalibrationEvent>,
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
        protocol_version: runtime.protocol_version,
        protocol_negotiated: runtime.protocol_negotiated,
        tension_frames: runtime.tension_frames,
        calibration_events: runtime.calibration_events,
        unknown_frames: runtime.unknown_frames,
        last_tension: runtime.last_tension,
        last_calibration: runtime.last_calibration,
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

    if device_has_transport(&state, &device_id)
        && matches!(request.action, SystemControlActionRequest::Disable)
    {
        if let Ok(mut devices) = state.devices.lock() {
            let _ = devices.mark_control_enabled(&device_id, false);
        }
    }

    send_frame_to_device(&state, &device_id, &frame, priority)?;

    if device_has_transport(&state, &device_id) {
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

    // V2 `0x10` 的数据段是 `addr / dir / dist / vel`，**没有加速度字段** ——
    // 旧实现多发 2 字节加速度，下位机只读 6 字节，整帧被静默丢弃。
    // 加速度是模型侧的量，不在本指令里下发。
    let frame = protocol::encode_motor_command(
        request.motor_id,
        request.position_mm,
        request.velocity_mm_per_sec.unwrap_or(10.0),
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

/// **把位移表索引导出给前端** ✓ —— 前端本地查表用 ✓。
///
/// 为什么这么做 ✗：曲率/位姿下发每次都要"后端查表 + 发送"✓，
/// 查表那一段是一条 RPC 往返（经隧道 200ms+ ✓，排队时更久 ✗）。
/// 表本身只有 1031 个样本 ✓，导出成 90KB 的索引给前端 ✓ →
/// 拖动 / 位姿下发 / 动作组全部变成纯本地计算 + 本机直发 ✓ → ms 级 ✓。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VcTableIndex {
    n: usize,
    /// 每个样本：`tip`（svc 系 mm ✓）+ `dl`（6 路目标位移 mm ✓）
    samples: Vec<VcTableIndexSample>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VcTableIndexSample {
    tip: [f64; 3],
    dl: [f64; 6],
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn vc_table_index() -> Result<VcTableIndex, String> {
    let model_tables = current_model();
    let vc = model_tables
        .vc
        .as_ref()
        .ok_or_else(|| "当前模型不是新格式（缺 KTB1/PTB1）".to_string())?;
    let rows = vc.dump_index();
    Ok(VcTableIndex {
        n: rows.len(),
        samples: rows
            .into_iter()
            .map(|(tip, dl)| VcTableIndexSample { tip, dl })
            .collect(),
    })
}

/// **只记录、不发送**的控制帧 ✓ —— 给"前端本机直发"那条路径用 ✓。
///
/// 为什么需要 ✗：本机直连串口后 ✓，指令**已经在浏览器里写进串口**了 ✓，
/// 后端不需要也不能再发一遍（发了就是双份动作 ✓，相对位移类会走两倍距离 ✗）。
/// 但后端仍必须知道"这件事发生过" ✓，否则：
///   · `control_enabled` 停在旧值 ✓ → 远程端（手机/另一台电脑）的指令被
///     `guard_command_allowed` 拒掉 ✗
///   · 审计 / 会话录制缺这一帧 ✗ → 复盘时看不到操作 ✗
///
/// 所以这里只做三件事：**更新内存状态 ✓、写审计 ✓、写日志 ✓**，绝不碰串口 ✓。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControlFrameLogRequest {
    device_id: Option<String>,
    /// 指令类别：`system-control` / `home` / `motor` / ……（只用于审计文案 ✓）
    kind: String,
    /// 前端实际写出去的帧（十六进制 ✓），用于审计
    frame_hex: Option<String>,
    /// 系统控制动作：`enable` / `disable` / `emergencyStop`（其它类别不传 ✓）
    action: Option<String>,
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn control_frame_log(
    state: State<'_, AppState>,
    request: ControlFrameLogRequest,
) -> Result<RuntimeSnapshot, String> {
    let device_id = selected_device_id(request.device_id.clone());
    let frame_hex = request.frame_hex.unwrap_or_default();
    let label = match request.kind.as_str() {
        "system-control" => "system control dispatched (browser direct)",
        "home" => "home command dispatched (browser direct)",
        "motor" => "motor command dispatched (browser direct)",
        _ => "control frame dispatched (browser direct)",
    };

    // ① 状态对账：和 `submit_system_control` 同口径 ✓，但不发帧 ✓
    if let Some(action) = request.action.as_deref() {
        if let Ok(mut devices) = state.devices.lock() {
            match action {
                "enable" => {
                    let _ = devices.mark_control_enabled(&device_id, true);
                }
                "emergencyStop" => {
                    let _ = devices.mark_emergency_stopped(&device_id);
                    if let Ok(mut control) = state.control_runtime.lock() {
                        control.stop("emergency stop latched");
                    }
                }
                "disable" => {
                    let _ = devices.mark_control_enabled(&device_id, false);
                    if let Ok(mut control) = state.control_runtime.lock() {
                        control.stop("device control is not enabled");
                    }
                }
                _ => {}
            }
        }
    }

    // ② 审计 + ③ 日志（和 `audit_control_frame` 的后半段一致 ✓，只是不发帧 ✓）
    record_control_command(
        &state,
        &device_id,
        label,
        &frame_hex,
        &serde_json::json!({ "kind": request.kind, "direct": true }),
    );
    state.store.mutate(|data| {
        data.sequence = data.sequence.saturating_add(1);
        data.logs.push(log_entry(
            data.sequence,
            LogLevel::Info,
            "control",
            label,
            Some(&device_id),
            Some(&frame_hex),
        ));
    });
    Ok(state.snapshot())
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
    // 档位同样**显式**解析：原来 `_ => Limit60n` 会把 20N 悄悄兜到 60 档，
    // 换到新臂（20/40N）后就会报「不含 60N 表」。
    let model_for_gauge = current_model();
    let gauge = request
        .table_gauge_n
        .unwrap_or_else(|| model_for_gauge.default_tension());
    let kind = kappatable::KappaTableKind::from_tension(gauge)
        .ok_or_else(|| format!("不支持的张力档位：{gauge}N（可选 20/40/60）"))?;
    let model_tables = current_model();
    let table = model_tables
        .kappa(kind)
        .map_err(|error| format!("κ 表档位不可用：{error:?}"))?;
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
/// `send_tip_pose_command` 的返回值。
///
/// 除了快照，**把模型查表算出来的 6 路电机目标一起带回去** —— 界面「下发目标」列要显示的
/// 就是它。刻意放进返回值、而不是让前端再查一次表：实时跟随是逐帧下发的，多一次 RPC
/// 就多一次往返延迟，而这份数据后端**本来就已经算出来了**（`lookup.displacement_mm`）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TipPoseCommandResult {
    pub snapshot: RuntimeSnapshot,
    /// 6 路肌腱的目标位移（mm），顺序对应 `start_address` 起的 6 个电机。
    /// 定长 6，与 `lookup.displacement_mm` 同型（序列化成 JSON 数组，前端仍按 number[] 读）。
    pub target_displacement_mm: [f64; 6],
    /// 与表中最近解的白化距离，越小越接近目标。
    pub nearest_distance: f64,
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn send_tip_pose_command(
    state: State<'_, AppState>,
    request: TipPoseCommandRequest,
) -> Result<TipPoseCommandResult, String> {
    let device_id = selected_device_id(request.device_id.clone());
    let model_tables = current_model();

    // ═══════════════════════════════════════════════════════════════
    // **新模型（KTB1/PTB1/KSB1/KKB1）—— 唯一路径** ✓
    //
    // 老臂的 `K40/P40/K20/P20` 逻辑**已全部移除** ✗：
    //   ① 新模型的老字段是**用旧臂包垫的** ✗ → 查出来的位移是旧臂的 ✓
    //      → **符号和量级都不对** ✗（向后拉算出负值 ✓ 本 bug ✓）
    //   ② 现在只剩一台臂 ✓，留两套路只会让人以为"还有人在用旧臂"✗
    // ═══════════════════════════════════════════════════════════════
    let vc = model_tables.vc.as_ref().ok_or_else(|| {
        "当前模型不是新格式（缺 KTB1/PTB1）✗，请重新导入模型包".to_string()
    })?;

    let (mut displacement_mm, nearest_distance) =
        vc.interpolate_by_tip_mm(request.position_mm).ok_or_else(|| {
            "新模型的位移表为空 ✗".to_string()
        })?;

    if nearest_distance > 120.0 {
        let message = format!(
            "位姿超出位移表覆盖范围：最近邻距离 {nearest_distance:.1} > 120，请把末端目标移回可达空间内",
        );
        record_control_failure(&state, &device_id, &message);
        return Err(message);
    }

    // **时间平滑** ✓ —— 和动作库播放时一样的做法 ✓：
    //   表是离散的 ✓，相邻样本 `dL` 差 1~2mm ✗ → 直接下发会**顿一下** ✗。
    //   这里对**上一帧下发的量**做低通 ✓（α=0.35 ✓），差 5mm 时约 3 帧收敛 ✓。
    {
        let mut guard = last_sent_displacement()
            .lock()
            .map_err(|_| "位移缓存锁失败".to_string())?;
        if let Some(previous) = guard.as_ref() {
            const ALPHA: f64 = 0.35;
            for axis in 0..6 {
                displacement_mm[axis] =
                    previous[axis] * (1.0 - ALPHA) + displacement_mm[axis] * ALPHA;
            }
        }
        *guard = Some(displacement_mm);
    }
    let absolute_mm: [f64; 6] = displacement_mm;

    let frame = protocol::encode_multi_motor_command(
        request.start_address.unwrap_or(1),
        &absolute_mm,
    )
    .map_err(|error| format!("{error:?}"))?;

    let snapshot = audit_control_frame(
        state,
        device_id,
        "tip pose command sent",
        frame,
        CommandSafety::Enabled,
    )?;

    Ok(TipPoseCommandResult {
        snapshot,
        // 回**实际下发**的绝对位移：界面「目标 mm」才和线上那帧对得上
        target_displacement_mm: absolute_mm,
        nearest_distance,
    })
}

/// **是否允许真实下发** ✗ —— 默认 **关** ✓。
///
/// 安全策略第 ② 条 ✓：默认只预览不下发 ✓，必须显式打开 ✓。
/// 每次进程启动都回到"关" ✓（不持久化 ✗）—— 避免"上次开着，重启还以为安全"✗。
static DISPATCH_ALLOWED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 查询 / 设置"允许下发" ✓。
fn set_dispatch_allowed(allowed: bool) -> serde_json::Value {
    DISPATCH_ALLOWED.store(allowed, std::sync::atomic::Ordering::SeqCst);
    if !allowed {
        // 关掉时**顺手清掉平滑缓存** ✓ —— 下次开启时不要被旧值拖住 ✗
        if let Ok(mut guard) = last_sent_displacement().lock() {
            *guard = None;
        }
    }
    serde_json::json!({ "dispatchAllowed": allowed })
}

fn dispatch_allowed() -> bool {
    DISPATCH_ALLOWED.load(std::sync::atomic::Ordering::SeqCst)
}

/// **上次下发的 6 路位移** ✓ —— 时间平滑用 ✓。
///
/// 为什么需要 ✗：位移表是离散的 ✓，相邻样本差 1~2mm ✗ →
/// 逐点直接下发会让电机**一顿一顿**✗。对上一帧做低通后就连续了 ✓。
static LAST_SENT_DISPLACEMENT: std::sync::OnceLock<std::sync::Mutex<Option<[f64; 6]>>> =
    std::sync::OnceLock::new();

fn last_sent_displacement() -> &'static std::sync::Mutex<Option<[f64; 6]>> {
    LAST_SENT_DISPLACEMENT.get_or_init(|| std::sync::Mutex::new(None))
}

/// **只算不发** ✓ —— 返回「这个末端位姿会下发的 6 路位移」✓。
///
/// 和 `send_tip_pose_command` 走**完全相同的查表逻辑** ✓（同一档位 ✓、同一 `lookup_shape` ✓），
/// 区别只有一句：**不编码帧、不写串口** ✗。
///
/// 用途：动作库 / 策略编排播放时 ✓，监控卡要显示"目标位移在变"✓，
/// 但默认**不能真的动** ✗（安全策略：需显式勾选允许下发 ✓）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TipPosePreviewResult {
    /// 6 路肌腱目标位移（mm）✓（和下发那条**完全一致** ✓）
    target_displacement_mm: Vec<f64>,
    /// 最近邻距离 ✓（判断"离表达多远"✓）
    nearest_distance: f64,
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn preview_tip_pose_command(request: TipPoseCommandRequest) -> Result<TipPosePreviewResult, String> {
    // **和老臂逻辑彻底脱钩** ✗ —— 新模型只有一个 20N 表 ✓，没有档位概念 ✓
    let _ = request.table_gauge_n;
    // ⚠ **不要 `vc.clone()`** ✗ —— 它会深拷贝 1031 个样本 ✗（每次约 200KB ✓）
    //   拖动控制每秒几十次 ✓ → 就是"帧率变慢"的元凶 ✗（本 bug ✓）。
    //   先绑定模型 ✓（`current_model()` 返回临时值 ✓，不绑定会被借用检查拒绝 ✓），再借 `vc` ✓。
    let model_tables = current_model();
    let vc = model_tables
        .vc
        .as_ref()
        .ok_or_else(|| "当前模型不是新格式（缺 KTB1/PTB1）✗".to_string())?;
    let (displacement, nearest_distance) = vc
        .interpolate_by_tip_mm(request.position_mm)
        .ok_or_else(|| "新模型的位移表为空 ✗".to_string())?;
    if nearest_distance > 120.0 {
        return Err(format!("位姿超出覆盖范围：最近邻 {nearest_distance:.1} > 120"));
    }

    Ok(TipPosePreviewResult {
        target_displacement_mm: displacement.to_vec(),
        nearest_distance,
    })
}

/// **批量预计算** ✓ —— 播放开始时把整条轨迹的 6 路位移**一次算完** ✓。
///
/// 为什么 ✗：逐点调 `preview_tip_pose_command` 时 ✓，每次都要再查一遍表 ✓，
/// 网络/查表开销叠加 ✓ → 界面"隔很久才跳一下"✗（实测 ✓）。
/// 一次请求算完 ✓，播放时纯前端查数组 ✓ → **零延迟** ✓。
///
/// 参数 `positionsMm` 是末端点的平铺数组 ✓（`[x0,y0,z0, x1,y1,z1, …]` ✓）。
/// 不可达的点返回 `null` ✓（前端沿用上一个可达点 ✓，不闪 0 ✗）。
#[cfg_attr(feature = "desktop", tauri::command)]
fn preview_tip_pose_batch(
    positions_mm: Vec<f64>,
    table_gauge_n: Option<u8>,
) -> Result<Vec<Option<Vec<f64>>>, String> {
    // **新模型优先** ✓ —— `KTB1`/`PTB1`/`FTB1` 三段存在时走这条路 ✓
    //   （`PTB1` 已经是前端坐标系 ✓，不用换轴 ✗）
    let maybe_vc = current_model();
    if let Some(vc) = maybe_vc.vc.as_ref() {
        let mut out = Vec::with_capacity(positions_mm.len() / 3);
        for chunk in positions_mm.chunks_exact(3) {
            match vc.interpolate_by_tip_mm([chunk[0], chunk[1], chunk[2]]) {
                // **`dL_mm` 就是 6 路目标位移** ✓（`KTB1` 的后 6 个分量 ✓）
                // 阈值按表密度定 ✓：1031 个点摊在臂长 445mm 的空间里 ✓，
                // 60mm 太紧（边缘全 None ✗），120mm 能覆盖大部分真实轨迹 ✓。
                Some((dl, distance)) if distance <= 120.0 => {
                    out.push(Some(dl.to_vec()));
                }
                // 太远 = 表里没有附近样本 ✗ → 返回 None ✓（前端沿用上一帧 ✓，不闪 0 ✗）
                _ => out.push(None),
            }
        }
        return Ok(out);
    }

    let model_for_gauge = current_model();
    let gauge: u8 = table_gauge_n.unwrap_or_else(|| model_for_gauge.default_tension());
    let kind = posetable::PoseTableKind::from_tension(gauge)
        .ok_or_else(|| format!("不支持的张力档位：{gauge}N（可选 20/40/60）"))?;
    let model_tables = current_model();
    let pose_table = model_tables
        .pose(kind)
        .map_err(|error| format!("位姿表档位不可用：{error:?}"))?;

    let mut out = Vec::with_capacity(positions_mm.len() / 3);
    for chunk in positions_mm.chunks_exact(3) {
        let query = posetable::encode_rpy_mm([chunk[0], chunk[1], chunk[2]], 0.0, 0.0, 0.0);
        let covered = pose_table
            .lookup(&query)
            .map(|lookup| lookup.covered)
            .unwrap_or(false);
        if !covered {
            out.push(None);
            continue;
        }
        out.push(match pose_table.lookup_shape(&query) {
            Ok(shape) => Some(shape.displacement_mm.to_vec()),
            Err(_) => None,
        });
        // 🔍 诊断（验证完删 ✓）
        if out.len() <= 4 {
            if let Ok(shape) = pose_table.lookup_shape(&query) {
                eprintln!(
                    "[batch-debug] pos={:?} query[0..3]={:?} nearest={:.1} disp={:?}",
                    &chunk,
                    &query[0..3],
                    shape.nearest_distance,
                    shape.displacement_mm[0]
                );
            }
        }
    }
    Ok(out)
}

#[cfg_attr(feature = "desktop", tauri::command)]
fn calibrate_sensor(
    state: State<'_, AppState>,
    request: SensorCalibrationRequest,
) -> Result<RuntimeSnapshot, String> {
    guard_permission(&state, auth::Permission::RunCalibration)?;

    let device_id = selected_device_id(request.device_id);
    // V2 `0x23` 砝码校准：`id(1) weight(2)`，重量单位是**克**（下位机收 g×10）。
    // 旧实现既用 `0xBB` 当**下行**帧头（下行固定 0xAA），又按 ×100 缩放，两处都不对。
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

    // V2 `0x40` 单段弯曲：**一段一帧**（`seg(1) dir(1) angle(2)`）。
    //
    // 旧实现把两段压进 `AA 05` 的一帧里：`0x05` 在指令集里是「动作组演示」且无数据段，
    // 而且 `seg` 被写死为 1 —— 第二段永远下发不出去。
    //
    // 两帧是**串口上的连续字节**，拼在一起下发与分两次下发等价；拼在一起只是让审计
    // 日志里一条记录就能看到本次全部下发内容。第二段角度为 0 视为「本段不动」，跳过，
    // 省得一帧 `0°` 把正在弯曲的臂体往回带。
    let mut payload = Vec::new();
    let segments = [
        (1u8, request.direction1, request.angle1_deg),
        (2u8, request.direction2, request.angle2_deg),
    ];
    for (segment, direction, angle_deg) in segments {
        if segment == 2 && angle_deg == 0.0 {
            continue;
        }
        // 前端方向码 0 = 朝上，其余（右/下/左）一律按朝下下发。
        let frame = protocol::encode_single_bend_command(segment, direction == 0, angle_deg)
            .map_err(|error| format!("{error:?}"))?;
        payload.extend_from_slice(&frame);
    }

    audit_control_frame(
        state,
        device_id,
        "bend command sent",
        payload,
        CommandSafety::Enabled,
    )
}

/// 主动控制 tick：V2 `0x41`（`0x4_` 动作组），无数据段。
///
/// 旧实现发 `AA 06 02 02 00` —— 既不是 V1 `0x06`（多电机自定义，`count=2` 却只跟了
/// 1 字节，长度不自洽），也不属于任何已定义功能码，下位机只会当畸形帧丢弃。
#[cfg_attr(feature = "desktop", tauri::command)]
fn send_active_control_tick(
    state: State<'_, AppState>,
    request: ActiveControlRequest,
) -> Result<RuntimeSnapshot, String> {
    let device_id = selected_device_id(request.device_id);
    let frame = protocol::encode_active_control_command()
        .map_err(|error| format!("{error:?}"))?;
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

    #[test]
    fn base64_encode_matches_rfc4648_vectors() {
        // RFC 4648 §10 的标准向量：手写编码器必须逐字节对上
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        // 边界：全 0 / 全 0xff，以及长度对 3 取余的三种情况
        assert_eq!(base64_encode(&[0, 0, 0]), "AAAA");
        assert_eq!(base64_encode(&[0xff, 0xff, 0xff]), "////");
        assert_eq!(base64_encode(&[0xff]), "/w==");
        assert_eq!(base64_encode(&[0xff, 0xff]), "//8=");
        // 长度必须是 4 的倍数 —— 不少客户端按这个校验
        for len in 0..64usize {
            assert_eq!(base64_encode(&vec![0xA5u8; len]).len() % 4, 0);
        }
    }

    use super::*;

    fn trunc2(value: f64) -> f64 {
        (value * 100.0).trunc() / 100.0
    }

    #[test]
    fn simulated_snapshot_reports_actual_protocol_version() {
        let seq = 64;
        let simulator = transport::SimulatorTransport::with_seed(seq).expect("simulator");
        let mut runtime = device::DeviceRuntime::new(simulator);
        let protocol_status = runtime.handshake().expect("status");
        let snapshot = make_frame(seq, true);

        // 模拟设备发的是 V2 帧，标签必须跟着走（旧实现写死 "Legacy V1"）。
        assert_eq!(snapshot.protocol_version, "V2 (0x55)");
        assert!(snapshot.system_enabled);
        assert_eq!(snapshot.motors.len(), protocol_status.motors.len());
        assert_eq!(snapshot.sensors.len(), protocol_status.sensors.len());
        assert_eq!(
            snapshot.motors[0].position_mm,
            trunc2(protocol_status.motors[0].position_mm)
        );
        assert_eq!(
            snapshot.sensors[0].raw_value,
            protocol_status.sensors[0].x
        );
        assert_eq!(
            snapshot.sensors[0].filtered_value,
            protocol_status.sensors[0].y
        );
        assert_eq!(
            snapshot.bend.section1.angle_deg,
            trunc2(protocol_status.scale)
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
    fn newly_exposed_control_commands_use_v2_frames() {
        let home = protocol::encode_home_command(2, 1).expect("home");
        let sensor = protocol::encode_sensor_calibration(2, 3.25).expect("sensor");
        let bend = protocol::encode_single_bend_command(1, true, 12.34).expect("bend");
        let active = protocol::encode_active_control_command().expect("active control");

        assert_eq!(frame_hex(&home), "AA 11 06 02 01 00 00 00 00 C4");
        assert_eq!(frame_hex(&sensor), "AA 23 03 02 00 21 F3");
        assert_eq!(frame_hex(&bend), "AA 40 04 01 00 04 D2 C5");
        // 主动控制在 0x4_ 动作组（与 0x40 同组）
        assert_eq!(frame_hex(&active), "AA 41 00 EB");
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
                scale: 0.0,
                arm_bend: 0.0,
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
            protocol_version: 2,
            protocol_negotiated: true,
            tension_frames: 0,
            calibration_events: 0,
            unknown_frames: 0,
            last_tension: None,
            last_calibration: None,
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
            sensors: vec![protocol::SensorData { x: 1.0, y: 2.0 }],
            scale: 4.0,
            arm_bend: 5.0,
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
            protocol_version: 2,
            protocol_negotiated: true,
            tension_frames: 0,
            calibration_events: 0,
            unknown_frames: 0,
            last_tension: None,
            last_calibration: None,
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
            protocol_version: 1,
            protocol_negotiated: false,
            tension_frames: 0,
            calibration_events: 0,
            unknown_frames: 0,
            last_tension: None,
            last_calibration: None,
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
                                    .map(|sensor| sensor.filtered_value)
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
            // 模型库 / AI 配置 / 界面共享数据 / 日志清理这些模块都是**按 `SOFTUI_STATE`
            // 推导目录**的（见 `models_dir()` 等）。desktop 以前没设它，于是导入的模型
            // 落在 `%TEMP%\models` 而不是应用数据目录 —— 会被系统清理，也和 `AppState`
            // 的数据目录分家。这里显式对齐一次。
            if std::env::var_os("SOFTUI_STATE").is_none() {
                std::env::set_var("SOFTUI_STATE", &state_path);
            }
            migrate_legacy_models(&state_path);
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
            import_model_base64,
            list_models,
            list_model_presets,
            save_model_params,
            select_model,
            delete_model,
            rename_model,
            export_model,
            lookup_tip_pose_shape,
            shape_from_displacements,
            vc_table_index,
            preview_tip_pose_command,
            preview_tip_pose_batch,
            control_frame_log,
            delete_logs,
            purge_logs,
            restore_logs,
            get_ui_store,
            set_ui_store,
            submit_ui_store,
            list_pending_ui_store,
            approve_ui_store,
            approve_ui_store_entry,
            reject_ui_store,
            list_rejections,
            clear_rejections,
            acknowledge_rejection,
            set_ai_key,
            ai_key_status,
            ai_compose_policy,
            model_status,
            reset_model,
            export_model_bundle,
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
        "export_model_bundle" => {
            export_model_bundle(st).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
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
        "list_models" => list_models()
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        "delete_model" => delete_model(arg::<String>(&args, "id")?)
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        "rename_model" => rename_model(
            arg::<String>(&args, "id")?,
            arg::<String>(&args, "name")?,
        )
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        "import_model_base64" => import_model_base64(
            arg::<String>(&args, "data")?,
            arg_opt::<String>(&args, "name")?,
        )
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        "submit_ui_store" => submit_ui_store(
            arg::<String>(&args, "namespace")?,
            arg::<serde_json::Value>(&args, "data")?,
            arg::<String>(&args, "submittedBy")?,
        )
        .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "list_rejections" => serde_json::to_value(list_rejections())
            .map_err(|error| error.to_string()),
        "clear_rejections" => serde_json::to_value(clear_rejections(
            arg::<String>(&args, "namespace")?,
        ))
        .map_err(|error| error.to_string()),
        "acknowledge_rejection" => serde_json::to_value(acknowledge_rejection(
            arg::<String>(&args, "id")?,
        ))
        .map_err(|error| error.to_string()),
        "list_pending_ui_store" => list_pending_ui_store()
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "approve_ui_store_entry" => approve_ui_store_entry(
            arg::<String>(&args, "id")?,
            arg::<String>(&args, "entryId")?,
        )
        .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "approve_ui_store" => approve_ui_store(arg::<String>(&args, "id")?)
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "reject_ui_store" => reject_ui_store(arg::<String>(&args, "id")?)
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "ai_compose_policy" => ai_compose_policy_blocking(
            arg::<String>(&args, "prompt")?,
            arg::<serde_json::Value>(&args, "context")?,
            arg::<Option<String>>(&args, "username").unwrap_or(None),
        )
        .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "ai_config_status" => Ok::<serde_json::Value, String>(ai_config_status()),
        "ai_key_status" => Ok::<serde_json::Value, String>(ai_key_status(
            arg::<String>(&args, "username")?,
        )),
        "set_ai_key" => set_ai_key(
            arg::<String>(&args, "username")?,
            arg::<String>(&args, "apiKey")?,
            arg::<Option<String>>(&args, "model").unwrap_or(None),
            arg::<Option<String>>(&args, "baseUrl").unwrap_or(None),
        )
        .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "save_ai_config" => save_ai_config(
            arg::<String>(&args, "apiKey")?,
            arg::<Option<String>>(&args, "baseUrl").unwrap_or(None),
            arg::<Option<String>>(&args, "model").unwrap_or(None),
        )
        .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "purge_logs" => purge_logs(st, arg::<Vec<i64>>(&args, "ids")?),
        "restore_logs" => restore_logs(st, arg::<Vec<i64>>(&args, "ids")?),
        "delete_logs" => delete_logs(st, arg::<Vec<i64>>(&args, "ids")?),
        "get_ui_store" => get_ui_store(arg::<String>(&args, "namespace")?)
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "set_ui_store" => set_ui_store(
            arg::<String>(&args, "namespace")?,
            arg::<serde_json::Value>(&args, "data")?,
        )
        .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "save_model_params" => save_model_params(
            arg::<String>(&args, "id")?,
            arg::<ModelParams>(&args, "params")?,
        )
        .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        "export_model" => export_model(arg::<String>(&args, "id")?)
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
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
        "vc_table_index" => vc_table_index()
            .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string())),
        "control_frame_log" => {
            let request: ControlFrameLogRequest = arg(args, "request")?;
            control_frame_log(st, request)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "send_multi_motor_command" => {
            let request: MultiMotorCommandRequest = arg(args, "request")?;
            send_multi_motor_command(st, request).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "send_curvature_command" => {
            let request: CurvatureCommandRequest = arg(args, "request")?;
            send_curvature_command(st, request).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "preview_tip_pose_batch" => {
            let positions = arg::<Vec<f64>>(&args, "positionsMm")?;
            let gauge = arg::<Option<u8>>(&args, "tableGaugeN").unwrap_or(None);
            preview_tip_pose_batch(positions, gauge)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "set_dispatch_allowed" => Ok::<serde_json::Value, String>(set_dispatch_allowed(
            arg::<bool>(&args, "allowed")?,
        )),
        "dispatch_allowed" => Ok::<serde_json::Value, String>(
            serde_json::json!({ "dispatchAllowed": dispatch_allowed() }),
        ),
        "preview_tip_pose_command" => {
            let request = arg::<TipPoseCommandRequest>(&args, "request")?;
            preview_tip_pose_command(request)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
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
        "shape_from_displacements" => {
            let displacement_mm: Vec<f64> = arg(args, "displacementMm")?;
            shape_from_displacements(displacement_mm)
                .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "list_model_presets" => serde_json::to_value(list_model_presets())
            .map_err(|error| error.to_string()),
        "select_model" => {
            let id: String = arg(args, "id")?;
            select_model_preset(id).and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
        }
        "webserial_push" => {
            let port_name: String = arg(args, "port_name")?;
            let bytes: Vec<u8> = arg(args, "bytes")?;
            let seq: Option<u64> = arg_opt(args, "seq")?;
            /**
             * **字节到后端 = 链路通** ✓ —— 老路径（原始字节上报 ✓）也要推进握手态 ✓。
             * 只在 `frame_ingest` 里做的话 ✓，走这条路径的设备会永远停在
             * `Handshaking` ✗（实测 ✓）。
             */
            if !bytes.is_empty() {
                let mut drop_bytes = false;
                if let Ok(mut devices) = st.devices.lock() {
                    /**
                     * **已有客户端在本地解析 → 丢弃原始字节** ✓。
                     *
                     * 多端场景下（电脑 + 手机 + 旧标签页 ✓），旧客户端仍会把原始字节推上来 ✗，
                     * 与本地解析上报的帧同时喂解析器 ✓ → 重复块 / 半包 → 协议错误疯长 ✗。
                     * 这里直接丢弃 ✓，并且**不再推进握手态**（帧通路已由 ingest 负责 ✓）。
                     */
                    if devices.has_recent_ingest(&port_name, 3000) {
                        drop_bytes = true;
                    } else {
                        devices.note_port_activity(&port_name);
                    }
                }
                if drop_bytes {
                    return Ok(serde_json::json!({
                        "accepted": 0, "duplicate": true, "gaps": 0, "duplicates": 0,
                    }));
                }
            }
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

/* ── 日志删除 / 恢复 / 彻底清除 ───────────────────────────────────────
 * 日志是 `AppState.store` 里的内存数据 + 状态文件里的持久化副本。
 *   只改文件 ✗ —— 下次 `mutate` 会把内存写回去，删除"复活" ✓（旧实现的问题）
 *   只改内存 ✗ —— 重启后状态文件里还在 ✗
 * 所以统一走 `store.mutate`：一次同时改内存和落盘 ✓。
 * ─────────────────────────────────────────────────────────────────── */

fn wanted_log_ids(ids: &[i64]) -> std::collections::HashSet<u64> {
    ids.iter()
        .filter(|id| **id > 0)
        .map(|id| *id as u64)
        .collect()
}

/// **软删除** ✓ —— 打 `deleted` 标记 ✓，进回收站，可恢复 ✓。
fn mark_logs_deleted(state: &AppState, ids: &[i64]) -> usize {
    let wanted = wanted_log_ids(ids);
    if wanted.is_empty() {
        return 0;
    }
    let now = now_ms();
    let mut removed = 0usize;
    state.store.mutate(|data| {
        for entry in data.logs.iter_mut() {
            if wanted.contains(&entry.id) && !entry.deleted {
                entry.deleted = true;
                entry.deleted_at_ms = now;
                removed += 1;
            }
        }
    });
    removed
}

/// **彻底删除** ✓ —— 从内存和状态文件里真的抹掉 ✓。
fn purge_logs_in_store(state: &AppState, ids: &[i64]) -> usize {
    let wanted = wanted_log_ids(ids);
    if wanted.is_empty() {
        return 0;
    }
    let mut removed = 0usize;
    state.store.mutate(|data| {
        let before = data.logs.len();
        data.logs.retain(|entry| !wanted.contains(&entry.id));
        removed = before - data.logs.len();
    });
    removed
}

/// **恢复软删除的日志** ✓（把标记摘掉 ✓）。
fn restore_logs_in_store(state: &AppState, ids: &[i64]) -> usize {
    let wanted = wanted_log_ids(ids);
    if wanted.is_empty() {
        return 0;
    }
    let mut restored = 0usize;
    state.store.mutate(|data| {
        for entry in data.logs.iter_mut() {
            if wanted.contains(&entry.id) && entry.deleted {
                entry.deleted = false;
                entry.deleted_at_ms = 0;
                restored += 1;
            }
        }
    });
    restored
}

/// 软删除日志（进回收站）✓。
#[cfg_attr(feature = "desktop", tauri::command)]
fn delete_logs(state: State<'_, AppState>, ids: Vec<i64>) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "removed": mark_logs_deleted(&state, &ids) }))
}

/// 彻底删除日志（回收站里的"永久删除"）✓。
#[cfg_attr(feature = "desktop", tauri::command)]
fn purge_logs(state: State<'_, AppState>, ids: Vec<i64>) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "removed": purge_logs_in_store(&state, &ids) }))
}

/// 从回收站恢复日志 ✓。
#[cfg_attr(feature = "desktop", tauri::command)]
fn restore_logs(state: State<'_, AppState>, ids: Vec<i64>) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "restored": restore_logs_in_store(&state, &ids) }))
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
