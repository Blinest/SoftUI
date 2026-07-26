import * as THREE from "three";
import type { RobotGeometryConfig } from "./types";

export interface SkinnedArmModel {
  mesh: THREE.SkinnedMesh;
  bones: THREE.Bone[];
  skeleton: THREE.Skeleton;
  skeletonHelper: THREE.SkeletonHelper;
  dispose: () => void;
}

export function createSlottedSkinnedArm(config: RobotGeometryConfig): SkinnedArmModel {
  const geometry = new THREE.BufferGeometry();
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const skinIndices: number[] = [];
  const skinWeights: number[] = [];
  const indices: number[] = [];
  const colors: number[] = [];

  for (let yIndex = 0; yIndex <= config.axialSegments; yIndex += 1) {
    const y = (config.lengthMm * yIndex) / config.axialSegments;
    const slotPhase = (y % config.slotPitchMm) / config.slotPitchMm;
    const slotBand = slotPhase > 0.18 && slotPhase < 0.18 + config.slotDuty;
    const ribScale = slotBand ? 0.93 : 1;
    for (let radialIndex = 0; radialIndex <= config.radialSegments; radialIndex += 1) {
      const u = radialIndex / config.radialSegments;
      const theta = u * Math.PI * 2;
      const radiusRipple = 1 + 0.018 * Math.sin(2 * Math.PI * y / config.slotPitchMm);
      const r = config.radiusMm * ribScale * radiusRipple;
      const x = Math.cos(theta) * r;
      const z = Math.sin(theta) * r;
      positions.push(x, y, z);
      normals.push(Math.cos(theta), 0, Math.sin(theta));
      uvs.push(u, y / config.lengthMm);

      const boneFloat = (y / config.lengthMm) * (config.boneCount - 1);
      const bone0 = Math.min(config.boneCount - 1, Math.floor(boneFloat));
      const bone1 = Math.min(config.boneCount - 1, bone0 + 1);
      const w1 = boneFloat - bone0;
      skinIndices.push(bone0, bone1, 0, 0);
      skinWeights.push(1 - w1, w1, 0, 0);

      const base = slotBand ? 0.43 : 0.73;
      colors.push(base * 0.7, base * 0.92, base);
    }
  }

  const stride = config.radialSegments + 1;
  for (let yIndex = 0; yIndex < config.axialSegments; yIndex += 1) {
    const slotPhase = (((config.lengthMm * (yIndex + 0.5)) / config.axialSegments) % config.slotPitchMm) / config.slotPitchMm;
    const slotBand = slotPhase > 0.18 && slotPhase < 0.18 + config.slotDuty;
    for (let radialIndex = 0; radialIndex < config.radialSegments; radialIndex += 1) {
      const theta = ((radialIndex + 0.5) / config.radialSegments) * Math.PI * 2;
      const openWindow = slotBand && Math.abs(Math.sin(3 * theta)) > 0.42;
      if (openWindow) continue;
      const a = yIndex * stride + radialIndex;
      const b = a + 1;
      const c = (yIndex + 1) * stride + radialIndex;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeights, 4));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  const bones: THREE.Bone[] = [];
  const segmentLength = config.lengthMm / Math.max(1, config.boneCount - 1);
  for (let index = 0; index < config.boneCount; index += 1) {
    const bone = new THREE.Bone();
    bone.name = `axis_bone_${String(index).padStart(2, "0")}`;
    bone.position.y = index === 0 ? 0 : segmentLength;
    if (index > 0) bones[index - 1].add(bone);
    bones.push(bone);
  }

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.62,
    metalness: 0.04,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = "procedural_slotted_continuum_arm";
  mesh.add(bones[0]);
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton);

  const skeletonHelper = new THREE.SkeletonHelper(mesh);
  skeletonHelper.visible = false;

  return {
    mesh,
    bones,
    skeleton,
    skeletonHelper,
    dispose: () => {
      geometry.dispose();
      material.dispose();
      skeleton.dispose();
    },
  };
}
