import { useEffect, useRef, useState } from "react";

type TrackingMode = "bright" | "dark" | "auto";
type CameraState = "idle" | "starting" | "ready" | "error";

interface ComponentCandidate {
  area: number;
  cx: number;
  cy: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  angleRad: number;
  length: number;
  elongation: number;
  confidence: number;
  score: number;
  skeleton: Array<{ x: number; y: number }>;
}

interface TrackResult extends ComponentCandidate {
  found: boolean;
  mode: TrackingMode;
  threshold: number;
}

interface SmoothedTrack {
  cx: number;
  cy: number;
  angleRad: number;
  length: number;
  confidence: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  skeleton: Array<{ x: number; y: number }>;
}

interface TrackingBuffers {
  width: number;
  height: number;
  luminance: Uint8Array;
  mask: Uint8Array;
  visited: Uint8Array;
  stack: Int32Array;
  points: Int32Array;
}

interface TrackerReadout {
  state: CameraState;
  message: string;
  angleDeg: number | null;
  confidence: number;
  threshold: number;
}

const ANALYSIS_MAX_WIDTH = 360;
const PROCESS_INTERVAL_MS = 50;
const STATUS_INTERVAL_MS = 250;
const SMOOTHING_ALPHA = 0.35;

/**
 * 虚拟摄像头（串流软件、安卓投屏、OBS 等）在列表里通常排在真实摄像头前面。
 * 不指定设备直接调用 getUserMedia 会取到列表第一个 —— 很容易命中一个
 * 根本没有信号源、只会输出纯黑帧的虚拟设备。这里按名字排除掉它们。
 */
const VIRTUAL_CAMERA_PATTERN =
  /virtual|idea\s*cam|obs|manycam|snap\s*camera|xsplit|droidcam|e2esoft|vcam|fake|dummy|stream\s*cam/i;

function isVirtualCamera(label: string) {
  return VIRTUAL_CAMERA_PATTERN.test(label);
}

/** 在候选设备里挑一个：优先非虚拟摄像头，其次是任意有名字的设备。 */
function pickPreferredCamera(devices: MediaDeviceInfo[], explicitId: string | null) {
  if (explicitId && devices.some((device) => device.deviceId === explicitId)) return explicitId;
  const real = devices.find((device) => !isVirtualCamera(device.label));
  return (real ?? devices[0])?.deviceId ?? null;
}

/**
 * 串行化 getUserMedia。
 *
 * Chromium 下两个并发的 getUserMedia 会互相阻塞，后一个必然超时
 * （表现为一直卡在"正在打开摄像头…"）。React StrictMode 会把 effect
 * 跑两遍，正好触发这种情况，所以这里用一个模块级队列把取流排成串。
 */
let cameraQueue: Promise<unknown> = Promise.resolve();

function requestCamera(constraints: MediaStreamConstraints): Promise<MediaStream> {
  const next = cameraQueue.then(
    () => navigator.mediaDevices.getUserMedia(constraints),
    () => navigator.mediaDevices.getUserMedia(constraints),
  );
  // 队列本身要吞掉失败，否则一次拒绝会让后续所有取流都被短路。
  cameraQueue = next.catch(() => undefined);
  return next;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function axialAngleDelta(next: number, prev: number) {
  let delta = next - prev;
  while (delta > Math.PI / 2) delta -= Math.PI;
  while (delta < -Math.PI / 2) delta += Math.PI;
  return delta;
}

function angleDeg(angleRad: number) {
  let deg = (angleRad * 180) / Math.PI;
  while (deg < 0) deg += 180;
  while (deg >= 180) deg -= 180;
  return deg;
}

function estimateOtsuThreshold(luminance: Uint8Array) {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < luminance.length; i++) histogram[luminance[i]]++;

  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];

  let sumBackground = 0;
  let weightBackground = 0;
  let bestThreshold = 128;
  let bestVariance = -1;
  const total = luminance.length;

  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * histogram[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const diff = meanBackground - meanForeground;
    const variance = weightBackground * weightForeground * diff * diff;
    if (variance > bestVariance) {
      bestVariance = variance;
      bestThreshold = t;
    }
  }

  return bestThreshold;
}

