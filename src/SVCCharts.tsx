import { useEffect, useRef, useState } from "react";
import type { BackboneOutput } from "./dynamics/svcModel";

/**
 * 主题感知的"墨色"（文字 / 坐标轴 / 网格）。
 *
 * 原来写死 `rgba(231,238,247,…)` ✗ —— 那是**近白**，深色主题清晰 ✓、浅色主题几乎看不见 ✗。
 * canvas 拿不到 CSS 变量 ✗，所以按 `data-theme` 自己算 ✓。
 */
/** 网格 / 轴线专用：浅色模式下**明显加深** ✓（原来近白几乎不可见 ✗） */
function gridInk(alpha: number): string {
  const isLight =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "light";
  if (isLight) {
    // 浅色底 → **黑色系**轴线 ✓（不是浅灰 ✗）
    return `rgba(15, 23, 42, ${Math.min(1, alpha * 6)})`;
  }
  return `rgba(255, 255, 255, ${alpha})`;
}

/** 图表背景：浅色模式用**浅蓝** ✓（原来是透明 → 直接透出页面灰白 ✗）*/
function chartBackground(): string | null {
  const isLight =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "light";
  return isLight ? "#eef4fb" : null;   // 深色主题保持透明 ✓
}

function ink(alpha: number): string {
  const isLight =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") === "light";
  if (isLight) {
    // 浅色底 → 深蓝灰，透明度略提（浅底上淡色更吃亏 ✓）
    return `rgba(30, 41, 59, ${Math.min(1, alpha * 1.4)})`;
  }
  return `rgba(231, 238, 247, ${alpha})`;
}

const CURVATURE_SEGMENT_COLORS = ["#4fc3f7", "#81c784", "#ffb74d", "#f06292", "#ba68c8", "#4dd0e1", "#aed581", "#ff8a65", "#9575cd", "#4db6ac", "#dce775", "#e57373", "#90a4ae", "#7986cb", "#64b5f6", "#a1887f"];

function segmentColor(index: number) {
  return CURVATURE_SEGMENT_COLORS[index % CURVATURE_SEGMENT_COLORS.length];
}

function segmentIndexAtS(backbone: BackboneOutput, sMm: number) {
  const index = backbone.distribution.segments.findIndex((segment) => sMm >= segment.sStartMm && sMm <= segment.sEndMm);
  return index >= 0 ? index : Math.max(0, backbone.distribution.segments.length - 1);
}

/** 三个视图。并排显示时每张只有容器 1/3 宽，曲线全挤在一起，所以改成一次看一张。 */
type SvcView = "curvature" | "forces" | "projection";

const SVC_VIEWS: Array<{ key: SvcView; label: string }> = [
  { key: "curvature", label: "曲率分布" },
  { key: "forces", label: "腱张力" },
  { key: "projection", label: "形变投影" },
];

