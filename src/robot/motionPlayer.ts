import { invoke } from "@tauri-apps/api/core";

import { mapThreeMmToSvcPoint, type CurvatureDistribution } from "../dynamics/svcModel";
import {
  getPlaybackDisplacementAt,
  pushTargetHistory,
  setCurrentDisplacement,
  setPlaybackDisplacements,
} from "./previewOverride";

/**
 * 动作播放器 ✓ —— 把规划好的 κ 序列按时间插值成连续的形位 ✓。
 *
 * 为什么要在前端插值 ✗：规划结果只有几十个关键采样点 ✓，
 * 直接一帧一个点会**明显卡顿** ✗；按 30Hz 线性插值后是连续的 ✓。
 *
 * 为什么用 `requestAnimationFrame` 而不是 `setInterval` ✓：
 * rAF 会跟着屏幕刷新 ✓、后台标签页自动暂停 ✓（避免"切走后还在跑"✗）。
 */

/** 播放请求键 ✓ —— 动作卡片写、WorkspacePage 读 ✓（跨子树 ✗）*/
export const PLAY_REQUEST_KEY = "softui:playAction";

export interface PlayRequest {
  actionId: string;
  actionName: string;
  modelId: string;
  modelName: string;
  durationMs: number;
  samples: Array<{ kx: number[]; ky: number[]; x: number; y: number; z: number }>;
  /** 臂长（mm ✓）—— 用来重建 base 分布 ✓ */
  totalLengthMm: number;
  requestedAt: number;
}

export interface PlaybackSample {
  /** 每段 kx / ky（1/m ✓）—— 带方向 ✓ */
  kx: number[];
  ky: number[];
  x: number;
  y: number;
  z: number;
}

export interface PlaybackOptions {
  samples: PlaybackSample[];
  /** 原始分布（用来复制长度/段数等结构 ✓）*/
  base: CurvatureDistribution;
  /** 总时长（ms ✓）*/
  durationMs: number;
  /**
   * 正在播的**动作名** ✓ —— 由实例自己写 ✓，别再让调用方先写一遍 ✗。
   *
   * 为什么 ✗：调用方写完名字再起播 ✓，中间若被另一个入口插进来 ✓ →
   * 名字和真正在播的实例对不上 ✗ → "点动作二、蓝条写动作一"✗（本 bug ✓）。
   */
  actionName?: string;
  /** 每帧回调 ✓（给出当前形位 ✓）*/
  onFrame: (distribution: CurvatureDistribution, progress: number) => void;
  /** 结束回调 ✓ */
  onDone?: () => void;
}

/** 第 i 帧的形位 ✓（线性插值 ✓，段数与 base 一致 ✓）*/
function distributionAt(
  base: CurvatureDistribution,
  kx: number[],
  ky: number[],
): CurvatureDistribution {
  return {
    ...base,
    source: "manualDrag",
    segments: base.segments.map((segment, index) => {
      const kxValue = kx[index] ?? 0;
      const kyValue = ky[index] ?? 0;
      return {
        ...segment,
        kxPerM: kxValue,
        kyPerM: kyValue,
        kappaAbsPerM: Math.hypot(kxValue, kyValue),
        // phiRad 必须给 ✓（缺了骨骼积分会 NaN ✗）
        phiRad: Math.atan2(kyValue, kxValue),
      };
    }),
  } as CurvatureDistribution;
}

/** 开始播放 ✓，返回**停止函数** ✓ */
/**
 * **播放实例代号** ✓ —— 只有"最新那次"能写/清状态 ✗。
 *
 * 为什么 ✗：`playMotion` 被重复调用时（今天实测 ✓），**旧实例的 cleanup
 * 会晚于新实例启动** ✓ → 它把新实例刚写的位移清成 `null` ✗ →
 * 监控卡"有时有值、大部分是 null"✗（本 bug ✓）。
 *
 * 有了代号后 ✓：旧实例的写入和清理**全部被丢弃** ✓。
 */
