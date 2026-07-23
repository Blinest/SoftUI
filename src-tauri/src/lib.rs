pub mod auth;
pub mod control;
pub mod device;
pub mod live;
pub mod migration;
pub mod playback;
pub mod profiles;
pub mod protocol;
pub mod session;
pub mod storage;
pub mod transport;

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
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
struct ChartChannel {
    name: String,
    unit: String,
    #[serde(rename = "channelType")]
    channel_type: String,
    #[serde(rename = "channelIndex")]
    channel_index: u32,
    points: Vec<f64>,
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
    charts: ChartSection,
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
    frames: Vec<DeviceSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChartSection {
    window_size: usize,
    channels: Vec<ChartChannel>,
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
    let simulator = transport::SimulatorTransport::with_seed(seq).expect("simulator should start");
    let mut runtime = device::DeviceRuntime::new(simulator);
    let mut status = runtime
        .handshake()
        .expect("simulated runtime should handshake");
    if !connected {
        status.system_state = 0;
    }
    let quality = if connected {
        FrameQuality::Ok
    } else {
        FrameQuality::Warning
    };
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
            latency_ms: if connected { 18 } else { 52 },
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
    if live_frames.is_empty() {
        return;
    }

    snapshot.live.selected_device_id = live_frames[0].device_id.clone();
    snapshot.live.frames = live_frames.to_vec();
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

fn make_charts(seq: u64) -> ChartSection {
    let motor_channels = vec![
        ("Motor 1", "mm", "motor", 1, 0.0, 0.32),
        ("Motor 2", "mm", "motor", 2, 0.5, 0.29),
        ("Motor 3", "mm", "motor", 3, 1.0, 0.26),
        ("Motor 4", "mm", "motor", 4, 1.5, 0.23),
        ("Motor 5", "mm", "motor", 5, 2.0, 0.2),
        ("Motor 6", "mm", "motor", 6, 2.5, 0.17),
    ];
    let mut channels: Vec<ChartChannel> = motor_channels
        .into_iter()
        .map(|(name, unit, ctype, idx, offset, scale)| ChartChannel {
            name: name.to_string(),
            unit: unit.to_string(),
            channel_type: ctype.to_string(),
            channel_index: idx,
            points: (0..120)
                .map(|i| {
                    let x = i as f64 / 8.0 + seq as f64 / 18.0 + offset;
                    0.5 + (x.sin() * scale + x.cos() * scale * 0.5)
                })
                .collect(),
        })
        .collect();

    // Add bend channels
    channels.push(ChartChannel {
        name: "Bend S1".to_string(),
        unit: "deg".to_string(),
        channel_type: "bend".to_string(),
        channel_index: 1,
        points: (0..120)
            .map(|i| 15.0 + ((i as f64 + seq as f64) / 20.0).sin() * 10.0)
            .collect(),
    });
    channels.push(ChartChannel {
        name: "Bend S2".to_string(),
        unit: "deg".to_string(),
        channel_type: "bend".to_string(),
        channel_index: 2,
        points: (0..120)
            .map(|i| 10.0 + ((i as f64 + seq as f64) / 15.0).cos() * 8.0)
            .collect(),
    });

    ChartSection {
        window_size: 120,
        channels,
    }
}

fn make_charts_from_motors(frames: &[DeviceSnapshot]) -> ChartSection {
    if frames.is_empty() {
        return make_charts(0);
    }
    let motor_count = frames[0].motors.len();
    let sensor_count = frames[0].sensors.len();
    let mut channels: Vec<ChartChannel> = Vec::new();

    // Motor position channels
    for motor_idx in 0..motor_count {
        let points: Vec<f64> = frames
            .iter()
            .map(|frame| {
                frame
                    .motors
                    .get(motor_idx)
                    .map(|m| m.position_mm)
                    .unwrap_or(0.0)
            })
            .collect();
        channels.push(ChartChannel {
            name: format!("Motor {} pos", motor_idx + 1),
            unit: "mm".to_string(),
            channel_type: "motor".to_string(),
            channel_index: motor_idx as u32,
            points,
        });
    }

    // Motor velocity channels
    for motor_idx in 0..motor_count {
        let points: Vec<f64> = frames
            .iter()
            .map(|frame| {
                frame
                    .motors
                    .get(motor_idx)
                    .map(|m| m.velocity_mm_per_sec)
                    .unwrap_or(0.0)
            })
            .collect();
        channels.push(ChartChannel {
            name: format!("Motor {} vel", motor_idx + 1),
            unit: "mm/s".to_string(),
            channel_type: "motor".to_string(),
            channel_index: motor_idx as u32,
            points,
        });
    }

    // Motor acceleration channels
    for motor_idx in 0..motor_count {
        let points: Vec<f64> = frames
            .iter()
            .map(|frame| {
                frame
                    .motors
                    .get(motor_idx)
                    .map(|m| m.acceleration_mm_per_sec2)
                    .unwrap_or(0.0)
            })
            .collect();
        channels.push(ChartChannel {
            name: format!("Motor {} acc", motor_idx + 1),
            unit: "mm/s²".to_string(),
            channel_type: "motor".to_string(),
            channel_index: motor_idx as u32,
            points,
        });
    }

    // Bend angle channels
    let bend_points1: Vec<f64> = frames
        .iter()
        .map(|frame| frame.bend.section1.angle_deg)
        .collect();
    channels.push(ChartChannel {
        name: "Bend S1".to_string(),
        unit: "deg".to_string(),
        channel_type: "bend".to_string(),
        channel_index: 1,
        points: bend_points1,
    });
    let bend_points2: Vec<f64> = frames
        .iter()
        .map(|frame| frame.bend.section2.angle_deg)
        .collect();
    channels.push(ChartChannel {
        name: "Bend S2".to_string(),
        unit: "deg".to_string(),
        channel_type: "bend".to_string(),
        channel_index: 2,
        points: bend_points2,
    });

    // Sensor channels
    for sensor_idx in 0..sensor_count {
        for ch in 0..3 {
            let axis = ["X", "Y", "Z"][ch];
            let points: Vec<f64> = frames
                .iter()
                .map(|frame| {
                    frame
                        .sensors
                        .get(sensor_idx)
                        .map(|s| s.filtered[ch])
                        .unwrap_or(0.0)
                })
                .collect();
            channels.push(ChartChannel {
                name: format!("Sensor {} {}", sensor_idx + 1, axis),
                unit: "N".to_string(),
                channel_type: "sensor".to_string(),
                channel_index: sensor_idx as u32,
                points,
            });
        }
    }

    ChartSection {
        window_size: channels.first().map(|c| c.points.len()).unwrap_or(0),
        channels,
    }
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
    let secondary = make_frame(seq.saturating_add(1), data.connected);
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
            frames: vec![frame, secondary],
        },
        charts: make_charts(seq),
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

struct AppState {
    store: RuntimeStore,
    profile_store: profiles::ProfileStore,
    devices: Arc<Mutex<device::DeviceRegistry>>,
    live_ring: Arc<Mutex<live::LiveDataRing>>,
    recorder: Arc<Mutex<session::SessionRecorder>>,
    playback: Arc<Mutex<playback::PlaybackEngine>>,
    control_runtime: Arc<Mutex<control::ControlRuntime>>,
    auth_session: Arc<Mutex<auth::AuthSession>>,
    auth_store: auth::AuthStore,
    sqlite: storage::SqliteStore,
    worker_stop: Arc<AtomicBool>,
}

impl AppState {
    fn new(path: PathBuf) -> Self {
        let devices = Arc::new(Mutex::new(device::DeviceRegistry::new()));
        {
            let mut guard = devices.lock().expect("device registry poisoned");
            let _ = guard.seed_simulator();
        }
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
        Self {
            store: RuntimeStore::load(path),
            profile_store: profiles::ProfileStore::load(profile_path),
            devices,
            live_ring: Arc::new(Mutex::new(live::LiveDataRing::new(6_000))),
            recorder: Arc::new(Mutex::new(session::SessionRecorder::new(session_dir))),
            playback: Arc::new(Mutex::new(playback::PlaybackEngine::new())),
            control_runtime: Arc::new(Mutex::new(control::ControlRuntime::default())),
            auth_session: Arc::new(Mutex::new(auth::AuthSession::default())),
            auth_store: auth::AuthStore::load(auth_path),
            sqlite: storage::SqliteStore::new(sqlite_path),
            worker_stop: Arc::new(AtomicBool::new(false)),
        }
    }

    fn snapshot(&self) -> RuntimeSnapshot {
        let mut snapshot = self.store.snapshot();
        self.sync_logs_to_sqlite();
        if let Ok(control) = self.control_runtime.lock() {
            snapshot.control_runtime = control.status();
        }
        if let Ok(auth) = self.auth_session.lock() {
            snapshot.auth_session = auth.clone();
        }

        // If playback is active, inject its frame and skip live ring
        if let Ok(pb) = self.playback.lock() {
            if pb.status().active {
                if let Some(frame) = pb.current_frame() {
                    snapshot.playback_mode = true;
                    if let Ok(mut control) = self.control_runtime.lock() {
                        control.stop("playback mode blocks active control");
                        snapshot.control_runtime = control.status();
                    }
                    snapshot.live.selected_device_id = frame.device_id.clone();
                    snapshot.live.frames = vec![frame.clone()];
                    snapshot.dashboard.device_count = 1;
                    snapshot.dashboard.connected_devices = 1;
                    snapshot.dashboard.last_error = None;
                    snapshot.connection.state = ConnectionState::Ready;

                    // Build chart data from playback frame window
                    let window = pb.frame_window(120);
                    if !window.is_empty() {
                        let owned: Vec<DeviceSnapshot> = window.into_iter().cloned().collect();
                        snapshot.charts = make_charts_from_motors(&owned);
                    }

                    return snapshot;
                }
            }
        }

        let mut live_stats = empty_live_stats();
        if let Ok(ring) = self.live_ring.lock() {
            live_stats = ring.stats();
            let live_frames = ring.latest_per_device();
            overlay_live_frames(&mut snapshot, &live_frames);

            let chart_frames = ring.window(120);
            if !chart_frames.is_empty() {
                snapshot.charts = make_charts_from_motors(&chart_frames);
            }
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

        let _snapshot = self.store.mutate(|data| {
            data.sequence = data.sequence.saturating_add(1);
            data.playback_cursor_ms = data.playback_cursor_ms.saturating_add(1_000);
            if data.connected && data.sequence % 16 == 0 {
                data.logs.push(log_entry(
                    data.sequence,
                    LogLevel::Debug,
                    "stream",
                    "Live snapshot refreshed",
                    Some("softui-sim-01"),
                    Some("BB 02 10 01 00 00 00 00 00 23"),
                ));
            }
            if data.logs.len() > 120 {
                let drain = data.logs.len() - 120;
                data.logs.drain(0..drain);
            }
        });

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

    fn export_diagnostics_bundle(&self) -> Result<String, String> {
        let snapshot = self.snapshot();
        let base_dir = self
            .store
            .path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("diagnostics");
        let bundle_dir = base_dir.join(format!(
            "softui-diagnostics-{}",
            snapshot.dashboard.current_session.replace('-', "")
        ));
        fs::create_dir_all(&bundle_dir).map_err(|err| err.to_string())?;

        let files = [
            (
                "app-info.json",
                serde_json::to_string_pretty(&snapshot.app_info).map_err(|err| err.to_string())?,
            ),
            (
                "snapshot.json",
                serde_json::to_string_pretty(&snapshot).map_err(|err| err.to_string())?,
            ),
            (
                "logs.json",
                serde_json::to_string_pretty(&snapshot.logs).map_err(|err| err.to_string())?,
            ),
            (
                "settings.json",
                serde_json::to_string_pretty(&snapshot.settings).map_err(|err| err.to_string())?,
            ),
            (
                "runtime-diagnostics.json",
                serde_json::to_string_pretty(&snapshot.runtime_diagnostics)
                    .map_err(|err| err.to_string())?,
            ),
        ];

        for (name, content) in files {
            fs::write(bundle_dir.join(name), content).map_err(|err| err.to_string())?;
        }

        Ok(bundle_dir.to_string_lossy().to_string())
    }

    fn sync_logs_to_sqlite(&self) {
        let logs = self
            .store
            .data
            .lock()
            .map(|data| data.logs.clone())
            .unwrap_or_default();
        for entry in logs {
            let _ = self.sqlite.insert_log(&storage::LogRow {
                id: entry.id,
                timestamp_ms: entry.timestamp_ms,
                level: log_level_key(&entry.level).to_string(),
                scope: entry.scope,
                message: entry.message,
                device_id: entry.device_id,
                frame_hex: entry.frame_hex,
            });
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
            connected
                && status
                    .last_status
                    .as_ref()
                    .map(|latest| latest.system_state != 0)
                    .unwrap_or(false)
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
                    .frames
                    .iter()
                    .find(|frame| frame.device_id == snapshot.live.selected_device_id)
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
        let auth_session = state
            .auth_session
            .lock()
            .map_err(|_| "auth session poisoned".to_string())?;
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
        CommandSafety::Connected => "device is not connected or ready",
        CommandSafety::Enabled => {
            "device control is not enabled; enable control and wait for device feedback before sending motion commands"
        }
    };
    Err(message.to_string())
}

fn selected_device_id(device_id: Option<String>) -> String {
    device_id.unwrap_or_else(|| "softui-sim-01".to_string())
}

fn guard_permission(
    state: &State<'_, AppState>,
    permission: auth::Permission,
) -> Result<(), String> {
    let auth_session = state
        .auth_session
        .lock()
        .map_err(|_| "auth session poisoned".to_string())?;
    auth::require_permission(&auth_session, permission)
}

fn current_username(state: &State<'_, AppState>) -> Option<String> {
    state
        .auth_session
        .lock()
        .ok()
        .filter(|session| session.authenticated)
        .map(|session| session.username.clone())
}

fn record_control_command<T: Serialize>(
    state: &State<'_, AppState>,
    device_id: &str,
    command: &str,
    frame_hex: &str,
    payload: &T,
) {
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
    Ok(state.store.mutate(|data| {
        data.sequence = data.sequence.saturating_add(1);
        data.logs.push(log_entry(
            data.sequence,
            LogLevel::Info,
            "control",
            message,
            Some(&device_id),
            Some(&frame_hex),
        ));
    }))
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        name: "SoftUI".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        backend: "Rust + Tauri 2".to_string(),
        frontend: "React + TypeScript + Three.js".to_string(),
        platform: format!("{} / {}", std::env::consts::OS, std::env::consts::ARCH),
    }
}

#[tauri::command]
fn current_auth_session(state: State<'_, AppState>) -> Result<auth::AuthSession, String> {
    state
        .auth_session
        .lock()
        .map_err(|_| "auth session poisoned".to_string())
        .map(|session| session.clone())
}

#[tauri::command]
fn login(
    state: State<'_, AppState>,
    request: auth::LoginRequest,
) -> Result<auth::AuthSession, String> {
    let session = state.auth_store.login(request)?;
    {
        let mut auth_session = state
            .auth_session
            .lock()
            .map_err(|_| "auth session poisoned".to_string())?;
        *auth_session = session.clone();
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
    Ok(session)
}

#[tauri::command]
fn logout(state: State<'_, AppState>) -> Result<auth::AuthSession, String> {
    let previous = {
        let mut auth_session = state
            .auth_session
            .lock()
            .map_err(|_| "auth session poisoned".to_string())?;
        let previous = auth_session.username.clone();
        *auth_session = auth::AuthSession::signed_out();
        previous
    };
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
    current_auth_session(state)
}

#[tauri::command]
fn list_users(state: State<'_, AppState>) -> Result<Vec<auth::UserAccount>, String> {
    guard_permission(&state, auth::Permission::ManageUsers)?;
    Ok(state.auth_store.list_users())
}

#[tauri::command]
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

#[tauri::command]
fn change_password(
    state: State<'_, AppState>,
    request: auth::ChangePasswordRequest,
) -> Result<(), String> {
    let auth_session = state
        .auth_session
        .lock()
        .map_err(|_| "auth session poisoned".to_string())?
        .clone();
    let target_username = request
        .username
        .clone()
        .unwrap_or_else(|| auth_session.username.clone());
    state.auth_store.change_password(&auth_session, request)?;
    if target_username == auth_session.username {
        let mut current_session = state
            .auth_session
            .lock()
            .map_err(|_| "auth session poisoned".to_string())?;
        current_session.must_change_password = false;
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

#[tauri::command]
fn set_user_disabled(
    state: State<'_, AppState>,
    username: String,
    disabled: bool,
) -> Result<auth::UserAccount, String> {
    guard_permission(&state, auth::Permission::ManageUsers)?;
    let account = state.auth_store.set_disabled(username, disabled)?;
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

#[tauri::command]
fn bootstrap_state(state: State<'_, AppState>) -> RuntimeSnapshot {
    state.snapshot()
}

#[tauri::command]
fn tick_snapshot(state: State<'_, AppState>) -> RuntimeSnapshot {
    state.tick()
}

#[tauri::command]
fn toggle_connection(state: State<'_, AppState>) -> RuntimeSnapshot {
    state.toggle_connection()
}

#[tauri::command]
fn set_theme(state: State<'_, AppState>, theme: ThemeMode) -> RuntimeSnapshot {
    state.set_theme(theme)
}

#[tauri::command]
fn update_settings(
    state: State<'_, AppState>,
    settings: SettingsState,
) -> Result<RuntimeSnapshot, String> {
    guard_permission(&state, auth::Permission::ManageSettings)?;
    Ok(state.update_settings(settings))
}

#[tauri::command]
fn export_diagnostics_bundle(state: State<'_, AppState>) -> Result<String, String> {
    guard_permission(&state, auth::Permission::ViewDiagnostics)?;
    state.export_diagnostics_bundle()
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
fn list_serial_ports() -> Result<Vec<transport::SerialPortDescriptor>, String> {
    transport::list_serial_ports().map_err(|error| format!("{error:?}"))
}

#[tauri::command]
fn list_connected_devices(
    state: State<'_, AppState>,
) -> Result<Vec<device::DeviceConnectionRecord>, String> {
    let devices = state
        .devices
        .lock()
        .map_err(|_| "device registry poisoned".to_string())?;
    Ok(devices.list())
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
fn fetch_live_window(state: State<'_, AppState>, count: u32) -> Vec<DeviceSnapshot> {
    state
        .live_ring
        .lock()
        .map(|ring| ring.window(count as usize))
        .unwrap_or_default()
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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
    Ok(state.store.mutate(|data| {
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
    }))
}

#[tauri::command]
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
    Ok(state.store.mutate(|data| {
        data.sequence = data.sequence.saturating_add(1);
        data.logs.push(log_entry(
            data.sequence,
            LogLevel::Info,
            "control",
            "motor command sent",
            Some(&device_id),
            Some(&frame_hex),
        ));
    }))
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
fn control_runtime_status(state: State<'_, AppState>) -> Result<control::ControlStatus, String> {
    state
        .control_runtime
        .lock()
        .map_err(|_| "control runtime poisoned".to_string())
        .map(|control| control.status())
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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
    let operator = state
        .auth_session
        .lock()
        .map(|session| session.username.clone())
        .unwrap_or_default();
    info.operator = Some(operator.clone());
    state
        .sqlite
        .upsert_session(&session_info_row(&info, Some(operator)))?;
    Ok(info)
}

#[tauri::command]
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

#[tauri::command]
fn pause_recording(state: State<'_, AppState>) -> Result<(), String> {
    guard_permission(&state, auth::Permission::ManageSessions)?;
    state
        .recorder
        .lock()
        .map_err(|_| "recorder poisoned".to_string())?
        .pause()
}

#[tauri::command]
fn resume_recording(state: State<'_, AppState>) -> Result<(), String> {
    guard_permission(&state, auth::Permission::ManageSessions)?;
    state
        .recorder
        .lock()
        .map_err(|_| "recorder poisoned".to_string())?
        .resume()
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
fn playback_load(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<playback::PlaybackStatus, String> {
    guard_permission(&state, auth::Permission::ManageSessions)?;
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

#[tauri::command]
fn playback_play(state: State<'_, AppState>) -> Result<playback::PlaybackStatus, String> {
    guard_permission(&state, auth::Permission::ManageSessions)?;
    let mut pb = state
        .playback
        .lock()
        .map_err(|_| "playback poisoned".to_string())?;
    pb.play();
    Ok(pb.status())
}

#[tauri::command]
fn playback_pause(state: State<'_, AppState>) -> Result<playback::PlaybackStatus, String> {
    guard_permission(&state, auth::Permission::ManageSessions)?;
    let mut pb = state
        .playback
        .lock()
        .map_err(|_| "playback poisoned".to_string())?;
    pb.pause();
    Ok(pb.status())
}

#[tauri::command]
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

#[tauri::command]
fn playback_seek(state: State<'_, AppState>, ms: u64) -> Result<playback::PlaybackStatus, String> {
    guard_permission(&state, auth::Permission::ManageSessions)?;
    let mut pb = state
        .playback
        .lock()
        .map_err(|_| "playback poisoned".to_string())?;
    pb.seek_to_ms(ms);
    Ok(pb.status())
}

#[tauri::command]
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

#[tauri::command]
fn playback_status(state: State<'_, AppState>) -> playback::PlaybackStatus {
    state
        .playback
        .lock()
        .map(|p| p.status())
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

#[tauri::command]
fn playback_get_frame(state: State<'_, AppState>) -> Option<DeviceSnapshot> {
    state
        .playback
        .lock()
        .ok()
        .and_then(|p| p.current_frame().cloned())
}

#[tauri::command]
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

#[tauri::command]
fn delete_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    guard_permission(&state, auth::Permission::ManageSessions)?;
    state
        .recorder
        .lock()
        .map_err(|_| "recorder poisoned".to_string())?
        .delete_session(&id)?;
    state.sqlite.delete_session(&id)
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
fn export_session_csv(
    state: State<'_, AppState>,
    id: String,
    output_path: Option<String>,
) -> Result<String, String> {
    guard_permission(&state, auth::Permission::ManageSessions)?;
    let rec = state
        .recorder
        .lock()
        .map_err(|_| "recorder poisoned".to_string())?;
    let csv_path = rec
        .session_csv_path(&id)
        .ok_or_else(|| "会话 CSV 文件不存在".to_string())?;
    match output_path {
        Some(dest) => {
            std::fs::copy(&csv_path, &dest).map_err(|e| e.to_string())?;
            Ok(dest)
        }
        None => Ok(csv_path.to_string_lossy().to_string()),
    }
}

#[tauri::command]
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

#[tauri::command]
fn export_chart_csv(
    state: State<'_, AppState>,
    session_id: Option<String>,
    channel_names: Vec<String>,
    max_count: Option<u32>,
) -> Result<String, String> {
    guard_permission(&state, auth::Permission::ManageSessions)?;
    let max = max_count.unwrap_or(5_000).clamp(10, 20_000) as usize;
    let mut frames = if let Some(id) = session_id.clone() {
        let sqlite_frames = state
            .sqlite
            .read_snapshot_json(&id, max)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|raw| serde_json::from_str::<DeviceSnapshot>(&raw).ok())
            .collect::<Vec<_>>();
        if sqlite_frames.is_empty() {
            let rec = state
                .recorder
                .lock()
                .map_err(|_| "recorder poisoned".to_string())?;
            let csv_path = rec
                .session_csv_path(&id)
                .ok_or_else(|| "会话 CSV 文件不存在".to_string())?;
            drop(rec);
            session::read_session_csv(&csv_path)?
        } else {
            sqlite_frames
        }
    } else {
        state
            .live_ring
            .lock()
            .map(|ring| ring.window(max))
            .unwrap_or_default()
            .into_iter()
            .rev()
            .collect()
    };

    downsample_frames(&mut frames, max);
    let chart = make_charts_from_motors(&frames);
    let selected = if channel_names.is_empty() {
        chart
            .channels
            .iter()
            .map(|channel| channel.name.clone())
            .collect::<Vec<_>>()
    } else {
        channel_names
    };

    let mut csv = String::from("received_at_ms,sequence,device_id");
    for name in &selected {
        csv.push(',');
        csv.push_str(&csv_escape(name));
    }
    csv.push('\n');

    for (index, frame) in frames.iter().enumerate() {
        csv.push_str(&format!(
            "{},{},{}",
            frame.received_at_ms,
            frame.sequence,
            csv_escape(&frame.device_id)
        ));
        for name in &selected {
            let value = chart
                .channels
                .iter()
                .find(|channel| &channel.name == name)
                .and_then(|channel| channel.points.get(index))
                .copied()
                .unwrap_or(0.0);
            csv.push_str(&format!(",{value:.6}"));
        }
        csv.push('\n');
    }

    let base_dir = state
        .store
        .path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("chart-exports");
    fs::create_dir_all(&base_dir).map_err(|error| error.to_string())?;
    let filename = format!(
        "chart-{}-{}.csv",
        session_id.unwrap_or_else(|| "live".to_string()),
        now_ms()
    );
    let output = base_dir.join(filename);
    fs::write(&output, csv).map_err(|error| error.to_string())?;
    Ok(output.to_string_lossy().to_string())
}

fn downsample_frames(frames: &mut Vec<DeviceSnapshot>, max: usize) {
    if frames.len() <= max || max == 0 {
        return;
    }
    let step = (frames.len() as f64 / max as f64).ceil() as usize;
    *frames = frames.iter().step_by(step.max(1)).cloned().collect();
}

fn csv_escape(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

// ── Connection profile commands ──

#[tauri::command]
fn list_connection_profiles(state: State<'_, AppState>) -> Vec<profiles::ConnectionProfile> {
    state.profile_store.list()
}

#[tauri::command]
fn save_connection_profile(
    state: State<'_, AppState>,
    profile: profiles::ConnectionProfile,
) -> Result<profiles::ConnectionProfile, String> {
    guard_permission(&state, auth::Permission::ManageSettings)?;
    state.profile_store.save(profile)
}

#[tauri::command]
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
            protocol_status.sensors[0].x.trunc()
        );
        assert_eq!(
            snapshot.bend.section1.angle_deg,
            trunc2(protocol_status.bend_angle1_deg)
        );
        assert!(snapshot.quality.checksum_ok);
    }

    #[test]
    fn runtime_snapshot_contains_protocol_backed_live_frames() {
        let data = default_persisted_state();
        let snapshot = build_snapshot(&data);

        assert_eq!(snapshot.live.frames.len(), 2);
        assert_eq!(snapshot.live.frames[0].motors.len(), 6);
        assert_eq!(snapshot.live.frames[0].sensors.len(), 6);
        assert_eq!(snapshot.live.selected_device_id, "softui-sim-01");
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
        assert_eq!(snapshot.live.frames.len(), 1);
        assert_eq!(snapshot.live.frames[0].motors.len(), 1);
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

            let bg_devices = app_state.devices.clone();
            let bg_live_ring = app_state.live_ring.clone();
            let bg_recorder = app_state.recorder.clone();
            let bg_playback = app_state.playback.clone();
            let bg_control = app_state.control_runtime.clone();
            let bg_sqlite = app_state.sqlite.clone();
            let bg_worker_stop = app_state.worker_stop.clone();

            app.manage(app_state);

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
                                    let feedback = control::ControlFeedback {
                                        angle_deg: frame.bend.section1.angle_deg,
                                        target_angle_deg: frame.bend.section1.target_angle_deg,
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
                                        rec.write_frame(&frame);
                                        if rec_status.active && !rec_status.paused {
                                            let _ = bg_sqlite.insert_snapshot(
                                                &rec_status.session_id,
                                                frame.sequence,
                                                frame.received_at_ms,
                                                &frame.device_id,
                                                &frame,
                                            );
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
            export_diagnostics_bundle,
            export_chart_csv,
            export_session_csv,
            fetch_live_window,
            fetch_live_stats,
            list_connected_devices,
            list_connection_profiles,
            list_serial_ports,
            list_sessions,
            list_users,
            login,
            logout,
            calibrate_sensor,
            configure_cycle_life,
            control_runtime_status,
            playback_get_frame,
            playback_get_window,
            playback_load,
            playback_pause,
            playback_play,
            playback_seek,
            playback_set_speed,
            playback_status,
            playback_stop,
            pause_recording,
            read_session_frames,
            recorder_status,
            rename_session,
            resume_recording,
            send_active_control_tick,
            send_bend_command,
            send_home_command,
            send_motor_command,
            save_connection_profile,
            preview_legacy_migration,
            run_legacy_migration,
            set_user_disabled,
            start_recording,
            stop_recording,
            start_cycle_life,
            stop_cycle_life,
            submit_system_control,
            tick_snapshot,
            toggle_connection,
            update_pid_control,
            update_session_metadata,
            update_settings,
            set_theme
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
