/*
 * SoftUI 前端协议解析（Legacy V1）
 *
 * 逐字对齐 src-tauri/src/protocol.rs，目的是把**遥测解析**从后端搬到串口所在的那台
 * 浏览器上：本机自己解析、自己渲染，不再把原始字节推给服务器、也不再把解析结果拉回来
 * （实测那条路的下行是 0.8 MB/s，且字节一旦在链路上被截断就整帧校验失败）。
 *
 * 帧格式（与 Rust 侧完全一致）：
 *   [0xBB, 0x02, total_len, num_motors, num_sensors,
 *    <motor × 7B: pos i16, vel i16, acc i16, status u8>,
 *    <sensor × 6B: x i16, y i16, z i16>,
 *    bend1 i16, bend2 i16, system_state u8,
 *    checksum u8]
 *
 *   其中 total_len = 1 + 1 + motors*7 + sensors*6 + 2 + 2 + 1
 *   （从 num_motors 那一位算起、到 system_state 为止，不含尾部校验和）
 *   物理量一律 i16 大端、定点 ×100（写用 round，避免 -4.56 → -455.999 丢 1）
 *   校验和 = 除自身以外所有字节的 u8 环绕求和
 */

export const FRAME_HEAD = 0xbb;
export const FRAME_FUNCTION_STATUS = 0x02;

/** 解析错误类型：与 Rust 的 ProtocolError 一一对应，便于对照日志。 */
export const ProtocolError = {
  InvalidHeader: "InvalidHeader",
  InvalidLength: "InvalidLength",
  InvalidChecksum: "InvalidChecksum",
};

/** 除自身外所有字节的 u8 环绕求和。 */
export function checksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    sum = (sum + bytes[i]) & 0xff;
  }
  return sum;
}

function readI16(frame, offsetRef) {
  if (offsetRef.value + 2 > frame.length) {
    throw ProtocolError.InvalidLength;
  }
  const value = (frame[offsetRef.value] << 8) | frame[offsetRef.value + 1];
  offsetRef.value += 2;
  // 还原成有符号：JS 的位运算得到的是补码无符号视图
  return value >= 0x8000 ? value - 0x10000 : value;
}

/**
 * 解析一帧状态帧。返回 DeviceStatus 的 JS 形态：
 *   { numMotors, numSensors, motors:[{positionMm,velocityMmPerSec,accelerationMmPerSec2,status}],
 *     sensors:[{x,y,z}], bendAngle1Deg, bendAngle2Deg, systemState }
 */
export function parseStatusFrame(frame) {
  if (frame.length < 4 || frame[0] !== FRAME_HEAD || frame[1] !== FRAME_FUNCTION_STATUS) {
    throw ProtocolError.InvalidHeader;
  }

  const totalLen = frame[2];
  if (frame.length !== totalLen + 4) {
    throw ProtocolError.InvalidLength;
  }

  if (frame[frame.length - 1] !== checksum(frame.subarray(0, frame.length - 1))) {
    throw ProtocolError.InvalidChecksum;
  }

  const numMotors = frame[3];
  const numSensors = frame[4];
  const expectedDataLen = 1 + 1 + numMotors * 7 + numSensors * 6 + 2 + 2 + 1;
  if (totalLen !== expectedDataLen) {
    throw ProtocolError.InvalidLength;
  }

  const offsetRef = { value: 5 };
  const motors = [];
  for (let i = 0; i < numMotors; i += 1) {
    motors.push({
      positionMm: readI16(frame, offsetRef) / 100,
      velocityMmPerSec: readI16(frame, offsetRef) / 100,
      accelerationMmPerSec2: readI16(frame, offsetRef) / 100,
      status: frame[offsetRef.value++],
    });
  }

  const sensors = [];
  for (let i = 0; i < numSensors; i += 1) {
    sensors.push({
      x: readI16(frame, offsetRef) / 100,
      y: readI16(frame, offsetRef) / 100,
      z: readI16(frame, offsetRef) / 100,
    });
  }

  const bendAngle1Deg = readI16(frame, offsetRef) / 100;
  const bendAngle2Deg = readI16(frame, offsetRef) / 100;
  const systemState = frame[offsetRef.value++];

  if (offsetRef.value !== frame.length - 1) {
    throw ProtocolError.InvalidLength;
  }

  return { numMotors, numSensors, motors, sensors, bendAngle1Deg, bendAngle2Deg, systemState };
}

