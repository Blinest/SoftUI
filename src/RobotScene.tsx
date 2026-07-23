import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

interface RobotSceneProps {
  section1AngleDeg: number;
  section2AngleDeg: number;
}

function createSegment(
  group: THREE.Group,
  length: number,
  radiusTop: number,
  radiusBottom: number,
  material: THREE.Material,
  bendZ = 0,
  bendX = 0,
) {
  const joint = new THREE.Group();
  joint.rotation.z = bendZ;
  joint.rotation.x = bendX;
  group.add(joint);

  const segment = new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, length, 24, 1, false), material);
  segment.position.y = length / 2;
  joint.add(segment);

  const tip = new THREE.Mesh(new THREE.SphereGeometry(radiusTop * 0.95, 18, 18), material);
  tip.position.y = length;
  joint.add(tip);

  return joint;
}

export default function RobotScene({ section1AngleDeg, section2AngleDeg }: RobotSceneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return undefined;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f141b);
    scene.fog = new THREE.Fog(0x0f141b, 4, 10);

    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(2.8, 1.9, 4.2);
    camera.lookAt(0, 0.9, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.replaceChildren(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0.8, 0);
    controls.minDistance = 2.2;
    controls.maxDistance = 8;
    controls.maxPolarAngle = Math.PI / 2.05;

    const ambient = new THREE.AmbientLight(0xdde7f4, 1.5);
    scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0x88c8ff, 2.4);
    keyLight.position.set(3, 4.4, 3.2);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0x69f0ae, 0.95);
    fillLight.position.set(-2, 2.6, 1);
    scene.add(fillLight);

    const grid = new THREE.GridHelper(8, 16, 0x344251, 0x24303d);
    grid.position.y = -0.01;
    scene.add(grid);

    const baseMaterial = new THREE.MeshStandardMaterial({
      color: 0x60758f,
      metalness: 0.14,
      roughness: 0.48,
    });

    const accentMaterial = new THREE.MeshStandardMaterial({
      color: 0x86c8ff,
      metalness: 0.08,
      roughness: 0.28,
      emissive: 0x102539,
    });

    const root = new THREE.Group();
    root.position.set(0, -0.1, 0);
    scene.add(root);

    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 0.28, 28), baseMaterial);
    base.position.y = 0.14;
    root.add(base);

    const stage = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.28, 0.12, 24), accentMaterial);
    stage.position.y = 0.36;
    root.add(stage);

    const section1 = new THREE.Group();
    section1.position.set(0, 0.44, 0);
    root.add(section1);
    createSegment(section1, 1.35, 0.2, 0.26, baseMaterial, THREE.MathUtils.degToRad(section1AngleDeg * 0.6), 0);

    const section1Overlay = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.03, 12, 36), accentMaterial);
    section1Overlay.position.set(0, 1.02, 0);
    section1Overlay.rotation.x = Math.PI / 2;
    section1.add(section1Overlay);

    const section2 = new THREE.Group();
    section2.position.set(0, 1.76, 0);
    root.add(section2);
    createSegment(section2, 1.08, 0.16, 0.2, accentMaterial, THREE.MathUtils.degToRad(section2AngleDeg * 0.65), 0);

    const endEffector = new THREE.Mesh(new THREE.SphereGeometry(0.12, 20, 20), new THREE.MeshStandardMaterial({
      color: 0xdbe5ef,
      metalness: 0.06,
      roughness: 0.42,
    }));
    endEffector.position.set(0, 2.88, 0);
    root.add(endEffector);

    const targetRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.42, 0.03, 12, 36),
      new THREE.MeshStandardMaterial({ color: 0x42c97a, emissive: 0x0d2419, roughness: 0.2 }),
    );
    targetRing.position.set(0.45, 2.18, 0);
    targetRing.rotation.x = Math.PI / 2;
    root.add(targetRing);

    const secondaryRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.34, 0.025, 12, 36),
      new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0x231506, roughness: 0.26 }),
    );
    secondaryRing.position.set(-0.25, 1.24, 0);
    secondaryRing.rotation.x = Math.PI / 2;
    root.add(secondaryRing);

    const clock = new THREE.Clock();
    let animationFrame = 0;

    const render = () => {
      const elapsed = clock.getElapsedTime();
      root.rotation.y = Math.sin(elapsed * 0.25) * 0.12;
      root.position.y = Math.sin(elapsed * 0.9) * 0.02;
      root.rotation.x = Math.sin(elapsed * 0.18) * 0.03;
      controls.update();
      renderer.render(scene, camera);
      animationFrame = window.requestAnimationFrame(render);
    };

    const resize = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      renderer.render(scene, camera);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    render();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      host.replaceChildren();
    };
  }, [section1AngleDeg, section2AngleDeg]);

  return <div className="robot-scene" ref={hostRef} />;
}
