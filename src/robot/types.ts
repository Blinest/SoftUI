export type SegmentMode = "constant" | "flex-weighted";

export interface DirectionMapping {
  offsetDeg: number;
  invertAngle: boolean;
  invertDirection: boolean;
}

export interface SegmentBend {
  angleDeg: number;
  directionDeg: number;
}

export interface ContinuumCommand {
  targetSegments: [SegmentBend, SegmentBend];
  feedbackSegments: [SegmentBend, SegmentBend];
  activeSegments: [boolean, boolean];
  mode: SegmentMode;
  smoothing: number;
  cableRadiusMm: number;
  cableTubeMm: number;
  showCables: boolean;
  tubularCables: boolean;
  showSkeleton: boolean;
  showAxes: boolean;
  showTarget: boolean;
  showFeedback: boolean;
  boneCount: number;
  mapping: DirectionMapping;
}

export interface RobotGeometryConfig {
  lengthMm: number;
  radiusMm: number;
  radialSegments: number;
  axialSegments: number;
  slotPitchMm: number;
  slotDuty: number;
  boneCount: number;
}

export interface PoseSample {
  center: [number, number, number];
  tangent: [number, number, number];
  normal: [number, number, number];
  binormal: [number, number, number];
}

export interface TipPose {
  position: [number, number, number];
  tangent: [number, number, number];
  angleDeg: number;
  directionDeg: number;
}
