/* 可编辑卡片栅格：拖动排序 / 右下角拖拽缩放 / 自适应列数与换行。
 *
 * 位置由 layoutStore.compactLayout 从「顺序 + 尺寸」算出来。拖动分两条线：
 * 被拖的卡片不进栅格布局，直接跟手（transform = 指针位置）；其余卡片按新顺序
 * 重排，并靠 CSS 过渡滑到新位置。松手时被拖卡片交回布局，位置正好对上。 */

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { GripVertical } from "lucide-react";

import type { CardPlacement, CardSize, PageLayout } from "../../softuiTypes";
import {
  cellToPoint,
  compactLayout,
  gridMetricsForWidth,
  nextSlot,
  pointToCell,
  resizeLayout,
  sizeFromDelta,
  slotPreview,
  spanForSize,
  type GridMetrics,
  type GridPoint,
} from "../../state/layoutStore";

/** 拖动超过这个距离才算拖拽，否则按点击处理（卡片内的输入框仍能正常点）。 */
const DRAG_THRESHOLD_PX = 4;

/** 两张卡片的顺序是否一致（只比 id，尺寸改动不算顺序变化）。 */
function sameOrder(a: CardPlacement[], b: CardPlacement[]): boolean {
  return a.length === b.length && a.every((card, index) => card.id === b[index].id);
}

/** 预览框上的尺寸标签，例如 `2x1`。 */
function sizeLabel(width: number, height: number, metrics: GridMetrics): string {
  const colSpan = Math.max(1, Math.round((width + metrics.gap) / (metrics.columnWidth + metrics.gap)));
  const rowSpan = Math.max(1, Math.round((height + metrics.gap) / (metrics.rowHeight + metrics.gap)));
  return `${colSpan}x${rowSpan}`;
}

interface DragSession {
  cardId: string;
  /** 按下瞬间的可见卡片顺序，用来在松手时把结果回填进完整布局。 */
  visibleIds: string[];
  metrics: GridMetrics;
  /** 栅格左上角相对视口的坐标。 */
  origin: { x: number; y: number };
  /** 指针相对被拖卡片左上角的偏移：卡片跟着指针走，不跳到光标中心。 */
  grabX: number;
  grabY: number;
  /** 被拖卡片的尺寸：拖动过程中不变，直接拿来渲染跟手的那一份。 */
  width: number;
  height: number;
  startX: number;
  startY: number;
  active: boolean;
  /** 让位算出来的顺序（去掉被拖卡片后再插回来），松手时按它提交。 */
  cards: CardPlacement[];
}

