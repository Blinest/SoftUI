import type { DeviceSnapshot } from "../softuiTypes";

export interface SectionCurvatureState {
  curvaturePerM: number;
  directionDeg: number;
}

export interface DynamicsConfig {
  segmentLengthM: [number, number];
  cableRadiusM: number;
  bendingStiffness: number;
  forceBaseN: number;
  forceAmpN: [number, number];
  backbonePointsPerSegment: number;
  maxCurvaturePerM: [number, number];
}

export interface CurvatureBasisSegment {
  index: number;
  sStartMm: number;
  sEndMm: number;
  sMidMm: number;
  lengthMm: number;
  kxPerM: number;
  kyPerM: number;
  kappaAbsPerM: number;
  phiRad: number;
}

export type CurvatureDerivationSource =
  | "sensorMotorFusion"
  | "forceOnly"
  | "motorOnly"
  | "legacyBendFallback";

export interface CurvatureDerivationDiagnostics {
  source: CurvatureDerivationSource;
  tendonForcesN: number[];
  cableDisplacementsMm: number[];
  missingSensorChannels: number[];
  missingMotorChannels: number[];
  forceConfidence: number;
  displacementConfidence: number;
  stiffnessMode: "linear" | "nonlinear";
  warnings: string[];
}

export interface CurvatureDistribution {
  totalLengthMm: number;
  basisSegmentCount: number;
  source: CurvatureDerivationSource | "legacyTwoChannelFit" | "deviceCurvature" | "simulated";
  segments: CurvatureBasisSegment[];
  diagnostics?: CurvatureDerivationDiagnostics;
}

export interface BackboneSample {
  sMm: number;
  pointM: [number, number, number];
  tangent: [number, number, number];
  normal: [number, number, number];
  binormal: [number, number, number];
  kxPerM: number;
  kyPerM: number;
  kappaAbsPerM: number;
}

export interface BackboneOutput {
  distribution: CurvatureDistribution;
  samples: BackboneSample[];
  pointsM: [number, number, number][];
  kxPerM: number[];
  kyPerM: number[];
  sMm: number[];
  kappaAbsPerM: number[];
  segmentCurvaturePerM: number[];
  segmentDirectionRad: number[];
}

