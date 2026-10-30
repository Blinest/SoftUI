import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown } from "lucide-react";
import uPlot from "uplot";
import { hasLocalPort } from "./robot/directDispatch";
import "uplot/dist/uPlot.min.css";
import { ChartLayout } from "./layouts/ChartLayout";
import { ChannelSidebar } from "./components/layout/ResponsiveRail";
import { ChartToolbar } from "./components/ChartToolbar";
import { hasPermission } from "./state/permissions";
import { chartsToCsv, downloadText, exportStamp } from "./utils/download";
import { curvatureDistributionFromSnapshot, summarizeBackbone, buildBackboneFromCurvatureDistribution } from "./dynamics/svcModel";
import type { ChartSection, DeviceSnapshot, RuntimeSnapshot, SessionInfo } from "./softuiTypes";
import { getTargetHistory } from "./robot/previewOverride";
import "./styles/charts.css";

type ChartKind =
  | "velocity"
  | "acceleration"
  | "curvature"
  | "tracking"
  | "trackingError"
  | "sensorX"
  | "sensorY"
  | "sensorZ";

interface ChartPanelConfig {
  key: ChartKind;
  title: string;
  unit: string;
  match: (name: string, channelType: string) => boolean;
  /** 按**通道序号**上色 ✓ —— 合并图里"实际 M1"和"理论 M1"必须同色 ✓ */
  colorByChannelIndex?: boolean;
}

interface CursorReadout {
  time: number;
  values: Array<{ name: string; color: string; value: number | null; unit: string }>;
}

const CHARTS: ChartPanelConfig[] = [
  {
    // **实际 + 理论合并** ✓ —— 实际实线、理论虚线、同色同轴 ✓
    key: "tracking",
    title: "电机位移曲线",
    unit: "mm",
    colorByChannelIndex: true,
    /**
     * ⚠ 也要收下 `Motor N pos` ✗ —— 纯实际位移图**已删** ✓（被本图取代 ✓），
     * 若这里不匹配 ✓，侧栏那些通道会变成"没有归属的图"✗（点勾选没地方去 ✓）。
     */
    match: (name, type) =>
      type === "trackA" || type === "trackT" || (type === "motor" && name.endsWith(" pos")),
  },
  {
    // **跟踪误差** ✓ —— 实际 − 理论，用来找规律（恒定滞后？随速度变大？）
    key: "trackingError",
    title: "电机跟踪误差",
    unit: "mm",
    colorByChannelIndex: true,
    match: (_name, type) => type === "trackErr",
  },
  {
    // **实际 + 理论合并** ✓（实际实线 ✓ 理论虚线 ✓ 同色 ✓）
    key: "velocity",
    title: "电机速度曲线",
    unit: "mm/s",
    colorByChannelIndex: true,
    match: (name, type) =>
      type === "velA" || type === "velT" || (type === "motor" && name.endsWith(" vel")),
  },
  { key: "acceleration", title: "电机加速度曲线", unit: "mm/s²", match: (name, type) => type === "motor" && name.endsWith(" acc") },
  { key: "curvature", title: "曲率分布时间曲线", unit: "1/m", match: (_name, type) => type === "curvature" },
  { key: "sensorX", title: "传感器 X 轴曲线", unit: "N", match: (name, type) => type === "sensor" && name.endsWith(" X") },
  { key: "sensorY", title: "传感器 Y 轴曲线", unit: "N", match: (name, type) => type === "sensor" && name.endsWith(" Y") },
  { key: "sensorZ", title: "传感器 Z 轴曲线", unit: "N", match: (name, type) => type === "sensor" && name.endsWith(" Z") },
];

const COLORS = ["#4fc3f7", "#81c784", "#ffb74d", "#f06292", "#ba68c8", "#4dd0e1", "#aed581", "#ff8a65", "#9575cd", "#4db6ac", "#dce775", "#e57373", "#90a4ae", "#7986cb", "#64b5f6", "#a1887f", "#ffcc80", "#b39ddb"];
const MAX_RENDER_POINTS = 240;

function downsampleFrames(frames: DeviceSnapshot[], maxPoints: number) {
  if (frames.length <= maxPoints) return frames;
  const step = Math.max(1, Math.ceil(frames.length / maxPoints));
  return frames.filter((_, index) => index % step === 0);
}

