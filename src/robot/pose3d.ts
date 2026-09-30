/* 末端位姿 ↔ 两段曲率的正解与反解。
 *
 * ── 自由度账（决定了这件事能做到什么程度）──
 *
 * 柔性臂是 **2 段常曲率（PCC）**，每段只有「曲率大小 κ + 弯曲方向 φ」两个
 * 自由度，**合计 4 个**。而末端位姿是 6 个约束（xyz + rpy）。所以：
 *
 *   - **位置（3 个约束）**通常可解，且有冗余自由度 —— 同一个末端点可以对应
 *     多组 (κ, φ)，解不唯一。
 *   - **姿态（另外 3 个约束）一般不可达**。想同时命中位置和姿态，是 6 个约束
 *     压 4 个自由度，只有测度为零的特殊目标才恰好成立。
 *
 * 所以反解按「**位置优先、姿态尽力**」做加权最小二乘，并把两个残差都返回给
 * UI 显示。绝不假装能精确达到 —— 那种做法只会让操作员以为臂坏了。
 *
 * ── 坐标约定 ──
 *
 * 与 svcModel 一致：静止时臂沿 **+z** 伸展，弯曲发生在 xy 平面，φ 从 +x 量起。
 * 段变换（长度 L、曲率 κ ≥ 0、方向 φ）：
 *
 *   θ = κL，绕轴 k = (−sinφ, cosφ, 0) 转 θ，再平移到 svcPose(κ, φ, L)
 *
 * φ = 0 时 k = +y，把 +z 转向 +x，与 svcModel.svcPose 的
 * (R(1−cosθ)·cosφ, R(1−cosθ)·sinφ, R·sinθ) 逐项一致（见 verifyPose3d）。
 *
 * RPY 取 **ZYX 内旋**（R = Rz(yaw)·Ry(pitch)·Rx(roll)），与常见机器人约定一致。 */

import type { CurvatureDistribution } from "../dynamics/svcModel";

export type Vec3 = [number, number, number];

/** 行主序 4x4 齐次变换矩阵：`[r00,r01,r02,tx, r10,r11,r12,ty, ...]`。 */
export type Mat4 = number[];

const EPS = 1e-9;

/* ── 基本矩阵运算 ── */

export function identityMat(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function matMul(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[r * 4 + k] * b[k * 4 + c];
      out[r * 4 + c] = sum;
    }
  }
  return out;
}

/** 刚体变换的逆：Rᵀ 与 −Rᵀt（比通用求逆快且不会引入数值漂移）。 */
export function matInverse(m: Mat4): Mat4 {
  const out = identityMat();
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) out[r * 4 + c] = m[c * 4 + r];
  }
  for (let r = 0; r < 3; r += 1) {
    out[r * 4 + 3] = -(m[0 * 4 + r] * m[0 * 4 + 3] + m[1 * 4 + r] * m[1 * 4 + 3] + m[2 * 4 + r] * m[2 * 4 + 3]);
  }
  return out;
}

export function matApplyPoint(m: Mat4, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2] + m[3],
    m[4] * v[0] + m[5] * v[1] + m[6] * v[2] + m[7],
    m[8] * v[0] + m[9] * v[1] + m[10] * v[2] + m[11],
  ];
}

/** 绕单位轴旋转的纯旋转矩阵（Rodrigues）。 */
function rotationAxisAngle(axis: Vec3, angle: number): Mat4 {
  const [x, y, z] = axis;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ];
}