function prepareBuffers(ref: React.MutableRefObject<TrackingBuffers | null>, width: number, height: number) {
  const size = width * height;
  const current = ref.current;
  if (current && current.width === width && current.height === height) return current;
  const next: TrackingBuffers = {
    width,
    height,
    luminance: new Uint8Array(size),
    mask: new Uint8Array(size),
    visited: new Uint8Array(size),
    stack: new Int32Array(size),
    points: new Int32Array(size),
  };
  ref.current = next;
  return next;
}

function buildMask(buffers: TrackingBuffers, threshold: number, mode: "bright" | "dark") {
  const { luminance, mask } = buffers;
  for (let i = 0; i < luminance.length; i++) {
    const value = luminance[i];
    mask[i] = mode === "bright" ? (value >= threshold ? 1 : 0) : value <= threshold ? 1 : 0;
  }
}

function findBestCandidate(buffers: TrackingBuffers) {
  const { width, height, mask, visited, stack, points } = buffers;
  visited.fill(0);
  const total = width * height;
  const minArea = Math.max(12, Math.floor(total * 0.00045));
  const maxArea = Math.floor(total * 0.28);
  let best: ComponentCandidate | null = null;

  for (let start = 0; start < total; start++) {
    if (!mask[start] || visited[start]) continue;

    let top = 0;
    stack[top++] = start;
    visited[start] = 1;

    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumYY = 0;
    let sumXY = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let edgePixels = 0;

    while (top > 0) {
      const idx = stack[--top];
      const x = idx % width;
      const y = (idx / width) | 0;

      points[area] = idx;
      area++;
      sumX += x;
      sumY += y;
      sumXX += x * x;
      sumYY += y * y;
      sumXY += x * y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) edgePixels++;

      const left = idx - 1;
      const right = idx + 1;
      const up = idx - width;
      const down = idx + width;
      if (x > 0 && mask[left] && !visited[left]) {
        visited[left] = 1;
        stack[top++] = left;
      }
      if (x < width - 1 && mask[right] && !visited[right]) {
        visited[right] = 1;
        stack[top++] = right;
      }
      if (y > 0 && mask[up] && !visited[up]) {
        visited[up] = 1;
        stack[top++] = up;
      }
      if (y < height - 1 && mask[down] && !visited[down]) {
        visited[down] = 1;
        stack[top++] = down;
      }
    }

    if (area < minArea || area > maxArea) continue;
    const boxW = maxX - minX + 1;
    const boxH = maxY - minY + 1;
    if (boxW < 4 || boxH < 4) continue;
    if (edgePixels / area > 0.35) continue;

    const cx = sumX / area;
    const cy = sumY / area;
    const covXX = sumXX / area - cx * cx;
    const covYY = sumYY / area - cy * cy;
    const covXY = sumXY / area - cx * cy;
    const trace = covXX + covYY;
    const detPart = Math.sqrt(Math.max(0, (covXX - covYY) * (covXX - covYY) + 4 * covXY * covXY));
    const major = Math.max(1e-6, (trace + detPart) / 2);
    const minor = Math.max(1e-6, (trace - detPart) / 2);
    const elongation = Math.sqrt(major / minor);
    if (elongation < 2.2) continue;

    const angleRad = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
    const length = Math.max(boxW, boxH, Math.sqrt(major) * 4);
    const areaScore = clamp(area / (total * 0.035), 0, 1);
    const slenderScore = clamp((elongation - 2.2) / 8, 0, 1);
    const lengthScore = clamp(length / Math.min(width, height), 0, 1);
    const confidence = clamp(slenderScore * 0.55 + areaScore * 0.25 + lengthScore * 0.2, 0, 1);
    const score = confidence + slenderScore * 0.25;

    const candidate: ComponentCandidate = {
      area,
      cx,
      cy,
      minX,
      minY,
      maxX,
      maxY,
      angleRad,
      length,
      elongation,
      confidence,
      score,
      skeleton: buildSkeleton(points, area, width, cx, cy, angleRad),
    };
    if (!best || candidate.score > best.score) best = candidate;
  }

  return best;
}

/**
 * 沿主方向把像素按投影分桶，取每桶质心形成中轴骨架点序列。
 * 对弯曲物体同样适用：骨架点会顺着物体的走向弯折。
 */
