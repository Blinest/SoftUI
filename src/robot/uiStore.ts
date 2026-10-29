import { invoke } from "@tauri-apps/api/core";

/**
 * **跨端共享**的界面数据存储 ✓。
 *
 * 原来动作库 / 策略编排存在 `localStorage` ✗ —— 那是**每个浏览器一份** ✗，
 * 手机、电脑、平板看到的是三份不同的数据 ✗。
 *
 * 现在走服务器上的 JSON 文件 ✓：
 *   `data/ui-store/<namespace>.json`
 *
 * 三个保证：
 *  1. 写**去抖** ✓（拖动参数时不会每帧都发请求 ✗）
 *  2. 写后**回读校验** ✓（服务端返回它看到的内容 ✓）
 *  3. 其他端改动通过**轮询**发现 ✓（每 5 秒 ✓，够用且简单 ✓）
 */

export type UiStoreNamespace =
  | "motion-actions"
  | "policy-schemes"
  | "policy-log"
  | "log-hidden"
  | "ui-prefs";

const POLL_INTERVAL_MS = 5000;

interface CacheEntry {
  /** 最近一次已知的 JSON 文本 ✓（用来判断"别的端改没改"✗）*/
  text: string;
  listeners: Set<(value: unknown) => void>;
}

/**
 * 当前登录者 ✓ —— 由 `WorkspacePage` 写入 ✓。
 *
 * 为什么不放 context ✗：`uiStore` 是**纯模块函数** ✓（不是组件 ✓），
 * 拿不到 React context ✓。模块级变量最简单 ✓。
 */
let authContext: { username: string; role: string } = { username: "", role: "operator" };

/** 审批提示回调 ✓（非 admin 提交后由卡片显示"已提交审批"✓）*/
type ApprovalNotice = (message: string) => void;
const approvalListeners = new Set<ApprovalNotice>();

export function getAuthRole(): string {
  return authContext.role;
}

export function getAuthUsername(): string {
  return authContext.username;
}

export function setAuthContext(username: string, role: string) {
  authContext = { username, role };
}

/** 订阅"需要审批"的提示 ✓（返回取消函数 ✓）*/
export function onApprovalSubmitted(notice: ApprovalNotice): () => void {
  approvalListeners.add(notice);
  return () => {
    approvalListeners.delete(notice);
  };
}

function notifyApproval(message: string) {
  for (const listener of approvalListeners) listener(message);
}

/** 只有 admin 直传 ✓，其他人走审批 ✓（方案 A ✓）*/
export function canWriteDirectly(): boolean {
  return authContext.role === "admin";
}

const cache = new Map<UiStoreNamespace, CacheEntry>();
const pending = new Map<UiStoreNamespace, number>();
const inflight = new Set<UiStoreNamespace>();

function entryFor(namespace: UiStoreNamespace): CacheEntry {
  let entry = cache.get(namespace);
  if (!entry) {
    entry = { text: "", listeners: new Set() };
    cache.set(namespace, entry);
  }
  return entry;
}

/** 读一次 ✓（失败返回 null ✓，调用方决定怎么兜底 ✓）*/
export async function loadUiStore<T>(namespace: UiStoreNamespace): Promise<T | null> {
  try {
    const value = await invoke<T | null>("get_ui_store", { namespace });
    if (value === null || value === undefined) return null;
    entryFor(namespace).text = JSON.stringify(value);
    return value;
  } catch {
    return null;
  }
}

/** 待审批项 ✓ */
export interface PendingUiChange {
  id: string;
  namespace: string;
  submittedBy: string;
  submittedAt: string;
  summary: string;
  data: unknown;
  /** **有变化的条目 id** ✓（`deleted:<id>` 表示删除 ✓）*/
  changedIds?: string[];
}

/** 提交待审批 ✓（非 admin 保存时走这里 ✓）*/
export async function submitUiStore<T>(
  namespace: UiStoreNamespace,
  data: T,
  submittedBy: string,
): Promise<boolean> {
  try {
    await invoke("submit_ui_store", { namespace, data, submittedBy });
    return true;
  } catch {
    return false;
  }
}

export async function listPendingUiStore(): Promise<PendingUiChange[]> {
  try {
    return await invoke<PendingUiChange[]>("list_pending_ui_store");
  } catch {
    return [];
  }
}

/** 按条目批准 ✓ —— 只应用选中的那一条 ✓ */
export async function approveUiStoreEntry(id: string, entryId: string): Promise<PendingUiChange[]> {
  try {
    return await invoke<PendingUiChange[]>("approve_ui_store_entry", { id, entryId });
  } catch {
    return [];
  }
}

export async function approveUiStore(id: string): Promise<PendingUiChange[]> {
  try {
    return await invoke<PendingUiChange[]>("approve_ui_store", { id });
  } catch {
    return [];
  }
}

