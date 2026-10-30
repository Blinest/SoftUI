/*
 * SoftUI 前端协议编解码（上下位机通信协议 · V1 legacy + V2）
 *
 * 逐字对齐 src-tauri/src/protocol.rs，目的是把**遥测解析**放在串口所在的那台浏览器上：
 * 本机自己解析、自己渲染，不再把原始字节推给服务器、也不再把解析结果拉回来
 * （实测那条路的下行是 0.8 MB/s，且字节一旦在链路上被截断就整帧校验失败）。
 *
 * 两边的编解码与容错行为必须逐条对齐 —— 改一边务必同步另一边。
 *
 * 帧格式（多字节一律大端，SUM = 前面所有字节之和 & 0xFF）：
 *   下行 (上位机 → 下位机)   [0xAA][功能码][LEN][数据段 LEN 字节][SUM]      共 4+LEN
 *   上行 V2                 [0x55][设备ID][功能码][LEN][数据段][SUM]       共 5+LEN
 *   上行 V1 (legacy)        [0xBB][功能码][LEN][数据段][SUM]               共 4+LEN
 *
 * 本文件是 ESM（测试要 import），浏览器版由 serve/server.mjs 按需转译成全局脚本
 * （只去掉行首 export、包一层 IIFE 挂到 window.__SOFTUI_PROTOCOL__），
 * 所以永远只有一个真源，不会出现两份文件各自漂移。
 */

export const MAGIC_DOWN = 0xaa;
export const MAGIC_UP_V1 = 0xbb;
export const MAGIC_UP_V2 = 0x55;

export const DEV_SYS = 0x00;
export const DEV_DRIVE = 0x01;
export const DEV_TENSION = 0x02;
export const DEV_CALIB = 0x03;

/** 下行功能码。V1 的 0x03~0x08 只是过渡兼容，新代码一律用 0x10 起的分组功能码。 */
export const FUNCTION = {
  MOTOR_DISABLE: 0x00,
  MOTOR_ENABLE: 0x01,
  MOTOR_STOP: 0x02,
  SYS_HANDSHAKE: 0x09,

  MOTOR_SINGLE: 0x10,
  MOTOR_SYNC: 0x11,
  MOTOR_CUSTOM: 0x12,
  MOTOR_DEMO: 0x13,

  SENSOR_INIT: 0x20,
  SENSOR_READ: 0x21,
  SENSOR_READ_ALL: 0x22,
  SENSOR_CAL: 0x23,
  PERCEPT_ZERO: 0x24,

  SET_MOUNT: 0x30,
  GRAV_COMP: 0x31,

  SINGLE_BEND: 0x40,
  ACTIVE_CONTROL: 0x41,

  BALANCE_CALIB: 0x50,
};

/** 统一缩放约定。写侧用 round，避免 -4.56 * 100 = -455.999… 被截断丢 1。 */
export const SCALE = {
  LINEAR: 100, // 位移 / 速度 / 张力 / 角度
  VECTOR: 1000, // 单位向量 / 增益
  RATIO: 10000, // 无量纲比例 / 份额误差
  WEIGHT: 10, // 砝码质量（克）
};

/** 解析错误类型：与 Rust 的 ProtocolError 一一对应，便于对照日志。 */
export const ProtocolError = {
  InvalidHeader: "InvalidHeader",
  InvalidLength: "InvalidLength",
  InvalidChecksum: "InvalidChecksum",
  ValueOutOfRange: "ValueOutOfRange",
};

/** 除自身外所有字节的 u8 环绕求和。 */
export function checksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    sum = (sum + bytes[i]) & 0xff;
  }
  return sum;
}

// ────────────────────────────── 下行帧构造 ──────────────────────────────

/** 封装一帧下行指令：`AA 功能码 LEN 数据段 SUM`。 */
export function buildDownFrame(func, data = []) {
  if (data.length > 255) throw ProtocolError.InvalidLength;
  const frame = [MAGIC_DOWN, func & 0xff, data.length];
  for (let i = 0; i < data.length; i += 1) frame.push(data[i] & 0xff);
  frame.push(checksum(frame));
  return frame;
}

function toI16(value, factor) {
  if (!Number.isFinite(value)) throw ProtocolError.ValueOutOfRange;
  const scaled = Math.round(value * factor); // 与 Rust 一致：round 而非 trunc
  if (scaled < -32768 || scaled > 32767) throw ProtocolError.ValueOutOfRange;
  return scaled < 0 ? scaled + 0x10000 : scaled;
}