function scaledI16(value) {
  if (!Number.isFinite(value)) {
    throw "ValueOutOfRange";
  }
  const scaled = Math.round(value * 100); // 与 Rust 一致：round 而非 trunc
  if (scaled < -32768 || scaled > 32767) {
    throw "ValueOutOfRange";
  }
  return scaled < 0 ? scaled + 0x10000 : scaled;
}

/** 编码一帧状态帧。生产路径用不到，但测试要靠它做往返校验。 */
export function encodeStatusFrame(status) {
  const totalLen = 1 + 1 + status.motors.length * 7 + status.sensors.length * 6 + 2 + 2 + 1;
  if (totalLen > 255) {
    throw ProtocolError.InvalidLength;
  }
  const out = [FRAME_HEAD, FRAME_FUNCTION_STATUS, totalLen, status.motors.length, status.sensors.length];
  const pushI16 = (value) => {
    const v = scaledI16(value);
    out.push((v >> 8) & 0xff, v & 0xff);
  };
  for (const motor of status.motors) {
    pushI16(motor.positionMm);
    pushI16(motor.velocityMmPerSec);
    pushI16(motor.accelerationMmPerSec2);
    out.push(motor.status & 0xff);
  }
  for (const sensor of status.sensors) {
    pushI16(sensor.x);
    pushI16(sensor.y);
    pushI16(sensor.z);
  }
  pushI16(status.bendAngle1Deg);
  pushI16(status.bendAngle2Deg);
  out.push(status.systemState & 0xff);
  out.push(checksum(out));
  return new Uint8Array(out);
}

/**
 * 流式解码器：把串口来的零散字节攒成完整帧。
 *
 * 与 Rust 的 LegacyV1Codec 行为逐条对齐：
 *   - 逐字节找帧头 0xBB 0x02，找到才认；所以丢字节后能自动重新对齐
 *   - 校验和错时只前进 1 字节（继续找下一个帧头），而不是整帧跳过
 *   - 缓冲上限 4096，超出保留尾部 2048
 */
export class LegacyV1Codec {
  constructor() {
    this.buffer = [];
  }

  /** 喂入一段字节，返回 [{ok: status} | {error: string}]，与 Rust 的返回形态一致。 */
  pushBytes(input) {
    for (let i = 0; i < input.length; i += 1) {
      this.buffer.push(input[i]);
    }
    if (this.buffer.length > 4096) {
      this.buffer.splice(0, this.buffer.length - 2048);
    }

    const decoded = [];
    let index = 0;

    while (index + 3 <= this.buffer.length) {
      if (this.buffer[index] !== FRAME_HEAD || this.buffer[index + 1] !== FRAME_FUNCTION_STATUS) {
        index += 1;
        continue;
      }

      const totalLen = this.buffer[index + 2];
      const frameLen = totalLen + 4;
      if (index + frameLen > this.buffer.length) {
        break; // 帧还没到齐，等后续字节
      }

      // 必须是 Uint8Array：parseStatusFrame 用的是 subarray，
      // 普通数组没有这个方法，会抛 TypeError 而被误当成"未知协议错误"。
      const frame = Uint8Array.from(this.buffer.slice(index, index + frameLen));
      try {
        decoded.push({ ok: parseStatusFrame(frame) });
        index += frameLen;
      } catch (error) {
        if (error === ProtocolError.InvalidChecksum) {
          // 只前进 1 字节：这一帧可能是被截断后拼出来的假帧头，不能整帧跳过
          decoded.push({ error: ProtocolError.InvalidChecksum });
          index += 1;
        } else {
          decoded.push({ error });
          index += frameLen;
        }
      }
    }

    if (index > 0) {
      this.buffer.splice(0, index);
    }
    return decoded;
  }
}
