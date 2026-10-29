import { solveDragToPoint } from "../dynamics/curvatureDrag";
import {
  mapSvcPointToThreeMm,
  modelCurvatureLimitForDirection,
  type CurvatureDistribution,
} from "../dynamics/svcModel";
import { tipPoseOfDistribution } from "./pose3d";
import type { MotionPoint } from "./motionDraft";

/**
 * 轨迹规划：**记录点 → 平滑曲线 → 重采样 → 逐点 IK → κ 平滑 → 偏差校验** ✓。
 *
 * 策略是"混合"✓：末端路径**不做硬约束** ✗（柔性臂走不出精确直线 ✓），
 * 只在**容差带**内要求达标 ✓；真正的连续性靠 **κ(s) 平滑** 保证 ✓。
 */

  // ⚠ 已知局限：这里只存 **|κ|**（kappaAbsPerM），**方向角 phiRad 没存** ✗
  //   所以播放时所有段都朝 phi=0 弯 ✓，形状与记录时可能不同 ✗。
  //   彻底修法：samples 改存 [kx, ky] ✓（见待办「动作库方向信息丢失」）
export interface PlanSample {
  x: number;
  y: number;
  z: number;
  /** 每段 kx / ky（1/m ✓）—— **带方向** ✓ */
  kx: number[];
  ky: number[];
  /** 该点解算是否饱和（到 κ 上限了 ✓）*/
  saturated: boolean;
  /** 该点与目标点的偏差（mm ✓）*/
  deviationMm: number;
}

export interface PlanResult {
  ok: boolean;
  samples: PlanSample[];
  /** 总弧长（mm ✓）*/
  lengthMm: number;
  /** 按速度估的时长（ms ✓）*/
  durationMs: number;
  maxDeviationMm: number;
  /** 不可达的采样点序号 ✓（空 = 全程可达 ✓）*/
  unreachable: number[];
  messages: string[];
}

/**
 * 由模型构造**平直基准形位** ✓（κ 全 0 ✓）。
 *
 * 为什么不用"当前形位"✗：动作库记的是**末端轨迹** ✓，和当时手臂什么形位无关 ✓。
 * 用平直基准 → 同一个动作对**任何模型**都能独立求解 ✓ → 结果可复现 ✓。
 */
export function baseDistributionFromModel(entry: {
  params?: { lengthMm?: number | null } | null;
  totalLengthMm?: number | null;
}) {
  // 优先用后端给的 totalLengthMm ✓（内建来自预设常量 ✓，用户模型来自参数 ✓）
  const raw = entry.totalLengthMm ?? entry.params?.lengthMm ?? 400;
  // ⚠ 校验：NaN / 0 / 负数都会让后续全部变 NaN ✗
  const totalLengthMm = Number.isFinite(raw) && raw > 10 ? raw : 400;
  const count = 12;
  const segmentLength = totalLengthMm / count;
  const segments = Array.from({ length: count }, (_, index) => ({
    index,
    sStartMm: index * segmentLength,
    sEndMm: (index + 1) * segmentLength,
    sMidMm: (index + 0.5) * segmentLength,
    lengthMm: segmentLength,
    kxPerM: 0,
    kyPerM: 0,
    kappaAbsPerM: 0,
    // ⚠ **必须给** ✓ —— `buildBackboneFromCurvatureDistribution` 用 `segment.phiRad` 算
    //    cos/sin ✓；缺了就是 `cos(undefined)` → **NaN** ✗ → 整条 IK 链变 NaN ✗
    phiRad: 0,
  }));
  return {
    totalLengthMm,
    basisSegmentCount: count,
    source: "manualDrag",
    segments,
  } as unknown as CurvatureDistribution;
}