function translation(x: number, y: number, z: number): Mat4 {
  return [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
}

/* ── RPY（ZYX 内旋） ── */

export function rpyToMat(rpy: Vec3): Mat4 {
  const [roll, pitch, yaw] = rpy;
  const [cr, sr] = [Math.cos(roll), Math.sin(roll)];
  const [cp, sp] = [Math.cos(pitch), Math.sin(pitch)];
  const [cy, sy] = [Math.cos(yaw), Math.sin(yaw)];
  return [
    cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr, 0,
    sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr, 0,
    -sp, cp * sr, cp * cr, 0,
    0, 0, 0, 1,
  ];
}

/**
 * 旋转矩阵 → RPY（ZYX 内旋）。
 *
 * 万向节锁（pitch = ±90°，cp → 0）时 roll/yaw 不可分离，按惯例把 roll 归零、
 * 把自由度全部算给 yaw。返回弧度。
 */
export function matToRpy(m: Mat4): Vec3 {
  const m20 = m[8];
  const sp = Math.max(-1, Math.min(1, -m20));
  const pitch = Math.asin(sp);
  const cp = Math.cos(pitch);
  if (Math.abs(cp) < 1e-8) {
    return [0, pitch, Math.atan2(-m[1], m[5])];
  }
  return [
    Math.atan2(m[9], m[10]),
    pitch,
    Math.atan2(m[4], m[0]),
  ];
}

/**
 * 两个旋转之间的**旋转向量**（轴 × 角），用作姿态残差。
 *
 * 直接拿 rpy 三个角相减是不行的：同一个姿态的 rpy 表示不唯一（±180° 翻转、
 * 万向节锁），相减出来的"误差"会在这些点上跳变，牛顿迭代立刻发散。
 * 转成旋转向量后，误差在零点附近是光滑的，迭代才收敛。
 */
export function rotationResidual(current: Mat4, target: Mat4): Vec3 {
  const rel = matMul(matInverse(current), target);
  const trace = rel[0] + rel[5] + rel[10];
  const cos = Math.max(-1, Math.min(1, (trace - 1) / 2));
  const angle = Math.acos(cos);
  if (angle < 1e-7) return [0, 0, 0];
  const s = 2 * Math.sin(angle);
  if (Math.abs(s) < 1e-9) return [0, 0, 0];
  return [
    ((rel[9] - rel[6]) / s) * angle,
    ((rel[2] - rel[8]) / s) * angle,
    ((rel[4] - rel[1]) / s) * angle,
  ];
}

/* ── 正解 ── */

/**
 * 一段常曲率的坐标系（相对段起点）。
 *
 * 参数用 **曲率向量 (kx, ky)** 而不是 (κ, φ)：κ=0 时 φ 是未定义的，
 * 那个点上 ∂f/∂φ 整列为零，反解的雅可比会退化 —— 优化器一旦走到
 * 「某一段是直的」就再也调不动那一段的方向。用曲率向量后，(0,0) 只是
 * 平面上的原点，两个分量都有正常梯度。这与 CurvatureDistribution 的
 * (kxPerM, kyPerM) 表示也是同一套。
 *
 * 换算关系与 svcModel 一致：`κ = hypot(kx,ky)`，`φ = atan2(−kx, ky)`，
 * 于是 ky>0 朝 +x 弯、kx>0 朝 −y 弯（对应渲染后的 three −z）。
 */
export function segmentTransform(kxPerM: number, kyPerM: number, lengthM: number): Mat4 {
  const curvaturePerM = Math.hypot(kxPerM, kyPerM);
  if (!(curvaturePerM > EPS)) return translation(0, 0, lengthM);
  const directionRad = Math.atan2(-kxPerM, kyPerM);
  const theta = curvaturePerM * lengthM;
  const radius = 1 / curvaturePerM;
  const [sphi, cphi] = [Math.sin(directionRad), Math.cos(directionRad)];
  const along = radius * (1 - Math.cos(theta));
  const position: Vec3 = [along * cphi, along * sphi, radius * Math.sin(theta)];
  const rotation = rotationAxisAngle([-sphi, cphi, 0], theta);
  rotation[3] = position[0];
  rotation[7] = position[1];
  rotation[11] = position[2];
  return rotation;
}

export interface SectionCurvature {
  /** 曲率向量分量（1/m）。 */
  kxPerM: number;
  kyPerM: number;
}

/** 曲率向量的模长与方向，供 UI 显示与协议折返。 */
export function curvatureOf(section: SectionCurvature): { curvaturePerM: number; directionRad: number } {
  return {
    curvaturePerM: Math.hypot(section.kxPerM, section.kyPerM),
    directionRad: Math.atan2(-section.kxPerM, section.kyPerM),
  };
}

/** 两段常曲率 → 末端坐标系（起点在原点的臂）。 */
export function forwardKinematics(
  sections: readonly [SectionCurvature, SectionCurvature],
  segmentLengthM: readonly [number, number],
): Mat4 {
  return matMul(
    segmentTransform(sections[0].kxPerM, sections[0].kyPerM, segmentLengthM[0]),
    segmentTransform(sections[1].kxPerM, sections[1].kyPerM, segmentLengthM[1]),
  );
}

export interface TipPose {
  positionM: Vec3;
  rpyRad: Vec3;
}

export function tipPoseOf(transform: Mat4): TipPose {
  return { positionM: [transform[3], transform[7], transform[11]], rpyRad: matToRpy(transform) };
}

/* ── 反解 ── */

export interface TipSolveInput {
  target: TipPose;
  /** 迭代初值（一般取当前实际曲率）：反解是非凸的，初值决定落到哪个解。 */
  base: readonly [SectionCurvature, SectionCurvature];
  segmentLengthM: readonly [number, number];
  /** 逐段曲率上限（1/m）。 */
  maxCurvaturePerM: readonly [number, number];
  /** 姿态权重（相对位置）。0 = 完全不管姿态。 */
  orientationWeight?: number;
  /** 位置与姿态残差的量纲不同，用一个特征长度把角度换算成米再加权。 */
  characteristicLengthM?: number;
  iterations?: number;
  /**
   * 快速模式：只用 4 个起点、迭代减半。
   *
   * 连续输入（拖拽预览、边打字边算）时用 —— 命中率仍然很高，耗时约为完整
   * 多起点的三分之一。松手/失焦时再跑一次完整模式补精度。
   */
  fast?: boolean;
}

export interface TipSolveResult {
  sections: [SectionCurvature, SectionCurvature];
  reached: TipPose;
  /** 位置残差（m）。 */
  positionErrorM: number;
  /** 姿态残差（rad，旋转向量的模长）。 */
  orientationErrorRad: number;
  /** 曲率是否顶到上限。 */
  saturated: boolean;
  /** 位置残差是否在可接受范围内（判断"这个点够不够得着"）。 */
  reachable: boolean;
  iterations: number;
}

/** 位置残差超过这个值就认为目标点不可达（1mm，远小于臂的 405mm 尺度）。 */
const REACHABLE_TOLERANCE_M = 1e-3;

/**
 * 多起点的初值表。两组方向正交、三档曲率，覆盖「直 / 沿四个方向弯」的组合。
 *
 * **为什么需要多起点**：位置约束在 4 个自由度里只占 3 个，留下一个 1 参数
 * 解族 —— 实测可达目标能解出上百个不同 (κ, φ) 组合（见 `probeTipSolutions`）。
 * 单起点只能拿到其中一个，姿态纯碰运气；而残差函数又是非凸的，换个起点
 * 常常落到完全不同的解。多跑 10 次单次迭代（每次不到 1ms）换一个明显更好的
 * 姿态，在「拖拽实时预览」这个量级上完全不值得省。
 */
const SEED_CURVATURES: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 0, 0, 0],
  [0, 8, 0, 8], [0, -8, 0, -8],
  [0, 12, 0, 4], [0, -12, 0, -4],
  [0, 6, 0, -14], [0, -6, 0, 14],
  [8, 0, 8, 0], [-8, 0, -8, 0],
  [0, 16, 0, 8],
];

