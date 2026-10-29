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
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { getArmView, onArmViewChange, setArmView, type ArmViewMode } from "./armView";
import { GestureCurvePane } from "./GestureCurvePane";
import { modelCurvatureLimitForDirection } from "../dynamics/svcModel";
import { tipPoseOfDistribution } from "./pose3d";
import { setRecording, subscribeMotionDraft, updateLivePose } from "./motionDraft";
import {
  clearTrail,
  getPreviewOverride,
  getPreviewPath,
  getTrail,
  pushTrail,
  setPreviewPath,
} from "./previewOverride";
import { getCurrentActionName } from "./motionPlayer";

import type { BackboneOutput, CurvatureDistribution } from "../dynamics/svcModel";
import { buildBackboneFromCurvatureDistribution, mapSvcPointToThreeMm } from "../dynamics/svcModel";
import { solveDragToPoint } from "../dynamics/curvatureDrag";
import { createSlottedSkinnedArm } from "./skinnedArm";
import { createCableVisuals } from "./cables";
import { dampBackbone, updateBoneChainFromBackbone } from "./kinematics";

/**
 * 臂体几何参数，和 RobotScene 保持同一套取值。
 *
 * **臂长来自模型包**（不同模型 445 / 400mm ✗），所以做成工厂函数 ——
 * 原来写死 404.89 会让"换了模型包但视图不变"✗。
 */
function makeGeometry(lengthMm: number) {
  return {
  lengthMm,
  radiusMm: 8.31,
  radialSegments: 72,
  axialSegments: 220,
  slotPitchMm: 24.2,
  slotDuty: 0.42,
  boneCount: 32,
  } as const;
}

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
/**
 * 抓取半径：射线到臂体采样点的距离在这个范围内才算"抓住了"。
 *
 * 原来是 `半径 × 1.6`，而拾取只在 backbone 的**离散采样点**上找最近点 ——
 * 臂细、采样疏的时候（尤其拉远看时），指针偏一两像素就判不中，然后**彻底静默**
 * （onPointerDown 直接 return，什么都不提示）。实测就卡在这里：臂体看着在动
 * （那是实时帧驱动的实际臂体），但拖动根本没建立会话。
 *
 * 编辑模式下放大到 `× 3.2`：拖动编辑默认关闭，打开时就是专门来拖的，
 * 宽容一点远比"抓不住"好。
 */
const PICK_THRESHOLD_MM = 8.31 * 3.2;   // 只和半径有关，与臂长无关 ✓

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
  /** 拖动控制出的目标分布；`null` 表示尚未编辑，显示实际形状。 */
  target: CurvatureDistribution | null;
  /** 编辑开关：关闭时完全不接管指针，视图保持纯 OrbitControls。 */
  enabled: boolean;
  /**
   * 固定末端位姿：只改臂体形状，末端位置/姿态保持不变（见 `curvatureDrag.solveDragLockingTip`）。
   */
  lockTipPose?: boolean;
  /** 拖动控制开关的 setter（传进来才能在 3D 面板里切换 ✓）。 */
  onEnabledChange?: (next: boolean) => void;
  /** 固定末端位姿开关的 setter。 */
  onLockTipPoseChange?: (next: boolean) => void;
  /** 手势跟随开启时：左 3D / 右手势曲线，两屏并排 ✓。 */
  showGestureCurve?: boolean;
  /**
   * 臂长（mm）—— **必须来自当前模型包** ✓。
   *
   * 不同模型 445 / 400mm，写死会让"换了模型包视图不变"✗。
   * 缺省值只是兜底，页面必须传 ✓。
   */
  lengthMm?: number;
  /**
   * 8 个方向的 κ 上限（来自 model_status）。
   *
   * **必须显式传** ✗ —— 试过走 `svcModel` 的模块级单例，但它是 lazy chunk 的
   * 另一份副本，页面设的值预览读不到 ✗ → 一直按标量 0.96 钳制。
   */
  kappaByDirection?: number[] | null;
  /** 臂体标识色（**当前不染色** ✓，恒为 null）。 */
  armTint?: string | null;
  /**
   * 表面质地：`metal` 金属感 / `matte` 哑光 ✓。
   *
   * 用**质地**而不是颜色区分模型 ✗ —— 染色会让银灰金属变"塑料感"✗，
   * 而金属/哑光的对比既明显又不破坏整体观感 ✓。
   */
  armFinish?: "metal" | "matte";
  /**
   * 固定末端位姿时的**漂移阈值**（mm，默认 2）。
   *
   * 硬约束求解也会在上限处留下毫米级残差，超过这个阈值就说明「形状已经到极限、
   * 末端开始被拖着走」，视图下方会把它标黄说清楚，而不是假装还锁着。
   */
  tipDriftToleranceMm?: number;
  showCables?: boolean;
  onTargetChange: (target: CurvatureDistribution | null) => void;
}

/**
 * 可拖动的三维曲率编辑器。
 *
 * 组件只负责「指针 → 目标位置 → 反解 → 回调」这条链路；目标形状的持有
 * 在父组件（面板），因为发送命令时还要读它。
 */
/** 臂体渲染旋转：+Y（建模轴）→ +Z（约定轴）。拾取/反解必须用同一个角。 */
const ARM_RENDER_ROTATION_X = Math.PI / 2;
const ARM_RENDER_EULER = new THREE.Euler(ARM_RENDER_ROTATION_X, 0, 0);
const ARM_RENDER_EULER_INV = new THREE.Euler(-ARM_RENDER_ROTATION_X, 0, 0);

/** 轴标签：Times New Roman 斜体；Sprite 永远正对相机；不参与色调映射。 */
function makeAxisLabel(text: string, color: string, sizeMm: number): THREE.Sprite {
  const px = 96;
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, px, px);
    ctx.font = 'italic 66px "Times New Roman", Times, serif';
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, px / 2, px / 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, toneMapped: false }),
  );
  sprite.scale.set(sizeMm, sizeMm, 1);
  sprite.renderOrder = 30;
  return sprite;
}

function attachAxisLabels(axes: THREE.AxesHelper, length: number, sizeMm: number): void {
  const labels: Array<[string, string, number, number, number]> = [
    ["x", "#ff5a5a", length * 1.14, 0, 0],
    ["y", "#4fd67c", 0, length * 1.14, 0],
    ["z", "#5aa2ff", 0, 0, length * 1.14],
  ];
  for (const [text, color, x, y, z] of labels) {
    const sprite = makeAxisLabel(text, color, sizeMm);
    sprite.position.set(x, y, z);
    axes.add(sprite);
  }
}

