/*
 * serve/protocol.js 的回归测试。
 *
 * 运行：node serve/protocol.test.mjs
 *
 * 覆盖重点是**两端一致性**：这里断言的字节序列与 src-tauri/src/protocol.rs 的
 * 单元测试用的是同一批期望值，任何一边改动都会立刻对不上。
 */

import assert from "node:assert/strict";
import {
  checksum,
  FrameParser,
  ProtocolError,
  FUNCTION,
  MAGIC_UP_V1,
  MAGIC_UP_V2,
  DEV_DRIVE,
  DEV_TENSION,
  DEV_CALIB,
  encodeActiveControlCommand,
  encodeBalanceCalibration,
  encodeCustomMotorCommand,
  encodeGravityCompensation,
  encodeHomeCommand,
  encodeMotorCommand,
  encodeMultiMotorCommand,
  encodeSensorCalibration,
  encodeSingleBendCommand,
  encodeSetMountDirection,
  encodeStatusFrame,
  encodeVersionNegotiation,
  parseUpFrame,
} from "./protocol.js";

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error && error.message ? error.message : error}`);
  }
}

const hex = (bytes) => Array.from(bytes).map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
const be16 = (v) => [(v >> 8) & 0xff, v & 0xff];

function sampleStatus() {
  return {
    numMotors: 2,
    numSensors: 2,
    motors: [
      { positionMm: 12.34, velocityMmPerSec: -2.5, accelerationMmPerSec2: 1.0, status: 1 },
      { positionMm: -1.25, velocityMmPerSec: 8.5, accelerationMmPerSec2: 2.75, status: 0 },
    ],
    // 每路只有两个数：x = 实际值（未滤波），y = 滤波值；每路 4 字节
    sensors: [
      { x: 1.23, y: -4.56 },
      { x: 0.5, y: 0.25 },
    ],
    bendAngle1Deg: 12.5,
    bendAngle2Deg: -6.75,
    systemState: 1,
  };
}

function tensionFrame() {
  const data = [1, 1];
  data.push(...be16(5000)); // s_norm
  data.push(...be16(2500)); // 干扰指标
  data.push(...be16(1000)); // F_seg[0]
  data.push(...be16(-2000 + 0x10000)); // F_seg[1] = -2000
  data.push(...be16(1234)); // F_mag
  data.push(0, 1, 2, 3, 4, 0); // health
  for (const v of [100, -100, 200, -200, 300, -300]) data.push(...be16(v < 0 ? v + 0x10000 : v));
  for (const v of [123, 456, 789, -123, -456, -789]) data.push(...be16(v < 0 ? v + 0x10000 : v));
  data.push(100, 98, 102, 95, 100, 105);
  data.push(2, 6); // calib_status / calib_error
  assert.equal(data.length, 50);
  const frame = [MAGIC_UP_V2, DEV_TENSION, 0x00, 50, ...data];
  frame.push(checksum(frame));
  return frame;
}

function pushOne(parser, bytes) {
  const decoded = parser.pushBytes(bytes);
  assert.equal(decoded.length, 1, `期望恰好 1 个报文：${JSON.stringify(decoded)}`);
  return decoded[0];
}

// ─────────────────────────── 下行帧 ───────────────────────────

test("单电机定位是 6 字节数据段（无加速度）", () => {
  const frame = encodeMotorCommand(1, -7.0, 10.0);
  assert.equal(hex(frame), "AA 10 06 01 01 02 BC 03 E8 6B");
  assert.equal(frame[2], 6, "数据段必须是 6 字节");
});

test("多电机同步位移 0x11", () => {
  const frame = encodeMultiMotorCommand(1, [1.0, 0.0, -2.5]);
  assert.equal(hex(frame), "AA 11 08 03 01 00 64 00 00 FF 06 30");
});

test("一键归中等于全零的同步位移", () => {
  assert.deepEqual(encodeHomeCommand(2, 1), encodeMultiMotorCommand(1, [0.0, 0.0]));
});

test("多电机自定义 0x12", () => {
  const frame = encodeCustomMotorCommand([
    [1, 0, 1.0],
    [3, 1, 2.5],
  ]);
  assert.equal(hex(frame), "AA 12 09 02 01 00 00 64 03 01 00 FA 2A");
});

test("版本协商 0x09", () => {
  assert.equal(hex(encodeVersionNegotiation(2)), "AA 09 01 02 B6");
  assert.equal(hex(encodeVersionNegotiation(1)), "AA 09 01 01 B5");
});

test("砝码校准用 0xAA 下行帧头 + g×10", () => {
  const frame = encodeSensorCalibration(2, 500.0);
  assert.equal(hex(frame), "AA 23 03 02 13 88 6D");
  assert.equal(frame[0], 0xaa, "下行帧头必须是 0xAA");
  assert.equal((frame[4] << 8) | frame[5], 5000);
});

test("安装方向与重力补偿", () => {
  assert.equal(hex(encodeSetMountDirection([0, 0, 1])), "AA 30 06 00 00 00 00 03 E8 CB");
  assert.equal(hex(encodeSetMountDirection([1, 0, 0])), "AA 30 06 03 E8 00 00 00 00 CB");
  assert.equal(hex(encodeGravityCompensation(1.0)), "AA 31 02 03 E8 C8");
  assert.equal(hex(encodeGravityCompensation(0.0)), "AA 31 02 00 00 DD");
});

test("单段弯曲 0x40", () => {
  assert.equal(hex(encodeSingleBendCommand(1, true, 30.0)), "AA 40 04 01 00 0B B8 B2");
  assert.equal(hex(encodeSingleBendCommand(2, false, 0.0)), "AA 40 04 02 01 00 00 F1");
  assert.throws(() => encodeSingleBendCommand(3, true, 10), /ValueOutOfRange/);
});

test("通道平衡标定 0x50", () => {
  assert.equal(hex(encodeBalanceCalibration(2.0)), "AA 50 02 00 C8 C4");
});

test("主动控制 tick 在 0x4_ 动作组（0x41）", () => {
  const frame = encodeActiveControlCommand();
  assert.equal(hex(frame), "AA 41 00 EB");
  assert.equal(
    FUNCTION.SINGLE_BEND & 0xf0,
    FUNCTION.ACTIVE_CONTROL & 0xf0,
    "主动控制必须与单段弯曲同属 0x4_ 动作组",
  );
});

// ─────────────────────────── 上行解析 ───────────────────────────

test("V2 状态帧解析 + 设备头", () => {
  const frame = encodeStatusFrame(sampleStatus(), 2);
  assert.equal(frame[0], MAGIC_UP_V2);
  assert.equal(frame[1], DEV_DRIVE);
  const message = pushOne(new FrameParser(), frame).ok;
  assert.equal(message.kind, "status");
  assert.deepEqual(message.motors, sampleStatus().motors);
  assert.deepEqual(message.sensors, sampleStatus().sensors);
  assert.equal(message.bendAngle1Deg, 12.5);
  assert.equal(message.bendAngle2Deg, -6.75);
  assert.equal(message.systemState, 1);
});

test("旧固件的 6 字节传感器步长也能解（z 被忽略）", () => {
  // 固件从 6 字节/路改成 4 字节/路后，上位机若只认新步长，整帧会被判
  // InvalidLength 直接丢弃 —— 实测踩到过。两种步长都必须能吃。
  const data = [1, 1];                       // 1 电机 / 1 传感器
  data.push(...be16(100), ...be16(0), ...be16(0), 0);  // pos=1.00 vel=0 acc=0 state=0
  data.push(...be16(150), ...be16(250), ...be16(999)); // x=1.50 y=2.50 z=999（保留位）
  data.push(...be16(0), ...be16(0), 1);      // scale armbend state
  const frame = [MAGIC_UP_V2, DEV_DRIVE, 0x00, data.length, ...data];
  frame.push(checksum(frame));

  const message = pushOne(new FrameParser(), frame).ok;
  assert.equal(message.kind, "status");
  assert.deepEqual(message.sensors, [{ x: 1.5, y: 2.5 }]);
  assert.equal(message.systemState, 1);
});

test("V1 状态帧仍然可用", () => {
  const frame = encodeStatusFrame(sampleStatus(), 1);
  assert.equal(frame[0], MAGIC_UP_V1);
  assert.equal(frame[1], 0x02);
  const message = pushOne(new FrameParser(), frame).ok;
  assert.equal(message.kind, "status");
  assert.equal(message.numMotors, 2);
});

test("握手应答 55 00 00 04", () => {
  const frame = [0x55, 0x00, 0x00, 0x04, 0x02, 0x06, 0x06, 0x00, 0x67];
  const message = pushOne(new FrameParser(), frame).ok;
  assert.deepEqual(message, { kind: "handshake", version: 2, motorCount: 6, sensorCount: 6, flags: 0 });
});

test("张力感知帧解析", () => {
  const parser = new FrameParser();
  const message = pushOne(parser, tensionFrame()).ok;
  assert.equal(message.kind, "tension");
  assert.equal(message.contact, true);
  assert.equal(message.contactSegment, 1);
  assert.equal(message.sNorm, 0.5);
  assert.equal(message.disturbance, 0.25);
  assert.deepEqual(message.fSeg, [0.1, -0.2]);
  assert.equal(message.fMag, 12.34);
  assert.deepEqual(message.health, [0, 1, 2, 3, 4, 0]);
  assert.equal(message.shareErr[0], 0.01);
  assert.equal(message.shareErr[5], -0.03);
  assert.equal(message.force[0], 1.23);
  assert.equal(message.force[5], -7.89);
  assert.equal(message.balanceGain[1], 0.98);
  assert.equal(message.calibStatus, 2);
  assert.equal(message.calibError, 6);
  assert.equal(parser.lastVersion(), 2);
});

test("标定事件帧解析 + 位掩码展开", () => {
  const frame = [MAGIC_UP_V2, DEV_CALIB, 0x00, 0x03, 2, 6, 0b0010_0100];
  frame.push(checksum(frame));
  const message = pushOne(new FrameParser(), frame).ok;
  assert.equal(message.kind, "calibration");
  assert.equal(message.stage, 2);
  assert.equal(message.error, 6);
  assert.deepEqual(message.pendingMotors, [3, 6]);
});

test("分段喂入：帧没收齐前不吐报文", () => {
  const frame = encodeStatusFrame(sampleStatus(), 2);
  const parser = new FrameParser();
  assert.equal(parser.pushBytes(frame.subarray(0, 8)).length, 0);
  assert.equal(parser.pushBytes(frame.subarray(8, frame.length - 3)).length, 0);
  assert.equal(parser.pushBytes(frame.subarray(frame.length - 3)).length, 1);
});

test("校验错只前进 1 字节，后续帧仍能对齐", () => {
  const bad = encodeStatusFrame(sampleStatus(), 2);
  bad[bad.length - 1] = (bad[bad.length - 1] + 1) & 0xff;
  const input = new Uint8Array(bad.length * 2);
  input.set(bad, 0);
  input.set(encodeStatusFrame(sampleStatus(), 2), bad.length);

  const decoded = new FrameParser().pushBytes(input);
  assert.equal(decoded[0].error, ProtocolError.InvalidChecksum);
  assert.equal(decoded[decoded.length - 1].ok.kind, "status");
});

test("前导噪声被跳过", () => {
  const noise = [0x00, 0x13, 0x37, 0xff, 0xaa];
  const frame = encodeStatusFrame(sampleStatus(), 2);
  const input = new Uint8Array(noise.length + frame.length);
  input.set(noise, 0);
  input.set(frame, noise.length);
  const decoded = new FrameParser().pushBytes(input);
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].ok.kind, "status");
});

test("V1 与 V2 混流", () => {
  const v1 = encodeStatusFrame(sampleStatus(), 1);
  const v2 = encodeStatusFrame(sampleStatus(), 2);
  const tension = tensionFrame();
  const input = new Uint8Array(v1.length + v2.length + tension.length);
  input.set(v1, 0);
  input.set(v2, v1.length);
  input.set(tension, v1.length + v2.length);

  const decoded = new FrameParser().pushBytes(input);
  assert.equal(decoded.length, 3);
  assert.equal(decoded[0].ok.kind, "status");
  assert.equal(decoded[1].ok.kind, "status");
  assert.equal(decoded[2].ok.kind, "tension");
});

test("预留设备判为 unknown 而不是解析错误", () => {
  const frame = [MAGIC_UP_V2, 0x04, 0x00, 0x02, 0xab, 0xcd];
  frame.push(checksum(frame));
  const message = pushOne(new FrameParser(), frame).ok;
  assert.equal(message.kind, "unknown");
  assert.equal(message.device, 0x04);
  assert.deepEqual(message.data, [0xab, 0xcd]);
});

test("长度对不上时报错而不是硬解", () => {
  const frame = [MAGIC_UP_V2, DEV_TENSION, 0x00, 0x03, 1, 2, 3];
  frame.push(checksum(frame));
  assert.equal(pushOne(new FrameParser(), frame).error, ProtocolError.InvalidLength);
});

test("parseUpFrame 兼容旧调用点", () => {
  const frame = encodeStatusFrame(sampleStatus(), 1);
  assert.equal(parseUpFrame(frame).kind, "status");
  assert.throws(() => parseUpFrame(new Uint8Array([0x01, 0x02, 0x03, 0x04])), /InvalidHeader/);
});

// ───────────────────────────

if (failures.length > 0) {
  console.error(`protocol.js: ${failures.length} 项失败 / ${passed + failures.length} 项`);
  for (const failure of failures) console.error("  ✗ " + failure);
  process.exit(1);
}
console.log(`protocol.js: ${passed} 项全部通过`);
