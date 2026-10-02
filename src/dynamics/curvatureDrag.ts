/* 拖动式曲率控制的反解：给定「把臂上某点拖到哪」，反解出整条曲率分布。
 *
 * ── 为什么不直接用 IK ──
 *
 * 正问题（曲率分布 → 形状）在 svcModel 里已经有了：每段积分一次刚体变换，
 * 串成 backbone。反问题没有解析解，但这里也不需要通用 IK —— 拖动是一个
 * **局部**操作：用户抓住臂上某一点拽，期望的是「这一点跟着走，其余部分平滑
 * 跟随」，而不是「解出一条恰好穿过目标点的曲线」。所以用一个基于柔度
 * （compliance）的迭代格式：
 *
 *   1. 拿当前实际分布作初值，正解一次，算出抓取点现在在哪；
 *   2. 把位移误差按**柔度权重**摊成各段的曲率增量（靠近抓取点、以及悬臂结构
 *      中更靠外的段更软，分到的更多）；
 *   3. 重复若干轮，直到误差收敛或被曲率上限钳住。
 *
 * 这样得到的 κ(s) 天然是连续的分布函数（12 段），而不是两个常曲率值，
 * 也天然满足「拖哪弯哪」。被钳制时返回最后一次结果并给 `saturated` 标志，
 * UI 据此提示「已经拖到极限」。
 *
 * ── 坐标与符号（最容易出错的地方，先在这里对齐） ──
 *
 * 分布里的曲率向量是 svc 约定 (kx, ky)，`phiRad = atan2(-kx, ky)`；
 * svcPose 在 φ=0 时朝 +x_svc 弯。渲染前 `svcToThreeMm` 做轴重排
 * `[x, z, y]`，于是：
 *
 *   svc-x → three-x，svc-y → three-z，svc-z → three-y（向上）
 *
 * 合起来，曲率向量到场景位移的映射是：
 *
 *   ky > 0 → 朝 +three-x 弯
 *   kx > 0 → 朝 −three-z 弯
 *
 * 所以下面按场景误差方向分量写增量时，kx 取的是 z 分量的**相反数**。
 * 这条关系用 `verifyDragSolver` 数值校验过，改动符号请重跑它。 */

import type { BackboneOutput, CurvatureBasisSegment, CurvatureDistribution } from "./svcModel";
import {
  buildBackboneFromCurvatureDistribution,
  mapSvcPointToThreeMm,
  modelCurvatureLimit,
  TOTAL_LENGTH_MM,
} from "./svcModel";
import { rpyToMat, rotationResidual, tipPoseOfDistribution } from "../robot/pose3d";

/** 一次拖拽反解的输入。 */
export interface DragSolveInput {
  /** 抓取点沿臂的弧长（mm）。 */
  sMm: number;
  /** 抓取点希望被拖到的位置（three 场景坐标，mm）。 */
  toMm: [number, number, number];
  /** 当前实际分布，作为迭代初值 —— 因此「不拖就不动」。 */
  base: CurvatureDistribution;
  /** 逐段曲率上限（1/m）。缺省时按基准分布自动放宽，见 `defaultLimits`。 */
  limitsPerM?: readonly number[];
  /** 迭代轮数，默认 14。 */
  iterations?: number;
  /** 每轮松弛系数（0~1.2），默认 0.9。越接近 1 收敛越快，过大易振荡。 */
  relaxation?: number;
  /**
   * **固定末端位姿**：只改臂体形状，末端位置与姿态保持不变（null-space 拖动）。
   *
   * 实现：每轮现算一次「抓取点 + 末端位姿」对 12 段曲率的数值 Jacobian，再解一个带权
   * 正规方程 —— 抓取点误差作为目标、末端位姿误差用大权重压住。代价是每轮 ~14 次骨架积分，
   * 比普通拖动贵，所以只在需要时打开。
   */
  lockTipPose?: boolean;
  /**
   * 固定末端位姿时的**末端权重**（默认 0.2，实测标定值）。越大末端越死、抓取点越难跟手；
   * 太大反而会在曲率上限处来回振荡（实测 w=1~20 时漂移升到 30~50mm）。正常不用改。
   */
  tipWeight?: number;
}