/**
 * 播放轨迹线的句柄 ✓。
 *
 * 为什么放模块级 ✗：`animate` 在第一个 effect ✓、`scene` 在第二个 effect ✗ ——
 * 局部变量跨不过去 ✓，模块级是这里最简单可靠的方式 ✓。
 */
let previewPathLine: THREE.Line | null = null;
let previewPathKey = "";

function ensurePreviewPathLine(scene: THREE.Scene) {
  if (previewPathLine) return previewPathLine;
  const material = new THREE.LineBasicMaterial({
    color: 0x4ade80,
    transparent: true,
    opacity: 0.85,
    toneMapped: false,
  });
  previewPathLine = new THREE.Line(new THREE.BufferGeometry(), material);
  previewPathLine.renderOrder = 3;
  previewPathLine.visible = false;
  // ⚠ 必须和臂体/电缆**同一个旋转** ✓ —— 臂体是 +Y 建模再绕 X 转 90° ✓，
  //   轨迹点虽然是 three 系 ✓ 但臂体的蒙皮也是"转过的"✗ → 不转就跑到另一边 ✗
  previewPathLine.rotation.x = ARM_RENDER_ROTATION_X;
  scene.add(previewPathLine);
  return previewPathLine;
}

/** 每帧更新轨迹 ✓（内容没变就不重建几何 ✗）*/
/** 上一次 `createScene` 是否从 localStorage 恢复了相机 ✓ */
let cameraWasRestored = false;

function syncPreviewPath(enabled: boolean) {
  const line = previewPathLine;
  if (!line) return;
  if (!enabled) {
    if (line.visible) {
      line.visible = false;
      previewPathKey = "";
    }
    return;
  }
  const points = getPreviewPath();
  if (points.length < 2) {
    if (line.visible) {
      line.visible = false;
      previewPathKey = "";
    }
    return;
  }
  const key = `${points.length}:${points[0].join(",")}:${points[points.length - 1].join(",")}`;
  if (key !== previewPathKey) {
    previewPathKey = key;
    const array = new Float32Array(points.length * 3);
    points.forEach((point, index) => {
      array[index * 3] = point[0];
      array[index * 3 + 1] = point[1];
      array[index * 3 + 2] = point[2];
    });
    line.geometry.setAttribute("position", new THREE.BufferAttribute(array, 3));
    line.geometry.computeBoundingSphere();
  }
  line.visible = true;
}

/**
 * **持久化的布尔开关** ✓ —— 组件卸载（切页签 ✓）后值还在 ✓。
 *
 * 为什么需要 ✗：`CurvatureDragPreview` 在切页签时**被卸载** ✓，
 * 所有 `useState` 回到默认 ✓ → 用户每次回来都要重新勾一遍 ✗（本 bug ✓）。
 *
 * 用 `localStorage` ✓：不需要后端 ✓、立刻生效 ✓、跨刷新保留 ✓。
 */
function usePersistedToggle(storageKey: string, fallback = false): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      return raw == null ? fallback : raw === "1";
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, value ? "1" : "0");
    } catch {
      /* 忽略 ✓ */
    }
  }, [storageKey, value]);
  return [value, setValue];
}

