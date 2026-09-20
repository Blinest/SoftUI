/* 卡片布局：读取 / 校验 / 持久化 / 拖拽变换。
 *
 * 布局以「格」为单位持久化（见 softuiTypes.CardSize），渲染时按容器可用宽度
 * 换算成列宽，因此同一个布局在宽屏是 4 列、窄屏是 2 列，卡片会自动换行。 */

import { useEffect, useSyncExternalStore } from "react";

import type {
  CardPlacement,
  CardSize,
  DashboardCardId,
  LayoutPage,
  MonitorCardId,
  PageLayout,
} from "../softuiTypes";

const STORAGE_PREFIX = "softui:layout";

/**
 * 布局数据结构版本。卡片集合有增删（例如把摄像头从 3D 卡片里拆出来）时递增，
 * 这样用户本地缓存的旧布局会被判为不合法并回落到新的默认布局，而不是缺卡片。
 */
const LAYOUT_SCHEMA_VERSION = 2;

const DASHBOARD_CARD_IDS: DashboardCardId[] = [
  "connection",
  "sampling",
  "recording",
  "alerts",
  "deviceHealth",
  "recentSessions",
  "recentEvents",
];

const MONITOR_CARD_IDS: MonitorCardId[] = [
  "deviceState",
  "commandQueue",
  "motorSummary",
  "sensorSummary",
  "model3d",
  "camera",
  "armCharts",
  "recentAlerts",
];

/** 卡片尺寸每一维的上限（列 / 行都是 1~4 格）。 */
export const MAX_CARD_SPAN = 4;

/** 尺寸白名单：持久化校验用。每一维 1~4 格，和 CardSize 的定义保持一致。 */
const CARD_SIZES: readonly CardSize[] = (() => {
  const sizes: CardSize[] = [];
  for (let col = 1; col <= MAX_CARD_SPAN; col += 1) {
    for (let row = 1; row <= MAX_CARD_SPAN; row += 1) {
      sizes.push(`${col}x${row}` as CardSize);
    }
  }
  return sizes;
})();

/* ---- 栅格度量 ---- */

/** 栅格间距与最小列宽（px），和 styles/layouts.css 里 .card-grid 的取值对齐。 */
export const CARD_GRID_GAP_PX = 12;
export const CARD_MIN_COLUMN_PX = 240;

/**
 * 按容器宽度决定列数，再决定列宽 —— 顺序不能反：列数必须先定，
 * 否则容器在档位边界来回一两个像素，列数就在 3/4 之间抖动。
 *
 * 上限 4 列是有意为之：`2x1` 的卡片在 5 列及以上的栅格里永远找不到位置，
 * 压实算法每次都会把它挤到下一行 —— 卡片一多就会出现大片空白。
 */
export function gridColumnsForWidth(width: number): number {
  if (width >= 1080) return 4;
  if (width >= 720) return 3;
  if (width >= 480) return 2;
  return 1;
}

/**
 * 列宽：把容器宽度按列数均分，向下取整后正好铺满，不会因为取整留出横向滚动。
 *
 * 卡片的位置和尺寸都是 JS 按这个值算好写成行内样式的，所以这里可以放心用
 * 「实测宽度 ÷ 列数」——CSS 与 JS 拿到的是同一个数，不会对不上。
 */
function gridColumnWidth(width: number, columns: number): number {
  if (columns <= 1) return Math.max(1, width);
  const available = width - (columns - 1) * CARD_GRID_GAP_PX;
  return Math.max(CARD_MIN_COLUMN_PX, Math.floor(available / columns));
}

export interface GridMetrics {
  columns: number;
  columnWidth: number;
  rowHeight: number;
  gap: number;
}

/** 栅格度量：列宽决定行高，行高用于把拖拽时的像素位置映射成格子坐标。 */
export function gridMetricsForWidth(width: number): GridMetrics {
  const columns = gridColumnsForWidth(width);
  const columnWidth = gridColumnWidth(width, columns);
  const rowHeight = Math.max(140, Math.round(Math.min(240, 165 * (columnWidth / CARD_MIN_COLUMN_PX))));
  return { columns, columnWidth, rowHeight, gap: CARD_GRID_GAP_PX };
}

