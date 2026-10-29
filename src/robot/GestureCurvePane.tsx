import { useEffect, useRef } from "react";

import type { CurvatureDistribution } from "../dynamics/svcModel";

/**
 * 手势曲线的 2D 剖面图。
 *
 * 画的是**目标分布**的 κ(s)：横幅 = 弧长 s（0 在基座、L 在末端），
 * 纵轴 = 曲率大小。手势跟随驱动出来的形状就是这条曲线，
 * 和左边 3D 里的臂体是**同一份数据**（不做任何换算 ✗）。
 */
export function GestureCurvePane({
  distribution,
  active,
}: {
  distribution: CurvatureDistribution | null;
  active: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 240;
    const height = canvas.clientHeight || 160;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const pad = { l: 30, r: 10, t: 12, b: 20 };
    const pw = Math.max(1, width - pad.l - pad.r);
    const ph = Math.max(1, height - pad.t - pad.b);

    // 轴
    ctx.strokeStyle = "rgba(148,163,184,.45)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t);
    ctx.lineTo(pad.l, pad.t + ph);
    ctx.lineTo(pad.l + pw, pad.t + ph);
    ctx.stroke();

    const segments = distribution?.segments ?? [];
    if (segments.length === 0) {
      ctx.fillStyle = "rgba(148,163,184,.8)";
      ctx.font = "11px Inter,sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(active ? "等待手势…" : "手势跟随未开启", pad.l + pw / 2, pad.t + ph / 2);
      return;
    }

    const kappas = segments.map((seg) => Math.abs(seg.kappaAbsPerM));
    const lengths = segments.map((seg) => seg.lengthMm);
    const totalMm = lengths.reduce((sum, v) => sum + v, 0) || 1;
    const kMax = Math.max(1e-3, ...kappas);

    // κ(s) 折线：横轴按**弧长**累加（不是等分 ✗）
    ctx.strokeStyle = "#ffb480";
    ctx.lineWidth = 2;
    ctx.beginPath();
    let accMm = 0;
    for (let i = 0; i < segments.length; i += 1) {
      const xMid = pad.l + ((accMm + lengths[i] / 2) / totalMm) * pw;
      const y = pad.t + ph - (kappas[i] / kMax) * ph * 0.92;
      if (i === 0) ctx.moveTo(xMid, y);
      else ctx.lineTo(xMid, y);
      accMm += lengths[i];
    }
    ctx.stroke();

    // 用点标出每段，避免"看着像连续曲线"但其实只有 12 个值
    ctx.fillStyle = "#ffb480";
    accMm = 0;
    for (let i = 0; i < segments.length; i += 1) {
      const xMid = pad.l + ((accMm + lengths[i] / 2) / totalMm) * pw;
      const y = pad.t + ph - (kappas[i] / kMax) * ph * 0.92;
      ctx.beginPath();
      ctx.arc(xMid, y, 2.2, 0, Math.PI * 2);
      ctx.fill();
      accMm += lengths[i];
    }

    // 刻度文字
    ctx.fillStyle = "rgba(148,163,184,.9)";
    ctx.font = "9px Inter,sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(kMax.toFixed(2), pad.l - 4, pad.t + 8);
    ctx.fillText("0", pad.l - 4, pad.t + ph);
    ctx.textAlign = "center";
    ctx.fillText("基座", pad.l + 10, pad.t + ph + 13);
    ctx.fillText("末端", pad.l + pw - 10, pad.t + ph + 13);
  }, [distribution, active]);

  return (
    <div className="gesture-curve-pane">
      <div className="gesture-curve-title">手势曲线 · κ(s)</div>
      <canvas ref={canvasRef} className="gesture-curve-canvas" />
      <GestureDirectionDial distribution={distribution} />
    </div>
  );
}


/**
 * 方向拨盘：把目标分布里的 (kx, ky) 反算成**弯曲平面的方位角**。
 *
 * 口径与 `pose3d.ts` 完全一致：`directionRad = atan2(-kx, ky)` ✓ ——
 * 这样拨盘指的方向就是 3D 里臂体真正弯向的方向 ✓，不会各说各话 ✗。
 * 纯显示：不改任何下发值 ✓。
 */
export function GestureDirectionDial({ distribution }: { distribution: CurvatureDistribution | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 140;
    const height = canvas.clientHeight || 140;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(width, height) / 2 - 12;

    // 外圈
    ctx.strokeStyle = "rgba(148,163,184,.35)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    // 八个方向刻度
    ctx.strokeStyle = "rgba(148,163,184,.45)";
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (radius - 4), cy + Math.sin(a) * (radius - 4));
      ctx.lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
      ctx.stroke();
    }

    const segments = distribution?.segments ?? [];
    let kx = 0;
    let ky = 0;
    for (const seg of segments) {
      kx += seg.kxPerM * seg.lengthMm;
      ky += seg.kyPerM * seg.lengthMm;
    }
    const mag = Math.hypot(kx, ky);

    if (segments.length === 0 || mag < 1e-9) {
      ctx.fillStyle = "rgba(148,163,184,.85)";
      ctx.font = "11px Inter,sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("无方向", cx, cy + 4);
      return;
    }

    const phi = Math.atan2(-kx, ky);              // 与 pose3d 同口径 ✓
    // 图像坐标：x 右、y 下 → 直接用 cos/sin
    const dx = Math.cos(phi) * radius * 0.82;
    const dy = Math.sin(phi) * radius * 0.82;

    ctx.strokeStyle = "#ffb480";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + dx, cy + dy);
    ctx.stroke();

    // 箭头
    const head = 7;
    const back = Math.atan2(-dy, -dx);
    ctx.beginPath();
    ctx.moveTo(cx + dx, cy + dy);
    ctx.lineTo(cx + dx + Math.cos(back + 0.4) * head, cy + dy + Math.sin(back + 0.4) * head);
    ctx.lineTo(cx + dx + Math.cos(back - 0.4) * head, cy + dy + Math.sin(back - 0.4) * head);
    ctx.closePath();
    ctx.fillStyle = "#ffb480";
    ctx.fill();

    // 中心点 + 角度文字
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(148,163,184,.9)";
    ctx.fill();
    ctx.fillStyle = "rgba(203,213,225,.95)";
    ctx.font = "10px Inter,sans-serif";
    ctx.textAlign = "center";
    const deg = ((phi * 180) / Math.PI + 360) % 360;
    ctx.fillText(`${deg.toFixed(0)}°`, cx, height - 4);
  }, [distribution]);

  return (
    <div className="gesture-dial-pane">
      <div className="gesture-curve-title">弯曲方向</div>
      <canvas ref={canvasRef} className="gesture-curve-canvas" />
    </div>
  );
}
