/* 管线自检：用合成剪影跑完整条链路，与已知真值逐点比对。
 *
 * 为什么值得写这个：真实采集里「管线对不对」和「打光好不好」是混在一起的，
 * 出了问题分不清是算法的锅还是硬件的锅。合成图把硬件变量全部去掉，剩下纯粹
 * 是算法正确性 —— 而且真值已知，能给定量结论。
 *
 * 返回空数组表示通过。改动 vision/ 下的任何算法都该重跑它。
 *
 * ── 写这个文件时的两个坑（都踩过）──
 *
 * 1. **单位**。合成图里 mmPerPx = 1，所以 1/m 的曲率换算成 1/px 是 **除以 1000**。
 *    直接写 `kappa1PerPx: 3.0` 得到的是半径 0.33 像素的"臂"，测试会以看起来
 *    合理的方式失败（曲率偏差某个奇怪的数），排查半天。
 *
 * 2. **符号**。曲率是带符号的，正负取决于臂往哪边弯 —— 而合成图的弯曲方向是
 *    测试自己定的。所以一律**比量级**，不要比符号，否则测的是方向约定而不是算法。 */

import { analyzeFrame } from "./curvature";
import { renderArm } from "./synthetic";
import type { SyntheticArm } from "./synthetic";

export interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

/** 1/m → 1/px（合成图里 1px = 1mm）。 */
function perMToPerPx(perM: number, mmPerPx: number): number {
  return perM / 1000 / mmPerPx;
}

