import * as THREE from "three";
import type { BackboneOutput, BackboneSample } from "../dynamics/svcModel";
import { buildBackboneFromCurvatureDistribution, mapSvcPointToThreeMm, mapSvcVectorToThree } from "../dynamics/svcModel";
import type { ContinuumCommand, PoseSample, SegmentBend, TipPose } from "./types";

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function wrapRadians(angle: number): number {
  let result = angle % (Math.PI * 2);
  if (result < 0) result += Math.PI * 2;
  return result;
}

export interface SegmentBendRad {
  angleRad: number;
  directionRad: number;
}

export function mapSegmentBend(segment: SegmentBend, command: ContinuumCommand): SegmentBendRad {
  const sign = command.mapping.invertAngle ? -1 : 1;
  const directionSign = command.mapping.invertDirection ? -1 : 1;
  const angleDeg = clamp(segment.angleDeg, -85, 85) * sign;
  const directionDeg = segment.directionDeg * directionSign + command.mapping.offsetDeg;
  return {
    angleRad: angleDeg * DEG2RAD,
    directionRad: wrapRadians(directionDeg * DEG2RAD),
  };
}

export function applyDirectionMapping(command: ContinuumCommand): [SegmentBendRad, SegmentBendRad] {
  return [mapSegmentBend(command.targetSegments[0], command), mapSegmentBend(command.targetSegments[1], command)];
}

export function cableLengthsFromBending(angleRad: number, directionRad: number, cableRadiusMm: number): number[] {
  const a = angleRad * Math.cos(directionRad);
  const b = angleRad * Math.sin(directionRad);
  const cableAngles = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3];
  return cableAngles.map((alpha) => -cableRadiusMm * (a * Math.cos(alpha) + b * Math.sin(alpha)));
}

export function makeBoneWeights(count: number, mode: ContinuumCommand["mode"], activeSegments: [boolean, boolean]): number[] {
  const weights = Array.from({ length: count }, (_, index) => {
    const t = count <= 1 ? 0 : index / (count - 1);
    const segment = t < 0.5 ? 0 : 1;
    if (!activeSegments[segment]) return 0;
    if (mode === "constant") return 1;
    const taper = 0.55 + 0.45 * Math.sin(Math.PI * t);
    const slotCompliance = 0.88 + 0.12 * Math.sin(2 * Math.PI * 15 * t);
    return taper * slotCompliance;
  });
  const sum = weights.reduce((acc, item) => acc + item, 0);
  if (sum <= 1e-6) return Array(count).fill(0);
  return weights.map((item) => item / sum);
}

export function updateBoneChain(
  bones: THREE.Bone[],
  lengthMm: number,
  angleRad: number,
  directionRad: number,
  weights: number[],
): void {
  if (bones.length === 0) return;
  const segmentLength = lengthMm / Math.max(1, bones.length - 1);
  const bendAxis = new THREE.Vector3(Math.sin(directionRad), 0, -Math.cos(directionRad)).normalize();
  bones[0].position.set(0, 0, 0);
  bones[0].quaternion.identity();
  for (let index = 1; index < bones.length; index += 1) {
    bones[index].position.set(0, segmentLength, 0);
    const delta = angleRad * (weights[index - 1] ?? 0);
    bones[index].quaternion.setFromAxisAngle(bendAxis, delta);
  }
}

export function updateSegmentedBoneChain(
  bones: THREE.Bone[],
  lengthMm: number,
  segments: [SegmentBendRad, SegmentBendRad],
  mode: ContinuumCommand["mode"],
): void {
  if (bones.length === 0) return;
  const rotationCount = Math.max(1, bones.length - 1);
  const segmentLength = lengthMm / rotationCount;
  const weights = [Array(rotationCount).fill(0), Array(rotationCount).fill(0)] as [number[], number[]];

  for (let index = 0; index < rotationCount; index += 1) {
    const t = (index + 0.5) / rotationCount;
    const segmentIndex = t < 0.5 ? 0 : 1;
    if (mode === "constant") {
      weights[segmentIndex][index] = 1;
    } else {
      const localT = segmentIndex === 0 ? t * 2 : (t - 0.5) * 2;
      weights[segmentIndex][index] = 0.55 + 0.45 * Math.sin(Math.PI * localT);
    }
  }

  for (const segmentWeights of weights) {
    const sum = segmentWeights.reduce((acc, item) => acc + item, 0);
    if (sum > 1e-6) {
      for (let index = 0; index < segmentWeights.length; index += 1) segmentWeights[index] /= sum;
    }
  }

  bones[0].position.set(0, 0, 0);
  bones[0].quaternion.identity();
  for (let index = 1; index < bones.length; index += 1) {
    const rotationIndex = index - 1;
    const segmentIndex = rotationIndex + 0.5 < rotationCount / 2 ? 0 : 1;
    const segment = segments[segmentIndex];
    const bendAxis = new THREE.Vector3(Math.sin(segment.directionRad), 0, -Math.cos(segment.directionRad)).normalize();
    const delta = segment.angleRad * weights[segmentIndex][rotationIndex];
    bones[index].position.set(0, segmentLength, 0);
    bones[index].quaternion.setFromAxisAngle(bendAxis, delta);
  }
}