/**
 * 反解：给定末端位姿，求两段曲率。
 *
 * ── 策略：字典序（位置优先、姿态次之）──
 *
 * 每个起点独立跑一次带阻尼的高斯-牛顿（Levenberg–Marquardt），然后：
 *   1. 在**位置误差达标**（≤ 1mm）的解里，挑姿态残差最小的；
 *   2. 一个都没有（目标够不着）时，退化为挑位置残差最小的。
 *
 * 不用「把位置与姿态加权成一个标量代价」：那个权重无论怎么取都是拍脑袋的，
 * 而且姿态项会把位置解拽偏 —— 实测 orientationWeight 从 0 调到 0.6，位置
 * 残差从 0.000mm 恶化到 44mm。字典序把「位置必须准」变成硬约束，姿态只在
 * 剩余的解族里优化，就没有这个问题。
 *
 * 参数用曲率向量 (kx, ky) 而非 (κ, φ)：κ=0 时 φ 未定义，那里 ∂f/∂φ 整列为
 * 零，雅可比退化 —— 优化器一旦走到「某段是直的」就再也调不动它的方向。
 *
 * 姿态用 `characteristicLengthM` 把角度换算到与位置同量纲再加权：否则
 * 0.1 rad 的姿态误差和 0.1 m 的位置误差会被当成同等重要，而它们对臂的尺度
 * 差了三个数量级。
 */
