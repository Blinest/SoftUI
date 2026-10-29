import { useCallback, useEffect, useState } from "react";
import { AiComposeDialog } from "./AiComposeDialog";
import { useRef } from "react";
import { ChevronLeft, Pencil, Plus, Trash2 } from "lucide-react";

import type { ModelLibraryEntry } from "../robot/modelBridge";
import { listModels } from "../robot/modelBridge";
import {
  clearRejections,
  listRejections,
  loadUiStore,
  saveUiStore,
  subscribeUiStore,
  canWriteDirectly,
  uploadUiStoreNow,
} from "../robot/uiStore";
import {
  readEngineEnabled,
  writeEngineEnabled,
} from "../robot/policyEngine";

/**
 * 策略编排：**方案列表 → 点进某个方案 → 编排规则** ✓。
 *
 * 第 1 轮只做**管理与持久化** ✓ —— 规则存在 localStorage（每个用户一份 ✓），
 * **还不执行** ✗。执行引擎在第 2 轮 ✓（只执行"当前生效方案"里的规则 ✓）。
 */

export type PolicyTrigger = "tension-spike" | "interval";

export interface PolicyRule {
  id: string;
  enabled: boolean;
  trigger: PolicyTrigger;
  /** 张力陡增幅度阈值（N）—— 仅 tension-spike ✓ */
  thresholdN: number;
  /** 判定窗口（ms）—— 仅 tension-spike ✓ */
  windowMs: number;
  /** 定时间隔（分钟）—— 仅 interval ✓ */
  intervalMin: number;
  /** 命中后切到哪个模型 ✓（targetKind = "model" 时用 ✓）*/
  targetModelId: string;
  /**
   * 命中后执行哪个动作 ✓（targetKind = "action" 时用 ✓）。
   *
   * "切到动作" 的语义：**加载该动作的轨迹并开始执行** ✓（末端按规划好的
   * κ 序列跑一遍 ✓）。第 1 阶段只记录配置 ✓，执行引擎下一轮接 ✓。
   */
  targetActionId?: string;
  /** 目标类型 ✓ —— 切模型 / 跑动作 ✓ */
  targetKind?: "model" | "action";
  note: string;
}

/**
 * 时间线片段 ✓ —— **按顺序执行** ✓。
 *
 * 为什么改成时间线 ✗：原来"定时规则"和"张力规则"是平级列表 ✓，
 * 同一秒到点时到底切模型还是跑动作，语义冲突 ✗。
 * 时间线**天然有序** ✓；中断单独一类 ✓，优先级高于时间线 ✓。
 */
export interface PolicyTimelineBlock {
  id: string;
  /** 动作 / 切模型 / 等待 ✓ */
  kind: "action" | "switch-model" | "wait";
  /** 动作库里的动作 id ✓（kind=action ✓）*/
  actionId?: string;
  /** 模型库里的模型 id ✓（kind=switch-model ✓）*/
  modelId?: string;
  /** 这一段持续多久（秒 ✓）—— action 会自动带出规划时长 ✓ */
  durationSec: number;
  note: string;
}

/**
 * 中断 ✓ —— **任何时候命中就打断时间线** ✓。
 */
export interface PolicyInterrupt {
  id: string;
  enabled: boolean;
  trigger: "tension-spike" | "tension-drop";
  /** 变化幅度阈值（N ✓）*/
  thresholdN: number;
  /** 判定窗口（ms ✓）*/
  windowMs: number;
  targetKind: "model" | "action";
  targetId: string;
  /** 中断做完后**是否回到时间线** ✓ */
  resume: boolean;
  note: string;
}

export interface PolicyScheme {
  id: string;
  name: string;
  /** 旧格式：平级规则列表 ✓（读到时自动迁移成 timeline + interrupts ✓）*/
  rules: PolicyRule[];
  /** **时间线** ✓ */
  timeline?: PolicyTimelineBlock[];
  /** **中断** ✓ */
  interrupts?: PolicyInterrupt[];
  /**
   * 同步状态 ✓：
   *  - `synced`  服务器上已生效 ✓
   *  - `pending` 已提交审批 ✓
   *  - `local`   只在本地 ✗
   */
  syncState?: "synced" | "pending" | "local";
  /** 已标删除、等审批 ✓（删除也要审批 ✓）*/
  pendingDelete?: boolean;
}

interface PolicyStore {
  schemes: PolicyScheme[];
  /** 当前生效的方案 id ✓ */
  activeId: string;
}

const STORAGE_KEY = "softui:policySchemes";
/**
 * **我提交审批时的内容指纹** ✓ —— 必须持久化 ✗。
 *
 * 为什么 ✗：`localEditedRef` / `localContentKeysRef` 都是 `useRef` ✓，**刷新就清空** ✗
 * → 刷新后永远认为"我没改过" ✓ → 解锁逻辑不跑 ✓ → 状态永远停在待审批 ✗（本次 bug ✓）。
 */
const SUBMITTED_KEY = "softui:policySubmittedKeys";

