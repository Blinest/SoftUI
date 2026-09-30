/* 从背光剪影到曲率：完整的中轴提取与曲率求解管线。
 *
 * 处理顺序：
 *
 *   灰度图 → 二值化 → 取最大连通域 → 距离变换 → 脊线（整数中轴）
 *          → 沿法向扫掠边缘（亚像素）→ 重采样成 N 个等弧长点
 *          → Savitzky-Golay 局部求导得曲率 → 两段常曲率模型拟合
 *
 * 每一步的取舍都在对应函数上有注释。这里先说三条最容易做错的：
 *
 * 1. **中轴不能用「投影分桶」求**。把像素投影到主轴再分桶取质心，隐含假设
 *    曲线沿主方向单值 —— 臂弯超过约 90° 后两端投影重叠，桶里混进两个分支
 *    的像素，质心落到中间的空处。标定要扫到大弯曲量，这条路走不通。
 *
 * 2. **曲率不能差分求**。见 types.ts 的估算：Δ=5px 时噪声约 7.4 1/m，而
 *    量程只有 0~8 1/m。这里全部走局部多项式拟合。
 *
 * 3. **比例尺由臂体自己给出**。圆柱剪影宽度恒等于 D×比例尺（与朝向无关），
 *    所以量出中位宽度就能定标，不需要标定板。 */

import type {
  AnalyzeOptions,
  AnalyzeResult,
  CenterlinePoint,
  Grayscale,
  PccFit,
  Point,
} from "./types";
import { DEFAULT_ANALYZE_OPTIONS } from "./types";

/* ── 二值化 ── */

/** 大津法：找一个阈值，让前景和背景的类间方差最大。 */
export function estimateOtsuThreshold(gray: Grayscale): number {
  const histogram = new Uint32Array(256);
  const data = gray.data;
  for (let i = 0; i < data.length; i += 1) histogram[data[i]] += 1;

  const total = data.length;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * histogram[i];

  let sumBackground = 0;
  let weightBackground = 0;
  let bestThreshold = 128;
  let bestVariance = -1;

  for (let t = 0; t < 256; t += 1) {
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

function buildMask(gray: Grayscale, threshold: number, mode: "dark" | "bright"): Uint8Array {
  const { data } = gray;
  const mask = new Uint8Array(data.length);
  if (mode === "dark") {
    for (let i = 0; i < data.length; i += 1) mask[i] = data[i] <= threshold ? 1 : 0;
  } else {
    for (let i = 0; i < data.length; i += 1) mask[i] = data[i] >= threshold ? 1 : 0;
  }
  return mask;
}

/* ── 形态学 ── */

/**
 * 可分离的形态学闭运算（先膨胀后腐蚀，方形结构元）。
 *
 * 只用来补镜面高光在臂体内部打出的小孔 —— 背光条件下一般没有孔，所以
 * **默认半径是 0（关闭）**：全图膨胀+腐蚀要对每个像素做 4×(2r+1) 次比较，
 * 640×480 下 r=2 就是约两千万次操作，在 20fps 预算里不容忽视。
 * 真遇到高光再打开。
 */
export function morphologicalClose(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  const dilated = separableMorph(mask, width, height, radius, true);
  return separableMorph(dilated, width, height, radius, false);
}

function separableMorph(src: Uint8Array, width: number, height: number, radius: number, dilate: boolean): Uint8Array {
  const horizontal = new Uint8Array(src.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let acc = dilate ? 0 : 1;
      const from = Math.max(0, x - radius);
      const to = Math.min(width - 1, x + radius);
      for (let k = from; k <= to; k += 1) {
        const v = src[row + k];
        acc = dilate ? (v > acc ? v : acc) : v < acc ? v : acc;
      }
      horizontal[row + x] = acc;
    }
  }
  const out = new Uint8Array(src.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let acc = dilate ? 0 : 1;
      const from = Math.max(0, y - radius);
      const to = Math.min(height - 1, y + radius);
      for (let k = from; k <= to; k += 1) {
        const v = horizontal[k * width + x];
        acc = dilate ? (v > acc ? v : acc) : v < acc ? v : acc;
      }
      out[y * width + x] = acc;
    }
  }
  return out;
}

/* ── 连通域 ── */

interface ComponentResult {
  mask: Uint8Array;
  area: number;
}

/** 取面积最大的前景连通域（四邻域），其余置 0。 */
export function largestComponent(mask: Uint8Array, width: number, height: number): ComponentResult {
  const visited = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);

  const flood = (seed: number, out: Uint8Array | null): number => {
    let top = 0;
    stack[top++] = seed;
    visited[seed] = 1;
    let area = 0;
    while (top > 0) {
      const idx = stack[--top];
      if (out) out[idx] = 1;
      area += 1;
      const x = idx % width;
      const y = (idx / width) | 0;
      if (x > 0 && mask[idx - 1] && !visited[idx - 1]) { visited[idx - 1] = 1; stack[top++] = idx - 1; }
      if (x < width - 1 && mask[idx + 1] && !visited[idx + 1]) { visited[idx + 1] = 1; stack[top++] = idx + 1; }
      if (y > 0 && mask[idx - width] && !visited[idx - width]) { visited[idx - width] = 1; stack[top++] = idx - width; }
      if (y < height - 1 && mask[idx + width] && !visited[idx + width]) { visited[idx + width] = 1; stack[top++] = idx + width; }
    }
    return area;
  };

  // 第一遍：只数面积、找最大的种子。不保留每域的点集，省一次遍历的内存。
  let bestSeed = -1;
  let bestArea = 0;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    const area = flood(start, null);
    if (area > bestArea) { bestArea = area; bestSeed = start; }
  }

  const out = new Uint8Array(mask.length);
  if (bestSeed < 0) return { mask: out, area: 0 };
  // 第二遍：只把最大域拷出来。
  visited.fill(0);
  const area = flood(bestSeed, out);
  return { mask: out, area };
}

/* ── 距离变换 ── */

