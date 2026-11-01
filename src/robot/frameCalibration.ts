/**
 * **模型包末端坐标系 ↔ 实机全局坐标系** 的旋转补偿（绕 z 轴）。
 *
 * 现场标定结论（2026-10-31）：
 *   · 单丝点动：M1 拉 +5mm → 实机向上（+y），模型末端在 (40, 7) ≈ +x；
 *   · 即模型的腱角/末端坐标系相对实机整体转了约 **90°**（模型 +x ≈ 实机 +y）。
 *
 * 所以：
 *   · 模型输出（末端位置 / 曲率）→ 实机：旋转 +90°；
 *   · 实机目标 → 模型查表：旋转 −90°。
 *
 * 这个角度先写成常量，等模型包按实机坐标系重导后改回 0 即可。
 */
export const MODEL_FRAME_ROTATION_DEG = 90;

const DEG2RAD = Math.PI / 180;

/** 绕 z 轴旋转 (x, y)（数学正方向：x→y）。 */
export function rotateXY(x: number, y: number, deg = MODEL_FRAME_ROTATION_DEG): [number, number] {
  const theta = deg * DEG2RAD;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return [x * cos - y * sin, x * sin + y * cos];
}

/** 模型末端（mm）→ 实机全局（mm）。 */
export function modelTipToPhysicalMm(
  tip: ArrayLike<number>,
  deg = MODEL_FRAME_ROTATION_DEG,
): [number, number, number] {
  const [x, y] = rotateXY(tip[0] ?? 0, tip[1] ?? 0, deg);
  return [x, y, tip[2] ?? 0];
}

/**
 * **目标坐标的 y 轴反向**（现场反馈：拖动/控制的上、下是反的，左右是对的）。
 * 只在“实机目标 → 模型查表”这一步翻转，保证拖动方向和三维视图一致。
 */
export const TARGET_Y_FLIP = -1;

/** 实机全局目标（mm）→ 模型查表用的末端（mm）。 */
export function physicalTipToModelMm(
  tip: ArrayLike<number>,
  deg = MODEL_FRAME_ROTATION_DEG,
): [number, number, number] {
  const x = tip[0] ?? 0;
  const y = (tip[1] ?? 0) * TARGET_Y_FLIP;
  const [rx, ry] = rotateXY(x, y, -deg);
  return [rx, ry, tip[2] ?? 0];
}

/** 模型曲率矢量 (kx, ky) → 实机朝向。 */
export function modelKappaToPhysical(
  kx: number,
  ky: number,
  deg = MODEL_FRAME_ROTATION_DEG,
): [number, number] {
  return rotateXY(kx, ky, deg);
}