let playbackGeneration = 0;

/** **当前播放控制器** ✓ —— 动作库的「暂停/继续」按钮直接调它 ✓ */
let currentController: PlaybackController | null = null;

/**
 * **当前实例的 stop** ✓ —— `stopActivePlayback()` 用它收尾 ✓。
 *
 * 为什么需要 ✗：被顶掉的旧实例 `stop()` 会因 `isStale()` 跳过清理 ✓ →
 * 蓝条/位移/控制器全留着 ✗ → "时间到了还在显示正在播放"✗（本 bug ✓）。
 */
let activeStop: (() => void) | null = null;

/**
 * **权威停止** ✓ —— 任何入口起播前都必须先调它 ✓。
 *
 * 和实例自己的 `stop()` 的区别：
 *   `stop()` 自己判断"我还是不是最新的"（被顶掉就什么都不清 ✗）；
 *   这里是**外部强制收尾** ✓ —— 不管新旧，一律清干净 ✓。
 * 两个入口（动作库 localStorage 请求 / 策略时间线请求）共用它 ✓，
 * 就不会出现"新动作在播、蓝条还写着上一个动作名"✗。
 */
export function stopActivePlayback(): void {
  const stop = activeStop;
  activeStop = null;
  try {
    stop?.();
  } catch {
    /* 忽略：收尾失败不该打断新的播放 ✓ */
  }
  // 兜底再清一遍 ✓ —— 旧实例即使是 stale（跳过清理）也清干净 ✓
  currentActionName = null;
  currentElapsedMs = 0;
  currentController = null;
  setPlaybackDisplacements(null);
  setCurrentDisplacement(null);
}

/**
 * **当前正在播的动作名** ✓ —— 放在模块里 ✗（`WorkspacePage` 的 state 切页签就丢 ✗）。
 *
 * 控制页那条蓝色横栏读它 ✓ → 切走再回来**还在** ✓（本 bug ✓）。
 */
let currentActionName: string | null = null;
/** 当前播放的总时长 / 已播时长（ms）✓ —— 蓝条要显示 ✓ */
let currentTotalMs = 0;
let currentElapsedMs = 0;

export function getCurrentPlaybackTimes(): { totalMs: number; elapsedMs: number } {
  return { totalMs: currentTotalMs, elapsedMs: currentElapsedMs };
}

export function getCurrentActionName(): string | null {
  return currentActionName;
}

export function setCurrentActionName(name: string | null) {
  currentActionName = name;
}

export function pauseCurrentPlayback(): boolean {
  if (!currentController) return false;
  currentController.pause();
  return true;
}

export function resumeCurrentPlayback(): boolean {
  if (!currentController) return false;
  currentController.resume();
  return true;
}

export function isCurrentPlaybackPaused(): boolean {
  return currentController?.isPaused() ?? false;
}

/** 有没有正在播放 / 暂停的动作 ✓ */
export function hasCurrentPlayback(): boolean {
  return currentController != null;
}

/** 播放来源 ✓ —— 用来阻止「策略时间线在跑，又去手动点动作库」互相踩 ✗ */
export type PlaybackOwner = "manual" | "policy";
let playbackOwner: PlaybackOwner = "manual";

export function setPlaybackOwner(owner: PlaybackOwner): void {
  playbackOwner = owner;
}

export function getPlaybackOwner(): PlaybackOwner {
  return playbackOwner;
}

export interface PlaybackController {
  /** 停止播放 ✓（清定时器 + 清注入 ✓）*/
  stop: () => void;
  /** 暂停 ✓（保留进度 ✓，不清注入 ✓）*/
  pause: () => void;
  /** 从暂停处继续 ✓ */
  resume: () => void;
  /** 当前状态 ✓ */
  isPaused: () => boolean;
}