/**
 * 倒角距离变换（chamfer 3-4）。返回每个前景像素到最近背景像素的近似距离 ×3。
 *
 * 之所以要它：管状目标的**脊线**（局部距离最大的那条线）就是中轴的粗估计，
 * 而且距离值本身就近似等于该处的半宽 —— 顺手给了一个分割是否正常的自检量。
 */
export function distanceTransform(mask: Uint8Array, width: number, height: number): Int32Array {
  const INF = 1 << 24;
  const dist = new Int32Array(mask.length);
  for (let i = 0; i < mask.length; i += 1) dist[i] = mask[i] ? INF : 0;

  // 前向：左上 → 右下
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (!mask[i]) continue;
      let d = dist[i];
      if (y > 0) {
        if (x > 0) d = Math.min(d, dist[i - width - 1] + 4);
        d = Math.min(d, dist[i - width] + 3);
        if (x < width - 1) d = Math.min(d, dist[i - width + 1] + 4);
      }
      if (x > 0) d = Math.min(d, dist[i - 1] + 3);
      dist[i] = d;
    }
  }
  // 后向：右下 → 左上
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const i = y * width + x;
      if (!mask[i]) continue;
      let d = dist[i];
      if (y < height - 1) {
        if (x < width - 1) d = Math.min(d, dist[i + width + 1] + 4);
        d = Math.min(d, dist[i + width] + 3);
        if (x > 0) d = Math.min(d, dist[i + width - 1] + 4);
      }
      if (x < width - 1) d = Math.min(d, dist[i + 1] + 3);
      dist[i] = d;
    }
  }
  return dist;
}

/* ── 中轴追踪 ── */

/**
 * 找一根初始切向：在种子上按各个角度向两侧扫掠，**总宽度最小的那个方向
 * 垂直于臂体轴向**。
 *
 * 道理：沿轴向扫，遇到的是管子端面（很远）；沿垂直方向扫，遇到的是管壁
 * （恰好一个直径）。所以最"窄"的方向就是垂直方向，转 90° 就是轴向。
 *
 * 返回的角度分辨率只有 180/divisions 度，但没关系 —— 行进过程中每一步都会
 * 用边缘重新居中，初值的误差只影响开头一两步就被纠正了。
 */
function findInitialTangent(
  gray: Grayscale,
  seed: Point,
  maxScanPx: number,
  referenceWidthPx: number,
  divisions = 64,
): { tx: number; ty: number; widthPx: number } | null {
  // **只在看起来像直径的方向里挑最窄的**。
  //
  // 不加这个带约束的话，噪声边缘会造出一个远窄于直径的假方向，它比真正的
  // 垂直方向还窄，于是被选中 —— 切向就错了，接着 marchFrom 第一步就因
  // 宽度超过 reference×1.25 而退出（实测 σ=6 时两个方向都是 0 个点）。
  // 距离变换给出的宽度估计是稳健的，正好拿来当这条带的基准。
  const low = referenceWidthPx * 0.75;
  const high = referenceWidthPx * 1.3;

  let best: { tx: number; ty: number; widthPx: number } | null = null;
  for (let k = 0; k < divisions; k += 1) {
    const angle = (Math.PI * k) / divisions;
    const nx = Math.cos(angle);
    const ny = Math.sin(angle);
    const a = scanEdge(gray, seed.x, seed.y, nx, ny, maxScanPx);
    const b = scanEdge(gray, seed.x, seed.y, -nx, -ny, maxScanPx);
    if (a === null || b === null) continue;
    const total = a + b;
    if (total < low || total > high) continue;
    if (!best || total < best.widthPx) best = { tx: nx, ty: ny, widthPx: total };
  }
  if (!best) return null;
  // best 是"垂直方向"，转 90° 得到轴向
  return { tx: -best.ty, ty: best.tx, widthPx: best.widthPx };
}

/**
 * 从种子出发沿给定切向行进，逐步用「垂直扫描 + 两侧边缘取中点」重新居中。
 *
 * 每一步：
 *   1. 沿当前切向前进一小段，得到预测点；
 *   2. 在预测点处向两侧扫掠找亚像素边缘，取中点为修正后的中轴点；
 *   3. 用「若干步之前的点 → 当前点」的方向更新切向（比用相邻两点平滑）。
 *
 * 这样做同时解决了两件事：得到**有序**的点列，以及每点都是**亚像素**精度。
 * 管子弯了也没关系 —— 方向是走出来的，不是投影出来的。
 */
export interface MarchResult {
  points: CenterlinePoint[];
  /** 是否因为进入端帽（宽度连续收窄）而停止 —— 说明这一端有端帽需要裁掉。 */
  stoppedByCap: boolean;
  /** 停止处的剪影宽度，用来反算端帽残长。 */
  lastWidthPx: number;
}

