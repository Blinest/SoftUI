//! 上下位机通信协议（指令集）
//!
//! 对应思源文档：
//!   · 《上下位机通信协议（指令集）》   协议版本 V1（legacy）+ V2（分组功能码 / 可扩展上行帧头）
//!   · 《上位机收发参考实现（Python · Rust）》
//!
//! 帧格式（多字节数值一律**大端**，`SUM` = 前面所有字节之和 `& 0xFF`）：
//!
//! ```text
//! 下行 (上位机 → 下位机)    [0xAA][功能码][LEN][数据段 LEN 字节][SUM]      共 4+LEN
//! 上行 V2                  [0x55][设备ID][功能码][LEN][数据段][SUM]       共 5+LEN
//! 上行 V1 (legacy)         [0xBB][功能码][LEN][数据段][SUM]               共 4+LEN
//! ```
//!
//! `serve/protocol.js` 是本文件的**同源 JS 实现**（串口所在的那台浏览器做本机解析用）。
//! 两边的编解码与容错行为必须逐条对齐 —— 改一边务必同步另一边。

use serde::{Deserialize, Serialize};

/// 下行帧头：只出现于「上位机 → 下位机」。
pub const MAGIC_DOWN: u8 = 0xAA;
/// 上行 V1（legacy）帧头。
pub const MAGIC_UP_V1: u8 = 0xBB;
/// 上行 V2 帧头，后随 1 字节设备 ID（解决 V1 的方向撞车）。
pub const MAGIC_UP_V2: u8 = 0x55;

// ───────────────────────── 设备 / 模块 ID（仅 V2 有意义）─────────────────────────

/// 主控系统：握手应答 / 通用 ACK / 错误告警。
pub const DEV_SYS: u8 = 0x00;
/// 电机驱动：系统状态帧。
pub const DEV_DRIVE: u8 = 0x01;
/// 张力感知：张力感知帧。
pub const DEV_TENSION: u8 = 0x02;
/// 标定：标定事件帧。
pub const DEV_CALIB: u8 = 0x03;

// ────────────────────────────── 下行功能码 ──────────────────────────────

/// 下行功能码。V1 的 `0x03~0x08` 过渡兼容保留，新代码一律用 `0x10` 起的分组功能码。
pub mod function {
    // ── 0x0_ 系统 ──
    /// 电机失能（V1 既有，无 V2 对应）。
    pub const MOTOR_DISABLE: u8 = 0x00;
    /// 电机使能（V1 既有，无 V2 对应）。**上电默认失能，动作前必发。**
    pub const MOTOR_ENABLE: u8 = 0x01;
    /// 多电机急停（V1 既有，无 V2 对应）。
    pub const MOTOR_STOP: u8 = 0x02;
    /// 协议版本协商（V2 新增）`client_ver(1)`。
    pub const SYS_HANDSHAKE: u8 = 0x09;

    // ── 0x1_ 电机运动 ──
    /// 单电机定位 `addr(1) dir(1) dist(2) vel(2)`。
    pub const MOTOR_SINGLE: u8 = 0x10;
    /// 多电机同步（连续）`count(1) start_addr(1) n×int16`。
    pub const MOTOR_SYNC: u8 = 0x11;
    /// 多电机自定义 `count(1) n×[addr(1) dir(1) dist(2)]`。
    pub const MOTOR_CUSTOM: u8 = 0x12;
    /// 动作组演示（无数据段）。
    pub const MOTOR_DEMO: u8 = 0x13;

    // ── 0x2_ 传感器 ──
    /// 传感器初始化。
    pub const SENSOR_INIT: u8 = 0x20;
    /// 单通道读取 `id(1)`。
    pub const SENSOR_READ: u8 = 0x21;
    /// 全通道读取。
    pub const SENSOR_READ_ALL: u8 = 0x22;
    /// 砝码校准 `id(1) weight(2)`，单位 **g×10**。
    pub const SENSOR_CAL: u8 = 0x23;
    /// 感知零点标定（臂体自由无接触时执行）。
    pub const PERCEPT_ZERO: u8 = 0x24;

    // ── 0x3_ 配置 ──
    /// 设置安装方向 `dx(2) dy(2) dz(2)`，单位向量 ×1000。
    pub const SET_MOUNT: u8 = 0x30;
    /// 设置重力补偿增益 `gain(2)` ×1000（0=关闭，1=理论全额）。
    pub const GRAV_COMP: u8 = 0x31;

    // ── 0x4_ 动作 ──
    /// 单段弯曲 `seg(1) dir(1) angle(2)` ×0.01°（dir 0=朝上 1=朝下）。
    pub const SINGLE_BEND: u8 = 0x40;
    /// 主动控制 tick（**本项目扩展**，无数据段）。
    ///
    /// 旧实现发的是 `AA 06 02 02 00` —— 既不是 V1 `0x06`（多电机自定义：`count=2`
    /// 却只跟了 1 字节，长度不自洽），也不属于 V1/V2 任何已定义功能码，下位机只会
    /// 当畸形帧丢弃。现归入 `0x4_` 动作组，与 [`SINGLE_BEND`] 同组，语义清晰。
    ///
    /// 操作员开启「主动控制」后由上位机周期下发；下位机每收一帧走一步主动控制回路
    /// （PID 参数等由 `0x30` / `0x31` 等配置命令设定）。
    pub const ACTIVE_CONTROL: u8 = 0x41;

    // ── 0x5_ 标定（预留）──
    /// 触发通道平衡标定 `pull(2)` ×0.01mm（当前上电自动执行，预留手动触发）。
    pub const BALANCE_CALIB: u8 = 0x50;
}

/// 统一缩放约定。写侧用 `round`，避免 `-4.56 * 100 = -455.999…` 被截断丢 1。
mod scaling {
    /// 位移 / 速度 / 张力 / 角度。
    pub const LINEAR: f64 = 100.0;
    /// 单位向量 / 增益。
    pub const VECTOR: f64 = 1000.0;
    /// 无量纲比例 / 份额误差。
    pub const RATIO: f64 = 10_000.0;
    /// 砝码质量（克）。
    pub const WEIGHT: f64 = 10.0;
}

/// 上行帧的协议版本。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolVersion {
    V1,
    V2,
}

