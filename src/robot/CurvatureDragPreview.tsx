/* 拖动式曲率控制：在三维视图里点住臂体拖动，反解出曲率分布。
 *
 * ── 交互 ──
 *
 * 左键点住臂身任意位置即可拖动（面板上的「拖动编辑」开关关闭时不拦截，
 * 鼠标仍然交给 OrbitControls 转视角 —— 只靠左/右键区分会和平移冲突）。
 * 按下时用射线在**当前显示的那条曲线**上找最近采样点，记下它的弧长 s；
 * 拖动时把该点投向一条过原抓取点、法线朝相机的平面，得到目标位置，
 * 交给 curvatureDrag.solveDragToPoint 反解。
 *
 * ── 拾取与反解都跟着「显示的那条曲线」走 ──
 *
 * 有目标时画面显示目标形状，没有才显示实际形状。拾取和反解基准都必须用
 * 同一个来源，否则会出现「点不中臂」（射线追实际、画面画目标，两者岔开）
 * 和「一拖就跳」（抓取点在目标上、基准却是实际）这两种症状。
 *
 * 反解本身是**绝对**的：目标位置由固定平面上的指针位置直接给出，不是逐帧
 * 累加，所以指针抖动不会累积漂移；清空目标时又会平滑回落到实际形状。
 *
 * 指针事件挂在 renderer.domElement 上并走 pointercapture，所以拖出画布
 * 也不会丢事件；指针一旦被捕获就临时关掉 OrbitControls。
 *
 * ── 为什么单独一个组件，而不是给 RobotScene 加开关 ──
 *
 * RobotScene 是监控页只读卡片，每秒随快照重渲染；把拾取、拖拽会话、
 * 目标/实际双轨平滑塞进去会同时污染只读语义和那条高频渲染路径。
 * 这里复用的只是同一套几何（skinnedArm / cables / kinematics）。 */

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { BackboneOutput, CurvatureDistribution } from "../dynamics/svcModel";
import { buildBackboneFromCurvatureDistribution, mapSvcPointToThreeMm } from "../dynamics/svcModel";
import { solveDragToPoint } from "../dynamics/curvatureDrag";
import { createSlottedSkinnedArm } from "./skinnedArm";
import { createCableVisuals } from "./cables";
import { dampBackbone, updateBoneChainFromBackbone } from "./kinematics";

/** 臂体几何参数，和 RobotScene 保持同一套取值。 */
const GEOMETRY = {
  lengthMm: 404.8927,
  radiusMm: 8.31,
  radialSegments: 72,
  axialSegments: 220,
  slotPitchMm: 24.2,
  slotDuty: 0.42,
  boneCount: 32,
} as const;

/** 拖动前后差异小于这个量（mm）就当没动，避免抖动时反复触发回调。 */
/**
 * 拖拽的启动阈值（屏幕像素）。
 *
 * 光靠下面那个"世界坐标位移 ≥ 0.4mm"是**拦不住点击的**：`toMm` 用的是指针
 * 在拖拽平面上的投影位置，不是指针的位移量，所以按下之后第一次 pointermove
 * 哪怕只抖 1px，投影点也会从"抓取点"跳到"指针处"，产生一个真实且往往
 * 不小的位移 —— 实测点击一下就能把峰值曲率从 5.84 改到 5.44。
 *
 * 必须先在**屏幕空间**确认这是拖动而不是点击，之后才允许反解。
 * 4px 与 CardGrid 的卡片拖动保持一致。
 */
const DRAG_THRESHOLD_PX = 4;

/** 世界坐标下的最小更新步长，避免抖动时反复触发回调。 */
const MIN_TARGET_DELTA_MM = 0.4;

/** 射线命中阈值：按臂半径给一点余量，细管子也点得中。 */
const PICK_THRESHOLD_MM = GEOMETRY.radiusMm * 1.6;

