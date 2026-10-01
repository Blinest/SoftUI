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









/* ── 工作空间边界（给 UI 提示「够不够得着」） ── */


/* ── 与实际状态 / 渲染数据的互转 ── */



/* ── 数值自检 ── */

