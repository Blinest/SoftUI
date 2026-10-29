import { useEffect, useRef, useState } from "react";
import { getArmView, onArmViewChange, setArmView, type ArmViewMode } from "./robot/armView";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { BackboneOutput } from "./dynamics/svcModel";
import { dampBackbone, updateBoneChainFromBackbone } from "./robot/kinematics";
import { createCableVisuals } from "./robot/cables";
import { createSlottedSkinnedArm } from "./robot/skinnedArm";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/**
 * 臂长缺省值（兜底）。**实际值由 `lengthMm` prop 传入** ✓
 * —— 换模型包时 445 / 400mm 不同，写死会让视图与链路上的段长不一致 ✗。
 */
const DEFAULT_LENGTH_MM = 404.8927;
const RADIUS_MM = 8.31;
const BONE_COUNT = 32;

interface RobotSceneProps {
  backbone: BackboneOutput;
  showCables?: boolean;
  showSkeleton?: boolean;
  animateIdle?: boolean;
  /** 臂长（mm）—— 来自当前模型包 ✓。缺省值只是兜底。 */
  lengthMm?: number;
  /** 臂体标识色（**当前不染色** ✓，恒为 null）。 */
  armTint?: string | null;
  /** 表面质地：`metal` 金属感 / `matte` 哑光 ✓（用来区分模型）*/
  armFinish?: "metal" | "matte";
}

/**
 * 画一个轴标签 Sprite：**Times New Roman 斜体**（数学记号的惯例）。
 *
 * - Sprite 永远正对相机 ✓，转视角时字不会被压扁
 * - `toneMapped: false` 很关键：ACES 色调映射会把纯红/绿/蓝压暗发灰 ✗，
 *   标签需要和轴的颜色**完全一致** ✓
 */
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
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(sizeMm, sizeMm, 1);
  sprite.renderOrder = 30;
  return sprite;
}

/** 给一个坐标系挂上 x / y / z 三个斜体标签（作为它的子节点，跟着一起转）。 */
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

