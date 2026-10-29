import { buildBackboneFromCurvatureDistribution, type BackboneOutput, type CurvatureDistribution } from "../dynamics/svcModel";

/**
 * 3D 预览的**直接注入通道** ✓。
 *
 * 为什么需要它 ✗：按正常链路，"动作播放"每帧的形位要经过
 *   onFrame → applyFrameRef → handleDragTarget → setDragTarget
 *          → rawTargetDistribution → clamp → targetDistribution
 *          → prop → targetBackbone → targetRef → 渲染循环
 * **七跳** ✗ —— 任何一跳断了都表现为"手臂不动"✗，排查成本极高 ✓。
 *
 * 这个模块把它压到**两跳**：
 *   setPreviewOverride(dist) → 渲染循环读 getPreviewOverride()
 *
 * 它**只影响显示** ✗ —— 不改 `dragTarget` ✓、不广播 ✓、不下发 ✓。
 * 播放结束调 `clearPreviewOverride()` ✓，画面自然回落到真实状态 ✓。
 */

let override: BackboneOutput | null = null;
/** 播放时的**末端轨迹线**（three 系 mm ✓）—— 空数组 = 不画 ✓ */
let pathPoints: Array<[number, number, number]> = [];
let version = 0;

/**
 * **播放期间的 6 路位移预计算结果** ✓ —— 播放开始时一次算完 ✓。
 *
 * 逐点查表每帧都要几百 ms ✗ → 界面"很久才跳一下"✗。
 * 这里存整条轨迹的位移 ✓，播放时按采样点**直接取** ✓ → 零延迟 ✓。
 */
let playbackDisplacements: Array<number[] | null> | null = null;

export function setPlaybackDisplacements(list: Array<number[] | null> | null) {
  playbackDisplacements = list;
}

/** **当前这一帧**的 6 路位移 ✓（播放器每帧写 ✓，监控卡读 ✓）*/
let currentDisplacement: number[] | null = null;

export function setCurrentDisplacement(value: number[] | null) {
  currentDisplacement = value;
}

export function getCurrentDisplacement(): number[] | null {
  return currentDisplacement;
}

/** 播放时按**采样点序号**取 ✓（越界返回 null ✓）*/
export function getPlaybackDisplacementsLength(): number {
  return playbackDisplacements?.length ?? 0;
}

export function getPlaybackDisplacementAt(index: number): number[] | null {
  if (!playbackDisplacements) return null;
  return playbackDisplacements[index] ?? null;
}

/** 按末端位置**找最近的点** ✓（播放器只知道自己走到哪 ✓）*/
export function getPlaybackDisplacementNearest(pointM: [number, number, number]): number[] | null {
  if (!playbackDisplacements || !override) return null;
  const points = override.pointsM;
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    const dx = points[i][0] - pointM[0];
    const dy = points[i][1] - pointM[1];
    const dz = points[i][2] - pointM[2];
    const dist = dx * dx + dy * dy + dz * dz;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best >= 0 ? (playbackDisplacements[best] ?? null) : null;
}

/** 设置播放轨迹（传空数组清掉 ✓）*/
export function setPreviewPath(points: Array<[number, number, number]>) {
  // **原地替换内容** ✓ —— 理由同上（有地方抓着引用 ✓）
  pathPoints.length = 0;
  for (const point of points) pathPoints.push(point);
  version += 1;
}

/**
 * **拖动 / 播放累积的末端轨迹** ✓ —— 放在**模块级** ✗
 * （原来是组件的 `useRef` ✓ → 切页签卸载就清零 ✗ → 回来从 0 重跑 ✓，本 bug ✓）。
 */
let trailPoints: Array<[number, number, number]> = [];

export function getTrail(): Array<[number, number, number]> {
  return trailPoints;
}

export function pushTrail(point: [number, number, number]): void {
  trailPoints.push(point);
  if (trailPoints.length > 4000) trailPoints.shift();
}

export function clearTrail(): void {
  /**
   * ⚠ **必须原地清空，不能换新数组** ✗ ——
   * 组件里 `const trailRef = { current: getTrail() }` ✗ 抓的是**数组引用** ✓，
   * `trailPoints = []` 只是把**模块变量**指向新数组 ✗
   * → `trailRef.current` **还抓着旧的那份** ✗ → 清掉了但还画得出来 ✗（本 bug ✓）。
   */
  trailPoints.length = 0;
}

export function getPreviewPath(): Array<[number, number, number]> {
  return pathPoints;
}

export function setPreviewOverride(distribution: CurvatureDistribution | null) {
  override = distribution ? buildBackboneFromCurvatureDistribution(distribution) : null;
  version += 1;
}

export function clearPreviewOverride() {
  override = null;
  pathPoints = [];
  version += 1;
}

/** 渲染循环每帧调用 ✓（纯读 ✓，开销为零 ✓）*/
export function getPreviewOverride(): BackboneOutput | null {
  return override;
}

/** 版本号：渲染循环可以用它判断"这一帧有没有新数据"✓ */
export function getPreviewOverrideVersion(): number {
  return version;
}

/**
 * **目标位移历史** ✓ —— 给「曲线分析」页画时间序列 ✓。
 *
 * 环形缓冲 ✓（固定 600 条 ≈ 60 秒 @10Hz ✓），不无限增长 ✗。
 * 采样点由 `motionPlayer`（每帧 ✓）和「电机概览」（每 100ms ✓）共同写入 ✓。
 */
const TARGET_HISTORY_MAX = 600;
const targetHistory: Array<{ at: number; values: number[] }> = [];

export function pushTargetHistory(values: number[] | null) {
  if (!values || values.length === 0) return;
  const at = Date.now();
  // ⚠ **不要"覆盖上一条"** ✗ —— 我上一版这么写 ✓，
  //   然后把 `last.at` 也更新了 ✓ → 下一条又满足 `< 80` ✗ → **永远覆盖第一条** ✗
  //   → 缓冲里只有 1~2 条 ✓ → 曲线画不出来 ✗（实测 `条数: 2` ✓）。
  //
  //   正确做法：**按时间抽样** ✓ —— 距上一条不足 80ms 就**丢弃**✓（不是覆盖 ✓），
  //   这样 600 条 ≈ 48 秒 ✓，点数足够画曲线 ✓。
  const last = targetHistory[targetHistory.length - 1];
  if (last && at - last.at < 80) return;   // ← **丢弃**，不是覆盖 ✓
  targetHistory.push({ at, values });
  if (targetHistory.length > TARGET_HISTORY_MAX) targetHistory.shift();
}

export function getTargetHistory(): ReadonlyArray<{ at: number; values: number[] }> {
  return targetHistory;
}

export function clearTargetHistory() {
  targetHistory.length = 0;
}
