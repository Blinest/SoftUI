import { useEffect } from "react";

/**
 * 3D 倾斜的最大角度（光标到卡片角上的极限值）。
 *
 * 最初按需求上限取了 3.5 度，实测偏大 —— 卡片一大，倾斜就越看越晃眼。
 * 收到"倾斜角太大"的反馈后降到 2 度：既是"轻微 3D"的体感，又不至于让内容看起来在歪。
 * 想再调：这个数直接改，0 就是关掉倾斜。
 */
const MAX_TILT_DEG = 2;
/** 移除光标后"平滑复原"的时长。 */
const RESTORE_MS = 360;

/**
 * 卡片跟随光标的三个效果（全局一份委托监听，不挂 React 状态）：
 *
 * 1. 径向光斑跟随光标 → 写 `--tilt-px` / `--tilt-py`
 * 2. 靠近光标的边框局部提亮 → 同一组坐标，由 CSS 的径向渐变负责
 * 3. 轻微 3D 倾斜（≤ `MAX_TILT_DEG` 度）→ 写 `--tilt-rx` / `--tilt-ry`
 *
 * **为什么直接写 style 而不是 setState**：指针每帧都在动，走 React 会让卡片所在
 * 页面的整棵子树跟着重渲染 —— 图表、输入框、3D 场景都会被反复打断。这里只改被悬停
 * 那张卡的 4 个自定义属性，React 完全不知情。
 *
 * **为什么用 window 上的事件委托**：卡片是动态增删的（换页签、权限过滤、拖动重排），
 * 逐张挂监听就要处理挂载/卸载/重排三件事，很容易漏一个。一份委托最简单也最不容易出错。
 *
 * **为什么倾斜能用 `transform` 而位置不行**：CardGrid 的卡片位置是**行内**样式，
 * 行内 `transform` 会压过 CSS；所以那边改用独立的 `translate` 属性，把 CSS 的
 * `transform` 让给倾斜。`.tilt-card` 里不写 `transition`，是因为 CardGrid 有一批
 * `transition: none` / `transition: transform 200ms ...` 的简写规则在控制滑位动画，
 * 会把这层的过渡一并接管或吃掉。所以复原动画在这里自己算，两端互不依赖。
 */
export function useCardTilt() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    /** 当前被悬停的卡片，以及它的倾斜角 —— 复原动画要从这个角度往回走。 */
    let current: HTMLElement | null = null;
    let tiltX = 0;
    let tiltY = 0;
    /** 每张卡片各自的复原动画。快速划过好几张时会有多个同时在跑，必须分别能取消。 */
    const restores = new Map<HTMLElement, number>();

    const write = (card: HTMLElement, x: number, y: number) => {
      card.style.setProperty("--tilt-rx", `${x.toFixed(3)}deg`);
      card.style.setProperty("--tilt-ry", `${y.toFixed(3)}deg`);
    };

    const cancelRestore = (card: HTMLElement) => {
      const frame = restores.get(card);
      if (frame === undefined) return;
      cancelAnimationFrame(frame);
      restores.delete(card);
    };

    /** 平滑复原：把角度送回 0，收尾再摘掉自定义属性（避免留个 0.001deg 的残影）。 */
    const restore = (card: HTMLElement, fromX: number, fromY: number) => {
      cancelRestore(card);
      if (reduceMotion) {
        card.style.removeProperty("--tilt-rx");
        card.style.removeProperty("--tilt-ry");
        return;
      }
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / RESTORE_MS);
        // easeOutCubic：起步快、收尾软，观感与页面里其它过渡一致
        const eased = 1 - Math.pow(1 - t, 3);
        write(card, fromX * (1 - eased), fromY * (1 - eased));
        if (t < 1) {
          restores.set(card, requestAnimationFrame(step));
        } else {
          restores.delete(card);
          card.style.removeProperty("--tilt-rx");
          card.style.removeProperty("--tilt-ry");
        }
      };
      restores.set(card, requestAnimationFrame(step));
    };

    const onPointerMove = (event: PointerEvent) => {
      const target = event.target;
      const card =
        target instanceof Element ? (target.closest(".tilt-card") as HTMLElement | null) : null;

      if (card !== current) {
        // 换目标了：把上一张送回原位，然后从 0 开始接手新的一张。
        if (current) restore(current, tiltX, tiltY);
        current = card;
        tiltX = 0;
        tiltY = 0;
        // 新的这张可能正处在退场动画里，先取消，否则会被旧动画拉回去。
        if (card) cancelRestore(card);
      }
      if (!card) return;

      const box = card.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return;

      // 归一化到 0..1，并夹住：指针略微越出卡片边缘时不要算出夸张的角度。
      const px = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
      const py = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));

      card.style.setProperty("--tilt-px", `${(px * 100).toFixed(2)}%`);
      card.style.setProperty("--tilt-py", `${(py * 100).toFixed(2)}%`);

      if (reduceMotion) return;

      // 光标偏右 → 右边缘"压下去" → rotateY 取负；偏下 → 下边缘压下去 → rotateX 取正。
      // 幅度与"到中心的距离"成正比，正好在正中时为 0。
      tiltX = (py - 0.5) * 2 * MAX_TILT_DEG;
      tiltY = (0.5 - px) * 2 * MAX_TILT_DEG;
      write(card, tiltX, tiltY);
    };

    // 指针在卡片内部元素之间移动不算离开：relatedTarget 还落在同一张卡里。
    const onPointerOut = (event: PointerEvent) => {
      const related = event.relatedTarget;
      if (related instanceof Element && related.closest(".tilt-card") === current) return;
      if (current) restore(current, tiltX, tiltY);
      current = null;
      tiltX = 0;
      tiltY = 0;
    };

    /**
     * 指针移出窗口 / 窗口失焦时不会有 pointermove，得单独兜底 ——
     * 否则卡片会一直歪着不回来。
     */
    const onReset = () => {
      if (current) restore(current, tiltX, tiltY);
      current = null;
      tiltX = 0;
      tiltY = 0;
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerout", onPointerOut, { passive: true });
    window.addEventListener("blur", onReset);
    document.addEventListener("pointerleave", onReset);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerout", onPointerOut);
      window.removeEventListener("blur", onReset);
      document.removeEventListener("pointerleave", onReset);
      restores.forEach((frame) => cancelAnimationFrame(frame));
      restores.clear();
    };
  }, []);
}