export function playMotion(options: PlaybackOptions): PlaybackController {
  const { samples, base, durationMs, onFrame, onDone } = options;
  if (samples.length === 0) {
    onDone?.();
    const noop = () => {};
    return { stop: noop, pause: noop, resume: noop, isPaused: () => false };
  }

  let cancelled = false;
  const myGeneration = ++playbackGeneration;
  /** 我是不是"最新那次播放" ✓（不是就一律不写不清理 ✗）*/
  const isStale = () => myGeneration !== playbackGeneration;

  // **名字跟着实例走** ✓ —— 谁真正在播，蓝条就写谁 ✓（见 `actionName` 的说明）
  if (!isStale() && options.actionName !== undefined) {
    currentActionName = options.actionName;
  }


  /**
   * **播放开始时一次算完 6 路位移** ✓（方案 C ✓）。
   *
   * 为什么 ✗：逐点调后端查表 → 每次几百 ms ✗ → 监控卡"很久才跳一下"✗。
   * 一次批量算完 ✓，播放时纯查数组 ✓ → 零延迟 ✓。
   * 请求是**异步的** ✓，不影响播放本身 ✓（算回来之前监控卡先显示旧值 ✓）。
   */
  void (async () => {
    try {
      // ⚠ `PlanSample.x/y/z` **本来就是 mm** ✓（来自 `tipMm` ✓），
      //   再乘 1000 会变成几百米 ✗ → 位姿全部不可达 ✗ → 监控卡显示 `--` ✗（本 bug ✓）。
      // **全系统统一 `svc` 系** ✓ —— `PlanSample` 是 `three` 系 mm ✗，
      //   后端表是 `svc` 系 mm ✓ → 查询前换轴 ✓（只换轴 ✓，不换单位 ✗）。
      const flat = samples.flatMap((sample) => mapThreeMmToSvcPoint([sample.x, sample.y, sample.z]));
      const list = await invoke<Array<number[] | null>>("preview_tip_pose_batch", {
        positionsMm: flat,
      });
      if (!cancelled && !isStale()) {
        const hit = list.filter((item) => item !== null).length;
        if (hit === 0) {
          console.warn("[playback] 6 路位移全部不可达", { count: list.length, first: flat.slice(0, 3) });
        }
        setPlaybackDisplacements(list);
      }
    } catch (error) {
      console.error("[playback] 预计算失败", error);
    }
  })();

  const totalMs = Math.max(200, durationMs);
  if (!isStale()) {
    currentTotalMs = totalMs;
    currentElapsedMs = 0;
  }
  const startedAt = performance.now();
  /** 累计暂停时长（ms）✓ —— 恢复时把 `elapsed` 减掉这一段 ✓ */
  let pausedAccumMs = 0;
  let pausedAtMs: number | null = null;
  let handle = 0;
  let finished = false;

  const tick = () => {
    if (cancelled || finished) return;
    // 暂停中：不再推进 ✓（但仍返回，不累积错误 ✗）
    if (pausedAtMs !== null) return;
    const now = performance.now();
    const elapsed = now - startedAt - pausedAccumMs;
    const progress = Math.min(1, elapsed / totalMs);
    if (!isStale()) currentElapsedMs = elapsed;
    const position = progress * (samples.length - 1);
    const index = Math.floor(position);
    const nextIndex = Math.min(samples.length - 1, index + 1);
    const t = position - index;

    const first = samples[index];
    const second = samples[nextIndex];
    // kx / ky **分别**插值 ✓（角度才不会反转 ✗）
    const blend = (a: number[], b: number[]) =>
      a.map((value, segIndex) => {
        const nextValue = b[segIndex] ?? value;
        return value + (nextValue - value) * t;
      });

    /**
     * ⚠ **旧实例不许再推形状** ✗ —— `onFrame` 原来无条件调用 ✓。
     *
     * 被顶掉的实例（动作库点了新的 / 时间线插进来）interval 也还在跑 ✓ →
     * 两个实例以不同相位每 33ms 各写一次 `previewOverride` ✗ →
     * 3D 在两个形状之间来回跳 = **臂体抖动** ✗（本 bug ✓）。
     */
    if (isStale()) return;

    /**
     * **先写当前帧位移，再推形状** ✓ —— 顺序反了会差一帧 ✗。
     *
     * `onFrame` 里要用这一帧的 6 路位移去下发（动作组 + 实时跟随 ✓）；
     * 原来先 `onFrame` 后写 ✓ → 拿到的是**上一帧**位移 ✗ → 下发比画面慢 33ms ✗。
     */
    {
      const dl = getPlaybackDisplacementAt(index);
      setCurrentDisplacement(dl);
      pushTargetHistory(dl);   // **曲线页要用历史** ✓
    }

    onFrame(distributionAt(base, blend(first.kx, second.kx), blend(first.ky, second.ky)), progress);

    if (progress >= 1) {
      finished = true;
      window.clearInterval(handle);
      // **正常播完也要清控制器** ✗ —— 只清动作名不够 ✓，
      //   `hasCurrentPlayback()` 还是 true ✓ → 按钮不灰、拖动被挡 ✗（本 bug ✓）
      if (!isStale()) {
        currentActionName = null;
        currentController = null;
      }
      onDone?.();
    }
  };

  // ⚠ 用 **setInterval(33ms ≈ 30fps)** 而不是 `requestAnimationFrame` ✗ ——
  //   rAF 在"标签页不可见 / 某些渲染限制"下**不触发** ✓，
  //   表现就是"横幅在、进度不动、手臂不动"✗（本次 bug ✓）。
  //   setInterval 不管可见性都会跑 ✓，30fps 对播放足够 ✓。
  /**
   * **兜底** ✗ —— 定时器可能被浏览器节流（后台标签页 ✓）、
   * 或 `progress` 因累加误差**永远差一点点** ✓ → 动作播完却**停不下来** ✗（本 bug ✓）。
   * 这里再加一个"到点必结束"的定时器 ✓（比总时长多 500ms ✓，让正常路径先走 ✓）。
   */
  window.setTimeout(() => {
    if (cancelled || finished) return;
    finished = true;
    window.clearInterval(handle);
    if (!isStale()) {
      currentActionName = null;
      currentController = null;
    }
    onDone?.();
  }, totalMs + 500);

  handle = window.setInterval(tick, 33);
  // 立刻推一帧 ✓ —— 用户点了就该看到 0% 的反馈 ✓
  tick();
  const stop = () => {
    if (!isStale()) {
      currentActionName = null;
      currentElapsedMs = 0;
      // ⚠ **必须清控制器** ✗ —— 不清的话 `hasCurrentPlayback()` 永远 true ✓
      //   → 动作库的「暂停」按钮一直亮着 ✓ → 用户以为"还在播"✗
      //   → 拖动被当成"播放中"挡住 ✗（本 bug ✓）
      currentController = null;
    }
    cancelled = true;
    window.clearInterval(handle);
    // ⚠ **只有最新实例才清状态** ✗ —— 旧实例清掉会把新实例的数据冲没 ✓
    if (isStale()) return;
    setPlaybackDisplacements(null);   // 播放结束清掉 ✓
    setCurrentDisplacement(null);
  };

  const controller: PlaybackController = {
    stop,
    pause: () => {
      if (pausedAtMs !== null) return;
      pausedAtMs = performance.now();
    },
    resume: () => {
      if (pausedAtMs === null) return;
      pausedAccumMs += performance.now() - pausedAtMs;
      pausedAtMs = null;
    },
    isPaused: () => pausedAtMs !== null,
  };
  // **登记为当前控制器** ✓（动作库的按钮用它 ✓）；只有最新实例能登记 ✗
  if (!isStale()) {
    currentController = controller;
    activeStop = stop;      // ← 外部强制收尾用 ✓（见 `stopActivePlayback`）
  }
  return controller;
}