function toU16(value, factor) {
  if (!Number.isFinite(value) || value < 0) throw ProtocolError.ValueOutOfRange;
  const scaled = Math.round(value * factor);
  if (scaled > 65535) throw ProtocolError.ValueOutOfRange;
  return scaled;
}

function be16(value) {
  return [(value >> 8) & 0xff, value & 0xff];
}

/** 协议版本协商（0x09）。`clientVer >= 2` 时下位机切 V2 上行并立即回握手应答。 */
export function encodeVersionNegotiation(clientVer) {
  return buildDownFrame(FUNCTION.SYS_HANDSHAKE, [clientVer & 0xff]);
}

/**
 * 单电机定位（0x10，V1 为 0x03）。
 * `addr dir dist(2) vel(2)` —— **没有加速度字段**，数据段就是 6 字节。
 */
export function encodeMotorCommand(motorId, positionMm, velocityMmPerSec) {
  if (!Number.isFinite(positionMm) || !Number.isFinite(velocityMmPerSec)) {
    throw ProtocolError.ValueOutOfRange;
  }
  const direction = positionMm >= 0 ? 0 : 1;
  const data = [motorId & 0xff, direction];
  data.push(...be16(toU16(Math.abs(positionMm), SCALE.LINEAR)));
  data.push(...be16(toU16(Math.abs(velocityMmPerSec), SCALE.LINEAR)));
  return buildDownFrame(FUNCTION.MOTOR_SINGLE, data);
}

/** 多电机同步位移（0x11，V1 为 0x04）。位移带符号，速度由下位机按比例分配。 */
export function encodeMultiMotorCommand(startAddress, positionsMm) {
  const data = [positionsMm.length & 0xff, startAddress & 0xff];
  for (const position of positionsMm) {
    data.push(...be16(toI16(position, SCALE.LINEAR)));
  }
  return buildDownFrame(FUNCTION.MOTOR_SYNC, data);
}

/** 一键归中：全部位移为 0 的 0x11 特例。 */
export function encodeHomeCommand(motorCount, startAddress) {
  return encodeMultiMotorCommand(startAddress, new Array(motorCount).fill(0));
}

/** 多电机自定义（0x12）。`items = [[addr, dir, distMm], ...]`，1~6 路。 */
export function encodeCustomMotorCommand(items) {
  const data = [items.length & 0xff];
  for (const [address, direction, distanceMm] of items) {
    data.push(address & 0xff, direction & 0x01);
    data.push(...be16(toU16(Math.abs(distanceMm), SCALE.LINEAR)));
  }
  return buildDownFrame(FUNCTION.MOTOR_CUSTOM, data);
}

/** 动作组演示（0x13，V1 为 0x05），无数据段。 */
export function encodeDemoCommand() {
  return buildDownFrame(FUNCTION.MOTOR_DEMO);
}

/** 传感器初始化（0x20）。 */
export function encodeSensorInit() {
  return buildDownFrame(FUNCTION.SENSOR_INIT);
}

/** 单通道读取（0x21）。 */
export function encodeSensorRead(sensorId) {
  return buildDownFrame(FUNCTION.SENSOR_READ, [sensorId & 0xff]);
}

/** 全通道读取（0x22）。 */
export function encodeSensorReadAll() {
  return buildDownFrame(FUNCTION.SENSOR_READ_ALL);
}

/** 砝码校准（0x23）。`weightG` 单位**克**，下位机收 g×10。 */
export function encodeSensorCalibration(sensorId, weightG) {
  const data = [sensorId & 0xff];
  data.push(...be16(toU16(weightG, SCALE.WEIGHT)));
  return buildDownFrame(FUNCTION.SENSOR_CAL, data);
}

/** 感知零点标定（0x24）。臂体自由无接触时执行。 */
export function encodePerceptZero() {
  return buildDownFrame(FUNCTION.PERCEPT_ZERO);
}

/** 设置安装方向（0x30，V1 为 0x07）。单位向量 ×1000。 */
export function encodeSetMountDirection(direction) {
  const data = [];
  for (const component of direction) {
    data.push(...be16(toI16(component, SCALE.VECTOR)));
  }
  return buildDownFrame(FUNCTION.SET_MOUNT, data);
}

