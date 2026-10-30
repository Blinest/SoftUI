import { loadUiStore, saveUiStore } from "./uiStore";

/**
 * **预校准** ✓ —— 记住"臂体伸直"时的六路位移 ✓，之后一键回到该姿态 ✓。
 *
 * 为什么需要 ✗：`0x11` 的"归零"是**电机自己的零点** ✓，和设备机械上的"伸直"
 * 不一定是同一个位置 ✓（装配、丝长、预紧都会让它偏几毫米 ✓）。
 * 所以操作员要的是"回到我上次确认过伸直的那个位置"✓，而不是回到电机零点 ✓。
 *
 * 存哪儿 ✗：`localStorage` 只在本浏览器有效 ✓ → 换台电脑就没了 ✗。
 * 这里用后端共享存储（`ui-prefs` 命名空间 ✓），手机 / 电脑看到的是同一份 ✓。
 *
 * 结构：
 * ```ts
 * { values: [m1..m6] mm, recordedAt: ISO 时间戳, note?: string }
 * ```
 */

export interface Precalibration {
  /** 六路电机位移（mm，带符号 ✓）—— 记录时的**实测**位置 ✓ */
  values: number[];
  /** 记录时间（ISO ✓），用于界面显示"什么时候记的" ✓ */
  recordedAt: string;
  /** 备注（可选，比如"用直尺对齐后的位置"）*/
  note?: string;
}

const NAMESPACE = "ui-prefs";
const KEY = "precalibration";
const LOCAL_KEY = "softui.precalibration";

function normalize(raw: unknown): Precalibration | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as { values?: unknown; recordedAt?: unknown; note?: unknown };
  if (!Array.isArray(item.values) || item.values.length < 6) return null;
  const values = item.values.slice(0, 6).map((value) => Number(value));
  if (!values.every((value) => Number.isFinite(value))) return null;
  return {
    values,
    recordedAt: typeof item.recordedAt === "string" ? item.recordedAt : new Date().toISOString(),
    note: typeof item.note === "string" ? item.note : undefined,
  };
}

/** **读本机缓存** ✓（同步 ✓，界面首屏就能显示 ✓）*/
export function readPrecalibrationLocal(): Precalibration | null {
  try {
    const raw = window.localStorage.getItem(LOCAL_KEY);
    if (!raw) return null;
    return normalize(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeLocal(value: Precalibration | null) {
  try {
    if (value) window.localStorage.setItem(LOCAL_KEY, JSON.stringify(value));
    else window.localStorage.removeItem(LOCAL_KEY);
  } catch {
    /* 忽略 */
  }
}

/** **保存预校准** ✓ —— 同时写本机缓存与后端共享存储 ✓ */
export function savePrecalibration(values: number[], note?: string): Precalibration {
  const entry: Precalibration = {
    values: values.slice(0, 6).map((value) => value),
    recordedAt: new Date().toISOString(),
    note,
  };
  writeLocal(entry);
  // 后端共享：`ui-prefs` 里按 key 存 ✓（失败不影响本机可用 ✓）
  void (async () => {
    try {
      const current = await loadUiStore<Record<string, unknown>>(NAMESPACE);
      const next = { ...(current ?? {}), [KEY]: entry };
      saveUiStore(NAMESPACE, next);
    } catch (error) {
      console.warn("[precalibration] 写入共享存储失败（本机已保存）", error);
    }
  })();
  return entry;
}

/** **清空预校准** ✓ */
export function clearPrecalibration() {
  writeLocal(null);
  void (async () => {
    try {
      const current = await loadUiStore<Record<string, unknown>>(NAMESPACE);
      if (!current) return;
      const next = { ...current };
      delete next[KEY];
      saveUiStore(NAMESPACE, next);
    } catch {
      /* 忽略 */
    }
  })();
}

/** **从后端拉一次** ✓ —— 本机没有、或想跟上别的端刚记的值时调 ✓ */
export async function fetchPrecalibrationRemote(): Promise<Precalibration | null> {
  try {
    const remote = await loadUiStore<Record<string, unknown>>(NAMESPACE);
    const entry = normalize(remote?.[KEY]);
    if (entry) {
      writeLocal(entry);
      return entry;
    }
  } catch (error) {
    console.warn("[precalibration] 读取共享存储失败", error);
  }
  return readPrecalibrationLocal();
}