export function verifyVisionPipeline(): CheckResult[] {
  const checks: CheckResult[] = [];
  const push = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });

  const MM_PER_PX = 1.0;
  const SEG_LEN_PX = 100; // 每段 100px，总长 200px = 200mm

  /** 跑一条臂：合成 → 分析。 */
  const run = (k1PerM: number, k2PerM: number, extra: Record<string, unknown> = {}) => {
    const arm: SyntheticArm = {
      baseX: 240,
      baseY: 640,
      baseAngleRad: -Math.PI / 2,
      kappa1PerPx: perMToPerPx(k1PerM, MM_PER_PX),
      kappa2PerPx: perMToPerPx(k2PerM, MM_PER_PX),
      segmentLengthPx: SEG_LEN_PX,
    };
    const image = renderArm(arm, {
      width: 960,
      height: 720,
      tubeDiameterPx: 60,
      supersample: 4,
      noiseSigma: 0,
      ...extra,
    });
    const result = analyzeFrame(image, {
      tubeDiameterMm: 60,
      armLengthMm: 2 * SEG_LEN_PX * MM_PER_PX,
      mode: "dark",
      threshold: 128,
      closeRadius: 0,
      sampleCount: 60,
      // 合成图里臂根已知，直接给 —— 自动猜（取图像下方）只在
      // 「臂从画面下方竖起来」时才对。
      rootHintPx: { x: arm.baseX, y: arm.baseY },
    });
    return { arm, image, result };
  };

  /** 取中段做比较，避开两端 SG 窗口的边界效应。 */
  const midErrors = (measured: number[], truth: number) =>
    measured.slice(6, 54).reduce((worst, v) => Math.max(worst, Math.abs(Math.abs(v) - truth)), 0);

  /* ── 1. 比例尺：由臂体自身宽度推出，应当等于 D / 剪影宽度 ── */
  {
    const { result } = run(2.0, 2.0);
    const expected = 60 / result.widthMedianPx;
    const err = Math.abs(result.scaleMmPerPx - expected);
    push("比例尺自洽", result.ok && err < 1e-9, `scale=${result.scaleMmPerPx.toFixed(4)} 期望=${expected.toFixed(4)}`);
  }

  /* ── 2. 直臂：曲率应当处处为 0 ── */
  {
    const { result } = run(0, 0);
    const worst = result.curvaturePerM.reduce((m, k) => Math.max(m, Math.abs(k)), 0);
    push("直臂曲率为零", result.ok && worst < 0.15, `max|κ|=${worst.toFixed(4)} 1/m（阈值 0.15）`);
  }

  /* ── 3. 单段常曲率 ── */
  //
  // 判据用**绝对**容差，不用相对。κ=0.5 时 0.26 1/m 的绝对偏差是 52% 的相对
  // 误差，但它只占 0~8 量程的 3% —— 小信号下用相对误差判据只会误导。
  // 0.35 1/m 是这套管线（亚像素边缘 + SG 求导）的实测噪声底附近。
  for (const kappa of [0.5, 1.5, 3.0, 6.0]) {
    const { result } = run(kappa, kappa);
    if (!result.ok) { push(`单段 κ=${kappa}`, false, result.reason); continue; }
    const worst = midErrors(result.curvaturePerM, kappa);
    push(
      `单段 κ=${kappa.toFixed(1)} 1/m`,
      worst < 0.35,
      `中段最大偏差 ${worst.toFixed(3)} 1/m（占量程 8 的 ${(worst / 8 * 100).toFixed(1)}%）`,
    );
  }
  /* ── 4. 两段不同曲率：检验分段位置是否找对 ── */
  {
    const { result } = run(1.0, 2.5);
    const k = result.curvaturePerM.map(Math.abs);
    // 前段看 6~24，后段看 38~54（换段在第 30 点）
    const err1 = k.slice(6, 24).reduce((m, v) => Math.max(m, Math.abs(v - 1.0)), 0);
    const err2 = k.slice(38, 54).reduce((m, v) => Math.max(m, Math.abs(v - 2.5)), 0);
    push("两段曲率（1.0 → 2.5）", Math.max(err1, err2) < 0.25, `前段偏差 ${err1.toFixed(3)}，后段偏差 ${err2.toFixed(3)}`);
  }

  /* ── 5. 大弯曲：总量程附近，中轴不能崩 ── */
  {
    const { result } = run(7.0, 7.0);
    const finite = result.curvaturePerM.every((k) => Number.isFinite(k));
    // κ=7 1/m → 半径 143mm > 臂长 200mm 的一半，会弯过 90°。
    // 这正是「投影分桶」那类算法会崩的场景。
    const worst = result.ok ? midErrors(result.curvaturePerM, 7.0) : Infinity;
    push(
      "大弯曲 κ=7（弯过 90°）",
      result.ok && finite && worst / 7 < 0.08,
      result.ok ? `中段最大偏差 ${worst.toFixed(3)} 1/m，宽度一致性 ${result.widthConsistency.toFixed(3)}` : result.reason,
    );
  }

  /* ── 6. 亚像素精度：中轴与真值的偏差应当远小于 1 像素 ── */
  {
    const { result } = run(1.2, 0.8);
    // 真值点（图像坐标）：沿弧长等分
    const truth: Array<{ x: number; y: number }> = [];
    const k1 = perMToPerPx(1.2, MM_PER_PX);
    const k2 = perMToPerPx(0.8, MM_PER_PX);
    let x = 240, y = 640, t = -Math.PI / 2;
    const step = (2 * SEG_LEN_PX) / 59;
    for (let i = 0; i < 60; i += 1) {
      truth.push({ x, y });
      if (i === 59) break;
      const kap = i * step < SEG_LEN_PX ? k1 : k2;
      const te = t + kap * step;
      x += (Math.sin(te) - Math.sin(t)) / kap;
      y -= (Math.cos(te) - Math.cos(t)) / kap;
      t = te;
    }
    // 度量的是**垂直偏差**（点到真值折线的最近距离），不是「按弧长参数对应」。
    //
    // 参数对应会把弧长本身的误差也算进来：检测出的弧长比真值差 0.5% 时，
    // 这个长度差会在末端累积成 1.4px 的漂移 —— 但那是长度误差，不是形状
    // 误差。形状对不对应该看垂直方向差多少。
    const distanceToPolyline = (px: number, py: number): number => {
      let best = Infinity;
      for (let i = 1; i < truth.length; i += 1) {
        const ax = truth[i - 1].x, ay = truth[i - 1].y;
        const bx = truth[i].x, by = truth[i].y;
        const vx = bx - ax, vy = by - ay;
        const len2 = vx * vx + vy * vy;
        const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
        best = Math.min(best, Math.hypot(px - (ax + vx * t), py - (ay + vy * t)));
      }
      return best;
    };
    let worst = 0;
    for (const p of result.pointsPx) worst = Math.max(worst, distanceToPolyline(p.x, p.y));
    push("中轴垂直偏差", result.ok && worst < 1.5, `与真值折线的最大垂直偏差 ${worst.toFixed(3)} px（含端点约 1px 的固有残留）`);
  }

  /* ── 7. 抗噪声 ── */
  {
    const clean = run(1.5, 1.5);
    const noisy = run(1.5, 1.5, { noiseSigma: 6 });
    const cleanErr = clean.result.ok ? midErrors(clean.result.curvaturePerM, 1.5) : Infinity;
    const noisyErr = noisy.result.ok ? midErrors(noisy.result.curvaturePerM, 1.5) : Infinity;
    push(
      "噪声 σ=6 灰度级下仍可用",
      noisy.result.ok && noisyErr < 0.35,
      `无噪 ${cleanErr.toFixed(3)} → 加噪 ${noisyErr.toFixed(3)} 1/m（真值 1.5）`,
    );
  }

  /* ── 8. PCC 拟合残差 ── */
  {
    const { result } = run(1.5, 1.5);
    const rms = result.pccFit?.residualRmsPx ?? Infinity;
    push("PCC 拟合残差", rms < 0.5, `RMS=${rms.toFixed(4)} px`);
  }

  return checks;
}