/** 设置重力补偿增益（0x31，V1 为 0x08）。0 = 关闭，1 = 理论全额。 */
export function encodeGravityCompensation(gain) {
  return buildDownFrame(FUNCTION.GRAV_COMP, be16(toI16(gain, SCALE.VECTOR)));
}

/** 单段弯曲（0x40）。`segment` ∈ {1, 2}；`up` 为 true 表示朝上（dir=0）。 */
export function encodeSingleBendCommand(segment, up, angleDeg) {
  if (segment !== 1 && segment !== 2) throw ProtocolError.ValueOutOfRange;
  const data = [segment, up ? 0 : 1];
  data.push(...be16(toU16(Math.abs(angleDeg), SCALE.LINEAR)));
  return buildDownFrame(FUNCTION.SINGLE_BEND, data);
}

/**
 * 主动控制 tick（0x41，`0x4_` 动作组）。无数据段。
 *
 * 语义是「走一步主动控制回路」，因此可以高频重复下发；开启主动控制时按控制周期发，
 * 停止时不再发即可，下位机不需要单独的模式切换命令。
 */
export function encodeActiveControlCommand() {
  return buildDownFrame(FUNCTION.ACTIVE_CONTROL);
}

/** 触发通道平衡标定（0x50，预留）。`pullMm` ×0.01mm。 */
export function encodeBalanceCalibration(pullMm) {
  return buildDownFrame(FUNCTION.BALANCE_CALIB, be16(toI16(pullMm, SCALE.LINEAR)));
}

// ────────────────────────────── 上行帧解码 ──────────────────────────────

function readI16(data, offsetRef) {
  if (offsetRef.value + 2 > data.length) {
    throw ProtocolError.InvalidLength;
  }
  const value = (data[offsetRef.value] << 8) | data[offsetRef.value + 1];
  offsetRef.value += 2;
  // 还原成有符号：JS 的位运算得到的是补码无符号视图
  return value >= 0x8000 ? value - 0x10000 : value;
}

/**
 * 系统状态帧数据段（85 字节）。
 *
 * 每路「传感器」其实是**一路压力通道**，不是三轴传感器，而且只有两个数：
 *   x = 实际值（未经滤波的读数）；y = 滤波值
 * 每路 4 字节；旧固件是 6 字节（多一个保留位 z），解析侧两种都接受。
 */
export function decodeStatus(data) {
  if (data.length < 5) throw ProtocolError.InvalidLength;
  const numMotors = data[0];
  const numSensors = data[1];
  // 传感器每路的字节数随固件版本不同：新版 4（x/y），旧版 6（x/y/z）。
  // 用帧内**声明的**传感器数量各算一遍，哪个对上用哪个 —— 两种步长都用同一个 m，
  // 长度必然不同，所以不会歧义。
  const base = 2 + numMotors * 7 + 2 + 2 + 1;
  let perSensor;
  if (data.length === base + numSensors * 4) perSensor = 4;
  else if (data.length === base + numSensors * 6) perSensor = 6;
  else throw ProtocolError.InvalidLength;

  const offsetRef = { value: 2 };
  const motors = [];
  for (let i = 0; i < numMotors; i += 1) {
    motors.push({
      positionMm: readI16(data, offsetRef) / SCALE.LINEAR,
      velocityMmPerSec: readI16(data, offsetRef) / SCALE.LINEAR,
      accelerationMmPerSec2: readI16(data, offsetRef) / SCALE.LINEAR,
      status: data[offsetRef.value++],
    });
  }

  const sensors = [];
  for (let i = 0; i < numSensors; i += 1) {
    const x = readI16(data, offsetRef) / SCALE.LINEAR;
    const y = readI16(data, offsetRef) / SCALE.LINEAR;
    if (perSensor === 6) readI16(data, offsetRef); // 旧格式的保留位，读掉不用
    sensors.push({ x, y });
  }

  const bendAngle1Deg = readI16(data, offsetRef) / SCALE.LINEAR;
  const bendAngle2Deg = readI16(data, offsetRef) / SCALE.LINEAR;
  const systemState = data[offsetRef.value++];

  if (offsetRef.value !== data.length) throw ProtocolError.InvalidLength;

  return { numMotors, numSensors, motors, sensors, bendAngle1Deg, bendAngle2Deg, systemState };
}

