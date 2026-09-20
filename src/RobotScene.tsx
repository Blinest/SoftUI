import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { BackboneOutput } from "./dynamics/svcModel";
import { dampBackbone, updateBoneChainFromBackbone } from "./robot/kinematics";
import { createCableVisuals } from "./robot/cables";
import { createSlottedSkinnedArm } from "./robot/skinnedArm";

const LENGTH_MM = 404.8927;
const RADIUS_MM = 8.31;
const BONE_COUNT = 32;

interface RobotSceneProps {
  backbone: BackboneOutput;
  showCables?: boolean;
  showSkeleton?: boolean;
  animateIdle?: boolean;
}

export default function RobotScene({
  backbone,
  showCables = true,
  showSkeleton = false,
  animateIdle = true,
}: RobotSceneProps) {
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

    const arm = createSlottedSkinnedArm({
      lengthMm: LENGTH_MM,
      radiusMm: RADIUS_MM,
      radialSegments: 72,
      axialSegments: 220,
      slotPitchMm: 24.2,
      slotDuty: 0.42,
      boneCount: BONE_COUNT,
    });
    scene.add(arm.mesh, arm.skeletonHelper);
    arm.skeletonHelper.visible = showSkeleton;

    const cables = createCableVisuals(LENGTH_MM, 0.42);
    cables.group.visible = showCables;
    scene.add(cables.group);

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
      updateBoneChainFromBackbone(arm.bones, LENGTH_MM, smoothedBackbone);
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

      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
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
  }, []);

  return <div className="robot-scene" ref={hostRef} />;
}