impl ProtocolVersion {
    /// 状态帧的完整头部（不含数据段）。
    fn status_header(self) -> [u8; 4] {
        match self {
            // V1 头部只有 3 字节，第 4 位占位无用（encode 时另行裁剪）
            Self::V1 => [MAGIC_UP_V1, 0x02, 0x00, 0x00],
            Self::V2 => [MAGIC_UP_V2, DEV_DRIVE, 0x00, 0x00],
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::V1 => "Legacy V1",
            Self::V2 => "V2",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    InvalidHeader,
    InvalidLength,
    InvalidChecksum,
    ValueOutOfRange(&'static str),
}

#[derive(Debug, Clone, PartialEq)]
pub struct MotorData {
    pub position_mm: f64,
    pub velocity_mm_per_sec: f64,
    pub acceleration_mm_per_sec2: f64,
    pub status: u8,
}

/// 系统状态帧里的单路张力采样。
///
/// ⚠️ 这不是「三轴传感器」，而是**一路压力通道**，而且**只有两个数**：
///   - `x` = 压力传感器的**实际值**（未经滤波的读数）
///   - `y` = **滤波值**
///
/// 每路占 **4 字节**（`x` i16 + `y` i16）。
///
/// 📌 与旧固件的差异：早期每路 6 字节（x/y/z，z 是保留位）。解析侧**两种步长都接受**
/// （见 [`DeviceStatus::decode`]），固件换代时上位机不必同步改；但
/// [`encode_status_frame`]（模拟设备）一律发新的 4 字节格式。
#[derive(Debug, Clone, PartialEq)]
pub struct SensorData {
    pub x: f64,
    pub y: f64,
}

/// 系统状态帧（数据段 85 字节，周期 200 ms）。
#[derive(Debug, Clone, PartialEq)]
pub struct DeviceStatus {
    pub num_motors: u8,
    pub num_sensors: u8,
    pub motors: Vec<MotorData>,
    pub sensors: Vec<SensorData>,
    /// 数据段偏移 80~81，int16 ×100。指令集字段名 `scale`。
    ///
    /// ⚠️ 界面目前把它显示成「第 1 段弯曲角(deg)」—— 那是历史口径，与指令集语义不符，
    /// 待固件侧确认后应修正展示。协议层本身按指令集命名，不改线上字节。
    pub scale: f64,
    /// 数据段偏移 82~83，int16 ×100。指令集字段名 `armbend`（臂弯曲）。
    pub arm_bend: f64,
    pub system_state: u8,
}

/// 握手应答：`55 00 00 04 <ver> <motor_n> <sensor_n> <flags>`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HandshakeAck {
    pub version: u8,
    pub motor_count: u8,
    pub sensor_count: u8,
    pub flags: u8,
}

/// 张力感知帧（数据段 50 字节，周期 500 ms）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TensionFrame {
    pub contact: bool,
    /// 接触主导段：0 或 1。
    pub contact_segment: u8,
    /// 接触点归一化弧长估计，×10000。
    pub s_norm: f64,
    /// 干扰指标，×10000，无量纲（份额不平衡矢量模长）。
    pub disturbance: f64,
    /// 截面系分量，×10000，**无量纲**。
    pub f_seg: [f64; 2],
    /// 由份额推算的力，×100，N（粗略）。
    pub f_mag: f64,
    /// 逐路健康码：0=正常 1=松弛/打滑 2=断丝/掉线 3=过张 4=过载。
    pub health: [u8; 6],
    /// 份额误差，×10000，无量纲。
    pub share_err: [f64; 6],
    /// 滤波 + 平衡后实测张力，×100，N。
    pub force: [f64; 6],
    /// 通道平衡系数，×100（100 表示 1.00，即未修正）。
    pub balance_gain: [f64; 6],
    pub calib_status: u8,
    pub calib_error: u8,
}

/// 标定事件帧（数据段 3 字节，事件触发）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalibrationEvent {
    /// 1=PRE_SETTLE 2=POST_MOVE 3=POST_SETTLE。
    pub stage: u8,
    /// 错误码，见 [`calib_error_label`]。
    pub error: u8,
    /// **未到位电机位掩码**，bit i = 电机 i。
    pub mask: u8,
}

/// 未识别（或预留）的上行帧。按设备 ID 分派，新增设备无需改动解析内核。
#[derive(Debug, Clone, PartialEq)]
pub struct UpFrame {
    /// 1 = V1(legacy)，2 = V2。
    pub version: u8,
    /// 设备 / 模块 ID（V1 固定为 [`DEV_SYS`]，无意义）。
    pub device: u8,
    pub function: u8,
    pub data: Vec<u8>,
}

/// 解析后的上行报文。
#[derive(Debug, Clone, PartialEq)]
pub enum UpMessage {
    Handshake(HandshakeAck),
    Status(DeviceStatus),
    Tension(TensionFrame),
    Calibration(CalibrationEvent),
    Unknown(UpFrame),
}

// ────────────────────────────── 文案映射 ──────────────────────────────

/// 健康码 → 中文说明。
pub fn health_label(code: u8) -> &'static str {
    match code {
        0 => "正常",
        1 => "松弛/打滑",
        2 => "断丝/掉线",
        3 => "过张",
        4 => "过载",
        _ => "未知",
    }
}

/// 标定状态码 → 中文说明。
pub fn calib_status_label(code: u8) -> &'static str {
    match code {
        0 => "未运行",
        1 => "进行中",
        2 => "成功",
        3 => "失败",
        _ => "未知",
    }
}

/// 标定阶段码 → 中文说明。
pub fn calib_stage_label(code: u8) -> &'static str {
    match code {
        1 => "PRE_SETTLE",
        2 => "POST_MOVE",
        3 => "POST_SETTLE",
        _ => "未知",
    }
}

/// 标定错误码 → 现场排查方向。
pub fn calib_error_label(code: u8) -> &'static str {
    match code {
        0 => "无",
        1 => "标定被禁用",
        2 => "电机无响应",
        3 => "Δτ 过小",
        4 => "Δτ 为负（方向反）",
        5 => "离散度过大",
        6 => "电机未到位",
        7 => "信号始终未稳定",
        _ => "未知",
    }
}

// ─────────────────────────── 通用工具 ───────────────────────────

/// 除自身外所有字节的 u8 环绕求和。
fn checksum(bytes: &[u8]) -> u8 {
    bytes.iter().fold(0u8, |sum, byte| sum.wrapping_add(*byte))
}

fn scaled_i16(value: f64, factor: f64, field: &'static str) -> Result<i16, ProtocolError> {
    if !value.is_finite() {
        return Err(ProtocolError::ValueOutOfRange(field));
    }
    // 四舍五入避免浮点漂移（-4.56 * 100 = -455.999…，trunc 会丢 1）
    let scaled = (value * factor).round();
    if scaled < i16::MIN as f64 || scaled > i16::MAX as f64 {
        return Err(ProtocolError::ValueOutOfRange(field));
    }
    Ok(scaled as i16)
}

fn scaled_u16(value: f64, factor: f64, field: &'static str) -> Result<u16, ProtocolError> {
    if !value.is_finite() || value < 0.0 {
        return Err(ProtocolError::ValueOutOfRange(field));
    }
    let scaled = (value * factor).round();
    if scaled > u16::MAX as f64 {
        return Err(ProtocolError::ValueOutOfRange(field));
    }
    Ok(scaled as u16)
}

/// 读取游标：越界一律 `InvalidLength`，不 panic。
struct Reader<'a> {
    data: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8], offset: usize) -> Self {
        Self { data, offset }
    }

    fn u8(&mut self) -> Result<u8, ProtocolError> {
        let value = *self.data.get(self.offset).ok_or(ProtocolError::InvalidLength)?;
        self.offset += 1;
        Ok(value)
    }

    fn i16(&mut self) -> Result<i16, ProtocolError> {
        if self.offset + 2 > self.data.len() {
            return Err(ProtocolError::InvalidLength);
        }
        let value = i16::from_be_bytes([self.data[self.offset], self.data[self.offset + 1]]);
        self.offset += 2;
        Ok(value)
    }

    fn at_end(&self) -> bool {
        self.offset >= self.data.len()
    }
}

// ─────────────────────────── 下行帧构造 ───────────────────────────

/// 封装一帧下行指令：`AA 功能码 LEN 数据段 SUM`。
pub fn build_down_frame(function: u8, data: &[u8]) -> Result<Vec<u8>, ProtocolError> {
    let len = u8::try_from(data.len()).map_err(|_| ProtocolError::InvalidLength)?;
    let mut frame = Vec::with_capacity(data.len() + 4);
    frame.push(MAGIC_DOWN);
    frame.push(function);
    frame.push(len);
    frame.extend_from_slice(data);
    frame.push(checksum(&frame));
    Ok(frame)
}

