/**
 * 臂体视角模式（竖直 / 水平）—— **两个 3D 视图共用同一份状态**。
 *
 * 之前监控页的「臂体形位预览」和控制的「臂体控制」各自用 `useState` ✗，
 * 在一处切换另一处不动 ✓ —— 同一个设备在两个视图里朝向不同，很容易误判。
 *
 * 这里用一个模块级状态 + `CustomEvent` 广播：
 *   - `localStorage` 负责**跨刷新**记住选择 ✓
 *   - `CustomEvent` 负责**同一页面内**的两个视图实时同步 ✓
 *     （`storage` 事件只在**其它标签页**触发 ✗，同页内收不到 ✓）
 */

export type ArmViewMode = "vertical" | "horizontal";

const STORAGE_KEY = "softui.armView";
const EVENT_NAME = "softui:armview";

function readStored(): ArmViewMode {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "horizontal" ? "horizontal" : "vertical";
  } catch {
    return "vertical";
  }
}

let current: ArmViewMode = typeof window === "undefined" ? "vertical" : readStored();

export function getArmView(): ArmViewMode {
  return current;
}

export function setArmView(mode: ArmViewMode): void {
  if (mode === current) return;
  current = mode;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // 隐私模式下写不进去，忽略（不影响本次会话内的同步）
  }
  window.dispatchEvent(new CustomEvent<ArmViewMode>(EVENT_NAME, { detail: mode }));
}

/** 订阅视角变化；返回取消订阅函数。 */
export function onArmViewChange(handler: (mode: ArmViewMode) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<ArmViewMode>).detail);
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}

/** 另一个视图切换了模式 → 本视图跟着切（不写回 localStorage，避免来回广播）。 */
export function applyArmViewLocally(mode: ArmViewMode): void {
  current = mode;
}