interface PlanOptions {
  toleranceMm: number;
  /** 末端速度（mm/s ✓），默认 20 ✓ */
  /**
   * **规划名义速度（mm/s）** ✓ —— 必须与驱动器实际可达速度匹配 ✓。
   *
   * 实测教训 ✗：写成 20 mm/s 时，驱动器只有 2 mm/s ✓ → 行程只完成 38%~82% ✓，
   * 跟踪误差 RMS 2~3 mm、峰值 11 mm ✓，即使把电机提到 5 mm/s 仍差 9 mm ✓
   * （因为轨迹要 6~12 mm/s ✗）。
   * 把它降到电机能力以内，误差主要由"恒定时滞 τ·v"构成 ✓，量级小一个数量级 ✓。
   */
  speedMmPerS?: number;
  /** 采样步长（mm ✓），默认 2 ✓ */
  stepMm?: number;
  base: CurvatureDistribution;
  /** 每段的曲率上限（1/m）✓ —— 不给就用模块单例 ✓（可能不准 ✗）*/
  limitsPerM?: number[];
}

/** Catmull-Rom 样条：**穿过所有控制点** ✓（不像 B 样条会被拉离 ✗）*/
function catmullRom(points: Array<[number, number, number]>, samplesPerSpan = 12) {
  const out: Array<[number, number, number]> = [];
  const n = points.length;
  if (n === 0) return out;
  if (n === 1) return [[...points[0]] as [number, number, number]];

  const at = (index: number): [number, number, number] => {
    // 端点：镜像外推 ✓（让曲线从第一个点开始 ✓、到最后一个点结束 ✓）
    if (index < 0) {
      const a = points[0];
      const b = points[1];
      return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
    }
    if (index >= n) {
      const a = points[n - 1];
      const b = points[n - 2];
      return [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
    }
    return points[index];
  };

  for (let i = 0; i < n - 1; i += 1) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const steps = i === n - 2 ? samplesPerSpan + 1 : samplesPerSpan;   // 最后一跨含终点 ✓
    for (let s = 0; s < steps; s += 1) {
      const t = s / samplesPerSpan;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 *
        (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1]), f(p0[2], p1[2], p2[2], p3[2])]);
    }
  }
  return out;
}

