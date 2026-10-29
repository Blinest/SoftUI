/**
 * 典型臂形的**方向 / 角度标定**。
 *
 * 为什么需要这一层：
 *   模型表里的弯曲平面是按 `kx = −κ·sinφ、ky = κ·cosφ` 定义的 ✓，
 *   但**实物**的丝序 / 装配朝向未必与表的坐标系一致 ✗ ——
 *   现场表现就是"命令向上弯，实际往旁边弯"✓（方向错），或"命令 30° 只弯到 24°"✓（幅值错）。
 *   这类偏差是**器件/装配的固定映射**✓，用一次标定就能补掉 ✓，不需要改模型表 ✓。
 *
 * 方向：`observed = s · commanded + Δ`（s = ±1，对应是否镜像；Δ = 整体旋转）
 *   ⇒ 反向补偿：`commanded = s · (desired − Δ)`
 * 角度：`measured = gain · commanded + offset`
 *   ⇒ 反向补偿：`commanded = (desired − offset) / gain`
 *
 * 标定结果存在**本机**（`localStorage`）✓ —— 它描述的是这台臂的装配朝向，
 * 换电脑/换臂要重新标 ✓。
 */

const STORAGE_KEY = "softui:shape-calibration";

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export interface DirectionCalibration {
  /** true = 左右镜像（实测方向与命令方向关于 0° 轴对称） */
  mirror: boolean;
  /** 整体旋转偏移（度，实测 = 命令 + offset） */
  offsetDeg: number;
}

export interface AngleCalibration {
  /** 实测角 = gain × 命令角 + offsetDeg */
  gain: number;
  offsetDeg: number;
}

export interface ShapeCalibration {
  direction: DirectionCalibration;
  angle: AngleCalibration;
}

export const IDENTITY_CALIBRATION: ShapeCalibration = {
  direction: { mirror: false, offsetDeg: 0 },
  angle: { gain: 1, offsetDeg: 0 },
};

/** 归一化到 [0, 360)。 */
export function wrapDeg360(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const value = deg % 360;
  return value < 0 ? value + 360 : value;
}

/** 归一化到 (-180, 180]，用于显示误差。 */
export function wrapDeg180(deg: number): number {
  const value = wrapDeg360(deg);
  return value > 180 ? value - 360 : value;
}

/** 名义方向 → 实际要下发的方向（补偿后）。 */
export function applyDirectionCalibration(
  desiredDeg: number,
  calibration: DirectionCalibration,
): number {
  const delta = desiredDeg - calibration.offsetDeg;
  return wrapDeg360(calibration.mirror ? -delta : delta);
}

/** 名义角 → 实际要下发的角（补偿后）。gain 异常时原样返回，避免除零放大。 */
export function applyAngleCalibration(desiredDeg: number, calibration: AngleCalibration): number {
  const gain = Number.isFinite(calibration.gain) ? calibration.gain : 1;
  if (Math.abs(gain) < 0.05) return desiredDeg;
  const offset = Number.isFinite(calibration.offsetDeg) ? calibration.offsetDeg : 0;
  return (desiredDeg - offset) / gain;
}

export interface DirectionSample {
  /** 实际下发的方向（度） */
  commandedDeg: number;
  /** 角度尺 / 目测得到的实际方向（度） */
  observedDeg: number;
}

export interface DirectionFit extends DirectionCalibration {
  /** 拟合残差 RMS（度）—— 越小说明"旋转/镜像"这个模型越贴 */
  residualRmsDeg: number;
  count: number;
}