/** 像素偏移 → 0 基格子坐标。 */
export function pointToCell(x: number, y: number, metrics: GridMetrics): GridPoint {
  const { columnWidth, rowHeight, gap } = metrics;
  return {
    row: Math.floor((y + gap / 2) / (rowHeight + gap)),
    col: Math.floor((x + gap / 2) / (columnWidth + gap)),
  };
}

/** 0 基格子坐标 → 卡片左上角的像素偏移。 */
export function cellToPoint(point: GridPoint, metrics: GridMetrics): { x: number; y: number } {
  const { columnWidth, rowHeight, gap } = metrics;
  return {
    x: point.col * (columnWidth + gap),
    y: point.row * (rowHeight + gap),
  };
}

/* ---- 默认布局 ---- */

/** 总览页默认布局。深冻结，避免运行时被就地改写。 */
export const defaultDashboardLayout: PageLayout = freezeLayout({
  schemaVersion: LAYOUT_SCHEMA_VERSION,
  cards: [
    { id: "connection", size: "1x1", visible: true },
    { id: "sampling", size: "1x1", visible: true },
    { id: "recording", size: "1x1", visible: true },
    { id: "alerts", size: "1x1", visible: true },
    { id: "deviceHealth", size: "2x1", visible: true },
    { id: "recentSessions", size: "1x1", visible: true },
    { id: "recentEvents", size: "1x1", visible: true },
  ],
});

/** 设备工作台「监控」标签默认布局。 */
export const defaultWorkspaceMonitorLayout: PageLayout = freezeLayout({
  schemaVersion: LAYOUT_SCHEMA_VERSION,
  cards: [
    { id: "deviceState", size: "1x1", visible: true },
    { id: "commandQueue", size: "1x1", visible: true },
    { id: "motorSummary", size: "2x1", visible: true },
    { id: "sensorSummary", size: "2x1", visible: true },
    { id: "model3d", size: "2x2", visible: true },
    { id: "camera", size: "2x2", visible: true },
    { id: "armCharts", size: "2x1", visible: true },
    { id: "recentAlerts", size: "2x1", visible: true },
  ],
});

function freezeLayout(layout: PageLayout): PageLayout {
  layout.cards.forEach((card) => Object.freeze(card));
  Object.freeze(layout.cards);
  return Object.freeze(layout);
}

function allowedCardIds(page: LayoutPage): string[] {
  return page === "dashboard" ? DASHBOARD_CARD_IDS : MONITOR_CARD_IDS;
}

/**
 * 默认布局的副本。默认布局是深冻结的，直接返回会让调用方改不动卡片顺序。
 */
export function defaultLayoutForPage(page: LayoutPage): PageLayout {
  const source = page === "dashboard" ? defaultDashboardLayout : defaultWorkspaceMonitorLayout;
  return { schemaVersion: source.schemaVersion, cards: source.cards.map((card) => ({ ...card })) };
}

/**
 * 严格校验持久化的布局：版本号、卡片 id 白名单、尺寸白名单、id 不重复、
 * 关键卡片不可隐藏。任一条不满足即整体回退到默认布局。
 */
export function validateLayout(value: unknown, page: LayoutPage = "dashboard"): PageLayout {
  if (typeof value !== "object" || value === null) return defaultLayoutForPage(page);
  const candidate = value as Partial<PageLayout>;
  if (candidate.schemaVersion !== LAYOUT_SCHEMA_VERSION || !Array.isArray(candidate.cards)) {
    return defaultLayoutForPage(page);
  }

  const allowed = allowedCardIds(page);
  const seen = new Set<string>();
  const cards: CardPlacement[] = [];
  for (const raw of candidate.cards) {
    if (typeof raw !== "object" || raw === null) return defaultLayoutForPage(page);
    const card = raw as Partial<CardPlacement>;
    if (typeof card.id !== "string" || !allowed.includes(card.id)) return defaultLayoutForPage(page);
    if (seen.has(card.id)) return defaultLayoutForPage(page);
    if (typeof card.size !== "string" || !CARD_SIZES.includes(card.size as (typeof CARD_SIZES)[number])) {
      return defaultLayoutForPage(page);
    }
    if (typeof card.visible !== "boolean") return defaultLayoutForPage(page);
    // 关键安全卡片不允许被隐藏。
    if (card.id === "connection" && !card.visible) return defaultLayoutForPage(page);
    seen.add(card.id);
    cards.push({ id: card.id, size: card.size, visible: card.visible });
  }
  // 安全卡片必须存在；监控页则要求 3D 与摄像头卡片都在，避免旧布局缺卡片。
  if (page === "dashboard" && !seen.has("connection")) return defaultLayoutForPage(page);
  if (page === "workspace-monitor" && !(seen.has("model3d") && seen.has("camera"))) {
    return defaultLayoutForPage(page);
  }
  return { schemaVersion: LAYOUT_SCHEMA_VERSION, cards };
}

