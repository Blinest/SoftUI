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
import { buildBackboneFromCurvatureDistribution, mapSvcPointToThreeMm } from "./svcModel";

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

/** 逐段曲率上限：基准最大值 + 2 1/m，兜底 3 1/m（对应约 34° 的段弯曲角）。 */
function defaultLimits(base: CurvatureDistribution): number[] {
  const observed = base.segments.reduce((max, segment) => Math.max(max, segment.kappaAbsPerM), 0);
  const limit = Math.max(observed + 2, 3);
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
  };
}

/**
 * 由整个 backbone 直接反解（调用方只需给出抓取弧长与目标点）。
 */
export function targetDistributionFromDrag(
  actual: BackboneOutput,
  sMm: number,
  toMm: [number, number, number],
  options: Omit<DragSolveInput, "sMm" | "toMm" | "base"> = {},
): DragSolveResult {
  return solveDragToPoint({ ...options, sMm, toMm, base: actual.distribution });
}

/* ── 把 12 段分布折回硬件要的两段语义 ── */

export interface SectionEquivalents {
  /** 每段的等效常曲率（1/m），取该段曲率向量的积分模长 ÷ 段长。 */
  curvaturePerM: [number, number];
  /** 每段的等效弯曲方向（度，0 上 / 90 右 / 180 下 / 270 左）。 */
  directionDeg: [number, number];
  /** 协议层的方向码（0~3），与 directionDeg 同义。 */
  directionCode: [0 | 1 | 2 | 3, 0 | 1 | 2 | 3];
}

/**
 * 12 段曲率分布 → 两个「等效常曲率」。
 *
 * 硬件协议（`send_bend_command`）每段只吃一个角度 + 一个方向，所以下发前
 * 必须把分布折回两段。这里取的是**保持该段末端朝向不变**的等效值：
 * 先按弧长积分出该段的净转角向量，再除以段长还原成常曲率 —— 这正是
 * 常曲率圆弧与一般曲线在「端点切线」上等价的条件，也正是硬件两段命令
 * 唯一能表达的信息。
 *
 * 段边界取总长的中点，与 `curvatureDistributionFromSdmInputs` 里
 * 「uMid < 0.5 用 A 组锚点」的划分保持一致。
 */
export function sectionEquivalents(distribution: CurvatureDistribution): SectionEquivalents {
  const segments = distribution.segments;
  const total = segments.length > 0 ? segments[segments.length - 1].sEndMm : 0;
  const boundary = total / 2;

  const sum: Array<{ kx: number; ky: number; lengthMm: number }> = [
    { kx: 0, ky: 0, lengthMm: 0 },
    { kx: 0, ky: 0, lengthMm: 0 },
  ];

  for (const segment of segments) {
    // 段落在哪一半：用段中点判，避免边界段被两半各切一刀。
    const half = segment.sMidMm < boundary ? 0 : 1;
    const lengthMm = segment.sEndMm - segment.sStartMm;
    sum[half].kx += segment.kxPerM * lengthMm;
    sum[half].ky += segment.kyPerM * lengthMm;
    sum[half].lengthMm += lengthMm;
  }

  // 积分出的 (kx·L, ky·L) 单位是 m⁻¹·mm，除以段长（mm）还原成 m⁻¹。
  const curvaturePerM = sum.map(({ kx, ky, lengthMm }) =>
    lengthMm > 1e-9 ? Math.hypot(kx, ky) / lengthMm : 0) as [number, number];
  const directionRad = sum.map(({ kx, ky }) => Math.atan2(-kx, ky)) as [number, number];
  const directionDeg = directionRad.map((rad) => ((rad * 180) / Math.PI + 360) % 360) as [number, number];
  const directionCode = directionDeg.map((deg) => (Math.round(deg / 90) % 4) as 0 | 1 | 2 | 3) as [0 | 1 | 2 | 3, 0 | 1 | 2 | 3];

  return { curvaturePerM, directionDeg, directionCode };
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
export function verifyDragSolver(totalLengthMm = 400): string[] {
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

  // 朝 +x 拖 15mm：应当得到 ky > 0 的弯曲（见文件头符号表）。
  const towardX: [number, number, number] = [from[0] + 15, from[1], from[2]];
  const solvedX = solveDragToPoint({ sMm, toMm: towardX, base });
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
  const solvedZ = solveDragToPoint({ sMm, toMm: towardNegZ, base });
  const meanKxZ = solvedZ.distribution.segments.reduce((sum, seg) => sum + seg.kxPerM, 0) / count;
  if (meanKxZ <= 1e-6) failures.push(`-z 拖动应产生 kx>0，实际 mean kx=${meanKxZ.toFixed(6)}`);
  if (solvedZ.reachedMm[2] >= from[2]) {
    failures.push(`-z 拖动后抓取点没有朝 -z 移动（到达 z=${solvedZ.reachedMm[2].toFixed(2)}，起始 ${from[2].toFixed(2)}）`);
  }

  // 左右对称：把 +x 与 −x 的拖拽结果互相镜像比对。
  // 这条是防「只往一边弯得动」的 —— 单看某一侧全对，另一侧可能要差一倍
  // 才看得出来，光靠肉眼拖动很容易漏掉。
  const plusX = solveDragToPoint({ sMm, toMm: [from[0] + 15, from[1], from[2]], base });
  const minusX = solveDragToPoint({ sMm, toMm: [from[0] - 15, from[1], from[2]], base });
  if (Math.abs(plusX.residualMm - minusX.residualMm) > 0.05) {
    failures.push(`左右不对称：残差 +x=${plusX.residualMm.toFixed(3)} vs -x=${minusX.residualMm.toFixed(3)}`);
  }
  if (Math.abs(plusX.reachedMm[0] + minusX.reachedMm[0] - 2 * from[0]) > 0.05) {
    failures.push(`左右不对称：到达点 +x=${plusX.reachedMm[0].toFixed(3)} / -x=${minusX.reachedMm[0].toFixed(3)}`);
  }

  // 不拖就不动：目标点就是当前位置时，分布应当基本不变。
  const noop = solveDragToPoint({ sMm, toMm: from, base });
  const drift = noop.distribution.segments.reduce((max, seg) => Math.max(max, seg.kappaAbsPerM), 0);
  if (drift > 1e-6) failures.push(`目标点未移动却产生了曲率：max κ=${drift.toFixed(6)}`);

  return failures;
}
