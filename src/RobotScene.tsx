import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { updateSegmentedBoneChain } from "./robot/kinematics";
import type { SegmentBendRad } from "./robot/kinematics";
import { createCableVisuals } from "./robot/cables";
import { createSlottedSkinnedArm } from "./robot/skinnedArm";

const LENGTH_MM = 404.8927;
const RADIUS_MM = 8.31;
const BONE_COUNT = 32;

export type BendDirection = "up" | "right" | "down" | "left";
const DIR_DEG: Record<BendDirection, number> = {
  up: 0,
  right: 90,
  down: 180,
  left: 270,
};

interface RobotSceneProps {
  section1AngleDeg: number;
  section2AngleDeg: number;
  section1Direction?: BendDirection;
  section2Direction?: BendDirection;
  showCables?: boolean;
  showSkeleton?: boolean;
  animateIdle?: boolean;
}

export default function RobotScene({
  section1AngleDeg,
  section2AngleDeg,
  section1Direction = "up",
  section2Direction = "up",
  showCables = true,
  showSkeleton = false,
  animateIdle = true,
}: RobotSceneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef({ section1AngleDeg, section2AngleDeg, section1Direction, section2Direction, animateIdle });
  propsRef.current = { section1AngleDeg, section2AngleDeg, section1Direction, section2Direction, animateIdle };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d1117);
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

    scene.add(new THREE.HemisphereLight(0xd9ecff, 0x1d2530, 2.1));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.8);
    keyLight.position.set(160, 300, 220);
    scene.add(keyLight);

    const grid = new THREE.GridHelper(220, 22, 0x2d3642, 0x1b232e);
    scene.add(grid);

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

    let currentSegments: [SegmentBendRad, SegmentBendRad] = [
      { angleRad: 0, directionRad: 0 },
      { angleRad: 0, directionRad: 0 },
    ];
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

      // Smooth target bend angles — read fresh props via ref
      const p = propsRef.current;
      const s1dir = DIR_DEG[p.section1Direction] * (Math.PI / 180);
      const s2dir = DIR_DEG[p.section2Direction] * (Math.PI / 180);
      const s1angle = THREE.MathUtils.degToRad(
        THREE.MathUtils.clamp(p.section1AngleDeg, -85, 85),
      );
      const s2angle = THREE.MathUtils.degToRad(
        THREE.MathUtils.clamp(p.section2AngleDeg, -85, 85),
      );

      const smoothing = 0.2;
      const lambda = THREE.MathUtils.lerp(22, 3, smoothing);
      currentSegments = [
        {
          angleRad: THREE.MathUtils.damp(currentSegments[0].angleRad, s1angle, lambda, dt),
          directionRad: THREE.MathUtils.damp(currentSegments[0].directionRad, s1dir, lambda, dt),
        },
        {
          angleRad: THREE.MathUtils.damp(currentSegments[1].angleRad, s2angle, lambda, dt),
          directionRad: THREE.MathUtils.damp(currentSegments[1].directionRad, s2dir, lambda, dt),
        },
      ];

      updateSegmentedBoneChain(arm.bones, LENGTH_MM, currentSegments, "constant");
      cables.updateSegments(currentSegments, 6.45, true);

      // Gentle idle sway when angles are small
      if (p.animateIdle && Math.abs(p.section1AngleDeg) < 2 && Math.abs(p.section2AngleDeg) < 2) {
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
      resizeObserver.disconnect();
      controls.dispose();
      cables.dispose();
      arm.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
    };
  }, []);

  return <div className="robot-scene" ref={hostRef} />;
}