interface SVCChartsProps {
  backbone: BackboneOutput;
  tendonForcesN?: number[];
  /** 模型反算的理论张力（N），与实测柱并列显示；不传则不画。 */
  theoreticalForcesN?: number[];
  /**
   * **理论形位** ✓ —— 由"实时跟随下发的电机指令"推导 ✓（`previewOverride`）。
   *
   * 为什么不并进 `backbone` ✗：
   *   `backbone` = **实际**（设备快照 ✓）；
   *   `theoryBackbone` = **理论**（下发推导 ✓）。
   *   两者混在一起，"实际曲率"就会被理论值污染 ✗ —— 语义就错了 ✓。
   */
  theoryBackbone?: BackboneOutput | null;
}
function drawCurvature(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  data: BackboneOutput,
  theory?: BackboneOutput | null,
) {
  const pad = { t: 18, r: 14, b: 22, l: 38 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  ctx.clearRect(0, 0, w, h);
  {
    const bg = chartBackground();
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
    }
  }

  ctx.fillStyle = "#9aa9b7";
  ctx.font = "11px Inter,sans-serif";
  ctx.fillText("Curvature distribution κ(s)", pad.l, 14);
  ctx.fillStyle = ink(0.4);
  ctx.font = "10px Inter,sans-serif";
  ctx.fillText("1/m", w - pad.r - 22, 14);

  const sMin = 0;
  const sMax = data.sMm[data.sMm.length - 1] || 1;
  const kMax = Math.max(Math.max(...data.kappaAbsPerM.map(Math.abs)), 3);
  const padK = kMax * 0.15;
  const kMin = -kMax - padK;
  const kMax2 = kMax + padK;

  const sx = (s: number) => pad.l + (s - sMin) / (sMax - sMin) * pw;
  const ky_ = (k: number) => pad.t + ph - (k - kMin) / (kMax2 - kMin) * ph;

  for (const segment of data.distribution.segments) {
    const x0 = sx(segment.sStartMm);
    const x1 = sx(segment.sEndMm);
    ctx.fillStyle = segmentColor(segment.index);
    ctx.globalAlpha = 0.08;
    ctx.fillRect(x0, pad.t, Math.max(1, x1 - x0), ph);
    ctx.globalAlpha = 1;
  }

  ctx.strokeStyle = gridInk(0.06);
  ctx.lineWidth = 1;
  for (let s = sMin; s <= sMax; s += 20) {
    ctx.beginPath();
    ctx.moveTo(sx(s), pad.t);
    ctx.lineTo(sx(s), pad.t + ph);
    ctx.stroke();
  }

  ctx.fillStyle = ink(0.45);
  ctx.font = "9px Inter,sans-serif";
  ctx.textAlign = "center";
  for (let s = sMin; s <= sMax; s += 40) ctx.fillText(String(s), sx(s), pad.t + ph + 14);
  ctx.textAlign = "start";
  for (let k = Math.round(kMin); k <= Math.round(kMax2); k++) {
    ctx.beginPath();
    ctx.moveTo(pad.l, ky_(k));
    ctx.lineTo(pad.l + pw, ky_(k));
    ctx.stroke();
  }

  ctx.fillStyle = ink(0.45);
  ctx.font = "9px Inter,sans-serif";
  ctx.textAlign = "end";
  for (let k = Math.round(kMin); k <= Math.round(kMax2); k++) {
    if (k === 0) continue;
    ctx.fillText(String(k), pad.l - 4, ky_(k) + 3);
  }
  ctx.textAlign = "start";

  ctx.strokeStyle = gridInk(0.15);
  ctx.beginPath();
  ctx.moveTo(pad.l, ky_(0));
  ctx.lineTo(pad.l + pw, ky_(0));
  ctx.stroke();

  ctx.strokeStyle = gridInk(0.05);
  ctx.setLineDash([2, 7]);
  for (const segment of data.distribution.segments.slice(1)) {
    ctx.beginPath();
    ctx.moveTo(sx(segment.sStartMm), pad.t);
    ctx.lineTo(sx(segment.sStartMm), pad.t + ph);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  ctx.fillStyle = ink(0.5);
  ctx.font = "9px Inter,sans-serif";
  ctx.fillText("s (mm)", pad.l + pw / 2 - 14, h - 4);
  ctx.save();
  ctx.translate(10, pad.t + ph / 2 + 10);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("κ (1/m)", -12, 0);
  ctx.restore();

  function plotLine(points: number[], color: string, width: number) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const x = sx(data.sMm[i]);
      const y = ky_(points[i]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  plotLine(data.kxPerM, "#ff6b6b", 1.5);
  plotLine(data.kyPerM, "#4fc3f7", 1.5);
  plotLine(data.kappaAbsPerM, "#ffd43b", 1);

  ctx.fillStyle = "#ff6b6b";
  ctx.fillRect(pad.l + pw - 100, pad.t + 2, 10, 2);
  ctx.fillStyle = ink(0.7);
  ctx.font = "9px Inter,sans-serif";
  ctx.fillText("κx", pad.l + pw - 88, pad.t + 6);
  ctx.fillStyle = "#4fc3f7";
  ctx.fillRect(pad.l + pw - 62, pad.t + 2, 10, 2);
  ctx.fillStyle = ink(0.7);
  ctx.fillText("κy", pad.l + pw - 50, pad.t + 6);
  ctx.fillStyle = "#ffd43b";
  ctx.fillRect(pad.l + pw - 30, pad.t + 2, 10, 2);
  ctx.fillText("|κ|", pad.l + pw - 18, pad.t + 6);

  /**
   * **理论曲率（虚线）** ✓ —— 三条线，**颜色和实际完全一致** ✓：
   *   κx 红 ✓ / κy 蓝 ✓ / |κ| 黄 ✓，只是虚线和细一点 ✓。
   * 这样"同一根线的实线是实际、虚线是理论"，一眼就能比 ✓。
   */
  if (theory) {
    const theoryPlot = (points: number[], color: string) => {
      ctx.save();
      // ⚠ **要比实线显眼** ✗ —— 实线 1.5px 实心 ✓，
      //   虚线如果只有 1px + 85% 透明 ✓，两者重合时**虚线完全看不见** ✗（本 bug ✓）。
      // **点线** ✓
      ctx.setLineDash([0.1, 7]);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2.6;
      ctx.lineCap = "round";
      ctx.beginPath();
      for (let index = 0; index < points.length; index += 1) {
        const x = sx(theory.sMm[index]);
        const y = ky_(points[index]);
        index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    };
    theoryPlot(theory.kxPerM, "#ff6b6b");
    theoryPlot(theory.kyPerM, "#4fc3f7");
    theoryPlot(theory.kappaAbsPerM, "#ffd43b");
  }
}

/** 实测张力柱：**深暖色**。 */
/** 每根肌腱的**独立颜色** ✓ —— 6 根一眼可分 ✓（色相拉开、亮度接近）。 */
const CABLE_COLORS = ["#e05c5c", "#e0913c", "#d8c344", "#5cc46a", "#48a9d8", "#9b7ae0"];
/** 理论张力（虚线轮廓 + 柱顶数值）：**浅暖色**，与实测成对 ✓。 */
const THEORY_WARM = "rgba(255, 186, 128, 0.9)";

/** 图例文字同步（原来写的是 Measured tendon force）。 */
function drawTendonForces(ctx: CanvasRenderingContext2D, w: number, h: number, forces: number[] | undefined, theoretical?: number[]) {
  const pad = { t: 18, r: 14, b: 24, l: 38 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  ctx.clearRect(0, 0, w, h);
  {
    const bg = chartBackground();
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
    }
  }

  ctx.fillStyle = "#9aa9b7";
  ctx.font = "11px Inter,sans-serif";
  ctx.fillText(theoretical ? "肌腱张力" : "肌腱张力（实测）", pad.l, 14);

  // 图注（图内右上角 ✓）—— 两项**等间距**、字号 11px ✓（原来 9px 偏小 ✗）
  if (theoretical) {
    const legendY = 15;
    const legendRight = w - pad.r;
    const gapText = 42;   // 文字与色块之间的间距 ✓（"实际"也挤过 ✗，统一用这个值）
    const itemGap = 62;   // 两项之间的间距 ✓
    ctx.font = "11px Inter,sans-serif";
    ctx.textBaseline = "middle";

    // 实际（实心块 + 文字）
    ctx.textAlign = "end";
    ctx.fillStyle = ink(0.9);
    ctx.fillText("实际", legendRight, legendY);
    ctx.fillRect(legendRight - gapText, legendY - 4, 14, 8);

    // 理论（虚线框 + 文字）
    const theoryTextRight = legendRight - itemGap;
    ctx.fillStyle = ink(0.9);
    ctx.fillText("理论", theoryTextRight, legendY);
    ctx.strokeStyle = ink(0.9);
    ctx.lineWidth = 1.6;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(theoryTextRight - gapText, legendY - 4, 14, 8);
    ctx.setLineDash([]);
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
  }
  ctx.fillStyle = ink(0.4);
  ctx.font = "10px Inter,sans-serif";
  ctx.fillText("N", w - pad.r - 10, 14);

  if (!forces || forces.length === 0) {
    ctx.fillStyle = ink(0.4);
    ctx.font = "10px Inter,sans-serif";
    ctx.fillText("无传感器输入", pad.l, pad.t + ph / 2);
    return;
  }

  // 缩放要同时覆盖实测与理论，否则理论柱会冲出画布
  const fMax = Math.max(1, ...forces.filter(Number.isFinite), ...(theoretical ?? []).filter(Number.isFinite));
  const barW = Math.min(pw / forces.length - 6, 36);
  const gap = (pw - barW * forces.length) / (forces.length + 1);

  ctx.strokeStyle = gridInk(0.06);
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    const y = pad.t + ph - (i / 4) * ph;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke();
  }
  ctx.fillStyle = ink(0.45);
  ctx.font = "9px Inter,sans-serif";
  ctx.textAlign = "end";
  for (let i = 1; i <= 4; i++) {
    const v = (i / 4) * fMax;
    const y = pad.t + ph - (i / 4) * ph;
    ctx.fillText(v.toFixed(1), pad.l - 4, y + 3);
  }
  ctx.textAlign = "start";

  for (let i = 0; i < forces.length; i++) {
    const x = pad.l + gap + i * (barW + gap);
    const value = forces[i];
    if (!Number.isFinite(value)) {
      ctx.strokeStyle = THEORY_WARM;   // N/A 也用同一套暖色，别混进彩虹色
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(x, pad.t + 4, barW, ph - 8);
      ctx.setLineDash([]);
      ctx.fillStyle = ink(0.45);
      ctx.font = "9px Inter,sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("N/A", x + barW / 2, pad.t + ph / 2 + 3);
      ctx.fillText(`F${i + 1}`, x + barW / 2, pad.t + ph + 12);
      ctx.textAlign = "start";
      continue;
    }
    const barH = (value / fMax) * ph * 0.85;
    const y = pad.t + ph - barH;
    // 实测 = 该肌腱的**专属颜色** ✓（原来 6 根同色，分不清 ✗）
    const cableColor = CABLE_COLORS[i % CABLE_COLORS.length];
    // 渐变柱：柱顶实、柱底淡 ✓（保留 78% 透明度，让理论虚线能透出来 ✓）
    const fade = ctx.createLinearGradient(0, y, 0, pad.t + ph);
    fade.addColorStop(0, cableColor);
    fade.addColorStop(1, `${cableColor}26`);   // 15% alpha 的底部 ✓
    ctx.fillStyle = fade;
    ctx.globalAlpha = 0.78;
    ctx.fillRect(x, y, barW, barH);
    ctx.globalAlpha = 1;
    // 柱体外边框 ✓ —— 渐变柱的底部很淡，边界需要一根线才清楚 ✓
    ctx.strokeStyle = cableColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, barW - 1, Math.max(0, barH - 1));

    // 理论张力：虚线轮廓，与实测柱并列对照（不是叠加，避免遮住实测值）
    const theory = theoretical?.[i];
    if (Number.isFinite(theory)) {
      const thH = (Math.max(0, theory as number) / fMax) * ph * 0.85;
      // 理论轮廓：**和实测柱同色** ✓ —— 同色实心柱 + 同色虚线框 = 一眼成对 ✓
      // （白线看不出属于哪根肌腱 ✗）
      ctx.strokeStyle = cableColor;
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2.4;          // ← 比实测柱边框(1px)粗 ✓，否则看不见 ✓
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x, pad.t + ph - thH, barW, thH);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // 理论张力数值标在柱顶：**浅色**（半透明暖色）+ 比实测柱数字更小，
      // 让它一眼能和实测区分开（实测的数值在纵轴刻度上读 ✓）。
      ctx.fillStyle = cableColor;   // 数值也同色 ✓
      ctx.font = "9px Inter,sans-serif";
      ctx.textAlign = "center";
      // ⚠ 实测标签在 `y - 4`（柱顶上方 4px）✗ —— 两者数值接近时会叠在一起 ✗。
      // 理论标签强制比实测标签**再高 11px** ✓，保证任何情况下都不重合 ✓。
      const measuredLabelY = y - 4;
      const labelY = Math.min(pad.t + ph - Math.max(barH, thH) - 4, measuredLabelY - 11);
      ctx.fillText((theory as number).toFixed(1), x + barW / 2, labelY);
      ctx.textAlign = "start";
    }
    ctx.fillStyle = cableColor;   // 与柱子同色 ✓（原来统一浅灰，分不清属于哪根 ✗）
    ctx.font = "9px Inter,sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(value.toFixed(1), x + barW / 2, y - 4);
    ctx.fillText(`F${i + 1}`, x + barW / 2, pad.t + ph + 12);
    ctx.textAlign = "start";
  }

  ctx.fillStyle = ink(0.5);
  ctx.font = "9px Inter,sans-serif";
  ctx.fillText("Cable #", pad.l + pw / 2 - 14, h - 3);
  ctx.save();
  ctx.translate(10, pad.t + ph / 2 + 14);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("Force (N)", -14, 0);
  ctx.restore();
}