interface DragSession {
  pointerId: number;
  /** 按下时的指针位置（视口坐标），用来判断是否越过拖动阈值。 */
  startX: number;
  startY: number;
  /** 是否已经越过阈值、开始真正拖动。 */
  active: boolean;
  /** 抓取点沿臂的弧长（mm）。 */
  sMm: number;
  /** 按下时抓取点所在位置（场景坐标，mm），拖拽平面过这一点。 */
  anchor: THREE.Vector3;
  /**
   * 按下瞬间「射线 ∩ 拖拽平面」的位置。
   *
   * 它和 `anchor` 一般**不重合**：`anchor` 是臂上离射线最近的采样点，射线
   * 可能从旁边擦过（命中阈值给了 13mm 余量）。反解要的是「抓取点相对按下时
   * 移动了多少」，所以必须以这个投影点为基准做差 —— 直接拿 `hitPoint` 当作
   * 目标位置的话，一越过阈值就等于被要求把一个十几毫米的偏移量一次性补上，
   * 表现为起步时臂突然窜一下（实测 4px 的位移产生了本该 20 多 px 才有的形变）。
   */
  grabPoint: THREE.Vector3;
  /** 拖拽平面：法线朝相机，保证「拖动方向 = 屏幕方向」。 */
  plane: THREE.Plane;
}

export interface CurvatureDragPreviewProps {
  /** 实际曲率状态（monitor 里那份 backbone）。 */
  actual: BackboneOutput;
  /** 拖动编辑出的目标分布；`null` 表示尚未编辑，显示实际形状。 */
  target: CurvatureDistribution | null;
  /** 编辑开关：关闭时完全不接管指针，视图保持纯 OrbitControls。 */
  enabled: boolean;
  showCables?: boolean;
  onTargetChange: (target: CurvatureDistribution | null) => void;
}

/**
 * 可拖动的三维曲率编辑器。
 *
 * 组件只负责「指针 → 目标位置 → 反解 → 回调」这条链路；目标形状的持有
 * 在父组件（面板），因为发送命令时还要读它。
 */