function buildSkeleton(
  points: Int32Array,
  count: number,
  width: number,
  cx: number,
  cy: number,
  angleRad: number,
) {
  const ux = Math.cos(angleRad);
  const uy = Math.sin(angleRad);
  const buckets = 12;
  const projections = new Float64Array(count);
  let minP = Infinity;
  let maxP = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = points[i] % width;
    const y = (points[i] / width) | 0;
    const p = (x - cx) * ux + (y - cy) * uy;
    projections[i] = p;
    if (p < minP) minP = p;
    if (p > maxP) maxP = p;
  }
  const span = Math.max(1e-6, maxP - minP);
  const sumX = new Float64Array(buckets);
  const sumY = new Float64Array(buckets);
  const sumN = new Float64Array(buckets);
  for (let i = 0; i < count; i++) {
    let b = Math.floor(((projections[i] - minP) / span) * buckets);
    if (b >= buckets) b = buckets - 1;
    if (b < 0) b = 0;
    const x = points[i] % width;
    const y = (points[i] / width) | 0;
    sumX[b] += x;
    sumY[b] += y;
    sumN[b] += 1;
  }
  const skeleton: Array<{ x: number; y: number }> = [];
  for (let b = 0; b < buckets; b++) {
    if (sumN[b] === 0) continue;
    skeleton.push({ x: sumX[b] / sumN[b], y: sumY[b] / sumN[b] });
  }
  return skeleton;
}

function analyze(buffers: TrackingBuffers, threshold: number, mode: TrackingMode): TrackResult | null {
  const actualThreshold = mode === "auto" ? estimateOtsuThreshold(buffers.luminance) : threshold;
  const modes: Array<"bright" | "dark"> = mode === "auto" ? ["bright", "dark"] : [mode];
  let best: TrackResult | null = null;

  for (const candidateMode of modes) {
    buildMask(buffers, actualThreshold, candidateMode);
    const candidate = findBestCandidate(buffers);
    if (!candidate) continue;
    const result: TrackResult = {
      ...candidate,
      found: true,
      mode: candidateMode,
      threshold: actualThreshold,
    };
    if (!best || result.score > best.score) best = result;
  }

  return best;
}

function smoothTrack(previous: SmoothedTrack | null, result: TrackResult) {
  if (!previous) {
    return {
      cx: result.cx,
      cy: result.cy,
      angleRad: result.angleRad,
      length: result.length,
      confidence: result.confidence,
      minX: result.minX,
      minY: result.minY,
      maxX: result.maxX,
      maxY: result.maxY,
      skeleton: result.skeleton.map((p) => ({ x: p.x, y: p.y })),
    };
  }
  const a = SMOOTHING_ALPHA;
  return {
    cx: previous.cx + (result.cx - previous.cx) * a,
    cy: previous.cy + (result.cy - previous.cy) * a,
    angleRad: previous.angleRad + axialAngleDelta(result.angleRad, previous.angleRad) * a,
    length: previous.length + (result.length - previous.length) * a,
    confidence: previous.confidence + (result.confidence - previous.confidence) * a,
    minX: previous.minX + (result.minX - previous.minX) * a,
    minY: previous.minY + (result.minY - previous.minY) * a,
    maxX: previous.maxX + (result.maxX - previous.maxX) * a,
    maxY: previous.maxY + (result.maxY - previous.maxY) * a,
    skeleton: result.skeleton.map((p, i) => ({
      x: (previous.skeleton[i]?.x ?? p.x) + (p.x - (previous.skeleton[i]?.x ?? p.x)) * a,
      y: (previous.skeleton[i]?.y ?? p.y) + (p.y - (previous.skeleton[i]?.y ?? p.y)) * a,
    })),
  };
}

function videoRect(containerW: number, containerH: number, videoW: number, videoH: number) {
  if (videoW <= 0 || videoH <= 0 || containerW <= 0 || containerH <= 0) {
    return { x: 0, y: 0, width: containerW, height: containerH };
  }
  const scale = Math.min(containerW / videoW, containerH / videoH);
  const width = videoW * scale;
  const height = videoH * scale;
  return {
    x: (containerW - width) / 2,
    y: (containerH - height) / 2,
    width,
    height,
  };
}