export function CurvatureDragPreview({
  actual,
  target,
  enabled,
  lockTipPose = false,
  tipDriftToleranceMm = 2,
  showCables = true,
  onTargetChange,
  onEnabledChange,
  onLockTipPoseChange,
  showGestureCurve = false,
  lengthMm = 404.8927,
  kappaByDirection = null,
  armTint = null,
  armFinish = "matte",
} : CurvatureDragPreviewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  /** 最新输入。渲染循环与指针回调都从这里读，避免重建整个场景。 */
  const inputRef = useRef({ actual, enabled, lockTipPose });
  inputRef.current = { actual, enabled, lockTipPose };
  const onChangeRef = useRef(onTargetChange);
  onChangeRef.current = onTargetChange;

  const [dragging, setDragging] = useState(false);
  /** 动作编排：勾上后拖动会**自动记录末端点** ✓（2mm 一点 ✓）*/
  const [motionRecord, setMotionRecord] = useState(false);

  /** 视角模式：与「臂体形位预览」共用同一份共享状态。 */
  const [viewMode, setViewMode] = useState<ArmViewMode>(getArmView);
  const viewModeRef = useRef<ArmViewMode>(viewMode);
  viewModeRef.current = viewMode;
  /** 已经应用过的视角模式；变化时才重设相机，避免每帧抢用户的缩放/旋转。 */
  /**
   * 已应用的视图模式 ✓。
   * `null` = 从没应用过 ✓；初始化时如果**恢复了相机**，要设成当前模式 ✓
   * （否则第一帧会当成"模式变了"✗ → 覆盖恢复的视角 ✗）。
   */
  const appliedViewRef = useRef<ArmViewMode | null>(null);
  /**
   * 显示风格：**默认全关 = 纯净臂体** ✓。
   * 用 ref 给渲染循环读，避免每勾一次就重建场景（相机会复位 ✗）。
   */
  // **全部持久化** ✓ —— 切页签 / 刷新都不丢 ✓
  const [showGravity, setShowGravity] = usePersistedToggle("softui.showGravity");
  const [showWorldAxes, setShowWorldAxes] = usePersistedToggle("softui.showWorldAxes");
  const [showTipAxes, setShowTipAxes] = usePersistedToggle("softui.showTipAxes");
  const [showSegmentFrames, setShowSegmentFrames] = usePersistedToggle("softui.showSegmentFrames");
  /**
   * 末端轨迹线 ✓（播放时才有内容 ✓）
   *
   * ⚠ **要持久化** ✗ —— 组件在切页签时会**卸载** ✓，`useState(false)` 会重置 ✗
   * → 切走再回来勾选就没了 ✗（本 bug ✓）。
   */
  const [showMotionPath, setShowMotionPath] = usePersistedToggle("softui.showMotionPath");
  /**
   * **轨迹点** ✓ —— 存在模块里 ✗（`useRef` 切页签就清零 ✓ → 回来从 0 重跑 ✗ 本 bug ✓）。
   * 这里用 getter 包一层 ✓，下面的代码不用大改 ✓。
   */
  const trailRef = { current: getTrail() };

  /**
   * 跟随**动作库的「记录」开关** ✓。
   *
   * 动作库里点「记录」→ 切到控制页时，这里的「动作编排」要**自动勾上** ✓
   * （否则用户以为在录 ✓，其实一个点都没记 ✗）。
   */
  useEffect(() => subscribeMotionDraft((state) => {
    setMotionRecord((previous) => (previous === state.recording ? previous : state.recording));
  }), []);
  /** 末端手柄跟随「拖动控制」：开启拖动就出现手柄（不再单独一个开关 ✓）。 */
  const showTipHandleRef = useRef(enabled);
  showTipHandleRef.current = enabled;
  const showFlagsRef = useRef({ gravity: false, world: false, tip: false, segments: false, motionPath: false });
  showFlagsRef.current = {
    gravity: showGravity,
    world: showWorldAxes,
    tip: showTipAxes,
    segments: showSegmentFrames,
    motionPath: showMotionPath,
  };
  /**
   * 重力箭头/锚点的引用。
   *
   * 场景在**一个 effect** 里建（`createScene`），渲染循环在**另一个 effect** 里跑 ✗，
   * 两边作用域不通 —— 所以用 ref 桥接（和 `lockRef` 完全一样的做法 ✓）。
   */
  /**
   * 按**每段自己的方向**算 12 个曲率上限（1/m）。
   *
   * 没有方向表时回落到标量 ✓（老后端安全）。
   * 口径与 pose3d 一致：`phi = atan2(-kx, ky)` ✓。
   */
  const limitsForDistribution = (
    base: CurvatureDistribution,
    scalarLimit: number,
  ): number[] => {
    const table = kappaByDirection;
    const limitFor = (phi: number): number => {
      if (!table || table.length !== 8) return scalarLimit;
      const twoPi = Math.PI * 2;
      let p = phi % twoPi;
      if (p < 0) p += twoPi;
      const scaled = (p / twoPi) * 8;
      const i = Math.floor(scaled) % 8;
      const j = (i + 1) % 8;
      const t = scaled - Math.floor(scaled);
      return table[i] * (1 - t) + table[j] * t;
    };
    // ⚠ 不要再加 `observed + 0.5` 的 headroom ✗：
    //   基准 κ≈0.46 时上限被压成 0.96，正好卡在用户看到的位置 ✗。
    //   现在的上限**直接就是该方位的表覆盖边界** ✓ —— 一次能拖到表允许的地方 ✓。
    return base.segments.map((seg) => limitFor(Math.atan2(-seg.kxPerM, seg.kyPerM)));
  };

  /** 几何随臂长变化 —— 变了就重建场景 ✓。 */
  const geometry = useMemo(() => makeGeometry(lengthMm), [lengthMm]);

  /** 循环里复用的临时四元数（避免每帧 new 一个）。 */
  const tipQuatScratch = useRef(new THREE.Quaternion()).current;

  const gravityRef = useRef<{
    arrow: THREE.ArrowHelper;
    dot: THREE.Mesh;
    tipAxes: THREE.AxesHelper;
    segmentFrames: THREE.AxesHelper[];
    worldAxes: THREE.AxesHelper;
    tipGizmoHelper: THREE.Object3D;
    tipProxy: THREE.Object3D;
    gizmoState: { dragging: boolean };
    targetGhost: THREE.Mesh;
    driftLine: THREE.Line;
  } | null>(null);

  useEffect(() => {
    return onArmViewChange((mode) => {
      setViewMode(mode);
      viewModeRef.current = mode;
    });
  }, []);
  const [saturated, setSaturated] = useState(false);
  /** 固定末端位姿模式下的末端漂移（mm / rad）——「锁没锁住」的量化答案。 */
  const [tipDriftMm, setTipDriftMm] = useState(0);
  const [tipDriftRad, setTipDriftRad] = useState(0);

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

    const handles = createScene(host, showCables, geometry, armTint, armFinish);
    gravityRef.current = {
      arrow: handles.gravityArrow,
      dot: handles.anchorDot,
      tipAxes: handles.tipAxes,
      segmentFrames: handles.segmentFrames,
      worldAxes: handles.worldAxes,
      tipGizmoHelper: handles.tipGizmoHelper,
      tipProxy: handles.tipProxy,
      gizmoState: handles.gizmoState,
      targetGhost: handles.targetGhost,
      driftLine: handles.driftLine,
    };
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
        // 采样点是**模型坐标**；渲染时臂体转过了 → 这里必须同样转一次，
        // 否则拾取位置和看到的臂对不上（表现："按在臂上却抓不到"✗）。
        const point = new THREE.Vector3(...mapSvcPointToThreeMm(sample.pointM))
          .applyEuler(ARM_RENDER_EULER);
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
      if (!session) {
        // 悬停反馈：指针落在臂体上才显示"可抓取"光标。
        // 这是操作员唯一能知道自己"按偏了"的线索 —— 原来点空白处是彻底静默的，
        // 表现就是"拖了半天没反应，也不知道为什么"。
        if (inputRef.current.enabled) {
          canvas.style.cursor = pickOnBackbone(pickShape(), event) ? "grab" : "default";
        }
        return;
      }
      if (event.pointerId !== session.pointerId) return;

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
      // 上面算出的是**世界坐标**；反解求解器吃的是**模型坐标**，
      // 用反向欧拉角转回去 —— 少了这一步就是"拖左边臂往右弯"✗。
      const localTarget = new THREE.Vector3(
        session.anchor.x + dx,
        session.anchor.y + dy,
        session.anchor.z + dz,
      ).applyEuler(ARM_RENDER_EULER_INV);
      const toMm: [number, number, number] = [localTarget.x, localTarget.y, localTarget.z];

      const solved = solveDragToPoint({
        sMm: session.sMm,
        toMm,
        base: pickShape().distribution,
        lockTipPose: inputRef.current.lockTipPose,
        // 每段按自身方向取上限 ✓（方向表由页面显式传入）
        limitsPerM: limitsForDistribution(pickShape().distribution, modelCurvatureLimitForDirection(0)),
      });
      setSaturated(solved.saturated);
      setTipDriftMm(solved.tipDriftMm);
      setTipDriftRad(solved.tipDriftRad);
      onChangeRef.current(solved.distribution);

      // 把当前形位挂到 window ✓ —— 轨迹规划要拿它当 base ✓
      // （模块单例跨 chunk 可能不同份 ✗，window 上是**唯一**的 ✓）
      (window as unknown as { __softuiCurrentDistribution?: unknown }).__softuiCurrentDistribution =
        solved.distribution;

      // 把末端位姿喂给"动作记录"草稿 ✓（记录中会自动落点 ✓，否则只更新 live ✓）
      const tipForRecord = tipPoseOfDistribution(solved.distribution.segments);
      // ⚠ 必须走 `mapSvcPointToThreeMm` ✓ —— 它会**交换 y/z** ✓。
      //   直接 positionM*1000 得到的是 svc 系 ✓，而 IK 的 `reached` 是 three 系 ✗
      //   → 两者差 90° ✗ → 残差 400mm+ ✗（本次 bug 的根因 ✓）
      const tipThree = mapSvcPointToThreeMm(tipForRecord.positionM);
      updateLivePose(
        {
          x: tipThree[0],
          y: tipThree[1],
          z: tipThree[2],
        },
        solved.distribution.segments.map((segment) => segment.kappaAbsPerM),
      );
    };

    const finish = (event: PointerEvent) => {
      if (!session || event.pointerId !== session.pointerId) return;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      session = null;
      lastEmitted = null;
      // 松手后回到「编辑开着就保持锁定」的状态，而不是无条件交还 —— 否则
      // 拖完一次就又能转视角，下一次拖动又得重新找角度。
      lockView(inputRef.current.enabled);
      canvas.style.cursor = "default"; // 否则一直停在 grabbing，像是还按着
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

      // 播放注入 ✓（有就优先，直接把动画形状喂给骨骼 ✓）
      const injected = getPreviewOverride();
      const targetBackboneNow = injected ?? targetRef.current;
      smoothTarget = targetBackboneNow
        ? dampBackbone(smoothTarget, targetBackboneNow, 0.05, dt)
        : null;

      const shown = smoothTarget ?? smoothActual;
      // 末端轨迹 ✓（勾「显示风格 → 末端轨迹」时，**拖动/播放都会实时累积** ✓）
      if (showFlagsRef.current.motionPath) {
        const tipSample = shown.samples[shown.samples.length - 1];
        if (tipSample) {
          const tipThree = mapSvcPointToThreeMm(tipSample.pointM);
          const last = trailRef.current[trailRef.current.length - 1];
          // 2mm 才记一点 ✓（和动作库记录同口径 ✓）
          if (!last || Math.hypot(tipThree[0] - last[0], tipThree[1] - last[1], tipThree[2] - last[2]) >= 2) {
            pushTrail(tipThree);
            setPreviewPath(trailRef.current);
          }
        } else if (trailRef.current.length > 0 && !getCurrentActionName()) {
          // **播放中不覆盖** ✗ —— 播放路径是 `WorkspacePage` 一次设好的整条 ✓，
          //   用"逐帧累积的 trail"覆盖它 ✓ → 只剩最后一小段 ✓ → 看起来像直线 ✗（本 bug ✓）。
          //   没有播放时仍要显示拖动留下的轨迹 ✓。
          setPreviewPath(trailRef.current);
        }
        syncPreviewPath(true);
      } else {
        syncPreviewPath(false);
      }

      updateBoneChainFromBackbone(arm.bones, geometry.lengthMm, shown);
      cables.updateBackbone(shown, 6.45, true);

      // ── 视角模式：与「臂体形位预览」**完全一致** ─────────────────────────
      // 臂体现在也沿 **+Z**（基座在原点），所以能直接用同一套公式：
      //   距离 = (L/2)/sin(fov/2) × 1.25
      //   水平 = 侧上方 (0.96, 0.26)；竖直 = 正上方俯视 (0, 0.99)
      //   up 保持 (0,1,0) —— 不再需要翻转（那是 +Y 臂时代为"横过来"才做的 ✗）
      /**
       * ⚠ **恢复过相机就不要再按"视图模式"重设** ✗ ——
       * 上一段已经从 localStorage 恢复了用户的视角 ✓，
       * 这里再无条件套一遍"水平/竖直"公式 ✓ → **视角被打回默认** ✗（本 bug ✓）。
       * 只有当用户**主动切换视图模式**时（`viewMode` 真的变了 ✓）才重设 ✓。
       */
      // 恢复过相机 → 首帧就把 `appliedViewRef` 对齐 ✓，不触发重设 ✓
      if (cameraWasRestored && appliedViewRef.current === null) {
        appliedViewRef.current = viewModeRef.current;
      }
      const wantedMode = viewModeRef.current;
      const shouldApplyMode = cameraWasRestored
        ? wantedMode !== appliedViewRef.current && appliedViewRef.current !== null
        : wantedMode !== appliedViewRef.current;
      if (shouldApplyMode) {
        appliedViewRef.current = wantedMode;
        const fovRad = (camera.fov * Math.PI) / 180;
        const lengthMm = geometry.lengthMm;
        const distance = ((lengthMm / 2) / Math.sin(fovRad / 2)) * 1.25;
        camera.up.set(0, 1, 0);
        controls.target.set(0, 0, lengthMm / 2);
        if (wantedMode === "horizontal") {
          camera.position.set(distance * 0.96, distance * 0.26, lengthMm / 2);
        } else {
          camera.position.set(0, distance * 0.99, lengthMm / 2);
        }
        camera.lookAt(controls.target);
        controls.update();
      }

      // 末端手柄：可见性 + 拖动反解
      const gizmoNow = gravityRef.current;
      if (gizmoNow) {
        const handleVisible = showTipHandleRef.current;
        gizmoNow.tipGizmoHelper.visible = handleVisible;
        if (gizmoNow.gizmoState.dragging && handleVisible) {
          const worldP = gizmoNow.tipProxy.getWorldPosition(new THREE.Vector3());
          const localP = worldP.clone().applyEuler(ARM_RENDER_EULER_INV);

          // ── A：闭环反解 ──────────────────────────────────────────────
          // 反解器只保证"可达范围内最接近"✗，一轮下来末端会与目标有残差。
          // 这里把残差**补回目标**再解一轮（最多 3 轮）：
          //   只要目标仍在可达域内，末端就会收敛到它 ✓；
          //   超出可达域则第 1 轮就饱和、后面几轮无变化 ✓（不会抖动）。
          let target: [number, number, number] = [localP.x, localP.y, localP.z];
          let solved = solveDragToPoint({
            sMm: geometry.lengthMm,
            toMm: target,
            base: pickShape().distribution,
            lockTipPose: inputRef.current.lockTipPose,
            limitsPerM: limitsForDistribution(pickShape().distribution, modelCurvatureLimitForDirection(0)),
          });
          for (let iter = 0; iter < 2 && !solved.saturated; iter += 1) {
            // tipPoseOfDistribution 吃**段数组**、返回**米**（positionM）
            const tip = tipPoseOfDistribution(solved.distribution.segments);
            const errX = target[0] - tip.positionM[0] * 1000;
            const errY = target[1] - tip.positionM[1] * 1000;
            const errZ = target[2] - tip.positionM[2] * 1000;
            if (Math.hypot(errX, errY, errZ) < 0.3) break;      // 亚毫米就算了
            const corrected: [number, number, number] = [target[0] + errX, target[1] + errY, target[2] + errZ];
            const retry = solveDragToPoint({
              sMm: geometry.lengthMm,
              toMm: corrected,
              base: pickShape().distribution,
              lockTipPose: inputRef.current.lockTipPose,
              limitsPerM: limitsForDistribution(pickShape().distribution, modelCurvatureLimitForDirection(0)),
            });
            if (retry.tipDriftMm >= solved.tipDriftMm) break;    // 没变好就停
            solved = retry;
            target = corrected;
          }
          setSaturated(solved.saturated);
          setTipDriftMm(solved.tipDriftMm);
          setTipDriftRad(solved.tipDriftRad);
          onChangeRef.current(solved.distribution);
        } else if (handleVisible) {
          // 空闲时把手柄对齐到**当前末端**（骨骼已含全部变形）
          const handleBones = arm.mesh.skeleton?.bones;
          const tipBoneForHandle = handleBones && handleBones.length > 0 ? handleBones[handleBones.length - 1] : null;
          if (tipBoneForHandle) {
            tipBoneForHandle.getWorldPosition(gizmoNow.tipProxy.position);
            tipBoneForHandle.getWorldQuaternion(tipQuatScratch);
            gizmoNow.tipProxy.quaternion.copy(tipQuatScratch);
          }
        }
      }

      // 目标幽灵 + 漂移连线：跟着手柄与真实末端的差走
      if (gizmoNow) {
        const showGhost = showTipHandleRef.current;
        gizmoNow.targetGhost.visible = showGhost;
        gizmoNow.driftLine.visible = showGhost;
        if (showGhost) {
          gizmoNow.tipProxy.getWorldPosition(gizmoNow.targetGhost.position);
          const actualBones = arm.mesh.skeleton?.bones;
          const actualTipBone = actualBones && actualBones.length > 0 ? actualBones[actualBones.length - 1] : null;
          if (actualTipBone) {
            const actualWorld = actualTipBone.getWorldPosition(new THREE.Vector3());
            const ghostPos = gizmoNow.targetGhost.position;
            gizmoNow.driftLine.geometry.setFromPoints([actualWorld, ghostPos.clone()]);
            const driftMm = actualWorld.distanceTo(ghostPos);
            (gizmoNow.driftLine.material as THREE.LineBasicMaterial).color.set(
              driftMm > 2 ? 0xff5a5a : 0x4fd67c,
            );
          }
        }
      }

      // 重力：起点跟随**变形后的中段骨骼**（骨骼已带全部变形与 mesh 旋转 ✓）。
      // 方向恒为世界 −Y，不随臂体转 ✓。
      const gravityNow = gravityRef.current;
      const bonesForGravity = arm.mesh.skeleton?.bones;
      if (gravityNow && bonesForGravity && bonesForGravity.length > 0) {
        const midBone = bonesForGravity[Math.floor(bonesForGravity.length / 2)];
        if (midBone) {
          const worldPoint = new THREE.Vector3();
          midBone.getWorldPosition(worldPoint);
          gravityNow.arrow.position.copy(worldPoint);
          gravityNow.dot.position.copy(worldPoint);

          // 末端局部系：位置 + 姿态都取**最后一个骨骼**（已含全部变形与 mesh 旋转 ✓）
          // 12 个分段系：均匀取骨骼（骨骼数远多于 12，取整即可 ✓）
          // 显示风格：每帧按开关设可见性（对象常驻，只切 visible ✓）
          const flags = showFlagsRef.current;
          gravityNow.arrow.visible = flags.gravity;
          gravityNow.dot.visible = flags.gravity;
          gravityNow.tipAxes.visible = flags.tip;
          gravityNow.worldAxes.visible = flags.world;

          const frames = gravityNow.segmentFrames;
          const framesVisible = flags.segments;
          if (frames && frames.length > 0) {
            for (const frame of frames) frame.visible = framesVisible;
            const lastIndex = bonesForGravity.length - 1;
            for (let i = 0; i < frames.length; i += 1) {
              const boneIndex = Math.round((i / frames.length) * lastIndex);
              const bone = bonesForGravity[boneIndex];
              if (!bone) continue;
              bone.getWorldPosition(frames[i].position);
              bone.getWorldQuaternion(tipQuatScratch);
              frames[i].quaternion.copy(tipQuatScratch);
              frames[i].rotateX(-Math.PI / 2);   // +Z 对准该段切向（与末端系同一规则）
            }
          }

          const tipBone = bonesForGravity[bonesForGravity.length - 1];
          if (tipBone) {
            tipBone.getWorldPosition(gravityNow.tipAxes.position);
            tipBone.getWorldQuaternion(tipQuatScratch);
            gravityNow.tipAxes.quaternion.copy(tipQuatScratch);
            gravityNow.tipAxes.rotateX(-Math.PI / 2);
          }
        }
      }

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
  }, [showCables, geometry, armTint, armFinish]);

  // 编辑开关关掉时，收起可能还挂着的拖拽态。
  useEffect(() => {
    if (enabled) return;
    setDragging(false);
    setSaturated(false);
  }, [enabled]);

  return (
    <div className={`curvature-drag-host${showGestureCurve ? " is-split" : ""}`}>
      {/* 按钮放在 .robot-scene **内部** —— 它 position:relative，
          这样"右上角"是相对画布而不是相对整张卡片（卡片还有提示条，会错位）。 */}
      <div
        className={`robot-scene${enabled ? " is-curvature-editable" : ""}${dragging ? " is-dragging" : ""}`}
        ref={hostRef}
      >
        <details className="robot-scene-mode-panel">
          <summary>控制模式</summary>
          {onEnabledChange ? (
            <label>
              <input type="checkbox" checked={enabled} onChange={(e) => onEnabledChange(e.target.checked)} />
              拖动控制
            </label>
          ) : null}
          {onLockTipPoseChange ? (
            <label>
              <input type="checkbox" checked={lockTipPose} onChange={(e) => onLockTipPoseChange(e.target.checked)} />
              固定末端位姿
            </label>
          ) : null}
          {/* 动作编排 ✓ —— 勾上后拖动会自动记点（2mm 一点 ✓），给「动作库」用 ✓ */}
          <label title="勾上后拖动手柄会自动记录末端点（每 2mm 一点）">
            <input
              type="checkbox"
              checked={motionRecord}
              onChange={(e) => {
                setMotionRecord(e.target.checked);
                setRecording(e.target.checked);
              }}
            />
            动作编排
          </label>
        </details>
        <details className="robot-scene-style-panel">
          <summary>显示风格</summary>
          <label>
            <input type="checkbox" checked={showGravity} onChange={(e) => setShowGravity(e.target.checked)} />
            重力矢量
          </label>
          <label>
            <input type="checkbox" checked={showWorldAxes} onChange={(e) => setShowWorldAxes(e.target.checked)} />
            世界坐标系
          </label>
          <label>
            <input type="checkbox" checked={showTipAxes} onChange={(e) => setShowTipAxes(e.target.checked)} />
            末端坐标系
          </label>
          <label>
            <input type="checkbox" checked={showSegmentFrames} onChange={(e) => setShowSegmentFrames(e.target.checked)} />
            分段系
          </label>
          <label title="播放动作时，把整条末端轨迹画成绿色线 ✓">
            <input
              type="checkbox"
              checked={showMotionPath}
              onChange={(e) => {
                setShowMotionPath(e.target.checked);
                /**
                 * **勾选变化都清一次** ✗ —— 原来只在取消时清 ✓。
                 * 但播放路径（`WorkspacePage` 设的整条 ✓）**不在 trail 里** ✗，
                 * 只清 trail 清不掉它 ✓ → 再勾上又把旧路径画回来 ✗（本 bug ✓）。
                 * 两边都清 ✓：取消时清 ✓、勾上时也从空白开始 ✓（从当前位置重新累积 ✓）。
                 */
                clearTrail();
                setPreviewPath([]);
                /**
                 * ⚠ **绝对不要清 `previewOverride`** ✗ ——
                 *
                 * 它是 3D 当前的**形位来源**（拖动目标 / 播放末帧 ✓），不是轨迹线 ✓。
                 * 这里一清 ✓ → 渲染循环的 `smoothTarget` 立刻变 `null` ✗ →
                 * `shown` 掉回 `smoothActual`（真实形状 ✓）→
                 * **臂体当场跳一下**✗（本 bug ✓）。
                 *
                 * 「末端轨迹」是**显示开关** ✓，只该影响那条线 ✓，不该改形位 ✓。
                 */
                // clearPreviewOverride();   ← 已删除（本 bug 的根因）
              }}
            />
            末端轨迹
          </label>
        </details>
        {!enabled ? (
          <button
            type="button"
            className="robot-scene-view-toggle"
            onClick={() => setArmView(viewMode === "horizontal" ? "vertical" : "horizontal")}
            title="切换视角：水平 / 竖直"
          >
            {viewMode === "horizontal" ? "水平" : "竖直"}
          </button>
        ) : null}
      </div>
      {showGestureCurve ? (
        <GestureCurvePane distribution={target} active={showGestureCurve} />
      ) : null}
      <div className="curvature-drag-hint" aria-live="polite">
        <span className="curvature-drag-limit" title="当前生效的曲率上限（按方向取，来自所选模型包）">
          上限 {(kappaByDirection && kappaByDirection.length === 8
            ? Math.min(...kappaByDirection)
            : modelCurvatureLimitForDirection(0)
          ).toFixed(2)}–{(kappaByDirection && kappaByDirection.length === 8
            ? Math.max(...kappaByDirection)
            : modelCurvatureLimitForDirection(0)
          ).toFixed(2)} 1/m
        </span>
        {!enabled ? (
          <span>拖动控制已关闭 · 鼠标用于旋转视角</span>
        ) : dragging ? (
          lockTipPose ? (
            <span className={tipDriftMm > tipDriftToleranceMm ? "is-warn" : undefined}>
              {tipDriftMm > tipDriftToleranceMm
                ? `已到曲率上限：形状到极限，末端开始被拖着走（漂移 ${tipDriftMm.toFixed(1)} mm > 阈值 ${tipDriftToleranceMm.toFixed(1)} mm）`
                : `拖动中 · 固定末端位姿（漂移 ${tipDriftMm.toFixed(1)} mm / ${((tipDriftRad * 180) / Math.PI).toFixed(1)}°，阈值 ${tipDriftToleranceMm.toFixed(1)} mm）`}
            </span>
          ) : (
            <span className={saturated ? "is-warn" : undefined}>
              {saturated ? "已到曲率上限，继续拖不会再弯" : "拖动中 · 反解曲率分布"}
            </span>
          )
        ) : (
          <span>
            {lockTipPose
              ? `固定末端位姿：末端不动，只改臂体形状（漂移阈值 ${tipDriftToleranceMm.toFixed(1)} mm）· 视角已锁定`
              : "点住臂身拖动改变曲率分布 · 视角已锁定，关闭拖动控制后才能转视角"}
          </span>
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
  /** 重力箭头（世界 −Y，起点跟随变形后的中段骨骼）。 */
  gravityArrow: THREE.ArrowHelper;
  /** 重力起点的小圆点。 */
  anchorDot: THREE.Mesh;
  /** 末端局部坐标系（跟随末端骨骼）。 */
  tipAxes: THREE.AxesHelper;
  /** 12 个分段的局部坐标系。 */
  segmentFrames: THREE.AxesHelper[];
  /** 世界坐标系。 */
  worldAxes: THREE.AxesHelper;
  /** 末端手柄（隐藏时不参与交互）。 */
  tipGizmo: TransformControls;
  tipGizmoHelper: THREE.Object3D;
  tipProxy: THREE.Object3D;
  gizmoState: { dragging: boolean };
  targetGhost: THREE.Mesh;
  driftLine: THREE.Line;
  disposeScene: () => void;
}

function createScene(
  host: HTMLDivElement,
  showCables: boolean,
  geometry: ReturnType<typeof makeGeometry>,
  armTint: string | null,
  armFinish: "metal" | "matte",
): SceneHandles {
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
  /**
   * **恢复上次的相机** ✓ —— 组件切页签时会**销毁 scene** ✗，
   * 回来时相机回到出厂位置 ✓ → 用户刚调好的视角白调 ✗（本 bug ✓）。
   *
   * 存 `localStorage` ✓（不需要后端 ✓，跨刷新也保留 ✓）。
   */
  const CAMERA_KEY = "softui.cameraView";
  let restoredCamera = false;
  try {
    const raw = window.localStorage.getItem(CAMERA_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as { pos?: number[]; target?: number[] };
      if (Array.isArray(saved.pos) && saved.pos.length === 3) {
        camera.position.fromArray(saved.pos);
        restoredCamera = true;
      }
      if (Array.isArray(saved.target) && saved.target.length === 3) {
        // target 在 controls 创建后才能设 ✓ → 先记下来 ✓
        (camera as unknown as { __savedTarget?: number[] }).__savedTarget = saved.target;
      }
    }
  } catch {
    /* 忽略 ✓ */
  }
  if (!restoredCamera) camera.position.set(200, 280, 420);
  cameraWasRestored = restoredCamera;

  const renderer = new THREE.WebGLRenderer({ antialias: true });

  // 环境贴图：金属感**必须**有东西可反射 ✗（否则 metalness 只影响反射项 → 和哑光没区别 ✗）
  // 用程序化 RoomEnvironment + PMREM，不引入外部 HDR ✓
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTexture;
  scene.environmentIntensity = 0.85;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(host.clientWidth, host.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // 与监控页的 3D 保持同一套观感：电影级色调映射 + 相同的曝光。
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  host.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  const savedTarget = (camera as unknown as { __savedTarget?: number[] }).__savedTarget;
  if (savedTarget && savedTarget.length === 3) {
    controls.target.fromArray(savedTarget);
  } else {
    controls.target.set(0, 190, 0);
  }
  controls.enableDamping = true;
  controls.maxDistance = 900;

  /**
   * **相机变化就存** ✓ —— 节流 500ms ✓（`change` 事件很频繁 ✗）。
   */
  let saveTimer = 0;
  const persistCamera = () => {
    if (saveTimer) return;
    saveTimer = window.setTimeout(() => {
      saveTimer = 0;
      try {
        window.localStorage.setItem(
          CAMERA_KEY,
          JSON.stringify({
            pos: camera.position.toArray(),
            target: controls.target.toArray(),
          }),
        );
      } catch {
        /* 忽略 ✓ */
      }
    }, 500);
  };
  controls.addEventListener("change", persistCamera);
  // ⚠ **不要在这里 lookAt / update** ✗ —— 相机和场景都还没建完 ✓，
  //   强行 update 会把初始姿态改掉 ✓ → 视角跑偏 ✓、轨迹看起来变成直线 ✗。
  //   存一次就够 ✓（恢复时用 `controls.target` 已经设过了 ✓）。

  const hemiLight = new THREE.HemisphereLight(0xd9ecff, colors.hemiGround, colors.hemiIntensity);
  scene.add(hemiLight);
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.8);
  keyLight.position.set(160, 300, 220);
  scene.add(keyLight);

  // 轮廓光 + 补光：与监控页 3D 用同一组参数，观感保持一致
  // （两处 3D 不一致会让人以为在看两个不同的设备）
  const rimLight = new THREE.DirectionalLight(0xcfe6ff, 1.6);
  rimLight.position.set(-220, 160, -260);
  scene.add(rimLight);
  const fillLight = new THREE.DirectionalLight(0xfff2e0, 0.55);
  fillLight.position.set(-180, 90, 200);
  scene.add(fillLight);

  // 网格 = **基座的竖直安装面**（XY 平面），贴在基座后侧 1mm。
  // 原来是一个 y=0 的水平面、且无偏移 ✗ —— 臂体沿 +Z 后基座就在原点，
  // 臂身会直接躺在那个网格里 ✗。
  let grid = new THREE.GridHelper(760, 38, colors.gridCenter, colors.gridLines);
  grid.rotation.x = Math.PI / 2;
  grid.position.set(0, 0, -1);
  scene.add(grid);

  const applyTheme = () => {
    colors = readThemeColors();
    scene.background = colors.background;
    hemiLight.groundColor = colors.hemiGround;
    hemiLight.intensity = colors.hemiIntensity;
    scene.remove(grid);
    grid.dispose();
    grid = new THREE.GridHelper(760, 38, colors.gridCenter, colors.gridLines);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(0, 0, -1);
    scene.add(grid);
  };
  const themeObserver = new MutationObserver(applyTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  const arm = createSlottedSkinnedArm(geometry);
  // 模型包标识色：材质是 **vertexColors** ✓，`material.color` 会与顶点色**相乘** ✓，
  // 所以这里设的是"染色"而不是覆盖 ✓（保留原有的明暗层次）。
  if (armTint) {
    const material = arm.mesh.material as THREE.MeshStandardMaterial;
    material.color.set(armTint);
    material.emissive.set(armTint);
    material.emissiveIntensity = 0.12;
  }
  // 表面质地：金属感 vs 哑光 ✓ —— 比染色更能区分模型，又不破坏银灰金属观感 ✓
  {
    const material = arm.mesh.material as THREE.MeshStandardMaterial;
    if (armFinish === "metal") {
      // 镜面金属：几乎全反射、极低粗糙度
      material.metalness = 1.0;
      material.roughness = 0.08;
      material.envMapIntensity = 1.6;
    } else {
      // 哑光涂层：完全不金属、极高粗糙度（散射为主）
      material.metalness = 0.0;
      material.roughness = 0.98;
      material.envMapIntensity = 0.55;
        // 「越软越黑」✓：color 与顶点色相乘，压到 0.55 倍 → 明显暗一档 ✓
        material.color.setRGB(0.55, 0.55, 0.55);
    }
    material.needsUpdate = true;
  }
  // ── 切线方向 = +Z ──────────────────────────────────────────────────
  // 臂体（含 rest 姿态与蒙皮）按 +Y 建模；绕 X 转 +90° ⇒ +Y → +Z，
  // 中轴切线落在 +Z，与「臂体形位预览」一致 ✓。
  // 用**常量欧拉角**而不是 Group：拾取/反解两处也要用同一个角，
  // 常量不跨 effect 作用域，省掉传引用的麻烦 ✓。
  arm.mesh.rotation.x = ARM_RENDER_ROTATION_X;
  scene.add(arm.mesh, arm.skeletonHelper);
  arm.skeletonHelper.visible = false;

  const cables = createCableVisuals(geometry.lengthMm, 0.42);
  cables.group.visible = showCables;
  cables.group.rotation.x = ARM_RENDER_ROTATION_X;
  scene.add(cables.group);

  // 拖动/播放轨迹线 ✓ —— **必须在这里建** ✓
  // （`animate` 在另一个 effect ✗ 拿不到 `scene` ✓）
  //
  // ⚠ 先**清掉模块级句柄** ✗：句柄是模块级的 ✓，但 `scene` 每次挂载都是新的 ✓ ——
  //   不清的话，第二次进页面会把线加到**已经销毁的场景**上 ✗ → 永远看不见 ✗。
  previewPathLine = null;
  ensurePreviewPathLine(scene);

  // ── 坐标系（基座原点）与重力箭头 ───────────────────────────────────
  // 臂体旋转后基座就在世界原点、臂身沿 +Z ⇒ 世界系直接放原点即可 ✓。
  const worldAxes = new THREE.AxesHelper(130);
  worldAxes.name = "drag_world_axes";
  worldAxes.renderOrder = 15;
  attachAxisLabels(worldAxes, 130, 26);
  scene.add(worldAxes);

  // 重力：恒定世界 −Y（不随臂体旋转）；起点在渲染循环里跟着**变形后的中段骨骼**走 ✓
  const gravityArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(0, 0, 0),
    165,
    0x7f8fa6,
    26,
    14,
  );
  gravityArrow.name = "drag_gravity_arrow";
  gravityArrow.renderOrder = 20;
  for (const part of [gravityArrow.line, gravityArrow.cone]) {
    const material = part.material as THREE.Material & { depthTest: boolean };
    material.depthTest = false;
    material.transparent = true;
    part.renderOrder = 20;
  }
  scene.add(gravityArrow);

  const anchorDot = new THREE.Mesh(
    new THREE.SphereGeometry(4.5, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0x7f8fa6, depthTest: false, transparent: true }),
  );
  anchorDot.name = "drag_gravity_anchor";
  anchorDot.renderOrder = 21;
  scene.add(anchorDot);

  // 末端局部系：跟着**末端骨骼**走（位置 + 姿态），+Z 对准末端切向 ✓。
  // 骨骼的 +Y 是骨长方向；绕 X 转 −90° 让 helper 的 +Z 落到骨长方向上
  // （用 +90° 会指回基座 ✗ —— 形位预览那边踩过这个坑）。
  const tipAxes = new THREE.AxesHelper(70);
  tipAxes.name = "drag_tip_axes";
  tipAxes.renderOrder = 16;
  attachAxisLabels(tipAxes, 70, 16);
  scene.add(tipAxes);

  // 每个**分段**一个局部坐标系（12 段 = 曲线分段的同一套划分 ✓）。
  // 尺寸取小（22mm）且不加 x/y/z 标注 —— 12 组标注会把画面糊死 ✗。
  const SEGMENT_FRAME_COUNT = 12;
  const segmentFrames: THREE.AxesHelper[] = [];
  for (let i = 0; i < SEGMENT_FRAME_COUNT; i += 1) {
    const frame = new THREE.AxesHelper(22);
    frame.name = `drag_segment_frame_${i}`;
    frame.renderOrder = 14;
    scene.add(frame);
    segmentFrames.push(frame);
  }

  // ── 末端手柄（Gizmo）────────────────────────────────────────────────
  // 一个三轴平移手柄贴在末端：拖它 = 直接给末端位置，走**同一个**反解器 ✓。
  // 比"拖着臂体在屏幕平面上移动"直观 —— 输入和目标在同一空间，不存在平面投影歧义 ✓。
  // 默认隐藏（控制模式里勾「末端手柄」才出现），不影响原有拖动 ✗。
  const tipProxy = new THREE.Object3D();
  tipProxy.name = "tip_gizmo_proxy";
  scene.add(tipProxy);

  const tipGizmo = new TransformControls(camera, renderer.domElement);
  tipGizmo.setSize(0.75);
  tipGizmo.setMode("translate");
  tipGizmo.attach(tipProxy);
  const tipGizmoHelper = tipGizmo.getHelper();
  tipGizmoHelper.visible = false;
  scene.add(tipGizmoHelper);

  // 手柄拖动期间要**锁住 OrbitControls**，否则相机跟着一起转 ✗
  const gizmoState = { dragging: false };
  tipGizmo.addEventListener("dragging-changed", (event) => {
    const value = (event as unknown as { value: boolean }).value;
    gizmoState.dragging = value;
    controls.enabled = !value;
  });

  // ── B：目标幽灵 + 漂移连线 ─────────────────────────────────────────
  // 幽灵 = 你拖到的目标点；连线 = 目标与实际末端的差。
  // 到不了的时候，"差多少"是看得见的 ✓，而不是"莫名其妙走歪了"✗。
  const targetGhost = new THREE.Mesh(
    new THREE.SphereGeometry(5, 12, 12),
    new THREE.MeshBasicMaterial({
      color: 0xff8c42, wireframe: true, depthTest: false, transparent: true, opacity: 0.9,
    }),
  );
  targetGhost.name = "tip_target_ghost";
  targetGhost.renderOrder = 22;
  targetGhost.visible = false;
  scene.add(targetGhost);

  const driftLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color: 0xff5a5a, depthTest: false, transparent: true, opacity: 0.9 }),
  );
  driftLine.name = "tip_drift_line";
  driftLine.renderOrder = 22;
  driftLine.visible = false;
  scene.add(driftLine);

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
    gravityArrow,
    anchorDot,
    tipAxes,
    segmentFrames,
    worldAxes,
    tipGizmo,
    tipGizmoHelper,
    tipProxy,
    gizmoState,
    targetGhost,
    driftLine,
    disposeScene: () => {
      themeObserver.disconnect();
      resizeObserver.disconnect();
    },
  };
}