function chartsFromFrames(frames: DeviceSnapshot[]): ChartSection | null {
  const ordered = downsampleFrames(frames, MAX_RENDER_POINTS);
  const first = ordered[0];
  if (!first) return null;
  const timestamps = ordered.map((frame) => frame.receivedAtMs / 1000);
  const channels: ChartSection["channels"] = [];

  for (const motor of first.motors) {
    channels.push({ name: `Motor ${motor.id} pos`, unit: "mm", channelType: "motor", channelIndex: motor.id, points: ordered.map((frame) => frame.motors.find((item) => item.id === motor.id)?.positionMm ?? 0) });
    channels.push({ name: `Motor ${motor.id} vel`, unit: "mm/s", channelType: "motor", channelIndex: motor.id, points: ordered.map((frame) => frame.motors.find((item) => item.id === motor.id)?.velocityMmPerSec ?? 0) });
    channels.push({ name: `Motor ${motor.id} acc`, unit: "mm/s²", channelType: "motor", channelIndex: motor.id, points: ordered.map((frame) => frame.motors.find((item) => item.id === motor.id)?.accelerationMmPerSec2 ?? 0) });
  }

  const distributions = ordered.map((frame) => curvatureDistributionFromSnapshot(frame, { basisSegmentCount: 12 }));
  const summaries = distributions.map((distribution) => summarizeBackbone(buildBackboneFromCurvatureDistribution(distribution)));
  const basisCount = distributions[0]?.basisSegmentCount ?? 0;
  for (let index = 0; index < basisCount; index += 1) {
    channels.push({
      name: `κ ${String(index + 1).padStart(2, "0")}`,
      unit: "1/m",
      channelType: "curvature",
      channelIndex: index + 1,
      points: distributions.map((distribution) => distribution.segments[index]?.kappaAbsPerM ?? 0),
    });
  }
  channels.push({ name: "κ max", unit: "1/m", channelType: "curvature", channelIndex: basisCount + 1, points: summaries.map((summary) => summary.maxKappaPerM) });
  channels.push({ name: "κ mean", unit: "1/m", channelType: "curvature", channelIndex: basisCount + 2, points: summaries.map((summary) => summary.meanKappaPerM) });

  // 一路张力通道 = 一条曲线（旧的「每路三轴」已经不存在了）。
  for (const sensor of first.sensors) {
    channels.push({
      name: `张力通道 ${sensor.id}`,
      unit: sensor.unit,
      channelType: "sensor",
      channelIndex: sensor.id,
      points: ordered.map((frame) => frame.sensors.find((item) => item.id === sensor.id)?.filteredValue ?? 0),
    });
  }

  return { windowSize: ordered.length, timestamps, channels };
}

/**
 * **目标位移 / 速度 —— 独立一套时间轴** ✓。
 *
 * 为什么必须独立 ✗：图表的 x 轴是**快照帧**（100ms ✓），而目标数据有自己的
 * 采样时刻（80ms ✓）✗ —— 塞进同一个 x 轴，**x 和 y 永远对不准** ✗
 * （同一个横坐标的纵坐标会随时间变化 ✗，这就是"错位"的本质 ✓）。
 *
 * 这里让目标曲线**自带 timestamps** ✓ → x 和 y 同源 ✓ → 严格一一对应 ✓。
 */
function targetCharts(): ChartSection | null {
  const history = getTargetHistory();
  if (history.length < 2) return null;
  const timestamps = history.map((item) => item.at / 1000);
  const channels: ChartSection["channels"] = [];

  for (let index = 0; index < 6; index += 1) {
    const series = history.map((item) => item.values[index] ?? 0);

    // **中值 + 平均** ✓（去孤立跳变 ✓，抹圆台阶 ✓）
    const raw = series.slice();
    const medianed = series.slice();
    for (let at = 0; at < medianed.length; at += 1) {
      let lo = at - 2;
      let hi = at + 2;
      if (lo < 0) { hi = Math.min(raw.length - 1, hi + (0 - lo)); lo = 0; }
      if (hi > raw.length - 1) { lo = Math.max(0, lo - (hi - (raw.length - 1))); hi = raw.length - 1; }
      const window = raw.slice(lo, hi + 1).sort((a, b) => a - b);
      medianed[at] = window[Math.floor(window.length / 2)];
    }
    const smooth = medianed.slice();
    // **3 遍** ✓ —— 原来 2 遍压不住 1.6mm 的阶跃 ✗（→ 20mm/s 峰值 ✗）
    for (let pass = 0; pass < 3; pass += 1) {
      for (let at = 0; at < smooth.length; at += 1) {
        let lo = at - 2;
        let hi = at + 2;
        if (lo < 0) { hi = Math.min(smooth.length - 1, hi + (0 - lo)); lo = 0; }
        if (hi > smooth.length - 1) { lo = Math.max(0, lo - (hi - (smooth.length - 1))); hi = smooth.length - 1; }
        let sum = 0;
        for (let k = lo; k <= hi; k += 1) sum += smooth[k];
        smooth[at] = sum / (hi - lo + 1);
      }
    }

    channels.push({
      name: `目标 M${index + 1}`,
      unit: "mm",
      channelType: "target",
      channelIndex: index + 1,
      points: series,
    });

    // **速度 = 平滑位移的差分** ✓
    const velocity: number[] = [];
    for (let at = 0; at < smooth.length; at += 1) {
      if (at === 0) { velocity.push(0); continue; }
      const dt = (history[at].at - history[at - 1].at) / 1000;
      if (!Number.isFinite(dt) || dt < 0.005) { velocity.push(velocity[at - 1] ?? 0); continue; }
      velocity.push((smooth[at] - smooth[at - 1]) / dt);
    }
    channels.push({
      name: `目标速度 M${index + 1}`,
      unit: "mm/s",
      channelType: "targetVel",
      channelIndex: index + 1,
      points: velocity,
    });
  }

  return { windowSize: history.length, timestamps, channels };
}