function storageKey(username: string, page: LayoutPage) {
  return `${STORAGE_PREFIX}:${username}:${page}`;
}

export function loadLayout(username: string, page: LayoutPage): PageLayout {
  try {
    const raw = localStorage.getItem(storageKey(username, page));
    if (!raw) return defaultLayoutForPage(page);
    return validateLayout(JSON.parse(raw), page);
  } catch {
    return defaultLayoutForPage(page);
  }
}

export function saveLayout(username: string, page: LayoutPage, layout: PageLayout) {
  try {
    localStorage.setItem(storageKey(username, page), JSON.stringify(layout));
  } catch {
    /* 忽略写入失败 */
  }
}

export function resetLayout(username: string, page: LayoutPage) {
  try {
    localStorage.removeItem(storageKey(username, page));
  } catch {
    /* 忽略删除失败 */
  }
}

/* ---- 栅格变换：压实 / 排序 / 缩放 ---- */

/** 0 基的格子坐标。行可以是负值（拖到第一行之上），算落点前会夹到 0。 */
export interface GridPoint {
  row: number;
  col: number;
}

interface GridEntry {
  id: string;
  row: number;
  col: number;
  colSpan: number;
  rowSpan: number;
}

/** `"3x2"` → `{ col: 3, row: 2 }`。每维都夹在 1~4，脏数据不会撑爆栅格。 */
export function sizeToSpan(size: CardSize): { col: number; row: number } {
  const [col, row] = size.split("x").map(Number);
  return {
    col: Math.min(MAX_CARD_SPAN, Math.max(1, Math.round(col) || 1)),
    row: Math.min(MAX_CARD_SPAN, Math.max(1, Math.round(row) || 1)),
  };
}

/** 容器列数不够时，把宽度收窄到放得下（例如单列里的 `2x1` 变成 `1x1`）。 */
function clampSpan(size: CardSize, columns: number): { colSpan: number; rowSpan: number } {
  const span = sizeToSpan(size);
  return { colSpan: Math.min(span.col, columns), rowSpan: span.row };
}

/** 卡片在指定列数下实际占的格数（单列时 2 格宽会被收窄成 1 格）。 */
export function spanOf(size: CardSize, columns: number): { colSpan: number; rowSpan: number } {
  return clampSpan(size, columns);
}

/**
 * 紧凑排布：按数组顺序把每张卡片放到第一个放得下的位置。
 *
 * 布局里只存**顺序 + 尺寸**，位置每次由这里算出来：拖拽只需要给出新顺序，
 * 也永远不会留下需要用户手动收拾的空洞。
 */
export function compactLayout(cards: CardPlacement[], columns: number): GridEntry[] {
  const placed: GridEntry[] = [];
  for (const card of cards) {
    const { colSpan, rowSpan } = clampSpan(card.size, columns);
    const point = firstFit(placed, colSpan, rowSpan, columns);
    placed.push({ id: card.id, row: point.row, col: point.col, colSpan, rowSpan });
  }
  return placed;
}

function firstFit(placed: GridEntry[], colSpan: number, rowSpan: number, columns: number): GridPoint {
  for (let row = 0; ; row += 1) {
    for (let col = 0; col + colSpan <= columns; col += 1) {
      if (fits(placed, row, col, colSpan, rowSpan)) return { row, col };
    }
  }
}

function fits(placed: GridEntry[], row: number, col: number, colSpan: number, rowSpan: number): boolean {
  return !placed.some((entry) => (
    col < entry.col + entry.colSpan
    && col + colSpan > entry.col
    && row < entry.row + entry.rowSpan
    && row + rowSpan > entry.row
  ));
}

/* ---- 拖拽：把卡片搬到某个「槽位」 ---- */