/** 标定事件帧数据段（3 字节）。 */
export function decodeCalibration(data) {
  if (data.length !== 3) throw ProtocolError.InvalidLength;
  const mask = data[2];
  const pendingMotors = [];
  for (let bit = 0; bit < 8; bit += 1) {
    if ((mask >> bit) & 1) pendingMotors.push(bit + 1);
  }
  return { stage: data[0], error: data[1], mask, pendingMotors };
}

/** 握手应答数据段（4 字节）：`ver motorN sensorN flags`。 */
export function decodeHandshake(data) {
  if (data.length !== 4) throw ProtocolError.InvalidLength;
  return {
    version: data[0],
    motorCount: data[1],
    sensorCount: data[2],
    flags: data[3],
  };
}

/**
 * 按「版本 + 设备 ID / 功能码」把数据段解成具体报文。
 * 新增设备只需在这里加一条分支，解析内核不用动。
 */
export function decodeUpFrame(version, device, func, data) {
  if (version === 2) {
    if (device === DEV_SYS) return { kind: "handshake", ...decodeHandshake(data) };
    if (device === DEV_DRIVE) return { kind: "status", ...decodeStatus(data) };
    if (device === DEV_CALIB) return { kind: "calibration", ...decodeCalibration(data) };
  } else {
    if (func === 0x02) return { kind: "status", ...decodeStatus(data) };
    if (func === 0x04) return { kind: "calibration", ...decodeCalibration(data) };
  }
  return { kind: "unknown", version, device, func, data: Array.from(data) };
}

/** 解析一整帧（自动识别 V1 / V2）。生产路径用 FrameParser，这个主要给测试与调试用。 */
export function parseUpFrame(frame) {
  if (frame.length < 4) throw ProtocolError.InvalidHeader;
  const magic = frame[0];
  const headerLen = magic === MAGIC_UP_V1 ? 3 : magic === MAGIC_UP_V2 ? 4 : 0;
  if (headerLen === 0) throw ProtocolError.InvalidHeader;

  const version = magic === MAGIC_UP_V2 ? 2 : 1;
  const device = version === 2 ? frame[1] : DEV_SYS;
  const func = version === 2 ? frame[2] : frame[1];
  const len = version === 2 ? frame[3] : frame[2];
  if (frame.length !== headerLen + len + 1) throw ProtocolError.InvalidLength;
  if (checksum(frame.slice(0, frame.length - 1)) !== frame[frame.length - 1]) {
    throw ProtocolError.InvalidChecksum;
  }
  return decodeUpFrame(version, device, func, frame.slice(headerLen, frame.length - 1));
}

/** 兼容旧调用点：解析一帧状态帧，直接返回状态对象。 */
export function parseStatusFrame(frame) {
  const message = parseUpFrame(frame);
  if (message.kind !== "status") throw ProtocolError.InvalidHeader;
  return message;
}

/** 编码一帧状态帧。生产路径用不到，但测试要靠它做往返校验。 */
export function encodeStatusFrame(status, version = 2) {
  const dataLen = 2 + status.motors.length * 7 + status.sensors.length * 4 + 2 + 2 + 1;
  if (dataLen > 255) throw ProtocolError.InvalidLength;
  const out =
    version === 1
      ? [MAGIC_UP_V1, 0x02, dataLen]
      : [MAGIC_UP_V2, DEV_DRIVE, 0x00, dataLen];
  out.push(status.motors.length, status.sensors.length);

  const pushI16 = (value) => out.push(...be16(toI16(value, SCALE.LINEAR)));
  for (const motor of status.motors) {
    pushI16(motor.positionMm);
    pushI16(motor.velocityMmPerSec);
    pushI16(motor.accelerationMmPerSec2);
    out.push(motor.status & 0xff);
  }
  for (const sensor of status.sensors) {
    pushI16(sensor.x);
    pushI16(sensor.y);
  }
  pushI16(status.bendAngle1Deg);
  pushI16(status.bendAngle2Deg);
  out.push(status.systemState & 0xff);
  out.push(checksum(out));
  return Uint8Array.from(out);
}

// ────────────────────────────── 文案映射 ──────────────────────────────

export function healthLabel(code) {
  return { 0: "正常", 1: "松弛/打滑", 2: "断丝/掉线", 3: "过张", 4: "过载" }[code] ?? "未知";
}

export function calibStatusLabel(code) {
  return { 0: "未运行", 1: "进行中", 2: "成功", 3: "失败" }[code] ?? "未知";
}

export function calibStageLabel(code) {
  return { 1: "PRE_SETTLE", 2: "POST_MOVE", 3: "POST_SETTLE" }[code] ?? "未知";
}