/**
 * **实际 vs 理论：合并成同一张图 + 一张误差图** ✓。
 *
 * 两条数据源的时间轴本来不同 ✓（实际是快照帧 ~100ms ✓，目标是播放器 ~80ms ✓），
 * 直接叠在一条轴上会**x/y 错位** ✗ —— 所以这里以**实际帧的时间轴**为基准 ✓，
 * 把目标序列按时间**线性插值**到这条轴上 ✓ → 同一横坐标的纵坐标才是同一时刻的 ✓。
 *
 * · 合并图：`实际 MN pos`（实线 ✓）+ `理论 MN pos`（虚线 ✓），同色 ✓
 * · 误差图：`误差 MN` = 实际 − 理论 ✓ —— 用来判断是**恒定滞后**（曲线整体平移 ✓）
 *   还是**随速度变大**（幅值跟速度相关 ✓），两者对应的补偿手段完全不同 ✓
 *
 * 目标覆盖不到的时间段用 `NaN` 断线 ✓（不画假的连续段 ✗）。
 */
function interpolateAt(timestamps: number[], points: number[], at: number): number {
  const count = timestamps.length;
  if (count === 0) return Number.NaN;
  if (at < timestamps[0] || at > timestamps[count - 1]) return Number.NaN;
  let low = 0;
  let high = count - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (timestamps[mid] <= at) low = mid;
    else high = mid;
  }
  const t0 = timestamps[low];
  const t1 = timestamps[high];
  const v0 = points[low];
  const v1 = points[high];
  if (!Number.isFinite(v0) || !Number.isFinite(v1)) return Number.NaN;
  if (t1 === t0) return v0;
  return v0 + (v1 - v0) * ((at - t0) / (t1 - t0));
}

function buildTracking(
  actual: ChartSection,
  target: ChartSection | null,
  delayMs = 0,
): { merge: ChartSection | null; error: ChartSection | null } {
  /**
   * **理论曲线延时 τ** ✓ —— 对齐"指令 → 电机实际响应"的纯滞后 ✓。
   *
   * 为什么 ✗：理论值是"这一刻应该在哪"✓，实际值是"上一批指令走到的位置"✓，
   * 两者相差一个传输 + 梯形加减速启动的纯滞后 τ（实测约 1s ✓）。
   * 不补偿就直接同轴对比 ✓ → 两条线整体错开 ✓ → 看起来到处都不对 ✗，
   * 其实只是相位差 ✓（用户要求：先把曲线对齐，再谈误差 ✓）。
   *
   * 做法：理论序列取 `t − τ` 处的值 ✓（等价于把理论曲线**右移** τ 秒 ✓）。
   * 误差也用对齐后的理论算 ✓，这样剩下的差值才是**真正的跟踪误差** ✓。
   */
  const delaySec = Math.max(0, delayMs) / 1000;
  if (!target || target.channels.length === 0) return { merge: null, error: null };
  const timestamps = actual.timestamps ?? [];
  if (timestamps.length < 2) return { merge: null, error: null };
  const targetStamps = target.timestamps ?? [];

  const mergeChannels: ChartSection["channels"] = [];
  const errorChannels: ChartSection["channels"] = [];

  for (let motor = 1; motor <= 6; motor += 1) {
    const actualChannel = actual.channels.find(
      (channel) => channel.channelType === "motor" && channel.name.endsWith(" pos") && channel.channelIndex === motor,
    );
    const targetChannel = target.channels.find(
      (channel) => channel.channelType === "target" && channel.channelIndex === motor,
    );
    if (!actualChannel || !targetChannel) continue;

    const actualPoints = actualChannel.points;
    const targetPoints = timestamps.map((stamp) =>
      // **延时对齐**：理论取 τ 之前的值 ✓
      interpolateAt(targetStamps, targetChannel.points, stamp - delaySec),
    );

    mergeChannels.push({
      name: `实际 M${motor} pos`,
      unit: "mm",
      channelType: "trackA",
      channelIndex: motor,
      points: actualPoints,
    });
    mergeChannels.push({
      name: `理论 M${motor} pos`,
      unit: "mm",
      channelType: "trackT",
      channelIndex: motor,
      points: targetPoints,
    });

    errorChannels.push({
      name: `误差 M${motor}`,
      unit: "mm",
      channelType: "trackErr",
      channelIndex: motor,
      points: actualPoints.map((value, index) => {
        const targetValue = targetPoints[index];
        if (!Number.isFinite(value) || !Number.isFinite(targetValue)) return Number.NaN;
        return value - targetValue;
      }),
    });
  }

  if (mergeChannels.length === 0) return { merge: null, error: null };
  return {
    merge: { windowSize: timestamps.length, timestamps, channels: mergeChannels },
    error: { windowSize: timestamps.length, timestamps, channels: errorChannels },
  };
}

