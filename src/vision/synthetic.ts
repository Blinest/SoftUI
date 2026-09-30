/* 合成剪影：按已知的 PCC 参数生成背光图像，用来验证整条管线。
 *
 * 为什么要超采样：如果逐像素判断"在不在圆管内"，边缘是硬的，不同朝向的
 * 遮挡面积会跳变 —— 那是我自己造出来的假误差，会把管线的真实精度淹掉。
 * 4× 超采样再盒式降采样，得到的边缘过渡和真实成像接近（真实成像的边缘
 * 还会再软一点，因为镜头有衍射和散焦）。
 *
 * 生成的几何**故意不居中**：偏心和旋转能让"标定矩阵的尺度错误"这类 bug
 * 在验证里暴露出来。如果只测居中的弧，很多错误会互相抵消。 */

import type { Grayscale } from "./types";

export interface SyntheticArm {
  /** 臂根位置（像素）。 */
  baseX: number;
  baseY: number;
  /** 臂根处切向角（弧度）。0 = 朝 +x，π/2 = 朝下（图像 y 轴向下）。 */
  baseAngleRad: number;
  /** 两段曲率（1/像素）。 */
  kappa1PerPx: number;
  kappa2PerPx: number;
  /** 每段弧长（像素）。 */
  segmentLengthPx: number;
}

export interface SyntheticOptions {
  width: number;
  height: number;
  tubeDiameterPx: number;
  /** 超采样倍率，默认 4。 */
  supersample: number;
  backgroundLevel: number;
  foregroundLevel: number;
  /** 加到整图上的高斯噪声标准差。 */
  noiseSigma: number;
  /** 根部是否是平端（真实臂体的夹持端），默认 true。 */
  flatBase: boolean;
}

export const DEFAULT_SYNTHETIC_OPTIONS: SyntheticOptions = {
  width: 960,
  height: 720,
  tubeDiameterPx: 60,
  supersample: 4,
  backgroundLevel: 235,
  foregroundLevel: 26,
  noiseSigma: 2,
  flatBase: true,
};

/** 沿臂体推进，同时收集覆盖矩形需要的包围盒。 */
function traceArm(arm: SyntheticArm, samples: number) {
  const total = 2 * arm.segmentLengthPx;
  const step = total / samples;
  const points: Array<{ x: number; y: number }> = [];
  let x = arm.baseX;
  let y = arm.baseY;
  let theta = arm.baseAngleRad;

  for (let i = 0; i <= samples; i += 1) {
    points.push({ x, y });
    const s = i * step;
    const kappa = s < arm.segmentLengthPx ? arm.kappa1PerPx : arm.kappa2PerPx;
    const ds = step;
    if (Math.abs(kappa * ds) < 1e-12) {
      x += Math.cos(theta) * ds;
      y += Math.sin(theta) * ds;
    } else {
      const thetaEnd = theta + kappa * ds;
      x += (Math.sin(thetaEnd) - Math.sin(theta)) / kappa;
      y -= (Math.cos(thetaEnd) - Math.cos(theta)) / kappa;
      theta = thetaEnd;
    }
  }
  return { points, step };
}

/**
 * 生成一张背光剪影图。
 *
 * 做法：先把整幅图设成背景亮度，然后**逐像素反算**它到臂体中轴线的距离 ——
 * 距离小于半径就是前景。比"沿中轴画圆盘"快得多，而且天然抗锯齿（配合超采样）。
 *
 * **根部切成平端**（`flatBase`，默认开）。真实的臂体根部是夹持/法兰，是一刀
 * 切平的；如果按胶囊模型把根部也做成圆端帽，中轴会一直走到端帽顶点，比结构
 * 长度多半圈。这个差异不是小事：60px 宽的管子多出 30px，而臂长才 200px，
 * 会让曲率积分整体偏小。仿真必须和实物一致，否则验证出来的结论没用。
 */