export function calibErrorLabel(code) {
  return {
    0: "无",
    1: "标定被禁用",
    2: "电机无响应",
    3: "Δτ 过小",
    4: "Δτ 为负（方向反）",
    5: "离散度过大",
    6: "电机未到位",
    7: "信号始终未稳定",
  }[code] ?? "未知";
}

// ────────────────────────────── 流式解码 ──────────────────────────────

const MAX_BUFFER = 4096;
const KEEP_TAIL = 2048;

/**
 * 流式解码器：把串口来的零散字节攒成完整报文。
 *
 * 容错策略（与指令集「帧头同步 + 长度收帧 + 校验」一致，也与 Rust 的 FrameParser 逐条对齐）：
 *   - 逐字节找帧头（0xBB 或 0x55），找到才认，所以丢字节后能自动重新对齐
 *   - 校验和错时**只前进 1 字节**（继续找下一个帧头），而不是整帧跳过 ——
 *     这一帧很可能是噪声里的假帧头，整帧跳过会把真正的帧头一起吃掉，导致后面连续错位
 *   - 缓冲上限 4096，超出保留尾部 2048
 *
 * V1 与 V2 可以混流（下位机协商切换的瞬间就会同时出现两种）。
 */
export class FrameParser {
  constructor() {
    this.buffer = [];
    this._lastVersion = 1;
  }

  /** 最近一帧成功解出的协议版本（1 = V1，2 = V2）。 */
  lastVersion() {
    return this._lastVersion;
  }

  /**
   * 喂入一段字节，返回 `[{ok: message} | {error: string}]`。
   * `message.kind` 为 "status" / "tension" / "calibration" / "handshake" / "unknown"。
   */
  pushBytes(input) {
    for (let i = 0; i < input.length; i += 1) {
      this.buffer.push(input[i] & 0xff);
    }
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer.splice(0, this.buffer.length - KEEP_TAIL);
    }

    const decoded = [];
    let index = 0;

    for (;;) {
      // ① 找帧头
      while (
        index < this.buffer.length &&
        this.buffer[index] !== MAGIC_UP_V1 &&
        this.buffer[index] !== MAGIC_UP_V2
      ) {
        index += 1;
      }
      if (index >= this.buffer.length) break;

      // ② 头部长度：V1 三字节，V2 四字节
      const magic = this.buffer[index];
      const headerLen = magic === MAGIC_UP_V1 ? 3 : 4;
      if (index + headerLen > this.buffer.length) break; // 帧头还没收齐

      const version = magic === MAGIC_UP_V2 ? 2 : 1;
      const device = version === 2 ? this.buffer[index + 1] : DEV_SYS;
      const func = version === 2 ? this.buffer[index + 2] : this.buffer[index + 1];
      const dataLen = version === 2 ? this.buffer[index + 3] : this.buffer[index + 2];

      // ③ 整帧收齐？
      const totalLen = headerLen + dataLen + 1;
      if (index + totalLen > this.buffer.length) break;

      // 必须是 Uint8Array：decode* 内部按数组访问，普通数组也能用，
      // 但统一成 Uint8Array 与 Rust 的「帧是字节切片」语义一致。
      const raw = Uint8Array.from(this.buffer.slice(index, index + totalLen));

      // **严格校验**：累加和 & 0xFF ✓ —— 不做任何兼容 ✗（固件侧负责补齐真校验 ✓）
      if (checksum(raw.subarray(0, totalLen - 1)) !== raw[totalLen - 1]) {
        // 只前进 1 字节：这一帧可能是被截断后拼出来的假帧头，不能整帧跳过
        decoded.push({ error: ProtocolError.InvalidChecksum });
        index += 1;
        continue;
      }

      this._lastVersion = version;
      try {
        decoded.push({
          ok: decodeUpFrame(version, device, func, raw.subarray(headerLen, totalLen - 1)),
        });
        index += totalLen;
      } catch (error) {
        decoded.push({ error });
        index += totalLen;
      }
    }

    if (index > 0) {
      this.buffer.splice(0, index);
    }
    return decoded;
  }
}

/**
 * @deprecated 旧名字。它只认 `0xBB 02`，现在用 {@link FrameParser}（V1 + V2 混流）。
 * 保留是为了让老调用点不会因为改名而静默失效。
 */
export const LegacyV1Codec = FrameParser;
