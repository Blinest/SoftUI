import { useEffect, useRef } from "react";

const L_SEG = 0.200;
const N_SEGMENTS = 2;
const N_BB_PTS = 60;
const FORCE_BASE = 4.0;
const FORCE_AMP = [90.0, 55.0];

const SEG0_IDX = [0, 2, 4];
const SEG1_IDX = [1, 3, 5];
const CABLE_COLORS = ["#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4"];

// SDM cable geometry and stiffness — matches plot_tendon_force_curvature_gif.py
const R_CABLE = 0.006;
const BENDING_STIFFNESS = 0.2;
const EI0 = BENDING_STIFFNESS * L_SEG;
const SEG0_ALPHA = [0, 2 * Math.PI / 3, 4 * Math.PI / 3];  // cables 0,2,4
const SEG1_ALPHA = [Math.PI / 3, Math.PI, 5 * Math.PI / 3]; // cables 1,3,5

interface PCCChartsProps {
  section1AngleDeg: number;
  section2AngleDeg: number;
}

function clamp2(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/** Cable force distribution: per-cable based on angular position relative to bend dir. */
function computeTendonForces(deg1: number, deg2: number): number[] {
  const forces = [0, 0, 0, 0, 0, 0];

  // Seg0 cables (0,2,4 at 0°, 120°, 240°) — direction and magnitude from deg1
  const dir1 = deg1 >= 0 ? 0 : Math.PI;
  const mag1 = clamp2(Math.abs(deg1) / 85, 0, 1);
  for (let j = 0; j < SEG0_IDX.length; j++) {
    const wi = SEG0_IDX[j];
    forces[wi] = FORCE_BASE + FORCE_AMP[0] * mag1 * (0.5 + 0.5 * Math.cos(SEG0_ALPHA[j] - dir1));
  }

  // Seg1 cables (1,3,5 at 60°, 180°, 300°) — direction and magnitude from deg2
  const dir2 = deg2 >= 0 ? Math.PI / 3 : 4 * Math.PI / 3;
  const mag2 = clamp2(Math.abs(deg2) / 85, 0, 1);
  for (let j = 0; j < SEG1_IDX.length; j++) {
    const wi = SEG1_IDX[j];
    forces[wi] = FORCE_BASE + FORCE_AMP[1] * mag2 * (0.5 + 0.5 * Math.cos(SEG1_ALPHA[j] - dir2));
  }

  return forces;
}

function pcc_pose(theta: number, phi: number, L_seg: number, s: number): [number, number, number] {
  const kappa = Math.abs(theta) < 1e-12 ? 0.0 : theta / L_seg;
  if (Math.abs(kappa) < 1e-12 || Math.abs(theta) < 1e-12) {
    return [0, 0, s];
  }
  const R = 1.0 / kappa;
  const x = R * (1.0 - Math.cos(kappa * s)) * Math.cos(phi);
  const y = R * (1.0 - Math.cos(kappa * s)) * Math.sin(phi);
  const z = R * Math.sin(kappa * s);
  return [x, y, z];
}

function segmentH(theta: number, phi: number, L_seg: number, m: number): number[][] {
  const Lr = L_seg / m;
  const kappa = Math.abs(theta) < 1e-12 ? 0.0 : theta / L_seg;
  const kLr = kappa * Lr;
  let sum_sin = 0, sum_cos = 0;
  for (let j = 1; j <= m; j++) {
    sum_sin += Math.sin(j * kLr);
    sum_cos += Math.cos(j * kLr);
  }
  const cp = Math.cos(phi), sp = Math.sin(phi);
  const cth = Math.cos(theta), sth = Math.sin(theta);

  const R: number[][] = [
    [cp * cp * (cth - 1) + 1, sp * cp * (cth - 1), cp * sth],
    [sp * cp * (cth - 1), cp * cp * (1 - cth) + cth, sp * sth],
    [-cp * sth, -sp * sth, cth],
  ];
  const p = [Lr * sum_sin * cp, Lr * sum_sin * sp, Lr * sum_cos];
  const H: number[][] = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) H[i][j] = R[i][j];
  for (let i = 0; i < 3; i++) H[i][3] = p[i];
  return H;
}