/// 协议版本协商（`0x09`）。`client_ver >= 2` 时下位机切 V2 上行并立即回握手应答。
pub fn encode_version_negotiation(client_ver: u8) -> Result<Vec<u8>, ProtocolError> {
    build_down_frame(function::SYS_HANDSHAKE, &[client_ver])
}

/// 单电机定位（`0x10`，V1 为 `0x03`）。
///
/// 帧结构：`AA 10 06 addr dir dist(2) vel(2) SUM`
///   - `addr` 电机地址（1 基）
///   - `dir`  0 = 正方向，1 = 反方向（由 `position_mm` 的符号推出）
///   - `dist` u16 ×0.01mm，**无符号**
///   - `vel`  u16 ×0.01mm/s
///
/// ⚠️ 这里**没有加速度字段**。旧实现按 8 字节（多带 2 字节加速度）发送，而下位机只读
/// 6 字节 —— 指令被静默丢弃。指令集已统一为 6 字节。
pub fn encode_motor_command(
    motor_id: u8,
    position_mm: f64,
    velocity_mm_per_sec: f64,
) -> Result<Vec<u8>, ProtocolError> {
    if !position_mm.is_finite() || !velocity_mm_per_sec.is_finite() {
        return Err(ProtocolError::ValueOutOfRange("position"));
    }
    let direction = if position_mm >= 0.0 { 0u8 } else { 1u8 };
    let distance = scaled_u16(position_mm.abs(), scaling::LINEAR, "position")?;
    let velocity = scaled_u16(velocity_mm_per_sec.abs(), scaling::LINEAR, "velocity")?;

    let mut data = Vec::with_capacity(6);
    data.push(motor_id);
    data.push(direction);
    data.extend_from_slice(&distance.to_be_bytes());
    data.extend_from_slice(&velocity.to_be_bytes());
    build_down_frame(function::MOTOR_SINGLE, &data)
}

/// 多电机同步位移（`0x11`，V1 为 `0x04`）。
///
/// 帧结构：`AA 11 LEN count start_addr d0_H d0_L ... dn_H dn_L SUM`
///   - `LEN`        = `2 + count * 2`
///   - `start_addr` = 起始电机地址（1 基）
///   - 每个位移     = `int16` 大端，单位 0.01mm，**带符号**
///
/// 本指令**不下发速度**：下位机按「各电机位移 / 本批次最大位移」的比例分配速度，
/// 使多轴位移同时到达。
pub fn encode_multi_motor_command(
    start_address: u8,
    positions_mm: &[f64],
) -> Result<Vec<u8>, ProtocolError> {
    let count = u8::try_from(positions_mm.len()).map_err(|_| ProtocolError::InvalidLength)?;

    let mut data = Vec::with_capacity(2 + positions_mm.len() * 2);
    data.push(count);
    data.push(start_address);
    for position in positions_mm {
        data.extend_from_slice(&scaled_i16(*position, scaling::LINEAR, "position")?.to_be_bytes());
    }
    build_down_frame(function::MOTOR_SYNC, &data)
}

/// 一键归中：全部位移为 0 的 `0x11` 特例。
pub fn encode_home_command(motor_count: u8, start_address: u8) -> Result<Vec<u8>, ProtocolError> {
    let positions = vec![0.0; motor_count as usize];
    encode_multi_motor_command(start_address, &positions)
}

/// 多电机自定义（`0x12`，全新实现）。`items = [(addr, dir, dist_mm), ...]`，1~6 路。
///
/// 旧 `0x06` 除 `addr == 0xFE` 特判外**全是空操作**（多路自定义从未实现）。
pub fn encode_custom_motor_command(items: &[(u8, u8, f64)]) -> Result<Vec<u8>, ProtocolError> {
    let count = u8::try_from(items.len()).map_err(|_| ProtocolError::InvalidLength)?;

    let mut data = Vec::with_capacity(1 + items.len() * 4);
    data.push(count);
    for (address, direction, distance_mm) in items {
        data.push(*address);
        data.push(*direction & 0x01);
        data.extend_from_slice(
            &scaled_u16(distance_mm.abs(), scaling::LINEAR, "position")?.to_be_bytes(),
        );
    }
    build_down_frame(function::MOTOR_CUSTOM, &data)
}

/// 动作组演示（`0x13`，V1 为 `0x05`，无数据段）。
pub fn encode_demo_command() -> Result<Vec<u8>, ProtocolError> {
    build_down_frame(function::MOTOR_DEMO, &[])
}

/// 传感器初始化（`0x20`）。
pub fn encode_sensor_init() -> Result<Vec<u8>, ProtocolError> {
    build_down_frame(function::SENSOR_INIT, &[])
}

/// 单通道读取（`0x21`）。
pub fn encode_sensor_read(sensor_id: u8) -> Result<Vec<u8>, ProtocolError> {
    build_down_frame(function::SENSOR_READ, &[sensor_id])
}

/// 全通道读取（`0x22`）。
pub fn encode_sensor_read_all() -> Result<Vec<u8>, ProtocolError> {
    build_down_frame(function::SENSOR_READ_ALL, &[])
}

/// 砝码校准（`0x23`）。`weight_g` 单位**克**，下位机收 g×10。
///
/// ⚠️ 旧实现发的是 `BB 03`（V1 传感器帧头）+ ×100，两处都不符合指令集：
/// 下行帧头必须是 `0xAA`，且重量按 g×10 缩放。
pub fn encode_sensor_calibration(
    sensor_id: u8,
    weight_g: f64,
) -> Result<Vec<u8>, ProtocolError> {
    if !weight_g.is_finite() || weight_g < 0.0 {
        return Err(ProtocolError::ValueOutOfRange("weight"));
    }
    let scaled = (weight_g * scaling::WEIGHT).round();
    if scaled > u16::MAX as f64 {
        return Err(ProtocolError::ValueOutOfRange("weight"));
    }
    let mut data = Vec::with_capacity(3);
    data.push(sensor_id);
    data.extend_from_slice(&(scaled as u16).to_be_bytes());
    build_down_frame(function::SENSOR_CAL, &data)
}

/// 感知零点标定（`0x24`）。臂体自由无接触时执行。
pub fn encode_percept_zero() -> Result<Vec<u8>, ProtocolError> {
    build_down_frame(function::PERCEPT_ZERO, &[])
}

/// 设置安装方向（`0x30`，V1 为 `0x07`）。`direction` 为**单位向量**，按 ×1000 下发。
///
/// 常用取值：竖直向上 `(0,0,1)`、水平沿 X `(1,0,0)`、水平沿 Y `(0,1,0)`。
/// 切换竖直 / 水平**必须重发**，否则感知与重力补偿基准都是错的。
pub fn encode_set_mount_direction(direction: [f64; 3]) -> Result<Vec<u8>, ProtocolError> {
    let mut data = Vec::with_capacity(6);
    for (index, component) in direction.iter().enumerate() {
        let field = match index {
            0 => "mount_x",
            1 => "mount_y",
            _ => "mount_z",
        };
        data.extend_from_slice(&scaled_i16(*component, scaling::VECTOR, field)?.to_be_bytes());
    }
    build_down_frame(function::SET_MOUNT, &data)
}

/// 设置重力补偿增益（`0x31`，V1 为 `0x08`）。`gain` ×1000（0 = 关闭，1 = 理论全额）。
pub fn encode_gravity_compensation(gain: f64) -> Result<Vec<u8>, ProtocolError> {
    let scaled = scaled_i16(gain, scaling::VECTOR, "gain")?;
    build_down_frame(function::GRAV_COMP, &scaled.to_be_bytes())
}