/** 驳回通知 ✓ —— 让提交者知道自己的改动被驳了 ✓ */
export interface RejectionNotice {
  id: string;
  namespace: string;
  submittedBy: string;
  summary: string;
  rejectedAt: string;
  /** 被驳回的条目 id ✓ */
  entryIds?: string[];
}

export async function listRejections(): Promise<RejectionNotice[]> {
  try {
    return await invoke<RejectionNotice[]>("list_rejections");
  } catch {
    return [];
  }
}

export async function clearRejections(namespace: UiStoreNamespace): Promise<RejectionNotice[]> {
  try {
    return await invoke<RejectionNotice[]>("clear_rejections", { namespace });
  } catch {
    return [];
  }
}

export async function acknowledgeRejection(id: string): Promise<RejectionNotice[]> {
  try {
    return await invoke<RejectionNotice[]>("acknowledge_rejection", { id });
  } catch {
    return [];
  }
}

export async function rejectUiStore(id: string): Promise<PendingUiChange[]> {
  try {
    return await invoke<PendingUiChange[]>("reject_ui_store", { id });
  } catch {
    return [];
  }
}

/** 立即保存 ✓（并回读校验 ✓）*/
export async function saveUiStoreNow<T>(namespace: UiStoreNamespace, data: T): Promise<boolean> {
  if (inflight.has(namespace)) return false;
  inflight.add(namespace);
  try {
    const echo = await invoke<T | null>("set_ui_store", { namespace, data });
    if (echo !== null && echo !== undefined) {
      entryFor(namespace).text = JSON.stringify(echo);
    }
    return true;
  } catch {
    return false;
  } finally {
    inflight.delete(namespace);
  }
}

/**
 * 去抖保存 ✓ —— 500ms 内的多次调用只发一次请求。
 *
 * 为什么需要 ✗：拖动容差输入框、改规则参数时会**逐字符触发** ✓，
 * 每次都发 RPC 会把服务器打满 ✗。
 */
export function saveUiStore<T>(namespace: UiStoreNamespace, data: T) {
  const previous = pending.get(namespace);
  if (previous !== undefined) window.clearTimeout(previous);
  pending.set(
    namespace,
    window.setTimeout(() => {
      pending.delete(namespace);
      /**
       * **和服务器那份一样就别发** ✓ —— 空改动不该产生审批单 ✗。
       *
       * 实际踩到：策略引擎启动时把空的 `policy-log`（`[]`）提交了一次 ✓ →
       * 后台多出一条"待审批 · 0 项" ✗ → 点进去**空白**✗（本 bug ✓）。
       */
      let text = "";
      try {
        text = JSON.stringify(data);
      } catch {
        text = "";
      }
      if (text && text === entryFor(namespace).text) return;
      // admin 直传 ✓；其他人**提交审批** ✓（不再直接改正式文件 ✗）
      if (canWriteDirectly()) {
        void saveUiStoreNow(namespace, data);
        return;
      }
      void (async () => {
        const ok = await submitUiStore(namespace, data, authContext.username || "unknown");
        notifyApproval(ok ? "改动已提交审批 ✓ 管理员批准后其他设备才会同步" : "提交审批失败，请重试");
      })();
    }, 500),
  );
}

/** 手动「立即上传」✓ —— 按角色分流 ✓ */
export async function uploadUiStoreNow<T>(namespace: UiStoreNamespace, data: T): Promise<"direct" | "pending" | "failed"> {
  if (canWriteDirectly()) {
    return (await saveUiStoreNow(namespace, data)) ? "direct" : "failed";
  }
  const ok = await submitUiStore(namespace, data, authContext.username || "unknown");
  return ok ? "pending" : "failed";
}

/** 订阅"其他端改了数据"✓（自动轮询 ✓，返回取消订阅 ✓）*/
export function subscribeUiStore<T>(
  namespace: UiStoreNamespace,
  listener: (value: T) => void,
): () => void {
  const entry = entryFor(namespace);
  const wrapped = listener as (value: unknown) => void;
  entry.listeners.add(wrapped);

  const timer = window.setInterval(() => {
    void (async () => {
      // 本端正在写的时候不拉 ✗（会把刚写的覆盖回去 ✓）
      if (inflight.has(namespace) || pending.has(namespace)) return;
      try {
        const value = await invoke<T | null>("get_ui_store", { namespace });
        if (value === null || value === undefined) return;
        const text = JSON.stringify(value);
        if (text === entry.text) return;   // 没变 ✓
        entry.text = text;
        for (const fn of entry.listeners) fn(value);
      } catch {
        /* 网络抖动忽略 ✓ */
      }
    })();
  }, POLL_INTERVAL_MS);

  return () => {
    entry.listeners.delete(wrapped);
    window.clearInterval(timer);
  };
}