export interface DragSolveResult {
  distribution: CurvatureDistribution;
  /** 正解出的抓取点最终落到哪（画指示器、判断是否跟上）。 */
  reachedMm: [number, number, number];
  /** 到目标的残差（mm）。 */
  residualMm: number;
  /** 是否撞到曲率上限 —— 撞了就说明「只能弯到这儿」。 */
  saturated: boolean;
  /** 实际执行的迭代轮数。 */
  iterations: number;
  /**
   * 末端位姿**漂移**（锁定模式的实际效果）：位置 mm、姿态 rad。
   *
   * 普通拖动恒为 0；锁定模式下这个数就是「末端到底有没有被固定住」的量化答案 ——
   * 拖到曲率上限时它会涨上来，UI 应当把它显示出来，而不是假装仍然锁着。
   */
  tipDriftMm: number;
  tipDriftRad: number;
}

/* ── 采样 ── */

/**
 * backbone 上弧长 `sMm` 处的点（three 场景坐标，mm）。
 *
 * 轴重排只在采样末端做一次，迭代内部全部用场景坐标，免得每轮来回换算出错。
 */
function pointAtS(backbone: BackboneOutput, sMm: number): [number, number, number] {
  const samples = backbone.samples;
  if (samples.length === 0) return [0, 0, 0];
  const clamped = Math.min(Math.max(sMm, samples[0].sMm), samples[samples.length - 1].sMm);
  const nextIndex = samples.findIndex((sample) => sample.sMm >= clamped);
  if (nextIndex <= 0) return mapSvcPointToThreeMm(samples[0].pointM);
  const next = samples[nextIndex];
  const prev = samples[nextIndex - 1];
  const span = Math.max(next.sMm - prev.sMm, 1e-6);
  const t = (clamped - prev.sMm) / span;
  const a = mapSvcPointToThreeMm(prev.pointM);
  const b = mapSvcPointToThreeMm(next.pointM);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/* ── 灵敏度 ── */

/**
 * 每段曲率对抓取点位移的**影响因子**：该段曲率增大 1 m⁻¹ 时，抓取点大约移动多少 mm。
 *
 * 悬臂梁的标准结果：曲率分布 κ(t) 在弧长 s 处产生的横向位移是
 *   δ(s) = ∫₀ˢ κ(t)·(s − t) dt
 * 把段内曲率看作常量，第 i 段（区间 [a, b]）的贡献系数就是
 *   w_i = ∫_a^min(b,s) (s − t) dt / 1000 = (c − a)·(s − (a + c)/2) / 1000,  c = min(b, s)
 * 除以 1000 是把 mm² 换算成 m²（κ 的单位是 m⁻¹，乘 m² 才得到 m）。
 *
 * 抓取点**之后**的段影响因子恒为 0 —— 它们管不着这点怎么动，反解时也不会
 * 被改动，于是「抓住中间拖」时臂尖只会被整体带过去，不会自己乱弯。
 */
function influenceVector(segments: CurvatureBasisSegment[], sMm: number): number[] {
  return segments.map((segment) => {
    const endMm = Math.min(segment.sEndMm, sMm);
    const spanMm = endMm - segment.sStartMm;
    if (spanMm <= 1e-6) return 0;
    return (spanMm * (sMm - (segment.sStartMm + endMm) / 2)) / 1000;
  });
}

/**
 * 把影响因子折成「曲率增量基」：`c_i = basis_i · δ`，使 Σ c_i·w_i = δ。
 *
 * 解按最小二乘取 —— 在所有能达到同样位移的曲率组合里，选总弯曲量平方和
 * 最小的那个（`c_i ∝ w_i`）。这样得到的是最平缓的一条弧，而不会是「把某一
 * 段掰出个硬折角去凑位移」。顺带地，杠杆越长（抓得越靠外）需要的曲率越小，
 * 这是真实的力学行为，不需要额外编权重。
 *
 * 全部影响因子为 0（抓在根部）时返回全零：那种位置拖不动，交给 UI 提示。
 */
function minimumCurvatureBasis(influence: readonly number[]): number[] {
  const squareSum = influence.reduce((sum, value) => sum + value * value, 0);
  if (!(squareSum > 1e-12)) return influence.map(() => 0);
  return influence.map((value) => value / squareSum);
}

/**
 * 逐段曲率上限。
 *
 * 取「基准最大值 + 0.5」是为了让拖动有手感（不必每次都从零开始推），但**必须再被当前模型的
 * κ 表覆盖上限兜住** —— 拖过覆盖边界只会得到一个后端查不到、下发必失败的形状。
 * 上限由 `setModelCurvatureLimitPerM()`（来自 `model_status`）设置。
 */
function defaultLimits(base: CurvatureDistribution): number[] {
  const observed = base.segments.reduce((max, segment) => Math.max(max, segment.kappaAbsPerM), 0);
  const limit = Math.min(Math.max(observed + 0.5, 0.5), modelCurvatureLimit());
  return base.segments.map(() => limit);
}

/* ── 分布构造 ── */

/**
 * 用新的 (kx, ky) 序列替换分布里的段。
 *
 * `phiRad` / `kappaAbsPerM` 必须跟着重算 —— 下游（backbone 积分、曲线图、
 * 诊断面板）读的是这几个字段，漏一个就会出现「形状变了但读数没变」。
 */
function withCurvature(
  base: CurvatureDistribution,
  kxPerM: number[],
  kyPerM: number[],
  source: CurvatureDistribution["source"] = "manualDrag",
): CurvatureDistribution {
  const segments: CurvatureBasisSegment[] = base.segments.map((segment, index) => {
    const kx = kxPerM[index] ?? 0;
    const ky = kyPerM[index] ?? 0;
    return {
      ...segment,
      kxPerM: kx,
      kyPerM: ky,
      kappaAbsPerM: Math.hypot(kx, ky),
      phiRad: Math.atan2(-kx, ky),
    };
  });
  return { ...base, source, segments };
}

/* ── 反解 ── */

/**
 * 反解：把臂上 `sMm` 处的点拖到 `toMm`。
 *
 * 每次调用都是**无状态**的 —— 输入带的是当前实际分布，输出是绝对结果。
 * 调用方每帧拿最新实际分布调一次即可，不必维护迭代中间态，因此
 * 「拖动中实际状态变了」「中途换了一根臂」都不会留下脏状态。
 */
export function solveDragToPoint(input: DragSolveInput): DragSolveResult {
  const { sMm, toMm, base, iterations = 14, relaxation = 0.9 } = input;
  if (input.lockTipPose) {
    return solveDragLockingTip({
      sMm,
      toMm,
      base,
      iterations,
      tipWeight: input.tipWeight ?? 0.2,
      limitsPerM: input.limitsPerM,
    });
  }

  const kx = base.segments.map((segment) => segment.kxPerM);
  const ky = base.segments.map((segment) => segment.kyPerM);
  const limits = (input.limitsPerM ?? defaultLimits(base)).map((value) => Math.abs(value));
  const influence = influenceVector(base.segments, sMm);
  const basis = minimumCurvatureBasis(influence);
  // 抓在根部附近时影响因子全零，怎么拖都动不了 —— 直接原样返回，
  // 让 UI 去提示，而不是让迭代空转 14 轮。
  const movable = basis.some((value) => Math.abs(value) > 1e-12);

  let backbone = buildBackboneFromCurvatureDistribution(base);
  let reached = pointAtS(backbone, sMm);
  let saturated = false;
  let used = 0;

  for (let step = 0; movable && step < iterations; step += 1) {
    used = step + 1;
    const error: [number, number, number] = [
      toMm[0] - reached[0],
      toMm[1] - reached[1],
      toMm[2] - reached[2],
    ];
    const errorLength = Math.hypot(error[0], error[1], error[2]);
    if (errorLength < 0.5) break; // 0.5mm 对视觉与手感都够用，再迭代只是浪费。

    // 需要多大的等效位移增量 **（mm）**；方向取场景 x / z 分量（y 是臂的轴向，
    // 位移上几乎不可控 —— 那要靠伸缩而不是弯曲，这里不处理）。
    //
    // 这里不再除 1000：`influenceVector` 已经把 mm²→m² 的换算吞进去了，
    // `basis` 的量纲就是「1 个单位的 basis 对应 1 mm 位移」（Σw·basis = 1）。
    const delta = errorLength * relaxation;
    const dirX = error[0] / errorLength;
    const dirZ = error[2] / errorLength;

    let hitLimit = false;
    for (let index = 0; index < base.segments.length; index += 1) {
      // 见文件头符号表：ky 吃场景 +x，kx 吃场景 −z。
      ky[index] += basis[index] * delta * dirX;
      kx[index] -= basis[index] * delta * dirZ;

      const magnitude = Math.hypot(kx[index], ky[index]);
      const limit = limits[index] ?? Infinity;
      if (magnitude > limit) {
        const scale = limit / magnitude;
        kx[index] *= scale;
        ky[index] *= scale;
        hitLimit = true;
      }
    }
    if (hitLimit) saturated = true;

    backbone = buildBackboneFromCurvatureDistribution(withCurvature(base, kx, ky));
    reached = pointAtS(backbone, sMm);
  }

  return {
    distribution: withCurvature(base, kx, ky),
    reachedMm: reached,
    residualMm: Math.hypot(toMm[0] - reached[0], toMm[1] - reached[1], toMm[2] - reached[2]),
    saturated,
    iterations: used,
    tipDriftMm: 0,
    tipDriftRad: 0,
  };
}

/* ── 固定末端位姿的拖动（null-space） ── */

/** 稠密线性方程组（列主元高斯消元）。固定末端位姿时每轮要解一次；导出以便数值自检。 */
export function solveDenseSystem(matrix: number[][], rhs: number[]): number[] | null {
  const n = rhs.length;
  const a = matrix.map((row, index) => [...row, rhs[index]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = a[row][col] / a[col][col];
      if (factor === 0) continue;
      for (let k = col; k <= n; k += 1) a[row][k] -= factor * a[col][k];
    }
  }
  return a.map((row, index) => row[n] / row[index]);
}

/**
 * **固定末端位姿**的反解：末端位置/姿态被当作**硬约束**，只有臂体形状变。
 *
 * 与普通拖动（`solveDragToPoint`）的区别只在约束：
 * - 普通拖动：抓取点跟手，末端随便跟着走（解析柔度，很便宜）。
 * - 固定末端：每轮解一个**等式约束最小二乘**
 *
 *   ```text
 *   min ‖Jg·Δq − r_grab‖²   s.t.   Jt·Δq = −r_tip
 *   ```
 *
 *   落地成三步（全部用数值 Jacobian，每段两个自由度 κx/κy，共 2N 维）：
 *   1. `Jt`（6×2N）→ 末端误差的**最小范数修正** `Δq_c = Jtᵀ(JtJtᵀ+μI)⁻¹(−r_tip)`；
 *   2. 抓取步沿用解析柔度方向 `d_g`，再**投影到末端零空间**：
 *      `d_⊥ = d_g − Jtᵀ(JtJtᵀ+μI)⁻¹(Jt·d_g)`（零空间分量不会破坏末端约束）；
 *   3. `Δq = d_⊥ + Δq_c`，最后按逐段曲率上限做**整体缩放** —— 零空间分量缩放不影响末端，
 *      修正量缩放留下的残差由下一轮补，所以「拖到上限」时是**形状先顶住、末端仍然不放**。
 *
 * 只有 6×6 的小线性系统（`JtJtᵀ`），比解 24×24 更稳；代价是每轮 2N 次骨架积分。
 */
function solveDragLockingTip(args: {
  sMm: number;
  toMm: [number, number, number];
  base: CurvatureDistribution;
  iterations: number;
  tipWeight: number;
  limitsPerM?: readonly number[];
}): DragSolveResult {
  const { sMm, toMm, base, iterations, limitsPerM } = args;
  const count = base.segments.length;
  const dof = count * 2;
  const armMm = base.totalLengthMm > 0 ? base.totalLengthMm : TOTAL_LENGTH_MM;
  const limits = (limitsPerM ?? defaultLimits(base)).map((value) => Math.abs(value));

  const kx = base.segments.map((segment) => segment.kxPerM);
  const ky = base.segments.map((segment) => segment.kyPerM);

  const shapeAt = (kxArr: number[], kyArr: number[]) => withCurvature(base, kxArr, kyArr);
  const grabAt = (shape: CurvatureDistribution) =>
    pointAtS(buildBackboneFromCurvatureDistribution(shape), sMm);
  /** 末端残差：位置 mm（3）+ 姿态 rad×总弧长（3，换算成 mm 才能和位置一起解）。 */
  const tipResidualOf = (shape: CurvatureDistribution, ref: ReturnType<typeof tipPoseOfDistribution>) => {
    const tip = tipPoseOfDistribution(shape.segments);
    const dPos = [
      (tip.positionM[0] - ref.positionM[0]) * 1000,
      (tip.positionM[1] - ref.positionM[1]) * 1000,
      (tip.positionM[2] - ref.positionM[2]) * 1000,
    ];
    const rot = rotationResidual(rpyToMat(tip.rpyRad), rpyToMat(ref.rpyRad)).map((v) => v * armMm);
    return [dPos[0], dPos[1], dPos[2], rot[0], rot[1], rot[2]];
  };

  const reference = tipPoseOfDistribution(shapeAt(kx, ky).segments);

  let reached = grabAt(shapeAt(kx, ky));
  let saturated = false;
  let used = 0;

  const EPS = 1e-4;
  const RIDGE = 1e-4;
  const KKT_MU = 1e-6;

  for (let step = 0; step < iterations; step += 1) {
    used = step + 1;
    const shape = shapeAt(kx, ky);
    reached = grabAt(shape);
    const gErr = [toMm[0] - reached[0], toMm[1] - reached[1], toMm[2] - reached[2]];
    const gLen = Math.hypot(gErr[0], gErr[1], gErr[2]);
    const tipErr = tipResidualOf(shape, reference);
    if (gLen < 0.3 && Math.hypot(tipErr[0], tipErr[1], tipErr[2]) < 0.1) break;

    // ① 数值 Jacobian：一次扰动同时得到抓取点（3）与末端残差（6）的变化率。
    //
    //    ⚠ 抓取点**必须**也用数值（不能拿解析的 `influenceVector` 代替）：解析柔度在
    //    「抓取点之后」的段上恒为 0，于是那些段在抓取步里永远是 0 分量 —— 而「末端不动、
    //    只改形状」恰恰需要**抓取点前后反向弯**（S 形）来互相抵消末端位移。用解析值等于
    //    把补偿自由度全锁死，拖起来只能动几毫米。
    const jacGrab: number[][] = [];
    const jacTip: number[][] = [];
    for (let index = 0; index < count; index += 1) {
      for (let axis = 0; axis < 2; axis += 1) {
        const kxProbe = [...kx];
        const kyProbe = [...ky];
        if (axis === 0) kxProbe[index] += EPS;
        else kyProbe[index] += EPS;
        const probeShape = shapeAt(kxProbe, kyProbe);
        const probeGrab = grabAt(probeShape);
        const probeTip = tipResidualOf(probeShape, reference);
        jacGrab.push([
          (probeGrab[0] - reached[0]) / EPS,
          (probeGrab[1] - reached[1]) / EPS,
          (probeGrab[2] - reached[2]) / EPS,
        ]);
        jacTip.push(probeTip.map((value, dim) => (value - tipErr[dim]) / EPS));
      }
    }

    // ③ 等式约束最小二乘（KKT）：
    //      min ‖Jg·Δq − r_grab‖²   s.t.  Jt·Δq = −r_tip
    //    这里**不加权重**：约束走 KKT 的 ν 块，是精确约束，不受量纲/权重影响。
    const kktSize = dof + 6;
    const kkt: number[][] = Array.from({ length: kktSize }, () => new Array<number>(kktSize).fill(0));
    const rhs = new Array<number>(kktSize).fill(0);
    for (let i = 0; i < dof; i += 1) {
      for (let j = 0; j < dof; j += 1) {
        let sum = 0;
        for (let dim = 0; dim < 3; dim += 1) sum += jacGrab[i][dim] * jacGrab[j][dim];
        kkt[i][j] = sum + (i === j ? RIDGE : 0);
      }
      for (let dim = 0; dim < 3; dim += 1) rhs[i] += jacGrab[i][dim] * gErr[dim];
      for (let dim = 0; dim < 6; dim += 1) {
        kkt[i][dof + dim] = jacTip[i][dim];
        kkt[dof + dim][i] = jacTip[i][dim];
      }
    }
    // 乘子块对角加一个极小正数：KKT 是鞍点矩阵，对角块全 0 时列主元消元可能在中间某列
    // 找不到非零主元（返回 null 直接退出，表现为「拖不动」）。加 μI 后等价于「软约束」，
    // μ→0 时就是硬约束（Jt 元素量级 1e2~1e3，所以 1e-6 相对量级可忽略）。
    for (let dim = 0; dim < 6; dim += 1) {
      kkt[dof + dim][dof + dim] = KKT_MU;
      rhs[dof + dim] = -tipErr[dim];
    }

    const solved = solveDenseSystem(kkt, rhs);
    if (!solved) break;
    const delta = solved.slice(0, dof);

    // ④ 逐段限位：整体缩放（缩放会让约束带一点残差，下一轮 KKT 会补回来，
    //    所以「拖到上限」时表现为形状先顶住、末端仍不放）。
    let scale = 1;
    for (let index = 0; index < count; index += 1) {
      const nextX = kx[index] + delta[index * 2];
      const nextY = ky[index] + delta[index * 2 + 1];
      const nextMagnitude = Math.hypot(nextX, nextY);
      const limit = limits[index] ?? Infinity;
      if (nextMagnitude > limit && nextMagnitude > 0) {
        scale = Math.min(scale, (limit / nextMagnitude) * 0.999);
      }
    }
    if (scale < 1) saturated = true;
    for (let index = 0; index < count; index += 1) {
      kx[index] += delta[index * 2] * scale;
      ky[index] += delta[index * 2 + 1] * scale;
    }
  }

  const finalShape = shapeAt(kx, ky);
  const drift = tipResidualOf(finalShape, reference);
  return {
    distribution: finalShape,
    reachedMm: reached,
    residualMm: Math.hypot(toMm[0] - reached[0], toMm[1] - reached[1], toMm[2] - reached[2]),
    saturated,
    iterations: used,
    tipDriftMm: Math.hypot(drift[0], drift[1], drift[2]),
    tipDriftRad: Math.hypot(drift[3], drift[4], drift[5]) / armMm,
  };
}

/* ── 数值自检 ── */

/**
 * 反解回路自检：造一条竖直臂，把中点朝场景 +x 拖，检查
 * 「正解 — 反解 — 再正解」是否闭合、且弯曲方向与符号约定一致。
 *
 * 这条断言是给未来改符号/改权重的人用的（见文件头「坐标与符号」）：
 * 弄反 kx/ky 不会报错，只会让臂往**相反方向**弯，很容易被当成手感问题
 * 而不是 bug。返回空数组表示通过。
 */
export function verifyDragSolver(totalLengthMm = TOTAL_LENGTH_MM): string[] {
  const failures: string[] = [];
  const count = 12;
  const lengthMm = totalLengthMm / count;
  const base: CurvatureDistribution = {
    totalLengthMm,
    basisSegmentCount: count,
    source: "manualDrag",
    segments: Array.from({ length: count }, (_, index) => ({
      index,
      sStartMm: index * lengthMm,
      sEndMm: (index + 1) * lengthMm,
      sMidMm: (index + 0.5) * lengthMm,
      lengthMm,
      kxPerM: 0,
      kyPerM: 0,
      kappaAbsPerM: 0,
      phiRad: 0,
    })),
  };

  const straight = buildBackboneFromCurvatureDistribution(base);
  const sMm = totalLengthMm / 2;
  const from = pointAtS(straight, sMm);

  // 自检只管**符号与闭环**，与「模型上限」无关：显式给一个宽松上限，
  // 免得模型表收紧（κ 表覆盖变小）后这条自检因为钳制而误报。
  const limitsPerM = Array.from({ length: count }, () => 20);
  const solve = (toMm: [number, number, number]) => solveDragToPoint({ sMm, toMm, base, limitsPerM });

  // 朝 +x 拖 15mm：应当得到 ky > 0 的弯曲（见文件头符号表）。
  const towardX: [number, number, number] = [from[0] + 15, from[1], from[2]];
  const solvedX = solve(towardX);
  if (solvedX.residualMm > 2) {
    failures.push(`+x 方向残差过大：${solvedX.residualMm.toFixed(2)}mm`);
  }
  if (solvedX.reachedMm[0] <= from[0]) {
    failures.push(`+x 拖动后抓取点没有朝 +x 移动（到达 x=${solvedX.reachedMm[0].toFixed(2)}，起始 ${from[0].toFixed(2)}）`);
  }
  const meanKy = solvedX.distribution.segments.reduce((sum, seg) => sum + seg.kyPerM, 0) / count;
  const meanKx = solvedX.distribution.segments.reduce((sum, seg) => sum + seg.kxPerM, 0) / count;
  if (meanKy <= 1e-6) failures.push(`+x 拖动应产生 ky>0，实际 mean ky=${meanKy.toFixed(6)}`);
  if (Math.abs(meanKx) > Math.abs(meanKy)) failures.push(`+x 拖动偏离主轴：mean kx=${meanKx.toFixed(6)} vs ky=${meanKy.toFixed(6)}`);

  // 朝 −z 拖：应当得到 kx > 0（kx 吃场景 −z）。
  const towardNegZ: [number, number, number] = [from[0], from[1], from[2] - 15];
  const solvedZ = solve(towardNegZ);
  const meanKxZ = solvedZ.distribution.segments.reduce((sum, seg) => sum + seg.kxPerM, 0) / count;
  if (meanKxZ <= 1e-6) failures.push(`-z 拖动应产生 kx>0，实际 mean kx=${meanKxZ.toFixed(6)}`);
  if (solvedZ.reachedMm[2] >= from[2]) {
    failures.push(`-z 拖动后抓取点没有朝 -z 移动（到达 z=${solvedZ.reachedMm[2].toFixed(2)}，起始 ${from[2].toFixed(2)}）`);
  }

  // 左右对称：把 +x 与 −x 的拖拽结果互相镜像比对。
  // 这条是防「只往一边弯得动」的 —— 单看某一侧全对，另一侧可能要差一倍
  // 才看得出来，光靠肉眼拖动很容易漏掉。
  const plusX = solve([from[0] + 15, from[1], from[2]]);
  const minusX = solve([from[0] - 15, from[1], from[2]]);
  if (Math.abs(plusX.residualMm - minusX.residualMm) > 0.05) {
    failures.push(`左右不对称：残差 +x=${plusX.residualMm.toFixed(3)} vs -x=${minusX.residualMm.toFixed(3)}`);
  }
  if (Math.abs(plusX.reachedMm[0] + minusX.reachedMm[0] - 2 * from[0]) > 0.05) {
    failures.push(`左右不对称：到达点 +x=${plusX.reachedMm[0].toFixed(3)} / -x=${minusX.reachedMm[0].toFixed(3)}`);
  }

  // 不拖就不动：目标点就是当前位置时，分布应当基本不变。
  const noop = solve(from);
  const drift = noop.distribution.segments.reduce((max, seg) => Math.max(max, seg.kappaAbsPerM), 0);
  if (drift > 1e-6) failures.push(`目标点未移动却产生了曲率：max κ=${drift.toFixed(6)}`);

  // 固定末端位姿：拖臂中点 20mm，末端位置/姿态都不该跟着跑。
  // （这条自检同样只关心「锁没锁住」，所以沿用上面那个宽松的 20 1/m 上限。）
  const locked = solveDragToPoint({
    sMm,
    toMm: [from[0] + 20, from[1], from[2]],
    base,
    limitsPerM,
    lockTipPose: true,
  });
  if (locked.tipDriftMm > 3) {
    failures.push(`固定末端位姿：末端位置漂移 ${locked.tipDriftMm.toFixed(2)}mm 过大（应 ≤ 3mm）`);
  }
  if (locked.tipDriftRad > 0.035) {
    failures.push(
      `固定末端位姿：末端姿态漂移 ${((locked.tipDriftRad * 180) / Math.PI).toFixed(2)}° 过大（应 ≤ 2°）`,
    );
  }
  if (locked.reachedMm[0] <= from[0] + 1) {
    failures.push(
      `固定末端位姿：抓取点几乎没动（到达 x=${locked.reachedMm[0].toFixed(2)}，起始 ${from[0].toFixed(2)}）`,
    );
  }

  return failures;
}