/**
 * **速度：实际 + 理论合并** ✓ —— 和位移同一套做法 ✓。
 *
 * 实际速度来自快照帧 ✓（`Motor N vel` ✓），理论速度来自播放器 ✓（`目标速度 MN` ✓），
 * 两条时间轴不同 ✓ → 同样以**实际帧时间轴**为基准插值对齐 ✓。
 */
function buildVelocityTracking(
  actual: ChartSection,
  target: ChartSection | null,
): ChartSection | null {
  if (!target || target.channels.length === 0) return null;
  const timestamps = actual.timestamps ?? [];
  if (timestamps.length < 2) return null;
  const targetStamps = target.timestamps ?? [];
  const channels: ChartSection["channels"] = [];

  for (let motor = 1; motor <= 6; motor += 1) {
    const actualChannel = actual.channels.find(
      (channel) => channel.channelType === "motor" && channel.name.endsWith(" vel") && channel.channelIndex === motor,
    );
    const targetChannel = target.channels.find(
      (channel) => channel.channelType === "targetVel" && channel.channelIndex === motor,
    );
    if (!actualChannel || !targetChannel) continue;

    channels.push({
      name: `实际 M${motor} vel`,
      unit: "mm/s",
      channelType: "velA",
      channelIndex: motor,
      points: actualChannel.points,
    });
    channels.push({
      name: `理论 M${motor} vel`,
      unit: "mm/s",
      channelType: "velT",
      channelIndex: motor,
      points: timestamps.map((stamp) => interpolateAt(targetStamps, targetChannel.points, stamp)),
    });
  }

  if (channels.length === 0) return null;
  return { windowSize: timestamps.length, timestamps, channels };
}

/**
 * **侧栏用的通道全集** ✓ —— 把"只在合并图里存在"的通道也算进来 ✓。
 *
 * 为什么需要 ✗：合并图的理论线 / 误差线只存在于派生的 section 里 ✓，
 * 侧栏若只读 `activeCharts` ✓ → 列表里根本看不到它们 ✗ →
 * "左侧导航栏内容不对" ✗（本 bug ✓）。
 */
function sidebarSection(
  actual: ChartSection,
  sections: Array<ChartSection | null>,
): ChartSection {
  /**
   * ⚠ **`Motor N pos` / `Motor N vel` 不再进侧栏** ✗ ——
   * 它们已经被合并图的 `实际 MN pos / vel` 取代 ✓，两边都列就是**一个电机两组勾选框** ✗
   * （实测位移/速度各冒出 18 条 ✗，本 bug ✓）。加速度等其余通道照旧 ✓。
   */
  const channels = actual.channels.filter(
    (channel) =>
      !(channel.channelType === "motor" && (channel.name.endsWith(" pos") || channel.name.endsWith(" vel"))),
  );
  for (const section of sections) {
    if (!section || section.timestamps.length !== actual.timestamps.length) continue;
    for (const channel of section.channels) {
      if (!channels.some((item) => item.name === channel.name)) channels.push(channel);
    }
  }
  return { windowSize: actual.windowSize, timestamps: actual.timestamps, channels };
}

/**
 * **导出用：把「理论位移」与「跟踪误差」并进同一张表** ✓。
 *
 * 三者都以**实际帧时间轴**为基准 ✓（见 `buildTracking` ✓）→ 行数一致 ✓，
 * 可以直接并列成列 ✓，不会错行 ✗。
 *
 * 注意不重复导出"实际位移"✗ —— `activeCharts` 里本来就有 `Motor N pos` ✓，
 * 这里只补**理论**与**误差**两类 ✓。
 */
function withTracking(
  actual: ChartSection,
  tracking: { merge: ChartSection | null; error: ChartSection | null },
  velocity: ChartSection | null = null,
): ChartSection {
  const aligned = (section: ChartSection | null) =>
    Boolean(section && section.timestamps.length === actual.timestamps.length);
  const extra: ChartSection["channels"] = [];
  if (aligned(tracking.merge)) {
    extra.push(
      ...(tracking.merge as ChartSection).channels.filter(
        (channel) => channel.channelType === "trackT",
      ),
    );
  }
  if (aligned(tracking.error)) {
    extra.push(...(tracking.error as ChartSection).channels);
  }
  // **理论速度也并进去** ✓（实际速度本来就在 `Motor N vel` 里 ✓）
  if (aligned(velocity)) {
    extra.push(
      ...(velocity as ChartSection).channels.filter((channel) => channel.channelType === "velT"),
    );
  }
  if (extra.length === 0) return actual;
  return {
    windowSize: actual.windowSize,
    timestamps: actual.timestamps,
    channels: [...actual.channels, ...extra],
  };
}