export function renderArm(arm: SyntheticArm, options: Partial<SyntheticOptions> = {}): Grayscale {
  const opts = { ...DEFAULT_SYNTHETIC_OPTIONS, ...options };
  const { width, height } = opts;
  const radius = opts.tubeDiameterPx / 2;
  const ss = Math.max(1, Math.round(opts.supersample));

  // 采样点密度：每 0.5 像素一个点，保证中轴线本身是准的。
  const { points } = traceArm(arm, Math.ceil((2 * arm.segmentLengthPx) / 0.5));

  const data = new Uint8Array(width * height);
  data.fill(opts.backgroundLevel);

  // 根部平面：像素若落在它的"背面"就不属于臂体 —— 这就是平端。
  const baseDx = points[1].x - points[0].x;
  const baseDy = points[1].y - points[0].y;
  const baseLen = Math.hypot(baseDx, baseDy) || 1;
  const ux = baseDx / baseLen;
  const uy = baseDy / baseLen;

  // 只扫描臂体附近的区域，避免全图 × 全采样点的 O(n²)。
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = radius + ss + 2;
  const x0 = Math.max(0, Math.floor(minX - pad));
  const x1 = Math.min(width - 1, Math.ceil(maxX + pad));
  const y0 = Math.max(0, Math.floor(minY - pad));
  const y1 = Math.min(height - 1, Math.ceil(maxY + pad));

  const r2 = radius * radius;
  for (let py = y0; py <= y1; py += 1) {
    for (let px = x0; px <= x1; px += 1) {
      // 超采样：在像素内取 ss×ss 个点，数落在圆管内的比例。
      let hits = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const fx = px + (sx + 0.5) / ss;
          const fy = py + (sy + 0.5) / ss;
          // 根部背面直接排除
          if (opts.flatBase && (fx - points[0].x) * ux + (fy - points[0].y) * uy < 0) continue;
          // 找最近的中轴采样点。线性扫描够用 —— 采样点间距 0.5px，
          // 这里的目的是生成测试数据，不是运行时性能。
          let bestD2 = Infinity;
          for (let i = 0; i < points.length; i += 1) {
            const dx = points[i].x - fx;
            const dy = points[i].y - fy;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) bestD2 = d2;
            if (bestD2 < r2 * 0.25) break; // 已经足够近，提前退出
          }
          if (bestD2 <= r2) hits += 1;
        }
      }
      const coverage = hits / (ss * ss);
      const value = opts.backgroundLevel + (opts.foregroundLevel - opts.backgroundLevel) * coverage;
      data[py * width + px] = Math.max(0, Math.min(255, Math.round(value)));
    }
  }

  if (opts.noiseSigma > 0) {
    // 自己实现一个确定性 PRNG：Math.random 不可复现，验证就没法比对。
    let seed = 0x2545f491;
    const next = () => {
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >> 17;
      seed ^= seed << 5; seed >>>= 0;
      return seed / 0xffffffff;
    };
    for (let i = 0; i < data.length; i += 1) {
      // Box-Muller 取一个标准正态
      const u1 = Math.max(1e-9, next());
      const u2 = next();
      const gaussian = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      data[i] = Math.max(0, Math.min(255, Math.round(data[i] + gaussian * opts.noiseSigma)));
    }
  }

  return { width, height, data };
}

/**
 * 真值中轴线：按等弧长采样 count 个点，并给出每点处的**物理曲率**（1/m）。
 *
 * 注意返回的是"真值"，可以直接和管线输出逐点比对。
 */
export function groundTruth(
  arm: SyntheticArm,
  count: number,
  mmPerPx: number,
): { points: Array<{ x: number; y: number }>; curvaturePerM: number[] } {
  const total = 2 * arm.segmentLengthPx;
  const step = total / (count - 1);
  const points: Array<{ x: number; y: number }> = [];
  const curvaturePerM: number[] = [];
  let x = arm.baseX;
  let y = arm.baseY;
  let theta = arm.baseAngleRad;

  for (let i = 0; i < count; i += 1) {
    points.push({ x, y });
    const s = i * step;
    const kappaPerPx = s < arm.segmentLengthPx ? arm.kappa1PerPx : arm.kappa2PerPx;
    curvaturePerM.push(kappaPerPx / mmPerPx);
    if (i === count - 1) break;
    if (Math.abs(kappaPerPx * step) < 1e-12) {
      x += Math.cos(theta) * step;
      y += Math.sin(theta) * step;
    } else {
      const thetaEnd = theta + kappaPerPx * step;
      x += (Math.sin(thetaEnd) - Math.sin(theta)) / kappaPerPx;
      y -= (Math.cos(thetaEnd) - Math.cos(theta)) / kappaPerPx;
      theta = thetaEnd;
    }
  }
  return { points, curvaturePerM };
}
