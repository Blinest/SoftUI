import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Circle, CircleDot, Pause, Pencil, Play, Plus, Square, Trash2 } from "lucide-react";

import {
  clearPoints,
  getMotionDraft,
  recordCurrentPoint,
  removePoint,
  setRecording,
  subscribeMotionDraft,
} from "../robot/motionDraft";
import { listModels, type ModelLibraryEntry } from "../robot/modelBridge";
import { planForAllModels, type ModelFeasibility } from "../robot/motionPlan";
import {
  getPlaybackOwner,
  hasCurrentPlayback,
  PLAY_REQUEST_KEY,
  type PlayRequest,
} from "../robot/motionPlayer";
import {
  clearRejections,
  listRejections,
  canWriteDirectly,
  loadUiStore,
  saveUiStore,
  subscribeUiStore,
  uploadUiStoreNow,
} from "../robot/uiStore";
import {
  isCurrentPlaybackPaused,
  pauseCurrentPlayback,
  resumeCurrentPlayback,
} from "../robot/motionPlayer";
/**
 * 动作库：**动作列表 → 点进某个动作 → 记录/编排末端轨迹** ✓。
 *
 * 动作 = 一串**末端点** ✓（和当时手臂形位无关 ✓）。
 * 可行性检查 = 对**模型库里每个模型**分别做平滑形位搜寻 ✓。
 */

export interface MotionAction {
  id: string;
  name: string;
  /** 记录用的模型（仅作标注 ✓，可行性检查会遍历全部模型 ✓）*/
  modelId: string;
  points: Array<{ x: number; y: number; z: number; kappa: number[]; index: number }>;
  /** 末端容差带（mm）✓ */
  toleranceMm: number;
  createdAt: string;
  note: string;
  /** 记录点坐标系版本 ✓（旧数据是 "svc" ✗，需换轴 ✓）*/
  pointsFrame?: PointsFrame;
  /**
   * 同步状态 ✓：
   *  - `synced`  服务器上已生效 ✓
   *  - `pending` 已提交审批、还没批 ✓
   *  - `local`   只在本地，还没上传 ✗
   */
  syncState?: "synced" | "pending" | "local";
  /**
   * 已标删除、**等审批** ✓。
   *
   * 为什么不直接从数组里删掉 ✗：删了就没法显示"删除中"✓，
   * 也没法在审批前**撤销**✓。标记法能：
   *  - UI 上打删除线 ✓ + 显示"待删除"✓
   *  - 上传时**排除掉**（不发给服务器 ✓）→ 批准后其他设备就看不到了 ✓
   */
  pendingDelete?: boolean;
  /**
   * 规划结果 ✓ —— **带采样点** ✓。
   *
   * 为什么要存 ✗：原来只存 `durationMs/maxDeviationMm/feasible`（摘要 ✓）
   * 真正的 `samples` 只在内存里 ✓，一刷新就没了 ✓ → 「播放」按钮又变灰 ✗
   * → 用户每次都得重新点「可行性」✗（本次问题 ✓）。
   */
  plan?: {
    durationMs: number;
    maxDeviationMm: number;
    feasible: boolean;
    modelId?: string;
    modelName?: string;
    samples?: Array<{ kx: number[]; ky: number[]; x: number; y: number; z: number }>;
  } | null;
  /**
   * **可行性缓存** ✓ —— 按容差整批存 ✓。
   *
   * 为什么这样设计 ✗：可行性是"**每条轨迹 × 每个模型**"的组合 ✓，
   * 算一次要好几秒 ✓。但结果只跟**轨迹 + 容差**有关 ✓，
   * 只要这两样没变 ✓，再算就是浪费 ✗（用户的原话 ✓）。
   *
   * 失效条件（两个）：
   *  ① `toleranceMm` 变了 ✓  → 整批重算 ✓
   *  ② 记录点变了（`points` 变 ✓ → `persist` 里清掉 ✓）
   */
  feasibility?: {
    /** 计算时用的容差 ✓ */
    toleranceMm: number;
    /** 计算时的点数 ✓（双重保险 ✓）*/
    pointCount: number;
    /** 每个模型一行 ✓ */
    models: Array<{
      modelId: string;
      modelName: string;
      ok: boolean;
      durationMs: number;
      maxDeviationMm: number;
      /** 只有可行的模型才有采样点 ✓（不可行的没必要存 ✗）*/
      samples?: Array<{ kx: number[]; ky: number[]; x: number; y: number; z: number }>;
      /** 不可行时的原因摘要 ✓ */
      reason?: string;
    }>;
  } | null;
}

const STORAGE_KEY = "softui:motionActions";

