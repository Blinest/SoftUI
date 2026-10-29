import { invoke } from "@tauri-apps/api/core";

import { pushTargetHistory, setCurrentDisplacement } from "./previewOverride";
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
  /**
   * 目标设备 id（`serial:COMx` / `simulator:0`）。**必填**。
   *
   * ⚠ 不传的后果很隐蔽：后端 `selected_device_id(None)` 会静默回落到内置模拟器
   * `softui-sim-01`，于是「使能检查」走的是模拟器快照、而不是你真正连的那台设备 ——
   * 现场表现就是「明明点了启动控制系统，按曲率下发还是报设备未使能」。
   */
  deviceId: string;
  /** 起始电机地址（1 基），默认 1。 */
  startAddress?: number;
  /** 全阶 Cosserat 查表档位（张力上限 N）：40 或 60，默认 60。 */
  /**
   * 张力上限标签。**一般不要传** —— 40N/60N 只是这张表的张力上限标识，
   * 不是两个工作窗口；真正的业务量是「曲率/位姿 ↔ 驱动丝位移 ↔ 理论张力」。
   * 不传时后端按**当前模型**取它的最高档（旧臂 60N / 新臂 40N）。
   */
  tableGaugeN?: 20 | 40 | 60;
}

/** 只读查表（不下发）的选项：没有「发给谁」的语义，所以不需要 deviceId。 */
export interface TableQueryOptions {
  /** 全阶 Cosserat 查表档位（张力上限 N）：40 或 60，默认 60。 */
  /**
   * 张力上限标签。**一般不要传** —— 40N/60N 只是这张表的张力上限标识，
   * 不是两个工作窗口；真正的业务量是「曲率/位姿 ↔ 驱动丝位移 ↔ 理论张力」。
   * 不传时后端按**当前模型**取它的最高档（旧臂 60N / 新臂 40N）。
   */
  tableGaugeN?: 20 | 40 | 60;
}

/** 下发前校验目标设备：空串会让后端静默改用内置模拟器，这里直接拦成明确的错误。 */
function requireDeviceId(deviceId: string | undefined): string {
  const trimmed = (deviceId ?? "").trim();
  if (!trimmed) {
    throw new Error("未选择目标设备：请先在左栏连接设备，再下发指令（否则指令会被发到内置模拟器）");
  }
  return trimmed;
}

/**
 * κ 表**覆盖面**（1/m，单段）——两个常数都在讲同一件事：这张表不是全平面可查的。
 *
 * 依据 `src-tauri/assets/kappa_table_*.bin` 的样本范围：
 *   - A 段 κ 上限 ≈ 1.68（40N）/ 1.81（60N）
 *   - B 段 κ 上限 ≈ 2.83（40N）/ 4.24（60N）
 * 加上后端 4 维最近邻半径 `COVERAGE_RADIUS_PER_M = 1.0`，实际能查的上限还要更保守一点。
 *
 * ⚠ UI 侧旧上限是 **85°/0.2m ≈ 7.4 1/m**——比表覆盖大 4 倍还多，所以旧版本「拖一下就下发失败」
 * 是必然的。（现在这个常数只是 `model_status` 回来之前的保守兜底。）
 */
/**
 * 模型上限尚未取回时的**兜底**曲率上限（1/m，单段）。
 *
 * 真实值来自后端 `ModelStatus.kappaLimitPerM`（由当前模型包的 κ 表覆盖范围扫出，见
 * `dynamics/svcModel.ts` 的 `setModelCurvatureLimitPerM`）。这里只是首帧的保守初值，
 * 免得在 `model_status` 回来之前放开一个「发出去必失败」的范围。
 *
 * ⚠ 参考实测（内置表）：两段 κ 覆盖上限 **60N = 1.73 1/m、40N = 1.88 1/m**（默认 60N，
 * 即单段 0.2m 只能弯到约 19.8°）。UI 旧口径 85°/0.2m ≈ 7.4 1/m，大 4 倍还多 ——
 * 这正是「拖一下就下发失败」的历史原因。
 */
export const KAPPA_TABLE_COVERAGE_PER_M = 1.6;

export async function sendCurvatureCommand(
  segmentCurvaturePerM: [number, number],
  segmentDirectionRad: [number, number],
  options: CurvatureCommandOptions,
) {
  return invoke("send_curvature_command", {
    request: {
      deviceId: requireDeviceId(options.deviceId),
      startAddress: options.startAddress ?? 1,
      segmentCurvaturePerM,
      segmentDirectionRad,
      // 不传 tableGaugeN：由后端按当前模型的最高档取表。
      // 原来写死 60 —— 换到新臂（20/40N）会直接报「不含 60N 表」。
      ...(options.tableGaugeN != null ? { tableGaugeN: options.tableGaugeN } : {}),
    },
  });

}

/** 位置由 mm 给定、姿态由 roll/pitch/yaw(rad, ZYX) 给定的位姿下发参数。 */
/** 位姿下发的选项（与曲率下发同一套）。 */
export type TipPoseOptions = CurvatureCommandOptions;