function drawProjections(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  backbone: BackboneOutput,
  theory?: BackboneOutput | null,
) {
  const pad = { t: 18, r: 10, b: 24, l: 28 };
  ctx.clearRect(0, 0, w, h);
  {
    const bg = chartBackground();
    if (bg) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
    }
  }
  ctx.fillStyle = "#9aa9b7";
  ctx.font = "11px Inter,sans-serif";
  ctx.fillText("Backbone projections · XY / XZ / YZ bound to κ(s)", pad.l, 14);

  const ptsMm = backbone.samples.map((sample) => [sample.pointM[0] * 1000, sample.pointM[1] * 1000, sample.pointM[2] * 1000] as [number, number, number]);
  const gap = 10;
  const plotW = (w - pad.l - pad.r - gap * 2) / 3;
  const plotH = h - pad.t - pad.b;
  const transverseExtentMm = Math.max(30, ...ptsMm.flatMap((p) => [Math.abs(p[0]), Math.abs(p[1])]));
  const axialExtentMm = Math.max(80, ...ptsMm.map((p) => Math.max(0, p[2])));
  const mmPerPx = Math.max((transverseExtentMm * 2.2) / plotW, (axialExtentMm * 1.08) / plotH);
  const tickStepMm = (() => {
    const raw = mmPerPx * Math.min(plotW, plotH) / 4;
    const magnitude = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
    const normalized = raw / magnitude;
    const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    return nice * magnitude;
  })();
  const views: Array<{ title: string; xLabel: string; yLabel: string; xi: 0 | 1 | 2; yi: 0 | 1 | 2; originX: number; originMode: "center" | "bottom" }> = [
    { title: "XY", xLabel: "X", yLabel: "Y", xi: 0, yi: 1, originX: pad.l, originMode: "center" },
    { title: "XZ", xLabel: "X", yLabel: "Z", xi: 0, yi: 2, originX: pad.l + plotW + gap, originMode: "bottom" },
    { title: "YZ", xLabel: "Y", yLabel: "Z", xi: 1, yi: 2, originX: pad.l + (plotW + gap) * 2, originMode: "bottom" },
  ];

  function drawView(view: typeof views[number]) {
    const x0 = view.originX;
    const y0 = pad.t;
    const originPx = {
      x: x0 + plotW / 2,
      y: view.originMode === "center" ? y0 + plotH / 2 : y0 + plotH - 8,
    };

    const xs = (x: number) => originPx.x + x / mmPerPx;
    const ys = (y: number) => originPx.y - y / mmPerPx;
    const minVisibleX = -Math.max(originPx.x - x0, x0 + plotW - originPx.x) * mmPerPx;
    const maxVisibleX = Math.max(originPx.x - x0, x0 + plotW - originPx.x) * mmPerPx;
    const minVisibleY = -(y0 + plotH - originPx.y) * mmPerPx;
    const maxVisibleY = (originPx.y - y0) * mmPerPx;

    ctx.strokeStyle = gridInk(0.08);
    ctx.lineWidth = 1;
    ctx.strokeRect(x0, y0, plotW, plotH);
    ctx.strokeStyle = gridInk(0.04);
    ctx.fillStyle = ink(0.38);
    ctx.font = "7px Inter,sans-serif";
    ctx.textAlign = "center";
    for (let tick = Math.ceil(minVisibleX / tickStepMm) * tickStepMm; tick <= maxVisibleX; tick += tickStepMm) {
      const x = xs(tick);
      if (x < x0 || x > x0 + plotW) continue;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y0 + plotH);
      ctx.stroke();
      if (Math.abs(tick) > 1e-6) ctx.fillText(tick.toFixed(0), x, Math.min(y0 + plotH - 2, originPx.y + 9));
    }
    ctx.textAlign = "right";
    for (let tick = Math.ceil(minVisibleY / tickStepMm) * tickStepMm; tick <= maxVisibleY; tick += tickStepMm) {
      const y = ys(tick);
      if (y < y0 || y > y0 + plotH) continue;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + plotW, y);
      ctx.stroke();
      if (Math.abs(tick) > 1e-6) ctx.fillText(tick.toFixed(0), Math.max(x0 + 18, originPx.x - 3), y + 3);
    }
    ctx.textAlign = "start";

    ctx.strokeStyle = gridInk(0.05);
    ctx.beginPath();
    ctx.moveTo(x0, ys(0));
    ctx.lineTo(x0 + plotW, ys(0));
    ctx.moveTo(xs(0), y0);
    ctx.lineTo(xs(0), y0 + plotH);
    ctx.stroke();

    ctx.fillStyle = ink(0.68);
    ctx.font = "10px Inter,sans-serif";
    ctx.fillText(view.title, x0 + 6, y0 + 12);
    ctx.fillStyle = ink(0.45);
    ctx.font = "8px Inter,sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`${view.xLabel} (mm)`, x0 + plotW / 2, y0 + plotH + 12);
    ctx.save();
    ctx.translate(x0 - 12, y0 + plotH / 2 + 12);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(`${view.yLabel} (mm)`, 0, 0);
    ctx.restore();
    ctx.textAlign = "start";

    for (let i = 1; i < ptsMm.length; i++) {
      const prev = ptsMm[i - 1];
      const curr = ptsMm[i];
      const segmentIndex = segmentIndexAtS(backbone, backbone.samples[i]?.sMm ?? 0);
      ctx.strokeStyle = segmentColor(segmentIndex);
      ctx.lineWidth = 2.1;
      ctx.beginPath();
      ctx.moveTo(xs(prev[view.xi]), ys(prev[view.yi]));
      ctx.lineTo(xs(curr[view.xi]), ys(curr[view.yi]));
      ctx.stroke();
    }

    for (const segment of backbone.distribution.segments.slice(1)) {
      const sample = backbone.samples.find((item) => item.sMm >= segment.sStartMm);
      if (!sample) continue;
      const point = [sample.pointM[0] * 1000, sample.pointM[1] * 1000, sample.pointM[2] * 1000] as [number, number, number];
      ctx.fillStyle = segmentColor(segment.index);
      ctx.beginPath();
      ctx.arc(xs(point[view.xi]), ys(point[view.yi]), 2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = "#42c97a";
    ctx.beginPath();
    ctx.arc(xs(0), ys(0), 3, 0, Math.PI * 2);
    ctx.fill();

    const last = ptsMm[ptsMm.length - 1];
    ctx.fillStyle = "#ff6b6b";
    ctx.beginPath();
    ctx.arc(xs(last[view.xi]), ys(last[view.yi]), 3.5, 0, Math.PI * 2);
    ctx.fill();

    /**
     * **理论形位（虚线）** ✓ —— 和实线**同色**分段 ✓，只是虚一点、细一点 ✓。
     * 这样"实线=实际 / 虚线=理论"一眼能比 ✓。
     */
    if (theory && theory.samples.length > 1) {
      const theoryPts = theory.samples.map(
        (sample) => [sample.pointM[0] * 1000, sample.pointM[1] * 1000, sample.pointM[2] * 1000] as [number, number, number],
      );
      ctx.save();
      ctx.lineWidth = 2.6;
      ctx.globalAlpha = 1;
      // **圆点线** ✓ —— `lineCap: round` + 零长度线段 = 圆点 ✓，
      // 间隔 7px ✓ —— 比虚线更能和实线区分开 ✓。
      ctx.lineCap = "round";
      for (let i = 1; i < theoryPts.length; i += 1) {
        const prev = theoryPts[i - 1];
        const curr = theoryPts[i];
        const segmentIndex = segmentIndexAtS(theory, theory.samples[i]?.sMm ?? 0);
        ctx.strokeStyle = segmentColor(segmentIndex);
        // **点线** ✓：线段长度 0.1（≈一个圆点 ✓）+ 间隔 7px ✓
        // 每次 stroke 前都重设 ✓（别处会 `setLineDash([])` 冲掉状态 ✗）
        ctx.setLineDash([0.1, 7]);
        ctx.beginPath();
        ctx.moveTo(xs(prev[view.xi]), ys(prev[view.yi]));
        ctx.lineTo(xs(curr[view.xi]), ys(curr[view.yi]));
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  views.forEach(drawView);
}

export default function SVCCharts({ backbone, tendonForcesN, theoreticalForcesN, theoryBackbone }: SVCChartsProps) {
  const curvRef = useRef<HTMLCanvasElement>(null);
  const forcesRef = useRef<HTMLCanvasElement>(null);
  const projRef = useRef<HTMLCanvasElement>(null);
  const curvWrapRef = useRef<HTMLDivElement>(null);
  const forcesWrapRef = useRef<HTMLDivElement>(null);
  const projWrapRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<SvcView>("curvature");

  // 优先使用 backbone 自带的传感器推导腱力；prop 仅作为可选覆盖。
  const effectiveTendonForces = tendonForcesN ?? backbone.distribution.diagnostics?.tendonForcesN;

  function draw() {
    const dpr = window.devicePixelRatio || 1;

    function setupCanvas(ref: HTMLCanvasElement | null, wrap: HTMLDivElement | null): CanvasRenderingContext2D | null {
      if (!ref || !wrap) return null;
      const w = wrap.clientWidth || 300;
      const h = wrap.clientHeight || 200;
      ref.width = w * dpr;
      ref.height = h * dpr;
      ref.style.width = w + "px";
      ref.style.height = h + "px";
      const ctx = ref.getContext("2d")!;
      ctx.scale(dpr, dpr);
      return ctx;
    }

    const ctxC = setupCanvas(curvRef.current, curvWrapRef.current);
    if (ctxC) drawCurvature(ctxC, Number(curvWrapRef.current?.clientWidth ?? 300), Number(curvWrapRef.current?.clientHeight ?? 200), backbone, theoryBackbone ?? null);

    const ctxF = setupCanvas(forcesRef.current, forcesWrapRef.current);
    if (ctxF) drawTendonForces(ctxF, Number(forcesWrapRef.current?.clientWidth ?? 300), Number(forcesWrapRef.current?.clientHeight ?? 200), effectiveTendonForces, theoreticalForcesN);

    const ctxP = setupCanvas(projRef.current, projWrapRef.current);
    if (ctxP) drawProjections(ctxP, Number(projWrapRef.current?.clientWidth ?? 300), Number(projWrapRef.current?.clientHeight ?? 200), backbone, theoryBackbone ?? null);

  }

  /** 主题变化计数：只是为了把绘制 effect 顶一次 ✓（画布拿不到 CSS 变量 ✗）*/
  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setThemeTick((n) => n + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    draw();
    const ro = new ResizeObserver(() => { draw(); });
    [curvWrapRef, forcesWrapRef, projWrapRef].forEach((r) => { if (r.current) ro.observe(r.current); });
    return () => ro.disconnect();
    // view 必须在依赖里：切换视图时只有当前那张图挂在 DOM 上，ref 会指向新元素，
    // 不重跑这个 effect 就没人观察它，画布会一直空着。
  }, [backbone, effectiveTendonForces, view, themeTick, theoryBackbone]);

  return (
    <div className="svc-charts-layout">
      <div className="svc-chart-tabs" role="tablist" aria-label="柔性臂数据视图">
        {SVC_VIEWS.map((item) => (
          <button
            aria-selected={view === item.key}
            className={`svc-chart-tab${view === item.key ? " is-active" : ""}`}
            key={item.key}
            onClick={() => setView(item.key)}
            role="tab"
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>
      {/* 只渲染当前那一张：并排时 1/3 宽完全看不清曲线。 */}
      {view === "curvature" ? (
        <div className="svc-curvature-wrap" ref={curvWrapRef}>
          <canvas ref={curvRef} />
        </div>
      ) : null}
      {view === "forces" ? (
        <div className="svc-forces-wrap" ref={forcesWrapRef}>
          <canvas ref={forcesRef} />
        </div>
      ) : null}
      {view === "projection" ? (
        <div className="svc-projection-wrap" ref={projWrapRef}>
          <canvas ref={projRef} />
        </div>
      ) : null}
    </div>
  );
}