/** **理论曲线滞后 τ（ms）** ✓ —— 默认 1000ms，可在页面顶部调 ✓。*/
export const TRACKING_DELAY_KEY = "softui.trackingDelayMs";
export const DEFAULT_TRACKING_DELAY_MS = 1000;

export function readTrackingDelayMs(): number {
  try {
    const raw = window.localStorage.getItem(TRACKING_DELAY_KEY);
    const value = raw == null ? Number.NaN : Number(raw);
    if (Number.isFinite(value) && value >= 0 && value <= 5000) return value;
  } catch {
    /* 忽略 */
  }
  return DEFAULT_TRACKING_DELAY_MS;
}

function fallbackTimestamps(charts: ChartSection) {
  if (charts.timestamps?.length) return charts.timestamps;
  const len = charts.channels[0]?.points.length ?? 0;
  return Array.from({ length: len }, (_, index) => Number(((index - Math.max(len - 1, 0)) * 0.05).toFixed(2)));
}

function emptyCharts(): ChartSection {
  return { windowSize: 0, timestamps: [], channels: [] };
}

function formatValue(value: number | null, unit: string) {
  if (value == null || !Number.isFinite(value)) return "--";
  const abs = Math.abs(value);
  const precision = abs >= 100 ? 1 : abs >= 10 ? 2 : 3;
  return `${value.toFixed(precision)} ${unit}`;
}

function formatRelativeSeconds(seconds: number) {
  return Number.isFinite(seconds) ? `${seconds.toFixed(1)}s` : "--";
}

function formatStatus(error: string, exportPath: string, playbackMode: boolean, historyCount: number) {
  if (error) return error;
  if (exportPath) return exportPath;
  if (playbackMode) return `历史会话：已加载 ${historyCount} 帧`;
  return "实时刷新中";
}

function channelSignature(channels: ChartSection["channels"]) {
  return channels.map((channel) => channel.name).join("|");
}

function latestDataKey(timestamps: number[], channels: ChartSection["channels"]) {
  const lastTime = timestamps[timestamps.length - 1] ?? 0;
  return `${timestamps.length}:${lastTime}:${channels.map((channel) => `${channel.points.length}:${channel.points[channel.points.length - 1] ?? 0}`).join("|")}`;
}

function axisRanges(timestamps: number[], channels: ChartSection["channels"]) {
  const xMin = timestamps[0] ?? 0;
  const xMax = timestamps[timestamps.length - 1] ?? 1;
  const values = channels.flatMap((channel) => channel.points).filter(Number.isFinite);
  let yMin = values.length ? Math.min(...values) : 0;
  let yMax = values.length ? Math.max(...values) : 1;
  if (Math.abs(yMax - yMin) < 1e-6) {
    yMin -= 1;
    yMax += 1;
  } else {
    const pad = (yMax - yMin) * 0.12;
    yMin -= pad;
    yMax += pad;
  }
  return { x: { min: xMin, max: xMax > xMin ? xMax : xMin + 1 }, y: { min: yMin, max: yMax } };
}