/**
 * 末端位姿 → 6 肌腱位移 → 0x04 多电机同步指令。
 *
 * 走 **全阶 Cosserat 位姿查表**（`ik_table.PoseTable` 口径，6 维白化空间
 * `[5·p_mm, 10·rotvec_mrad]`），取代原先「位姿 → 两段曲率 → 0x05 角度」的内置 PCC 链路。
 *
 * @param positionMm 末端位置（mm）
 * @param rpyRad     末端姿态 roll/pitch/yaw（rad，ZYX 内旋）
 */
/** `send_tip_pose_command` 的返回：快照 + **模型算出来的 6 路目标位移**。 */
export interface TipPoseCommandResult {
  snapshot: unknown;
  /** 6 路肌腱目标位移（mm），顺序对应 `startAddress` 起的 6 个电机。 */
  targetDisplacementMm: number[];
  nearestDistance: number;
}

/**
 * **按 6 路位移直接下发** ✓ —— 动作播放用这条路 ✓。
 *
 * 为什么不复用 `sendTipPoseCommand` ✗：播放的每一帧位移在播放开始时**已经批量算好**了
 * （`preview_tip_pose_batch` ✓）。再按末端位姿查一次表 ✓ 是白花几百微秒 ✓，
 * 而且会二次插值 → 轨迹和 3D 显示的形状对不上 ✗。
 *
 * 只发**最新一帧** ✓、绝不排队 ✓（和拖动实时跟随同一套策略 ✓）。
 */
export async function sendMultiMotorCommand(
  positionsMm: number[],
  options: { deviceId?: string; startAddress?: number } = {},
): Promise<{ snapshot?: unknown; targetDisplacementMm?: number[] }> {
  return invoke("send_multi_motor_command", {
    request: {
      deviceId: requireDeviceId(options.deviceId),
      startAddress: options.startAddress ?? 1,
      positionsMm,
    },
  });
}

/**
 * **只查表、不下发** ✓ —— 返回 6 路目标位移 ✓。
 *
 * 用途：本机直发路径 ✓ —— 前端先拿到位移 ✓，再用 `directMultiMotor` 直接写串口 ✓，
 * 免掉"后端查表 + 后端发送"里**发送那一段的往返与排队** ✓。
 * （查表本身仍要后端，因为表在后端 ✓；要彻底本地化需要把表下发给前端 ✓）
 */
export async function previewTipPoseCommand(
  positionMm: [number, number, number],
  rpyRad: [number, number, number],
  options: TipPoseOptions,
) {
  // ⚠ 字段名以 Rust 为准：`TipPosePreviewResult.target_displacement_mm`
  //   经 `rename_all = "camelCase"` 序列化成 `targetDisplacementMm`。
  //   之前这里写成 `displacementMm` → 调用方拿到 undefined（本 bug）。
  return invoke<{ targetDisplacementMm: number[]; nearestDistance: number }>(
    "preview_tip_pose_command",
    {
      request: {
        deviceId: requireDeviceId(options.deviceId),
        startAddress: options.startAddress ?? 1,
        positionMm,
        roll: rpyRad[0],
        pitch: rpyRad[1],
        yaw: rpyRad[2],
        ...(options.tableGaugeN != null ? { tableGaugeN: options.tableGaugeN } : {}),
      },
    },
  );
}

export async function sendTipPoseCommand(
  positionMm: [number, number, number],
  rpyRad: [number, number, number],
  options: TipPoseOptions,
): Promise<TipPoseCommandResult> {
  const result = await invoke<TipPoseCommandResult>("send_tip_pose_command", {
    request: {
      deviceId: requireDeviceId(options.deviceId),
      startAddress: options.startAddress ?? 1,
      positionMm,
      roll: rpyRad[0],
      pitch: rpyRad[1],
      yaw: rpyRad[2],
      // 不传 tableGaugeN：由后端按当前模型的最高档取表。
      // 原来写死 60 —— 换到新臂（20/40N）会直接报「不含 60N 表」。
      ...(options.tableGaugeN != null ? { tableGaugeN: options.tableGaugeN } : {}),
    },
  });

  /**
   * **把下发量喂给监控卡 / 曲线** ✓ —— 实时跟随（拖动 ✓）走的正是这条路 ✓，
   * 原来返回值**没人用** ✗ → 目标位移曲线、速度曲线、电机概览**全没数据** ✗（本 bug ✓）。
   */
  if (Array.isArray(result?.targetDisplacementMm)) {
    setCurrentDisplacement(result.targetDisplacementMm);
    pushTargetHistory(result.targetDisplacementMm);
  }

  return result;
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
  options: TableQueryOptions = {},
): Promise<TipPoseShapeLookup> {
  return invoke<TipPoseShapeLookup>("lookup_tip_pose_shape", {
    request: {
      positionMm,
      roll: rpyRad[0],
      pitch: rpyRad[1],
      yaw: rpyRad[2],
      // 不传 tableGaugeN：由后端按当前模型的最高档取表。
      // 原来写死 60 —— 换到新臂（20/40N）会直接报「不含 60N 表」。
      ...(options.tableGaugeN != null ? { tableGaugeN: options.tableGaugeN } : {}),
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
  options: CurvatureCommandOptions,
) {
  return sendCurvatureCommand(
    segmentCurvature(backbone),
    segmentDirection(backbone),
    options,
  );
}