/**
 * 记录点的坐标系版本 ✓。
 *
 * `"svc"`   —— 旧格式 ✗：`(x, y, z)` 是 svc 系（y 是臂轴方向 ✓）
 * `"three"` —— 新格式 ✓：`(x, y, z)` 已经是 three 系（y 向上 ✓）
 *
 * 旧数据必须**换轴**（y↔z 互换 ✓）才能和 IK 的 `reached` 对上 ✗ ——
 * 不换就是 90° 错位 ✓，残差 400mm+ ✗。
 */
type PointsFrame = "svc" | "three";

function migrateActions(actions: MotionAction[]): { actions: MotionAction[]; changed: boolean } {
  let changed = false;
  const migrated = actions.map((action) => {
    const frame = (action as MotionAction & { pointsFrame?: PointsFrame }).pointsFrame;
    if (frame === "three") return action;
    changed = true;
    return {
      ...action,
      pointsFrame: "three" as PointsFrame,
      // svc (x, y, z) → three (x, z, y) ✓
      points: action.points.map((point) => ({ ...point, y: point.z, z: point.y })),
      // 旧的规划结果作废 ✓（坐标系变了 ✗）
      plan: null,
    };
  });
  return { actions: migrated, changed };
}
/** 停留在哪个动作里 ✓ —— 切页签时卡片会卸载 ✗，不存这里就会"回到列表"✗ */
const OPEN_KEY = "softui:motionOpenId";

function readOpenId(): string | null {
  try {
    return window.localStorage.getItem(OPEN_KEY);
  } catch {
    return null;
  }
}

function writeOpenId(id: string | null) {
  try {
    if (id) window.localStorage.setItem(OPEN_KEY, id);
    else window.localStorage.removeItem(OPEN_KEY);
  } catch {
    /* 忽略 ✓ */
  }
}

function readActions(): MotionAction[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MotionAction[]) : [];
  } catch {
    return [];
  }
}

/**
 * 写动作库 ✓ —— 从 `localStorage` 改成**后端共享存储** ✓。
 *
 * `localStorage` 是每浏览器一份 ✗，多端不同步 ✗；
 * 后端写文件 → 手机/电脑/平板看到同一份 ✓。
 * 同时**保留一份 localStorage 副本** ✓ 作为离线兜底（断网时至少能看 ✓）。
 */
function writeActions(actions: MotionAction[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(actions));
  } catch {
    /* 忽略 ✓ */
  }
  saveUiStore("motion-actions", actions);   // 去抖 500ms ✓
}