export default function ArmObjectTracker() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const workCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const buffersRef = useRef<TrackingBuffers | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastProcessRef = useRef(0);
  const lastStatusUpdateRef = useRef(0);
  const smoothedRef = useRef<SmoothedTrack | null>(null);
  const lastMaskRef = useRef<Uint8Array | null>(null);
  const modeRef = useRef<TrackingMode>("bright");
  const thresholdRef = useRef(200);
  const showMaskRef = useRef(false);
  const deviceIdRef = useRef<string | null>(null);

  const [mode, setMode] = useState<TrackingMode>("bright");
  const [threshold, setThreshold] = useState(200);
  const [showMask, setShowMask] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [readout, setReadout] = useState<TrackerReadout>({
    state: "idle",
    message: "等待打开摄像头",
    angleDeg: null,
    confidence: 0,
    threshold: 200,
  });

  useEffect(() => {
    modeRef.current = mode;
    thresholdRef.current = threshold;
    showMaskRef.current = showMask;
  }, [mode, threshold, showMask]);

  // 只负责枚举设备并选定一个默认项。依赖里不放 deviceId，否则会和下面的
  // 开流 effect 互相触发。
  //
  // 这里刻意不做 getUserMedia 预热：已授权过的 origin 直接枚举就能拿到
  // label；而预热会和开流 effect 的取流并发，Chromium 下两个并发的
  // getUserMedia 会互相阻塞（实测第二个必然超时），表现为一直卡在"打开中"。
  useEffect(() => {
    let cancelled = false;
    const discover = async () => {
      const all = await navigator.mediaDevices.enumerateDevices();
      if (cancelled) return;
      const cams = all.filter((device) => device.kind === "videoinput");
      setDevices(cams);
      const chosen = pickPreferredCamera(cams, deviceIdRef.current);
      if (chosen) deviceIdRef.current = chosen;
      setDeviceId((prev) => (chosen && prev !== chosen ? chosen : prev));
    };
    discover().catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  // 开流。换设备时只重跑这一个 effect。
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !navigator.mediaDevices?.getUserMedia) {
      setReadout((prev) => ({ ...prev, state: "error", message: "浏览器不支持摄像头访问" }));
      return;
    }
    if (deviceId === null) return; // 等设备枚举完成

    let cancelled = false;
    let stream: MediaStream | null = null;
    setReadout((prev) => ({ ...prev, state: "starting", message: "正在打开摄像头…" }));

    requestCamera({
      video: {
        deviceId: { exact: deviceId },
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
      audio: false,
    })
      .then((opened) => {
        if (cancelled) {
          opened.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = opened;
        streamRef.current = opened;
        video.srcObject = opened;
        video.play().catch(() => undefined);
        const label = opened.getVideoTracks()[0]?.label ?? "";
        setReadout((prev) => ({
          ...prev,
          state: "ready",
          message: isVirtualCamera(label)
            ? `当前是虚拟摄像头（${label}），画面可能全黑，请在上方切换设备`
            : "摄像头已打开，等待目标",
        }));
      })
      .catch((error) => {
        if (cancelled) return;
        setReadout((prev) => ({
          ...prev,
          state: "error",
          message: error instanceof Error ? error.message : "摄像头权限被拒绝或不可用",
        }));
      });

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
      if (streamRef.current === stream) streamRef.current = null;
      if (video.srcObject === stream) video.srcObject = null;
    };
  }, [deviceId]);

  useEffect(() => {
    const canvas = overlayRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, rect.width, rect.height);
      }
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    window.addEventListener("resize", resize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, []);

  useEffect(() => {
    const loop = (time: number) => {
      const video = videoRef.current;
      const overlay = overlayRef.current;
      const wrap = wrapRef.current;
      if (video && overlay && wrap) {
        drawFrame(video, overlay, wrap, time);
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, []);

  const drawFrame = (video: HTMLVideoElement, overlay: HTMLCanvasElement, wrap: HTMLDivElement, time: number) => {
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    const rect = wrap.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);

    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) {
      drawStatus(ctx, rect.width, rect.height, readout.message);
      return;
    }

    const shouldProcess = time - lastProcessRef.current >= PROCESS_INTERVAL_MS;
    let result: TrackResult | null = null;
    if (shouldProcess) {
      lastProcessRef.current = time;
      result = processVideoFrame(video);
      if (result) {
        smoothedRef.current = smoothTrack(smoothedRef.current, result);
      } else {
        smoothedRef.current = null;
      }
      if (time - lastStatusUpdateRef.current >= STATUS_INTERVAL_MS) {
        lastStatusUpdateRef.current = time;
        setReadout({
          state: "ready",
          message: result ? "已锁定细长目标" : "未锁定目标，尝试调节阈值/模式",
          angleDeg: result ? angleDeg(result.angleRad) : null,
          confidence: result?.confidence ?? 0,
          threshold: result?.threshold ?? thresholdRef.current,
        });
      }
    }

    const smoothed = smoothedRef.current;
    const analysis = buffersRef.current;
    if (!smoothed || !analysis) {
      drawStatus(ctx, rect.width, rect.height, "未锁定目标");
      return;
    }

    const rendered = videoRect(rect.width, rect.height, video.videoWidth, video.videoHeight);
    if (showMaskRef.current && lastMaskRef.current) drawMask(ctx, rendered, analysis, lastMaskRef.current);
    drawTrackingOverlay(ctx, rendered, analysis.width, analysis.height, smoothed);
  };

  const processVideoFrame = (video: HTMLVideoElement): TrackResult | null => {
    const sourceW = video.videoWidth;
    const sourceH = video.videoHeight;
    if (!sourceW || !sourceH) return null;

    const analysisW = Math.min(ANALYSIS_MAX_WIDTH, sourceW);
    const analysisH = Math.max(1, Math.round((analysisW * sourceH) / sourceW));
    const work = workCanvasRef.current ?? document.createElement("canvas");
    workCanvasRef.current = work;
    if (work.width !== analysisW || work.height !== analysisH) {
      work.width = analysisW;
      work.height = analysisH;
    }
    const workCtx = work.getContext("2d", { willReadFrequently: true });
    if (!workCtx) return null;
    workCtx.drawImage(video, 0, 0, analysisW, analysisH);
    const image = workCtx.getImageData(0, 0, analysisW, analysisH);
    const buffers = prepareBuffers(buffersRef, analysisW, analysisH);
    const data = image.data;
    for (let src = 0, dst = 0; src < data.length; src += 4, dst++) {
      buffers.luminance[dst] = clamp(0.2126 * data[src] + 0.7152 * data[src + 1] + 0.0722 * data[src + 2], 0, 255);
    }
    const result = analyze(buffers, thresholdRef.current, modeRef.current);
    lastMaskRef.current = showMaskRef.current ? new Uint8Array(buffers.mask) : null;
    return result;
  };

  return (
    <div className="camera-feed-wrap arm-tracker" ref={wrapRef}>
      <video ref={videoRef} className="camera-feed arm-tracker-video" autoPlay muted playsInline />
      <canvas ref={overlayRef} className="arm-tracker-overlay" />
      <div className="arm-tracker-controls">
        {devices.length > 0 ? (
          <label className="arm-tracker-device">
            <span>设备</span>
            <select
              value={deviceId ?? ""}
              onChange={(event) => setDeviceId(event.target.value || null)}
              title={devices.find((device) => device.deviceId === deviceId)?.label ?? ""}
            >
              {devices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {isVirtualCamera(device.label) ? `⚠ ${device.label}` : device.label || "未命名摄像头"}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          <span>目标</span>
          <select value={mode} onChange={(event) => setMode(event.target.value as TrackingMode)}>
            <option value="bright">亮目标</option>
            <option value="dark">暗目标</option>
            <option value="auto">自动</option>
          </select>
        </label>
        <label className="arm-tracker-threshold">
          <span>阈值 {readout.threshold}</span>
          <input type="range" min={0} max={255} value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} />
        </label>
        <label className="arm-tracker-mask-toggle">
          <input type="checkbox" checked={showMask} onChange={(event) => setShowMask(event.target.checked)} />
          <span>掩膜</span>
        </label>
      </div>
      <div className={`arm-tracker-status ${readout.state}`}>
        <strong>{readout.state === "ready" && readout.angleDeg != null ? `${readout.angleDeg.toFixed(1)}°` : readout.state === "error" ? "摄像头错误" : "视觉追踪"}</strong>
        <span>{readout.message}</span>
        {readout.confidence > 0 ? <small>置信度 {(readout.confidence * 100).toFixed(0)}%</small> : null}
      </div>
    </div>
  );
}

/**
 * 未锁定目标时的提示。
 *
 * 这里刻意不铺满整块画布：早期版本用 44% 黑罩盖满，摄像头本身偏暗时
 * 会让整个画面看起来像全黑，也会把视频信号压得看不清。改成只画一个
 * 紧凑的药丸标签 —— 底部状态条已经有一份同样的文案，不必再压暗画面。
 */
function drawStatus(ctx: CanvasRenderingContext2D, width: number, height: number, message: string) {
  ctx.save();
  ctx.font = "13px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const paddingX = 12;
  const boxW = Math.min(width - 16, ctx.measureText(message).width + paddingX * 2);
  const boxH = 24;
  const boxX = (width - boxW) / 2;
  const boxY = (height - boxH) / 2;

  ctx.fillStyle = "rgba(12, 18, 26, 0.62)";
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxW, boxH, 12);
    ctx.fill();
  } else {
    ctx.fillRect(boxX, boxY, boxW, boxH);
  }

  ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
  ctx.fillText(message, width / 2, height / 2, boxW - paddingX * 2);
  ctx.restore();
}

