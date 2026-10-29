/**
 * 策略执行引擎 ✓ —— 只跑**当前生效方案**里启用的规则 ✓。
 *
 * 分两块：
 *  1. **求值**（本文件）：给定"上一刻/此刻"的实时数据，判断哪些规则命中 ✓
 *  2. **执行**（WorkspacePage 里的 hook）：命中后切模型 / 跑动作 ✓
 *
 * 为什么求值和执行分开 ✗：求值是**纯函数** ✓，可以单元测试、可以在没有硬件时
 * 用假数据驱动 ✓；执行才依赖网络和 3D 场景 ✓。
 */

export interface PolicyRuleLike {
  id: string;
  enabled: boolean;
  trigger: "tension-spike" | "interval";
  thresholdN: number;
  windowMs: number;
  intervalMin: number;
  targetModelId: string;
  targetActionId?: string;
  targetKind?: "model" | "action";
  note: string;
}

export interface PolicySchemeLike {
  id: string;
  name: string;
  rules: PolicyRuleLike[];
  /** 时间线 ✓（没有就不是新格式 ✓）*/
  timeline?: Array<{
    id: string;
    kind: "action" | "switch-model" | "wait";
    actionId?: string;
    modelId?: string;
    durationSec: number;
    note: string;
  }>;
}

export interface PolicyStoreLike {
  schemes: PolicySchemeLike[];
  activeId: string;
}

export interface PolicyHit {
  schemeName: string;
  rule: PolicyRuleLike;
  /** 命中的原因（写日志用 ✓）*/
  reason: string;
}

/** 定时规则的"上次触发时间"✓（按 rule.id 记 ✓）*/
export type IntervalMarks = Record<string, number>;

/**
 * 定时规则求值 ✓。
 *
 * 用**绝对时间戳**而不是 `setInterval` ✗：页面切走再回来时，
 * `setInterval` 会漏掉中间的时间 ✓，而时间戳比较能立刻补上 ✓。
 */
export function evaluateIntervalRules(
  store: PolicyStoreLike,
  nowMs: number,
  marks: IntervalMarks,
): { hits: PolicyHit[]; nextMarks: IntervalMarks } {
  const scheme = store.schemes.find((item) => item.id === store.activeId);
  if (!scheme) return { hits: [], nextMarks: marks };

  const hits: PolicyHit[] = [];
  const nextMarks: IntervalMarks = { ...marks };

  for (const rule of scheme.rules) {
    if (!rule.enabled || rule.trigger !== "interval") continue;
    const periodMs = Math.max(1, rule.intervalMin) * 60_000;
    const last = nextMarks[rule.id];
    // 第一次见到这条规则：只记时间，**不立刻触发** ✗（否则一进页面就乱跑 ✗）
    if (last === undefined) {
      nextMarks[rule.id] = nowMs;
      continue;
    }
    if (nowMs - last >= periodMs) {
      nextMarks[rule.id] = nowMs;
      hits.push({
        schemeName: scheme.name,
        rule,
        reason: `定时 ${rule.intervalMin} 分钟到点`,
      });
    }
  }
  return { hits, nextMarks };
}

/** 张力陡增的历史窗口 ✓（每个规则独立 ✓）*/
export type TensionHistory = Record<string, Array<{ at: number; n: number }>>;

/**
 * 张力陡增规则求值 ✓。
 *
 * 判据：**窗口内最大值 − 最小值 ≥ thresholdN** ✓（而不是"和窗口起点比"✗ ——
 * 后者对缓慢爬升不敏感 ✗，对一次尖峰才敏感 ✓）。
 */
export function evaluateTensionRules(
  store: PolicyStoreLike,
  nowMs: number,
  tipForceN: number | null,
  history: TensionHistory,
): { hits: PolicyHit[]; nextHistory: TensionHistory } {
  const scheme = store.schemes.find((item) => item.id === store.activeId);
  if (!scheme) return { hits: [], nextHistory: history };

  const hits: PolicyHit[] = [];
  const nextHistory: TensionHistory = { ...history };

  for (const rule of scheme.rules) {
    if (!rule.enabled || rule.trigger !== "tension-spike") continue;
    const windowMs = Math.max(200, rule.windowMs);
    const previous = nextHistory[rule.id] ?? [];

    if (tipForceN === null) {
      // 没有实时数据：只保留窗口结构 ✓，不清空（否则每帧重建 ✗）
      nextHistory[rule.id] = previous.filter((sample) => nowMs - sample.at <= windowMs);
      continue;
    }

    const series = [...previous.filter((sample) => nowMs - sample.at <= windowMs), { at: nowMs, n: tipForceN }];
    nextHistory[rule.id] = series;

    if (series.length < 3) continue;
    const values = series.map((sample) => sample.n);
    const rise = Math.max(...values) - Math.min(...values);
    if (rise >= rule.thresholdN) {
      hits.push({
        schemeName: scheme.name,
        rule,
        reason: `张力在 ${(windowMs / 1000).toFixed(1)}s 内变化 ${rise.toFixed(1)}N（阈值 ${rule.thresholdN}N）`,
      });
      // 触发后清空窗口 ✓ —— 否则同一次陡增会连发 ✗
      nextHistory[rule.id] = [];
    }
  }
  return { hits, nextHistory };
}