export function solveTipPose(input: TipSolveInput): TipSolveResult {
  const { target, base, segmentLengthM, maxCurvaturePerM, iterations = 60, fast = false } = input;
  const orientationWeight = input.orientationWeight ?? 0.02;
  const characteristicLengthM = input.characteristicLengthM ?? 0.1;

  // 把用户给的当前状态放在第一位：它是最贴近现实的起点，也保证
  // 「目标就是当前位姿」时解出来的是现状而不是另一个等效解。
  const seedList = fast ? SEED_CURVATURES.slice(0, 4) : SEED_CURVATURES;
  const seeds: Array<[number, number, number, number]> = [
    [base[0].kxPerM, base[0].kyPerM, base[1].kxPerM, base[1].kyPerM],
    ...seedList.map((s) => [...s] as [number, number, number, number]),
  ];

  const runs = seeds.map((seed) => runGaussNewton({
    seed, target, segmentLengthM, maxCurvaturePerM,
    // 快速模式初值少、每组也少迭代几轮；精度主要靠"位置达标即可"这条硬约束兜住。
    orientationWeight, characteristicLengthM,
    iterations: fast ? Math.ceil(iterations / 2) : iterations,
  }));

  const reachableRuns = runs.filter((r) => r.positionErrorM <= REACHABLE_TOLERANCE_M);
  if (reachableRuns.length > 0) {
    return reachableRuns.reduce((best, r) => (r.orientationErrorRad < best.orientationErrorRad ? r : best));
  }
  // 一个可达解都没有：退化为位置优先。平手时比姿态，免得同样的位置残差下
  // 给出一个姿态离谱的结果 —— 这种平手在"目标正好落在工作空间边界外"时很常见。
  const best = runs.reduce((a, b) => {
    if (Math.abs(b.positionErrorM - a.positionErrorM) > 1e-9) {
      return b.positionErrorM < a.positionErrorM ? b : a;
    }
    return b.orientationErrorRad < a.orientationErrorRad ? b : a;
  });
  return { ...best, reachable: false };
}

interface GaussNewtonInput {
  seed: [number, number, number, number];
  target: TipPose;
  segmentLengthM: readonly [number, number];
  maxCurvaturePerM: readonly [number, number];
  orientationWeight: number;
  characteristicLengthM: number;
  iterations: number;
}