function readSubmittedKeys(): Set<string> {
  try {
    const raw = window.localStorage.getItem(SUBMITTED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? (parsed as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeSubmittedKeys(keys: Set<string>) {
  try {
    window.localStorage.setItem(SUBMITTED_KEY, JSON.stringify(Array.from(keys)));
  } catch {
    /* 忽略 ✓ */
  }
}
/** 动作库的存储键 ✓（和 MotionLibraryCard 共用 ✓）*/
const ACTION_KEY = "softui:motionActions";

interface ActionRef {
  id: string;
  name: string;
  pointCount: number;
}

interface ActionRefFull {
  id: string;
  name: string;
  /** 规划时长（秒 ✓）—— 来自可行性检查 ✓，没检查过就是 null ✓ */
  durationSec: number | null;
}

/** 读动作库 ✓（含可行性算出来的时长 ✓，用于时间线显示 ✓）*/
function readActionsWithDuration(): ActionRefFull[] {
  try {
    const raw = window.localStorage.getItem("softui:motionActions");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item: {
      id: string;
      name: string;
      plan?: { durationMs?: number; feasible?: boolean } | null;
      feasibility?: { models?: Array<{ ok: boolean; durationMs: number }> } | null;
    }) => {
      // 优先用可行性缓存里**第一个可行模型**的时长 ✓
      const fromCache = item.feasibility?.models?.find((m) => m.ok)?.durationMs;
      const fromPlan = item.plan?.feasible ? item.plan.durationMs : undefined;
      const ms = fromCache ?? fromPlan;
      return {
        id: item.id,
        name: item.name,
        durationSec: typeof ms === "number" && ms > 0 ? Math.round(ms / 100) / 10 : null,
      };
    });
  } catch {
    return [];
  }
}

function readActions(): ActionRef[] {
  try {
    const raw = window.localStorage.getItem(ACTION_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item: { id: string; name: string; points?: unknown[] }) => ({
      id: item.id,
      name: item.name,
      pointCount: Array.isArray(item.points) ? item.points.length : 0,
    }));
  } catch {
    return [];
  }
}

function defaultStore(): PolicyStore {
  const schemes: PolicyScheme[] = ["方案一", "方案二", "方案三"].map((name, index) => ({
    id: `scheme-${index + 1}`,
    name,
    rules: [],
    timeline: [],
    interrupts: [],
  }));
  return { schemes, activeId: schemes[0].id };
}

/**
 * 旧规则 → 时间线 + 中断 ✓（幂等 ✓）。
 *
 * - `interval` 规则 → 时间线里的**等待**片段 ✓（原来"每 N 分钟"的循环语义
 *   改成"先等 N 分钟再继续"✓ —— 时间线是一次性的 ✓，语义更明确 ✓）
 * - `tension-spike` 规则 → **中断** ✓
 */
function migrateScheme(scheme: PolicyScheme): PolicyScheme {
  if (Array.isArray(scheme.timeline)) return scheme;   // 已是新格式 ✓
  const timeline: PolicyTimelineBlock[] = [];
  const interrupts: PolicyInterrupt[] = [];
  let order = 0;
  for (const rule of scheme.rules ?? []) {
    if (rule.trigger === "interval") {
      timeline.push({
        id: `block-${scheme.id}-${order++}`,
        kind: "wait",
        durationSec: Math.max(1, rule.intervalMin) * 60,
        note: rule.note || `等待 ${rule.intervalMin} 分钟`,
      });
    } else {
      interrupts.push({
        id: `intr-${scheme.id}-${order++}`,
        enabled: rule.enabled,
        trigger: "tension-spike",
        thresholdN: rule.thresholdN,
        windowMs: rule.windowMs,
        targetKind: rule.targetKind === "action" ? "action" : "model",
        targetId: rule.targetKind === "action" ? (rule.targetActionId ?? "") : rule.targetModelId,
        resume: true,
        note: rule.note,
      });
    }
  }
  return { ...scheme, timeline, interrupts };
}

/**
 * 方案的**内容指纹** ✓ —— 用于判断"服务器上的是不是我提交的"。
 *
 * 为什么不用 `JSON.stringify(整个对象)` ✗：
 * 服务器回来的字段顺序**不保证一致** ✓（Rust 结构体 / 前端对象 ✗），
 * 整串比较会**永远不相等** ✗ → 审批通过也解不了锁 ✗（本次 bug ✓）。
 *
 * 只取"真正决定内容"的部分 ✓：方案名 + 时间线 + 中断 ✓。
 */
function schemeContentKey(scheme: {
  id?: string;
  name?: string;
  timeline?: Array<{ kind?: string; actionId?: string; modelId?: string; durationSec?: number; note?: string }>;
  interrupts?: Array<{ thresholdN?: number; windowMs?: number; targetKind?: string; targetId?: string; resume?: boolean }>;
}): string {
  const timeline = (scheme.timeline ?? []).map(
    (block) => `${block.kind}|${block.actionId ?? ""}|${block.modelId ?? ""}|${block.durationSec ?? 0}`,
  );
  const interrupts = (scheme.interrupts ?? []).map(
    (intr) => `${intr.thresholdN ?? 0}|${intr.windowMs ?? 0}|${intr.targetKind ?? ""}|${intr.targetId ?? ""}|${intr.resume ? 1 : 0}`,
  );
  return `${scheme.id ?? ""}::${scheme.name ?? ""}::${timeline.join(",")}::${interrupts.join(",")}`;
}

function readStore(): PolicyStore {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultStore();
    const parsed = JSON.parse(raw) as Partial<PolicyStore>;
    if (!Array.isArray(parsed.schemes) || parsed.schemes.length === 0) return defaultStore();
    const schemes = (parsed.schemes as PolicyScheme[]).map(migrateScheme);
    const activeId = schemes.some((item) => item.id === parsed.activeId)
      ? (parsed.activeId as string)
      : schemes[0].id;
    return { schemes, activeId };
  } catch {
    return defaultStore();
  }
}