/** 日志条目 ✓ */
export interface PolicyLogEntry {
  id: string;
  at: string;
  schemeName: string;
  ruleNote: string;
  reason: string;
  target: string;
  ok: boolean;
  error?: string;
}

export const POLICY_LOG_KEY = "softui:policyLog";
/** 引擎总开关的存储键 ✓（卡片里勾 ↑，WorkspacePage 读 ↓）*/
export const POLICY_ENGINE_KEY = "softui:policyEngine";

export function readEngineEnabled(): boolean {
  try {
    return window.localStorage.getItem(POLICY_ENGINE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeEngineEnabled(enabled: boolean) {
  try {
    window.localStorage.setItem(POLICY_ENGINE_KEY, enabled ? "1" : "0");
  } catch {
    /* 忽略 ✓ */
  }
}
const MAX_LOG = 200;

export function readPolicyLog(): PolicyLogEntry[] {
  try {
    const raw = window.localStorage.getItem(POLICY_LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PolicyLogEntry[]) : [];
  } catch {
    return [];
  }
}

export function appendPolicyLog(entry: PolicyLogEntry): PolicyLogEntry[] {
  const next = [entry, ...readPolicyLog()].slice(0, MAX_LOG);
  try {
    window.localStorage.setItem(POLICY_LOG_KEY, JSON.stringify(next));
  } catch {
    /* 忽略 ✓ */
  }
  // **同步到后端** ✓ —— 这样手机也能看到电脑跑的策略日志 ✓
  void import("./uiStore").then(({ saveUiStore }) => saveUiStore("policy-log", next));
  return next;
}

/**
 * **按日期批量删除** ✓ —— 删掉某个日期之前的日志 ✓。
 *
 * @param beforeIso 例如 `"2026-10-20"` ✓ —— 早于这天的全删 ✓；不传 = 全删 ✓
 */
export function clearPolicyLogBefore(beforeIso?: string): PolicyLogEntry[] {
  const all = readPolicyLog();
  const keep = beforeIso ? all.filter((entry) => entry.at.slice(0, 10) >= beforeIso) : [];
  try {
    window.localStorage.setItem(POLICY_LOG_KEY, JSON.stringify(keep));
  } catch {
    /* 忽略 ✓ */
  }
  void import("./uiStore").then(({ saveUiStore }) => saveUiStore("policy-log", keep));
  return keep;
}

export function clearPolicyLog() {
  try {
    window.localStorage.removeItem(POLICY_LOG_KEY);
  } catch {
    /* 忽略 ✓ */
  }
  void import("./uiStore").then(({ saveUiStore }) => saveUiStore("policy-log", []));
}

/**
 * 从实时快照估算"尖端力"✓。
 *
 * `RuntimeSnapshot` 里**没有直接的尖端力**✗ —— 只有 6 路传感器的 `filteredValue` ✓。
 * 这里用**传感器均值**作为合成指标 ✓：
 *  - 均值比最大值稳 ✓（单路毛刺不触发 ✗）
 *  - 比总和更不受"传感器数量变化"影响 ✓
 *
 * ⚠ 单位按 `sensor.unit` 原样使用 ✗（不做换算 ✓）—— 规则里的阈值要按同样单位填 ✓。
 * 以后有了真正的力传感器（N）✓ 可以直接把阈值改成 N ✓。
 */
export function tipForceFromSensors(sensors: Array<{ filteredValue: number; quality?: string }>): number | null {
  const usable = sensors.filter(
    (sensor) => Number.isFinite(sensor.filteredValue) && sensor.quality !== "bad" && sensor.quality !== "stale",
  );
  if (usable.length === 0) return null;
  const sum = usable.reduce((total, sensor) => total + sensor.filteredValue, 0);
  return sum / usable.length;
}