/// 单段弯曲（`0x40`，旧 `0x06 + addr=0xFE` 的替代）。
///
/// `segment` ∈ {1, 2}；`up = true` 表示朝上（dir=0），`false` 表示朝下（dir=1）。
/// 旧实现把「寻址」与「功能选择」压进同一字节，且 `seg` 被写死为 1。
pub fn encode_single_bend_command(
    segment: u8,
    up: bool,
    angle_deg: f64,
) -> Result<Vec<u8>, ProtocolError> {
    if !(1..=2).contains(&segment) {
        return Err(ProtocolError::ValueOutOfRange("segment"));
    }
    let angle = scaled_u16(angle_deg.abs(), scaling::LINEAR, "angle")?;
    let mut data = Vec::with_capacity(4);
    data.push(segment);
    data.push(if up { 0 } else { 1 });
    data.extend_from_slice(&angle.to_be_bytes());
    build_down_frame(function::SINGLE_BEND, &data)
}

/// 触发通道平衡标定（`0x50`，预留）。`pull_mm` ×0.01mm。
pub fn encode_balance_calibration(pull_mm: f64) -> Result<Vec<u8>, ProtocolError> {
    let pull = scaled_i16(pull_mm, scaling::LINEAR, "pull")?;
    build_down_frame(function::BALANCE_CALIB, &pull.to_be_bytes())
}