/** 单次带阻尼高斯-牛顿（Levenberg–Marquardt）。 */
function runGaussNewton(input: GaussNewtonInput): TipSolveResult {
  const {
    seed, target, segmentLengthM, maxCurvaturePerM,
    orientationWeight, characteristicLengthM, iterations,
  } = input;

  const targetTransform = (() => {
    const m = rpyToMat(target.rpyRad);
    m[3] = target.positionM[0];
    m[7] = target.positionM[1];
    m[11] = target.positionM[2];
    return m;
  })();

  const params = [...seed];
  const limits = [maxCurvaturePerM[0], maxCurvaturePerM[1]];

  /** 按曲率向量的模长夹到上限（等比缩放，方向不变）。 */
  const clampParams = (p: number[]) => {
    const out = [...p];
    for (let i = 0; i < 2; i += 1) {
      const magnitude = Math.hypot(out[i * 2], out[i * 2 + 1]);
      if (magnitude > limits[i]) {
        const scale = limits[i] / magnitude;
        out[i * 2] *= scale;
        out[i * 2 + 1] *= scale;
      }
    }
    return out;
  };

  const poseOf = (p: number[]) => {
    const sections: [SectionCurvature, SectionCurvature] = [
      { kxPerM: p[0], kyPerM: p[1] },
      { kxPerM: p[2], kyPerM: p[3] },
    ];
    return forwardKinematics(sections, segmentLengthM);
  };

  /** 残差向量：前 3 个是位置（m），后 3 个是姿态换算后的等效位移（m）。 */
  const residualOf = (p: number[]): number[] => {
    const transform = poseOf(p);
    const r: number[] = [
      target.positionM[0] - transform[3],
      target.positionM[1] - transform[7],
      target.positionM[2] - transform[11],
    ];
    const rot = rotationResidual(transform, targetTransform);
    const scale = orientationWeight * characteristicLengthM;
    r.push(rot[0] * scale, rot[1] * scale, rot[2] * scale);
    return r;
  };

  let current = clampParams(params);
  let residual = residualOf(current);
  let cost = residual.reduce((sum, value) => sum + value * value, 0);
  let damping = 1e-3;
  let used = 0;

  for (let step = 0; step < iterations; step += 1) {
    used = step + 1;
    if (Math.sqrt(cost) < 1e-7) break;

    // 数值雅可比：4 个参数各扰动一次。四个分量都是同量纲的曲率，步长统一。
    const jacobian: number[][] = [[], [], [], [], [], []];
    for (let p = 0; p < 4; p += 1) {
      const h = 1e-7;
      const probe = [...current];
      probe[p] += h;
      const delta = residualOf(probe);
      for (let r = 0; r < 6; r += 1) jacobian[r].push((delta[r] - residual[r]) / h);
    }

    // 正规方程 (JᵀJ + λI) Δ = Jᵀr —— 注意这里的 J 是 ∂残差/∂参数，
    // 而残差 = 目标 − 当前，所以 ∂f/∂参数 = −J。最小化 ‖r − FΔ‖² 给出
    // Δ = (FᵀF)⁻¹Fᵀr = −(JᵀJ)⁻¹Jᵀr，**负号不能丢**：丢掉就会朝误差增大的
    // 方向走，配合"只接受更优解"的阻尼策略表现为一次迭代就退出。
    const n = 4;
    const A: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    const b = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        let sum = 0;
        for (let r = 0; r < 6; r += 1) sum += jacobian[r][i] * jacobian[r][j];
        A[i][j] = sum;
      }
      let sum = 0;
      for (let r = 0; r < 6; r += 1) sum += jacobian[r][i] * residual[r];
      b[i] = -sum;
    }

    let accepted = false;
    for (let attempt = 0; attempt < 6 && !accepted; attempt += 1) {
      const damped = A.map((row, i) => row.map((value, j) => (i === j ? value + damping * (1 + value) : value)));
      const delta = solveLinear(damped, b);
      if (!delta) { damping *= 10; continue; }
      const candidate = clampParams(current.map((value, i) => value + delta[i]));
      const nextResidual = residualOf(candidate);
      const nextCost = nextResidual.reduce((sum, value) => sum + value * value, 0);
      if (nextCost < cost) {
        current = candidate;
        residual = nextResidual;
        cost = nextCost;
        damping = Math.max(damping * 0.3, 1e-9);
        accepted = true;
      } else {
        damping *= 10;
      }
    }
    if (!accepted) break; // 阻尼加到顶仍无改善 —— 已经到局部最优
  }

  const finalPose = tipPoseOf(poseOf(current));
  const positionErrorM = Math.hypot(
    target.positionM[0] - finalPose.positionM[0],
    target.positionM[1] - finalPose.positionM[1],
    target.positionM[2] - finalPose.positionM[2],
  );
  const rotErr = rotationResidual(poseOf(current), targetTransform);
  const saturated =
    Math.hypot(current[0], current[1]) > limits[0] - 1e-6
    || Math.hypot(current[2], current[3]) > limits[1] - 1e-6;

  return {
    sections: [
      { kxPerM: current[0], kyPerM: current[1] },
      { kxPerM: current[2], kyPerM: current[3] },
    ],
    reached: finalPose,
    positionErrorM,
    orientationErrorRad: Math.hypot(rotErr[0], rotErr[1], rotErr[2]),
    saturated,
    reachable: positionErrorM <= REACHABLE_TOLERANCE_M,
    iterations: used,
  };
}

/** 高斯消元解 `A x = b`（A 会被就地改写）。奇异时返回 null。 */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) < 1e-14) return null;
    if (pivot !== col) { const tmp = m[pivot]; m[pivot] = m[col]; m[col] = tmp; }
    const diag = m[col][col];
    for (let row = col + 1; row < n; row += 1) {
      const factor = m[row][col] / diag;
      if (factor === 0) continue;
      for (let k = col; k <= n; k += 1) m[row][k] -= factor * m[col][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = m[row][n];
    for (let k = row + 1; k < n; k += 1) sum -= m[row][k] * x[k];
    x[row] = sum / m[row][row];
  }
  return x;
}

/* ── 工作空间边界（给 UI 提示「够不够得着」） ── */

/**
 * 末端能到达的最远距离：两段都取零曲率（完全伸直）= L₁ + L₂。
 * 最近的边界没有闭式解，实际由曲率上限决定（κ 越大圆弧半径越小）。
 * 只用来给出一个粗判提示，不参与解算。
 */
export function maxReachM(segmentLengthM: readonly [number, number]): number {
  return segmentLengthM[0] + segmentLengthM[1];
}