export function sampleConstantCurvature(lengthMm: number, angleRad: number, directionRad: number, samples: number): PoseSample[] {
  const direction = new THREE.Vector3(Math.cos(directionRad), 0, Math.sin(directionRad));
  const bendAxis = new THREE.Vector3(Math.sin(directionRad), 0, -Math.cos(directionRad)).normalize();
  const result: PoseSample[] = [];
  const curvature = Math.abs(angleRad) < 1e-6 ? 0 : angleRad / lengthMm;
  for (let index = 0; index < samples; index += 1) {
    const s = (lengthMm * index) / Math.max(1, samples - 1);
    const localAngle = curvature * s;
    let center: THREE.Vector3;
    if (Math.abs(curvature) < 1e-6) {
      center = new THREE.Vector3(0, s, 0);
    } else {
      center = direction
        .clone()
        .multiplyScalar((1 - Math.cos(localAngle)) / curvature)
        .add(new THREE.Vector3(0, Math.sin(localAngle) / curvature, 0));
    }
    const tangent = direction.clone().multiplyScalar(Math.sin(localAngle)).add(new THREE.Vector3(0, Math.cos(localAngle), 0)).normalize();
    const normal = direction.clone().multiplyScalar(Math.cos(localAngle)).add(new THREE.Vector3(0, -Math.sin(localAngle), 0)).normalize();
    result.push({
      center: center.toArray() as [number, number, number],
      tangent: tangent.toArray() as [number, number, number],
      normal: normal.toArray() as [number, number, number],
      binormal: bendAxis.toArray() as [number, number, number],
    });
  }
  return result;
}

export function samplePiecewiseConstantCurvature(lengthMm: number, segments: [SegmentBendRad, SegmentBendRad], samplesPerSegment: number): PoseSample[] {
  const result: PoseSample[] = [];
  const segmentLength = lengthMm / 2;
  let basePosition = new THREE.Vector3();
  let baseQuaternion = new THREE.Quaternion();

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const localSamples = sampleConstantCurvature(segmentLength, segment.angleRad, segment.directionRad, samplesPerSegment);
    const start = segmentIndex === 0 ? 0 : 1;
    for (let index = start; index < localSamples.length; index += 1) {
      const sample = localSamples[index];
      const center = new THREE.Vector3(...sample.center).applyQuaternion(baseQuaternion).add(basePosition);
      const tangent = new THREE.Vector3(...sample.tangent).applyQuaternion(baseQuaternion).normalize();
      const normal = new THREE.Vector3(...sample.normal).applyQuaternion(baseQuaternion).normalize();
      const binormal = new THREE.Vector3(...sample.binormal).applyQuaternion(baseQuaternion).normalize();
      result.push({
        center: center.toArray() as [number, number, number],
        tangent: tangent.toArray() as [number, number, number],
        normal: normal.toArray() as [number, number, number],
        binormal: binormal.toArray() as [number, number, number],
      });
    }

    const bendAxis = new THREE.Vector3(Math.sin(segment.directionRad), 0, -Math.cos(segment.directionRad)).normalize();
    const segmentRotation = new THREE.Quaternion().setFromAxisAngle(bendAxis, segment.angleRad);
    const endSample = localSamples[localSamples.length - 1];
    basePosition.add(new THREE.Vector3(...endSample.center).applyQuaternion(baseQuaternion));
    baseQuaternion.multiply(segmentRotation).normalize();
  }

  return result;
}

export function tipPose(lengthMm: number, angleRad: number, directionRad: number): TipPose {
  const sample = sampleConstantCurvature(lengthMm, angleRad, directionRad, 2)[1];
  return {
    position: sample.center,
    tangent: sample.tangent,
    angleDeg: angleRad * RAD2DEG,
    directionDeg: directionRad * RAD2DEG,
  };
}

export function segmentedTipPose(lengthMm: number, segments: [SegmentBendRad, SegmentBendRad]): TipPose {
  const samples = samplePiecewiseConstantCurvature(lengthMm, segments, 32);
  const sample = samples[samples.length - 1];
  return {
    position: sample.center,
    tangent: sample.tangent,
    angleDeg: segments.reduce((acc, item) => acc + item.angleRad, 0) * RAD2DEG,
    directionDeg: segments[segments.length - 1].directionRad * RAD2DEG,
  };
}