function matMul4(H: number[][], v: number[]): number[] {
  const r: number[] = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++)
    r[i] = H[i][0] * v[0] + H[i][1] * v[1] + H[i][2] * v[2] + H[i][3] * v[3];
  return r;
}

function buildBackbone(section1Deg: number, section2Deg: number): {
  pts: [number, number, number][];
  curv_kx: number[];
  curv_ky: number[];
  s_mm: number[];
  kappa_abs: number[];
  km_seg: number[];
  phi_seg: number[];
} {
  const forces = computeTendonForces(section1Deg, section2Deg);

  function addMoment(idxList: number[], alphaList: number[]) {
    let mx = 0, my = 0;
    for (let j = 0; j < idxList.length; j++) {
      const F = Math.max(forces[idxList[j]], 0);
      mx += R_CABLE * F * (-Math.sin(alphaList[j]));
      my += R_CABLE * F * (Math.cos(alphaList[j]));
    }
    return [mx, my];
  }
  const [mx0, my0] = addMoment(SEG0_IDX, SEG0_ALPHA);
  const [mx1, my1] = addMoment(SEG1_IDX, SEG1_ALPHA);

  const pts: [number, number, number][] = [[0, 0, 0]];
  const s_vals: number[] = [0];
  const curv_kx: number[] = [0];
  const curv_ky: number[] = [0];
  const km_seg: number[] = [];
  const phi_seg: number[] = [];
  let H_curr: number[][] = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];

  // Sub-step accumulation: at each backbone point, compute per-point curvature
  // from the SDM moment blend, then create a micro-PCC transform for this step.
  // This eliminates both the curvature step AND the position kink at s=200mm.
  const totalPts = N_SEGMENTS * N_BB_PTS;
  for (let i = 0; i < totalPts; i++) {
    const seg = Math.floor(i / N_BB_PTS);
    const j = i - seg * N_BB_PTS + 1; // 1..N_BB_PTS
    const s_local = (j / N_BB_PTS) * L_SEG;
    const s_abs = seg * L_SEG + s_local;
    const ds = L_SEG / N_BB_PTS; // step in arc length

    // Variable curvature (same blend as curvature display)
    const tSeg = s_local / L_SEG; // 0→1 within segment
    let wx, wy;
    if (seg === 0) {
      wx = (mx0 + mx1 * tSeg) / EI0;
      wy = (my0 + my1 * tSeg) / EI0;
    } else {
      const w = 1 - tSeg;
      wx = (mx0 * w + mx1) / EI0;
      wy = (my0 * w + my1) / EI0;
    }

    // Per-step PCC params: km = |κ|, phi = bending plane
    const km_pt = Math.hypot(wx, wy);
    const phi_pt = Math.atan2(-wx, wy);
    const theta_pt = km_pt * ds; // micro-bend angle over this sub-step

    // Micro PCC local pose for this sub-step
    const local_p = pcc_pose(theta_pt, phi_pt, ds, ds);
    const global_p = matMul4(H_curr, [local_p[0], local_p[1], local_p[2], 1]);
    pts.push([global_p[0], global_p[1], global_p[2]]);
    s_vals.push(s_abs);
    curv_kx.push(wx);
    curv_ky.push(wy);

    // Accumulate micro transform for this sub-step
    const microH = segmentH(theta_pt, phi_pt, ds, 5);
    const newH: number[][] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1]];
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 4; c++)
        for (let k = 0; k < 4; k++)
          newH[r][c] += H_curr[r][k] * microH[k][c];
    H_curr = newH;

    // Record per-segment values at the midpoint of each segment
    if (j === Math.floor(N_BB_PTS / 2)) {
      km_seg.push(km_pt);
      phi_seg.push(phi_pt);
    }
  }

  const kappa_abs = curv_kx.map((_, i) => Math.hypot(curv_kx[i], curv_ky[i]));
  const s_mm = s_vals.map((s) => s * 1000);

  return { pts, curv_kx, curv_ky, s_mm, kappa_abs, km_seg, phi_seg };
}

