import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** 滑块相对容器内容盒的矩形（已把容器自身的滚动偏移算进去）。 */
export interface SlidingIndicatorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function sameRect(a: SlidingIndicatorRect | null, b: SlidingIndicatorRect | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * 菜单「滑块」：让选中背景在菜单项之间**连续移动**，位置与尺寸都跟着目标走。
 *
 * ```tsx
 * const { containerRef, setItemRef, rect } = useSlidingIndicator<string, HTMLDivElement>(activeKey);
 * return (
 *   <div ref={containerRef} className="menu">
 *     <SlidingIndicator rect={rect} />
 *     {items.map((item) => (
 *       <button key={item.key} ref={setItemRef(item.key)} className={item.key === activeKey ? "is-active" : ""} />
 *     ))}
 *   </div>
 * );
 * ```
 *
 * 三条必须守住的点，都是踩过的坑：
 *
 * 1. **同一个元素、同一组属性**。位置只走 `transform`、尺寸只走 `width` / `height`，
 *    全程只改这一个节点的这几个属性。浏览器在过渡**中途**收到新的目标值时，会自动从
 *    **当前计算值**接着走 —— 所以快速连点不会回弹、不会先跳回起点、不会重置。
 *    换成 `animation` + keyframes、或每次切换重新挂载节点，都拿不到这个行为。
 *
 * 2. **不碰文字**。滑块是独立的一层（绝对定位、压在菜单项之下），菜单项的 padding、
 *    字号、字重一概不动。任何「选中就加粗」的写法都会让文字重新排版、每个字的宽度跳一下，
 *    那才是文字不稳定的来源 —— 只能从菜单项自身去掉，滑块这边无能为力。
 *
 * 3. **不写死位置**。每次提交后都重新测一次，所以侧栏折叠、权限变化导致菜单项增减、
 *    字体加载完成、窗口缩放，都能自动跟上。测出来没变就不 setState，
 *    否则会变成「测量 → 渲染 → 再测量」的自激循环。
 */
export function useSlidingIndicator<K extends string, E extends HTMLElement = HTMLElement>(
  activeKey: K | null | undefined,
) {
  const containerRef = useRef<E | null>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const refCallbacks = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const currentRef = useRef<SlidingIndicatorRect | null>(null);
  const [rect, setRect] = useState<SlidingIndicatorRect | null>(null);

  const measure = useCallback(() => {
    const container = containerRef.current;
    const item = activeKey == null ? undefined : itemRefs.current.get(activeKey);
    if (!container || !item) {
      // 当前项不存在（还没渲染 / 被权限过滤掉了）：收起来，别停在上一处误导人。
      if (currentRef.current !== null) {
        currentRef.current = null;
        setRect(null);
      }
      return;
    }

    const box = container.getBoundingClientRect();
    const target = item.getBoundingClientRect();
    // getBoundingClientRect 是视口坐标，容器自身滚动不会体现在两个 rect 的差值里；
    // 但绝对定位子元素挂在容器的**内容坐标系**上，所以要把滚动量加回去。
    // clientLeft / clientTop 是容器边框宽度（这里都是 0，但留着更稳）。
    const next: SlidingIndicatorRect = {
      x: target.left - box.left - container.clientLeft + container.scrollLeft,
      y: target.top - box.top - container.clientTop + container.scrollTop,
      width: target.width,
      height: target.height,
    };
    if (sameRect(currentRef.current, next)) return;
    currentRef.current = next;
    setRect(next);
  }, [activeKey]);

  // 故意不写依赖数组：折叠、菜单项增减、字体加载都发生在**提交之后**，
  // 只在 activeKey 变化时测会漏掉这些"布局变了但选中项没变"的情况。
  useLayoutEffect(() => {
    measure();
  });

  useEffect(() => {
    const container = containerRef.current;
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    // 容器尺寸变化不一定由 React 提交触发（例如外层栅格随窗口变化），补一个观察器。
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onResize);
    // 观察 content-box 而不是默认的 border-box：滚动条出现/消失会改变内容宽度
    // （菜单项跟着变窄），但容器自身尺寸没变，只有 content-box 能捕捉到这种情况。
    if (container) observer?.observe(container, { box: "content-box" });
    return () => {
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
    };
  }, [measure]);

  // ref 回调必须按 key 缓存下来。每次渲染都传一个新函数，React 会先 detach 再 attach，
  // 白白多一轮布局，还可能让测到的矩形闪一下。
  const setItemRef = useCallback((key: string) => {
    let callback = refCallbacks.current.get(key);
    if (!callback) {
      callback = (element: HTMLElement | null) => {
        if (element) itemRefs.current.set(key, element);
        else itemRefs.current.delete(key);
      };
      refCallbacks.current.set(key, callback);
    }
    return callback;
  }, []);

  return { containerRef, setItemRef, rect };
}