function writeStore(store: PolicyStore) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* 忽略 ✓ */
  }
  // 跨端同步 ✓（localStorage 只作离线兜底 ✗）
  saveUiStore("policy-schemes", store);
}


export function PolicyRulesCard() {
  const [store, setStore] = useState<PolicyStore>(() => readStore());
  const [models, setModels] = useState<ModelLibraryEntry[]>([]);
  /** 动作库列表 ✓（规则可以指向动作 ✓）*/
  const [actions, setActions] = useState<ActionRef[]>(() => readActions());
  /** 引擎总开关 ✓ */
  const [engineEnabled, setEngineEnabled] = useState(() => readEngineEnabled());
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  /** AI 对话 ✓ */
  const [aiOpen, setAiOpen] = useState(false);
  /** 动作库（含时长 ✓）*/
  const [actionRefs, setActionRefs] = useState<ActionRefFull[]>(() => readActionsWithDuration());
  /**
   * 本端是否改过 ✓ —— 改过就不再接受远端覆盖 ✗。
   * （非 admin 提交到 pending ✓，正式文件不变 ✗ → 轮询必然回滚 ✗）
   */
  const localEditedRef = useRef(false);
  /** 服务器上已生效的方案 id ✓ */
  const syncedIdsRef = useRef<Set<string>>(new Set());
  /** 已提交审批、等批准的方案 id ✓ */
  const submittedIdsRef = useRef<Set<string>>(new Set());
  /** 被驳回的方案 id ✓（直接标状态，不弹提示 ✗）*/
  const [rejectedIds, setRejectedIds] = useState<Set<string>>(new Set());
  const storeRef = useRef<PolicyStore | null>(null);
  /**
   * **政策卡片不再显示「执行日志」** ✗ —— 日志与诊断页已经有一份 ✓，
   * 两处重复只会让人对不上哪份是全的 ✓（用户要求 ✓）。
   *
   * 日志本身**照旧写入** ✓ —— `appendPolicyLog` 与 `policy-log` 命名空间都不动 ✓，
   * 「日志与诊断」继续读它 ✓。这里只剩引擎开关状态的轮询 ✓。
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      setEngineEnabled(readEngineEnabled());
    }, 1500);
    return () => window.clearInterval(timer);
  }, []);
  /** 当前进入编排的方案 id ✓（null = 停在方案列表 ✓）*/
  const [openSchemeId, setOpenSchemeId] = useState<string | null>(null);
  const [renamingScheme, setRenamingScheme] = useState<string | null>(null);
  const [schemeDraft, setSchemeDraft] = useState("");

  /**
   * **按服务器 id 集合打标** ✓ —— 渲染前统一算 ✓
   * （`syncState` 是派生值 ✓，不落盘 ✗）
   */
  const remoteIds = syncedIdsRef.current;
  const markedSchemes = store.schemes.map((item) =>
    remoteIds.has(item.id)
      ? { ...item, syncState: "synced" as const }
      : item,
  );

  const openScheme = markedSchemes.find((item) => item.id === openSchemeId) ?? null;

  const refreshModels = useCallback(async () => {
    try {
      setModels(await listModels());
    } catch {
      /* 拿不到模型列表时规则仍可编辑 ✓ */
    }
  }, []);

  useEffect(() => {
    void refreshModels();
    setActions(readActions());
    setActionRefs(readActionsWithDuration());
  }, [refreshModels]);

  /** 轮询驳回结果 ✓ —— 只用来打「已驳回」标 ✓ */
  useEffect(() => {
    const pull = () => {
      void listRejections().then((items) => {
        const ids = new Set<string>();
        for (const item of items) {
          if (item.namespace !== "policy-schemes") continue;
          for (const id of item.entryIds ?? []) ids.add(id);
        }
        setRejectedIds(ids);
      });
    };
    pull();
    const timer = window.setInterval(pull, 5000);
    return () => window.clearInterval(timer);
  }, []);

  /** 首次加载 + 跨端同步 ✓ */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const remote = await loadUiStore<PolicyStore>("policy-schemes");
      if (cancelled) return;
      if (!remote || !Array.isArray(remote.schemes) || remote.schemes.length === 0) {
        // 服务器没有数据 → 把本地现有的推上去 ✓（首次迁移 ✓）
        if (storeRef.current) saveUiStore("policy-schemes", storeRef.current);
        return;
      }
      syncedIdsRef.current = new Set(remote.schemes.map((item) => item.id));
      /**
       * **保留本地的 syncState** ✓
       *
       * 服务器返回的数据**没有这个字段** ✗ —— 直接覆盖会让所有方案退回"未上传"✗
       * （刷新后状态消失 ✓ 就是这个原因 ✓）。
       * 规则：本地有同名方案 → **沿用它的状态** ✓；本地没有（别人新建的）→ 标 `synced` ✓。
       */
      // **刷新后也检查"我提交的是否已被批准"** ✓
      const submitted = readSubmittedKeys();
      const remoteKeys = new Set(remote.schemes.map((item) => schemeContentKey(item)));
      const approvedAll =
        submitted.size > 0 && Array.from(submitted).every((key) => remoteKeys.has(key));
      if (approvedAll) writeSubmittedKeys(new Set());

      setStore((prev) => {
        /**
         * **服务器来的就是"已同步"** ✓ —— 不再看本地缓存怎么说 ✗。
         *
         * 为什么 ✗：`syncState` 存在**每台设备自己的 localStorage** ✓ ——
         * 手机从来没提交过 ✓，它那份是旧的 `local` ✗ → 显示"未上传"✗（本次现象 ✓）。
         * 服务器的数据本身**就是权威** ✓。
         */
        const ids = new Set(remote.schemes.map((item) => item.id));
        syncedIdsRef.current = ids;   // ← **唯一的状态来源** ✓
        const merged: PolicyStore = {
          ...remote,
          // **保留本地选中的方案** ✓ —— 服务器那份是别的设备的 ✓，
          // 直接覆盖会让"切了方案又跳回去"✗（本次 bug ✓）。
          activeId: prev.schemes.some((item) => item.id === prev.activeId)
            ? prev.activeId
            : remote.activeId,
          schemes: remote.schemes.slice(),
        };
        // 本地**还没上传**的保留 ✓（服务器没有 + 本地标过 local/pending ✓）
        for (const item of prev.schemes) {
          if (ids.has(item.id)) continue;
          if (item.syncState === "local" || item.syncState === "pending") merged.schemes.push(item);
        }
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
        } catch {
          /* 忽略 ✓ */
        }
        return merged;
      });
    })();
    const unsubscribe = subscribeUiStore<PolicyStore>("policy-schemes", (remote) => {
      if (!remote || !Array.isArray(remote.schemes) || remote.schemes.length === 0) return;

      // **照动作库的做法** ✓：服务器有的 → `synced` ✓；本地多出来的（还没上传/待审批）→ 保留 ✓
      setStore((prev) => {
        const remoteKeys = new Set(remote.schemes.map((item) => schemeContentKey(item)));
        const merged: PolicyStore = {
          ...remote,
          // 同上：**activeId 用本地的** ✓
          activeId: prev.schemes.some((item) => item.id === prev.activeId)
            ? prev.activeId
            : remote.activeId,
          schemes: remote.schemes.map((item) => ({
            ...item,
            syncState: "synced" as const,
          })),
        };
        for (const item of prev.schemes) {
          if (remoteKeys.has(schemeContentKey(item))) continue;   // 服务器已有 ✓
          if (item.syncState === "local" || item.syncState === "pending") {
            merged.schemes.push(item);                            // 本地未上传的 → 保留 ✓
          }
        }
        writeStore(merged);
        return merged;
      });
      localEditedRef.current = false;
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const persist = (next: PolicyStore) => {
    /**
     * **同步状态不再"存"在方案里** ✓ —— 改成**从服务器数据推导** ✓：
     *   服务器上有这个 id → `synced` ✓
     *   服务器上没有 → 本地状态（`local` / `pending`）✓
     *
     * 为什么 ✅：原来把 `syncState` 写进 localStorage ✓ —— 卡片每次挂载都重读 ✓，
     * 一旦某次写错（切页签 ✓ / 切方案 ✓）就会"来回切换"✗（本次现象 ✓）。
     * 推导出来的值**不可能自相矛盾** ✓。
     */
    setStore(next);
    writeStore(next);
    localEditedRef.current = true;
    if (rejectedIds.size > 0) {
      setRejectedIds(new Set());
      void clearRejections("policy-schemes");
    }
  };


  const addScheme = () => {
    const id = `scheme-${Date.now()}`;
    const name = `方案${["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"][Math.min(store.schemes.length, 9)] ?? store.schemes.length + 1}`;
    persist({ ...store, schemes: [...store.schemes, { id, name, rules: [], syncState: "local" }] });
    setOpenSchemeId(id);
  };

  const removeScheme = (id: string) => {
    const target = store.schemes.find((item) => item.id === id);
    if (!target) return;
    if (store.schemes.length <= 1) return;

    // 已标记待删除 → **撤销** ✓
    if (target.pendingDelete) {
      persist({
        ...store,
        schemes: store.schemes.map((item) =>
          item.id === id ? { ...item, pendingDelete: false } : item,
        ),
      });
      return;
    }

    // **被驳回的不算"已生效"** ✓ —— 可以直接删 ✓（不用再审批一轮 ✗）
    const rejected = rejectedIds.has(id);
    const synced = !rejected && (target.syncState === "synced" || syncedIdsRef.current.has(id));
    if (
      !window.confirm(
        synced
          ? `「${target.name}」已在服务器生效 ✓。\n提交删除后需要管理员审批 ✓，批准后其他设备将看不到它 ✗。`
          : `删除「${target.name}」？里面的 ${target.timeline?.length ?? 0} 段时间线和 ${target.interrupts?.length ?? 0} 条中断会一并删除。`,
      )
    ) {
      return;
    }

    if (synced) {
      /**
       * **管理员直接删** ✓ —— 不再"标记待删除 → 等审批"✗。
       *
       * 原来这条分支不看角色 ✓ → 管理员删自己的方案也要走审批 ✗ →
       * 后台多出一条"待审批"、前台留下 `pendingDelete` 幽灵行 ✗（本 bug ✓）。
       * 管理员本来就直传（`canWriteDirectly()` ✓），删除也一样直传 ✓。
       */
      if (canWriteDirectly()) {
        const schemes = store.schemes.filter((item) => item.id !== id);
        const activeId = store.activeId === id ? schemes[0].id : store.activeId;
        persist({ schemes, activeId });
        if (openSchemeId === id) setOpenSchemeId(null);
        void (async () => {
          const result = await uploadUiStoreNow("policy-schemes", { ...store, schemes, activeId });
          setUploadNotice(
            result === "direct"
              ? `已删除「${target.name}」✓ 其他设备 5 秒内同步`
              : "本地已删除，但上传失败 —— 点「立即上传」重试",
          );
          window.setTimeout(() => setUploadNotice(null), 6000);
        })();
        return;
      }

      // 已同步 → **标记待删除** ✓（等审批 ✓）
      persist({
        ...store,
        schemes: store.schemes.map((item) =>
          item.id === id ? { ...item, pendingDelete: true } : item,
        ),
      });
      setUploadNotice("已标记删除 ✓ 点「立即上传」提交审批");
      window.setTimeout(() => setUploadNotice(null), 6000);
      return;
    }

    // 未同步的 → 直接删 ✓
    const schemes = store.schemes.filter((item) => item.id !== id);
    const activeId = store.activeId === id ? schemes[0].id : store.activeId;
    persist({ schemes, activeId });
    if (openSchemeId === id) setOpenSchemeId(null);
  };

  const renameScheme = (id: string, name: string) => {
    const trimmed = name.trim();
    setRenamingScheme(null);
    if (!trimmed) return;
    persist({
      ...store,
      schemes: store.schemes.map((item) => (item.id === id ? { ...item, name: trimmed } : item)),
    });
  };

  const setActive = (id: string) => persist({ ...store, activeId: id });

  // ── 视图 A：方案列表 ✓ ────────────────────────────────────────
  if (!openScheme) {
    return (
      <div className="policy-card">
        <div className="policy-toolbar">
          <button type="button" className="ghost-btn" onClick={addScheme}>
            <Plus size={14} />
            <span>新建方案</span>
          </button>
          <span className="policy-hint">
            {store.schemes.length} 个方案 · 生效中：<b>{store.schemes.find((s) => s.id === store.activeId)?.name ?? "—"}</b>
          </span>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => {
              void (async () => {
                // 待删除的方案不发给服务器 ✓（服务器没有它 = 删除生效 ✓）
                // **按角色决定** ✓：管理员剔除待删 ✓，操作员带上待删 ✓
                const payload: PolicyStore = canWriteDirectly()
                  ? { ...store, schemes: store.schemes.filter((item) => !item.pendingDelete) }
                  : store;
                const result = await uploadUiStoreNow("policy-schemes", payload);
                if (result === "direct") {
                  const remote = await loadUiStore<PolicyStore>("policy-schemes");
                  // ⚠ 服务器返回的数据**没有 syncState** ✗ ——
                  //   直接 `setStore(remote)` 会让徽标消失/退回"未上传"✗（本 bug ✓）。
                  //   所以合并时**显式打标** ✓。
                  setStore((prev) => {
                    const base = remote && Array.isArray(remote.schemes) && remote.schemes.length > 0
                      ? remote
                      : prev;
                    syncedIdsRef.current = new Set(base.schemes.map((item) => item.id));
                    return {
                      ...base,
                      schemes: base.schemes.map((item) => ({ ...item, syncState: "synced" as const })),
                    };
                  });
                  localEditedRef.current = false;
                  setUploadNotice("已上传 ✓ 其他设备 5 秒内可见");
                } else if (result === "pending") {
                  // ⚠ 原来这里用 `syncedIdsRef.has(id)` 跳过 ✗ ——
                  //   那个集合的意思是"**服务器上有这个方案**"✓，不是"内容已同步"✗。
                  //   结果：老方案全被跳过 ✓ → 永远停在「未上传」✗（本 bug ✓）。
                  //   改成**全部标待审批** ✓（除了标记删除的 ✓）。
                  setStore((prev) => ({
                    ...prev,
                    schemes: prev.schemes.map((scheme) => {
                      submittedIdsRef.current.add(scheme.id);
                      return { ...scheme, syncState: "pending" as const };
                    }),
                  }));
                  setUploadNotice("已提交审批 ✓ 管理员批准后生效");
                } else {
                  setUploadNotice("上传失败，请重试");
                }
                window.setTimeout(() => setUploadNotice(null), 6000);
              })();
            }}
            title="立即把方案与规则写到服务器 ✓"
          >
            立即上传
          </button>
          {uploadNotice ? <span className="policy-hint">{uploadNotice}</span> : null}
          <label className="policy-engine">
            <input
              type="checkbox"
              checked={engineEnabled}
              onChange={(event) => {
                setEngineEnabled(event.target.checked);
                writeEngineEnabled(event.target.checked);
              }}
            />
            <span>{engineEnabled ? "引擎运行中" : "引擎已停止"}</span>
          </label>
        </div>

        <ul className="scheme-list">
          {markedSchemes.map((item) => {
            const isActive = item.id === store.activeId;
            return (
              <li
                key={item.id}
                className={`scheme-item${isActive ? " is-active" : ""}${
                  item.pendingDelete ? " is-pending-delete" : ""
                }`}
              >
                {renamingScheme === item.id ? (
                  <input
                    className="policy-scheme-input"
                    autoFocus
                    value={schemeDraft}
                    onChange={(event) => setSchemeDraft(event.target.value)}
                    onBlur={() => renameScheme(item.id, schemeDraft)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") renameScheme(item.id, schemeDraft);
                      if (event.key === "Escape") setRenamingScheme(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="scheme-name"
                    onClick={() => setOpenSchemeId(item.id)}
                    title="点击进入编排"
                  >
                    <span>{item.name}</span>
                    {rejectedIds.has(item.id) ? (
                      <em className="motion-badge is-rejected" title="管理员驳回了这次改动">已驳回</em>
                    ) : item.pendingDelete ? (
                      <em className="motion-badge is-delete" title="已标记删除，等待审批">待删除</em>
                    ) : item.syncState === "local" ? (
                      <em className="motion-badge is-local" title="只在本地，还没上传">未上传</em>
                    ) : item.syncState === "pending" ? (
                      <em className="motion-badge is-pending" title="已提交审批">待审批</em>
                    ) : item.syncState === "synced" ? (
                      <em className="motion-badge is-synced" title="服务器上已生效">已同步</em>
                    ) : null}
                    <em>
                      {item.timeline?.length ?? 0} 段
                      {(item.interrupts?.length ?? 0) > 0 ? ` · ${item.interrupts?.length} 中断` : ""}
                    </em>
                  </button>
                )}

                <div className="scheme-actions">
                  {/* 重命名用**独立按钮** ✓ —— 原来靠双击 ✗，但单击会先导航走 ✗，
                      双击事件永远等不到 ✗（这是本次 bug 的根因）*/}
                  <button
                    type="button"
                    className="policy-delete"
                    style={{ color: "var(--text-secondary)" }}
                    onClick={() => {
                      setSchemeDraft(item.name);
                      setRenamingScheme(item.id);
                    }}
                    title="重命名方案"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    className={`scheme-active${isActive ? " is-on" : ""}`}
                    disabled={isActive}
                    onClick={() => setActive(item.id)}
                    title={isActive ? "当前生效" : "设为生效"}
                  >
                    {isActive ? "生效中" : "设为生效"}
                  </button>
                  <button
                    type="button"
                    className="policy-delete"
                    disabled={store.schemes.length <= 1}
                    onClick={() => removeScheme(item.id)}
                    title={store.schemes.length <= 1 ? "至少保留一个方案" : "删除方案"}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  // ── 视图 B：某个方案的规则编排 ✓ ──────────────────────────────

  if (models.length === 0) {
    return (
      <div className="policy-card">
        <button type="button" className="ghost-btn" onClick={() => setOpenSchemeId(null)}>
          <ChevronLeft size={14} /> 返回方案列表
        </button>
        <p className="policy-empty">先用配置表或导入模型包，再来编排策略。</p>
      </div>
    );
  }

  return (
    <div className="policy-card">
      <div className="policy-toolbar">
        <button type="button" className="ghost-btn" onClick={() => setOpenSchemeId(null)}>
          <ChevronLeft size={14} />
          <span>方案列表</span>
        </button>
        <span className="policy-crumb">
          方案 / <b>{openScheme.name}</b>
          {openScheme.id === store.activeId ? <i>生效中</i> : null}
        </span>
      </div>

      <div className="policy-ai-entry">
        <button type="button" className="ghost-btn" onClick={() => setAiOpen(true)}>
          智能策略编排
        </button>
      </div>

      {actions.length === 0 ? (
        <p className="policy-hint">
          动作库还没有动作。
        </p>
      ) : null}

      {/* ── 时间线 ✓ ─────────────────────────────────────────── */}
      {(() => {
        const timeline = openScheme.timeline ?? [];
        const interrupts = openScheme.interrupts ?? [];
        const totalSec = timeline.reduce((sum, block) => sum + Math.max(0, block.durationSec), 0);
        let cursor = 0;

        const commitTimeline = (next: PolicyTimelineBlock[]) =>
          persist({
            ...store,
            schemes: store.schemes.map((item) =>
              item.id === openScheme.id ? { ...item, timeline: next } : item,
            ),
          });
        const commitInterrupts = (next: PolicyInterrupt[]) =>
          persist({
            ...store,
            schemes: store.schemes.map((item) =>
              item.id === openScheme.id ? { ...item, interrupts: next } : item,
            ),
          });

        const addBlock = (kind: PolicyTimelineBlock["kind"]) => {
          commitTimeline([
            ...timeline,
            {
              id: `block-${Date.now()}`,
              kind,
              actionId: kind === "action" ? (actionRefs[0]?.id ?? "") : undefined,
              modelId: kind === "switch-model" ? (models[0]?.id ?? "") : undefined,
              durationSec: kind === "action" ? (actionRefs[0]?.durationSec ?? 10) : 10,
              note: "",
            },
          ]);
        };

        return (
          <>
            {/* ── AI 助手入口 ✓（详细表单在对话框里 ✓）────────── */}

            <div className="policy-timeline-head">
              <span>时间线</span>
              <em>总时长 {totalSec.toFixed(1)}s · {timeline.length} 段</em>
            </div>

            {timeline.length === 0 ? (
              <p className="policy-empty">还没有片段。点下面的「添加片段」开始。</p>
            ) : (
              <ol className="policy-timeline">
                {timeline.map((block, index) => {
                  const from = cursor;
                  cursor += Math.max(0, block.durationSec);
                  const action = actionRefs.find((item) => item.id === block.actionId);
                  return (
                    <li key={block.id} className="policy-timeline-block">
                      <span className="policy-timeline-index">{index + 1}</span>
                      <div className="policy-timeline-main">
                        <div className="policy-row">
                          <select
                            value={block.kind}
                            onChange={(event) =>
                              commitTimeline(
                                timeline.map((item) =>
                                  item.id === block.id
                                    ? { ...item, kind: event.target.value as PolicyTimelineBlock["kind"] }
                                    : item,
                                ),
                              )
                            }
                          >
                            <option value="action">执行动作</option>
                            <option value="switch-model">切换模型</option>
                            <option value="wait">等待</option>
                          </select>

                          {block.kind === "action" ? (
                            <select
                              value={block.actionId ?? ""}
                              onChange={(event) => {
                                const picked = actionRefs.find((item) => item.id === event.target.value);
                                commitTimeline(
                                  timeline.map((item) =>
                                    item.id === block.id
                                      ? {
                                          ...item,
                                          actionId: event.target.value,
                                          // 选动作时**自动带出时长** ✓
                                          durationSec: picked?.durationSec ?? item.durationSec,
                                        }
                                      : item,
                                  ),
                                );
                              }}
                            >
                              <option value="">（选择动作）</option>
                              {actionRefs.map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.name}
                                  {item.durationSec != null ? `（${item.durationSec}s）` : "（未计算时长）"}
                                </option>
                              ))}
                            </select>
                          ) : block.kind === "switch-model" ? (
                            <select
                              value={block.modelId ?? ""}
                              onChange={(event) =>
                                commitTimeline(
                                  timeline.map((item) =>
                                    item.id === block.id ? { ...item, modelId: event.target.value } : item,
                                  ),
                                )
                              }
                            >
                              {models.map((model) => (
                                <option key={model.id} value={model.id}>
                                  {model.name}
                                </option>
                              ))}
                            </select>
                          ) : null}

                          <span className="policy-unit">持续</span>
                          <input
                            type="number"
                            step="0.5"
                            min={0}
                            value={block.durationSec}
                            onChange={(event) =>
                              commitTimeline(
                                timeline.map((item) =>
                                  item.id === block.id
                                    ? { ...item, durationSec: Number(event.target.value) }
                                    : item,
                                ),
                              )
                            }
                          />
                          <span className="policy-unit">s</span>

                          <span className="policy-timeline-range">
                            {from.toFixed(1)}–{cursor.toFixed(1)}s
                          </span>

                          {block.kind === "action" && action?.durationSec != null ? (
                            <em className="policy-timeline-hint">规划时长 {action.durationSec}s</em>
                          ) : null}
                          {block.kind === "action" && action?.durationSec == null ? (
                            <em className="policy-timeline-hint is-warn">时长未计算（先做可行性检查）</em>
                          ) : null}
                        </div>
                      </div>
                      <div className="policy-timeline-actions">
                        <button
                          type="button"
                          className="policy-delete"
                          disabled={index === 0}
                          onClick={() => {
                            const next = [...timeline];
                            [next[index - 1], next[index]] = [next[index], next[index - 1]];
                            commitTimeline(next);
                          }}
                          title="上移"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="policy-delete"
                          disabled={index === timeline.length - 1}
                          onClick={() => {
                            const next = [...timeline];
                            [next[index], next[index + 1]] = [next[index + 1], next[index]];
                            commitTimeline(next);
                          }}
                          title="下移"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="policy-delete"
                          onClick={() => commitTimeline(timeline.filter((item) => item.id !== block.id))}
                          title="删除片段"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}

            <div className="policy-row" style={{ gap: 6 }}>
              <button type="button" className="ghost-btn" onClick={() => addBlock("action")}>
                <Plus size={13} /> 执行动作
              </button>
              <button type="button" className="ghost-btn" onClick={() => addBlock("switch-model")}>
                <Plus size={13} /> 切换模型
              </button>
              <button type="button" className="ghost-btn" onClick={() => addBlock("wait")}>
                <Plus size={13} /> 等待
              </button>
            </div>

            {/* ── 中断 ✓ ─────────────────────────────────────── */}
            <div className="policy-timeline-head">
              <span>中断</span>
              <em>{interrupts.length} 条 · 命中时打断时间线</em>
            </div>

            {interrupts.length === 0 ? (
              <p className="policy-empty">还没有中断规则。</p>
            ) : (
              <ul className="policy-list">
                {interrupts.map((intr) => (
                  <li key={intr.id} className={`policy-item${intr.enabled ? "" : " is-off"}`}>
                    <label className="policy-toggle">
                      <input
                        type="checkbox"
                        checked={intr.enabled}
                        onChange={(event) =>
                          commitInterrupts(
                            interrupts.map((item) =>
                              item.id === intr.id ? { ...item, enabled: event.target.checked } : item,
                            ),
                          )
                        }
                      />
                      <span>{intr.enabled ? "启用" : "停用"}</span>
                    </label>

                    <div className="policy-main">
                      <div className="policy-row">
                        <span className="policy-unit">张力陡增 &gt;</span>
                        <input
                          type="number"
                          step="0.5"
                          value={intr.thresholdN}
                          onChange={(event) =>
                            commitInterrupts(
                              interrupts.map((item) =>
                                item.id === intr.id ? { ...item, thresholdN: Number(event.target.value) } : item,
                              ),
                            )
                          }
                        />
                        <span className="policy-unit">N /</span>
                        <input
                          type="number"
                          step="500"
                          value={intr.windowMs}
                          onChange={(event) =>
                            commitInterrupts(
                              interrupts.map((item) =>
                                item.id === intr.id ? { ...item, windowMs: Number(event.target.value) } : item,
                              ),
                            )
                          }
                        />
                        <span className="policy-unit">ms 内 →</span>

                        <select
                          value={intr.targetKind}
                          onChange={(event) =>
                            commitInterrupts(
                              interrupts.map((item) =>
                                item.id === intr.id
                                  ? { ...item, targetKind: event.target.value as "model" | "action" }
                                  : item,
                              ),
                            )
                          }
                        >
                          <option value="model">切模型</option>
                          <option value="action">执行动作</option>
                        </select>

                        <select
                          value={intr.targetId}
                          onChange={(event) =>
                            commitInterrupts(
                              interrupts.map((item) =>
                                item.id === intr.id ? { ...item, targetId: event.target.value } : item,
                              ),
                            )
                          }
                        >
                          <option value="">（选择）</option>
                          {(intr.targetKind === "model"
                            ? models.map((model) => ({ id: model.id, name: model.name }))
                            : actionRefs.map((item) => ({ id: item.id, name: item.name }))
                          ).map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.name}
                            </option>
                          ))}
                        </select>

                        <label className="motion-tolerance">
                          <input
                            type="checkbox"
                            checked={intr.resume}
                            onChange={(event) =>
                              commitInterrupts(
                                interrupts.map((item) =>
                                  item.id === intr.id ? { ...item, resume: event.target.checked } : item,
                                ),
                              )
                            }
                          />
                          <span>结束后回到时间线</span>
                        </label>
                      </div>
                    </div>

                    <button
                      type="button"
                      className="policy-delete"
                      onClick={() => commitInterrupts(interrupts.filter((item) => item.id !== intr.id))}
                      title="删除中断"
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="policy-row">
              <button
                type="button"
                className="ghost-btn"
                onClick={() =>
                  commitInterrupts([
                    ...interrupts,
                    {
                      id: `intr-${Date.now()}`,
                      enabled: true,
                      trigger: "tension-spike",
                      thresholdN: 5,
                      windowMs: 2000,
                      targetKind: "model",
                      targetId: models[0]?.id ?? "",
                      resume: true,
                      note: "",
                    },
                  ])
                }
              >
                <Plus size={13} /> 添加中断
              </button>
            </div>
          </>
        );
      })()}
      <AiComposeDialog
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        context={{
          models: models.map((m) => ({ id: m.id, name: m.name })),
          actions: actionRefs.map((a) => ({ id: a.id, name: a.name, durationSec: a.durationSec })),
        }}
        onAdopt={(draft) => {
          if (!openScheme) return;
          persist({
            ...store,
            schemes: store.schemes.map((item) =>
              item.id === openScheme.id
                ? {
                    ...item,
                    // ⚠ **不改方案名** ✗ —— AI 起的名字又长又不可控 ✓，
                    //   而且"采用建议"不该顺带改名字 ✗（用户要改可以自己双击改 ✓）。
                    timeline: draft.timeline ?? [],
                    interrupts: draft.interrupts ?? [],
                  }
                : item,
            ),
          });
          setUploadNotice("已采用 AI 建议 ✓ 记得点「立即上传」");
          window.setTimeout(() => setUploadNotice(null), 8000);
        }}
      />
    </div>
  );
}