export function CurvatureDragPreview({
  actual,
  target,
  enabled,
  showCables = true,
  onTargetChange,
}: CurvatureDragPreviewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  /** 最新输入。渲染循环与指针回调都从这里读，避免重建整个场景。 */
  const inputRef = useRef({ actual, enabled });
  inputRef.current = { actual, enabled };
  const onChangeRef = useRef(onTargetChange);
  onChangeRef.current = onTargetChange;

  const [dragging, setDragging] = useState(false);
  const [saturated, setSaturated] = useState(false);

  // 指针回调与渲染循环都定义在下面这个 effect 里；它们需要读到最新的 target，
  // 但 target 每帧都在变，不能进依赖数组（否则场景会被反复销毁重建）。
  //
  // 这里存的是**目标骨骼**而不是原始分布：拾取要在显示曲线上找最近点，
  // 正解一次是必须的，而反解也要用同一份骨骼作基准 —— 两者共用，
  // 「射线打到哪条曲线」和「从哪条曲线开始解」就永远是一致的。
  const targetBackbone = useMemo(
    () => (target ? buildBackboneFromCurvatureDistribution(target) : null),
    [target],
  );
  const targetRef = useRef(targetBackbone);
  targetRef.current = targetBackbone;

  // 开关变化时同步视图锁定。OrbitControls 实例建在下面那个 effect 里，
  // 这里用 ref 把「锁定函数」交出去 —— 避免两个 effect 之间传实例引用，
  // 也避免把会变的东西塞进场景 effect 的依赖数组把场景重建掉。
  const lockRef = useRef<((locked: boolean) => void) | null>(null);
  useEffect(() => {
    lockRef.current?.(enabled);
  }, [enabled]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const handles = createScene(host, showCables);
    const { renderer, camera, controls, scene, arm, cables, grid, disposeScene } = handles;

    const canvas = renderer.domElement;
    let session: DragSession | null = null;
    let lastEmitted: [number, number, number] | null = null;

    /**
     * 锁定视角。
     *
     * 开启「拖动编辑」后**整个视图都不响应鼠标**，而不是只锁「点中臂之后」：
     * 相机一旦会动，指针到世界的映射每帧都在变，而拖拽平面是按下那一刻按
     * 当时的相机建的 —— 视角一偏，指针位置与解算目标就对不上，拖起来会莫名
     * 往旁边跑。操作员要的是「对着一个固定视角调形状」，锁死反而更符合预期。
     *
     * 关掉拖动编辑就整体交还给 OrbitControls，仍然可以自由转视角。
     */
    const lockView = (locked: boolean) => {
      if (session) return; // 拖动进行中不因为一次 prop 变化把 controls 抢回来
      controls.enabled = !locked;
      canvas.style.cursor = locked ? "grab" : "";
    };
    lockRef.current = lockView;

    /**
     * 拾取用的形状：**目标**优先，没有目标才用实际。
     *
     * 画面上显示的是目标形状（target 非空时 `shown` 走 target），所以拾取
     * 必须跟着用目标 —— 早先这里固定用 `actual`，一旦设过目标，臂在屏幕上
     * 是目标那条曲线、射线却在追实际那条，两组采样点岔开十几个点距离，
     * 结果就是**再也点不中臂**（表现为「拖动没反应」）。
     */
    const pickShape = () => targetRef.current ?? inputRef.current.actual;

    const toNdc = (event: PointerEvent): THREE.Vector2 => {
      const rect = canvas.getBoundingClientRect();
      return new THREE.Vector2(
        ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1,
        -((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1,
      );
    };

    /** 在给定 backbone 上找离射线最近的采样点，返回弧长、位置与偏差。 */
    const pickOnBackbone = (
      backbone: BackboneOutput,
      event: PointerEvent,
    ): { sMm: number; point: THREE.Vector3; distance: number } | null => {
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(toNdc(event), camera);

      let best: { sMm: number; point: THREE.Vector3; distance: number } | null = null;
      for (const sample of backbone.samples) {
        const point = new THREE.Vector3(...mapSvcPointToThreeMm(sample.pointM));
        const distance = raycaster.ray.distanceToPoint(point);
        if (best === null || distance < best.distance) {
          best = { sMm: sample.sMm, point, distance };
        }
      }
      if (!best || best.distance > PICK_THRESHOLD_MM) return null;
      return best;
    };

    /* ── 指针 ── */

    const onPointerDown = (event: PointerEvent) => {
      // 关掉拖动编辑时完全不接管指针，后续 move / up 也不再需要用捕获兜住。
      if (!inputRef.current.enabled || event.button !== 0 || session) return;
      const hit = pickOnBackbone(pickShape(), event);
      if (!hit) return;

      // 拖拽平面过抓取点、法线朝相机 —— 拖动方向会精确对应屏幕方向。
      const normal = camera.getWorldDirection(new THREE.Vector3()).negate();
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.point);
      // 按下瞬间的射线-平面交点，作为「位移零点」。
      const grabPoint = new THREE.Vector3();
      raycastPlane(event, plane, grabPoint);

      session = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        // 先只记下会话，真正开始改形状要等越过阈值 —— 见 DRAG_THRESHOLD_PX。
        active: false,
        sMm: hit.sMm,
        anchor: hit.point.clone(),
        grabPoint,
        plane,
      };
      lastEmitted = null;
      canvas.setPointerCapture(event.pointerId);
      controls.enabled = false;
      canvas.style.cursor = "grabbing";
      setDragging(true);
      event.preventDefault();
      event.stopPropagation();
    };

    /** 射线 ∩ 拖拽平面。相机固定（编辑期间视角锁定），所以这个映射是稳定的。 */
    const raycastPlane = (event: PointerEvent, plane: THREE.Plane, out: THREE.Vector3): boolean => {
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(toNdc(event), camera);
      return raycaster.ray.intersectPlane(plane, out) !== null;
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!session || event.pointerId !== session.pointerId) return;

      // 屏幕空间阈值：越过之前一律不碰形状，所以纯点击（含手抖）不会移动臂体。
      if (!session.active) {
        const distance = Math.hypot(event.clientX - session.startX, event.clientY - session.startY);
        if (distance < DRAG_THRESHOLD_PX) return;
        session.active = true;
        // 从零点起算，阈值那几像素的位移不折算成形变，避免起步窜一下。
        lastEmitted = [session.grabPoint.x, session.grabPoint.y, session.grabPoint.z];
      }

      const hitPoint = new THREE.Vector3();
      if (!raycastPlane(event, session.plane, hitPoint)) return;

      const moved = hitPoint.distanceTo(new THREE.Vector3(...lastEmitted!));
      if (moved < MIN_TARGET_DELTA_MM) return;
      lastEmitted = [hitPoint.x, hitPoint.y, hitPoint.z];

      // 见文件头：拾取与反解基准都跟着「显示的那条曲线」走。
      //
      // toMm 是**抓取点当前的绝对位置**：
      // 表面坐标 = 按下时的抓取点 + （指针投影 − 按下时的指针投影）
      // 起点用 anchor（臂上那个采样点）而不是指针落点，这样抓取点不会在
      // 按下的瞬间跳到指针位置；位移部分用投影之差，几像素的抖动就只对应
      // 几毫米的位移，不会被放大成十几毫米。
      const dx = hitPoint.x - session.grabPoint.x;
      const dy = hitPoint.y - session.grabPoint.y;
      const dz = hitPoint.z - session.grabPoint.z;
      const toMm: [number, number, number] = [
        session.anchor.x + dx,
        session.anchor.y + dy,
        session.anchor.z + dz,
      ];

      const solved = solveDragToPoint({
        sMm: session.sMm,
        toMm,
        base: pickShape().distribution,
      });
      setSaturated(solved.saturated);
      onChangeRef.current(solved.distribution);
    };

    const finish = (event: PointerEvent) => {
      if (!session || event.pointerId !== session.pointerId) return;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      session = null;
      lastEmitted = null;
      // 松手后回到「编辑开着就保持锁定」的状态，而不是无条件交还 —— 否则
      // 拖完一次就又能转视角，下一次拖动又得重新找角度。
      lockView(inputRef.current.enabled);
      setDragging(false);
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", finish);
    canvas.addEventListener("pointercancel", finish);

    // 初始状态按当前开关取值（组件可能在编辑已开启时才挂载）。
    lockView(inputRef.current.enabled);

    /* ── 渲染循环 ── */

    let animFrameId = 0;
    let smoothActual: BackboneOutput | null = null;
    let smoothTarget: BackboneOutput | null = null;
    let lastTime = performance.now();

    const animate = () => {
      animFrameId = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;

      // 实际形状阻尼得轻（smoothing 0.2，跟监控卡片一致）；
      // 目标形状阻尼重一些，拖动时指针再抖也不会把臂甩来甩去。
      //
      // 两份各自独立阻尼而不是直接切：目标为空（未编辑 / 已清空）时
      // `smoothTarget` 停止更新，形状平滑落回 `smoothActual` ——
      // 清空目标那一下是「滑回去」而不是瞬跳。
      smoothActual = dampBackbone(smoothActual, inputRef.current.actual, 0.2, dt);
      const targetBackboneNow = targetRef.current;
      smoothTarget = targetBackboneNow
        ? dampBackbone(smoothTarget, targetBackboneNow, 0.05, dt)
        : null;

      const shown = smoothTarget ?? smoothActual;
      updateBoneChainFromBackbone(arm.bones, GEOMETRY.lengthMm, shown);
      cables.updateBackbone(shown, 6.45, true);

      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(animFrameId);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", finish);
      canvas.removeEventListener("pointercancel", finish);
      lockRef.current = null;
      disposeScene();
      controls.dispose();
      cables.dispose();
      arm.dispose();
      grid.dispose();
      renderer.dispose();
      if (canvas.parentElement === host) host.removeChild(canvas);
    };
  }, [showCables]);

  // 编辑开关关掉时，收起可能还挂着的拖拽态。
  useEffect(() => {
    if (enabled) return;
    setDragging(false);
    setSaturated(false);
  }, [enabled]);

  return (
    <div className="curvature-drag-host">
      <div
        className={`robot-scene${enabled ? " is-curvature-editable" : ""}${dragging ? " is-dragging" : ""}`}
        ref={hostRef}
      />
      <div className="curvature-drag-hint" aria-live="polite">
        {!enabled ? (
          <span>拖动编辑已关闭 · 鼠标用于旋转视角</span>
        ) : dragging ? (
          <span className={saturated ? "is-warn" : undefined}>
            {saturated ? "已到曲率上限，继续拖不会再弯" : "拖动中 · 反解曲率分布"}
          </span>
        ) : (
          <span>点住臂身拖动改变曲率分布 · 视角已锁定，关闭拖动编辑后才能转视角</span>
        )}
      </div>
    </div>
  );
}