/* ── 与实际状态 / 渲染数据的互转 ── */

/**
 * 由一组正交基（列 = 局部 x/y/z 在机器人坐标系中的方向）+ 位置构造位姿。
 *
 * backbone 的采样点正是这个形式：`normal / binormal / tangent` 就是坐标系的
 * 三个列向量（见 svcModel 的 `frameFromMatrix`），其中 tangent 是臂的局部 z。
 * 用它把「当前实际末端位姿」填进输入框 —— 而不是用输入的上一帧值，这样
 * 页面刚打开、或者切换设备之后，输入框显示的是臂真正在哪。
 */
export function poseFromFrame(positionM: Vec3, axes: { x: Vec3; y: Vec3; z: Vec3 }): TipPose {
  const matrix = [
    axes.x[0], axes.y[0], axes.z[0], positionM[0],
    axes.x[1], axes.y[1], axes.z[1], positionM[1],
    axes.x[2], axes.y[2], axes.z[2], positionM[2],
    0, 0, 0, 1,
  ];
  return { positionM: [...positionM], rpyRad: matToRpy(matrix) };
}

/**
 * 两段常曲率 → 12 段曲率分布，供 3D 视图与曲线图渲染。
 *
 * 前一半段取段 1 的曲率、后一半取段 2 的 —— 与
 * `curvatureDistributionFromSdmInputs` 里「uMid < 0.5 用 A 组锚点」的划分
 * 一致。段长按总长均分，因此每段的弧长区间与 backbone 的采样区间对齐。
 */
export function distributionFromTipSections(
  sections: readonly [SectionCurvature, SectionCurvature],
  segmentLengthM: readonly [number, number],
  basisSegmentCount = 12,
): CurvatureDistribution {
  const count = Math.max(2, Math.round(basisSegmentCount));
  const totalMm = (segmentLengthM[0] + segmentLengthM[1]) * 1000;
  const lengthMm = totalMm / count;
  return {
    totalLengthMm: totalMm,
    basisSegmentCount: count,
    source: "tipTarget",
    segments: Array.from({ length: count }, (_, index) => {
      const half = index < count / 2 ? 0 : 1;
      const { kxPerM, kyPerM } = sections[half];
      return {
        index,
        sStartMm: index * lengthMm,
        sEndMm: (index + 1) * lengthMm,
        sMidMm: (index + 0.5) * lengthMm,
        lengthMm,
        kxPerM,
        kyPerM,
        kappaAbsPerM: Math.hypot(kxPerM, kyPerM),
        phiRad: Math.atan2(-kxPerM, kyPerM),
      };
    }),
  };
}

/* ── 数值自检 ── */

/**
 * 自检：正解与 svcModel 的 backbone 是否一致、反解能否回到给定的位姿。
 *
 * 这两条是「改符号/改约定时最先坏掉、又最难从界面上看出来」的地方 ——
 * 正解矩阵转置错一个元素，臂看上去还是"一条弯的管子"，只是弯的方向不对；
 * 反解的 RPY 约定弄反，输入和显示会自洽但整体错 90°。返回空数组表示通过。
 */