function toPoseSample(sample: BackboneSample): PoseSample {
  const center = mapSvcPointToThreeMm(sample.pointM);
  const tangent = mapSvcVectorToThree(sample.tangent);
  const normal = mapSvcVectorToThree(sample.normal);
  const binormal = mapSvcVectorToThree(sample.binormal);
  return {
    center,
    tangent,
    normal,
    binormal,
  };
}

export function samplesFromBackbone(backbone: BackboneOutput): PoseSample[] {
  return backbone.samples.map(toPoseSample);
}

export function sampleBackboneAtS(backbone: BackboneOutput, sMm: number): PoseSample {
  const samples = backbone.samples;
  if (samples.length === 0) {
    return { center: [0, 0, 0], tangent: [0, 1, 0], normal: [1, 0, 0], binormal: [0, 0, 1] };
  }
  const clamped = clamp(sMm, samples[0].sMm, samples[samples.length - 1].sMm);
  let nextIndex = samples.findIndex((sample) => sample.sMm >= clamped);
  if (nextIndex <= 0) return toPoseSample(samples[0]);
  const next = samples[nextIndex];
  const prev = samples[nextIndex - 1];
  const t = (clamped - prev.sMm) / Math.max(next.sMm - prev.sMm, 1e-6);
  const lerp3 = (a: [number, number, number], b: [number, number, number]): [number, number, number] => [
    THREE.MathUtils.lerp(a[0], b[0], t),
    THREE.MathUtils.lerp(a[1], b[1], t),
    THREE.MathUtils.lerp(a[2], b[2], t),
  ];
  const posePrev = toPoseSample(prev);
  const poseNext = toPoseSample(next);
  const normalize3 = (v: [number, number, number]): [number, number, number] => {
    const vector = new THREE.Vector3(...v).normalize();
    return vector.toArray() as [number, number, number];
  };
  return {
    center: lerp3(posePrev.center, poseNext.center),
    tangent: normalize3(lerp3(posePrev.tangent, poseNext.tangent)),
    normal: normalize3(lerp3(posePrev.normal, poseNext.normal)),
    binormal: normalize3(lerp3(posePrev.binormal, poseNext.binormal)),
  };
}

export function updateBoneChainFromBackbone(bones: THREE.Bone[], lengthMm: number, backbone: BackboneOutput): void {
  if (bones.length === 0) return;
  const rotationCount = Math.max(1, bones.length - 1);
  const segmentLength = lengthMm / rotationCount;
  const yAxis = new THREE.Vector3(0, 1, 0);
  const worldQuaternions: THREE.Quaternion[] = [];

  bones[0].position.set(0, 0, 0);
  bones[0].quaternion.identity();
  worldQuaternions[0] = new THREE.Quaternion();

  for (let index = 1; index < bones.length; index += 1) {
    const s = (index / rotationCount) * lengthMm;
    const sample = sampleBackboneAtS(backbone, s);
    const tangent = new THREE.Vector3(...sample.tangent).normalize();
    const worldQuaternion = new THREE.Quaternion().setFromUnitVectors(yAxis, tangent);
    const parentWorld = worldQuaternions[index - 1] ?? new THREE.Quaternion();
    const localQuaternion = parentWorld.clone().invert().multiply(worldQuaternion).normalize();
    bones[index].position.set(0, segmentLength, 0);
    bones[index].quaternion.copy(localQuaternion);
    worldQuaternions[index] = worldQuaternion;
  }
}

export function dampBackbone(current: BackboneOutput | null, target: BackboneOutput, smoothing: number, dt: number): BackboneOutput {
  if (!current || current.distribution.segments.length !== target.distribution.segments.length) return target;
  const lambda = THREE.MathUtils.lerp(22, 3, smoothing);
  const segments = target.distribution.segments.map((segment, index) => {
    const prev = current.distribution.segments[index];
    const kxPerM = THREE.MathUtils.damp(prev.kxPerM, segment.kxPerM, lambda, dt);
    const kyPerM = THREE.MathUtils.damp(prev.kyPerM, segment.kyPerM, lambda, dt);
    const kappaAbsPerM = Math.hypot(kxPerM, kyPerM);
    return {
      ...segment,
      kxPerM,
      kyPerM,
      kappaAbsPerM,
      phiRad: Math.atan2(-kxPerM, kyPerM),
    };
  });
  return buildBackboneFromCurvatureDistribution({ ...target.distribution, segments });
}

export function damp(current: number, target: number, smoothing: number, dt: number): number {
  const lambda = THREE.MathUtils.lerp(22, 3, smoothing);
  return THREE.MathUtils.damp(current, target, lambda, dt);
}
