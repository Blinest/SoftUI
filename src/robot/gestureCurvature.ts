/**
 * 手势曲率：把摄像头识别到的细长物体（手指）的**弯折**，映射成臂体的曲率分布。
 *
 * ── 为什么用「总弯折角」而不是「曲率 κ = 1/R」──────────────────────────────
 *
 * 1/R 需要**像素 → 米**的标定，而摄像头没有标定，猜一个比例尺会把误差直接
 * 带进控制量。改用骨架的**累计转角**：
 *
 *     弯折角 θ = Σ 相邻线段的方向变化
 *
 * 它是无量纲的（rad），**对像素尺度、镜头距离、物体粗细都不敏感** ——
 * 伸直的手指 θ≈0，折成直角 θ≈π/2。这样标定问题就消失了，只剩一个
 * 「θ 多大连到臂体 κ 上限」的**量程**和一个方向符号要现场确认。
 *
 * ── 映射 ─────────────────────────────────────────────────────────────────
 *
 *   θ（0..fullBendRad） →  κ_arm（0..kappaLimitPerM），12 段等曲率，
 *   弯曲方向取骨架的平均走向。
 *
 * kappaLimitPerM 由**动力学模型**给出（`model_status.kappaLimitPerM`），
 * 所以手势永远发不出模型不允许的曲率 —— 超了也只会被位姿表拒绝。
 */

import type { CurvatureDistribution } from "../dynamics/svcModel";

/** 骨架点（图像坐标，y 向下）。 */
export interface SkeletonPoint {
  x: number;
  y: number;
}

export interface GestureBend {
  /** 总弯折角（rad，带符号）。伸直≈0，折成直角≈±π/2。 */
  bendRad: number;
  /** 弯折所在方向（rad，图像坐标下的平均走向）。 */
  directionRad: number;
  /** 骨架总长（像素）。太短说明抓到的是一小团噪声，不可信。 */
  spanPx: number;
}

/** 骨架点少于这个数就拟合不出弯折。 */
const MIN_SKELETON_POINTS = 3;
/** 单段短于这个长度（像素）视为重复点，跳过。 */
const MIN_SEGMENT_PX = 1e-6;
/** 骨架总长短于这个值（像素）时直接判为不可信。 */
const MIN_SPAN_PX = 8;

function wrapPi(angle: number): number {
  let value = angle;
  while (value > Math.PI) value -= 2 * Math.PI;
  while (value < -Math.PI) value += 2 * Math.PI;
  return value;
}

/**
 * 从骨架点序列估计**总弯折角**与走向。
 *
 * 返回 `null` 表示点太少 / 太短 / 退化，此时调用方**必须停止下发**，
 * 而不是沿用上一帧 —— 摄像头一旦丢帧，保持上一帧的弯曲会让臂体一直弯着。
 */
export function bendFromSkeleton(points: readonly SkeletonPoint[] | null | undefined): GestureBend | null {
  if (!points || points.length < MIN_SKELETON_POINTS) return null;

  let bendRad = 0;
  let spanPx = 0;
  let sumCos = 0;
  let sumSin = 0;
  let previousDirection: number | null = null;
  let usable = 0;

  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    const length = Math.hypot(dx, dy);
    if (length < MIN_SEGMENT_PX) continue;
    spanPx += length;
    usable += 1;
    const direction = Math.atan2(dy, dx);
    sumCos += Math.cos(direction);
    sumSin += Math.sin(direction);
    if (previousDirection !== null) bendRad += wrapPi(direction - previousDirection);
    previousDirection = direction;
  }

  if (previousDirection === null || usable < 2 || spanPx < MIN_SPAN_PX) return null;

  return {
    // 图像坐标 y 向下，"向下弯"在数学上是负号；取反让它符合直觉（正 = 向上弯）。
    // ⚠️ 这个符号只能现场确认（见文件头），是唯一需要标定的东西。
    bendRad: -bendRad,
    directionRad: Math.atan2(sumSin, sumCos),
    spanPx,
  };
}

export interface GestureMappingOptions {
  /** 动力学模型给出的曲率上限（1/m，单段）。由 `model_status` 提供。 */
  kappaLimitPerM: number;
  /** 臂体总长（mm）。 */
  totalLengthMm: number;
  /** 分段数（与臂体控制一致，通常 12）。 */
  segments: number;
  /** 手指弯到多大算"弯到底"。默认 90°。 */
  fullBendRad?: number;
  /** 小于这个弯折角视为噪声，直接输出零曲率（防静止时抖动）。 */
  deadZoneRad?: number;
}

const DEFAULT_FULL_BEND_RAD = Math.PI / 2;
const DEFAULT_DEAD_ZONE_RAD = 0.12; // ≈ 7°

/**
 * 手势弯折 → 12 段等曲率分布。
 *
 * - 方向：由 `directionRad` 给到 `kx/ky` 的比值（弯曲平面）。
 * - 量值：|θ| / fullBendRad 线性映射到 `kappaLimitPerM`，**并硬性钳在模型上限内**。
 * - 死区：|θ| < deadZone 时输出零曲率，避免手指静止时臂体抖。
 */
export function gestureDistribution(
  bend: GestureBend | null,
  options: GestureMappingOptions,
): CurvatureDistribution | null {
  if (!bend) return null;

  const fullBend = options.fullBendRad ?? DEFAULT_FULL_BEND_RAD;
  const deadZone = options.deadZoneRad ?? DEFAULT_DEAD_ZONE_RAD;
  if (!(fullBend > 0)) return null;

  const magnitude = Math.abs(bend.bendRad) < deadZone ? 0 : Math.abs(bend.bendRad);
  // 上限来自动力学模型；再多也不许发 —— 超了位姿表会拒绝整帧。
  const magnitudePerM = Math.min(magnitude / fullBend, 1) * Math.max(0, options.kappaLimitPerM);

  const segmentCount = Math.max(1, Math.floor(options.segments));
  const segmentLengthMm = options.totalLengthMm / segmentCount;
  const phi = bend.directionRad;

  // 方向取反与否同样只能现场确认：这里让"手指往哪边弯"与"臂体往哪边弯"
  // 在屏幕坐标系里一致（图像 y 向下已在 bendRad 里取反过一次）。
  const bendSign = bend.bendRad < 0 ? -1 : 1;
  const kxPerM = magnitudePerM * Math.cos(phi) * bendSign;
  const kyPerM = magnitudePerM * Math.sin(phi) * bendSign;

  const segments = Array.from({ length: segmentCount }, (_, index) => ({
    index,
    sStartMm: index * segmentLengthMm,
    sEndMm: (index + 1) * segmentLengthMm,
    sMidMm: (index + 0.5) * segmentLengthMm,
    lengthMm: segmentLengthMm,
    kxPerM,
    kyPerM,
    kappaAbsPerM: magnitudePerM,
    phiRad: phi,
  }));

  return {
    totalLengthMm: options.totalLengthMm,
    basisSegmentCount: segmentCount,
    source: "gesture",
    segments,
  };
}