interface OverlayGeometry {
  cardId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CardGridProps {
  layout: PageLayout;
  /** 标题栏：右侧可放操作按钮。 */
  headerForCard?: (cardId: string) => { title: string; icon?: ReactNode; action?: ReactNode };
  childrenForCard: (cardId: string) => ReactNode;
  /** 卡片内容区的额外 class（例如 3D 场景需要无内边距）。 */
  bodyClassForCard?: (cardId: string) => string | undefined;
  /** 松手后提交新布局；不传时卡片只展示，不可拖动。 */
  onLayoutChange?: (next: PageLayout) => void;
  /** 布局的持久化标识，变化时跳过占位动画，避免整屏卡片一起飞。 */
  layoutKey?: string;
  ariaLabel?: string;
}

/**
 * 卡片栅格：按布局顺序渲染可见卡片，位置与尺寸由 layoutStore.compactLayout 算出。
 *
 * 列数与列宽由容器实测宽度决定（见 layoutStore.gridColumnsForWidth），
 * 所以窗口变窄时卡片会自动从 4 列换到 3 列、2 列，不需要媒体查询 ——
 * 换行是同一套逻辑的自然结果，布局数据里只存顺序和尺寸。
 */
export function CardGrid({
  layout,
  headerForCard,
  childrenForCard,
  bodyClassForCard,
  onLayoutChange,
  layoutKey,
  ariaLabel = "卡片布局",
}: CardGridProps) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragSession | null>(null);
  /** 缩放会话：起点像素、卡片左上角的偏移、起点尺寸，以及当前算出的目标尺寸。 */
  const resizeRef = useRef<{
    x: number;
    y: number;
    x0: number;
    y0: number;
    cardId: string;
    startSize: CardSize;
    size: CardSize;
  } | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [overlay, setOverlay] = useState<OverlayGeometry | null>(null);
  const [animating, setAnimating] = useState(true);
  /**
   * 拖动中的卡片顺序（state 而不是 ref）：其余卡片要按它重新排布，
   * 靠 CSS 过渡滑到新位置，所以必须触发重渲染。
   *
   * 注意这里**保留**被拖那张卡片 —— 它在布局里占着的槽位就是「空位」，
   * 顺序一变，空位跟着指针走，后面的卡片依次补上，这才是让位动画。
   * （若把它从布局里摘掉，其余卡片会恒定地压到最前面，怎么拖都不动。）
   */
  const [dragOrder, setDragOrder] = useState<CardPlacement[] | null>(null);
  /** 落点指示器的几何（拖动时那一格是空的，用它标出会落在哪）。 */
  const [preview, setPreview] = useState<Omit<OverlayGeometry, "cardId"> | null>(null);
  /** 缩放预览框：拖动中不写布局，先把目标大小画出来。 */
  const [resizePreview, setResizePreview] = useState<OverlayGeometry | null>(null);

  const visible = useMemo(() => layout.cards.filter((card) => card.visible), [layout.cards]);
  const placed = dragOrder ?? visible;
  const editable = Boolean(onLayoutChange);

  const baseMetrics = useMemo(() => gridMetricsForWidth(box.width), [box.width]);
  const entries = useMemo(
    () => compactLayout(placed, baseMetrics.columns),
    [placed, baseMetrics.columns],
  );
  const entryById = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const rowCount = entries.reduce((rows, entry) => Math.max(rows, entry.row + entry.rowSpan), 0);

  /**
   * 行高：把可视区高度按行数均分，等价于原来 grid 的 `minmax(150px, 1fr)`。
   *
   * 用的是可视区高度而不是栅格自身高度 —— 栅格里全是绝对定位的卡片，
   * 自身高度恒为内容高度，拿它当基准会变成「越高越撑」的正反馈。
   * 下限 150 与原来的 minmax 一致（放不下就交给滚动区）；上限只是兜底，
   * 免得用户把卡片全调成一行时，那一行被拉成整屏高的一条。
   */
  const metrics = useMemo(() => {
    if (box.height <= 0 || rowCount <= 0) return baseMetrics;
    const available = box.height - (rowCount - 1) * baseMetrics.gap;
    const rowHeight = Math.max(150, Math.min(400, Math.floor(available / rowCount)));
    return { ...baseMetrics, rowHeight };
  }, [baseMetrics, box.height, rowCount]);

  const contentHeight = rowCount > 0
    ? rowCount * metrics.rowHeight + (rowCount - 1) * metrics.gap
    : 0;

