use crate::{
    protocol::{DeviceStatus, LegacyV1Codec, ProtocolError},
    transport::{SerialConnectionConfig, SerialTransport, Transport, TransportError},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeviceConnectionState {
    Idle,
    Connecting,
    Handshaking,
    Ready,
    Enabled,
    EmergencyStopped,
    Reconnecting,
    Error,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceConnectionRecord {
    pub device_id: String,
    pub connection_id: String,
    pub port_name: String,
    pub baud_rate: u32,
    pub state: DeviceConnectionState,
    pub connected_at_ms: u64,
}

pub struct DeviceRegistry {
    serial_devices: HashMap<String, DeviceRuntime<Box<dyn Transport>>>,
    records: HashMap<String, DeviceConnectionRecord>,
    configs: HashMap<String, SerialConnectionConfig>,
    next_connection: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DevicePollResult {
    pub record: DeviceConnectionRecord,
    pub status: Option<DeviceStatus>,
    pub runtime: RuntimeStatus,
    pub error: Option<String>,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandPriority {
    Normal,
    Emergency,
}

impl DeviceRegistry {
    pub fn new() -> Self {
        Self {
            serial_devices: HashMap::new(),
            records: HashMap::new(),
            configs: HashMap::new(),
            next_connection: 1,
        }
    }

    pub fn list(&self) -> Vec<DeviceConnectionRecord> {
        let mut records = self.records.values().cloned().collect::<Vec<_>>();
        records.sort_by(|left, right| left.device_id.cmp(&right.device_id));
        records
    }

    pub fn connect_serial(
        &mut self,
        config: SerialConnectionConfig,
    ) -> Result<DeviceConnectionRecord, DeviceRuntimeError> {
        if self.serial_devices.contains_key(&config.port_name) {
            return Err(DeviceRuntimeError::DuplicatePort(config.port_name));
        }

        let port_name = config.port_name.clone();
        let baud_rate = config.baud_rate;
        let transport = SerialTransport::open(config.clone())?;
        let mut runtime = DeviceRuntime::new(Box::new(transport) as Box<dyn Transport>);
        match runtime.handshake() {
            Ok(_) | Err(DeviceRuntimeError::NoStatusFrame) => {}
            Err(error) => return Err(error),
        }
        let runtime_status = runtime.status();
        let record = DeviceConnectionRecord {
            device_id: format!("serial:{port_name}"),
            connection_id: format!("conn-{}", self.next_connection),
            port_name: port_name.clone(),
            baud_rate,
            state: runtime_status.state,
            connected_at_ms: now_ms(),
        };
        self.next_connection = self.next_connection.saturating_add(1);
        self.configs.insert(port_name.clone(), config);
        self.serial_devices.insert(port_name, runtime);
        self.records
            .insert(record.device_id.clone(), record.clone());
        Ok(record)
    }

    pub fn disconnect(
        &mut self,
        device_id: &str,
    ) -> Result<DeviceConnectionRecord, DeviceRuntimeError> {
        let mut record = self
            .records
            .remove(device_id)
            .ok_or_else(|| DeviceRuntimeError::DeviceNotFound(device_id.to_string()))?;
        if let Some(mut runtime) = self.serial_devices.remove(&record.port_name) {
            runtime.close()?;
        }
        self.configs.remove(&record.port_name);
        record.state = DeviceConnectionState::Closed;
        Ok(record)
    }

    pub fn disconnect_all(&mut self) {
        for runtime in self.serial_devices.values_mut() {
            let _ = runtime.close();
        }
        for record in self.records.values_mut() {
            record.state = DeviceConnectionState::Closed;
        }
        self.serial_devices.clear();
        self.configs.clear();
    }

    pub fn send_command(
        &mut self,
        device_id: &str,
        frame: &[u8],
        priority: CommandPriority,
    ) -> Result<RuntimeStatus, DeviceRuntimeError> {
        let record = self
            .records
            .get(device_id)
            .ok_or_else(|| DeviceRuntimeError::DeviceNotFound(device_id.to_string()))?
            .clone();
        let runtime = self
            .serial_devices
            .get_mut(&record.port_name)
            .ok_or_else(|| DeviceRuntimeError::DeviceNotFound(device_id.to_string()))?;
        runtime.enqueue_command(frame.to_vec(), priority);
        if priority == CommandPriority::Emergency {
            runtime.flush_command_queue()?;
        }
        Ok(runtime.status())
    }

    pub fn runtime_status(&self, device_id: &str) -> Result<RuntimeStatus, DeviceRuntimeError> {
        let record = self
            .records
            .get(device_id)
            .ok_or_else(|| DeviceRuntimeError::DeviceNotFound(device_id.to_string()))?;
        let runtime = self
            .serial_devices
            .get(&record.port_name)
            .ok_or_else(|| DeviceRuntimeError::DeviceNotFound(device_id.to_string()))?;
        Ok(runtime.status())
    }

    pub fn runtime_statuses(&self) -> Vec<(String, RuntimeStatus)> {
        self.records
            .values()
            .filter_map(|record| {
                self.serial_devices
                    .get(&record.port_name)
                    .map(|runtime| (record.device_id.clone(), runtime.status()))
            })
            .collect()
    }

    pub fn mark_control_enabled(
        &mut self,
        device_id: &str,
        enabled: bool,
    ) -> Result<RuntimeStatus, DeviceRuntimeError> {
        let record = self
            .records
            .get(device_id)
            .ok_or_else(|| DeviceRuntimeError::DeviceNotFound(device_id.to_string()))?
            .clone();
        let runtime = self
            .serial_devices
            .get_mut(&record.port_name)
            .ok_or_else(|| DeviceRuntimeError::DeviceNotFound(device_id.to_string()))?;
        runtime.mark_control_enabled(enabled);
        let status = runtime.status();
        if let Some(record) = self.records.get_mut(device_id) {
            record.state = status.state.clone();
        }
        Ok(status)
    }

    pub fn mark_emergency_stopped(
        &mut self,
        device_id: &str,
    ) -> Result<RuntimeStatus, DeviceRuntimeError> {
        let record = self
            .records
            .get(device_id)
            .ok_or_else(|| DeviceRuntimeError::DeviceNotFound(device_id.to_string()))?
            .clone();
        let runtime = self
            .serial_devices
            .get_mut(&record.port_name)
            .ok_or_else(|| DeviceRuntimeError::DeviceNotFound(device_id.to_string()))?;
        runtime.mark_emergency_stopped();
        let status = runtime.status();
        if let Some(record) = self.records.get_mut(device_id) {
            record.state = status.state.clone();
        }
        Ok(status)
    }

    pub fn poll_all(&mut self) -> Vec<DevicePollResult> {
        let mut results = Vec::new();
        let device_ids = self.records.keys().cloned().collect::<Vec<_>>();

        for device_id in device_ids {
            let Some(record) = self.records.get(&device_id).cloned() else {
                continue;
            };
            let reconnect_config = self.configs.get(&record.port_name).cloned();
            let Some(runtime) = self.serial_devices.get_mut(&record.port_name) else {
                continue;
            };

            let (status, error, error_code) = if runtime.state
                == DeviceConnectionState::Reconnecting
                || runtime.state == DeviceConnectionState::Error
            {
                let recovered = runtime.poll_for_reconnect();
                if recovered {
                    (runtime.latest_status(), None, None)
                } else {
                    if runtime.reconnect_wait_elapsed(1_000) {
                        runtime.mark_reconnecting();
                        if let Some(config) = reconnect_config.clone() {
                            match SerialTransport::open(config) {
                                Ok(transport) => {
                                    runtime.replace_transport(Box::new(transport));
                                    match runtime.handshake() {
                                        Ok(status) => (Some(status), None, None),
                                        Err(error) => {
                                            let code = error.code().to_string();
                                            runtime.remember_error_with_code(
                                                format!("{error:?}"),
                                                code.clone(),
                                            );
                                            (None, Some(format!("{error:?}")), Some(code))
                                        }
                                    }
                                }
                                Err(error) => {
                                    let code = error.code().to_string();
                                    runtime.remember_error_with_code(
                                        format!("{error:?}"),
                                        code.clone(),
                                    );
                                    (None, Some(format!("{error:?}")), Some(code))
                                }
                            }
                        } else {
                            (None, None, None)
                        }
                    } else {
                        (None, None, None)
                    }
                }
            } else {
                let queue_error = runtime.flush_command_queue().err();
                if let Some(error) = queue_error {
                    let code = error.code().to_string();
                    runtime.remember_error_with_code(format!("{error:?}"), code.clone());
                    runtime.mark_reconnecting();
                    (None, Some(format!("{error:?}")), Some(code))
                } else {
                    match runtime.poll_status() {
                        Ok(status) => (Some(status), None, None),
                        Err(DeviceRuntimeError::NoStatusFrame) => (None, None, None),
                        Err(error) => {
                            let code = error.code().to_string();
                            let was_online = matches!(
                                runtime.state,
                                DeviceConnectionState::Ready | DeviceConnectionState::Enabled
                            );
                            if was_online {
                                runtime.mark_reconnecting();
                            } else {
                                runtime.state = DeviceConnectionState::Error;
                            }
                            runtime.remember_error_with_code(format!("{error:?}"), code.clone());
                            (None, Some(format!("{error:?}")), Some(code))
                        }
                    }
                }
            };
            let runtime_status = runtime.status();
            if let Some(record) = self.records.get_mut(&device_id) {
                record.state = runtime_status.state.clone();
            }
            let updated_record = self.records.get(&device_id).cloned().unwrap_or(record);

            results.push(DevicePollResult {
                record: updated_record,
                status,
                runtime: runtime_status,
                error,
                error_code,
            });
        }

        results
    }

    /// Insert a simulator device under port "simulator".
    /// Used by AppState::new() to provide data even without real hardware.
    pub fn seed_simulator(&mut self) -> Result<DeviceConnectionRecord, DeviceRuntimeError> {
        if self.serial_devices.contains_key("simulator") {
            return Err(DeviceRuntimeError::DuplicatePort("simulator".to_string()));
        }
        let transport = crate::transport::SimulatorTransport::new()
            .map_err(|e| DeviceRuntimeError::Transport(e))?;
        let mut runtime = DeviceRuntime::new(Box::new(transport) as Box<dyn Transport>);
        let _ = runtime.handshake();
        let record = DeviceConnectionRecord {
            device_id: "simulator:0".to_string(),
            connection_id: format!("conn-{}", self.next_connection),
            port_name: "simulator".to_string(),
            baud_rate: 9_600,
            state: runtime.status().state,
            connected_at_ms: now_ms(),
        };
        self.next_connection = self.next_connection.saturating_add(1);
        self.serial_devices.insert("simulator".to_string(), runtime);
        self.records
            .insert(record.device_id.clone(), record.clone());
        Ok(record)
    }

    #[cfg(test)]
    fn reserve_for_test(&mut self, record: DeviceConnectionRecord) {
        self.records.insert(record.device_id.clone(), record);
    }
}

impl Default for DeviceRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceRuntimeError {
    DeviceNotFound(String),
    DuplicatePort(String),
    Transport(TransportError),
    Protocol(ProtocolError),
    NoStatusFrame,
}

impl DeviceRuntimeError {
    pub fn code(&self) -> &'static str {
        match self {
            DeviceRuntimeError::DeviceNotFound(_) => "DEVICE_NOT_FOUND",
            DeviceRuntimeError::DuplicatePort(_) => "SERIAL_DUPLICATE_PORT",
            DeviceRuntimeError::Transport(error) => error.code(),
            DeviceRuntimeError::Protocol(_) => "PROTOCOL_FRAME",
            DeviceRuntimeError::NoStatusFrame => "SERIAL_NO_STATUS_FRAME",
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

impl From<TransportError> for DeviceRuntimeError {
    fn from(value: TransportError) -> Self {
        Self::Transport(value)
    }
}

impl From<ProtocolError> for DeviceRuntimeError {
    fn from(value: ProtocolError) -> Self {
        Self::Protocol(value)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeStatus {
    pub state: DeviceConnectionState,
    pub last_status: Option<DeviceStatus>,
    pub received_frames: u64,
    pub protocol_errors: u64,
    pub sent_commands: u64,
    pub pending_commands: usize,
    pub reconnect_attempts: u32,
    pub last_frame_ms: u64,
    pub last_command_ms: u64,
    pub command_high_watermark: usize,
    pub emergency_latched: bool,
    pub last_error: Option<String>,
    pub last_error_code: Option<String>,
}

pub struct DeviceRuntime<T: Transport> {
    transport: T,
    codec: LegacyV1Codec,
    state: DeviceConnectionState,
    last_status: Option<DeviceStatus>,
    received_frames: u64,
    protocol_errors: u64,
    sent_commands: u64,
    pending_commands: VecDeque<Vec<u8>>,
    reconnect_attempts: u32,
    last_reconnect_ms: u64,
    last_frame_ms: u64,
    last_command_ms: u64,
    command_high_watermark: usize,
    emergency_latched: bool,
    last_error: Option<String>,
    last_error_code: Option<String>,
}

impl<T: Transport> DeviceRuntime<T> {
    pub fn new(transport: T) -> Self {
        Self {
            transport,
            codec: LegacyV1Codec::new(),
            state: DeviceConnectionState::Idle,
            last_status: None,
            received_frames: 0,
            protocol_errors: 0,
            sent_commands: 0,
            pending_commands: VecDeque::new(),
            reconnect_attempts: 0,
            last_reconnect_ms: 0,
            last_frame_ms: 0,
            last_command_ms: 0,
            command_high_watermark: 0,
            emergency_latched: false,
            last_error: None,
            last_error_code: None,
        }
    }

    pub fn status(&self) -> RuntimeStatus {
        RuntimeStatus {
            state: self.state.clone(),
            last_status: self.last_status.clone(),
            received_frames: self.received_frames,
            protocol_errors: self.protocol_errors,
            sent_commands: self.sent_commands,
            pending_commands: self.pending_commands.len(),
            reconnect_attempts: self.reconnect_attempts,
            last_frame_ms: self.last_frame_ms,
            last_command_ms: self.last_command_ms,
            command_high_watermark: self.command_high_watermark,
            emergency_latched: self.emergency_latched,
            last_error: self.last_error.clone(),
            last_error_code: self.last_error_code.clone(),
        }
    }

    pub fn handshake(&mut self) -> Result<DeviceStatus, DeviceRuntimeError> {
        self.state = DeviceConnectionState::Handshaking;
        for _ in 0..5 {
            match self.poll_status() {
                Ok(status) => {
                    self.state = DeviceConnectionState::Ready;
                    return Ok(status);
                }
                Err(DeviceRuntimeError::NoStatusFrame) => continue,
                Err(error) => return Err(error),
            }
        }
        Err(DeviceRuntimeError::NoStatusFrame)
    }

    pub fn poll_status(&mut self) -> Result<DeviceStatus, DeviceRuntimeError> {
        let bytes = match self.transport.read() {
            Ok(bytes) => bytes,
            Err(error) => {
                self.last_error = Some(format!("{error:?}"));
                self.last_error_code = Some(error.code().to_string());
                return Err(DeviceRuntimeError::Transport(error));
            }
        };
        let decoded = self.codec.push_bytes(&bytes);

        for frame in decoded {
            match frame {
                Ok(status) => {
                    self.received_frames = self.received_frames.saturating_add(1);
                    self.last_status = Some(status.clone());
                    self.last_frame_ms = now_ms();
                    self.last_error = None;
                    self.last_error_code = None;
                    if self.state != DeviceConnectionState::Handshaking {
                        self.state = if self.emergency_latched {
                            DeviceConnectionState::EmergencyStopped
                        } else if status.system_state != 0 {
                            DeviceConnectionState::Enabled
                        } else {
                            DeviceConnectionState::Ready
                        };
                    }
                    return Ok(status);
                }
                Err(error) => {
                    self.protocol_errors = self.protocol_errors.saturating_add(1);
                    self.state = DeviceConnectionState::Error;
                    self.last_error = Some(format!("{error:?}"));
                    self.last_error_code = Some("PROTOCOL_FRAME".to_string());
                    return Err(DeviceRuntimeError::Protocol(error));
                }
            }
        }

        Err(DeviceRuntimeError::NoStatusFrame)
    }

    pub fn send_command(&mut self, frame: &[u8]) -> Result<(), DeviceRuntimeError> {
        if let Err(error) = self.transport.write(frame) {
            self.last_error = Some(format!("{error:?}"));
            self.last_error_code = Some(error.code().to_string());
            return Err(DeviceRuntimeError::Transport(error));
        }
        self.sent_commands = self.sent_commands.saturating_add(1);
        self.last_command_ms = now_ms();
        Ok(())
    }

    pub fn enqueue_command(&mut self, frame: Vec<u8>, priority: CommandPriority) {
        match priority {
            CommandPriority::Normal => self.pending_commands.push_back(frame),
            CommandPriority::Emergency => {
                self.pending_commands.clear();
                self.pending_commands.push_front(frame);
                self.emergency_latched = true;
                self.state = DeviceConnectionState::EmergencyStopped;
            }
        }
        self.command_high_watermark = self.command_high_watermark.max(self.pending_commands.len());
    }

    pub fn flush_command_queue(&mut self) -> Result<(), DeviceRuntimeError> {
        while let Some(frame) = self.pending_commands.pop_front() {
            if let Err(error) = self.send_command(&frame) {
                self.pending_commands.push_front(frame);
                self.last_error = Some(format!("{error:?}"));
                return Err(error);
            }
        }
        Ok(())
    }

    pub fn close(&mut self) -> Result<(), DeviceRuntimeError> {
        self.transport.close()?;
        self.state = DeviceConnectionState::Closed;
        self.pending_commands.clear();
        Ok(())
    }

    pub fn into_transport(self) -> T {
        self.transport
    }

    pub fn latest_status(&self) -> Option<DeviceStatus> {
        self.last_status.clone()
    }

    pub fn can_send_commands(&self) -> bool {
        !self.emergency_latched
            && (self.state == DeviceConnectionState::Ready
                || self.state == DeviceConnectionState::Enabled)
    }

    pub fn mark_reconnecting(&mut self) {
        self.state = DeviceConnectionState::Reconnecting;
        self.reconnect_attempts = self.reconnect_attempts.saturating_add(1);
        self.last_reconnect_ms = now_ms();
    }

    pub fn mark_control_enabled(&mut self, enabled: bool) {
        if enabled {
            self.emergency_latched = false;
            self.state = DeviceConnectionState::Enabled;
        } else {
            self.state = DeviceConnectionState::Ready;
            self.pending_commands.clear();
        }
    }

    pub fn mark_emergency_stopped(&mut self) {
        self.emergency_latched = true;
        self.state = DeviceConnectionState::EmergencyStopped;
        self.pending_commands.clear();
    }

    pub fn remember_error(&mut self, error: String) {
        self.last_error = Some(error);
    }

    pub fn remember_error_with_code(&mut self, error: String, code: String) {
        self.last_error = Some(error);
        self.last_error_code = Some(code);
    }

    pub fn reconnect_wait_elapsed(&self, interval_ms: u64) -> bool {
        now_ms().saturating_sub(self.last_reconnect_ms) >= interval_ms
    }

    /// Attempt to poll status during a reconnection cycle.
    /// Returns true if a valid status frame was received (device is back).
    pub fn poll_for_reconnect(&mut self) -> bool {
        match self.poll_status() {
            Ok(_) => {
                self.state = DeviceConnectionState::Ready;
                self.reconnect_attempts = 0;
                true
            }
            Err(DeviceRuntimeError::NoStatusFrame) => false,
            Err(_) => false,
        }
    }
}

impl DeviceRuntime<Box<dyn Transport>> {
    pub fn replace_transport(&mut self, transport: Box<dyn Transport>) {
        self.transport = transport;
        self.codec = LegacyV1Codec::new();
        self.state = DeviceConnectionState::Handshaking;
        self.last_error = None;
        self.last_error_code = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        protocol::{encode_motor_command, encode_system_control_command, SystemControlAction},
        transport::{SimulatorTransport, Transport},
    };

    struct FragmentedTransport {
        chunks: Vec<Vec<u8>>,
        writes: Vec<Vec<u8>>,
    }

    impl Transport for FragmentedTransport {
        fn read(&mut self) -> Result<Vec<u8>, TransportError> {
            Ok(self.chunks.remove(0))
        }

        fn write(&mut self, bytes: &[u8]) -> Result<(), TransportError> {
            self.writes.push(bytes.to_vec());
            Ok(())
        }

        fn close(&mut self) -> Result<(), TransportError> {
            Ok(())
        }
    }

    #[test]
    fn runtime_handshake_moves_to_ready_with_status() {
        let transport = SimulatorTransport::new().expect("simulator");
        let mut runtime = DeviceRuntime::new(transport);

        let status = runtime.handshake().expect("handshake");
        let runtime_status = runtime.status();

        assert_eq!(runtime_status.state, DeviceConnectionState::Ready);
        assert_eq!(runtime_status.received_frames, 1);
        assert_eq!(runtime_status.pending_commands, 0);
        assert_eq!(status.num_motors, 6);
        assert!(runtime_status.last_status.is_some());
    }

    #[test]
    fn runtime_preserves_fragment_until_status_is_complete() {
        let mut transport = SimulatorTransport::new().expect("simulator");
        let frame = transport.read().expect("frame");
        let split_at = 7;
        let fragmented = FragmentedTransport {
            chunks: vec![frame[..split_at].to_vec(), frame[split_at..].to_vec()],
            writes: Vec::new(),
        };
        let mut runtime = DeviceRuntime::new(fragmented);

        assert_eq!(
            runtime.poll_status(),
            Err(DeviceRuntimeError::NoStatusFrame)
        );
        let status = runtime.poll_status().expect("status");

        assert_eq!(status.num_motors, 6);
        assert_eq!(runtime.status().received_frames, 1);
    }

    #[test]
    fn runtime_sends_commands_through_transport() {
        let transport = SimulatorTransport::new().expect("simulator");
        let mut runtime = DeviceRuntime::new(transport);
        let command = encode_motor_command(2, 10.0, 12.0, 4.0).expect("command");

        runtime.send_command(&command).expect("send");
        let status = runtime.status();
        let transport = runtime.into_transport();

        assert_eq!(status.sent_commands, 1);
        assert_eq!(transport.written_frames(), &[command]);
    }

    #[test]
    fn normal_command_waits_for_background_flush() {
        let transport = SimulatorTransport::new().expect("simulator");
        let mut runtime = DeviceRuntime::new(transport);
        let command = encode_motor_command(2, 10.0, 12.0, 4.0).expect("command");

        runtime.enqueue_command(command.clone(), CommandPriority::Normal);
        assert_eq!(runtime.status().pending_commands, 1);
        assert_eq!(runtime.status().sent_commands, 0);

        runtime.flush_command_queue().expect("flush");
        let status = runtime.status();
        let transport = runtime.into_transport();

        assert_eq!(status.pending_commands, 0);
        assert_eq!(status.sent_commands, 1);
        assert_eq!(status.command_high_watermark, 1);
        assert_eq!(transport.written_frames(), &[command]);
    }

    #[test]
    fn emergency_command_clears_normal_pending_commands() {
        let transport = SimulatorTransport::new().expect("simulator");
        let mut runtime = DeviceRuntime::new(transport);
        let normal = encode_motor_command(2, 10.0, 12.0, 4.0).expect("command");
        let emergency =
            encode_system_control_command(SystemControlAction::EmergencyStop).expect("emergency");

        runtime.enqueue_command(normal, CommandPriority::Normal);
        runtime.enqueue_command(emergency.clone(), CommandPriority::Emergency);
        assert_eq!(runtime.status().pending_commands, 1);
        assert!(runtime.status().emergency_latched);
        assert!(!runtime.can_send_commands());

        runtime.flush_command_queue().expect("flush");
        let transport = runtime.into_transport();

        assert_eq!(transport.written_frames(), &[emergency]);
    }

    #[test]
    fn runtime_close_updates_state() {
        let transport = SimulatorTransport::new().expect("simulator");
        let mut runtime = DeviceRuntime::new(transport);

        runtime.close().expect("close");

        assert_eq!(runtime.status().state, DeviceConnectionState::Closed);
    }

    #[test]
    fn registry_lists_records_sorted_by_device_id() {
        let mut registry = DeviceRegistry::new();
        registry.reserve_for_test(DeviceConnectionRecord {
            device_id: "serial:COM9".to_string(),
            connection_id: "conn-2".to_string(),
            port_name: "COM9".to_string(),
            baud_rate: 9_600,
            state: DeviceConnectionState::Idle,
            connected_at_ms: 2,
        });
        registry.reserve_for_test(DeviceConnectionRecord {
            device_id: "serial:COM3".to_string(),
            connection_id: "conn-1".to_string(),
            port_name: "COM3".to_string(),
            baud_rate: 9_600,
            state: DeviceConnectionState::Ready,
            connected_at_ms: 1,
        });

        let records = registry.list();

        assert_eq!(records[0].device_id, "serial:COM3");
        assert_eq!(records[1].device_id, "serial:COM9");
    }

    #[test]
    fn registry_disconnects_reserved_record() {
        let mut registry = DeviceRegistry::new();
        registry.reserve_for_test(DeviceConnectionRecord {
            device_id: "serial:COM3".to_string(),
            connection_id: "conn-1".to_string(),
            port_name: "COM3".to_string(),
            baud_rate: 9_600,
            state: DeviceConnectionState::Ready,
            connected_at_ms: 1,
        });

        let record = registry.disconnect("serial:COM3").expect("disconnect");

        assert_eq!(record.state, DeviceConnectionState::Closed);
        assert!(registry.list().is_empty());
    }

    #[test]
    fn registry_rejects_command_for_missing_device() {
        let mut registry = DeviceRegistry::new();
        let command = encode_motor_command(1, 5.0, 10.0, 3.0).expect("command");

        assert_eq!(
            registry.send_command("serial:COM404", &command, CommandPriority::Normal),
            Err(DeviceRuntimeError::DeviceNotFound(
                "serial:COM404".to_string()
            ))
        );
    }
}
