/**
 * 动作记录的**草稿状态** ✓（模块级单例 ✓，跨组件共享 ✓）。
 *
 * 为什么不放 React context ✗：3D 预览（`CurvatureDragPreview`）和「动作库」卡片
 * 不在同一棵子树里 ✓，context 传递要改很多层 ✗。模块级 + 事件订阅最轻 ✓。
 *
 * 坑（踩过一次）：模块单例在**不同 chunk 里可能是两份** ✗ —— 所以这里只放
 * 极轻量的状态 ✓，而且**谁写谁读都走同一份 import** ✓。
 */

export interface MotionPoint {
  /** 记录时刻的末端位姿（mm + 弧度 ✓）*/
  x: number;
  y: number;
  z: number;
  /** 记录时刻的 κ(s) 快照（用于回放/规划 ✓）*/
  kappa: number[];
  /** 记录顺序 ✓ */
  index: number;
}

interface MotionDraftState {
  /** 是否处于"记录中"✓ —— 只有开着才记点 ✓ */
  recording: boolean;
  points: MotionPoint[];
  /** 当前末端位姿（不记录时也更新 ✓，用于显示"当前点"✓）*/
  live: { x: number; y: number; z: number } | null;
}

/** 记录时的**最小步长**（mm）✓ —— 移动不到这么远就不记点 ✗（否则列表会被逐帧点淹没 ✗）*/
const MIN_STEP_MM = 2;

const state: MotionDraftState = { recording: false, points: [], live: null };

/** 上一个**已记录**的点（用于判步长 ✓），不含 live ✓ */
let lastRecorded: { x: number; y: number; z: number } | null = null;

function distanceMm(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

type Listener = (next: MotionDraftState) => void;
const listeners = new Set<Listener>();

const EVENT = "softui:motiondraft";

function emit() {
  const snapshot: MotionDraftState = {
    recording: state.recording,
    points: [...state.points],
    live: state.live,
  };
  for (const listener of listeners) listener(snapshot);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: snapshot }));
  }
}

export function subscribeMotionDraft(listener: Listener): () => void {
  listeners.add(listener);
  listener({ recording: state.recording, points: [...state.points], live: state.live });
  return () => {
    listeners.delete(listener);
  };
}

export function getMotionDraft(): MotionDraftState {
  return { recording: state.recording, points: [...state.points], live: state.live };
}

/** 开始 / 结束记录 ✓（结束时不清空，方便用户接着记 ✓）*/
export function setRecording(recording: boolean) {
  state.recording = recording;
  // 开始记录时把"当前位置"作为基准 ✓ —— 否则一开启就会立刻落一个和上一点重复的点 ✗
  lastRecorded = recording && state.live ? { ...state.live } : null;
  emit();
}

/** 3D 预览每帧调用 ✓（很轻，只是赋值 ✓）。记录中会自动落一个点 ✓。 */
export function updateLivePose(pose: { x: number; y: number; z: number }, kappa?: number[]) {
  state.live = pose;
  if (state.recording && kappa) {
    // 等距抽稀 ✓：起点必记 ✓，之后每移动 ≥ MIN_STEP_MM 才记一点 ✓
    const shouldRecord = !lastRecorded || distanceMm(lastRecorded, pose) >= MIN_STEP_MM;
    if (shouldRecord) {
      state.points.push({ ...pose, kappa: [...kappa], index: state.points.length });
      lastRecorded = { ...pose };
    }
  }
  emit();
}

/** 手动记录当前点 ✓（点按钮时用 ✓，用的是最近一帧的 live ✓）。 */
export function recordCurrentPoint(kappa?: number[]) {
  if (!state.live) return false;
  state.points.push({
    ...state.live,
    kappa: kappa ? [...kappa] : [],
    index: state.points.length,
  });
  lastRecorded = { ...state.live };
  emit();
  return true;
}

export function removePoint(index: number) {
  state.points.splice(index, 1);
  lastRecorded = state.points.length > 0 ? { ...state.points[state.points.length - 1] } : null;
  state.points.forEach((point, order) => {
    point.index = order;
  });
  emit();
}

export function clearPoints() {
  state.points = [];
  lastRecorded = null;
  emit();
}