  /**
   * 可用区：
   * - 宽度取栅格自己的 clientWidth。卡片全是绝对定位的子元素，栅格作为普通
   *   块级元素的宽度只由父级的内容宽决定，**不受内容影响**，量一次就准。
   * - 高度取「栅格顶边 → 可视区底边」。因为栅格的高度由 CardGrid 自己按行数
   *   写进行内样式，用量自身高度会形成「越高越撑」的正反馈；而顶边位置由
   *   前面的兄弟节点和外边距决定，与栅格自身高度无关。
   */
  useLayoutEffect(() => {
    const element = gridRef.current;
    if (!element) return;
    const viewport = element.closest<HTMLElement>("[data-card-grid-viewport]") ?? element.parentElement ?? element;
    const measure = () => {
      const gridRect = element.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      setBox({
        width: element.clientWidth,
        height: Math.max(0, viewport.clientHeight - (gridRect.top - viewportRect.top)),
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  // 占位动画只在布局整体切换（换设备 / 切标签）时跳过；拖动提交仍然要动。
  useEffect(() => {
    setAnimating(false);
    const timer = window.setTimeout(() => setAnimating(true), 80);
    return () => window.clearTimeout(timer);
  }, [layoutKey]);

  // 首帧还没量出宽度，先把过渡关掉，避免卡片从 (0,0) 飞到初始位置。
  useEffect(() => {
    if (box.width > 0) return;
    setAnimating(false);
  }, [box.width]);

  useEffect(() => () => {
    document.body.classList.remove("card-dragging");
  }, []);

  const gridStyle = {
    "--card-col-width": `${metrics.columnWidth}px`,
    "--card-row-height": `${metrics.rowHeight}px`,
    "--card-gap": `${metrics.gap}px`,
    height: contentHeight > 0 ? `${contentHeight}px` : undefined,
  } as CSSProperties;

  const geometryFor = (cardId: string) => {
    const entry = entryById.get(cardId);
    if (!entry) return null;
    const point = cellToPoint({ row: entry.row, col: entry.col }, metrics);
    return {
      x: point.x,
      y: point.y,
      width: entry.colSpan * metrics.columnWidth + (entry.colSpan - 1) * metrics.gap,
      height: entry.rowSpan * metrics.rowHeight + (entry.rowSpan - 1) * metrics.gap,
    };
  };

  /**
   * 让位判定用的命中点：被拖卡片的**中心**，不是指针位置。
   *
   * 指针停在卡片的抓取点上（一般是标题栏，也就是卡片顶部），比中心高半张卡片；
   * 拿指针去命中，纵向就得把整张卡片拖出屏幕才能越过一行 —— 大卡片上几乎不可能，
   * 表现的就像「只能跨列不能跨行」。用中心点，卡片压到哪一行就命中哪一行。
   */
  const dropPoint = (
    session: DragSession,
    event: ReactPointerEvent<HTMLElement>,
  ): GridPoint => pointToCell(
    event.clientX - session.origin.x - session.grabX + session.width / 2,
    event.clientY - session.origin.y - session.grabY + session.height / 2,
    session.metrics,
  );

  /** 落点指示器：就画在被拖卡片当前占的那个空位上。 */
  const previewFor = (order: CardPlacement[], cardId: string) => {
    const slot = slotPreview(order, metrics.columns, cardId);
    if (!slot) return null;
    const pixel = cellToPoint({ row: slot.row, col: slot.col }, metrics);
    return {
      x: pixel.x,
      y: pixel.y,
      width: slot.colSpan * metrics.columnWidth + (slot.colSpan - 1) * metrics.gap,
      height: slot.rowSpan * metrics.rowHeight + (slot.rowSpan - 1) * metrics.gap,
    };
  };

  const beginDrag = (event: ReactPointerEvent<HTMLElement>, cardId: string) => {
    if (!editable || event.button !== 0) return;
    const entry = entryById.get(cardId);
    if (!entry) return;
    event.preventDefault();
    event.stopPropagation();

    const bounds = gridRef.current?.getBoundingClientRect();
    const origin = bounds ? { x: bounds.left, y: bounds.top } : { x: 0, y: 0 };
    const rect = cellToPoint({ row: entry.row, col: entry.col }, metrics);
    // 指针相对卡片左上角的偏移：拖动时保持这个偏移，卡片就「抓哪儿跟哪儿」。
    dragRef.current = {
      cardId,
      visibleIds: visible.map((card) => card.id),
      metrics,
      origin,
      grabX: event.clientX - origin.x - rect.x,
      grabY: event.clientY - origin.y - rect.y,
      width: entry.colSpan * metrics.columnWidth + (entry.colSpan - 1) * metrics.gap,
      height: entry.rowSpan * metrics.rowHeight + (entry.rowSpan - 1) * metrics.gap,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      cards: visible,
    };
  };

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const session = dragRef.current;
    if (!session) return;

    if (!session.active) {
      const distance = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
      if (distance < DRAG_THRESHOLD_PX) return;
      session.active = true;
      setDragOrder(session.cards);
      setPreview(previewFor(session.cards, session.cardId));
      document.body.classList.add("card-dragging");
      event.currentTarget.setPointerCapture(event.pointerId);
    }

    // 1) 卡片跟手：直接用指针坐标（减去按下时的抓取偏移），不做格子吸附。
    setOverlay({
      cardId: session.cardId,
      x: event.clientX - session.origin.x - session.grabX,
      y: event.clientY - session.origin.y - session.grabY,
      width: session.width,
      height: session.height,
    });

    // 2) 让位：被拖卡片的**中心**压到哪张卡片上，就把它挤到那个槽位。
    const cell = dropPoint(session, event);
    const step = nextSlot(session.cards, session.metrics.columns, session.cardId, cell);
    if (!step.changed) return;
    session.cards = step.cards;
    setDragOrder(step.cards);
    // 让位会把空位挪到别处 —— 指示器必须跟着走，否则会留在一个早已填满的格子上。
    setPreview(previewFor(step.cards, session.cardId));
  };

  const endDrag = (cancelled = false) => {
    const session = dragRef.current;
    if (!session) return;
    dragRef.current = null;
    setOverlay(null);
    setPreview(null);
    setDragOrder(null);
    document.body.classList.remove("card-dragging");
    if (!session.active || cancelled || !onLayoutChange) return;

    // 回填进完整布局：可见卡片按新顺序占原来的槽位，隐藏卡片留在原地。
    const visibleIds = new Set(session.visibleIds);
    let cursor = 0;
    const merged = layout.cards.map((card) => (visibleIds.has(card.id) ? session.cards[cursor++] : card));
    // 顺序没变就不用提交（拖回原位）。比的是**当前渲染的顺序**，
    // 不能比拖动中间态 `placed` —— 那正是要提交的内容，会永远判定为重复。
    if (sameOrder(merged, layout.cards)) return;
    onLayoutChange({ ...layout, cards: merged });
  };

  /**
   * 缩放 = 从右下角往外拖，拖出多大就有多大。
   *
   * 拖动过程**不写布局**，只更新预览框：框画在卡片左上角处，随拖拽实时放大
   * 缩小，所以「拖到一半松手」也不会留下半截尺寸。松手才把目标尺寸提交给布局，
   * 其余卡片随即重新压实（该换列的换列、该换行的换行）—— 那一下带 CSS 过渡，
   * 就是让位动画。
   */
  const resizeTo = (dx: number, dy: number) => {
    const start = resizeRef.current;
    if (!start) return;
    const size = sizeFromDelta(start.startSize, metrics.columns, dx, dy, metrics.columnWidth, metrics.rowHeight, metrics.gap);
    const span = spanForSize(size, metrics.columns);
    start.size = size;
    setResizePreview({
      cardId: start.cardId,
      x: start.x0,
      y: start.y0,
      width: span.colSpan * metrics.columnWidth + (span.colSpan - 1) * metrics.gap,
      height: span.rowSpan * metrics.rowHeight + (span.rowSpan - 1) * metrics.gap,
    });
  };

  const resizeStart = (event: ReactPointerEvent<HTMLElement>) => {
    if (!editable || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const cardId = event.currentTarget.dataset.cardId ?? "";
    const card = layout.cards.find((item) => item.id === cardId);
    const entry = entryById.get(cardId);
    if (!card || !entry) return;
    const origin = cellToPoint({ row: entry.row, col: entry.col }, metrics);
    // 指针必须捕获在把手自己身上，后续 move/up 才会继续回到这里。
    resizeRef.current = {
      x: event.clientX,
      y: event.clientY,
      x0: origin.x,
      y0: origin.y,
      cardId,
      // 尺寸按「相对按下时」的位移算，不是逐帧累加，才不会漂。
      size: card.size,
      startSize: card.size,
    };
    setResizePreview({
      cardId,
      x: origin.x,
      y: origin.y,
      width: entry.colSpan * metrics.columnWidth + (entry.colSpan - 1) * metrics.gap,
      height: entry.rowSpan * metrics.rowHeight + (entry.rowSpan - 1) * metrics.gap,
    });
    document.body.classList.add("card-resizing");
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const resizeMove = (event: ReactPointerEvent<HTMLElement>) => {
    const start = resizeRef.current;
    if (!start) return;
    resizeTo(event.clientX - start.x, event.clientY - start.y);
  };

  const resizeEnd = () => {
    const start = resizeRef.current;
    resizeRef.current = null;
    setResizePreview(null);
    document.body.classList.remove("card-resizing");
    if (!start || !onLayoutChange) return;
    // 松手才提交：其余卡片按新尺寸重新压实，带过渡滑过去。
    const next = resizeLayout(layout.cards, start.cardId, start.size);
    if (next.every((card, at) => card.size === layout.cards[at].size)) return;
    setAnimating(true);
    onLayoutChange({ ...layout, cards: next });
  };

  return (
    <div
      className={`card-grid feature-card-grid${editable ? " is-editable" : ""}${animating ? " is-animating" : ""}`}
      aria-label={ariaLabel}
      ref={gridRef}
      style={gridStyle}
    >
      {visible.map((card) => {
        const header = headerForCard?.(card.id);
        const bodyClass = bodyClassForCard?.(card.id);
        const dragging = overlay?.cardId === card.id;
        // 被拖的卡片不进栅格布局：它的位置/尺寸由 overlay 直接给，才会跟手。
        const geometry = dragging ? overlay : geometryFor(card.id);
        return (
          <article
            className={`feature-card${dragging ? " is-dragging" : ""}${editable ? " is-editable" : ""}`}
            key={card.id}
            role="region"
            aria-label={header?.title}
            style={geometry
              ? {
                transform: `translate(${geometry.x}px, ${geometry.y}px)`,
                width: `${geometry.width}px`,
                height: `${geometry.height}px`,
              }
              : undefined}
          >
            {header ? (
              <header
                className={`feature-card-header${editable ? " is-draggable" : ""}`}
                onPointerDown={editable ? (event) => beginDrag(event, card.id) : undefined}
                onPointerMove={editable ? moveDrag : undefined}
                onPointerUp={editable ? () => endDrag() : undefined}
                onPointerCancel={editable ? () => endDrag(true) : undefined}
              >
                <div>
                  {editable ? <GripVertical className="feature-card-grip" aria-hidden="true" size={14} /> : null}
                  {header.icon}
                  <h2>{header.title}</h2>
                </div>
                <div className="feature-card-action">
                  {header.action}
                </div>
              </header>
            ) : null}
            <div className={`feature-card-body${bodyClass ? ` ${bodyClass}` : ""}`}>
              {childrenForCard(card.id)}
            </div>

            {editable ? (
              <div
                className="card-resize-handle"
                data-card-id={card.id}
                onPointerCancel={resizeEnd}
                onPointerDown={resizeStart}
                onPointerMove={resizeMove}
                onPointerUp={resizeEnd}
                role="presentation"
                title="拖拽调整卡片大小"
              />
            ) : null}
          </article>
        );
      })}

      {resizePreview ? (
        <div
          aria-hidden="true"
          className="card-resize-preview"
          style={{
            transform: `translate(${resizePreview.x}px, ${resizePreview.y}px)`,
            width: `${resizePreview.width}px`,
            height: `${resizePreview.height}px`,
          }}
        >
          <span>{sizeLabel(resizePreview.width, resizePreview.height, metrics)}</span>
        </div>
      ) : null}

      {preview ? (
        <div
          aria-hidden="true"
          className="card-drop-preview"
          style={{
            transform: `translate(${preview.x}px, ${preview.y}px)`,
            width: `${preview.width}px`,
            height: `${preview.height}px`,
          }}
        />
      ) : null}
    </div>
  );
}