export interface BackboneSummary {
  maxKappaPerM: number;
  meanKappaPerM: number;
  tipOffsetMm: number;
  tipPositionMm: [number, number, number];
  basisSegmentCount: number;
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const LEGACY_MAX_BEND_DEG = 85;
export const DEFAULT_CURVATURE_BASIS_SEGMENTS = 12;
const DEFAULT_TOTAL_LENGTH_MM = 400;

export interface ForceChannelMapping {
  cableIndex: number;
  sensorId: number;
  axisIndex: 0 | 1 | 2;
  zeroN: number;
  gain: number;
  sign: 1 | -1;
  clampMinN: number;
}

export interface MotorCableMapping {
  cableIndex: number;
  motorId: number;
  zeroMm: number;
  gainMmPerMotorMm: number;
  sign: 1 | -1;
}

export interface CurvatureDerivationConfig {
  segmentLengthM: [number, number];
  totalLengthMm: number;
  basisSegmentCount: number;
  cableRadiusM: number;
  linearEiNm2: [number, number];
  nonlinearC0Nm2: number;
  nonlinearEiMinNm2: number;
  stiffnessMode: "linear" | "nonlinear";
  fusionMode: "force" | "displacement" | "fused" | "legacy";
  forceWeight: number;
  displacementWeight: number;
  sensorMappings: ForceChannelMapping[];
  motorMappings: MotorCableMapping[];
}

export const DEFAULT_SENSOR_MAPPINGS: ForceChannelMapping[] = [0, 1, 2, 3, 4, 5].map((cableIndex) => ({
  cableIndex,
  sensorId: cableIndex + 1,
  axisIndex: 0 as const,
  zeroN: 0,
  gain: 1,
  sign: 1 as const,
  clampMinN: 0,
}));

export const DEFAULT_MOTOR_MAPPINGS: MotorCableMapping[] = [0, 1, 2, 3, 4, 5].map((cableIndex) => ({
  cableIndex,
  motorId: cableIndex + 1,
  zeroMm: 0,
  gainMmPerMotorMm: 1,
  sign: 1 as const,
}));

export const DEFAULT_CURVATURE_DERIVATION_CONFIG: CurvatureDerivationConfig = {
  segmentLengthM: [0.200, 0.200],
  totalLengthMm: 400,
  basisSegmentCount: DEFAULT_CURVATURE_BASIS_SEGMENTS,
  cableRadiusM: 0.006,
  linearEiNm2: [0.04, 0.04],
  nonlinearC0Nm2: 0.128,
  nonlinearEiMinNm2: 1e-4,
  stiffnessMode: "linear",
  fusionMode: "fused",
  forceWeight: 0.35,
  displacementWeight: 0.65,
  sensorMappings: DEFAULT_SENSOR_MAPPINGS,
  motorMappings: DEFAULT_MOTOR_MAPPINGS,
};

export const DEFAULT_DYNAMICS_CONFIG: DynamicsConfig = {
  segmentLengthM: [0.200, 0.200],
  cableRadiusM: 0.006,
  bendingStiffness: 0.2,
  forceBaseN: 4.0,
  forceAmpN: [90.0, 55.0],
  backbonePointsPerSegment: 60,
  maxCurvaturePerM: [
    (LEGACY_MAX_BEND_DEG * DEG2RAD) / 0.200,
    (LEGACY_MAX_BEND_DEG * DEG2RAD) / 0.200,
  ],
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = clamp((value - edge0) / Math.max(edge1 - edge0, 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function normalize(v: [number, number, number], fallback: [number, number, number]): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len < 1e-9 || !Number.isFinite(len)) return fallback;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function svcToThreeMm(pointM: [number, number, number]): [number, number, number] {
  return [pointM[0] * 1000, pointM[2] * 1000, pointM[1] * 1000];
}

export function mapSvcVectorToThree(v: [number, number, number]): [number, number, number] {
  return [v[0], v[2], v[1]];
}

export function mapSvcPointToThreeMm(pointM: [number, number, number]): [number, number, number] {
  return svcToThreeMm(pointM);
}

function directionNameToDeg(direction: string | undefined) {
  return direction === "right" ? 90 : direction === "down" ? 180 : direction === "left" ? 270 : 0;
}

function curvatureVector(curvaturePerM: number, directionDeg: number): { kxPerM: number; kyPerM: number; phiRad: number } {
  const signedCurvature = finiteOr(curvaturePerM, 0);
  const basePhi = finiteOr(directionDeg, 0) * DEG2RAD;
  const phiRad = signedCurvature >= 0 ? basePhi : basePhi + Math.PI;
  const kappaAbsPerM = Math.abs(signedCurvature);
  return {
    kxPerM: -kappaAbsPerM * Math.sin(phiRad),
    kyPerM: kappaAbsPerM * Math.cos(phiRad),
    phiRad,
  };
}

function makeSegment(index: number, count: number, totalLengthMm: number, kxPerM: number, kyPerM: number): CurvatureBasisSegment {
  const lengthMm = totalLengthMm / count;
  const sStartMm = index * lengthMm;
  const sEndMm = sStartMm + lengthMm;
  const sMidMm = (sStartMm + sEndMm) / 2;
  const kappaAbsPerM = Math.hypot(kxPerM, kyPerM);
  return {
    index,
    sStartMm,
    sEndMm,
    sMidMm,
    lengthMm,
    kxPerM,
    kyPerM,
    kappaAbsPerM,
    phiRad: Math.atan2(-kxPerM, kyPerM),
  };
}

export function angleDegToCurvaturePerM(angleDeg: number, segmentLengthM = DEFAULT_DYNAMICS_CONFIG.segmentLengthM[0]) {
  if (!Number.isFinite(angleDeg) || !Number.isFinite(segmentLengthM) || segmentLengthM <= 0) return 0;
  return (angleDeg * DEG2RAD) / segmentLengthM;
}

export function curvaturePerMToAngleDeg(curvaturePerM: number, segmentLengthM = DEFAULT_DYNAMICS_CONFIG.segmentLengthM[0]) {
  if (!Number.isFinite(curvaturePerM) || !Number.isFinite(segmentLengthM) || segmentLengthM <= 0) return 0;
  return curvaturePerM * segmentLengthM * RAD2DEG;
}

export function curvatureDistributionFromSnapshot(
  frame: DeviceSnapshot | null | undefined,
  options: {
    basisSegmentCount?: number;
    totalLengthMm?: number;
    config?: Partial<CurvatureDerivationConfig>;
  } = {},
): CurvatureDistribution {
  return curvatureDistributionFromSdmInputs(frame, options);
}

// ── SDM derivation from pressure sensors and motor displacements ──

const CABLE_GROUP_A_INDICES = [0, 2, 4];
const CABLE_GROUP_B_INDICES = [1, 3, 5];
const GROUP_A_ALPHAS = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3];
const GROUP_B_ALPHAS = [Math.PI / 3, Math.PI, (5 * Math.PI) / 3];

function extractTendonForcesFromSensors(
  frame: DeviceSnapshot | null | undefined,
  config: CurvatureDerivationConfig,
): { forcesN: number[]; missing: number[]; confidence: number } {
  const forcesN = new Array(6).fill(NaN);
  const missing: number[] = [];
  let present = 0;
  for (const mapping of config.sensorMappings) {
    const sensor = frame?.sensors.find((item) => item.id === mapping.sensorId);
    const value = sensor?.filtered[mapping.axisIndex];
    if (sensor == null || value == null || !Number.isFinite(value)) {
      missing.push(mapping.cableIndex);
      continue;
    }
    forcesN[mapping.cableIndex] = Math.max(
      mapping.clampMinN,
      mapping.sign * mapping.gain * (value - mapping.zeroN),
    );
    present += 1;
  }
  const total = config.sensorMappings.length || 1;
  return { forcesN, missing, confidence: present / total };
}

function extractCableDisplacementsFromMotors(
  frame: DeviceSnapshot | null | undefined,
  config: CurvatureDerivationConfig,
): { displacementsMm: number[]; missing: number[]; confidence: number } {
  const displacementsMm = new Array(6).fill(NaN);
  const missing: number[] = [];
  let present = 0;
  for (const mapping of config.motorMappings) {
    const motor = frame?.motors.find((item) => item.id === mapping.motorId);
    const value = motor?.positionMm;
    if (motor == null || value == null || !Number.isFinite(value)) {
      missing.push(mapping.cableIndex);
      continue;
    }
    displacementsMm[mapping.cableIndex] =
      mapping.sign * mapping.gainMmPerMotorMm * (value - mapping.zeroMm);
    present += 1;
  }
  const total = config.motorMappings.length || 1;
  return { displacementsMm, missing, confidence: present / total };
}

function momentFromTendonForces(
  forces3: number[],
  alphas: number[],
  cableRadiusM: number,
): { mxNm: number; myNm: number } {
  let mx = 0;
  let my = 0;
  for (let i = 0; i < 3; i++) {
    const tau = finiteOr(forces3[i], 0);
    mx += cableRadiusM * tau * -Math.sin(alphas[i]);
    my += cableRadiusM * tau * Math.cos(alphas[i]);
  }
  return { mxNm: mx, myNm: my };
}

function readSensorForce(
  frame: DeviceSnapshot | null | undefined,
  config: CurvatureDerivationConfig,
  cableIndex: number,
): number {
  const mapping = config.sensorMappings.find((m) => m.cableIndex === cableIndex);
  if (!mapping) return 0;
  const sensor = frame?.sensors.find((s) => s.id === mapping.sensorId);
  const value = sensor?.filtered[mapping.axisIndex];
  if (sensor == null || value == null || !Number.isFinite(value)) return 0;
  return Math.max(mapping.clampMinN, mapping.sign * mapping.gain * (value - mapping.zeroN));
}

function readMotorDisplacement(
  frame: DeviceSnapshot | null | undefined,
  config: CurvatureDerivationConfig,
  cableIndex: number,
): number {
  const mapping = config.motorMappings.find((m) => m.cableIndex === cableIndex);
  if (!mapping) return 0;
  const motor = frame?.motors.find((m) => m.id === mapping.motorId);
  const value = motor?.positionMm;
  if (motor == null || value == null || !Number.isFinite(value)) return 0;
  return mapping.sign * mapping.gainMmPerMotorMm * (value - mapping.zeroMm);
}

/** 三缆位移 → 常曲率向量 (kx, ky)，去 common-mode 后投影到弯曲分量。
 * 输入 disp3 单位为 mm，r_i 与 L_seg 单位为 m，故将 rho 换算为 m。 */
function curvatureVectorFromDisplacements(
  disp3: number[],
  alphas: number[],
  cableRadiusM: number,
  segmentLengthM: number,
): { kx: number; ky: number } {
  const common = (disp3[0] + disp3[1] + disp3[2]) / 3;
  const c = disp3.map((d) => d - common);
  let a = 0;
  let b = 0;
  for (let i = 0; i < 3; i++) {
    a += c[i] * Math.cos(alphas[i]);
    b += c[i] * Math.sin(alphas[i]);
  }
  a *= 2 / 3;
  b *= 2 / 3;
  const rhoMm = Math.hypot(a, b);
  const phi = Math.atan2(b, a);
  // 单位换算：rho[mm] -> rho[m]，再除以 (r_i * L_seg)
  const rhoM = rhoMm / 1000;
  const kappa = rhoM / (cableRadiusM * segmentLengthM);
  return { kx: -kappa * Math.sin(phi), ky: kappa * Math.cos(phi) };
}

/** 每组三根腱力 → 基础曲率向量（线性 EI）。 */
function segmentCurvatureFromSensors(
  frame: DeviceSnapshot | null | undefined,
  config: CurvatureDerivationConfig,
): { kxA: number; kyA: number; kxB: number; kyB: number } {
  const forcesA = CABLE_GROUP_A_INDICES.map((ci) => readSensorForce(frame, config, ci));
  const mA = momentFromTendonForces(forcesA, GROUP_A_ALPHAS, config.cableRadiusM);
  const forcesB = CABLE_GROUP_B_INDICES.map((ci) => readSensorForce(frame, config, ci));
  const mB = momentFromTendonForces(forcesB, GROUP_B_ALPHAS, config.cableRadiusM);
  const eiA = config.linearEiNm2[0] || 1e-9;
  const eiB = config.linearEiNm2[1] || 1e-9;
  return {
    kxA: mA.mxNm / eiA,
    kyA: mA.myNm / eiA,
    kxB: mB.mxNm / eiB,
    kyB: mB.myNm / eiB,
  };
}

/** 每组三缆电机位移 → 基础曲率向量。 */
function segmentCurvatureFromMotors(
  frame: DeviceSnapshot | null | undefined,
  config: CurvatureDerivationConfig,
): { kxA: number; kyA: number; kxB: number; kyB: number } {
  const dispA = CABLE_GROUP_A_INDICES.map((ci) => readMotorDisplacement(frame, config, ci));
  const vA = curvatureVectorFromDisplacements(dispA, GROUP_A_ALPHAS, config.cableRadiusM, config.segmentLengthM[0]);
  const dispB = CABLE_GROUP_B_INDICES.map((ci) => readMotorDisplacement(frame, config, ci));
  const vB = curvatureVectorFromDisplacements(dispB, GROUP_B_ALPHAS, config.cableRadiusM, config.segmentLengthM[1]);
  return { kxA: vA.kx, kyA: vA.ky, kxB: vB.kx, kyB: vB.ky };
}

/** SDM 悬臂式 shape：每段内曲率自段基向段端衰减，并在两段连接处平滑过渡。 */
function cantileverShape(u: number): number {
  const joint = smoothstep(0.42, 0.58, u);
  const decayA = 1 - clamp(u / 0.5, 0, 1);
  const decayB = 1 - clamp((u - 0.5) / 0.5, 0, 1);
  return (1 - joint) * decayA + joint * decayB;
}

export function curvatureDistributionFromSdmInputs(
  frame: DeviceSnapshot | null | undefined,
  options: {
    basisSegmentCount?: number;
    totalLengthMm?: number;
    config?: Partial<CurvatureDerivationConfig>;
  } = {},
): CurvatureDistribution {
  const config: CurvatureDerivationConfig = {
    ...DEFAULT_CURVATURE_DERIVATION_CONFIG,
    ...options.config,
    segmentLengthM: options.config?.segmentLengthM ?? DEFAULT_CURVATURE_DERIVATION_CONFIG.segmentLengthM,
    sensorMappings: options.config?.sensorMappings ?? DEFAULT_SENSOR_MAPPINGS,
    motorMappings: options.config?.motorMappings ?? DEFAULT_MOTOR_MAPPINGS,
  };
  const totalLengthMm = finiteOr(options.totalLengthMm ?? config.totalLengthMm, DEFAULT_TOTAL_LENGTH_MM);
  const basisSegmentCount = Math.max(10, Math.round(options.basisSegmentCount ?? config.basisSegmentCount));

  const forces = extractTendonForcesFromSensors(frame, config);
  const displacements = extractCableDisplacementsFromMotors(frame, config);

  const warnings: string[] = [];
  const forceAvailable = forces.confidence > 0 && forces.forcesN.some((v) => Number.isFinite(v) && v > 0);
  const motorAvailable = displacements.confidence > 0 && displacements.displacementsMm.some((v) => Number.isFinite(v));

  let source: CurvatureDerivationSource;
  if (forceAvailable && motorAvailable) {
    source = "sensorMotorFusion";
  } else if (forceAvailable) {
    source = "forceOnly";
  } else if (motorAvailable) {
    source = "motorOnly";
  } else {
    source = "legacyBendFallback";
    warnings.push("sensor 与 motor 输入均不可用，回退到 legacy bend 拟合");
  }

  let segments: CurvatureBasisSegment[];
  if (source === "legacyBendFallback") {
    // 无传感器/电机输入时的降级：用 legacy 两个弯曲角生成基础曲率并铺开为 basis 段。
    const halfLengthM = totalLengthMm / 2000;
    const a = curvatureVector(angleDegToCurvaturePerM(frame?.bend.section1.angleDeg ?? 0, halfLengthM), directionNameToDeg(frame?.bend.section1.direction));
    const b = curvatureVector(angleDegToCurvaturePerM(frame?.bend.section2.angleDeg ?? 0, halfLengthM), directionNameToDeg(frame?.bend.section2.direction));
    segments = Array.from({ length: basisSegmentCount }, (_, index) => {
      const u = (index + 0.5) / basisSegmentCount;
      const transition = smoothstep(0.18, 0.82, u);
      const endFade = smoothstep(0, 0.08, u) * (1 - smoothstep(0.92, 1, u));
      const kxPerM = lerp(a.kxPerM, b.kxPerM, transition) * endFade;
      const kyPerM = lerp(a.kyPerM, b.kyPerM, transition) * endFade;
      return makeSegment(index, basisSegmentCount, totalLengthMm, kxPerM, kyPerM);
    });
    return {
      totalLengthMm,
      basisSegmentCount,
      source,
      segments,
      diagnostics: {
        source,
        tendonForcesN: forces.forcesN,
        cableDisplacementsMm: displacements.displacementsMm,
        missingSensorChannels: forces.missing,
        missingMotorChannels: displacements.missing,
        forceConfidence: forces.confidence,
        displacementConfidence: displacements.confidence,
        stiffnessMode: config.stiffnessMode,
        warnings,
      },
    };
  }

  const forceAnchors = segmentCurvatureFromSensors(frame, config);
  const motorAnchors = segmentCurvatureFromMotors(frame, config);
  const fusedAnchors = {
    kxA: (config.forceWeight * forceAnchors.kxA + config.displacementWeight * motorAnchors.kxA) / (config.forceWeight + config.displacementWeight),
    kyA: (config.forceWeight * forceAnchors.kyA + config.displacementWeight * motorAnchors.kyA) / (config.forceWeight + config.displacementWeight),
    kxB: (config.forceWeight * forceAnchors.kxB + config.displacementWeight * motorAnchors.kxB) / (config.forceWeight + config.displacementWeight),
    kyB: (config.forceWeight * forceAnchors.kyB + config.displacementWeight * motorAnchors.kyB) / (config.forceWeight + config.displacementWeight),
  };

  segments = Array.from({ length: basisSegmentCount }, (_, index) => {
    const uMid = (index + 0.5) / basisSegmentCount;
    const shape = cantileverShape(uMid);
    let kxPerM: number;
    let kyPerM: number;
    if (source === "forceOnly") {
      kxPerM = (uMid < 0.5 ? forceAnchors.kxA : forceAnchors.kxB) * shape;
      kyPerM = (uMid < 0.5 ? forceAnchors.kyA : forceAnchors.kyB) * shape;
    } else if (source === "motorOnly") {
      kxPerM = (uMid < 0.5 ? motorAnchors.kxA : motorAnchors.kxB) * shape;
      kyPerM = (uMid < 0.5 ? motorAnchors.kyA : motorAnchors.kyB) * shape;
    } else {
      kxPerM = (uMid < 0.5 ? fusedAnchors.kxA : fusedAnchors.kxB) * shape;
      kyPerM = (uMid < 0.5 ? fusedAnchors.kyA : fusedAnchors.kyB) * shape;
    }
    return makeSegment(index, basisSegmentCount, totalLengthMm, kxPerM, kyPerM);
  });

  const diagnostics: CurvatureDerivationDiagnostics = {
    source,
    tendonForcesN: forces.forcesN,
    cableDisplacementsMm: displacements.displacementsMm,
    missingSensorChannels: forces.missing,
    missingMotorChannels: displacements.missing,
    forceConfidence: forces.confidence,
    displacementConfidence: displacements.confidence,
    stiffnessMode: config.stiffnessMode,
    warnings,
  };

  return {
    totalLengthMm,
    basisSegmentCount,
    source,
    segments,
    diagnostics,
  };
}

function svcPose(curvaturePerM: number, phi: number, s: number): [number, number, number] {
  if (!Number.isFinite(curvaturePerM) || !Number.isFinite(phi)) return [0, 0, s];
  if (Math.abs(curvaturePerM) < 1e-12) return [0, 0, s];
  const radius = 1.0 / curvaturePerM;
  const localAngle = curvaturePerM * s;
  const x = radius * (1.0 - Math.cos(localAngle)) * Math.cos(phi);
  const y = radius * (1.0 - Math.cos(localAngle)) * Math.sin(phi);
  const z = radius * Math.sin(localAngle);
  return [x, y, z];
}

function segmentH(curvaturePerM: number, phi: number, stepLengthM: number, subSteps: number): number[][] {
  const ds = stepLengthM / subSteps;
  const kDs = curvaturePerM * ds;
  let sumSin = 0;
  let sumCos = 0;
  for (let j = 1; j <= subSteps; j++) {
    sumSin += Math.sin(j * kDs);
    sumCos += Math.cos(j * kDs);
  }

  const cp = Math.cos(phi), sp = Math.sin(phi);
  const theta = curvaturePerM * stepLengthM;
  const cth = Math.cos(theta), sth = Math.sin(theta);
  const rotation: number[][] = [
    [cp * cp * (cth - 1) + 1, sp * cp * (cth - 1), cp * sth],
    [sp * cp * (cth - 1), cp * cp * (1 - cth) + cth, sp * sth],
    [-cp * sth, -sp * sth, cth],
  ];
  const p = [ds * sumSin * cp, ds * sumSin * sp, ds * sumCos];
  const h: number[][] = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) h[i][j] = rotation[i][j];
    h[i][3] = p[i];
  }
  return h;
}

