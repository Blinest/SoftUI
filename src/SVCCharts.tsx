import { useEffect, useRef } from "react";
import type { BackboneOutput } from "./dynamics/svcModel";

const CABLE_COLORS = ["#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4"];
const CURVATURE_SEGMENT_COLORS = ["#4fc3f7", "#81c784", "#ffb74d", "#f06292", "#ba68c8", "#4dd0e1", "#aed581", "#ff8a65", "#9575cd", "#4db6ac", "#dce775", "#e57373", "#90a4ae", "#7986cb", "#64b5f6", "#a1887f"];

function segmentColor(index: number) {
  return CURVATURE_SEGMENT_COLORS[index % CURVATURE_SEGMENT_COLORS.length];
}

function segmentIndexAtS(backbone: BackboneOutput, sMm: number) {
  const index = backbone.distribution.segments.findIndex((segment) => sMm >= segment.sStartMm && sMm <= segment.sEndMm);
  return index >= 0 ? index : Math.max(0, backbone.distribution.segments.length - 1);
}

interface SVCChartsProps {
  backbone: BackboneOutput;
  tendonForcesN?: number[];
}
function drawCurvature(ctx: CanvasRenderingContext2D, w: number, h: number, data: BackboneOutput) {
  const pad = { t: 18, r: 14, b: 22, l: 38 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = "#9aa9b7";
  ctx.font = "11px Inter,sans-serif";
  ctx.fillText("Curvature distribution κ(s)", pad.l, 14);
  ctx.fillStyle = "rgba(231,238,247,0.4)";
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

  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  for (let s = sMin; s <= sMax; s += 20) {
    ctx.beginPath();
    ctx.moveTo(sx(s), pad.t);
    ctx.lineTo(sx(s), pad.t + ph);
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(231,238,247,0.45)";
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

  ctx.fillStyle = "rgba(231,238,247,0.45)";
  ctx.font = "9px Inter,sans-serif";
  ctx.textAlign = "end";
  for (let k = Math.round(kMin); k <= Math.round(kMax2); k++) {
    if (k === 0) continue;
    ctx.fillText(String(k), pad.l - 4, ky_(k) + 3);
  }
  ctx.textAlign = "start";

  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.beginPath();
  ctx.moveTo(pad.l, ky_(0));
  ctx.lineTo(pad.l + pw, ky_(0));
  ctx.stroke();

  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.setLineDash([2, 7]);
  for (const segment of data.distribution.segments.slice(1)) {
    ctx.beginPath();
    ctx.moveTo(sx(segment.sStartMm), pad.t);
    ctx.lineTo(sx(segment.sStartMm), pad.t + ph);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  ctx.fillStyle = "rgba(231,238,247,0.5)";
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
  ctx.fillStyle = "rgba(231,238,247,0.7)";
  ctx.font = "9px Inter,sans-serif";
  ctx.fillText("κx", pad.l + pw - 88, pad.t + 6);
  ctx.fillStyle = "#4fc3f7";
  ctx.fillRect(pad.l + pw - 62, pad.t + 2, 10, 2);
  ctx.fillStyle = "rgba(231,238,247,0.7)";
  ctx.fillText("κy", pad.l + pw - 50, pad.t + 6);
  ctx.fillStyle = "#ffd43b";
  ctx.fillRect(pad.l + pw - 30, pad.t + 2, 10, 2);
  ctx.fillText("|κ|", pad.l + pw - 18, pad.t + 6);
}

function drawTendonForces(ctx: CanvasRenderingContext2D, w: number, h: number, forces: number[] | undefined) {
  const pad = { t: 18, r: 14, b: 24, l: 38 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = "#9aa9b7";
  ctx.font = "11px Inter,sans-serif";
  ctx.fillText("Measured tendon force", pad.l, 14);
  ctx.fillStyle = "rgba(231,238,247,0.4)";
  ctx.font = "10px Inter,sans-serif";
  ctx.fillText("N", w - pad.r - 10, 14);

  if (!forces || forces.length === 0) {
    ctx.fillStyle = "rgba(231,238,247,0.4)";
    ctx.font = "10px Inter,sans-serif";
    ctx.fillText("无传感器输入", pad.l, pad.t + ph / 2);
    return;
  }

  const fMax = Math.max(1, ...forces.filter(Number.isFinite));
  const barW = Math.min(pw / forces.length - 6, 36);
  const gap = (pw - barW * forces.length) / (forces.length + 1);

  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    const y = pad.t + ph - (i / 4) * ph;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke();
  }
  ctx.fillStyle = "rgba(231,238,247,0.45)";
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
      ctx.strokeStyle = CABLE_COLORS[i];
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(x, pad.t + 4, barW, ph - 8);
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(231,238,247,0.45)";
      ctx.font = "9px Inter,sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("N/A", x + barW / 2, pad.t + ph / 2 + 3);
      ctx.fillText(`F${i}`, x + barW / 2, pad.t + ph + 12);
      ctx.textAlign = "start";
      continue;
    }
    const barH = (value / fMax) * ph * 0.85;
    const y = pad.t + ph - barH;
    ctx.fillStyle = CABLE_COLORS[i];
    ctx.fillRect(x, y, barW, barH);
    ctx.fillStyle = "rgba(231,238,247,0.6)";
    ctx.font = "9px Inter,sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(value.toFixed(1), x + barW / 2, y - 4);
    ctx.fillText(`F${i}`, x + barW / 2, pad.t + ph + 12);
    ctx.textAlign = "start";
  }

  ctx.fillStyle = "rgba(231,238,247,0.5)";
  ctx.font = "9px Inter,sans-serif";
  ctx.fillText("Cable #", pad.l + pw / 2 - 14, h - 3);
  ctx.save();
  ctx.translate(10, pad.t + ph / 2 + 14);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("Force (N)", -14, 0);
  ctx.restore();
}

function drawProjections(ctx: CanvasRenderingContext2D, w: number, h: number, backbone: BackboneOutput) {
  const pad = { t: 18, r: 10, b: 24, l: 28 };
  ctx.clearRect(0, 0, w, h);
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

    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x0, y0, plotW, plotH);
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.fillStyle = "rgba(231,238,247,0.38)";
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

    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.beginPath();
    ctx.moveTo(x0, ys(0));
    ctx.lineTo(x0 + plotW, ys(0));
    ctx.moveTo(xs(0), y0);
    ctx.lineTo(xs(0), y0 + plotH);
    ctx.stroke();

    ctx.fillStyle = "rgba(231,238,247,0.68)";
    ctx.font = "10px Inter,sans-serif";
    ctx.fillText(view.title, x0 + 6, y0 + 12);
    ctx.fillStyle = "rgba(231,238,247,0.45)";
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
  }

  views.forEach(drawView);
}

