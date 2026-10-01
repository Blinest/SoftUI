import { invoke } from "@tauri-apps/api/core";
import type { BackboneOutput } from "../dynamics/svcModel";

/**
 * 曲率 → 6 肌腱位移 → 0x04 多电机同步指令 的 UI 侧桥接。
 *
 * 数据流：
 * ```
 * 臂体拖拽 (CurvatureDragPreview / dynamics/curvatureDrag.ts)
 *      │  CurvatureDistribution / BackboneOutput
 *      ▼
 * sendCurvatureDragCommand(backbone)      ← 本文件
 *      │  invoke("send_curvature_command")
 *      ▼
 * Rust: kappatable::KappaTable::lookup        全阶 Cosserat 查表 (κ → ΔL)
 *      │  表外自动退回 curvature::kappa_to_motor_displacements_mm
 *      ▼
 * Rust: protocol::encode_multi_motor_command  (帧 AA 04 …)
 *      ▼
 * 串口下发
 * ```
 */

export interface CurvatureCommandOptions {
  deviceId?: string;
  /** 起始电机地址（1 基），默认 1。 */
  startAddress?: number;
  /** 全阶 Cosserat 查表档位（张力上限 N）：40 或 60，默认 60。 */
  tableGaugeN?: 40 | 60;
}

/**
 * 低层入口：直接给两段「曲率大小 + 方向」。
 *
 * @param segmentCurvaturePerM 两段曲率 κ（1/m）
 * @param segmentDirectionRad  两段弯曲方向 φ（rad）
 */
export async function sendCurvatureCommand(
  segmentCurvaturePerM: [number, number],
  segmentDirectionRad: [number, number],
  options: CurvatureCommandOptions = {},
) {
  return invoke("send_curvature_command", {
    request: {
      deviceId: options.deviceId,
      startAddress: options.startAddress ?? 1,
      segmentCurvaturePerM,
      segmentDirectionRad,
      tableGaugeN: options.tableGaugeN ?? 60,
    },
  });
}

/** 位置由 mm 给定、姿态由 roll/pitch/yaw(rad, ZYX) 给定的位姿下发参数。 */
export interface TipPoseOptions extends CurvatureCommandOptions {}

/**
 * 末端位姿 → 6 肌腱位移 → 0x04 多电机同步指令。
 *
 * 走 **全阶 Cosserat 位姿查表**（`ik_table.PoseTable` 口径，6 维白化空间
 * `[5·p_mm, 10·rotvec_mrad]`），取代原先「位姿 → 两段曲率 → 0x05 角度」的内置 PCC 链路。
 *
 * @param positionMm 末端位置（mm）
 * @param rpyRad     末端姿态 roll/pitch/yaw（rad，ZYX 内旋）
 */
export async function sendTipPoseCommand(
  positionMm: [number, number, number],
  rpyRad: [number, number, number],
  options: TipPoseOptions = {},
) {
  return invoke("send_tip_pose_command", {
    request: {
      deviceId: options.deviceId,
      startAddress: options.startAddress ?? 1,
      positionMm,
      roll: rpyRad[0],
      pitch: rpyRad[1],
      yaw: rpyRad[2],
      tableGaugeN: options.tableGaugeN ?? 60,
    },
  });
}

/** 表中某点对应的真实形状（12 段 κx/κy），供 3D 预览渲染。 */
export interface TipPoseShapeLookup {
  nearestDistance: number;
  covered: boolean;
  degraded: boolean;
  segmentCount: number;
  segmentLengthMm: number;
  totalLengthMm: number;
  kxPerM: number[];
  kyPerM: number[];
  kappaAbsPerM: number[];
  phiRad: number[];
  displacementMm: number[];
}

/**
 * 末端位姿 → 表中最接近的**真实形状**（只读，不下发）。
 *
 * 3D 预览用它取代前端的 `solveTipPose` 反解：预览显示的必须是 .py 表里真实存在
 * 的解，否则会出现「预览一个形状、发下去另一个」。
 */
export async function lookupTipPoseShape(
  positionMm: [number, number, number],
  rpyRad: [number, number, number],
  options: CurvatureCommandOptions = {},
): Promise<TipPoseShapeLookup> {
  return invoke<TipPoseShapeLookup>("lookup_tip_pose_shape", {
    request: {
      positionMm,
      roll: rpyRad[0],
      pitch: rpyRad[1],
      yaw: rpyRad[2],
      tableGaugeN: options.tableGaugeN ?? 60,
    },
  });
}

/** 取每段曲率（`BackboneOutput` 已按段聚合，最多两段）。 */
function segmentCurvature(backbone: BackboneOutput): [number, number] {
  const values = backbone.segmentCurvaturePerM ?? [];
  return [values[0] ?? 0, values[1] ?? 0];
}

/** 取每段弯曲方向（rad）。 */
function segmentDirection(backbone: BackboneOutput): [number, number] {
  const values = backbone.segmentDirectionRad ?? [];
  return [values[0] ?? 0, values[1] ?? 0];
}

/**
 * 把拖拽产生的曲率直接下发给下位机（走全阶 Cosserat 查表）。
 *
 * @param backbone 拖拽预览的输出（`BackboneOutput`）
 */
export async function sendCurvatureDragCommand(
  backbone: BackboneOutput,
  options: CurvatureCommandOptions = {},
) {
  return sendCurvatureCommand(
    segmentCurvature(backbone),
    segmentDirection(backbone),
    options,
  );
}