function drawCurvature(ctx: CanvasRenderingContext2D, w: number, h: number, data: ReturnType<typeof buildBackbone>) {
  const pad = { t: 18, r: 14, b: 22, l: 38 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  ctx.clearRect(0, 0, w, h);

  // title
  ctx.fillStyle = "#9aa9b7";
  ctx.font = "11px Inter,sans-serif";
  ctx.fillText("Curvature κ along backbone", pad.l, 14);
  ctx.fillStyle = "rgba(231,238,247,0.4)";
  ctx.font = "10px Inter,sans-serif";
  ctx.fillText("1/m", w - pad.r - 22, 14);

  const sMin = 0;
  const sMax = data.s_mm[data.s_mm.length - 1] || 1;
  const kMax = Math.max(Math.max(...data.kappa_abs.map(Math.abs)), 3);
  const padK = kMax * 0.15;
  const kMin = -kMax - padK;
  const kMax2 = kMax + padK;

  const sx = (s: number) => pad.l + (s - sMin) / (sMax - sMin) * pw;
  const ky_ = (k: number) => pad.t + ph - (k - kMin) / (kMax2 - kMin) * ph;

  // grid
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  for (let s = sMin; s <= sMax; s += 20) {
    ctx.beginPath();
    ctx.moveTo(sx(s), pad.t);
    ctx.lineTo(sx(s), pad.t + ph);
    ctx.stroke();
  }
  // X tick labels
  ctx.fillStyle = "rgba(231,238,247,0.45)";
  ctx.font = "9px Inter,sans-serif";
  ctx.textAlign = "center";
  for (let s = sMin; s <= sMax; s += 40) {
    ctx.fillText(String(s), sx(s), pad.t + ph + 14);
  }
  ctx.textAlign = "start";
  for (let k = Math.round(kMin); k <= Math.round(kMax2); k++) {
    ctx.beginPath();
    ctx.moveTo(pad.l, ky_(k));
    ctx.lineTo(pad.l + pw, ky_(k));
    ctx.stroke();
  }
  // Y tick labels
  ctx.fillStyle = "rgba(231,238,247,0.45)";
  ctx.font = "9px Inter,sans-serif";
  ctx.textAlign = "end";
  for (let k = Math.round(kMin); k <= Math.round(kMax2); k++) {
    if (k === 0) continue;
    ctx.fillText(String(k), pad.l - 4, ky_(k) + 3);
  }
  ctx.textAlign = "start";

  // zero line
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.beginPath();
  ctx.moveTo(pad.l, ky_(0));
  ctx.lineTo(pad.l + pw, ky_(0));
  ctx.stroke();

  // segment boundary
  const segBoundary = sMax / 2;
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(sx(segBoundary), pad.t);
  ctx.lineTo(sx(segBoundary), pad.t + ph);
  ctx.stroke();
  ctx.setLineDash([]);

  // axis labels
  ctx.fillStyle = "rgba(231,238,247,0.5)";
  ctx.font = "9px Inter,sans-serif";
  ctx.fillText("s (mm)", pad.l + pw / 2 - 14, h - 4);
  ctx.save();
  ctx.translate(10, pad.t + ph / 2 + 10);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("κ (1/m)", -12, 0);
  ctx.restore();

  // plot lines
  function plotLine(points: number[], color: string, width: number) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const x = sx(data.s_mm[i]);
      const y = ky_(points[i]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  plotLine(data.curv_kx, "#ff6b6b", 1.5);
  plotLine(data.curv_ky, "#4fc3f7", 1.5);
  plotLine(data.kappa_abs, "#ffd43b", 1);

  // legend
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

function drawTendonForces(ctx: CanvasRenderingContext2D, w: number, h: number, forces: number[]) {
  const pad = { t: 18, r: 14, b: 24, l: 38 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = "#9aa9b7";
  ctx.font = "11px Inter,sans-serif";
  ctx.fillText("Tendon Forces", pad.l, 14);
  ctx.fillStyle = "rgba(231,238,247,0.4)";
  ctx.font = "10px Inter,sans-serif";
  ctx.fillText("N", w - pad.r - 10, 14);

  const fMax = Math.max(Math.max(...forces), 1);
  const barW = Math.min(pw / forces.length - 6, 36);
  const gap = (pw - barW * forces.length) / (forces.length + 1);

  // grid
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    const y = pad.t + ph - (i / 4) * ph;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + pw, y); ctx.stroke();
  }
  // Y tick labels
  ctx.fillStyle = "rgba(231,238,247,0.45)";
  ctx.font = "9px Inter,sans-serif";
  ctx.textAlign = "end";
  for (let i = 1; i <= 4; i++) {
    const v = (i / 4) * fMax;
    const y = pad.t + ph - (i / 4) * ph;
    ctx.fillText(v.toFixed(1), pad.l - 4, y + 3);
  }
  ctx.textAlign = "start";

  // bars
  for (let i = 0; i < forces.length; i++) {
    const x = pad.l + gap + i * (barW + gap);
    const barH = (forces[i] / fMax) * ph * 0.85;
    const y = pad.t + ph - barH;
    ctx.fillStyle = CABLE_COLORS[i];
    ctx.fillRect(x, y, barW, barH);
    ctx.fillStyle = "rgba(231,238,247,0.6)";
    ctx.font = "9px Inter,sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(forces[i].toFixed(1), x + barW / 2, y - 4);
    ctx.fillText(`F${i}`, x + barW / 2, pad.t + ph + 12);
    ctx.textAlign = "start";
  }

  // labels
  ctx.fillStyle = "rgba(231,238,247,0.5)";
  ctx.font = "9px Inter,sans-serif";
  ctx.fillText("Cable #", pad.l + pw / 2 - 14, h - 3);
  ctx.save();
  ctx.translate(10, pad.t + ph / 2 + 14);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("Force (N)", -14, 0);
  ctx.restore();
}function drawProjections(ctx: CanvasRenderingContext2D, w: number, h: number, pts: [number, number, number][]) {
  const pad = { t: 18, r: 10, b: 30, l: 38 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#9aa9b7";
  ctx.font = "11px Inter,sans-serif";
  ctx.fillText("XZ Projection", pad.l, 14);

  const pts_mm = pts.map((p) => [p[0] * 1000, p[1] * 1000, p[2] * 1000]);
  const xAll = pts_mm.map((p) => p[0]);
  const zAll = pts_mm.map((p) => p[2]);
  const xMin = Math.min(...xAll);
  const xMax = Math.max(...xAll);
  const zMin = 0;
  const zMax = Math.max(...zAll);
  const xRange = Math.max(xMax - xMin, 40);
  const zRange = Math.max(zMax - zMin, 80);
  const xPad = xRange * 0.12;
  const zPad = zRange * 0.08;

  const xs = (x: number) => pad.l + (x - xMin + xPad) / (xRange + 2 * xPad) * pw;
  const zs = (z: number) => pad.t + ph - (z - zMin + zPad) / (zRange + 2 * zPad) * ph;

  // grid
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.l, pad.t + ph * 0.5);
  ctx.lineTo(pad.l + pw, pad.t + ph * 0.5);
  ctx.stroke();
  // X tick labels
  ctx.fillStyle = "rgba(231,238,247,0.45)";
  ctx.font = "9px Inter,sans-serif";
  ctx.textAlign = "center";
  const xTicks = 4;
  for (let i = 0; i <= xTicks; i++) {
    const v = xMin - xPad + ((xRange + 2 * xPad) / xTicks) * i;
    ctx.fillText(v.toFixed(0), pad.l + (pw / xTicks) * i, pad.t + ph + 14);
  }
  ctx.textAlign = "start";
  // Y tick labels
  ctx.fillStyle = "rgba(231,238,247,0.45)";
  ctx.font = "9px Inter,sans-serif";
  ctx.textAlign = "end";
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const v = zMin - zPad + ((zRange + 2 * zPad) / yTicks) * i;
    const y = pad.t + ph - (ph / yTicks) * i;
    ctx.fillText(v.toFixed(0), pad.l - 4, y + 3);
  }
  ctx.textAlign = "start";

  // backbone
  ctx.strokeStyle = "#4fc3f7";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < pts_mm.length; i++) {
    const x = xs(pts_mm[i][0]);
    const y = zs(pts_mm[i][2]);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // base dot
  ctx.fillStyle = "#42c97a";
  ctx.beginPath();
  ctx.arc(xs(0), zs(0), 4, 0, Math.PI * 2);
  ctx.fill();

  // tip dot
  const last = pts_mm[pts_mm.length - 1];
  ctx.fillStyle = "#ff6b6b";
  ctx.beginPath();
  ctx.arc(xs(last[0]), zs(last[2]), 4, 0, Math.PI * 2);
  ctx.fill();

  // labels
  ctx.fillStyle = "rgba(231,238,247,0.5)";
  ctx.font = "9px Inter,sans-serif";
  ctx.fillText("X (mm)", pad.l + pw / 2 - 14, h - 4);
  ctx.save();
  ctx.translate(6, pad.t + ph / 2 + 10);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("Z (mm)", -16, 0);
  ctx.restore();
}

export default function PCCCharts({ section1AngleDeg, section2AngleDeg }: PCCChartsProps) {
  const curvRef = useRef<HTMLCanvasElement>(null);
  const forcesRef = useRef<HTMLCanvasElement>(null);
  const projRef = useRef<HTMLCanvasElement>(null);
  const curvWrapRef = useRef<HTMLDivElement>(null);
  const forcesWrapRef = useRef<HTMLDivElement>(null);
  const projWrapRef = useRef<HTMLDivElement>(null);

  function draw() {
    const data = buildBackbone(section1AngleDeg, section2AngleDeg);
    const forces = computeTendonForces(section1AngleDeg, section2AngleDeg);

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
    if (ctxC) drawCurvature(ctxC, Number(curvWrapRef.current?.clientWidth ?? 300), Number(curvWrapRef.current?.clientHeight ?? 200), data);

    const ctxF = setupCanvas(forcesRef.current, forcesWrapRef.current);
    if (ctxF) drawTendonForces(ctxF, Number(forcesWrapRef.current?.clientWidth ?? 300), Number(forcesWrapRef.current?.clientHeight ?? 200), forces);

    const ctxP = setupCanvas(projRef.current, projWrapRef.current);
    if (ctxP) drawProjections(ctxP, Number(projWrapRef.current?.clientWidth ?? 300), Number(projWrapRef.current?.clientHeight ?? 200), data.pts);
  }

  useEffect(() => {
    draw();
    const ro = new ResizeObserver(() => { draw(); });
    [curvWrapRef, forcesWrapRef, projWrapRef].forEach((r) => { if (r.current) ro.observe(r.current); });
    return () => ro.disconnect();
  }, [section1AngleDeg, section2AngleDeg]);

  return (
    <div className="pcc-charts-layout">
      <div className="pcc-curvature-wrap" ref={curvWrapRef}>
        <canvas ref={curvRef} />
      </div>
      <div className="pcc-forces-wrap" ref={forcesWrapRef}>
        <canvas ref={forcesRef} />
      </div>
      <div className="pcc-projection-wrap" ref={projWrapRef}>
        <canvas ref={projRef} />
      </div>
    </div>
  );
}