export default function SVCCharts({ backbone, tendonForcesN }: SVCChartsProps) {
  const curvRef = useRef<HTMLCanvasElement>(null);
  const forcesRef = useRef<HTMLCanvasElement>(null);
  const projRef = useRef<HTMLCanvasElement>(null);
  const curvWrapRef = useRef<HTMLDivElement>(null);
  const forcesWrapRef = useRef<HTMLDivElement>(null);
  const projWrapRef = useRef<HTMLDivElement>(null);

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
    if (ctxC) drawCurvature(ctxC, Number(curvWrapRef.current?.clientWidth ?? 300), Number(curvWrapRef.current?.clientHeight ?? 200), backbone);

    const ctxF = setupCanvas(forcesRef.current, forcesWrapRef.current);
    if (ctxF) drawTendonForces(ctxF, Number(forcesWrapRef.current?.clientWidth ?? 300), Number(forcesWrapRef.current?.clientHeight ?? 200), effectiveTendonForces);

    const ctxP = setupCanvas(projRef.current, projWrapRef.current);
    if (ctxP) drawProjections(ctxP, Number(projWrapRef.current?.clientWidth ?? 300), Number(projWrapRef.current?.clientHeight ?? 200), backbone);
  }

  useEffect(() => {
    draw();
    const ro = new ResizeObserver(() => { draw(); });
    [curvWrapRef, forcesWrapRef, projWrapRef].forEach((r) => { if (r.current) ro.observe(r.current); });
    return () => ro.disconnect();
  }, [backbone, effectiveTendonForces]);

  return (
    <div className="svc-charts-layout">
      <div className="svc-curvature-wrap" ref={curvWrapRef}>
        <canvas ref={curvRef} />
      </div>
      <div className="svc-forces-wrap" ref={forcesWrapRef}>
        <canvas ref={forcesRef} />
      </div>
      <div className="svc-projection-wrap" ref={projWrapRef}>
        <canvas ref={projRef} />
      </div>
    </div>
  );
}