/**
 * 把 `id` 搬到第 `slot` 个位置：被拖卡片占住这个槽位，后面的卡片依次后移。
 *
 * 槽位是「压缩掉空洞之后的位置序号」，不保证等于指针所在的格子 —— 多格宽的
 * 卡片（`2x1`）会让后面的卡片整体下沉，所以调用方要拿它**实际渲染出来的位置**
 * 回填给被拖卡片，见 `nextSlot` 与 CardGrid 的提交逻辑。
 */
export function applySlot(cards: CardPlacement[], id: string, slot: number): CardPlacement[] {
  const from = cards.findIndex((card) => card.id === id);
  if (from < 0) return cards;
  const target = Math.max(0, Math.min(cards.length - 1, slot));
  if (target === from) return cards;
  const rest = cards.filter((card) => card.id !== id);
  return [...rest.slice(0, target), cards[from], ...rest.slice(target)];
}

/**
 * 拖动过程中的下一次布局。
 *
 * 命中测试跑在**去掉被拖卡片**的那份布局上，这一步很关键：
 *
 * 1. 被拖卡片不在里面对应任何格子，指针不会「自己命中自己」；
 * 2. 其余卡片在这份布局里的位置从按下到松手始终不变，命中区因此是稳定的，
 *    不会出现「指针底下卡片刚被挤走 → 又弹回来」的抖动。
 *
 * 光有「命中谁的槽位」还不够：**槽位序号不等于格子坐标**。前面的卡片尺寸不齐
 * （`2x1`、`2x2`）时，第 4 个槽位可能落在第一行右边的空格里，于是卡片明明往
 * 下拖、却停在了上面 —— 看起来就是「只能跨列不能跨行」。所以这里把每个候选
 * 槽位都压实一遍，挑**实际落点离落点最近的**那个。卡片数量在十几个量级，
 * 枚举一遍的开销可以忽略。
 *
 * 返回 `changed: false` 表示这一步不需要改布局（指针停在空白处）——调用方
 * 据此保持上一次的布局。
 */
export function nextSlot(
  cards: CardPlacement[],
  columns: number,
  id: string,
  point: GridPoint,
): { changed: boolean; cards: CardPlacement[] } {
  const dragged = cards.find((card) => card.id === id);
  if (!dragged) return { changed: false, cards };
  const others = cards.filter((card) => card.id !== id);
  const current = cards.findIndex((card) => card.id === id);

  const row = Math.max(0, point.row);
  const col = Math.max(0, point.col);

  let best = current;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let slot = 0; slot <= others.length; slot += 1) {
    const order = [...others.slice(0, slot), dragged, ...others.slice(slot)];
    const entry = compactLayout(order, columns).find((item) => item.id === id);
    if (!entry) continue;
    // 距离优先；同样近时偏向当前槽位，免得在两格之间来回抖。
    const cost = (entry.row - row) ** 2 + (entry.col - col) ** 2 + Math.abs(slot - current) * 1e-3;
    if (cost < bestCost) {
      bestCost = cost;
      best = slot;
    }
  }

  const next = [...others.slice(0, best), dragged, ...others.slice(best)];
  const changed = next.some((card, index) => card.id !== cards[index].id);
  return changed ? { changed: true, cards: next } : { changed: false, cards };
}

/**
 * 让位落点：被拖卡片挤到某个槽位之后，它**实际渲染**在哪里。
 *
 * 拖动时栅格按「命中谁的槽位」调整顺序，但落到具体格子还要看各卡片的尺寸
 * （多格宽的卡片会把后面的整体推下去），所以这里用渲染结果回填，
 * 落点指示器才能画在真正的位置上（也就是那个空位本身）。
 */
export function slotPreview(
  order: CardPlacement[],
  columns: number,
  id: string,
): { row: number; col: number; colSpan: number; rowSpan: number } | null {
  const entry = compactLayout(order, columns).find((item) => item.id === id);
  return entry ? { row: entry.row, col: entry.col, colSpan: entry.colSpan, rowSpan: entry.rowSpan } : null;
}

/* ---- 缩放 ---- */

/** 格数 -> 卡片尺寸（每维夹在 1~4 格）。 */
export function spanToSize(columns: number, rows: number): CardSize {
  const col = Math.min(MAX_CARD_SPAN, Math.max(1, Math.round(columns) || 1));
  const row = Math.min(MAX_CARD_SPAN, Math.max(1, Math.round(rows) || 1));
  return `${col}x${row}` as CardSize;
}