/** 按弧长等距重采样 ✓ */
function resampleByArcLength(
  path: Array<[number, number, number]>,
  stepMm: number,
): { points: Array<[number, number, number]>; lengthMm: number } {
  if (path.length < 2) return { points: path, lengthMm: 0 };
  const cumulative = [0];
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1];
    const b = path[i];
    cumulative.push(cumulative[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const total = cumulative[cumulative.length - 1];
  if (total < 1e-6) return { points: [path[0]], lengthMm: 0 };

  const count = Math.max(2, Math.min(400, Math.ceil(total / stepMm) + 1));
  const points: Array<[number, number, number]> = [];
  let cursor = 0;
  for (let k = 0; k < count; k += 1) {
    const target = (total * k) / (count - 1);
    while (cursor < cumulative.length - 2 && cumulative[cursor + 1] < target) cursor += 1;
    const span = cumulative[cursor + 1] - cumulative[cursor] || 1;
    const t = Math.min(1, Math.max(0, (target - cumulative[cursor]) / span));
    const a = path[cursor];
    const b = path[cursor + 1];
    points.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  }
  return { points, lengthMm: total };
}

/** 三点滑动平均 ✓ —— 消掉逐点 IK 的锯齿 ✗（kx / ky 各自平滑 ✓）*/
function smoothSeries(series: number[][], passes = 2): number[][] {
  let current = series.map((row) => [...row]);
  for (let pass = 0; pass < passes; pass += 1) {
    const next = current.map((row) => [...row]);
    for (let i = 1; i < current.length - 1; i += 1) {
      for (let seg = 0; seg < row(current[i]).length; seg += 1) {
        next[i][seg] = (current[i - 1][seg] + 2 * current[i][seg] + current[i + 1][seg]) / 4;
      }
    }
    current = next;
  }
  return current;
}

function row(values: number[]) {
  return values;
}

/**
 * **默认规划名义速度** ✓ —— 单位 mm/s ✓。
 *
 * 取值依据：驱动器实测可达速度（最初 2 mm/s，现调到 5 mm/s）✓。
 * 规划速度**必须 ≤ 实际可达速度** ✓，否则时间轴一算出来就是"追不上"✗：
 * 距离 L、名义速度 v_plan、实际 v_real → 行程完成度 ≈ v_real / v_plan ✓，
 * 剩余量在结束时才靠"钉终点"补，过程中必然持续落后 ✗。
 *
 * 目前留 20% 余量取 4 mm/s ✓（电机 5 mm/s 时仍有裕度 ✓）。
 * 想跑快只有两条路：① 继续提高驱动器速度 ② 接受动作时长变长 ✓。
 */
export const DEFAULT_PLAN_SPEED_MM_PER_S = 4;

export interface ModelFeasibility extends PlanResult {
  modelId: string;
  modelName: string;
}

/** 对**一个模型**做可行性检查 ✓ */
export function planForModel(
  points: MotionPoint[],
  model: {
    id: string;
    name: string;
    params?: { lengthMm?: number | null } | null;
    totalLengthMm?: number | null;
  },
  toleranceMm: number,
): ModelFeasibility {
  const base = baseDistributionFromModel(model);
  // 方向表（8 个）取平均前先校验 ✓ —— 有 NaN / 空就退回标量 ✓
  const directionTable = (model as { kappaLimitByDirection?: number[] }).kappaLimitByDirection;
  const scalar = (model as { kappaLimitPerM?: number }).kappaLimitPerM;
  const usableScalar =
    typeof scalar === "number" && Number.isFinite(scalar) && scalar > 0 ? scalar : 1.5;
  const limit =
    Array.isArray(directionTable) && directionTable.length === 8 &&
    directionTable.every((value) => Number.isFinite(value) && value > 0)
      ? directionTable.reduce((sum, value) => sum + value, 0) / 8
      : usableScalar;
  const limitsPerM = Array.from({ length: base.segments.length }, () => limit);

  const result = planMotion(points, {
    toleranceMm,
    speedMmPerS: DEFAULT_PLAN_SPEED_MM_PER_S,
    stepMm: 2,
    base,
    limitsPerM,
  });
  return { ...result, modelId: model.id, modelName: model.name };
}

/** 对**模型库里所有模型**逐个检查 ✓ —— 这就是"这条轨迹哪些模型能走" ✓ */
export function planForAllModels(
  points: MotionPoint[],
  models: Array<{
    id: string;
    name: string;
    params?: { lengthMm?: number | null } | null;
    totalLengthMm?: number | null;
  }>,
  toleranceMm: number,
): ModelFeasibility[] {
  return models.map((model) => planForModel(points, model, toleranceMm));
}

export function planMotion(points: MotionPoint[], options: PlanOptions): PlanResult {
  const messages: string[] = [];
  if (points.length < 2) {
    return {
      ok: false,
      samples: [],
      lengthMm: 0,
      durationMs: 0,
      maxDeviationMm: 0,
      unreachable: [],
      messages: ["至少需要 2 个记录点 ✓"],
    };
  }

  const stepMm = options.stepMm ?? 2;
  const speed = Math.max(0.5, options.speedMmPerS ?? DEFAULT_PLAN_SPEED_MM_PER_S);
  // 上限必须**显式给** ✓（模块单例在别的 chunk 里可能还是默认值甚至未初始化 ✗ → NaN ✗）
  const segmentCount = options.base.segments.length;
  const limitsPerM =
    options.limitsPerM && options.limitsPerM.length === segmentCount
      ? options.limitsPerM
      : Array.from({ length: segmentCount }, () => modelCurvatureLimitForDirection(0));

  // ① 样条 ✓ ② 重采样 ✓
  const dense = catmullRom(points.map((p) => [p.x, p.y, p.z] as [number, number, number]));
  const { points: targets, lengthMm } = resampleByArcLength(dense, stepMm);
  messages.push(`路径 ${lengthMm.toFixed(0)}mm，采样 ${targets.length} 点`);

  // ③ 逐点 IK ✓ —— 用**上一点的解**当 base ✓，保证 κ 连续 ✓
  const rawKx: number[][] = [];
  const rawKy: number[][] = [];
  const solvedPoints: Array<[number, number, number]> = [];
  const saturatedFlags: boolean[] = [];
  const unreachable: number[] = [];
  let base = options.base;

  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    const solved = solveDragToPoint({
      sMm: options.base.totalLengthMm,
      toMm: target,
      base,
      limitsPerM,
    } as never);
    const tip = tipPoseOfDistribution((solved as { distribution: CurvatureDistribution }).distribution.segments);
    // 和 IK 的 `reached` 同口径：都是 three 系 ✓（y/z 互换 ✓）
    const tipMm: [number, number, number] = mapSvcPointToThreeMm(tip.positionM);
    const error = Math.hypot(tipMm[0] - target[0], tipMm[1] - target[1], tipMm[2] - target[2]);

    if (error > options.toleranceMm * 3) unreachable.push(i);
    saturatedFlags.push(Boolean((solved as { saturated?: boolean }).saturated));
    rawKx.push(
      (solved as { distribution: CurvatureDistribution }).distribution.segments.map((seg) => seg.kxPerM),
    );
    rawKy.push(
      (solved as { distribution: CurvatureDistribution }).distribution.segments.map((seg) => seg.kyPerM),
    );
    solvedPoints.push(tipMm);
    base = (solved as { distribution: CurvatureDistribution }).distribution;
  }

  // ④ κ 平滑 ✓ —— kx / ky **分别**平滑 ✓（方向角才不会跳 ✗）
  const smoothedKx = smoothSeries(rawKx, 2);
  const smoothedKy = smoothSeries(rawKy, 2);

  // ⑤ 偏差校验 ✓（用平滑后的 κ 回算末端 ✓）
  const samples: PlanSample[] = smoothedKx.map((kxRow, index) => {
    const kyRow = smoothedKy[index] ?? [];
    const pseudo: CurvatureDistribution = {
      ...options.base,
      segments: options.base.segments.map((segment, segIndex) => {
        const kx = kxRow[segIndex] ?? 0;
        const ky = kyRow[segIndex] ?? 0;
        return {
          ...segment,
          kxPerM: kx,
          kyPerM: ky,
          kappaAbsPerM: Math.hypot(kx, ky),
          // phiRad 必须跟着给 ✓（缺了骨骼积分会 NaN ✗）
          phiRad: Math.atan2(ky, kx),
        };
      }),
    } as CurvatureDistribution;
    const tip = tipPoseOfDistribution(pseudo.segments);
    const tipMm: [number, number, number] = mapSvcPointToThreeMm(tip.positionM);
    const target = targets[index];
    return {
      x: tipMm[0],
      y: tipMm[1],
      z: tipMm[2],
      kx: kxRow,
      ky: kyRow,
      saturated: saturatedFlags[index] ?? false,
      deviationMm: Math.hypot(tipMm[0] - target[0], tipMm[1] - target[1], tipMm[2] - target[2]),
    };
  });

  const maxDeviationMm = samples.reduce((max, sample) => Math.max(max, sample.deviationMm), 0);
  const durationMs = Math.round((lengthMm / speed) * 1000);
  // 容差比较留 0.05mm 浮点余量 ✓ —— 2.00 vs 2 判成超差没有意义 ✗
  const ok = unreachable.length === 0 && maxDeviationMm <= options.toleranceMm + 0.05;

  if (unreachable.length > 0) {
    messages.push(`⚠ ${unreachable.length} 个采样点不可达（第 ${unreachable.slice(0, 5).join("、")}${unreachable.length > 5 ? "…" : ""} 点）`);
  }
  if (maxDeviationMm > options.toleranceMm + 0.05) {
    // 偏差远超容差 → 多半是**目标超出臂长/可达范围** ✗，而不是精度问题 ✓
    const beyondReach = maxDeviationMm > options.toleranceMm * 5;
    messages.push(
      beyondReach
        ? `⚠ 目标超出可达范围（最大偏差 ${maxDeviationMm.toFixed(1)}mm）—— 多半是臂长不够或弯不到 ✗`
        : `⚠ 最大偏差 ${maxDeviationMm.toFixed(1)}mm，超出容差 ${options.toleranceMm}mm`,
    );
  } else {
    messages.push(`✓ 偏差 ${maxDeviationMm.toFixed(1)}mm，在容差内 ✓`);
  }


  return { ok, samples, lengthMm, durationMs, maxDeviationMm, unreachable, messages };
}