function marchFrom(
  gray: Grayscale,
  mask: Uint8Array,
  start: Point,
  tangent: { tx: number; ty: number },
  referenceWidthPx: number,
  maxScanPx: number,
  step: number,
  limit: number,
): MarchResult {
  const out: CenterlinePoint[] = [];
  let narrowStreak = 0;
  let stoppedByCap = false;
  let x = start.x;
  let y = start.y;
  let tx = tangent.tx;
  let ty = tangent.ty;
  // 切向用「若干步之前 → 现在」来更新，比相邻两点稳得多（相邻两点的方向
  // 会被亚像素噪声放大）。
  const history: Point[] = [{ x, y }];

  for (let i = 0; i < limit; i += 1) {
    const px = x + tx * step;
    const py = y + ty * step;
    const nx = -ty;
    const ny = tx;

    const left = scanEdge(gray, px, py, nx, ny, maxScanPx);
    const right = scanEdge(gray, px, py, -nx, -ny, maxScanPx);
    if (left === null || right === null) break;

    const widthPx = left + right;
    // 宽度必须和参考值接近。
    //
    // **上界收 1.25**：扫描方向一旦偏离垂直，穿过的弦长变成 D/cosθ，宽度虚高。
    // 58 → 60 的变化看不出来，但 78、81 这种一定是扫斜了，必须判失效。
    if (widthPx > referenceWidthPx * 1.25) break;

    // **下界要求「连续 3 步」而不是单步**。
    //
    // 进入端帽后宽度从 D 单调收到 0（端帽是半球，宽度 = 2√(r²−d²)）。单步
    // 判低容易被管身上的抗锯齿噪声误伤，所以要求连续 3 步都低于 0.92D。
    //
    // **必须在这里停住**：继续走下去，扫描方向会在端帽的曲面上歪掉，中点乱飘，
    // 最后折回管身 —— 那时宽度又回到 D，看起来完全正常，但中轴已经多走了一
    // 大段来回。实测 κ=1.5 就是因此在端帽处折返，长度多出 28%。
    if (widthPx < referenceWidthPx * 0.92) {
      narrowStreak += 1;
      if (narrowStreak >= 3) { stoppedByCap = true; break; }
    } else {
      narrowStreak = 0;
    }

    const midT = (left - right) / 2;
    const mx = px + nx * midT;
    const my = py + ny * midT;
    // 中点必须仍落在掩膜内，否则说明已经走出管子了。
    const mi = Math.round(my) * gray.width + Math.round(mx);
    if (mi < 0 || mi >= mask.length || !mask[mi]) break;

    out.push({
      x: mx, y: my, tx, ty, nx, ny,
      left: { x: px + nx * left, y: py + ny * left },
      right: { x: px - nx * right, y: py - ny * right },
      halfLeft: left,
      halfRight: right,
      widthPx,
      quality: 1,
    });

    // ── 更新切向（**必须阻尼**）──
    //
    // 这里存在一个正反馈回路：扫描方向偏 → 找到的"边缘"不再是两侧管壁 →
    // 中点偏移 → 切向更偏 → ……。实测在管子端面附近会直接跑飞（切向转
    // 45°，中点横移 5px，然后整条中轴折返走第二遍）。
    //
    // 用指数平滑把回路断开：管子是光滑的，切向本来就该缓慢变化。取 0.15
    // 的系数意味着滞后约 7 步，对 κ=6 1/m 的弯曲只差 0.9°，而重新居中会
    // 把这点角度误差转成的横向误差修掉。
    history.push({ x: mx, y: my });
    if (history.length > 4) history.shift();
    const back = history[0];
    const dx = mx - back.x;
    const dy = my - back.y;
    const dl = Math.hypot(dx, dy);
    if (dl > 1e-6) {
      const alpha = 0.15;
      tx += (dx / dl - tx) * alpha;
      ty += (dy / dl - ty) * alpha;
      const tl = Math.hypot(tx, ty);
      if (tl > 1e-9) { tx /= tl; ty /= tl; }
    }
    x = mx;
    y = my;
  }
  return { points: out, stoppedByCap, lastWidthPx: out.length ? out[out.length - 1].widthPx : 0 };
}

/**
 * 完整的中轴提取：取最大连通域 → 距离变换定种子 → 找初始切向 → 双向行进。
 *
 * **不要用「沿固定主轴投影分桶」或「在距离场上贪心行走」**：
 *  - 前者隐含「曲线沿主方向单值」，臂弯过 90° 后两端投影重叠，桶里混进两个
 *    分支的像素，质心落到中间的空处；
 *  - 后者对宽管子无效 —— 60px 宽管子的距离场中轴是一片「高原」，贪心走法
 *    没有唯一解，会在高原上乱窜（实测能走出 16 倍的弧长）。
 *
 * 行进法两个问题都没有：方向是走出来的，且每步都重新居中。
 */
export function traceCenterline(
  gray: Grayscale,
  mask: Uint8Array,
  dist: Int32Array,
  options: { maxScanPx?: number; step?: number } = {},
): {
  centerline: CenterlinePoint[];
  seed: Point | null;
  /** 两端的行走结果，供端帽裁剪判断该端是否真有端帽。 */
  endInfo: { head: MarchResult; tail: MarchResult };
} {
  const { width, height } = gray;
  const step = options.step ?? 1;
  // 扫描距离的默认值取**图像对角线**，不要取短边的比例。
  //
  // 种子落在臂体中段时，按几何算打到端部需要
  //   L/2·cos(θ/2) + (D/2)·sin(θ/2)   （L 臂长、θ 这段弧的转角）
  // 竖直臂在 960×720 的图里就是 104px，而 max(8, min(w,h)×0.25)=180 只勉强够，
  // 臂一斜就不够。scanEdge 是 O(maxScan)，给足余量的代价很小。
  const scanLimit = options.maxScanPx ?? Math.hypot(width, height);

  let seedIndex = -1;
  let seedDist = 0;
  for (let i = 0; i < dist.length; i += 1) {
    if (dist[i] > seedDist) { seedDist = dist[i]; seedIndex = i; }
  }
  if (seedIndex < 0 || seedDist <= 0) { const empty = { points: [], stoppedByCap: false, lastWidthPx: 0 }; return { centerline: [], seed: null, endInfo: { head: empty, tail: empty } }; }
  const seed: Point = { x: seedIndex % width, y: (seedIndex / width) | 0 };

  // 倒角距离的权重是 3/4，除以 3 近似回欧氏距离。距离变换的最大值
  // 约等于半宽，所以参考宽度约为它的两倍。
  const referenceWidthPx = (seedDist / 3) * 2;

  const initial = findInitialTangent(gray, seed, scanLimit, referenceWidthPx);
  if (!initial) { const empty = { points: [], stoppedByCap: false, lastWidthPx: 0 }; return { centerline: [], seed, endInfo: { head: empty, tail: empty } }; }

  // 参考宽度用**切向搜索**的结果：它就是实测的直径，比距离变换准。
  //
  // 倒角距离的权重是 3/4，除以 3 只是近似回欧氏距离 —— 实测在 60px 管子
  // 上给出 62.7，偏 4.5%。而切向搜索直接量的是两侧管壁的像素距离，实测 59.75。
  // （切向搜索的结果已经在 findInitialTangent 里被距离变换估值的 ±30% 带约束
  // 过，所以不会像早先那样被噪声带跑。）
  const reference = initial.widthPx > 1 ? initial.widthPx : referenceWidthPx;

  const limit = Math.ceil((width + height) * 4);
  const forward = marchFrom(gray, mask, seed, { tx: initial.tx, ty: initial.ty }, reference, scanLimit, step, limit);
  const backward = marchFrom(gray, mask, seed, { tx: -initial.tx, ty: -initial.ty }, reference, scanLimit, step, limit);

  // backward 是从种子往回走出来的，反转后接到 forward 前面，得到「从头到尾」。
  return {
    centerline: [...[...backward.points].reverse(), ...forward.points],
    seed,
    endInfo: { head: backward, tail: forward },
  };
}