/** 卡片尺寸 -> 格数（拖动缩放时用来跟手换算）。 */
export function spanForSize(size: CardSize, columns: number): { colSpan: number; rowSpan: number } {
  return clampSpan(size, columns);
}

/**
 * 缩放 = 从右下角拖。
 *
 * 尺寸只受容器列数与 `MAX_CARD_SPAN` 限制，**不看邻居占位**：卡片栅格是紧凑
 * 排布的，扩大之后其余卡片会被重新压实 —— 该换列的换列、该换行的换行，
 * 所以邻居挡不挡得住不该由用户操心。
 */
export function sizeFromDelta(
  startSize: CardSize,
  columns: number,
  dx: number,
  dy: number,
  columnWidth: number,
  rowHeight: number,
  gap: number,
): CardSize {
  const base = spanForSize(startSize, columns);
  const colStep = columnWidth + gap;
  const rowStep = rowHeight + gap;
  const colSpan = Math.max(1, Math.min(columns, MAX_CARD_SPAN, base.colSpan + Math.round(dx / colStep)));
  const rowSpan = Math.max(1, Math.min(MAX_CARD_SPAN, base.rowSpan + Math.round(dy / rowStep)));
  return spanToSize(colSpan, rowSpan);
}

/** 缩放时其余卡片的重排结果：只换尺寸，顺序不动，位置由压实算法重算。 */
export function resizeLayout(
  cards: CardPlacement[],
  cardId: string,
  size: CardSize,
): CardPlacement[] {
  return cards.map((card) => (card.id === cardId ? { ...card, size } : card));
}

/**
 * 把某张卡片改成 `size` 后，它**实际**会占多少格。
 *
 * 因为卡片按顺序压实排布，尺寸不一定等于请求的尺寸：例如位于最后一列时
 * `2x1` 放不下，会被挪到下一行才摆得开。尺寸菜单用它避免给出「选了没反应」
 * 的选项 —— 那些选项算出来的实际尺寸和当前一模一样。
 */
export function effectiveSizeWith(
  cards: CardPlacement[],
  columns: number,
  cardId: string,
  size: CardSize,
): CardSize {
  const next = cards.map((card) => (card.id === cardId ? { ...card, size } : card));
  const entry = compactLayout(next, columns).find((item) => item.id === cardId);
  return entry ? spanToSize(entry.colSpan, entry.rowSpan) : size;
}

/* ---- React hook ---- */

/**
 * 按页面读取布局，并在编辑时持久化到 localStorage。
 *
 * 返回值刻意做成稳定引用：设备工作台每秒都会被新快照重渲染，
 * `commit` 如果每次渲染都是新函数，会连锁触发下游所有 useMemo / useEffect。
 */
const layoutCache = new Map<string, ReturnType<typeof createCardLayoutApi>>();

function createCardLayoutApi(username: string, page: LayoutPage) {
  const user = username || "default";
  // 编辑过之后，用户名变化触发的重新加载不应把改动冲掉。
  let edited = false;
  let current = loadLayout(user, page);
  const listeners = new Set<() => void>();

  const emit = () => listeners.forEach((listener) => listener());

  const api = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => current,
    commit(next: PageLayout) {
      edited = true;
      current = next;
      saveLayout(user, page, next);
      emit();
    },
    reset() {
      edited = false;
      resetLayout(user, page);
      current = defaultLayoutForPage(page);
      emit();
    },
    /** 用户名变化时重新读取，除非用户刚刚改过布局。 */
    reload() {
      if (edited) return;
      current = loadLayout(user, page);
      emit();
    },
  };
  return api;
}

function cardLayoutApi(username: string, page: LayoutPage) {
  const key = `${username || "default"}:${page}`;
  let api = layoutCache.get(key);
  if (!api) {
    api = createCardLayoutApi(username, page);
    layoutCache.set(key, api);
  }
  return api;
}

export function useCardLayout(username: string, page: LayoutPage) {
  const api = cardLayoutApi(username, page);
  const layout = useSyncExternalStore(api.subscribe, api.getSnapshot);

  useEffect(() => {
    api.reload();
  }, [api]);

  return { layout, commit: api.commit, reset: api.reset };
}