/* ── 场景搭建（与 RobotScene 同构，区别只在灯光/主题与 resize 的生命周期） ── */

interface SceneHandles {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  arm: ReturnType<typeof createSlottedSkinnedArm>;
  cables: ReturnType<typeof createCableVisuals>;
  grid: THREE.GridHelper;
  disposeScene: () => void;
}

function createScene(host: HTMLDivElement, showCables: boolean): SceneHandles {
  // WebGL 不吃 CSS 变量，场景底色/网格色得自己跟着 data-theme 走，
  // 否则浅色主题下卡片里会是一块黑方块。
  const readThemeColors = () => {
    const styles = getComputedStyle(document.documentElement);
    const isDark = document.documentElement.dataset.theme === "dark";
    const bg = styles.getPropertyValue("--surface-panel").trim() || (isDark ? "#202930" : "#ffffff");
    return {
      background: new THREE.Color(bg),
      gridCenter: new THREE.Color(isDark ? 0x2d3642 : 0xb8c6d4),
      gridLines: new THREE.Color(isDark ? 0x1b232e : 0xd7e0e8),
      hemiGround: new THREE.Color(isDark ? 0x1d2530 : 0xdbe4ec),
      hemiIntensity: isDark ? 2.1 : 2.6,
    };
  };

  let colors = readThemeColors();
  const scene = new THREE.Scene();
  scene.background = colors.background;
  const camera = new THREE.PerspectiveCamera(
    36,
    host.clientWidth / Math.max(host.clientHeight, 1),
    0.1,
    1800,
  );
  camera.position.set(200, 280, 420);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(host.clientWidth, host.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 190, 0);
  controls.enableDamping = true;
  controls.maxDistance = 900;

  const hemiLight = new THREE.HemisphereLight(0xd9ecff, colors.hemiGround, colors.hemiIntensity);
  scene.add(hemiLight);
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.8);
  keyLight.position.set(160, 300, 220);
  scene.add(keyLight);

  let grid = new THREE.GridHelper(220, 22, colors.gridCenter, colors.gridLines);
  scene.add(grid);

  const applyTheme = () => {
    colors = readThemeColors();
    scene.background = colors.background;
    hemiLight.groundColor = colors.hemiGround;
    hemiLight.intensity = colors.hemiIntensity;
    scene.remove(grid);
    grid.dispose();
    grid = new THREE.GridHelper(220, 22, colors.gridCenter, colors.gridLines);
    scene.add(grid);
  };
  const themeObserver = new MutationObserver(applyTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  const arm = createSlottedSkinnedArm(GEOMETRY);
  scene.add(arm.mesh, arm.skeletonHelper);
  arm.skeletonHelper.visible = false;

  const cables = createCableVisuals(GEOMETRY.lengthMm, 0.42);
  cables.group.visible = showCables;
  scene.add(cables.group);

  const resizeObserver = new ResizeObserver(() => {
    const w = host.clientWidth;
    const h = Math.max(host.clientHeight, 1);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });
  resizeObserver.observe(host);

  return {
    scene,
    camera,
    renderer,
    controls,
    arm,
    cables,
    grid,
    disposeScene: () => {
      themeObserver.disconnect();
      resizeObserver.disconnect();
    },
  };
}