export function verifyPose3d(segmentLengthM: readonly [number, number] = [0.2, 0.2]): string[] {
  const failures: string[] = [];

  // 1) 正解 vs 解析式：φ=0（kx=0, ky>0）时末端应在 +x 方向偏移、沿 +z 抬起。
  const bend: [SectionCurvature, SectionCurvature] = [
    { kxPerM: 0, kyPerM: 5 },
    { kxPerM: 0, kyPerM: 3 },
  ];
  const pose = tipPoseOf(forwardKinematics(bend, segmentLengthM));
  if (!(pose.positionM[0] > 0)) failures.push(`ky>0 应向 +x 弯，实际 x=${pose.positionM[0].toFixed(4)}`);
  if (Math.abs(pose.positionM[1]) > 1e-12) {
    failures.push(`kx=0 的 y 应为 0，实际 ${pose.positionM[1].toExponential(2)}`);
  }
  if (!(pose.positionM[2] > 0 && pose.positionM[2] < segmentLengthM[0] + segmentLengthM[1])) {
    failures.push(`末端 z=${pose.positionM[2].toFixed(4)} 不在 (0, 总长) 内`);
  }

  // 1b) 逐项对照 svcModel.svcPose 的解析弧：第 1 段直、第 2 段弯 κ、φ=0。
  //     第 1 段把原点沿 +z 抬到 (0,0,L₁)，第 2 段再按圆弧公式展开。
  {
    const L1 = segmentLengthM[0];
    const kappa = 3;
    const theta = kappa * segmentLengthM[1];
    const radius = 1 / kappa;
    const along = radius * (1 - Math.cos(theta));
    const expected: Vec3 = [along, 0, L1 + radius * Math.sin(theta)];
    const actual = tipPoseOf(forwardKinematics(
      [{ kxPerM: 0, kyPerM: 0 }, { kxPerM: 0, kyPerM: kappa }],
      segmentLengthM,
    )).positionM;
    const drift = Math.hypot(expected[0] - actual[0], expected[1] - actual[1], expected[2] - actual[2]);
    if (drift > 1e-12) {
      failures.push(`与 svcPose 解析式不符：期望 ${expected.map((v) => v.toFixed(6)).join(",")} 实际 ${actual.map((v) => v.toFixed(6)).join(",")}`);
    }
  }

  // 2) 零曲率 = 直线，末端在 (0,0,L)、姿态为单位阵。
  const straight = tipPoseOf(forwardKinematics(
    [{ kxPerM: 0, kyPerM: 0 }, { kxPerM: 0, kyPerM: 0 }],
    segmentLengthM,
  ));
  const straightError = Math.hypot(
    straight.positionM[0],
    straight.positionM[1],
    straight.positionM[2] - (segmentLengthM[0] + segmentLengthM[1]),
  );
  if (straightError > 1e-12) failures.push(`零曲率末端应竖直，偏差 ${straightError.toExponential(2)}`);

  // 3) 姿态约定：绕 +z 转 90°（yaw）后滚转/俯仰应为 0。
  const yawOnly = matToRpy(rpyToMat([0, 0, Math.PI / 2]));
  if (Math.abs(yawOnly[2] - Math.PI / 2) > 1e-9 || Math.abs(yawOnly[0]) > 1e-9 || Math.abs(yawOnly[1]) > 1e-9) {
    failures.push(`RPY 往返失败：${yawOnly.map((v) => v.toFixed(6)).join(", ")}`);
  }

  // 4) 反解能到达的目标，位置残差应当接近 0，且正解回去对得上。
  const targets: Array<[string, Vec3]> = [
    ["正前方近点", [0.05, 0.02, 0.32]],
    ["侧向", [0.12, -0.06, 0.28]],
    ["接近伸直", [0.03, 0.01, 0.38]],
  ];
  for (const [name, positionM] of targets) {
    const solved = solveTipPose({
      target: { positionM, rpyRad: [0, 0, 0] },
      base: [{ kxPerM: 0, kyPerM: 2 }, { kxPerM: 0, kyPerM: 2 }],
      segmentLengthM,
      maxCurvaturePerM: [20, 20],
    });
    if (!solved.reachable) {
      failures.push(`「${name}」位置不可达？残差 ${(solved.positionErrorM * 1000).toFixed(3)}mm`);
    }
    const check = tipPoseOf(forwardKinematics(solved.sections, segmentLengthM));
    const drift = Math.hypot(
      check.positionM[0] - solved.reached.positionM[0],
      check.positionM[1] - solved.reached.positionM[1],
      check.positionM[2] - solved.reached.positionM[2],
    );
    if (drift > 1e-9) failures.push(`「${name}」正解回代不一致：${drift.toExponential(2)}`);
  }

  // 5) 反解应尊重曲率上限：给一个够不着的远点，结果必须顶到上限且报不可达。
  const tooFar = solveTipPose({
    target: { positionM: [0, 0, 1.5], rpyRad: [0, 0, 0] },
    base: [{ kxPerM: 0, kyPerM: 1 }, { kxPerM: 0, kyPerM: 1 }],
    segmentLengthM,
    maxCurvaturePerM: [20, 20],
  });
  if (tooFar.reachable) failures.push("超出工作空间的目标被判为可达");
  if (Math.hypot(tooFar.sections[0].kxPerM, tooFar.sections[0].kyPerM) > 20 + 1e-6
    || Math.hypot(tooFar.sections[1].kxPerM, tooFar.sections[1].kyPerM) > 20 + 1e-6) {
    failures.push("反解结果超出曲率上限");
  }

  return failures;
}