function matMul4(h: number[][], v: number[]): number[] {
  const result = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    result[i] = h[i][0] * v[0] + h[i][1] * v[1] + h[i][2] * v[2] + h[i][3] * v[3];
  }
  return result;
}

function matMul4x4(a: number[][], b: number[][]): number[][] {
  const out: number[][] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1]];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      out[r][c] = 0;
      for (let k = 0; k < 4; k++) out[r][c] += a[r][k] * b[k][c];
    }
  }
  return out;
}

function frameFromMatrix(h: number[][]): Pick<BackboneSample, "normal" | "binormal" | "tangent"> {
  return {
    normal: normalize([h[0][0], h[1][0], h[2][0]], [1, 0, 0]),
    binormal: normalize([h[0][1], h[1][1], h[2][1]], [0, 1, 0]),
    tangent: normalize([h[0][2], h[1][2], h[2][2]], [0, 0, 1]),
  };
}

export function buildBackboneFromCurvatureDistribution(
  distribution: CurvatureDistribution,
  options: { samplesPerBasisSegment?: number } = {},
): BackboneOutput {
  const samplesPerBasisSegment = Math.max(2, Math.round(options.samplesPerBasisSegment ?? 6));
  const pointsM: [number, number, number][] = [[0, 0, 0]];
  const sMm: number[] = [0];
  const kxPerM: number[] = [distribution.segments[0]?.kxPerM ?? 0];
  const kyPerM: number[] = [distribution.segments[0]?.kyPerM ?? 0];
  const kappaAbsPerM: number[] = [Math.hypot(kxPerM[0], kyPerM[0])];
  const initialFrame = frameFromMatrix([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]);
  const samples: BackboneSample[] = [{
    sMm: 0,
    pointM: [0, 0, 0],
    ...initialFrame,
    kxPerM: kxPerM[0],
    kyPerM: kyPerM[0],
    kappaAbsPerM: kappaAbsPerM[0],
  }];
  let hCurr: number[][] = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];

  for (const segment of distribution.segments) {
    const dsM = segment.lengthMm / samplesPerBasisSegment / 1000;
    const curvature = segment.kappaAbsPerM;
    const phi = segment.phiRad;
    for (let step = 0; step < samplesPerBasisSegment; step++) {
      const localP = svcPose(curvature, phi, dsM);
      const globalP = matMul4(hCurr, [localP[0], localP[1], localP[2], 1]);
      hCurr = matMul4x4(hCurr, segmentH(curvature, phi, dsM, 5));
      const frame = frameFromMatrix(hCurr);
      const s = segment.sStartMm + ((step + 1) / samplesPerBasisSegment) * segment.lengthMm;
      const pointM: [number, number, number] = [globalP[0], globalP[1], globalP[2]];
      pointsM.push(pointM);
      sMm.push(s);
      kxPerM.push(segment.kxPerM);
      kyPerM.push(segment.kyPerM);
      kappaAbsPerM.push(segment.kappaAbsPerM);
      samples.push({
        sMm: s,
        pointM,
        ...frame,
        kxPerM: segment.kxPerM,
        kyPerM: segment.kyPerM,
        kappaAbsPerM: segment.kappaAbsPerM,
      });
    }
  }

  return {
    distribution,
    samples,
    pointsM,
    kxPerM,
    kyPerM,
    sMm,
    kappaAbsPerM,
    segmentCurvaturePerM: distribution.segments.map((segment) => segment.kappaAbsPerM),
    segmentDirectionRad: distribution.segments.map((segment) => segment.phiRad),
  };
}

export function summarizeBackbone(backbone: BackboneOutput): BackboneSummary {
  const values = backbone.distribution.segments.map((segment) => segment.kappaAbsPerM);
  const maxKappaPerM = values.length ? Math.max(...values) : 0;
  const meanKappaPerM = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const tip = backbone.pointsM[backbone.pointsM.length - 1] ?? [0, 0, 0];
  const tipPositionMm: [number, number, number] = [tip[0] * 1000, tip[1] * 1000, tip[2] * 1000];
  return {
    maxKappaPerM,
    meanKappaPerM,
    tipOffsetMm: Math.hypot(tipPositionMm[0], tipPositionMm[1]),
    tipPositionMm,
    basisSegmentCount: backbone.distribution.basisSegmentCount,
  };
}