/** 由若干组（下发方向, 实测方向）拟合 `observed = s·commanded + Δ`。 */
export function fitDirectionCalibration(samples: DirectionSample[]): DirectionFit | null {
  const usable = samples.filter(
    (sample) => Number.isFinite(sample.commandedDeg) && Number.isFinite(sample.observedDeg),
  );
  if (usable.length === 0) return null;

  const evaluate = (sign: 1 | -1): DirectionFit => {
    const residuals = usable.map((sample) =>
      wrapDeg180(sample.observedDeg - sign * sample.commandedDeg),
    );
    // 圆周平均求 Δ（避免 0/360 跳变把平均值拉偏）
    let sumCos = 0;
    let sumSin = 0;
    for (const residual of residuals) {
      sumCos += Math.cos(residual * DEG2RAD);
      sumSin += Math.sin(residual * DEG2RAD);
    }
    const offsetDeg = wrapDeg360(Math.atan2(sumSin, sumCos) * RAD2DEG);
    const squared = residuals.reduce((sum, residual) => {
      const error = wrapDeg180(residual - offsetDeg);
      return sum + error * error;
    }, 0);
    return {
      mirror: sign === -1,
      offsetDeg,
      residualRmsDeg: Math.sqrt(squared / residuals.length),
      count: usable.length,
    };
  };

  const normal = evaluate(1);
  const mirrored = evaluate(-1);
  // 留一点余量，避免两个模型残差相同时来回跳
  return mirrored.residualRmsDeg + 1e-6 < normal.residualRmsDeg ? mirrored : normal;
}

export interface AngleSample {
  commandedDeg: number;
  measuredDeg: number;
}

export interface AngleFit extends AngleCalibration {
  residualRmsDeg: number;
  count: number;
}

/** 最小二乘拟合 `measured = gain·commanded + offset`（至少 2 组）。 */
export function fitAngleCalibration(samples: AngleSample[]): AngleFit | null {
  const usable = samples.filter(
    (sample) => Number.isFinite(sample.commandedDeg) && Number.isFinite(sample.measuredDeg),
  );
  if (usable.length < 2) return null;

  const n = usable.length;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (const sample of usable) {
    sumX += sample.commandedDeg;
    sumY += sample.measuredDeg;
    sumXX += sample.commandedDeg * sample.commandedDeg;
    sumXY += sample.commandedDeg * sample.measuredDeg;
  }
  const denominator = n * sumXX - sumX * sumX;
  if (Math.abs(denominator) < 1e-6) return null;
  const gain = (n * sumXY - sumX * sumY) / denominator;
  const offsetDeg = (sumY - gain * sumX) / n;
  if (!Number.isFinite(gain) || Math.abs(gain) < 0.05 || Math.abs(gain) > 5) return null;

  const squared = usable.reduce((sum, sample) => {
    const error = gain * sample.commandedDeg + offsetDeg - sample.measuredDeg;
    return sum + error * error;
  }, 0);
  return {
    gain,
    offsetDeg,
    residualRmsDeg: Math.sqrt(squared / n),
    count: n,
  };
}

export function loadShapeCalibration(): ShapeCalibration {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...IDENTITY_CALIBRATION, direction: { ...IDENTITY_CALIBRATION.direction }, angle: { ...IDENTITY_CALIBRATION.angle } };
    const parsed = JSON.parse(raw) as Partial<ShapeCalibration>;
    const mirror = Boolean(parsed?.direction?.mirror);
    const offsetDeg = Number(parsed?.direction?.offsetDeg);
    const gain = Number(parsed?.angle?.gain);
    const angleOffset = Number(parsed?.angle?.offsetDeg);
    return {
      direction: {
        mirror,
        offsetDeg: Number.isFinite(offsetDeg) ? wrapDeg360(offsetDeg) : 0,
      },
      angle: {
        gain: Number.isFinite(gain) && Math.abs(gain) >= 0.05 && Math.abs(gain) <= 5 ? gain : 1,
        offsetDeg: Number.isFinite(angleOffset) ? angleOffset : 0,
      },
    };
  } catch {
    return { direction: { mirror: false, offsetDeg: 0 }, angle: { gain: 1, offsetDeg: 0 } };
  }
}

export function saveShapeCalibration(calibration: ShapeCalibration): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(calibration));
  } catch {
    /* 隐私模式写不进去：本次会话仍生效，忽略 */
  }
}

export function isIdentityCalibration(calibration: ShapeCalibration): boolean {
  return (
    !calibration.direction.mirror &&
    wrapDeg360(calibration.direction.offsetDeg) === 0 &&
    calibration.angle.gain === 1 &&
    calibration.angle.offsetDeg === 0
  );
}
