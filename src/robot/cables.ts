import * as THREE from "three";
import type { BackboneOutput } from "../dynamics/svcModel";
import { samplesFromBackbone, sampleConstantCurvature, type SegmentBendRad, samplePiecewiseConstantCurvature } from "./kinematics";

export interface CableVisuals {
  group: THREE.Group;
  update: (angleRad: number, directionRad: number, cableRadiusMm: number, tubular: boolean) => void;
  updateSegments: (segments: [SegmentBendRad, SegmentBendRad], cableRadiusMm: number, tubular: boolean) => void;
  updateBackbone: (backbone: BackboneOutput, cableRadiusMm: number, tubular: boolean) => void;
  dispose: () => void;
}

const CABLE_ANGLES = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3];
const CABLE_COLORS = [0xff4b3e, 0x2aa876, 0x2f6de0];

export function createCableVisuals(lengthMm: number, tubeRadiusMm: number): CableVisuals {
  const group = new THREE.Group();
  const objects: THREE.Object3D[] = [];

  function clearObjects(): void {
    for (const object of objects.splice(0)) {
      group.remove(object);
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material as THREE.Material | undefined;
      if (material) material.dispose();
    }
  }

  function update(angleRad: number, directionRad: number, cableRadiusMm: number, tubular: boolean): void {
    renderSamples(sampleConstantCurvature(lengthMm, angleRad, directionRad, 72), cableRadiusMm, tubular);
  }

  function updateSegments(segments: [SegmentBendRad, SegmentBendRad], cableRadiusMm: number, tubular: boolean): void {
    renderSamples(samplePiecewiseConstantCurvature(lengthMm, segments, 40), cableRadiusMm, tubular);
  }

  function updateBackbone(backbone: BackboneOutput, cableRadiusMm: number, tubular: boolean): void {
    renderSamples(samplesFromBackbone(backbone), cableRadiusMm, tubular);
  }

  function renderSamples(frame: ReturnType<typeof sampleConstantCurvature>, cableRadiusMm: number, tubular: boolean): void {
    clearObjects();
    CABLE_ANGLES.forEach((cableAngle, index) => {
      const points = frame.map((sample) => {
        const center = new THREE.Vector3(...sample.center);
        const normal = new THREE.Vector3(...sample.normal);
        const binormal = new THREE.Vector3(...sample.binormal);
        return center.add(normal.multiplyScalar(Math.cos(cableAngle) * cableRadiusMm)).add(binormal.multiplyScalar(Math.sin(cableAngle) * cableRadiusMm));
      });
      const material = tubular
        ? new THREE.MeshStandardMaterial({ color: CABLE_COLORS[index], roughness: 0.45 })
        : new THREE.LineBasicMaterial({ color: CABLE_COLORS[index], linewidth: 2 });
      if (tubular) {
        const geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 96, tubeRadiusMm, 8, false);
        const mesh = new THREE.Mesh(geometry, material);
        objects.push(mesh);
        group.add(mesh);
      } else {
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const line = new THREE.Line(geometry, material);
        objects.push(line);
        group.add(line);
      }
    });
  }

  return {
    group,
    update,
    updateSegments,
    updateBackbone,
    dispose: clearObjects,
  };
}