/// 主动控制 tick（`0x41`，`0x4_` 动作组）。无数据段：`AA 41 00 SUM`。
///
/// 语义是「走一步主动控制回路」，因此**可以高频重复下发**；开启主动控制时上位机
/// 按控制周期调用，停止时不再发即可（下位机不需要单独的模式切换命令）。
pub fn encode_active_control_command() -> Result<Vec<u8>, ProtocolError> {
    build_down_frame(function::ACTIVE_CONTROL, &[])
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemControlAction {
    Disable,
    Enable,
    EmergencyStop,
}

impl SystemControlAction {
    /// 这三个功能码 V1 / V2 通用，没有分组版本。
    pub fn function_code(self) -> u8 {
        match self {
            Self::Disable => function::MOTOR_DISABLE,
            Self::Enable => function::MOTOR_ENABLE,
            Self::EmergencyStop => function::MOTOR_STOP,
        }
    }
}

/// 电机失能 / 使能 / 急停。无数据段。
pub fn encode_system_control_command(
    action: SystemControlAction,
) -> Result<Vec<u8>, ProtocolError> {
    build_down_frame(action.function_code(), &[])
}

// ─────────────────────────── 上行帧编码 / 解析 ───────────────────────────

/// 组装一帧上行状态帧（仅供模拟设备与单元测试使用）。
pub fn encode_status_frame(
    status: &DeviceStatus,
    version: ProtocolVersion,
) -> Result<Vec<u8>, ProtocolError> {
    if status.motors.len() > u8::MAX as usize || status.sensors.len() > u8::MAX as usize {
        return Err(ProtocolError::InvalidLength);
    }
    if status.motors.len() != status.num_motors as usize
        || status.sensors.len() != status.num_sensors as usize
    {
        return Err(ProtocolError::InvalidLength);
    }

    let data_len = 2 + status.motors.len() * 7 + status.sensors.len() * 4 + 2 + 2 + 1;
    let data_len = u8::try_from(data_len).map_err(|_| ProtocolError::InvalidLength)?;

    let header = version.status_header();
    let mut frame = Vec::with_capacity(data_len as usize + 5);
    match version {
        ProtocolVersion::V1 => frame.extend_from_slice(&header[..2]),
        ProtocolVersion::V2 => frame.extend_from_slice(&header[..3]),
    }
    frame.push(data_len);
    frame.push(status.num_motors);
    frame.push(status.num_sensors);

    for motor in &status.motors {
        frame.extend_from_slice(&scaled_i16(motor.position_mm, scaling::LINEAR, "position")?.to_be_bytes());
        frame.extend_from_slice(
            &scaled_i16(motor.velocity_mm_per_sec, scaling::LINEAR, "velocity")?.to_be_bytes(),
        );
        frame.extend_from_slice(
            &scaled_i16(motor.acceleration_mm_per_sec2, scaling::LINEAR, "acceleration")?
                .to_be_bytes(),
        );
        frame.push(motor.status);
    }

    for sensor in &status.sensors {
        frame.extend_from_slice(&scaled_i16(sensor.x, scaling::LINEAR, "sensor_x")?.to_be_bytes());
        frame.extend_from_slice(&scaled_i16(sensor.y, scaling::LINEAR, "sensor_y")?.to_be_bytes());
    }

    frame.extend_from_slice(&scaled_i16(status.scale, scaling::LINEAR, "scale")?.to_be_bytes());
    frame.extend_from_slice(&scaled_i16(status.arm_bend, scaling::LINEAR, "armbend")?.to_be_bytes());
    frame.push(status.system_state);
    frame.push(checksum(&frame));
    Ok(frame)
}

impl DeviceStatus {
    /// 解析系统状态帧的**数据段**（85 字节；电机/传感器数量从数据段首两字节读取）。
    pub fn decode(data: &[u8]) -> Result<Self, ProtocolError> {
        if data.len() < 5 {
            return Err(ProtocolError::InvalidLength);
        }
        let num_motors = data[0];
        let num_sensors = data[1];
        // 传感器每路的字节数随固件版本不同：新版 4（x/y），旧版 6（x/y/z）。
        // 用**帧内声明的传感器数量**各算一遍期望长度，哪个对上就用哪个 —— 于是同一个
        // 上位机能同时吃新旧固件的帧，不必两边同步升级。
        // （不会产生歧义：两种算法用的是同一个 m，长度必然不同。）
        let base = 2 + num_motors as usize * 7 + 2 + 2 + 1;
        let per_sensor = if data.len() == base + num_sensors as usize * 4 {
            4usize
        } else if data.len() == base + num_sensors as usize * 6 {
            6usize
        } else {
            return Err(ProtocolError::InvalidLength);
        };

        let mut reader = Reader::new(data, 2);
        let mut motors = Vec::with_capacity(num_motors as usize);
        for _ in 0..num_motors {
            motors.push(MotorData {
                position_mm: reader.i16()? as f64 / scaling::LINEAR,
                velocity_mm_per_sec: reader.i16()? as f64 / scaling::LINEAR,
                acceleration_mm_per_sec2: reader.i16()? as f64 / scaling::LINEAR,
                status: reader.u8()?,
            });
        }

        let mut sensors = Vec::with_capacity(num_sensors as usize);
        for _ in 0..num_sensors {
            let x = reader.i16()? as f64 / scaling::LINEAR;
            let y = reader.i16()? as f64 / scaling::LINEAR;
            if per_sensor == 6 {
                // 旧格式的保留位：读掉不用，别让它错位到后面的字段上
                let _reserved = reader.i16()?;
            }
            sensors.push(SensorData { x, y });
        }

        let scale = reader.i16()? as f64 / scaling::LINEAR;
        let arm_bend = reader.i16()? as f64 / scaling::LINEAR;
        let system_state = reader.u8()?;
        if !reader.at_end() {
            return Err(ProtocolError::InvalidLength);
        }

        Ok(DeviceStatus {
            num_motors,
            num_sensors,
            motors,
            sensors,
            scale,
            arm_bend,
            system_state,
        })
    }
}

impl HandshakeAck {
    pub fn decode(data: &[u8]) -> Result<Self, ProtocolError> {
        if data.len() != 4 {
            return Err(ProtocolError::InvalidLength);
        }
        Ok(Self {
            version: data[0],
            motor_count: data[1],
            sensor_count: data[2],
            flags: data[3],
        })
    }
}

impl TensionFrame {
    pub fn decode(data: &[u8]) -> Result<Self, ProtocolError> {
        if data.len() != 50 {
            return Err(ProtocolError::InvalidLength);
        }

        let mut reader = Reader::new(data, 2);
        let s_norm = reader.i16()? as f64 / scaling::RATIO;
        let disturbance = reader.i16()? as f64 / scaling::RATIO;
        let f0 = reader.i16()? as f64 / scaling::RATIO;
        let f1 = reader.i16()? as f64 / scaling::RATIO;
        let f_mag = reader.i16()? as f64 / scaling::LINEAR;

        let mut health = [0u8; 6];
        for slot in health.iter_mut() {
            *slot = reader.u8()?;
        }

        let mut share_err = [0.0f64; 6];
        for slot in share_err.iter_mut() {
            *slot = reader.i16()? as f64 / scaling::RATIO;
        }

        let mut force = [0.0f64; 6];
        for slot in force.iter_mut() {
            *slot = reader.i16()? as f64 / scaling::LINEAR;
        }

        let mut balance_gain = [0.0f64; 6];
        for slot in balance_gain.iter_mut() {
            *slot = reader.u8()? as f64 / scaling::LINEAR;
        }

        let calib_status = reader.u8()?;
        let calib_error = reader.u8()?;
        if !reader.at_end() {
            return Err(ProtocolError::InvalidLength);
        }

        Ok(Self {
            contact: data[0] != 0,
            contact_segment: data[1],
            s_norm,
            disturbance,
            f_seg: [f0, f1],
            f_mag,
            health,
            share_err,
            force,
            balance_gain,
            calib_status,
            calib_error,
        })
    }
}

impl CalibrationEvent {
    pub fn decode(data: &[u8]) -> Result<Self, ProtocolError> {
        if data.len() != 3 {
            return Err(ProtocolError::InvalidLength);
        }
        Ok(Self {
            stage: data[0],
            error: data[1],
            mask: data[2],
        })
    }

    /// 未到位电机序号（1 基），来自 `mask`。
    pub fn pending_motors(&self) -> Vec<u8> {
        (0..8)
            .filter(|bit| self.mask >> bit & 1 == 1)
            .map(|bit| bit + 1)
            .collect()
    }
}

/// 按「版本 + 设备 ID / 功能码」把数据段解成具体报文。
fn decode_up_frame(
    version: u8,
    device: u8,
    function: u8,
    data: &[u8],
) -> Result<UpMessage, ProtocolError> {
    match (version, device, function) {
        // ── V2：按设备 ID 分派，新增设备无需改动解析内核 ──
        //
        // DEV_SYS（主控）不只发握手应答 —— 指令集 3.2 的设备表里它还带「通用 ACK /
        // 错误告警」。所以**必须连功能码一起判**：否则那些帧会被拿去按 4 字节的握手
        // 应答来解，长度对不上就报 InvalidLength，一个正常的系统告警反而会把设备
        // 判成协议错误。
        (2, DEV_SYS, 0x00) => Ok(UpMessage::Handshake(HandshakeAck::decode(data)?)),
        (2, DEV_DRIVE, _) => Ok(UpMessage::Status(DeviceStatus::decode(data)?)),
        // **张力感知帧已移除** ✓ —— 只保留状态帧里的张力通道数据 ✓。
        // 帧本身仍按长度切分 ✓（不会打乱后续帧 ✓），只是不再解析成结构 ✓。
        (2, DEV_TENSION, _) => Ok(UpMessage::Unknown(UpFrame {
            version: 2,
            device: DEV_TENSION,
            function: 0,
            data: Vec::new(),
        })),
        (2, DEV_CALIB, _) => Ok(UpMessage::Calibration(CalibrationEvent::decode(data)?)),
        // ── V1：没有设备 ID，只能按功能码分派 ──
        (1, _, 0x02) => Ok(UpMessage::Status(DeviceStatus::decode(data)?)),
        // **V1 的张力帧同样移除** ✓
        (1, _, 0x03) => Ok(UpMessage::Unknown(UpFrame {
            version: 1,
            device: DEV_SYS,
            function: 0x03,
            data: Vec::new(),
        })),
        (1, _, 0x04) => Ok(UpMessage::Calibration(CalibrationEvent::decode(data)?)),
        _ => Ok(UpMessage::Unknown(UpFrame {
            version,
            device,
            function,
            data: data.to_vec(),
        })),
    }
}

/// 流式解码器：把串口来的零散字节攒成完整报文。
///
/// 容错策略（与指令集「帧头同步 + 长度收帧 + 校验」一致）：
///   - 逐字节找帧头（`0xBB` 或 `0x55`），找到才认，所以丢字节后能自动重新对齐
///   - 校验和错时**只前进 1 字节**（继续找下一个帧头），而不是整帧跳过 ——
///     这一帧很可能是噪声里的假帧头，整帧跳过会把真正的帧头一起吃掉，导致后面连续错位
///   - 缓冲上限 4096，超出保留尾部 2048
///
/// V1 与 V2 可以混流（下位机协商切换的瞬间就会同时出现两种）。
#[derive(Debug)]
pub struct FrameParser {
    buffer: Vec<u8>,
    last_version: u8,
}

const MAX_BUFFER: usize = 4096;
const KEEP_TAIL: usize = 2048;

impl Default for FrameParser {
    fn default() -> Self {
        Self::new()
    }
}

impl FrameParser {
    pub fn new() -> Self {
        Self {
            buffer: Vec::new(),
            last_version: 1,
        }
    }

    /// 最近一帧成功解出的协议版本（1 = V1，2 = V2）。
    ///
    /// 用于界面显示与「是否还需要发版本协商」的判断。默认 1（下位机上电默认发 V1），
    /// 只要出现过一次 `0x55` 帧就变 2。
    pub fn last_version(&self) -> u8 {
        self.last_version
    }

    pub fn push_bytes(&mut self, input: &[u8]) -> Vec<Result<UpMessage, ProtocolError>> {
        self.buffer.extend_from_slice(input);
        if self.buffer.len() > MAX_BUFFER {
            let keep_from = self.buffer.len().saturating_sub(KEEP_TAIL);
            self.buffer.drain(..keep_from);
        }

        let mut decoded = Vec::new();
        let mut index = 0usize;

        loop {
            // ① 找帧头
            while index < self.buffer.len()
                && self.buffer[index] != MAGIC_UP_V1
                && self.buffer[index] != MAGIC_UP_V2
            {
                index += 1;
            }
            if index >= self.buffer.len() {
                break;
            }

            // ② 头部长度：V1 三字节，V2 四字节
            let magic = self.buffer[index];
            let header_len = if magic == MAGIC_UP_V1 { 3usize } else { 4usize };
            if index + header_len > self.buffer.len() {
                break; // 帧头还没收齐
            }

            let (device, function, data_len) = if magic == MAGIC_UP_V1 {
                (DEV_SYS, self.buffer[index + 1], self.buffer[index + 2] as usize)
            } else {
                (
                    self.buffer[index + 1],
                    self.buffer[index + 2],
                    self.buffer[index + 3] as usize,
                )
            };

            // ③ 整帧收齐？
            let total_len = header_len + data_len + 1;
            if index + total_len > self.buffer.len() {
                break;
            }

            let frame = &self.buffer[index..index + total_len];
            if checksum(&frame[..total_len - 1]) != frame[total_len - 1] {
                decoded.push(Err(ProtocolError::InvalidChecksum));
                index += 1;
                continue;
            }

            let data = &frame[header_len..total_len - 1];
            let version = if magic == MAGIC_UP_V2 { 2 } else { 1 };
            self.last_version = version;
            decoded.push(decode_up_frame(version, device, function, data));
            index += total_len;
        }

        if index > 0 {
            self.buffer.drain(..index);
        }

        decoded
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_status() -> DeviceStatus {
        DeviceStatus {
            num_motors: 2,
            num_sensors: 2,
            motors: vec![
                MotorData {
                    position_mm: 12.34,
                    velocity_mm_per_sec: -2.5,
                    acceleration_mm_per_sec2: 1.0,
                    status: 1,
                },
                MotorData {
                    position_mm: -1.25,
                    velocity_mm_per_sec: 8.5,
                    acceleration_mm_per_sec2: 2.75,
                    status: 0,
                },
            ],
            sensors: vec![
                SensorData { x: 1.23, y: -4.56 },
                SensorData { x: 0.5, y: 0.25 },
            ],
            scale: 12.5,
            arm_bend: -6.75,
            system_state: 1,
        }
    }

    fn v1_status_frame() -> Vec<u8> {
        encode_status_frame(&sample_status(), ProtocolVersion::V1).expect("v1 status")
    }

    fn v2_status_frame() -> Vec<u8> {
        encode_status_frame(&sample_status(), ProtocolVersion::V2).expect("v2 status")
    }

    fn push_one(parser: &mut FrameParser, bytes: &[u8]) -> Result<UpMessage, ProtocolError> {
        let decoded = parser.push_bytes(bytes);
        assert_eq!(decoded.len(), 1, "期望恰好解出 1 个报文：{decoded:?}");
        decoded.into_iter().next().unwrap()
    }

    // ─────────────────────── 下行帧构造 ───────────────────────

    #[test]
    fn encodes_single_motor_with_six_byte_payload() {
        // 旧实现发 `AA 03 08 …`（8 字节，多带加速度）→ 下位机只读 6 字节，指令被静默丢弃。
        let frame = encode_motor_command(1, -7.0, 10.0).expect("motor command");
        assert_eq!(
            frame,
            vec![0xAA, 0x10, 0x06, 0x01, 0x01, 0x02, 0xBC, 0x03, 0xE8, 0x6B]
        );
        assert_eq!(frame[2], 6, "数据段必须是 6 字节（无加速度字段）");
        assert_eq!(checksum(&frame[..frame.len() - 1]), frame[frame.len() - 1]);
    }

    #[test]
    fn encodes_system_control_commands() {
        assert_eq!(
            encode_system_control_command(SystemControlAction::Disable).expect("disable"),
            vec![0xAA, 0x00, 0x00, 0xAA]
        );
        assert_eq!(
            encode_system_control_command(SystemControlAction::Enable).expect("enable"),
            vec![0xAA, 0x01, 0x00, 0xAB]
        );
        assert_eq!(
            encode_system_control_command(SystemControlAction::EmergencyStop).expect("stop"),
            vec![0xAA, 0x02, 0x00, 0xAC]
        );
    }

    #[test]
    fn encodes_version_negotiation() {
        // 指令集 3.3 / 检查清单：「AA 09 01 02」
        let frame = encode_version_negotiation(2).expect("handshake");
        assert_eq!(frame, vec![0xAA, 0x09, 0x01, 0x02, 0xB6]);
        assert_eq!(
            encode_version_negotiation(1).expect("handshake"),
            vec![0xAA, 0x09, 0x01, 0x01, 0xB5]
        );
    }

    #[test]
    fn encodes_multi_motor_command_with_signed_positions() {
        // 3 台电机，起始地址 1，位移 +1.00 / 0.00 / -2.50 mm
        let frame = encode_multi_motor_command(1, &[1.0, 0.0, -2.5]).expect("multi motor");
        assert_eq!(
            frame,
            vec![
                0xAA, 0x11, 0x08, 0x03, 0x01, // 帧头/功能码/LEN=8/count=3/起始地址=1
                0x00, 0x64, // +1.00mm ->  100
                0x00, 0x00, //  0.00mm ->    0
                0xFF, 0x06, // -2.50mm -> -250
                0x30,       // 校验和
            ]
        );
    }

    #[test]
    fn home_command_equals_multi_motor_with_zero_positions() {
        assert_eq!(
            encode_home_command(2, 1).expect("home"),
            encode_multi_motor_command(1, &[0.0, 0.0]).expect("multi"),
        );
    }

    #[test]
    fn multi_motor_command_rejects_out_of_range_position() {
        // int16 只能表示 ±327.67mm
        assert_eq!(
            encode_multi_motor_command(1, &[400.0]),
            Err(ProtocolError::ValueOutOfRange("position")),
        );
        assert_eq!(
            encode_multi_motor_command(1, &[f64::NAN]),
            Err(ProtocolError::ValueOutOfRange("position")),
        );
    }

    #[test]
    fn encodes_custom_motor_command() {
        let frame =
            encode_custom_motor_command(&[(1, 0, 1.0), (3, 1, 2.5)]).expect("custom motor");
        assert_eq!(
            frame,
            vec![
                0xAA, 0x12, 0x09, 0x02, // 帧头/功能码/LEN=9/count=2
                0x01, 0x00, 0x00, 0x64, // addr=1 dir=+ +1.00mm
                0x03, 0x01, 0x00, 0xFA, // addr=3 dir=- +2.50mm
                0x2A,
            ]
        );
    }

    #[test]
    fn encodes_demo_and_sensor_commands() {
        assert_eq!(encode_demo_command().expect("demo"), vec![0xAA, 0x13, 0x00, 0xBD]);
        assert_eq!(
            encode_sensor_init().expect("init"),
            vec![0xAA, 0x20, 0x00, 0xCA]
        );
        assert_eq!(
            encode_sensor_read(2).expect("read"),
            vec![0xAA, 0x21, 0x01, 0x02, 0xCE]
        );
        assert_eq!(
            encode_sensor_read_all().expect("read all"),
            vec![0xAA, 0x22, 0x00, 0xCC]
        );
        assert_eq!(
            encode_percept_zero().expect("percept zero"),
            vec![0xAA, 0x24, 0x00, 0xCE]
        );
    }

    #[test]
    fn encodes_sensor_calibration_in_grams_times_ten() {
        // 旧实现：`BB 03 03 02 FE BB …`（0xBB 下行帧头 + ×100），两处都不符合指令集。
        let frame = encode_sensor_calibration(2, 500.0).expect("sensor calibration");
        assert_eq!(frame, vec![0xAA, 0x23, 0x03, 0x02, 0x13, 0x88, 0x6D]);
        assert_eq!(frame[0], MAGIC_DOWN, "下行帧头必须是 0xAA");
        // 500.0 g → 5000 = 0x1388（g×10）
        assert_eq!(u16::from_be_bytes([frame[4], frame[5]]), 5000);
    }

    #[test]
    fn encodes_mount_direction_and_gravity_compensation() {
        let vertical = encode_set_mount_direction([0.0, 0.0, 1.0]).expect("mount");
        assert_eq!(
            vertical,
            vec![0xAA, 0x30, 0x06, 0x00, 0x00, 0x00, 0x00, 0x03, 0xE8, 0xCB]
        );

        let horizontal_x = encode_set_mount_direction([1.0, 0.0, 0.0]).expect("mount");
        assert_eq!(
            horizontal_x,
            vec![0xAA, 0x30, 0x06, 0x03, 0xE8, 0x00, 0x00, 0x00, 0x00, 0xCB]
        );

        let gain = encode_gravity_compensation(1.0).expect("gravity");
        assert_eq!(gain, vec![0xAA, 0x31, 0x02, 0x03, 0xE8, 0xC8]);
        assert_eq!(
            encode_gravity_compensation(0.0).expect("gravity"),
            vec![0xAA, 0x31, 0x02, 0x00, 0x00, 0xDD]
        );
    }

    #[test]
    fn encodes_single_bend_and_balance_calibration() {
        // 单段弯曲 seg=1 朝上 30.00°
        let bend = encode_single_bend_command(1, true, 30.0).expect("bend");
        assert_eq!(bend, vec![0xAA, 0x40, 0x04, 0x01, 0x00, 0x0B, 0xB8, 0xB2]);
        // seg=2 朝下
        assert_eq!(
            encode_single_bend_command(2, false, 0.0).expect("bend"),
            vec![0xAA, 0x40, 0x04, 0x02, 0x01, 0x00, 0x00, 0xF1]
        );
        assert_eq!(
            encode_single_bend_command(3, true, 10.0),
            Err(ProtocolError::ValueOutOfRange("segment")),
        );

        let balance = encode_balance_calibration(2.0).expect("balance");
        assert_eq!(balance, vec![0xAA, 0x50, 0x02, 0x00, 0xC8, 0xC4]);
    }

    #[test]
    fn encodes_active_control_tick_in_action_group() {
        // 0x4_ 动作组：0x40 单段弯曲 / 0x41 主动控制 tick
        let frame = encode_active_control_command().expect("active control");
        assert_eq!(frame, vec![0xAA, 0x41, 0x00, 0xEB]);
        assert_eq!(
            function::SINGLE_BEND & 0xF0,
            function::ACTIVE_CONTROL & 0xF0,
            "主动控制必须与单段弯曲同属 0x4_ 动作组"
        );
    }

    // ─────────────────────── 上行帧解析 ───────────────────────

    #[test]
    fn parses_v2_status_frame_with_device_header() {
        let frame = v2_status_frame();
        assert_eq!(frame[0], MAGIC_UP_V2);
        assert_eq!(frame[1], DEV_DRIVE);
        assert_eq!(frame[2], 0x00);
        assert_eq!(frame[3] as usize, 2 + 2 * 7 + 2 * 4 + 2 + 2 + 1);

        let mut parser = FrameParser::new();
        match push_one(&mut parser, &frame).expect("status") {
            UpMessage::Status(status) => assert_eq!(status, sample_status()),
            other => panic!("期望状态帧，实际 {other:?}"),
        }
    }

    #[test]
    fn parses_legacy_v1_status_frame() {
        let frame = v1_status_frame();
        assert_eq!(frame[0], MAGIC_UP_V1);
        assert_eq!(frame[1], 0x02);

        let mut parser = FrameParser::new();
        match push_one(&mut parser, &frame).expect("status") {
            UpMessage::Status(status) => assert_eq!(status, sample_status()),
            other => panic!("期望状态帧，实际 {other:?}"),
        }
    }

    #[test]
    fn parses_handshake_ack_frame() {
        // 指令集 3.3：`55 00 00 04 <ver> <motor_n> <sensor_n> <flags> <SUM>`
        let frame = [0x55, 0x00, 0x00, 0x04, 0x02, 0x06, 0x06, 0x00, 0x67];
        let mut parser = FrameParser::new();
        match push_one(&mut parser, &frame).expect("handshake") {
            UpMessage::Handshake(ack) => {
                assert_eq!(
                    ack,
                    HandshakeAck {
                        version: 2,
                        motor_count: 6,
                        sensor_count: 6,
                        flags: 0,
                    }
                );
            }
            other => panic!("期望握手应答，实际 {other:?}"),
        }
    }

    /// 造一帧张力感知帧（数据段 50 字节）。
    fn tension_frame_bytes() -> Vec<u8> {
        let mut data = Vec::with_capacity(50);
        data.push(1); // 接触标志
        data.push(1); // 接触主导段
        data.extend_from_slice(&5000i16.to_be_bytes()); // s_norm 0.5
        data.extend_from_slice(&2500i16.to_be_bytes()); // 干扰指标 0.25
        data.extend_from_slice(&1000i16.to_be_bytes()); // F_seg[0] 0.1
        data.extend_from_slice(&(-2000i16).to_be_bytes()); // F_seg[1] -0.2
        data.extend_from_slice(&1234i16.to_be_bytes()); // F_mag 12.34 N
        data.extend_from_slice(&[0, 1, 2, 3, 4, 0]); // health[6]
        for value in [100i16, -100, 200, -200, 300, -300] {
            data.extend_from_slice(&value.to_be_bytes()); // share_err[6]
        }
        for value in [123i16, 456, 789, -123, -456, -789] {
            data.extend_from_slice(&value.to_be_bytes()); // force[6]
        }
        data.extend_from_slice(&[100, 98, 102, 95, 100, 105]); // balance_gain[6]
        data.push(2); // calib_status = 成功
        data.push(6); // calib_error = 电机未到位
        assert_eq!(data.len(), 50);

        let mut frame = vec![MAGIC_UP_V2, DEV_TENSION, 0x00, 50];
        frame.extend_from_slice(&data);
        frame.push(checksum(&frame));
        frame
    }

    #[test]
    fn parses_tension_frame() {
        let mut parser = FrameParser::new();
        match push_one(&mut parser, &tension_frame_bytes()).expect("tension") {
            UpMessage::Tension(tension) => {
                assert!(tension.contact);
                assert_eq!(tension.contact_segment, 1);
                assert_eq!(tension.s_norm, 0.5);
                assert_eq!(tension.disturbance, 0.25);
                assert_eq!(tension.f_seg, [0.1, -0.2]);
                assert_eq!(tension.f_mag, 12.34);
                assert_eq!(tension.health, [0, 1, 2, 3, 4, 0]);
                assert_eq!(tension.health[1], 1);
                assert_eq!(health_label(tension.health[1]), "松弛/打滑");
                assert_eq!(tension.share_err[0], 0.01);
                assert_eq!(tension.share_err[5], -0.03);
                assert_eq!(tension.force[0], 1.23);
                assert_eq!(tension.force[5], -7.89);
                assert_eq!(tension.balance_gain[1], 0.98);
                assert_eq!(tension.balance_gain[5], 1.05);
                assert_eq!(calib_status_label(tension.calib_status), "成功");
                assert_eq!(calib_error_label(tension.calib_error), "电机未到位");
            }
            other => panic!("期望张力感知帧，实际 {other:?}"),
        }
    }

    #[test]
    fn parses_calibration_event_frame() {
        // `55 03 00 03 <stage> <err> <mask> <SUM>`
        let mut frame = vec![MAGIC_UP_V2, DEV_CALIB, 0x00, 0x03, 2, 6, 0b0010_0100];
        frame.push(checksum(&frame));

        let mut parser = FrameParser::new();
        match push_one(&mut parser, &frame).expect("calib") {
            UpMessage::Calibration(event) => {
                assert_eq!(event.stage, 2);
                assert_eq!(calib_stage_label(event.stage), "POST_MOVE");
                assert_eq!(event.error, 6);
                assert_eq!(event.pending_motors(), vec![3, 6]);
            }
            other => panic!("期望标定事件帧，实际 {other:?}"),
        }
    }

    #[test]
    fn parser_handles_fragmented_frames() {
        let frame = v2_status_frame();
        let mut parser = FrameParser::new();

        assert!(parser.push_bytes(&frame[..8]).is_empty());
        assert!(parser.push_bytes(&frame[8..frame.len() - 3]).is_empty());
        let decoded = parser.push_bytes(&frame[frame.len() - 3..]);

        assert_eq!(decoded.len(), 1);
        assert!(decoded[0].is_ok());
    }

    #[test]
    fn parser_resynchronizes_after_bad_checksum() {
        let mut bad = v2_status_frame();
        let last = bad.len() - 1;
        bad[last] = bad[last].wrapping_add(1);

        let mut input = bad;
        input.extend_from_slice(&v2_status_frame());

        let mut parser = FrameParser::new();
        let decoded = parser.push_bytes(&input);

        assert!(decoded.len() >= 2);
        assert_eq!(decoded[0], Err(ProtocolError::InvalidChecksum));
        assert!(decoded.last().expect("last").is_ok());
    }

    #[test]
    fn parser_skips_leading_noise() {
        let mut input = vec![0x00, 0x13, 0x37, 0xFF, 0xAA];
        input.extend_from_slice(&v2_status_frame());

        let mut parser = FrameParser::new();
        let decoded = parser.push_bytes(&input);

        assert_eq!(decoded.len(), 1);
        assert!(decoded[0].is_ok());
    }

    #[test]
    fn parser_handles_mixed_v1_and_v2_stream() {
        // 协商切换的瞬间两种帧头会同时出现。
        let mut input = v1_status_frame();
        input.extend_from_slice(&v2_status_frame());
        input.extend_from_slice(&tension_frame_bytes());

        let mut parser = FrameParser::new();
        let decoded = parser.push_bytes(&input);

        assert_eq!(decoded.len(), 3);
        assert!(matches!(decoded[0], Ok(UpMessage::Status(_))));
        assert!(matches!(decoded[1], Ok(UpMessage::Status(_))));
        assert!(matches!(decoded[2], Ok(UpMessage::Tension(_))));
    }

    #[test]
    fn parser_reports_unknown_device_as_unknown_frame() {
        // 预留设备 0x04（IMU）不应被判成解析错误。
        let mut frame = vec![MAGIC_UP_V2, 0x04, 0x00, 0x02, 0xAB, 0xCD];
        frame.push(checksum(&frame));

        let mut parser = FrameParser::new();
        match push_one(&mut parser, &frame).expect("unknown") {
            UpMessage::Unknown(raw) => {
                assert_eq!(raw.version, 2);
                assert_eq!(raw.device, 0x04);
                assert_eq!(raw.data, vec![0xAB, 0xCD]);
            }
            other => panic!("期望未知帧，实际 {other:?}"),
        }
    }

    #[test]
    fn dev_sys_frames_other_than_handshake_are_not_protocol_errors() {
        // 指令集 3.2：DEV_SYS 还承载「通用 ACK / 错误告警」，功能码不一定是 0x00。
        // 这类帧必须落成 Unknown（预留），不能因为长度不是 4 就被当成握手应答去解 ——
        // 那样一个正常的系统告警会把整个设备判成协议错误。
        let mut frame = vec![MAGIC_UP_V2, DEV_SYS, 0x01, 0x03, 0xAA, 0x01, 0x02];
        frame.push(checksum(&frame));

        let mut parser = FrameParser::new();
        match push_one(&mut parser, &frame).expect("dev sys") {
            UpMessage::Unknown(raw) => {
                assert_eq!(raw.device, DEV_SYS);
                assert_eq!(raw.function, 0x01);
                assert_eq!(raw.data, vec![0xAA, 0x01, 0x02]);
            }
            other => panic!("期望未知帧，实际 {other:?}"),
        }
    }

    #[test]
    fn parser_rejects_wrong_length_status_payload() {
        // 声明 LEN=85，但数据段只有 3 字节 → 长度自洽但内容不合法。
        let mut frame = vec![MAGIC_UP_V2, DEV_TENSION, 0x00, 0x03, 1, 2, 3];
        frame.push(checksum(&frame));

        let mut parser = FrameParser::new();
        assert_eq!(
            push_one(&mut parser, &frame),
            Err(ProtocolError::InvalidLength)
        );
    }

    #[test]
    fn decodes_legacy_six_byte_sensor_stride_too() {
        // 旧固件每路传感器是 6 字节（x/y/z）。解析侧**两种步长都必须能吃**，
        // 否则固件换代时上位机得同步升级，中间必然有一段时间对不上 ——
        // 实测踩到过：固件改成 4 字节后整帧被判 InvalidLength 直接丢弃。
        let mut data = vec![1u8, 1u8]; // 1 电机 / 1 传感器
        data.extend_from_slice(&100i16.to_be_bytes()); // pos = 1.00
        data.extend_from_slice(&0i16.to_be_bytes()); // vel
        data.extend_from_slice(&0i16.to_be_bytes()); // acc
        data.push(0); // motor state
        data.extend_from_slice(&150i16.to_be_bytes()); // x = 1.50
        data.extend_from_slice(&250i16.to_be_bytes()); // y = 2.50
        data.extend_from_slice(&999i16.to_be_bytes()); // z —— 旧格式保留位，应被忽略
        data.extend_from_slice(&0i16.to_be_bytes()); // scale
        data.extend_from_slice(&0i16.to_be_bytes()); // armbend
        data.push(1); // system state

        let got = DeviceStatus::decode(&data).expect("旧步长也必须能解");
        assert_eq!(got.num_sensors, 1);
        assert_eq!(got.sensors, vec![SensorData { x: 1.5, y: 2.5 }]);
        assert_eq!(got.system_state, 1);
        assert_eq!(got.scale, 0.0);
    }

    #[test]
    fn status_frame_round_trips_through_both_versions() {
        for version in [ProtocolVersion::V1, ProtocolVersion::V2] {
            let encoded = encode_status_frame(&sample_status(), version).expect("encode");
            let mut parser = FrameParser::new();
            match push_one(&mut parser, &encoded).expect("decode") {
                UpMessage::Status(status) => assert_eq!(status, sample_status(), "{version:?}"),
                other => panic!("期望状态帧，实际 {other:?}"),
            }
        }
    }

    #[test]
    fn status_frame_reports_expected_v2_total_length() {
        // 指令集 5.1：V2 总长 90（85 + 5），V1 总长 89（85 + 4）。
        let mut status = sample_status();
        status.num_motors = 6;
        status.num_sensors = 6;
        status.motors = (0..6)
            .map(|index| MotorData {
                position_mm: index as f64,
                velocity_mm_per_sec: 0.0,
                acceleration_mm_per_sec2: 0.0,
                status: 0,
            })
            .collect();
        status.sensors = (0..6).map(|_| SensorData { x: 0.0, y: 0.0 }).collect();

        // 6 电机 + 6 传感器、每路 4 字节 → 数据段 73，V2 总长 78 / V1 总长 77
        assert_eq!(
            encode_status_frame(&status, ProtocolVersion::V2)
                .expect("v2")
                .len(),
            78
        );
        assert_eq!(
            encode_status_frame(&status, ProtocolVersion::V1)
                .expect("v1")
                .len(),
            77
        );
    }
}