function ChartPanel({ config, charts, paused, timeOrigin, hidden, onToggleChannel }: {
  config: ChartPanelConfig;
  charts: ChartSection;
  paused: boolean;
  timeOrigin: number;
  hidden: Record<string, boolean>;
  onToggleChannel: (name: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const lastKeyRef = useRef("");
  const [readout, setReadout] = useState<CursorReadout | null>(null);
  /**
   * 通道选项（勾选框）与实时读数是否展开。默认收起：
   * 每张卡片展开时标题区要占三行（标题 / 图例 / 读数），图本身被挤得很矮；
   * 收起后只留标题行，开关上直接写着"通道 n/m"，信息不丢。
   */
  const [optionsOpen, setOptionsOpen] = useState(false);

  const panelChannels = useMemo(() => charts.channels.filter((channel) => config.match(channel.name, channel.channelType)), [charts.channels, config]);
  const visibleChannels = useMemo(() => panelChannels.filter((channel) => !hidden[channel.name]), [hidden, panelChannels]);
  const timestamps = useMemo(() => fallbackTimestamps(charts), [charts]);
  const alignedData = useMemo<uPlot.AlignedData>(() => [timestamps, ...visibleChannels.map((channel) => channel.points)], [timestamps, visibleChannels]);
  const visibleKey = useMemo(() => channelSignature(visibleChannels), [visibleChannels]);
  const dataKey = useMemo(() => `${config.key}:${latestDataKey(timestamps, visibleChannels)}`, [config.key, timestamps, visibleChannels]);
  const timestampsRef = useRef(timestamps);
  const visibleChannelsRef = useRef(visibleChannels);

  useEffect(() => {
    timestampsRef.current = timestamps;
    visibleChannelsRef.current = visibleChannels;
  }, [timestamps, visibleChannels]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const updateReadout = (plot: uPlot) => {
      const idx = typeof plot.cursor.idx === "number" ? plot.cursor.idx : null;
      const currentTimestamps = timestampsRef.current;
      const currentChannels = visibleChannelsRef.current;
      if (idx == null || idx < 0 || idx >= currentTimestamps.length) {
        setReadout(null);
        return;
      }
      setReadout({
        time: currentTimestamps[idx],
        values: currentChannels.map((channel, index) => ({
          name: channel.name,
          color: config.colorByChannelIndex
            ? COLORS[(Math.max(1, channel.channelIndex) - 1) % COLORS.length]
            : COLORS[index % COLORS.length],
          value: channel.points[idx] ?? null,
          unit: channel.unit || config.unit,
        })),
      });
    };

    const opts: uPlot.Options = {
      width: Math.max(320, host.clientWidth),
      height: Math.max(180, host.clientHeight || 220),
      cursor: { show: true, x: true, y: false, drag: { x: false, y: false }, points: { show: false } },
      legend: { show: false },
      scales: { x: { time: false }, y: {} },
      series: [
        {},
        ...visibleChannels.map((channel, index): uPlot.Series => {
          /**
           * **上色规则** ✓：
           *   合并图按**通道序号**上色 ✓（实际 M1 与 理论 M1 必须同色 ✓），
           *   其余图按序列顺序上色 ✓（保持原样 ✓）。
           */
          const dashed = channel.name.startsWith("理论");
          const color = config.colorByChannelIndex
            ? COLORS[(Math.max(1, channel.channelIndex) - 1) % COLORS.length]
            : COLORS[index % COLORS.length];
          return {
            label: channel.name,
            stroke: color,
            width: dashed ? 1.2 : 1.7,
            // **理论 = 虚线** ✓（实线/虚线是唯一区分手段 ✓，颜色要留给通道 ✓）
            dash: dashed ? [5, 3] : undefined,
            points: { show: false },
          };
        }),
      ],
      axes: [
        { label: "时间 s", stroke: "#8a95a3", grid: { stroke: "rgba(255,255,255,0.06)" }, values: (_plot, vals) => vals.map((value) => (value - timeOrigin).toFixed(1)) },
        { label: config.unit, stroke: "#8a95a3", grid: { stroke: "rgba(255,255,255,0.06)" } },
      ],
      hooks: { setCursor: [updateReadout] },
    };

    plotRef.current?.destroy();
    plotRef.current = new uPlot(opts, alignedData, host);
    const ranges = axisRanges(timestampsRef.current, visibleChannelsRef.current);
    plotRef.current.setScale("x", ranges.x);
    plotRef.current.setScale("y", ranges.y);
    lastKeyRef.current = dataKey;
    setReadout(null);

    const resize = () => plotRef.current?.setSize({ width: Math.max(320, host.clientWidth), height: Math.max(180, host.clientHeight || 220) });
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    return () => {
      observer.disconnect();
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, [config.unit, timeOrigin, visibleKey]);

  useEffect(() => {
    const plot = plotRef.current;
    if (!plot || paused || lastKeyRef.current === dataKey) return;
    plot.setData(alignedData, false);
    const ranges = axisRanges(timestamps, visibleChannels);
    plot.setScale("x", ranges.x);
    plot.setScale("y", ranges.y);
    lastKeyRef.current = dataKey;
  }, [alignedData, dataKey, paused, timestamps, visibleChannels]);

  return (
    <section className="chart-split-card">
      <div className="chart-split-head">
        <div className="chart-split-title-row">
          <strong>{config.title}</strong>
          <div className="chart-split-title-actions">
            <span>{readout ? `t=${formatRelativeSeconds(readout.time - timeOrigin)}` : "移动鼠标查看当前时间"}</span>
            <button
              aria-expanded={optionsOpen}
              className={`chart-split-options${optionsOpen ? " is-open" : ""}`}
              onClick={() => setOptionsOpen((previous) => !previous)}
              type="button"
            >
              <ChevronDown aria-hidden="true" size={13} />
              通道 {visibleChannels.length}/{panelChannels.length}
            </button>
          </div>
        </div>
        {optionsOpen ? (
          <>
            <div className="chart-split-legend">
              {panelChannels.map((channel, index) => (
                <label className={hidden[channel.name] ? "muted" : ""} key={channel.name}>
                  <input type="checkbox" checked={!hidden[channel.name]} onChange={() => onToggleChannel(channel.name)} />
                  <i style={{ background: COLORS[index % COLORS.length] }} />
                  {channel.name}
                </label>
              ))}
            </div>
            <div className="chart-readout-values">
              {(readout?.values ?? visibleChannels.map((channel, index) => ({ name: channel.name, color: COLORS[index % COLORS.length], value: null, unit: channel.unit || config.unit }))).map((item) => (
                <span key={item.name}><i style={{ background: item.color }} />{item.name}: <strong>{formatValue(item.value, item.unit)}</strong></span>
              ))}
            </div>
          </>
        ) : null}
      </div>
      <div className="chart-split-plot" ref={hostRef} />
    </section>
  );
}

export default function ChartsPage({ snapshot }: { snapshot: RuntimeSnapshot }) {
  /* 历史会话帧与导出都属会话管理（维护员及以上）。无权限时只保留实时曲线：
   * 入口不出现，免得点了才报错。 */
  const canManageSessions = hasPermission(snapshot, "manageSessions");
  const [paused, setPaused] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState("live");
  const [historyFrames, setHistoryFrames] = useState<DeviceSnapshot[]>([]);
  const [liveFrames, setLiveFrames] = useState<DeviceSnapshot[]>([]);
  const [exportPath, setExportPath] = useState("");
  const [chartError, setChartError] = useState("");
  const [timeOrigin, setTimeOrigin] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});

  const toggleChannel = useCallback((name: string) => {
    setHidden((prev) => ({ ...prev, [name]: !prev[name] }));
  }, []);
  /**
   * **目标位移采样版本** ✓ —— 环形缓冲是普通数组 ✗，不是 React state ✓，
   * 所以 `useMemo` 不会知道它变了 ✗（这就是"通道看不到目标曲线"的原因 ✓）。
   * 这里每 300ms 顶一次 ✓，只在**播放中**才起定时器 ✓（空闲零开销 ✗）。
   */
  const [targetTick, setTargetTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (getTargetHistory().length === 0) return;
      setTargetTick((n) => n + 1);
    }, 300);
    return () => window.clearInterval(timer);
  }, []);

  const liveCharts = useMemo(() => chartsFromFrames(liveFrames), [liveFrames, targetTick]);
  const historyCharts = useMemo(() => chartsFromFrames(historyFrames), [historyFrames]);
  /** 目标曲线的数据（自己的时间轴 ✓）*/
  const targetData = useMemo(() => targetCharts(), [targetTick]);
  const activeCharts: ChartSection = selectedSessionId === "live" ? liveCharts ?? emptyCharts() : historyCharts ?? emptyCharts();
  /** **实际 vs 理论** ✓ —— 合并图 + 误差图（同一时间轴 ✓，x/y 同源 ✓）*/
  /** **理论曲线延时 τ** ✓ —— 用户可调（默认 1000ms）✓ */
  const [tauMs, setTauMs] = useState(DEFAULT_TRACKING_DELAY_MS);
  useEffect(() => {
    setTauMs(readTrackingDelayMs());
  }, []);
  const tracking = useMemo(
    () => buildTracking(activeCharts, targetData, tauMs),
    [activeCharts, targetData, tauMs],
  );
  /** **速度合并** ✓（实际实线 + 理论虚线 ✓）*/
  const velocityTracking = useMemo(
    () => buildVelocityTracking(activeCharts, targetData),
    [activeCharts, targetData],
  );
  /** **侧栏通道全集** ✓ —— 合并图里的理论线 / 误差线也要能勾选 ✓ */
  const sidebarCharts = useMemo(
    () => sidebarSection(activeCharts, [tracking.merge, tracking.error, velocityTracking]),
    [activeCharts, tracking, velocityTracking],
  );
  const playbackMode = selectedSessionId !== "live";

  /**
   * 实时曲线的数据来源 ✓ —— **能本地就本地** ✓。
   *
   * 曲线解析（`chartsFromFrames` ✓、曲率分布 ✓、统计摘要 ✓）全部在浏览器里算 ✓，
   * 数据来源分两种情况：
   *   · **本端持有串口**（电脑插着设备）→ `fetch_live_window` 被 shim 拦成本地应答 ✓
   *     → **零网络请求** ✓，250ms 刷新无成本 ✓
   *   · **本端没有串口**（手机 / 另一台电脑）→ 只能问后端 ✓ →
   *     240 帧一次几百 KB ✗ → 4Hz 一天几十 GB ✗（流量异常的一大来源 ✓）
   *
   * 所以远端把刷新降到 **2s** ✓：曲线是"看趋势"✓，不必 4Hz；
   * 真要高刷就在持串口那台机器上看 ✓。
   */
  const localSource = hasLocalPort();
  useEffect(() => {
    if (selectedSessionId !== "live" || paused) return;
    let cancelled = false;
    let pending = false;
    const fetchWindow = async () => {
      if (pending) return;
      pending = true;
      try {
        const frames = await invoke<DeviceSnapshot[]>("fetch_live_window", { count: 240 });
        if (!cancelled) setLiveFrames(frames);
      } catch (error) {
        if (!cancelled) setChartError(error instanceof Error ? error.message : String(error));
      } finally {
        pending = false;
      }
    };
    void fetchWindow();
    const intervalMs = localSource ? 250 : 2000;
    const timer = window.setInterval(fetchWindow, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [paused, selectedSessionId, localSource]);

  useEffect(() => {
    void invoke<SessionInfo[]>("list_sessions").then(setSessions).catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    setExportPath("");
    setChartError("");
    setTimeOrigin(null);
    if (selectedSessionId === "live") {
      setHistoryFrames([]);
      return;
    }
    void invoke<DeviceSnapshot[]>("read_session_frames", { id: selectedSessionId, maxCount: 1200 })
      .then(setHistoryFrames)
      .catch((error) => {
        setHistoryFrames([]);
        setChartError(error instanceof Error ? error.message : String(error));
      });
  }, [selectedSessionId]);

  useEffect(() => {
    if (timeOrigin != null) return;
    const first = activeCharts.timestamps?.[0];
    if (Number.isFinite(first)) setTimeOrigin(first);
  }, [activeCharts.timestamps, timeOrigin]);

  /** 曲线导出同样在前端生成：服务端不再写文件。 */
  const exportAllChannels = () => {
    try {
      const suffix = selectedSessionId === "live" ? "实时" : selectedSessionId;
      // **导出带上理论位移与跟踪误差** ✓ —— 三者同一条时间轴 ✓，可直接并列成列 ✓
      downloadText(
        `曲线-${suffix}-${exportStamp()}.csv`,
        chartsToCsv(withTracking(activeCharts, tracking, velocityTracking)),
      );
      setExportPath(`已导出 ${activeCharts.timestamps.length} 行`);
      setChartError("");
    } catch (error) {
      setChartError(error instanceof Error ? error.message : String(error));
    }
  };

  const chartKeyFor = useCallback(
    (channel: ChartSection["channels"][number]) =>
      CHARTS.find((config) => config.match(channel.name, channel.channelType))?.key ?? null,
    [],
  );
  const chartTitles = useMemo(
    () => Object.fromEntries(CHARTS.map((config) => [config.key as string, config.title])),
    [],
  );
  const visibleNames = useMemo(() => (
    new Set(
      sidebarCharts.channels
        .filter((channel) => !hidden[channel.name])
        .map((channel) => channel.name),
    )
  ), [sidebarCharts.channels, hidden]);

  return (
    <ChartLayout
      channelsLabel="曲线通道"
      channels={
        <ChannelSidebar
          channels={sidebarCharts.channels}
          visibleNames={visibleNames}
          chartKeyFor={chartKeyFor}
          chartTitles={chartTitles}
          onToggleChannel={toggleChannel}
        />
      }
      toolbar={
        <ChartToolbar
          sessions={canManageSessions ? sessions : []}
          canManageSessions={canManageSessions}
          selectedSessionId={selectedSessionId}
          paused={paused}
          playbackMode={playbackMode}
          status={formatStatus(chartError, exportPath, playbackMode, historyFrames.length)}
          onSessionChange={setSelectedSessionId}
          onPauseChange={setPaused}
          onRefresh={() => setPaused(false)}
          onExportCsv={() => void exportAllChannels()}
        />
      }
    >
      <div className="chart-tau-row">
        <label>
          理论曲线延时 τ
          <input
            type="number"
            min={0}
            max={5000}
            step={50}
            value={tauMs}
            onChange={(event) => {
              const next = Math.max(0, Math.min(5000, Number(event.target.value) || 0));
              setTauMs(next);
              try {
                window.localStorage.setItem(TRACKING_DELAY_KEY, String(next));
              } catch {
                /* 忽略 */
              }
            }}
          />
          ms
        </label>
        <span className="chart-tau-hint">
          指令下发到电机实际响应有约 1s 纯滞后；这里把理论曲线右移 τ，
          两条线才在同一相位上对比，误差才是真正的跟踪误差。
        </span>
      </div>

      <div className="charts-split-grid">
        {CHARTS.map((config) => {
          // **目标曲线用自己的 section** ✓（自己的 timestamps ✓ → x/y 同源 ✓）
          // **合并图 / 误差图** ✓ —— 都以"实际帧时间轴"为基准 ✓（见 buildTracking ✓）
          const charts =
            config.key === "tracking"
              // 没有目标数据（历史会话 ✓）→ 退回只画实际线 ✓，别整张空着 ✗
              ? (tracking.merge ?? activeCharts)
              : config.key === "trackingError"
                ? (tracking.error ?? emptyCharts())
                : config.key === "velocity"
                  ? (velocityTracking ?? activeCharts)
                  : activeCharts;
          return (
            <ChartPanel
              key={`${config.key}-${config.key === "tracking" || config.key === "trackingError" ? tauMs : "n"}`}
              config={config}
              charts={charts}
              paused={paused}
              // **目标图不共用 frame 的时间原点** ✗ ——
              //   两百个 epoch 毫秒 / 1000 = 十几亿秒 ✗ → 轴刻度变成"几千秒"✗（本 bug ✓）
              timeOrigin={timeOrigin ?? charts.timestamps?.[0] ?? 0}
              hidden={hidden}
              onToggleChannel={toggleChannel}
            />
          );
        })}
      </div>
    </ChartLayout>
  );
}
