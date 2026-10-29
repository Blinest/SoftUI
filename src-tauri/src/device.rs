use crate::{
    protocol::{
        encode_version_negotiation, CalibrationEvent, DeviceStatus, FrameParser, ProtocolError,
        TensionFrame, UpMessage,
    },
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

    /// 这个 device_id 是否对应一条**真实存在的传输通道**（能真正收到字节）。
    ///
    /// 用来替代早期"按 `serial:` 前缀判断"的写法 —— 见 `lib.rs` 的
    /// `device_has_transport` 注释。
    pub fn contains(&self, device_id: &str) -> bool {
        self.records.contains_key(device_id)
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

    /// **收到设备帧 → 链路已通** ✓ —— 把握手态推进到 `Ready` ✓。
    ///
    /// 为什么必须有 ✗：`P1` 本地解析模式下（前端默认 ✓），浏览器把原始字节
    /// **自己解析** ✓，只把解析后的帧经 `frame_ingest` 上报 ✓，
    /// **原始字节从不到后端**✗ → 后端的 `handshake()` 永远等不到应答 ✓ →
    /// 状态卡在 `Handshaking` ✗ → 安全判定 `connected = false` ✓ →
    /// 界面"一直握手中、控制全不可用"✗（本 bug ✓）。
    ///
    /// 语义上也更对 ✓：帧能进来，就说明端口打开 ✓、波特率对 ✓、协议在跑 ✓。
    pub fn note_frame(&mut self, device_id: &str) {
        let Some(record) = self.records.get(device_id).cloned() else {
            return;
        };
        let Some(runtime) = self.serial_devices.get_mut(&record.port_name) else {
            return;
        };
        if matches!(
            runtime.state,
            DeviceConnectionState::Handshaking
                | DeviceConnectionState::Reconnecting
                | DeviceConnectionState::Error
        ) {
            runtime.state = DeviceConnectionState::Ready;
        }
        let next_state = runtime.state.clone();
        if let Some(record) = self.records.get_mut(device_id) {
            record.state = next_state;
        }
    }

    /// **浏览器上报的已解析帧 → 推进接收帧计数** ✓。
    ///
    /// 为什么必须单独记 ✗：`received_frames` 原来只在后端自己的
    /// `poll_status()`（读字节 + 解析 ✓）里递增 ✓。
    /// 而 `P1` 本地解析模式下，字节由浏览器解析 ✓、后端**读不到原始字节**✗，
    /// 加上"浏览器持有的串口不做状态轮询" ✓ → 这个计数永远停在 0 ✗ →
    /// 界面上"接收帧 0"，但数据其实是通的 ✓（本 bug ✓）。
    ///
    /// 只给 `frame_ingest` 用 ✓；`webserial_push`（原始字节路径）不调它 ✗，
    /// 否则会和 `poll_status` 重复计数 ✓。
    pub fn note_ingested_frame(&mut self, device_id: &str) {
        let Some(record) = self.records.get(device_id).cloned() else {
            return;
        };
        let Some(runtime) = self.serial_devices.get_mut(&record.port_name) else {
            return;
        };
        runtime.received_frames = runtime.received_frames.saturating_add(1);
        runtime.last_frame_ms = now_ms();
        runtime.last_ingest_ms = now_ms();
    }

    /// **这个端口最近是否有客户端在做本地解析** ✓。
    ///
    /// 有 → `webserial_push` 的原始字节应当**丢弃** ✓：
    /// 否则解析器会同时吃到"已解析帧"和"原始字节"两份数据 ✓ →
    /// 半包 / 重复块 → 协议错误疯长 ✗（现场现象 ✓）。
    pub fn has_recent_ingest(&self, port_name: &str, window_ms: u64) -> bool {
        let Some(runtime) = self.serial_devices.get(port_name) else {
            return false;
        };
        runtime.last_ingest_ms > 0 && now_ms().saturating_sub(runtime.last_ingest_ms) < window_ms
    }

    /// **按端口名推进握手态** ✓ —— 给"浏览器把原始字节推上来"那条路径用 ✓。
    ///
    /// 两条上报路径要**都**覆盖 ✗：
    ///   · `P1` 本地解析 → `frame_ingest`（解析后的帧 ✓）
    ///   · 老路径 → `webserial_push`（原始字节 ✓，后端自己解析 ✓）
    /// 只修一条的话，另一条仍然卡在 `Handshaking` ✓（实测 ✓）。
    pub fn note_port_activity(&mut self, port_name: &str) {
        let device_id = self
            .records
            .iter()
            .find(|(_, record)| record.port_name == port_name)
            .map(|(id, _)| id.clone());
        if let Some(device_id) = device_id {
            self.note_frame(&device_id);
        }
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
            /**
             * ⚠ **浏览器持有的串口（`webserial:*`）后端一律不碰** ✗。
             *
             * 这类设备的真实端口在**操作员的电脑上** ✓，数据由浏览器解析后上报 ✓。
             * 后端在本机 `SerialTransport::open("webserial:0")` 必然失败 ✓ →
             * `mark_reconnecting` → 每秒重试 ✓ → 界面永远显示"重连中"✗、
             * 而且会把这个**根本用不了的设备**留在列表里 ✓（现场现象 ✓）。
             */
            let browser_owned = record.port_name.starts_with("webserial:");
            let Some(runtime) = self.serial_devices.get_mut(&record.port_name) else {
                continue;
            };

            let (status, error, error_code) = if browser_owned {
                /**
                 * ⚠ **命令队列照常刷** ✗ —— 这是"电机全都不动、但反馈正常"的根因 ✓。
                 *
                 * 浏览器持有的串口：数据由浏览器读 ✓，但**下行命令**必须先由这里
                 * 把队列里的帧写进 `WebSerialTransport` 的 tx 缓冲 ✓，
                 * 浏览器再靠 `webserial_wait_tx` 拉走写串口 ✓。
                 * 上一版为了"后端别碰浏览器串口"把这一段整个跳过了 ✗ →
                 * 命令永远停在 `pending_commands` 里 ✓ → 下位机收不到任何帧 ✗，
                 * 而**读取路径完全不受影响** ✓（所以反馈照常解析 ✓，正是现场现象 ✓）。
                 *
                 * 这里只跳过：打开串口 ✓、重连 ✓、状态超时判定 ✓。
                 */
                let queue_error = runtime.flush_command_queue().err();
                /**
                 * **心跳超时** ✓ —— 浏览器端断开后必须让状态跟着掉 ✗。
                 *
                 * 页面刷新 / 关标签时浏览器会 `sendBeacon` 注销 ✓，
                 * 但崩溃、断网、强杀进程时不会 ✓ → 后端留着一条"已连接"✗ →
                 * 界面显示连着、**接收帧永远不涨**✗（现场现象 ✓）。
                 * 判据用"超过 **120 秒**没有新帧"✓ —— 原来是 15 秒 ✗，
                 * 太激进：固件校验没对齐时**所有帧都被丢弃** ✓ →
                 * 15 秒后状态被打成 Error ✗ → 之后连"启动控制系统"都被拖累 ✓
                 * （实测：点启动/关闭都没反应 ✓）。
                 * 120 秒足够区分"浏览器真的没了"，又不会误伤正在排障的现场 ✓。
                 */
                if runtime.last_frame_ms > 0
                    && now_ms().saturating_sub(runtime.last_frame_ms) > 120_000
                    && matches!(
                        runtime.state,
                        DeviceConnectionState::Ready | DeviceConnectionState::Enabled
                    )
                {
                    runtime.state = DeviceConnectionState::Error;
                    runtime.last_error = Some("超过 120 秒没有收到任何帧（浏览器端可能已断开）".into());
                    runtime.last_error_code = Some("StaleBrowserSession".into());
                }
                if let Some(error) = queue_error {
                    let code = error.code().to_string();
                    runtime.remember_error_with_code(format!("{error:?}"), code.clone());
                    (None, Some(format!("{error:?}")), Some(code))
                } else {
                    (None, None, None)
                }
            } else if runtime.state
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

    /// 当前是否有模拟设备在线。
    pub fn has_simulator(&self) -> bool {
        self.records
            .values()
            .any(|record| record.port_name == "simulator")
    }

    /// 是否还有真实的（非模拟）设备接入。
    pub fn has_real_device(&self) -> bool {
        self.records.values().any(|record| record.port_name != "simulator")
    }

    /// 真实设备接入时摘掉内置模拟设备：避免界面同时挂两个数据源、
    /// 图表在两组数据之间来回跳。
    pub fn remove_simulator(&mut self) {
        let _ = self.close_webserial("simulator");
    }

    /// 真实设备全部断开时把模拟设备补回来，保证界面始终有数据可看。
    pub fn ensure_simulator(&mut self) {
        if self.has_real_device() {
            return;
        }
        if self.records.values().any(|record| record.port_name == "simulator") {
            return;
        }
        let _ = self.seed_simulator();
    }

    /// 用浏览器 Web Serial 建立一路设备：字节由前端推入 `rx`，命令字节从前端取走。
    /// 同端口重复打开时先清掉旧的，保证幂等。
    pub fn open_webserial(
        &mut self,
        port_name: &str,
        baud_rate: u32,
        device_name: Option<String>,
        rx: crate::transport::WsRx,
        tx: crate::transport::WsTx,
    ) -> Result<DeviceConnectionRecord, DeviceRuntimeError> {
        self.serial_devices.remove(port_name);
        self.records.retain(|_, record| record.port_name != port_name);

        let transport = crate::transport::WebSerialTransport::new(rx, tx);
        let mut runtime = DeviceRuntime::new(Box::new(transport) as Box<dyn Transport>);
        // 握手失败是正常的：串口刚打开时对端还没回帧，等前端推字节进来即可。
        let _ = runtime.handshake();
        let record = DeviceConnectionRecord {
            // 显示名由前端给（例如 TDCR_v1）。给不出就退回 port_name，
            // 至少不会是 "webserial:webserial:1" 这种双重前缀。
            device_id: device_name.unwrap_or_else(|| port_name.to_string()),
            connection_id: format!("conn-{}", self.next_connection),
            port_name: port_name.to_string(),
            baud_rate,
            state: runtime.status().state,
            connected_at_ms: now_ms(),
        };
        self.next_connection = self.next_connection.saturating_add(1);
        self.serial_devices.insert(port_name.to_string(), runtime);
        self.records.insert(record.device_id.clone(), record.clone());
        Ok(record)
    }

    /// 关闭一路 Web Serial 设备。
    pub fn close_webserial(&mut self, port_name: &str) -> Result<(), DeviceRuntimeError> {
        let Some(mut runtime) = self.serial_devices.remove(port_name) else {
            return Err(DeviceRuntimeError::DeviceNotFound(port_name.to_string()));
        };
        let _ = runtime.close();
        self.records.retain(|_, record| record.port_name != port_name);
        Ok(())
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

    /// 连同**传输通道**一起登记：`send_command` 要按 port_name 取 runtime，
    /// 只登记 records 的话会以 DeviceNotFound 失败（测发送链路时必须用这个）。
    #[cfg(test)]
    fn reserve_runtime_for_test(&mut self, record: DeviceConnectionRecord) {
        let transport = crate::transport::SimulatorTransport::new().expect("simulator should start");
        self.serial_devices.insert(
            record.port_name.clone(),
            DeviceRuntime::new(Box::new(transport) as Box<dyn Transport>),
        );
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
    /// **最近一次 `frame_ingest`（浏览器本地解析后上报）的时刻** ✓
    ///
    /// 用来判断"是否已经有客户端在做本地解析" ✓ ——
    /// 有的话就不该再接受原始字节（`webserial_push`）✗，
    /// 否则两个来源同时喂解析器 → 重复/交错 → 协议错误疯长 ✗（现场现象 ✓）。
    pub last_ingest_ms: u64,
    pub sent_commands: u64,
    pub pending_commands: usize,
    pub reconnect_attempts: u32,
    pub last_frame_ms: u64,
    pub last_command_ms: u64,
    pub command_high_watermark: usize,
    pub emergency_latched: bool,
    /// 操作员是否通过「启动控制系统」使能过本设备。
    ///
    /// 状态帧里的 `system_state` 只有 0/1，且每来一帧就会被 `poll()` 重算 —— 下位机若不把
    /// 使能状态回写（当前 STM32 的 `CR.state` 恒 0），使能会在下一帧被冲掉。这个标志由
    /// `mark_control_enabled` 维护，不受状态帧影响，是**运动指令放行的依据**。
    pub control_enabled: bool,
    pub last_error: Option<String>,
    pub last_error_code: Option<String>,

    // ── 指令集 V2：多设备上行 ──
    /// 当前上行协议版本：1 = Legacy V1（`0xBB`），2 = V2（`0x55` + 设备 ID）。
    pub protocol_version: u8,
    /// 是否已回过版本协商（`AA 09 01 02`）。只需发一次。
    pub protocol_negotiated: bool,
    /// 累计收到的张力感知帧（`0x02` / V1 `0x03`）数量。
    pub tension_frames: u64,
    /// 累计收到的标定事件帧（`0x03` / V1 `0x04`）数量。
    pub calibration_events: u64,
    /// 累计收到的未识别帧（预留设备 / 未知功能码）数量。
    pub unknown_frames: u64,
    /// 最近一帧张力感知。
    pub last_tension: Option<TensionFrame>,
    /// 最近一次标定事件。
    pub last_calibration: Option<CalibrationEvent>,
}

pub struct DeviceRuntime<T: Transport> {
    transport: T,
    parser: FrameParser,
    state: DeviceConnectionState,
    last_status: Option<DeviceStatus>,
    received_frames: u64,
    protocol_errors: u64,
    sent_commands: u64,
    pending_commands: VecDeque<Vec<u8>>,
    reconnect_attempts: u32,
    last_reconnect_ms: u64,
    last_frame_ms: u64,
    /// **最近一次 `frame_ingest`（浏览器本地解析后上报）的时刻** ✓
    /// 用来判断"是否已有客户端在做本地解析" ✓
    last_ingest_ms: u64,
    last_command_ms: u64,
    command_high_watermark: usize,
    emergency_latched: bool,
    /// 操作员使能标志（`mark_control_enabled` 维护），不受状态帧重算影响。
    control_enabled: bool,
    last_error: Option<String>,
    last_error_code: Option<String>,
    /// 已经回过版本协商，不要重复发。
    protocol_negotiated: bool,
    tension_frames: u64,
    calibration_events: u64,
    unknown_frames: u64,
    last_tension: Option<TensionFrame>,
    last_calibration: Option<CalibrationEvent>,
}

impl<T: Transport> DeviceRuntime<T> {
    pub fn new(transport: T) -> Self {
        Self {
            transport,
            parser: FrameParser::new(),
            state: DeviceConnectionState::Idle,
            last_status: None,
            received_frames: 0,
            protocol_errors: 0,
            sent_commands: 0,
            pending_commands: VecDeque::new(),
            reconnect_attempts: 0,
            last_reconnect_ms: 0,
            last_frame_ms: 0,
            last_ingest_ms: 0,
            last_command_ms: 0,
            command_high_watermark: 0,
            emergency_latched: false,
            control_enabled: false,
            last_error: None,
            last_error_code: None,
            protocol_negotiated: false,
            tension_frames: 0,
            calibration_events: 0,
            unknown_frames: 0,
            last_tension: None,
            last_calibration: None,
        }
    }

    pub fn status(&self) -> RuntimeStatus {
        RuntimeStatus {
            state: self.state.clone(),
            last_status: self.last_status.clone(),
            received_frames: self.received_frames,
            protocol_errors: self.protocol_errors,
            last_ingest_ms: self.last_ingest_ms,
            sent_commands: self.sent_commands,
            pending_commands: self.pending_commands.len(),
            reconnect_attempts: self.reconnect_attempts,
            last_frame_ms: self.last_frame_ms,
            last_command_ms: self.last_command_ms,
            command_high_watermark: self.command_high_watermark,
            emergency_latched: self.emergency_latched,
            control_enabled: self.control_enabled,
            last_error: self.last_error.clone(),
            last_error_code: self.last_error_code.clone(),
            protocol_version: self.parser.last_version(),
            protocol_negotiated: self.protocol_negotiated,
            tension_frames: self.tension_frames,
            calibration_events: self.calibration_events,
            unknown_frames: self.unknown_frames,
            last_tension: self.last_tension.clone(),
            last_calibration: self.last_calibration,
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
        let decoded = self.parser.push_bytes(&bytes);
        if decoded.is_empty() {
            return Err(DeviceRuntimeError::NoStatusFrame);
        }

        let mut last_status: Option<DeviceStatus> = None;
        let mut first_error: Option<ProtocolError> = None;

        for frame in decoded {
            match frame {
                // ── 系统状态帧：唯一会推进设备状态的帧 ──
                Ok(UpMessage::Status(status)) => {
                    self.received_frames = self.received_frames.saturating_add(1);
                    self.last_status = Some(status.clone());
                    self.last_frame_ms = now_ms();
                    self.last_error = None;
                    self.last_error_code = None;
                    // 收到有效帧就说明链路是通的，**从 Handshaking 也必须能推出去**。
                    //
                    // 原来是 `if state != Handshaking`，配合 handshake() 的实现
                    // （先置 Handshaking，再连续同步读 5 次；读不到就 Err 返回、
                    // 状态留在 Handshaking）会形成一个死局：
                    // Web Serial 打开端口的那一刻浏览器还没送来字节，那 5 次必然
                    // 全部落空 —— 此后帧照收，但状态永远停在 handshaking，
                    // 使能 / 急停这类要求 ready 的操作全被挡住（实际踩到过）。
                    self.state = if self.emergency_latched {
                        DeviceConnectionState::EmergencyStopped
                    } else if self.control_enabled || status.system_state != 0 {
                        // 操作员使能过就保持 Enabled：下位机不回写 system_state 时
                        // （STM32 的 CR.state 恒 0），否则每帧都会把使能状态冲回 Ready。
                        DeviceConnectionState::Enabled
                    } else {
                        DeviceConnectionState::Ready
                    };
                    last_status = Some(status);
                }
                // ── 张力感知帧 / 标定事件帧：只记账，不推进设备状态 ──
                Ok(UpMessage::Tension(tension)) => {
                    self.tension_frames = self.tension_frames.saturating_add(1);
                    self.last_tension = Some(tension);
                }
                Ok(UpMessage::Calibration(event)) => {
                    self.calibration_events = self.calibration_events.saturating_add(1);
                    self.last_calibration = Some(event);
                }
                // ── 握手应答：下位机确认已切到 V2 ──
                Ok(UpMessage::Handshake(_)) => {
                    self.protocol_negotiated = true;
                }
                Ok(UpMessage::Unknown(_)) => {
                    self.unknown_frames = self.unknown_frames.saturating_add(1);
                }
                Err(error) => {
                    self.protocol_errors = self.protocol_errors.saturating_add(1);
                    self.last_error = Some(format!("{error:?}"));
                    self.last_error_code = Some("PROTOCOL_FRAME".to_string());
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }

        // 下位机上电默认发 V1；确认收到过帧之后再发一次协商，切到 V2 上行。
        // 只需一次：「默认 V1 → 上位机声明支持 V2 → 下位机切 V2」是一次性动作。
        if last_status.is_some() {
            self.maybe_queue_protocol_negotiation();
        }

        if let Some(status) = last_status {
            return Ok(status);
        }
        // 这一批里一个状态帧都没有：可能是只收到了张力帧（500ms 一帧，与状态的
        // 200ms 节奏不同），也可能是校验错。前者不算故障，后者才置 Error。
        match first_error {
            Some(error) => {
                self.state = DeviceConnectionState::Error;
                Err(DeviceRuntimeError::Protocol(error))
            }
            None => Err(DeviceRuntimeError::NoStatusFrame),
        }
    }

    /// 发一次版本协商（`AA 09 01 02`），让下位机把上行切到 V2。
    ///
    /// 只发一次：下位机已经是 V2（收到过 `0x55` 帧）或已回过握手应答时都不再发，
    /// 否则会变成每 200ms 一次的噪声。
    fn maybe_queue_protocol_negotiation(&mut self) {
        if self.protocol_negotiated || self.parser.last_version() >= 2 {
            self.protocol_negotiated = true;
            return;
        }
        let Ok(frame) = encode_version_negotiation(2) else {
            return;
        };
        // **直接写出，不排进 pending_commands**：协商是一次性动作，而队列会被
        // `mark_control_enabled(false)` 与急停清空 —— 帧被清掉、标志却已置位，
        // 就再也不会协商，表现是"下位机永远停在 V1"且毫无线索。
        // 整帧写进串口不会和队列里的用户命令错位：串口是字节流，整帧不会互相穿插。
        if self.send_command(&frame).is_ok() {
            self.protocol_negotiated = true;
        }
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
        self.control_enabled = enabled;
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
        self.parser = FrameParser::new();
        self.state = DeviceConnectionState::Handshaking;
        self.last_error = None;
        self.last_error_code = None;
        // 换了物理链路就要重新协商：新设备可能只认 V1。
        self.protocol_negotiated = false;
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
        let command = encode_motor_command(2, 10.0, 12.0).expect("command");

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
        let command = encode_motor_command(2, 10.0, 12.0).expect("command");

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
        let normal = encode_motor_command(2, 10.0, 12.0).expect("command");
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

    /// V2 上行帧的头部是 4 字节（`55 设备ID 功能码 LEN`），V1 是 3 字节（`BB 功能码 LEN`）。
    /// 同一个数据段换头即可得到一帧合法的 V1 帧。
    fn to_legacy_v1_frame(v2_frame: &[u8]) -> Vec<u8> {
        let len = v2_frame[3] as usize;
        let mut frame = vec![0xBB, 0x02, len as u8];
        frame.extend_from_slice(&v2_frame[4..4 + len]);
        let sum = frame.iter().fold(0u8, |acc, byte| acc.wrapping_add(*byte));
        frame.push(sum);
        frame
    }

    #[test]
    fn runtime_negotiates_v2_after_first_v1_status_frame() {
        let mut simulator = SimulatorTransport::new().expect("simulator");
        let v1 = to_legacy_v1_frame(&simulator.read().expect("frame"));
        let v2 = simulator.read().expect("frame");

        let transport = FragmentedTransport {
            chunks: vec![v1, v2.clone(), v2],
            writes: Vec::new(),
        };
        let mut runtime = DeviceRuntime::new(transport);

        runtime.poll_status().expect("first status");
        assert_eq!(
            runtime.status().protocol_version,
            1,
            "只收到 V1 帧时协议版本必须照实报 1"
        );

        let transport = runtime.into_transport();
        assert_eq!(
            transport.writes,
            vec![vec![0xAA, 0x09, 0x01, 0x02, 0xB6]],
            "首个 V1 状态帧之后应写出一帧版本协商（AA 09 01 02）"
        );
    }

    #[test]
    fn runtime_skips_negotiation_when_device_already_speaks_v2() {
        let transport = SimulatorTransport::new().expect("simulator");
        let mut runtime = DeviceRuntime::new(transport);

        // 模拟设备发的是 V2 帧，本来就无需协商。
        runtime.poll_status().expect("status");
        assert_eq!(runtime.status().protocol_version, 2);
        assert!(runtime.status().protocol_negotiated);

        let transport = runtime.into_transport();
        assert!(
            transport.written_frames().is_empty(),
            "已经是 V2 就不该再发协商帧：{:?}",
            transport.written_frames()
        );
    }

    #[test]
    fn runtime_tracks_tension_and_calibration_frames_separately() {
        let mut runtime = DeviceRuntime::new(SimulatorTransport::new().expect("simulator"));

        runtime.poll_status().expect("status");
        let status = runtime.status();

        // 状态帧计数只算状态帧：张力/标定帧是另一个节拍，混进去会让界面帧率显示虚高。
        assert_eq!(status.received_frames, 1);
        assert_eq!(status.tension_frames, 0);
        assert_eq!(status.calibration_events, 0);
        assert!(status.last_tension.is_none());
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
    fn registry_finds_devices_regardless_of_id_prefix() {
        // ★ 回归测试：Web Serial 设备的 id 是前端给的 deviceName（如 `TDCR_v1`），
        //   没有 `serial:` 前缀。上层曾经按前缀判断"能不能下发指令"，结果这类设备
        //   （以及 `simulator:0`）的**每一条指令都被静默丢弃**，而审计日志照样记
        //   "已发送" —— 现场表现是"点了没反应、设备永不确认"，查日志却一切正常。
        let mut registry = DeviceRegistry::new();
        registry.reserve_runtime_for_test(DeviceConnectionRecord {
            device_id: "TDCR_v1".to_string(),
            connection_id: "conn-1".to_string(),
            port_name: "webserial:0".to_string(),
            baud_rate: 115_200,
            state: DeviceConnectionState::Ready,
            connected_at_ms: 1,
        });

        assert!(registry.contains("TDCR_v1"), "按 id 就该找得到，与前缀无关");
        assert!(!registry.contains("serial:COM7"), "没注册的 id 不该被找到");

        let command = encode_motor_command(1, 5.0, 10.0).expect("command");
        assert!(
            registry
                .send_command("TDCR_v1", &command, CommandPriority::Normal)
                .is_ok(),
            "无前缀的 id 也必须能进发送链路"
        );
    }

    #[test]
    fn registry_rejects_command_for_missing_device() {
        let mut registry = DeviceRegistry::new();
        let command = encode_motor_command(1, 5.0, 10.0).expect("command");

        assert_eq!(
            registry.send_command("serial:COM404", &command, CommandPriority::Normal),
            Err(DeviceRuntimeError::DeviceNotFound(
                "serial:COM404".to_string()
            ))
        );
    }
}