/* ── 亚像素边缘 ── */

/** 双线性插值采样。越界返回 -1，调用方据此判断"扫出图像了"。 */
function sampleBilinear(gray: Grayscale, x: number, y: number): number {
  const { width, height, data } = gray;
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return -1;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = data[y0 * width + x0];
  const b = data[y0 * width + x1];
  const c = data[y1 * width + x0];
  const d = data[y1 * width + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/**
 * 沿法向扫掠，找亚像素边缘位置。
 *
 * 返回**带符号**的偏移量（沿法向为正）。找不到边缘返回 null。
 *
 * 亚像素的做法是标准的抛物线插值：在一片梯度里找极值，再用极值点两侧的
 * 两个梯度值拟合抛物线，取顶点。比直接取最大梯度那个整数位置准一个量级。
 */
function scanEdge(
  gray: Grayscale,
  originX: number,
  originY: number,
  nx: number,
  ny: number,
  maxDistance: number,
): number | null {
  const step = 0.25;
  const samples = Math.max(4, Math.floor(maxDistance / step));
  const values = new Float64Array(samples);
  for (let k = 0; k < samples; k += 1) {
    const t = (k + 1) * step;
    values[k] = sampleBilinear(gray, originX + nx * t, originY + ny * t);
  }

  // 先把明显扫出图像的尾部截掉，避免把边界当边缘。
  let usable = samples;
  while (usable > 0 && values[usable - 1] < 0) usable -= 1;
  if (usable < 4) return null;

  let bestIndex = -1;
  let bestGradient = 0;
  // 上界留到 usable-2，因为下面要用 values[bestIndex + 2] 做插值。
  for (let k = 1; k < usable - 2; k += 1) {
    const gradient = Math.abs(values[k + 1] - values[k - 1]);
    if (gradient > bestGradient) { bestGradient = gradient; bestIndex = k; }
  }
  // 梯度太弱说明这里根本没有边界（比如走进了一片均匀区）。
  if (bestIndex < 1 || bestGradient < 8) return null;

  // ── 亚像素定位：**梯度质心**，不是抛物线顶点 ──
  //
  // 边缘是阶跃，它的梯度是一个三角形脉冲。抛物线顶点假设梯度脉冲关于峰值
  // **对称**，三角形正好满足 —— 但前提是峰值恰好落在某个采样点上。峰值落在
  // 两个采样点之间时，三角形脉冲的采样是不对称的，抛物线顶点会有偏差。
  //
  // 实测这个偏差在 60px 宽的管子上表现为中轴上 ±0.124px 的纹波；单个点看不
  // 出来，但二阶导把它放大成 0.28 1/m 的曲率噪声底 —— 已经接近 0.5 1/m 的
  // 目标精度，必须压下去。
  //
  // 质心法是加权平均，对脉冲形状不敏感（三角形、高斯都一样），是边缘亚像素
  // 定位里更稳的做法。窗口取 ±3 个采样格，刚好覆盖梯度脉冲的支撑区。
  const window = 3;
  const from = Math.max(0, bestIndex - window);
  const to = Math.min(usable - 1, bestIndex + window);
  let weightSum = 0;
  let momentSum = 0;
  for (let k = from; k <= to; k += 1) {
    const g = Math.abs(values[Math.min(k + 1, usable - 1)] - values[Math.max(k - 1, 0)]);
    // 只累计有意义的梯度，避免把远处的噪声也拉进来把质心拖偏。
    const weight = g > bestGradient * 0.15 ? g : 0;
    weightSum += weight;
    momentSum += weight * k;
  }
  if (!(weightSum > 1e-9)) return (bestIndex + 1) * step;
  const centerIndex = momentSum / weightSum;
  // 采样点 k 位于 t = (k + 1)·step（k=0 时 t=step）。
  return (centerIndex + 1) * step;
}

/**
 * 把整数脊线精修成亚像素中轴。
 *
 * 保留它是为了对照：`traceCenterline` 是现在实际用的路径（边走边居中），
 * 这个函数是早期「先有粗脊线、再逐点精修」的思路。留着给以后的实验用，
 * 不参与主流程。
 */
export function refineCenterline(
  gray: Grayscale,
  polyline: Point[],
  tangentWindow: number,
  maxScanPx: number,
): CenterlinePoint[] {
  if (polyline.length < 3) return [];
  const out: CenterlinePoint[] = [];

  for (let i = 0; i < polyline.length; i += 1) {
    const a = polyline[Math.max(0, i - tangentWindow)];
    const b = polyline[Math.min(polyline.length - 1, i + tangentWindow)];
    let tx = b.x - a.x;
    let ty = b.y - a.y;
    const tl = Math.hypot(tx, ty);
    if (tl < 1e-6) continue;
    tx /= tl; ty /= tl;
    const nx = -ty;
    const ny = tx;

    const originX = polyline[i].x;
    const originY = polyline[i].y;
    const left = scanEdge(gray, originX, originY, nx, ny, maxScanPx);
    const right = scanEdge(gray, originX, originY, -nx, -ny, maxScanPx);
    if (left === null || right === null) continue;

    const midT = (left - right) / 2;
    const x = originX + nx * midT;
    const y = originY + ny * midT;
    const widthPx = left + right;
    out.push({
      x, y, tx, ty, nx, ny,
      left: { x: originX + nx * left, y: originY + ny * left },
      right: { x: originX - nx * right, y: originY - ny * right },
      halfLeft: left,
      halfRight: right,
      widthPx,
      quality: 1,
    });
  }
  return out;
}

/* ── 重采样 ── */

/** 按累计弧长把点列重采样成等距的 count 个点。 */
export function resampleByArcLength(points: Point[], count: number): Point[] {
  if (points.length < 2 || count < 2) return [];
  const cumulative = new Float64Array(points.length);
  for (let i = 1; i < points.length; i += 1) {
    cumulative[i] = cumulative[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  const total = cumulative[points.length - 1];
  if (!(total > 0)) return [];

  const out: Point[] = [];
  let cursor = 1;
  for (let k = 0; k < count; k += 1) {
    const target = (total * k) / (count - 1);
    while (cursor < points.length - 1 && cumulative[cursor] < target) cursor += 1;
    const segStart = cumulative[cursor - 1];
    const segLength = cumulative[cursor] - segStart;
    const t = segLength > 1e-9 ? (target - segStart) / segLength : 0;
    out.push({
      x: points[cursor - 1].x + (points[cursor].x - points[cursor - 1].x) * t,
      y: points[cursor - 1].y + (points[cursor].y - points[cursor - 1].y) * t,
    });
  }
  return out;
}

/* ── 曲率：Savitzky-Golay 局部多项式求导 ── */

/**
 * 小规模线性方程组的高斯消元（带部分主元）。奇异返回 null。
 *
 * 这段和 robot/pose3d.ts 里的 solveLinear 是同一个套路。这里没有共用是
 * 因为 vision 包不该反向依赖 robot 包；等第三处需要它时再抽出来。
 */
function solveLinearSystem(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) < 1e-14) return null;
    if (pivot !== col) { const tmp = m[pivot]; m[pivot] = m[col]; m[col] = tmp; }
    const diag = m[col][col];
    for (let row = col + 1; row < n; row += 1) {
      const factor = m[row][col] / diag;
      if (factor === 0) continue;
      for (let k = col; k <= n; k += 1) m[row][k] -= factor * m[col][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = m[row][n];
    for (let k = row + 1; k < n; k += 1) sum -= m[row][k] * x[k];
    x[row] = sum / m[row][row];
  }
  return x;
}

/** 局部多项式拟合的系数（等距采样、间距为 1）。 */
function polynomialFit(values: number[], count: number, offset: number, order: number): number[] | null {
  const rows = count;
  const cols = order + 1;
  const A: number[][] = [];
  for (let i = 0; i < rows; i += 1) {
    const row: number[] = [];
    const t = i - offset;
    let power = 1;
    for (let c = 0; c < cols; c += 1) { row.push(power); power *= t; }
    A.push(row);
  }
  // 正规方程 (AᵀA) c = Aᵀ y
  const M: number[][] = Array.from({ length: cols }, () => new Array<number>(cols).fill(0));
  const rhs = new Array<number>(cols).fill(0);
  for (let i = 0; i < cols; i += 1) {
    for (let j = 0; j < cols; j += 1) {
      let sum = 0;
      for (let r = 0; r < rows; r += 1) sum += A[r][i] * A[r][j];
      M[i][j] = sum;
    }
    let sum = 0;
    for (let r = 0; r < rows; r += 1) sum += A[r][i] * values[r];
    rhs[i] = sum;
  }
  return solveLinearSystem(M, rhs);
}

/**
 * 用 Savitzky-Golay 局部多项式求每点的一阶、二阶导数。
 *
 * 对每个点取一个以它为中心的窗口，拟合 order 阶多项式，再取该点处的导数。
 * 边界上的窗口向内平移，但**仍在偏移处求值**，所以两端也是准的。
 *
 * 为什么非要这样：二阶差分的噪声放大是 1/Δ²，见 types.ts 的估算 —— 在这里
 * 会直接把信号淹掉。局部多项式拟合的噪声抑制随窗口长度增长，是本问题的
 * 唯一可行解。
 */
export function savitzkyGolayDerivatives(
  values: number[],
  halfWindow: number,
  order: number,
): { first: number[]; second: number[] } {
  const n = values.length;
  const first = new Array<number>(n).fill(0);
  const second = new Array<number>(n).fill(0);
  if (n < 3) return { first, second };
  const window = Math.min(halfWindow, Math.floor((n - 1) / 2));
  if (window < 1) return { first, second };
  const count = 2 * window + 1;
  const deg = Math.min(order, count - 1);

  for (let i = 0; i < n; i += 1) {
    const start = Math.max(0, Math.min(i - window, n - count));
    const seg = values.slice(start, start + count);
    const offset = i - start;
    const coeffs = polynomialFit(seg, count, offset, deg);
    if (!coeffs) continue;
    first[i] = coeffs[1] ?? 0;
    second[i] = coeffs[2] ? 2 * coeffs[2] : 0;
  }
  return { first, second };
}

/**
 * 由点列求每点的带符号曲率（1/像素）。
 *
 * 符号约定（**图像坐标系，x 向右、y 向下**）：
 *   κ = (x′y″ − y′x″) / (x′² + y′²)^1.5
 * 在这个约定下，y 轴朝下意味着「逆时针弯」得到负值。具体的正负不必记，
 * 只要下游统一 —— 换算到 mm 坐标系时 y 会翻转，符号也跟着翻，见 analyzeFrame。
 */
export function curvatureFromPoints(points: Point[], halfWindow: number, order: number): number[] {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const dx = savitzkyGolayDerivatives(xs, halfWindow, order);
  const dy = savitzkyGolayDerivatives(ys, halfWindow, order);
  const out: number[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const x1 = dx.first[i];
    const y1 = dy.first[i];
    const speed = Math.hypot(x1, y1);
    if (speed < 1e-9) { out.push(0); continue; }
    const numerator = x1 * dy.second[i] - y1 * dx.second[i];
    out.push(numerator / (speed * speed * speed));
  }
  return out;
}

/* ── 两段常曲率拟合 ── */

/**
 * 从 `(x, y, θ)` 出发，沿常曲率 κ 走弧长 s 后的位置与切向（图像坐标系）。
 *
 * 这是整个 PCC 拟合的唯一几何原语：一段圆弧的弦向量是
 *   Δx = (sin(θ+κs) − sinθ)/κ,  Δy = −(cos(θ+κs) − cosθ)/κ
 * κ→0 时取直线。**必须走「按物理弧长积分」而不是「按归一化参数积分」**，
 * 否则曲率值的物理含义就没了。
 */
function advance(x: number, y: number, theta: number, kappa: number, s: number) {
  if (Math.abs(kappa * s) < 1e-12) {
    return { x: x + Math.cos(theta) * s, y: y + Math.sin(theta) * s, theta };
  }
  const thetaEnd = theta + kappa * s;
  return {
    x: x + (Math.sin(thetaEnd) - Math.sin(theta)) / kappa,
    y: y - (Math.cos(thetaEnd) - Math.cos(theta)) / kappa,
    theta: thetaEnd,
  };
}

/**
 * 把测量点拟合成两段常曲率圆弧（PCC）。
 *
 * 起点端（臂根）未知，所以**两个方向各拟一次**，取残差小的那个。拟合本身
 * 很便宜，这条路比"猜哪端是根"可靠 —— 臂弯大了之后从哪头看都像一条弧，
 * 光凭几何分不出来。
 */
export function fitPccModel(points: Point[], segmentLengthPx: number): PccFit | null {
  if (points.length < 6 || !(segmentLengthPx > 0)) return null;
  const reversed = [...points].reverse();

  const forward = fitPccOneDirection(points, segmentLengthPx);
  const backward = fitPccOneDirection(reversed, segmentLengthPx);
  if (!forward && !backward) return null;
  if (!forward) return flipPcc(backward as PccFit, segmentLengthPx);
  if (!backward) return forward;
  return forward.residualRmsPx <= backward.residualRmsPx ? forward : flipPcc(backward, segmentLengthPx);
}

/** 用 PCC 参数算出末端位置与切向角。 */
function pccEndPose(fit: PccFit, segmentLengthPx: number) {
  const a = advance(fit.baseX, fit.baseY, fit.baseAngleRad, fit.kappa1PerPx, segmentLengthPx);
  return advance(a.x, a.y, a.theta, fit.kappa2PerPx, segmentLengthPx);
}

/**
 * 把「从另一端起算」的拟合翻回正向参数化。
 *
 * 同一条曲线反向遍历时，Frenet 标架翻转，曲率**变号**，两段的先后顺序也
 * 调换，所以 κ₁' = −κ₂、κ₂' = −κ₁。
 */
function flipPcc(fit: PccFit, segmentLengthPx: number): PccFit {
  const end = pccEndPose(fit, segmentLengthPx);
  return {
    baseX: end.x,
    baseY: end.y,
    baseAngleRad: end.theta + Math.PI,
    kappa1PerPx: -fit.kappa2PerPx,
    kappa2PerPx: -fit.kappa1PerPx,
    residualRmsPx: fit.residualRmsPx,
    iterations: fit.iterations,
  };
}

/**
 * 单方向拟合。参数 `[x₀, y₀, θ₀, κ₁, κ₂]`，曲率单位为 1/像素。
 *
 * 用带阻尼的高斯-牛顿（LM）。残差是「模型上的第 j 个等弧长采样点」与
 * 「测量的第 j 个点」的距离 —— 测量点已经重采样成等弧长，所以模型侧也只
 * 要按等弧长取点，**不需要做最近点搜索**。这正是前面重采样那一步的价值。
 */
function fitPccOneDirection(points: Point[], segmentLengthPx: number): PccFit | null {
  const n = points.length;
  // 模型总长是**两段之和**：每步 = 2L/(n−1)。写成 L/(n−1) 会让模型只覆盖
  // 半根臂，拟合出来的曲率系统性偏大、残差也下不去。
  const step = (2 * segmentLengthPx) / (n - 1);
  const first = points[0];
  const second = points[1];
  const params = [first.x, first.y, Math.atan2(second.y - first.y, second.x - first.x), 0, 0];

  const model = (p: number[]): Point[] => {
    const out: Point[] = [];
    for (let j = 0; j < n; j += 1) {
      const s = j * step;
      // 前 L/2 按 κ₁ 走，之后按 κ₂ 走。写成「到 s 为止各走多少」而不是
      // 逐步累加，是为了让每个点是 s 的纯函数、不受浮点累积影响。
      const runtime1 = Math.min(s, segmentLengthPx / 2);
      const runtime2 = Math.max(0, s - segmentLengthPx / 2);
      let st = advance(p[0], p[1], p[2], p[3], runtime1);
      if (runtime2 > 0) st = advance(st.x, st.y, st.theta, p[4], runtime2);
      out.push({ x: st.x, y: st.y });
    }
    return out;
  };

  const residuals = (p: number[]): number[] => {
    const m = model(p);
    const r: number[] = [];
    for (let j = 0; j < n; j += 1) {
      r.push(points[j].x - m[j].x);
      r.push(points[j].y - m[j].y);
    }
    return r;
  };

  let current = [...params];
  let residual = residuals(current);
  let cost = residual.reduce((s, v) => s + v * v, 0);
  let damping = 1e-3;
  let iterations = 0;

  for (let stepIndex = 0; stepIndex < 60; stepIndex += 1) {
    iterations = stepIndex + 1;
    if (Math.sqrt(cost / (2 * n)) < 0.02) break; // 残差已到亚像素级，够用

    // 数值雅可比：5 个参数各扰动一次。位置/角度的量级是 1e2~1e0，
    // 曲率是 1e-3，步长必须分开取，否则曲率那几列的差分会被舍入误差吃掉。
    const jac: number[][] = Array.from({ length: 2 * n }, () => new Array<number>(5).fill(0));
    for (let k = 0; k < 5; k += 1) {
      const h = k < 3 ? 1e-4 : 1e-7;
      const probe = [...current];
      probe[k] += h;
      const delta = residuals(probe);
      for (let r = 0; r < 2 * n; r += 1) jac[r][k] = (delta[r] - residual[r]) / h;
    }

    // (JᵀJ + λI) Δ = Jᵀr —— J 是 ∂残差/∂参数，而残差 = 测量 − 模型，
    // 所以 ∂模型/∂参数 = −J。最小化 ‖r − FΔ‖² 给出 Δ = −(JᵀJ)⁻¹Jᵀr。
    // **负号丢了就会朝误差增大的方向走**，表现为一次迭代就退出。
    const A: number[][] = Array.from({ length: 5 }, () => new Array<number>(5).fill(0));
    const b = new Array<number>(5).fill(0);
    for (let i = 0; i < 5; i += 1) {
      for (let j = 0; j < 5; j += 1) {
        let sum = 0;
        for (let r = 0; r < 2 * n; r += 1) sum += jac[r][i] * jac[r][j];
        A[i][j] = sum;
      }
      let sum = 0;
      for (let r = 0; r < 2 * n; r += 1) sum += jac[r][i] * residual[r];
      b[i] = -sum;
    }

    let accepted = false;
    for (let attempt = 0; attempt < 6 && !accepted; attempt += 1) {
      const damped = A.map((row, i) => row.map((v, j) => (i === j ? v + damping * (1 + v) : v)));
      const delta = solveLinearSystem(damped, b);
      if (!delta) { damping *= 10; continue; }
      const candidate = current.map((v, i) => v + delta[i]);
      const nextResidual = residuals(candidate);
      const nextCost = nextResidual.reduce((s, v) => s + v * v, 0);
      if (nextCost < cost) {
        current = candidate;
        residual = nextResidual;
        cost = nextCost;
        damping = Math.max(damping * 0.3, 1e-9);
        accepted = true;
      } else {
        damping *= 10;
      }
    }
    if (!accepted) break;
  }

  return {
    baseX: current[0],
    baseY: current[1],
    baseAngleRad: current[2],
    kappa1PerPx: current[3],
    kappa2PerPx: current[4],
    residualRmsPx: Math.sqrt(cost / (2 * n)),
    iterations,
  };
}

/* ── 总入口 ── */

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 掐掉两端的「端帽」延伸段。
 *
 * 圆柱管的剪影在末端是半圆端帽，中轴追踪会一直走到端帽的顶点 —— 比结构端面
 * 多出**一整个半径**。60px 宽的管子就是 30px，占 200px 臂长的 15%，会让曲率
 * 整体偏小 15%。绝对不能忽略。
 *
 * 分两步：
 *
 * 1. **按宽度阈值筛出端帽**。端帽段宽度从 D 单调收到 0，而管身段恒为 D。
 *    阈值取 0.9D 是为了躲开抗锯齿噪声（管身上宽度有 ±0.5px 浮动，约 1%）。
 *
 * 2. **把残余的端帽长度算准扣掉**。在宽度 = 0.9D 处还没有到端面 —— 设端帽
 *    是半径 r 的半球，宽度 w = 2√(r² − t²)，令 w = 0.9·2r 得 t = r·√(1−0.81)
 *    ≈ 0.436r。也就是说还剩 0.436r 的弧长没扣，按半径算就是 0.218·D。
 *
 * 注意第二步只对**真的被裁剪过的那一端**做：平端（臂根夹持处）的宽度从一开始
 * 就等于 D，第一步会立刻停住，此时不该再扣 —— 那一端本来就没有端帽。
 */
function trimEndCaps(centerline: CenterlinePoint[], referenceWidthPx: number): CenterlinePoint[] {
  const floor = referenceWidthPx * 0.92;
  let start = 0;
  let end = centerline.length - 1;
  while (start < end && centerline[start].widthPx < floor) start += 1;
  while (end > start && centerline[end].widthPx < floor) end -= 1;

  // 端帽残长（沿中轴的像素距离），由**实际停止处的宽度**反算：
  //   w = 2√(r² − d²)  ⟹  d = √(r² − (w/2)²)
  // 见上面第 2 步的推导。
  const residueFor = (widthPx: number): number => {
    const r = referenceWidthPx / 2;
    const clamped = Math.min(widthPx / 2, r * 0.999);
    return Math.sqrt(Math.max(0, r * r - clamped * clamped));
  };

  // 只在**该端确实有端帽**时才往里退。平端（臂根夹持处）的宽度从一开始就是 D，
  // 第一步会立刻停住，此时 start/end 没动过，不该再退。
  const hadCapAtStart = start > 0;
  const hadCapAtEnd = end < centerline.length - 1;

  const retreat = (from: number, direction: 1 | -1, distance: number): number => {
    let index = from;
    let travelled = 0;
    while (index > 0 && index < centerline.length - 1 && travelled < distance) {
      const a = centerline[index];
      const b = centerline[index + direction];
      travelled += Math.hypot(b.x - a.x, b.y - a.y);
      index += direction;
    }
    return index;
  };

  const trimmedStart = hadCapAtStart ? retreat(start, 1, residueFor(centerline[start].widthPx)) : start;
  const trimmedEnd = hadCapAtEnd ? retreat(end, -1, residueFor(centerline[end].widthPx)) : end;

  if (trimmedEnd - trimmedStart < 8) return centerline.slice(start, end + 1);
  return centerline.slice(trimmedStart, trimmedEnd + 1);
}

function failure(reason: string, threshold: number): AnalyzeResult {
  return {
    ok: false, reason, threshold, maskArea: 0,
    centerline: [], centerlineLengthPx: 0,
    pointsPx: [], pointsMm: [],
    scaleMmPerPx: 0, widthMedianPx: 0, widthConsistency: 0,
    curvaturePerMm: [], curvaturePerM: [],
    pccFit: null,
  };
}

/**
 * 完整管线：灰度图 → 中轴线 → 60 个点 → 曲率。
 *
 * 全过程不需要任何硬件假设之外的先验：直径用来定比例尺，臂长用来判断
 * 是否截断，仅此而已。
 */
export function analyzeFrame(gray: Grayscale, options: Partial<AnalyzeOptions> = {}): AnalyzeResult {
  const opts: AnalyzeOptions = { ...DEFAULT_ANALYZE_OPTIONS, ...options };
  const { width, height } = gray;
  if (width < 16 || height < 16) return failure("图像太小", 0);

  const threshold = opts.threshold === "otsu" ? estimateOtsuThreshold(gray) : opts.threshold;

  const rawMask = buildMask(gray, threshold, opts.mode);
  const closed = morphologicalClose(rawMask, width, height, opts.closeRadius);
  const { mask, area } = largestComponent(closed, width, height);

  // 太小的连通域是噪声，不是臂体。
  if (area < width * height * 0.002) return failure("未找到足够大的剪影，检查光照/阈值/目标模式", threshold);

  const dist = distanceTransform(mask, width, height);
  const traced = traceCenterline(gray, mask, dist, { step: opts.traceStep });
  if (traced.centerline.length < 12) return failure("中轴提取失败，剪影可能被截断或过短", threshold);

  // 宽度一致性：理想情况下沿线宽度应当恒定（圆柱剪影的固有性质）。
  // 偏离得越多，越说明分割有问题（高光劈裂、遮挡、边缘出画）。
  const rawWidths = traced.centerline.map((p) => p.widthPx);
  const rawWidthMedian = median(rawWidths);
  if (!(rawWidthMedian > 1)) return failure("剪影宽度异常", threshold);

  const centerline = trimEndCaps(traced.centerline, rawWidthMedian);
  if (centerline.length < 12) return failure("中轴有效段过短，管子可能被截断", threshold);

  const widths = centerline.map((p) => p.widthPx);
  const widthMedianPx = median(widths);
  const deviations = widths.map((w) => Math.abs(w - widthMedianPx) / widthMedianPx);
  const meanDeviation = deviations.reduce((s, v) => s + v, 0) / deviations.length;
  const widthConsistency = Math.max(0, 1 - meanDeviation * 2);
  for (let i = 0; i < centerline.length; i += 1) {
    centerline[i].quality = Math.max(0, 1 - deviations[i] * 4);
  }

  // 比例尺由臂体自己给出：圆柱剪影宽度恒等于 D × 比例尺，与朝向无关。
  const scaleMmPerPx = opts.tubeDiameterMm / widthMedianPx;

  let centerlineLengthPx = 0;
  for (let i = 1; i < centerline.length; i += 1) {
    centerlineLengthPx += Math.hypot(centerline[i].x - centerline[i - 1].x, centerline[i].y - centerline[i - 1].y);
  }

  const pointsPx = resampleByArcLength(centerline.map((p) => ({ x: p.x, y: p.y })), opts.sampleCount);
  if (pointsPx.length < 6) return failure("重采样失败", threshold);

  // ── 定序：把靠近根部提示的那端作为臂根 ──
  //
  // 中轴追踪出来的顺序是**任意的**（取决于种子点往哪边走）。而 κ₁/κ₂ 对应
  // 不同的驱动通道，顺序反了整个标定就反了 —— 两段常曲率从两头看都成立，
  // 拟合残差也一样，光靠几何分不出来。所以必须由外部给一个"臂根在哪"的提示。
  //
  // **必须放在求曲率之前**：点序反了的话，(x′y″−y′x″) 整体变号，曲率会
  // 取反、两段的先后也颠倒 —— 而且两条剖面看起来都"很合理"，极难察觉。
  const rootRef = opts.rootHintPx ?? { x: width / 2, y: height };
  const headDistance = (pointsPx[0].x - rootRef.x) ** 2 + (pointsPx[0].y - rootRef.y) ** 2;
  const tailDistance = (pointsPx[pointsPx.length - 1].x - rootRef.x) ** 2 + (pointsPx[pointsPx.length - 1].y - rootRef.y) ** 2;
  if (tailDistance < headDistance) {
    pointsPx.reverse();
    centerline.reverse();
  }

  const kappaPerPx = curvatureFromPoints(pointsPx, opts.sgHalfWindow, opts.sgOrder);

  // ── 图像坐标 → 机器人坐标 ──
  //
  // 下面把点从「图像坐标（x 右、y 下、单位像素）」变换到
  // 「臂根为原点、根处切向朝 +y、单位 mm、y 向上」。
  //
  // **曲率的符号必须跟着一起翻**：y 取反会让 κ = (x′y″−y′x″)/|·|³ 变号，
  // 如果点翻了、κ 没翻，下游把两者配对使用就会得到反方向的弯。
  const rootPx = pointsPx[0];
  const tipPx = pointsPx[pointsPx.length - 1];
  const rootAngle = Math.atan2(tipPx.y - rootPx.y, tipPx.x - rootPx.x);
  const rotate = -rootAngle - Math.PI / 2;
  const cos = Math.cos(rotate);
  const sin = Math.sin(rotate);
  const pointsMm: Point[] = pointsPx.map((p) => {
    const dx = (p.x - rootPx.x) * scaleMmPerPx;
    const dy = (p.y - rootPx.y) * scaleMmPerPx;
    const rx = dx * cos - dy * sin;
    const ry = dx * sin + dy * cos;
    // 图像 y 向下 → 机器人坐标 y 向上
    return { x: rx, y: -ry };
  });

  const curvaturePerMm = kappaPerPx.map((k) => -k / scaleMmPerPx);
  const curvaturePerM = curvaturePerMm.map((k) => k * 1000);

  const pccFit = fitPccModel(pointsPx, centerlineLengthPx / 2);

  const truncated = centerlineLengthPx * scaleMmPerPx < opts.armLengthMm * 0.9;
  return {
    ok: true,
    reason: truncated
      ? `检测到臂长 ${(centerlineLengthPx * scaleMmPerPx).toFixed(0)}mm，明显短于 ${opts.armLengthMm}mm，可能被截断`
      : "",
    threshold,
    maskArea: area,
    centerline,
    centerlineLengthPx,
    pointsPx,
    pointsMm,
    scaleMmPerPx,
    widthMedianPx,
    widthConsistency,
    curvaturePerMm,
    curvaturePerM,
    pccFit,
  };
}