function drawMask(ctx: CanvasRenderingContext2D, rendered: { x: number; y: number; width: number; height: number }, analysis: TrackingBuffers, mask: Uint8Array) {
  ctx.save();
  ctx.fillStyle = "rgba(79, 195, 247, 0.18)";
  const step = Math.max(2, Math.ceil(Math.max(analysis.width, analysis.height) / 140));
  const sx = rendered.width / analysis.width;
  const sy = rendered.height / analysis.height;
  for (let y = 0; y < analysis.height; y += step) {
    for (let x = 0; x < analysis.width; x += step) {
      if (!mask[y * analysis.width + x]) continue;
      ctx.fillRect(rendered.x + x * sx, rendered.y + y * sy, Math.max(1, step * sx), Math.max(1, step * sy));
    }
  }
  ctx.restore();
}

function drawTrackingOverlay(
  ctx: CanvasRenderingContext2D,
  rendered: { x: number; y: number; width: number; height: number },
  analysisW: number,
  analysisH: number,
  track: SmoothedTrack,
) {
  const mapX = (x: number) => rendered.x + (x / analysisW) * rendered.width;
  const mapY = (y: number) => rendered.y + (y / analysisH) * rendered.height;
  const points = track.skeleton.map((p) => ({ x: mapX(p.x), y: mapY(p.y) }));

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // 中轴骨架连线（半透明，顺物体走向，可表达弯曲）
  if (points.length >= 2) {
    ctx.strokeStyle = "rgba(79, 195, 247, 0.55)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
  }

  // 用圆点串成一条线（类似手势识别骨架），覆盖整个物体走向
  ctx.fillStyle = "#4fc3f7";
  for (const p of points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
    ctx.fill();
  }

  const cx = points[0]?.x ?? mapX(track.cx);
  const cy = points[0]?.y ?? mapY(track.cy);
  const label = `角度 ${angleDeg(track.angleRad).toFixed(1)}° · ${(track.confidence * 100).toFixed(0)}%`;
  ctx.font = "12px system-ui, sans-serif";
  const labelW = ctx.measureText(label).width + 14;
  const labelX = clamp(cx + 10, 6, Math.max(6, rendered.x + rendered.width - labelW - 6));
  const labelY = clamp(cy - 28, 8, Math.max(8, rendered.y + rendered.height - 28));
  ctx.fillStyle = "rgba(6, 10, 18, 0.78)";
  ctx.fillRect(labelX, labelY, labelW, 22);
  ctx.fillStyle = "#eaf6ff";
  ctx.fillText(label, labelX + 7, labelY + 15);
  ctx.restore();
}