export function MotionLibraryCard() {
  /** 服务器上已生效的 id ✓ */
  const syncedIdsRef = useRef<Set<string>>(new Set());
  /** 已提交审批、等待批准的 id ✓ */
  const submittedIdsRef = useRef<Set<string>>(new Set());

  const [actions, setActions] = useState<MotionAction[]>(() => {
    // 旧数据自动迁移 ✓（换轴 + 作废旧规划 ✓）—— 不然老动作永远"不可达"✗
    const stored = readActions();
    const { actions: migrated, changed } = migrateActions(stored);
    if (changed) writeActions(migrated);
    return migrated;
  });
  const [models, setModels] = useState<ModelLibraryEntry[]>([]);
  /** 当前进入编排的动作 id ✓（null = 停在动作列表 ✓）*/
  const [openId, setOpenIdState] = useState<string | null>(() => readOpenId());
  const setOpenId = (id: string | null) => {
    setOpenIdState(id);
    writeOpenId(id);
  };
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [draft, setDraft] = useState(() => getMotionDraft());
  const [plans, setPlans] = useState<Record<string, ModelFeasibility[]>>({});
  const [checking, setChecking] = useState<string | null>(null);
  /** 上传反馈 ✓ */
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  /** 被驳回的条目 id ✓（用于把卡片标成「已驳回」✓，不弹提示 ✗）*/
  const [rejectedIds, setRejectedIds] = useState<Set<string>>(new Set());
  /**
   * 本地是否有**还没上传成功**的改动 ✓。
   *
   * 没有这个保护的话 ✗：新建动作后还没等去抖上传 ✓，
   * 5 秒轮询拉到服务器上的旧数据（空数组 ✓）→ **动作直接消失** ✗。
   */
  /**
   * 本端是否**改过**（本次会话内）✓。
   *
   * 一旦改过，就**不再接受远端覆盖** ✗ —— 原因是：
   *  - admin 直传 → 正式文件会变 ✓（可以接受远端 ✓）
   *  - **非 admin 提交审批 → 正式文件永远不变** ✗ → 轮询每次都读到旧数据 ✗
   *    → 必然把自己的改动冲掉 ✗（这就是"动作消失"的真因 ✓）
   *
   * 想拿远端数据时，**重新进页面**即可 ✓（可预期 ✓，比"偷偷回滚"好 ✓）。
   */
  const localEditedRef = useRef(false);
  /** 本地缓存（用于"服务器空 → 推上去"✓）*/
  const storedRef = useRef<MotionAction[]>([]);
  // ⚠ 不能写进 useState 的初始化函数里 ✗ —— 那时 `storedRef` 还没声明 ✓，
  //   会抛 "Cannot access before initialization" ✗（今天真踩了 ✗）。
  useEffect(() => {
    storedRef.current = actions;
  }, [actions]);
  /** 本地内容的 JSON ✓（轮询时和服务器比 ✓ —— 相等说明"我的提交已生效"✓）*/
  const localJsonRef = useRef<string>("");
  // ⚠ 同样不能写进 useState 初始化 ✗（那时还没声明 ✓ → TDZ ✗）
  useEffect(() => {
    if (!localEditedRef.current) {
      localJsonRef.current = JSON.stringify(actions);
    }
  }, [actions]);
  /** 播放反馈 ✓ —— 点了要**立刻看到反应** ✗（否则用户以为没生效 ✗）*/
  const [playNotice, setPlayNotice] = useState<string | null>(null);
  /**
   * **播放器状态** ✓ —— 和控制页**同源** ✗：
   * 两边都从 `motionPlayer` 模块读 ✓，不各存一份 state ✗
   * （各存一份会**不同步** ✓：动作库点了暂停 ✓，控制页还显示"正在播放"✗）。
   */
  const [, setPlaybackTick] = useState(0);
  const playbackPaused = isCurrentPlaybackPaused();
  const playbackOn = hasCurrentPlayback();
  useEffect(() => {
    const timer = window.setInterval(() => setPlaybackTick((n) => n + 1), 250);
    return () => window.clearInterval(timer);
  }, []);

  const openAction = useMemo(
    () => actions.find((item) => item.id === openId) ?? null,
    [actions, openId],
  );

  // 存的 id 在库里已经不存在了（被删 / 换了浏览器 ✓）→ 清掉 ✓
  useEffect(() => {
    if (openId && !actions.some((item) => item.id === openId)) {
      setOpenId(null);
    }
  }, [actions, openId]);

  useEffect(() => subscribeMotionDraft(setDraft), []);

  /**
   * 轮询驳回结果 ✓（5 秒 ✓）——
   * **只用来给卡片打「已驳回」标记** ✓，不弹任何提示 ✗。
   */
  useEffect(() => {
    const pull = () => {
      void listRejections().then((items) => {
        const ids = new Set<string>();
        for (const item of items) {
          if (item.namespace !== "motion-actions") continue;
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
      const remote = await loadUiStore<MotionAction[]>("motion-actions");
      if (cancelled) return;
      const remoteList = Array.isArray(remote) ? migrateActions(remote).actions : [];
      const remoteIds = new Set(remoteList.map((item) => item.id));
      syncedIdsRef.current = remoteIds;

      setActions((local) => {
        // **合并** ✓：服务器有的用服务器的 ✓；服务器没有的（本地新建 / 待审批）**保留** ✓
        const merged: MotionAction[] = remoteList.map((item) => ({
          ...item,
          syncState: "synced" as const,
        }));
        for (const item of local) {
          if (remoteIds.has(item.id)) continue;
          // **已批准删除** ✓ —— 标记了待删除、且服务器上已经没有它 ✓ → 从本地移除 ✓
          // （未上传的 pendingDelete 不会走到这里 ✗，因为被直接删掉了 ✓）
          if (item.pendingDelete && item.syncState !== "local") continue;
          merged.push({
            ...item,
            syncState: submittedIdsRef.current.has(item.id) ? "pending" : "local",
          });
        }
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
        } catch {
          /* 忽略 ✓ */
        }
        return merged;
      });

      // 服务器空 → 首次迁移：把本地推上去 ✓
      if (remoteList.length === 0 && storedRef.current.length > 0) {
        saveUiStore("motion-actions", storedRef.current);
      }
    })();
    const unsubscribe = subscribeUiStore<MotionAction[]>("motion-actions", (remote) => {
      // 本端改过 → 只有一种情况可以覆盖：
      //   **服务器内容 === 我本地的内容** ✓ → 说明我的提交（审批）已经生效 ✓
      //   其他情况一律忽略 ✗（否则 pending 期间会被旧数据冲掉 ✗）
      const remoteList = Array.isArray(remote) ? migrateActions(remote).actions : [];
      const remoteIds = new Set(remoteList.map((item) => item.id));

      // 我提交的那条出现在服务器上了 → 审批通过 ✓ → 解锁 ✓
      if (localEditedRef.current) {
        const mine = remoteList.some((item) => submittedIdsRef.current.has(item.id) || remoteIds.has(item.id));
        if (!mine && JSON.stringify(remote) !== localJsonRef.current) return;
        localEditedRef.current = false;
      }

      syncedIdsRef.current = remoteIds;
      setActions((local) => {
        const merged: MotionAction[] = remoteList.map((item) => ({
          ...item,
          syncState: "synced" as const,
        }));
        for (const item of local) {
          if (remoteIds.has(item.id)) continue;
          if (item.pendingDelete && item.syncState !== "local") continue;   // 已批准删除 ✓
          merged.push({
            ...item,
            syncState: submittedIdsRef.current.has(item.id) ? "pending" : "local",
          });
        }
        return merged;
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        // ⚠ 再兜一层 ✗ —— `listModels()` 已归一化 ✓，但这条 state 直接进渲染 ✓，
        //   任何非数组进来都是 `s.find is not a function` 白屏 ✗
        const loaded = await listModels();
        setModels(Array.isArray(loaded) ? loaded : []);
      } catch {
        /* 忽略 ✓ */
      }
    })();
  }, []);

  const persist = useCallback((next: MotionAction[]) => {
    setActions(next);
    writeActions(next);
    localEditedRef.current = true;   // 改过就锁定 ✓（详见 localEditedRef 注释 ✓）
    localJsonRef.current = JSON.stringify(next);

    // 一改动就清掉「已驳回」标记 ✓ —— 那是"上一次"的结论 ✗
    if (rejectedIds.size > 0) {
      setRejectedIds(new Set());
      void clearRejections("motion-actions");
    }
  }, []);

  /**
   * **动作库的持久化** ✓ —— ⚠ 不能拿内存快照整体覆盖 ✗。
   *
   * 为什么 ✗：`persist(actions.map(...))` 里的 `actions` 是本卡片上次渲染的快照 ✓。
   * 播一个动作会顺手 `patchAction` 一次 ✓ → 把**整份快照**写回 storage ✗ →
   * 别处（另一台设备 / 之前的操作）刚算好的 `feasibility`、`plan.samples` 全被擦掉 ✗
   * → 策略时间线再到那段就报「采样点缺失」✗（本 bug ✓，= 用户说的"点位丢失"）。
   *
   * 正确做法：**读最新的 → 只改目标那一条 → 写回** ✓（和策略卡同一条教训 ✓）。
   */
  const patchAction = (id: string, changes: Partial<MotionAction>) => {
    const stored = readActions();
    // 存储里没有的新建动作（还没落盘）也要保住 ✓
    const base = stored.length === 0
      ? actions
      : [
          ...stored,
          ...actions.filter((item) => !stored.some((kept) => kept.id === item.id)),
        ];
    persist(
      base.map((item) => {
        if (item.id !== id) return item;
        const next = { ...item, ...changes };
        // **记录点 / 容差变了 → 可行性缓存作废** ✓
        //（点数相同但位置变了也要作废 ✗ —— 光靠 pointCount 不够 ✓）
        if ("points" in changes || "toleranceMm" in changes) {
          next.feasibility = null;
          next.plan = null;
        }
        return next;
      }),
    );
  };

  const createAction = () => {
    const action: MotionAction = {
      id: `action-${Date.now()}`,
      name: `动作${actions.length + 1}`,
      modelId: models.find((m) => m.selected)?.id ?? models[0]?.id ?? "",
      points: [],
      pointsFrame: "three",
      syncState: "local",
      toleranceMm: 2,
      createdAt: new Date().toISOString().slice(0, 10),
      note: "",
      plan: null,
    };
    persist([...actions, action]);
    setOpenId(action.id);
    clearPoints();
  };

  const removeAction = (id: string) => {
    const target = actions.find((item) => item.id === id);
    if (!target) return;
    if (!window.confirm(`删除「${target.name}」？它的 ${target.points.length} 个记录点会一并删除。`)) return;
    persist(actions.filter((item) => item.id !== id));
    if (openId === id) {
      setOpenId(null);
      setRecording(false);
    }
  };

  const renameAction = (id: string, name: string) => {
    const trimmed = name.trim();
    setRenamingId(null);
    if (!trimmed) return;
    patchAction(id, { name: trimmed });
  };

  /** 进动作时把草稿清干净 ✓（避免上一个动作的点串进来 ✗）*/
  const enterAction = (id: string) => {
    clearPoints();
    setRecording(false);
    setOpenId(id);
  };

  const checkFeasibility = (action: MotionAction) => {
    setChecking(action.id);
    try {
      const results = planForAllModels(action.points, models, action.toleranceMm);
      setPlans((prev) => ({ ...prev, [action.id]: results }));
      const feasible = results.filter((item) => item.ok);
      patchAction(action.id, {
        // **整批缓存** ✓（按容差 + 点数校验 ✓）
        feasibility: {
          toleranceMm: action.toleranceMm,
          pointCount: action.points.length,
          models: results.map((item) => ({
            modelId: item.modelId,
            modelName: item.modelName,
            ok: item.ok,
            durationMs: item.durationMs,
            maxDeviationMm: item.maxDeviationMm,
            samples: item.ok
              ? item.samples.map((sample) => ({
                  kx: sample.kx,
                  ky: sample.ky,
                  x: sample.x,
                  y: sample.y,
                  z: sample.z,
                }))
              : undefined,
            reason: item.ok ? undefined : item.messages.filter((m) => m.startsWith("⚠")).join("；"),
          })),
        },
        plan: {
          durationMs: feasible[0]?.durationMs ?? 0,
          maxDeviationMm: feasible[0]?.maxDeviationMm ?? 0,
          feasible: feasible.length > 0,
          modelId: feasible[0]?.modelId,
          modelName: feasible[0]?.modelName,
          samples: feasible[0]?.samples.map((sample) => ({
            kx: sample.kx,
            ky: sample.ky,
            x: sample.x,
            y: sample.y,
            z: sample.z,
          })),
        },
      });
    } finally {
      setChecking(null);
    }
  };

  /** 可行性缓存是否**仍然有效** ✓（容差 / 点数都没变 ✓）*/
  const isFeasibilityFresh = (action: MotionAction): boolean =>
    Boolean(
      action.feasibility &&
        action.feasibility.toleranceMm === action.toleranceMm &&
        action.feasibility.pointCount === action.points.length,
    );

  /**
   * 播放源 ✓。
   * ① 优先用**刚算出来的**内存结果 ✓
   * ② 没有就用**动作里存着的**（上次可行性检查的结果 ✓）—— 不用重新检查 ✗
   */
  /**
   * **优先用当前选中的模型** ✓ —— 原来取"第一个可行的"✗，
   * 结果：切到新模型后播放仍用旧模型 ✗（本 bug ✓）。
   */
  const selectedModelId = models.find((model) => model.selected)?.id ?? null;
  const preferSelected = <T extends { modelId: string; ok: boolean }>(list: T[]): T | undefined =>
    list.find((item) => item.ok && item.modelId === selectedModelId) ??
    list.find((item) => item.ok);

  const playableResult = openAction
    ? (() => {
        const fromPlans = preferSelected(plans[openAction.id] ?? []);
        if (fromPlans && fromPlans.samples.length > 0) return fromPlans;
        if (!isFeasibilityFresh(openAction)) return null;
        const modelsList = openAction.feasibility?.models ?? [];
        const hit =
          modelsList.find((m) => m.ok && m.samples?.length && m.modelId === selectedModelId) ??
          modelsList.find((m) => m.ok && m.samples?.length);
        return hit
          ? {
              modelId: hit.modelId,
              modelName: hit.modelName,
              durationMs: hit.durationMs,
              maxDeviationMm: hit.maxDeviationMm,
              samples: hit.samples!,
              ok: true as const,
            }
          : null;
      })()
    : null;

  // ── 视图 A：动作列表 ✓ ─────────────────────────────────────
  if (!openAction) {
    return (
      <div className="motion-card">
        <div className="motion-toolbar">
          <button type="button" className="ghost-btn" onClick={createAction}>
            <Plus size={14} />
            <span>新建动作</span>
          </button>
          <span className="policy-hint">{actions.length} 个动作</span>
          <button
            type="button"
            className="ghost-btn"
            onClick={() => {
              void (async () => {
                // **按角色决定发什么** ✓：
                //   管理员 → 直传正式数据 ✓，待删除的**必须剔除** ✗（否则又被写回去 ✓）
                //   操作员 → 提交审批 ✓，待删除的**要带上** ✓（否则审批界面看不到 ✓）
                const payload = canWriteDirectly()
                  ? actions.filter((item) => !item.pendingDelete)
                  : actions;
                const result = await uploadUiStoreNow("motion-actions", payload);
                if (result === "direct") {
                  // 直传成功 → **立即回读服务器** ✓ 并解除本地锁 ✓
                  // （之前靠独立的"从服务器刷新"按钮 ✗，现在上传自带刷新 ✓）
                  const remote = await loadUiStore<MotionAction[]>("motion-actions");
                  // ⚠ 服务器返回的数据**没有 syncState** ✗ ——
                  //   直接覆盖会让徽标退回"未上传"✗（和策略卡同一个坑 ✓）。
                  setActions((prev) => {
                    const base = Array.isArray(remote) && remote.length > 0
                      ? migrateActions(remote).actions
                      : prev;
                    syncedIdsRef.current = new Set(base.map((item) => item.id));
                    return base.map((item) => ({ ...item, syncState: "synced" as const }));
                  });
                  localEditedRef.current = false;
                  setUploadNotice("已上传 ✓ 其他设备 5 秒内可见");
                } else if (result === "pending") {
                  // 本地全部标"待审批" ✓（服务器已有的保持"已同步"✓）
                  setActions((list) => {
                    // ⚠ 不要再按 `syncedIdsRef` 跳过 ✗ ——
                    //   它表示"服务器上有这个动作"✓，不是"内容已同步"✗（策略卡踩过 ✓）。
                    for (const item of list) submittedIdsRef.current.add(item.id);
                    return list.map((item) => ({ ...item, syncState: "pending" as const }));
                  });
                  setUploadNotice("已提交审批 ✓ 管理员批准后生效");
                } else {
                  setUploadNotice("上传失败，请重试");
                }
                window.setTimeout(() => setUploadNotice(null), 6000);
              })();
            }}
            title="立即把本地数据写到服务器 ✓（不等去抖 ✓）"
          >
            立即上传
          </button>
          {uploadNotice ? <span className="policy-hint">{uploadNotice}</span> : null}

        </div>

        {actions.length === 0 ? (
          <p className="policy-empty">还没有动作。</p>
        ) : (
          <ul className="motion-list">
            {actions.map((action) => (
              <li
                key={action.id}
                className={`motion-item${action.pendingDelete ? " is-pending-delete" : ""}`}
              >
                {renamingId === action.id ? (
                  <input
                    className="policy-scheme-input"
                    autoFocus
                    value={nameDraft}
                    onChange={(event) => setNameDraft(event.target.value)}
                    onBlur={() => renameAction(action.id, nameDraft)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") renameAction(action.id, nameDraft);
                      if (event.key === "Escape") setRenamingId(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="motion-item-main motion-open"
                    onClick={() => enterAction(action.id)}
                    title="点击进入编排"
                  >
                    <span className="motion-item-name">
                      {action.name}
                      {rejectedIds.has(action.id) ? (
                        <em className="motion-badge is-rejected" title="管理员驳回了这次改动">
                          已驳回
                        </em>
                      ) : action.pendingDelete ? (
                        <em className="motion-badge is-delete" title="已标记删除，等待管理员审批">
                          待删除
                        </em>
                      ) : action.syncState === "local" ? (
                        <em className="motion-badge is-local" title="只在本地，还没上传">未上传</em>
                      ) : action.syncState === "pending" ? (
                        <em className="motion-badge is-pending" title="已提交审批，等待管理员批准">待审批</em>
                      ) : action.syncState === "synced" ? (
                        <em className="motion-badge is-synced" title="服务器上已生效，所有设备可见">已同步</em>
                      ) : null}
                    </span>
                    <span className="motion-item-meta">
                      {action.points.length} 点 · {models.find((m) => m.id === action.modelId)?.name ?? "未绑定模型"} · 容差 {action.toleranceMm}mm · {action.createdAt}
                      {action.plan
                        ? action.plan.feasible
                          ? " · ✓ 有可行模型"
                          : " · ⚠ 全部不可行"
                        : ""}
                    </span>
                  </button>
                )}
                <div className="motion-item-actions">
                  {/* 重命名用独立按钮 ✓（双击在"单击会导航"的列表项上不可能生效 ✗）*/}
                  <button
                    type="button"
                    className="policy-delete"
                    style={{ color: "var(--text-secondary)" }}
                    onClick={() => {
                      setNameDraft(action.name);
                      setRenamingId(action.id);
                    }}
                    title="重命名动作"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    className="policy-delete"
                    onClick={() => {
                      if (action.pendingDelete) {
                        // 已标记 → 撤销 ✓
                        patchAction(action.id, { pendingDelete: false });
                        return;
                      }
                      // **被驳回的不算"已生效"** ✓ —— 服务器上没有它的新内容 ✓，
                      // 直接删就行 ✗（不用再走一遍审批 ✓）。
                      const rejected = rejectedIds.has(action.id);
                      const approved = action.syncState === "synced" && !rejected;
                      if (
                        !window.confirm(
                          approved
                            ? `「${action.name}」已在服务器生效 ✓。\n提交删除后需要管理员审批 ✓，批准后其他设备将看不到它 ✗。`
                            : `删除「${action.name}」？`,
                        )
                      ) {
                        return;
                      }
                      if (approved) {
                        // **管理员直删** ✓（不需要审批 ✓）
                        if (canWriteDirectly()) {
                          removeAction(action.id);   // 先从本地移除 ✓
                          void (async () => {
                            const remaining = actions.filter((item) => item.id !== action.id);
                            const result = await uploadUiStoreNow("motion-actions", remaining);
                            setUploadNotice(
                              result === "direct"
                                ? "已删除 ✓ 其他设备 5 秒内同步"
                                : "已提交删除申请 ✓ 等待管理员审批",
                            );
                            window.setTimeout(() => setUploadNotice(null), 6000);
                          })();
                          return;
                        }
                        // 非管理员 → **标记待删除** ✓（等审批 ✓）
                        patchAction(action.id, { pendingDelete: true });
                        setUploadNotice("已标记删除 ✓ 点「立即上传」提交审批");
                        window.setTimeout(() => setUploadNotice(null), 6000);
                      } else {
                        // 新的 / 待审批的 → 直接删 ✓（服务器本来就没有 ✓）
                        removeAction(action.id);
                      }
                    }}
                    title={action.pendingDelete ? "撤销删除" : "删除动作"}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // ── 视图 B：某个动作的编排 ✓ ───────────────────────────────
  const inSync = draft.points.length !== openAction.points.length;
  return (
    <div className="motion-card">
      <div className="motion-toolbar">
        <button
          type="button"
          className="ghost-btn"
          onClick={() => {
            setRecording(false);
            setOpenId(null);
            clearPoints();
          }}
        >
          <ChevronLeft size={14} />
          <span>动作列表</span>
        </button>
        <span className="policy-crumb">
          动作 / <b>{openAction.name}</b>
        </span>
      </div>

      <div className="motion-toolbar">
        <button
          type="button"
          className={`motion-record-btn${draft.recording ? " is-on" : ""}`}
          onClick={() => setRecording(!draft.recording)}
          title={draft.recording ? "停止记录" : "开始记录（拖动手柄，每 2mm 记一点）"}
        >
          {draft.recording ? <Square size={13} /> : <Circle size={13} />}
          <span>{draft.recording ? "停止" : "记录"}</span>
        </button>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => recordCurrentPoint()}
          disabled={!draft.live}
          title="把当前末端位置记为一个点"
        >
          <CircleDot size={13} />
          <span>记一点</span>
        </button>
        <span className="motion-count">{draft.points.length} 点</span>
        {draft.points.length > 0 ? (
          <button type="button" className="policy-delete" onClick={() => clearPoints()} title="清空">
            <Trash2 size={13} />
          </button>
        ) : null}
      </div>

      {draft.live ? (
        <p className="motion-live">
          当前末端：
          <b>
            {draft.live.x.toFixed(0)}, {draft.live.y.toFixed(0)}, {draft.live.z.toFixed(0)}
          </b>
          mm
        </p>
      ) : (
        <p className="motion-live">在「臂体控制」里拖动手柄。</p>
      )}

      {draft.points.length > 0 ? (
        <ol className="motion-points">
          {draft.points.map((point, index) => (
            <li key={`${point.index}-${index}`}>
              <span className="motion-point-index">{index + 1}</span>
              <span className="motion-point-xyz">
                {point.x.toFixed(0)}, {point.y.toFixed(0)}, {point.z.toFixed(0)}
              </span>
              <button
                type="button"
                className="motion-point-remove"
                onClick={() => removePoint(index)}
                title="删除这个点"
              >
                ×
              </button>
            </li>
          ))}
        </ol>
      ) : null}

      <div className="motion-save">
        <label className="motion-tolerance">
          <span>模型</span>
          <select
            value={openAction.modelId}
            onChange={(event) => patchAction(openAction.id, { modelId: event.target.value })}
            title="这个动作参照的模型（可行性检查仍会遍历全部模型 ✓）"
          >
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>
        </label>
        <label className="motion-tolerance">
          <span>容差</span>
          <input
            type="number"
            step="0.5"
            min="0.5"
            value={openAction.toleranceMm}
            onChange={(event) => patchAction(openAction.id, { toleranceMm: Number(event.target.value) })}
          />
          <span>mm</span>
        </label>
        <button
          type="button"
          className="ghost-btn"
          disabled={draft.points.length < 2 || !inSync}
          onClick={() => patchAction(openAction.id, { points: draft.points, plan: null })}
          title={inSync ? "把草稿点写入动作" : "已经同步"}
        >
          {inSync ? "写入动作" : "已同步"}
        </button>
        <button
          type="button"
          className="ghost-btn"
          disabled={openAction.points.length < 2 || checking === openAction.id}
          onClick={() => checkFeasibility(openAction)}
        >
          <Play size={13} />
          <span>{checking === openAction.id ? "检查中…" : "可行性"}</span>
        </button>
        <button
          type="button"
          className="ghost-btn"
          disabled={openAction.points.length < 2 || checking === openAction.id}
          onClick={() => {
            /**
             * ⚠ **策略时间线在跑就别抢播放** ✗ —— 允许抢的后果（本 bug ✓）：
             *   ① 时间线那个播放实例被顶掉 ✓ → 它结束时**跳过清理** ✗；
             *   ② 动作库这次播完会清掉注入 / 位移表 ✗ → 时间线下一段
             *      拿不到采样点与形状 ✓ → "点位丢失、动作不执行"✗。
             * 现在直接拒绝并说明原因 ✓，用户知道该先关引擎 ✓。
             */
            if (hasCurrentPlayback() && getPlaybackOwner() === "policy") {
              setPlayNotice("策略正在执行时间线：先关掉策略引擎（或等这一段跑完）再手动播放");
              window.setTimeout(() => setPlayNotice(null), 6000);
              return;
            }
            // **缓存过期就自动算一次** ✓ —— 用户不用手动点「可行性」✗
            let playSource = playableResult;
            if (!playSource) {
              const results = planForAllModels(openAction.points, models, openAction.toleranceMm);
              setPlans((prev) => ({ ...prev, [openAction.id]: results }));
              const feasible = results.find((item) => item.ok && item.samples.length > 0);
              if (!feasible) {
                setPlayNotice("没有可行模型 —— 这条轨迹当前所有模型都走不了 ✗");
                window.setTimeout(() => setPlayNotice(null), 8000);
                return;
              }
              patchAction(openAction.id, {
                feasibility: {
                  toleranceMm: openAction.toleranceMm,
                  pointCount: openAction.points.length,
                  models: results.map((item) => ({
                    modelId: item.modelId,
                    modelName: item.modelName,
                    ok: item.ok,
                    durationMs: item.durationMs,
                    maxDeviationMm: item.maxDeviationMm,
                    samples: item.ok
                      ? item.samples.map((sample) => ({
                          kx: sample.kx,
                          ky: sample.ky,
                          x: sample.x,
                          y: sample.y,
                          z: sample.z,
                        }))
                      : undefined,
                    reason: item.ok
                      ? undefined
                      : item.messages.filter((m) => m.startsWith("⚠")).join("；"),
                  })),
                },
              });
              playSource = {
                modelId: feasible.modelId,
                modelName: feasible.modelName,
                durationMs: feasible.durationMs,
                maxDeviationMm: feasible.maxDeviationMm,
                samples: feasible.samples,
                ok: true,
              };
            }
            const play = playSource;
            const model = models.find((m) => m.id === play.modelId);
            const request: PlayRequest = {
              actionId: openAction.id,
              actionName: openAction.name,
              modelId: play.modelId,
              modelName: play.modelName,
              durationMs: play.durationMs,
              samples: play.samples.map((sample) => ({
                kx: sample.kx,
                ky: sample.ky,
                x: sample.x,
                y: sample.y,
                z: sample.z,
              })),
              totalLengthMm: model?.totalLengthMm ?? model?.params?.lengthMm ?? 400,
              requestedAt: Date.now(),
            };
            try {
              window.localStorage.setItem(PLAY_REQUEST_KEY, JSON.stringify(request));
              setPlayNotice(
                `已发送播放请求（${play.modelName}，${(play.durationMs / 1000).toFixed(1)}s）→ 切到「控制」页签看 3D`,
              );
              window.setTimeout(() => setPlayNotice(null), 8000);
            } catch (error) {
              setPlayNotice(`发送失败：${String(error)}`);
            }
          }}
          title={playableResult ? "按规划结果驱动 3D 预览" : "先做一次可行性检查（需要至少一个可行模型）"}
        >
          <Play size={13} />
          <span>播放</span>
        </button>
        {/* **暂停/继续** ✓ —— 紧跟「播放」✓，和控制页同源 ✓ */}
        <button
          type="button"
          className="ghost-btn"
          disabled={!playbackOn}
          onClick={() => {
            const before = isCurrentPlaybackPaused();
            const hit = before ? resumeCurrentPlayback() : pauseCurrentPlayback();
            console.log("[pause]", { before, hit, after: isCurrentPlaybackPaused(), has: hasCurrentPlayback() });
          }}
          title={playbackOn ? "暂停 / 继续当前播放" : "当前没有在播放的动作"}
        >
          {playbackPaused ? <Play size={13} /> : <Pause size={13} />}
          <span>{playbackPaused ? "继续" : "暂停"}</span>
        </button>
      </div>

      {playNotice ? <p className="motion-play-notice">{playNotice}</p> : null}

      {plans[openAction.id] ? (
        <ul className="motion-feasibility">
          {plans[openAction.id].map((item) => (
            <li key={item.modelId} className={item.ok ? "is-ok" : "is-warn"}>
              <span>{item.ok ? "✓" : "⚠"}</span>
              <b>{item.modelName}</b>
              <span className="motion-feasibility-meta">
                {item.ok
                  ? `偏差 ${item.maxDeviationMm.toFixed(1)}mm · ${item.durationMs}ms`
                  : item.messages.filter((m) => m.startsWith("⚠")).join("；") || "不可行"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
