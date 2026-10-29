/**
 * 策略时间线的**执行引擎** ✓（纯函数 ✓，可测 ✓）。
 *
 * 设计要点：
 *  ① 时间线按顺序走 ✓，每段 `durationSec` 秒 ✓
 *  ② 进入某一段时**只发一次**"开始"信号 ✓（不是每帧都发 ✗）
 *  ③ **中断优先** ✓ —— 命中就暂停时间线 ✓，中断做完再按 `resume` 决定是否继续 ✓
 *  ④ 引擎本身**不碰网络 / 不碰 3D** ✗ —— 只返回"该做什么" ✓
 *     真正执行在 `WorkspacePage` 里 ✓（好测 ✓、好回放 ✓、不会因为 UI 出错而乱跑 ✓）
 */

import type { PolicyTimelineBlock } from "../pages/PolicyRulesCard";

/** 引擎状态 ✓（由调用方持有 ✓，跨 tick 保留 ✓）*/
export interface TimelineState {
  /** 已经走到第几段 ✓（0 = 还没开始 ✓）*/
  blockIndex: number;
  /** 当前这一段从什么时候开始（ms ✓）*/
  blockStartedAt: number;
  /** 是否被中断挂起 ✓ */
  suspended: boolean;
  /** 挂起的时刻（ms ✓）—— 恢复时用来补偿时间线 ✓ */
  suspendedAt?: number;
  /** 已完成的段数 ✓（循环播放时用 ✓）*/
  completedLoops: number;
}

export function createTimelineState(startedAt: number): TimelineState {
  // ⚠ blockIndex = **-1** 表示"还没进入任何片段" ✓
  //   原来是 0 ✗ —— 第一个 tick 会当成"正在播第 0 段"✓，
  //   永远不 emits `start-block` ✗ → **第一段永远不执行**✗（本次 bug ✓）。
  return { blockIndex: -1, blockStartedAt: startedAt, suspended: false, completedLoops: 0 };
}

/** 引擎产出：这一 tick 要执行的动作 ✓ */
export type TimelineEffect =
  | { kind: "start-block"; index: number; block: PolicyTimelineBlock }
  | { kind: "finish-timeline" }
  | { kind: "nothing" };

/** 中断描述（和 `PolicyInterrupt` 同构 ✓，这里只取需要的字段 ✓）*/
export interface InterruptSpec {
  enabled: boolean;
  thresholdN: number;
  windowMs: number;
  targetKind: "model" | "action";
  targetId: string;
  resume: boolean;
}

/**
 * 推进时间线 ✓ —— 每 1 秒调一次就够 ✓。
 *
 * 返回的 `effect` 只在**进入新的一段**时是 `start-block` ✓，
 * 其他时候是 `nothing` ✓ —— 调用方据此决定"要不要发命令"✓。
 */
export function advanceTimeline(
  blocks: PolicyTimelineBlock[],
  state: TimelineState,
  nowMs: number,
): { state: TimelineState; effect: TimelineEffect } {
  if (blocks.length === 0) {
    return { state, effect: { kind: "nothing" } };
  }
  // 被中断挂起 ✓ → 时间线冻结 ✓
  if (state.suspended) {
    return { state, effect: { kind: "nothing" } };
  }

  // **还没开始** → 立刻进入第 0 段 ✓（这是"第一段不执行"的修复 ✓）
  if (state.blockIndex < 0) {
    const nextState: TimelineState = { ...state, blockIndex: 0, blockStartedAt: nowMs };
    return {
      state: nextState,
      effect: { kind: "start-block", index: 0, block: blocks[0] },
    };
  }

  const block = blocks[state.blockIndex];
  if (!block) {
    // 走到头了 ✓
    return { state, effect: { kind: "finish-timeline" } };
  }

  const elapsedSec = (nowMs - state.blockStartedAt) / 1000;
  if (elapsedSec < Math.max(0, block.durationSec)) {
    return { state, effect: { kind: "nothing" } };
  }

  // 这一段结束 → 下一段 ✓
  const nextIndex = state.blockIndex + 1;
  const nextState: TimelineState = {
    ...state,
    blockIndex: nextIndex,
    blockStartedAt: nowMs,
  };

  if (nextIndex >= blocks.length) {
    return {
      state: { ...nextState, blockIndex: 0, completedLoops: state.completedLoops + 1 },
      effect: { kind: "finish-timeline" },
    };
  }

  return {
    state: nextState,
    effect: { kind: "start-block", index: nextIndex, block: blocks[nextIndex] },
  };
}

/** 中断命中判定 ✓（窗口内 最大值 − 最小值 ≥ 阈值 ✓）*/
export function interruptHit(
  spec: InterruptSpec,
  series: number[],
): boolean {
  if (!spec.enabled || series.length < 3) return false;
  const rise = Math.max(...series) - Math.min(...series);
  return rise >= spec.thresholdN;
}

/** 时间线进度（0~1 ✓）—— 给臂体控制显示用 ✓ */
export function timelineProgress(
  blocks: PolicyTimelineBlock[],
  state: TimelineState,
  nowMs: number,
): { index: number; elapsedSec: number; totalSec: number; blockElapsedSec: number } {
  const totalSec = blocks.reduce((sum, block) => sum + Math.max(0, block.durationSec), 0);
  const before = blocks
    .slice(0, state.blockIndex)
    .reduce((sum, block) => sum + Math.max(0, block.durationSec), 0);
  const blockElapsedSec = (nowMs - state.blockStartedAt) / 1000;
  return {
    index: state.blockIndex,
    elapsedSec: before + Math.max(0, blockElapsedSec),
    totalSec,
    blockElapsedSec: Math.max(0, blockElapsedSec),
  };
}

/**
 * **中断挂起** ✓ —— 时间线冻结 ✓。
 *
 * 为什么要记 `suspendedAt` ✗：恢复时要把 `blockStartedAt` **往后推** ✓，
 * 否则暂停的这段时间会被算进当前片段 ✓ → 恢复后瞬间跳到下一段 ✗。
 */
export function suspendTimeline(state: TimelineState, nowMs: number): TimelineState {
  if (state.suspended) return state;
  return { ...state, suspended: true, suspendedAt: nowMs };
}

/** **中断恢复** ✓ —— 把时间线时间轴整体后移暂停时长 ✓ */
export function resumeTimeline(state: TimelineState, nowMs: number): TimelineState {
  const pausedMs = Math.max(0, nowMs - (state.suspendedAt ?? nowMs));
  return {
    ...state,
    suspended: false,
    suspendedAt: undefined,
    blockStartedAt: state.blockStartedAt + pausedMs,
  };
}