export default function RobotScene({
  backbone,
  showCables = true,
  showSkeleton = false,
  animateIdle = true,
  lengthMm = DEFAULT_LENGTH_MM,
  armTint = null,
  armFinish = "matte",
}: RobotSceneProps) {
  /** 视角模式来自**共享状态**（与控制的臂体控制同步）。 */
  const [viewMode, setViewMode] = useState<ArmViewMode>(getArmView);
  const viewModeRef = useRef<ArmViewMode>(viewMode);
  viewModeRef.current = viewMode;

  useEffect(() => {
    // 另一处切换了视角 → 这里跟着变（不写回 localStorage，避免来回广播）
    return onArmViewChange((mode) => {
      setViewMode(mode);
      viewModeRef.current = mode;
    });
  }, []);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef({ backbone, animateIdle });
  propsRef.current = { backbone, animateIdle };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // WebGL 不吃 CSS 变量，场景底色/网格色必须自己跟着 data-theme 走，
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
    const camera = new THREE.PerspectiveCamera(36, host.clientWidth / host.clientHeight, 0.1, 1800);
    // 臂体转成水平后（见下方 armGroup），相机改成**侧视**——这样整根臂在屏幕上是横着的。
    camera.position.set(150, 260, 540);
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
    // 电影级色调映射：曲面高光不再一片死白，明暗过渡才有层次。
    // 只作用于渲染内容，不影响 canvas 背景色（主题色仍由 scene.background 控制）✓。
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    // 软投影：臂体在地面上有一层淡淡的落影，"悬在空中"的塑料感会消失很多。
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxDistance = 900;
    // 平移：默认是右键/中键拖动，很多人以为"不能平移"✗。
    // screenSpacePanning = true 让平移沿**屏幕平面**走（不会莫名其妙地沿视线纵深跑），更符合直觉。
    controls.enablePan = true;
    controls.screenSpacePanning = true;
    controls.panSpeed = 1.1;
    // 不加 listenToKeyEvents(window)：那会让方向键在**整个页面**被画布吃掉 ✗
    // （命令面板 / 列表导航都会失效）。

    // ── 浏览器手势屏蔽 ────────────────────────────────────────────────
    // 右键会弹上下文菜单、中键会启动"自动滚屏"，两者都会硬生生打断平移 ✗。
    // 只在**画布上**屏蔽，不影响页面其它区域。
    const canvas = renderer.domElement;
    const blockContextMenu = (event: Event) => event.preventDefault();
    const blockMiddleAutoscroll = (event: MouseEvent) => {
      if (event.button === 1) event.preventDefault();
    };
    canvas.addEventListener("contextmenu", blockContextMenu);
    canvas.addEventListener("mousedown", blockMiddleAutoscroll);

    // ── Shift + 左键 = 平移 ──────────────────────────────────────────
    // 右键/中键在浏览器里天然有别的含义 ✓，所以给一个**不用碰它们**的入口：
    // 按住 Shift 时把左键临时切成 PAN，松开恢复 ROTATE（CAD / Figma 的习惯）。
    const onShift = (event: KeyboardEvent) => {
      if (event.key !== "Shift") return;
      controls.mouseButtons.LEFT =
        event.type === "keydown" ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    };
    window.addEventListener("keydown", onShift);
    window.addEventListener("keyup", onShift);

    const hemiLight = new THREE.HemisphereLight(0xd9ecff, colors.hemiGround, colors.hemiIntensity);
    scene.add(hemiLight);
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.8);
    keyLight.position.set(160, 300, 220);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    // 默认平行光的阴影相机很小，臂长 400mm 会被裁掉 —— 这里按臂长放宽。
    keyLight.shadow.camera.left = -450;
    keyLight.shadow.camera.right = 450;
    keyLight.shadow.camera.top = 450;
    keyLight.shadow.camera.bottom = -450;
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 1400;
    keyLight.shadow.bias = -0.0006;
    scene.add(keyLight);

    // ── 力示意：重力 + 尖端力 ─────────────────────────────────────────
    // 坐标系：世界 +Y 朝上 ⇒ 重力沿 −Y；末端在原点、法向 +Z ⇒ 尖端力沿 +Z。
    // 两枝箭头都加在**场景**（不是 armGroup）—— 它们表示的是世界里的方向，
    // 不该跟着臂体一起转 ✗。
    const arrowHeadLength = 26;
    const arrowHeadWidth = 14;

    // 重力：挂在臂身中点，长度固定（示意用，不按 F=mg 缩放）
    // 起点就在**臂体圆心的正中心**（轴线上）✓。
    // 从轴心出发会被臂身表面挡住 ✗ —— 所以下面把材质设成 depthTest = false
    // 且提高 renderOrder，让箭头**始终画在最上层**（注释类图形的常规做法）。
    const gravityArrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, -1, 0),
      new THREE.Vector3(0, 0, -lengthMm / 2),
      165,
      0x7f8fa6,
      arrowHeadLength,
      arrowHeadWidth,
    );
    gravityArrow.name = "force_arrow_gravity";
    // 始终可见：只关深度测试、不改颜色混合（否则箭头会半透明）
    gravityArrow.renderOrder = 20;
    const arrowParts = [gravityArrow.line, gravityArrow.cone];
    for (const part of arrowParts) {
      const material = part.material as THREE.Material & { depthTest: boolean };
      material.depthTest = false;
      material.transparent = true;
      part.renderOrder = 20;
    }

    // 起点处一个小圆点，标出"这根箭头是从圆心出发的" ✓
    const anchorDot = new THREE.Mesh(
      new THREE.SphereGeometry(4.5, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0x7f8fa6, depthTest: false, transparent: true }),
    );
    anchorDot.position.set(0, 0, -lengthMm / 2);
    anchorDot.renderOrder = 21;
    anchorDot.name = "force_arrow_gravity_anchor";
    scene.add(anchorDot);

    scene.add(gravityArrow);

    // ── 坐标系 ────────────────────────────────────────────────────────
    // 全局系：固结在**基座（世界原点）**，X 红 / Y 绿 / Z 蓝。
    const worldAxes = new THREE.AxesHelper(130);
    worldAxes.name = "world_axes_helper";
    worldAxes.renderOrder = 15;
    attachAxisLabels(worldAxes, 130, 26);
    scene.add(worldAxes);

    // 末端局部系：跟着末端骨骼走（位置 + 姿态）。骨骼的 +Y 沿切向，
    // 预转 90°（绕 X）让它的 **+Z 对准末端切向**，与全局系的 Z 含义一致。
    const tipAxes = new THREE.AxesHelper(70);
    tipAxes.name = "tip_axes_helper";
    tipAxes.renderOrder = 16;
    attachAxisLabels(tipAxes, 70, 16);
    scene.add(tipAxes);
    const tipQuat = new THREE.Quaternion();

    // 尖端力：起点就是末端（原点），沿末端外法向 +Z

    // 接影地面：只画阴影本身（ShadowMaterial），不挡背景/网格
    const shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(1200, 1200),
      new THREE.ShadowMaterial({ opacity: 0.2 }),
    );
    shadowPlane.rotation.x = -Math.PI / 2;
    // 接影面与网格同面同向（竖直），否则影子会飘在另一个平面上
    shadowPlane.rotation.set(Math.PI / 2, 0, 0);
    shadowPlane.position.set(0, 0, -1.2);
    shadowPlane.receiveShadow = true;
    scene.add(shadowPlane);

    // 轮廓光（背后偏上，冷色）：沿曲面边缘勾出一道亮边，立体感立刻出来。
    const rimLight = new THREE.DirectionalLight(0xcfe6ff, 1.6);
    rimLight.position.set(-220, 160, -260);
    scene.add(rimLight);

    // 补光（弱、暖）：把主光造成的死黑侧面提起来，避免"一半全黑"。
    const fillLight = new THREE.DirectionalLight(0xfff2e0, 0.55);
    fillLight.position.set(-180, 90, 200);
    scene.add(fillLight);

    // 网格 = **基座的安装面（竖直墙）**，不是地面 ✗。
    // 方案 A 下臂身沿 −Z，基座圆盘落在 XY 平面里；水平的网格永远和它不重合 ✗，
    // 所以这里把网格绕 X 转 90° 立起来，并放到基座后面（z = −L − 1）。
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

    const arm = createSlottedSkinnedArm({
      lengthMm: lengthMm,
      radiusMm: RADIUS_MM,
      radialSegments: 72,
      axialSegments: 220,
      slotPitchMm: 24.2,
      slotDuty: 0.42,
      boneCount: BONE_COUNT,
    });
    // 模型包标识色：材质是 vertexColors ✓，`material.color` 与顶点色**相乘** ✓
    if (armTint) {
      const material = arm.mesh.material as THREE.MeshStandardMaterial;
      material.color.set(armTint);
      material.emissive.set(armTint);
      material.emissiveIntensity = 0.12;
    }
    // 表面质地：金属感 vs 哑光 ✓
    {
      const material = arm.mesh.material as THREE.MeshStandardMaterial;
      if (armFinish === "metal") {
        material.metalness = 1.0;
        material.roughness = 0.08;
        material.envMapIntensity = 1.6;
      } else {
        material.metalness = 0.0;
        material.roughness = 0.98;
        material.envMapIntensity = 0.55;
        // 「越软越黑」✓：color 与顶点色相乘，压到 0.55 倍 → 明显暗一档 ✓
        material.color.setRGB(0.55, 0.55, 0.55);
      }
      material.needsUpdate = true;
    }
    // ── 全局坐标系固结在**基座**（世界原点）──────────────────────────
    // 建模时臂沿 +Y（0..L）。绕 X 转 +90° 把 +Y 映射到 +Z ⇒
    //   **基座（模型 y=0）落在世界原点**，臂身沿 **+Z** 伸出，
    //   末端切向（圆盘法向）同样是 +Z ✓。
    // 不再额外平移：基座即原点，这是机器人学的标准基座系。
    const armGroup = new THREE.Group();
    armGroup.rotation.x = Math.PI / 2;
    armGroup.add(arm.mesh, arm.skeletonHelper);
    arm.mesh.traverse((child) => {
      if ("castShadow" in child) {
        (child as THREE.Mesh).castShadow = true;
      }
    });
    scene.add(armGroup);

    // 视角切换：只在模式变化时改一次相机/朝向，不与用户手动拖动视角打架。
    let appliedView: ArmViewMode | null = null;
    const applyView = (mode: ArmViewMode) => {
      if (mode === appliedView) return;
      appliedView = mode;
      // 臂体朝向固定（末端在原点、沿 −Z），这里只改相机。
      // 距离按**看全整根臂**算：臂长 L，竖直视场 fov ⇒ 需要
      //   d = (L/2) / sin(fov/2)
      // 再乘 1.25 留边。写死 620/640 在窗口变窄或 fov 不同时会看不全 ✗。
      const fovRad = (camera.fov * Math.PI) / 180;
      const distance = ((lengthMm / 2) / Math.sin(fovRad / 2)) * 1.25;
      // 支点取臂身中点（末端在原点、臂身沿 −Z），这样整根臂在画面里居中
      controls.target.set(0, 0, lengthMm / 2);
      if (mode === "horizontal") {
        camera.position.set(distance * 0.96, distance * 0.26, lengthMm / 2);
      } else {
        camera.position.set(0, distance * 0.99, lengthMm / 2);
      }
      controls.update();
    };
    arm.skeletonHelper.visible = showSkeleton;

    const cables = createCableVisuals(lengthMm, 0.42);
    cables.group.visible = showCables;
    armGroup.add(cables.group);

    let smoothedBackbone: BackboneOutput | null = null;
    let lastTime = performance.now();
    let animFrameId = 0;

    const resizeObserver = new ResizeObserver(() => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    resizeObserver.observe(host);

    const animate = () => {
      animFrameId = requestAnimationFrame(animate);
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;

      const p = propsRef.current;
      smoothedBackbone = dampBackbone(smoothedBackbone, p.backbone, 0.2, dt);
      updateBoneChainFromBackbone(arm.bones, lengthMm, smoothedBackbone);
      cables.updateBackbone(smoothedBackbone, 6.45, true);

      const maxCurvature = smoothedBackbone.distribution.segments.reduce((max, segment) => Math.max(max, segment.kappaAbsPerM), 0);
      if (p.animateIdle && maxCurvature < 0.2) {
        const sway = Math.sin(now * 0.001) * 0.02;
        arm.mesh.rotation.z = sway;
        arm.mesh.rotation.x = Math.sin(now * 0.0007 + 1) * 0.015;
      } else {
        arm.mesh.rotation.z = 0;
        arm.mesh.rotation.x = 0;
      }

      // 重力箭头：起点跟着**变形后的中心线**走。
      //
      // ⚠️ 不要用 `backbone.pointM` 再手动套 armGroup 的变换 ✗：
      //   骨架（物理）沿 **+Z**，而臂体网格沿 **+Y** 建模 —— 再乘一次组变换会多转 90°。
      //   直接取**骨骼的世界坐标**最稳：骨骼已经带着全部变形与组变换 ✓。
      const skeletonBones = arm.mesh.skeleton?.bones;
      if (skeletonBones && skeletonBones.length > 0) {
        const midBone = skeletonBones[Math.floor(skeletonBones.length / 2)];
        if (midBone) {
          const worldPoint = new THREE.Vector3();
          midBone.getWorldPosition(worldPoint);
          gravityArrow.position.copy(worldPoint);
          if (anchorDot) anchorDot.position.copy(worldPoint);
        }
      }

      // 末端局部系：位置 + 姿态都取末端骨骼，+Y→+Z 预转
      if (skeletonBones && skeletonBones.length > 0) {
        const tipBone = skeletonBones[skeletonBones.length - 1];
        if (tipBone) {
          tipBone.getWorldPosition(tipAxes.position);
          tipBone.getWorldQuaternion(tipQuat);
          tipAxes.quaternion.copy(tipQuat);
          // 绕 X 转 **−90°**：局部 +Z → 骨骼的 +Y（朝外）。
          // 用 +90° 时 +Z 会落到骨骼 −Y 上 —— 也就是指向基座，反了 ✗。
          tipAxes.rotateX(-Math.PI / 2);
        }
      }

      applyView(viewModeRef.current);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      canvas.removeEventListener("contextmenu", blockContextMenu);
      canvas.removeEventListener("mousedown", blockMiddleAutoscroll);
      window.removeEventListener("keydown", onShift);
      window.removeEventListener("keyup", onShift);
      cancelAnimationFrame(animFrameId);
      themeObserver.disconnect();
      resizeObserver.disconnect();
      controls.dispose();
      cables.dispose();
      arm.dispose();
      grid.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
  }, [lengthMm, armTint, armFinish]);   // 臂长/标识色/质地变了都要重建场景（材质在场景里定 ✓）

  return (
    <div className="robot-scene" ref={hostRef}>
      <button
        type="button"
        className="robot-scene-view-toggle"
        onClick={() => setArmView(viewMode === "horizontal" ? "vertical" : "horizontal")}
        title="切换视角：水平 / 竖直"
      >
        {viewMode === "horizontal" ? "水平" : "竖直"}
      </button>
    </div>
  );
}