/** 拉伸手感参数。都集中在这里，方便按实际观感调。 */
const STRETCH = {
  /** 速度到达该值（px/s）时拉到最大。越小越"灵敏"。 */
  speedRef: 1500,
  /** 最大额外拉伸比例：0.32 = 最多拉长 32%。 */
  max: 0.32,
  /** 弹簧刚度：越大回得越快、越"紧"。 */
  stiffness: 320,
  /** 阻尼：越小越弹。阻尼比 ζ = damping / (2·√stiffness)，
   *  16 / (2·√320) ≈ 0.45 —— 会明显过冲一下再收住，但不会来回晃。 */
  damping: 16,
  /** 与移动方向垂直的那一维压扁多少（0 = 不压扁）。 */
  squash: 0.45,
};

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function centerOf(element: HTMLElement): { x: number; y: number } {
  const box = element.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

export interface SlidingIndicatorProps {
  rect: SlidingIndicatorRect | null;
}

/**
 * 滑块本体。分两层：
 *
 * - **外壳 `.nav-sliding-indicator`**：只负责"在哪、多大"。位置与尺寸交给 CSS 过渡，
 *   所以中途换目标会从当前值接着走。
 * - **胶囊 `.nav-sliding-indicator__capsule`**：视觉（半透明玻璃 + 边缘细高光），
 *   并且由 JS 逐帧写 `transform: scale()` 做**沿移动方向的拉伸**，以及到位的**弹性回弹**。
 *
 * 两层分开是必要的：位置用 CSS 过渡（才能"接着走"），形变用弹簧（才能"弹"），
 * 两者的时间曲线不一样，塞进同一个 transform 会互相干扰。
 *
 * `rect` 为 null（没有选中项）时**不渲染** —— 这样它第一次出现就是"就地画好"，
 * 不会从容器左上角滑进来。
 */
export function SlidingIndicator({ rect }: SlidingIndicatorProps) {
  const shellRef = useRef<HTMLSpanElement | null>(null);
  const capsuleRef = useRef<HTMLSpanElement | null>(null);
  // 弹簧状态放在 ref 里：外壳每次测到新矩形都会重建 effect，
  // 状态要是放在 effect 内部就会被重置，快速连点时形变会一跳一跳的。
  const motion = useRef({
    stretch: 1,
    velocity: 0,
    centerX: 0,
    centerY: 0,
    time: 0,
    primed: false,
  });

  useEffect(() => {
    const shell = shellRef.current;
    const capsule = capsuleRef.current;
    if (!shell || !capsule || !rect || prefersReducedMotion()) return;

    const state = motion.current;
    if (!state.primed) {
      const center = centerOf(shell);
      state.centerX = center.x;
      state.centerY = center.y;
      state.time = performance.now();
      state.primed = true;
    }

    let frameId = 0;
    let idleFrames = 0;

    const step = (now: number) => {
      // dt 必须夹住：标签页切走再回来时 now - time 会是好几秒，
      // 不夹的话弹簧一次积分就飞出去了。
      const dt = Math.min(0.05, Math.max(0.001, (now - state.time) / 1000));
      state.time = now;

      const center = centerOf(shell);
      const velocityX = (center.x - state.centerX) / dt;
      const velocityY = (center.y - state.centerY) / dt;
      state.centerX = center.x;
      state.centerY = center.y;

      const speed = Math.hypot(velocityX, velocityY);
      const target = 1 + Math.min(1, speed / STRETCH.speedRef) * STRETCH.max;
      // 欠阻尼弹簧追目标。目标掉回 1 时弹簧还带着速度，于是过冲、再收 ——
      // 那一下就是"到位弹性回弹"。用 CSS 的 transition 做不出这个（它是单调收敛的）。
      state.velocity +=
        (-STRETCH.stiffness * (state.stretch - target) - STRETCH.damping * state.velocity) * dt;
      state.stretch += state.velocity * dt;

      const along = Math.max(1, state.stretch);
      const across = 1 - (along - 1) * STRETCH.squash;
      const horizontal = Math.abs(velocityX) >= Math.abs(velocityY);
      capsule.style.transform = horizontal
        ? `scale(${along.toFixed(4)}, ${across.toFixed(4)})`
        : `scale(${across.toFixed(4)}, ${along.toFixed(4)})`;

      const settled =
        speed < 1 &&
        Math.abs(state.stretch - 1) < 0.002 &&
        Math.abs(state.velocity) < 0.01;
      idleFrames = settled ? idleFrames + 1 : 0;

      if (idleFrames < 3) {
        frameId = window.requestAnimationFrame(step);
      } else {
        // 收尾把形变归零：留着 0.999 这种亚像素缩放会让边缘和文字发糊。
        state.stretch = 1;
        state.velocity = 0;
        capsule.style.transform = "";
      }
    };

    frameId = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frameId);
  }, [rect]);

  if (!rect) return null;

  return (
    <span
      aria-hidden="true"
      className="nav-sliding-indicator"
      ref={shellRef}
      style={{
        transform: `translate(${rect.x}px, ${rect.y}px)`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      }}
    >
      <span className="nav-sliding-indicator__capsule" ref={capsuleRef} />
    </span>
  );
}
