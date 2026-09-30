/* 视觉标定：从背光剪影重建臂体的中轴线与曲率。
 *
 * ── 适用前提（决定了这套算法能成立）──
 *
 * 1. **臂体被约束在一个平面内**，该平面平行于像面 —— 于是整条臂深度恒定、
 *    比例尺处处相同，单目的深度歧义消失。这是最简单也最可靠的做法：
 *    标定本来就是受控流程，没必要追求任意位姿。
 *
 * 2. **背光**，臂体是亮背景上的暗剪影。黑色臂体在正面光下对比度极低、还会
 *    有镜面高光把管子劈成两半；背光下它反而是最理想的被测物 —— 不反射、
 *    无高光、边界干净。对比度拉满之后，二值化用固定阈值就够。
 *
 * 3. **已知直径 D**。圆柱的剪影宽度恒等于 D × 比例尺（与朝向无关，因为
 *    轮廓母线的法线方向 a×v 本身垂直于视线、投影不缩短），所以臂体自己
 *    就是标尺：量出平均宽度就能定出 mm/px，不需要额外标定板。
 *
 * ── 为什么不能用差分求曲率 ──
 *
 * 点间距 Δ 很小时，二阶差分的噪声会被 1/Δ² 放大。按 Δ=5px、亚像素精度
 * 0.1px 估算，噪声 σ_κ ≈ 0.1×√6/25 = 0.0098 px⁻¹，换算到物理量约
 * **7.4 1/m** —— 而工作范围是 0~8 1/m。差分的噪声比信号还大。
 *
 * 所以本模块的曲率一律来自**拟合**：单个位姿下用局部多项式（Savitzky-Golay）
 * 求导，多个静态帧之间再做平均。60 个点是**测量样本**，不是输出。 */

export interface Point {
  x: number;
  y: number;
}

/** 灰度图：单通道，0~255。图像坐标 x 向右、y 向下。 */
export interface Grayscale {
  width: number;
  height: number;
  data: Uint8Array;
}

/** 中轴线上的一个采样点，全部为亚像素精度。 */
export interface CenterlinePoint {
  /** 中轴点位置（两侧边缘的中点）。 */
  x: number;
  y: number;
  /** 该处的单位切向（沿臂体走向）。 */
  tx: number;
  ty: number;
  /** 该处的单位法向（垂直于走向，指向"左侧"边缘）。 */
  nx: number;
  ny: number;
  /** 左右两侧边缘的亚像素位置。 */
  left: Point;
  right: Point;
  /** 到两侧边缘的距离（像素），理想情况下两者相等且等于 D·s/2。 */
  halfLeft: number;
  halfRight: number;
  /** 两侧距离之和 = 该处的剪影宽度（像素）。 */
  widthPx: number;
  /** 0~1。宽度偏离中位数、或边缘落在图像外时降低。 */
  quality: number;
}

/** 两段常曲率模型对测量点的拟合结果（图像坐标系）。 */
export interface PccFit {
  /** 臂根位置（像素）。 */
  baseX: number;
  baseY: number;
  /** 臂根处的切向角（弧度，图像坐标，0 = +x 方向，顺时针为正因为 y 向下）。 */
  baseAngleRad: number;
  /** 两段的带符号曲率（1/px）。符号约定见 curvature.ts。 */
  kappa1PerPx: number;
  kappa2PerPx: number;
  /** 拟合残差 RMS（像素）。 */
  residualRmsPx: number;
  /** 迭代次数，供调试。 */
  iterations: number;
}

export interface AnalyzeOptions {
  /** 背光下臂体是暗的，用 "dark"。 */
  mode: "dark" | "bright";
  /** 阈值。给 "otsu" 则自动估计。对比度拉满时固定值更稳。 */
  threshold: number | "otsu";
  /** 形态学闭运算半径（像素），用来补镜面高光造成的小孔。0 = 关闭。 */
  closeRadius: number;
  /** 中轴重采样点数，即「60 个点」。 */
  sampleCount: number;
  /** 臂体直径（mm），用来把像素比例尺定出来。 */
  tubeDiameterMm: number;
  /** 期望的臂长（mm），用于换算弧长与判断截断。 */
  armLengthMm: number;
  /** Savitzky-Golay 局部拟合的半窗宽（点数）。窗口 = 2m+1。 */
  sgHalfWindow: number;
  /** 局部多项式阶数，求二阶导至少要 3 阶。 */
  sgOrder: number;
  /**
   * 中轴追踪的步长（像素）。
   *
   * **保持 1，不要调小。** 亚像素边缘本身能做到 ~0.02px，但步长决定它在哪
   * 采样。减到 0.5 会让切向更新的历史基线从 4px 缩到 2px、端帽判定的
   * `narrowStreak` 窗口从 3px 缩到 1.5px —— 实测整条管线会崩（曲率偏差冲到
   * 100+ 1/m）。
   *
   * 代价是端点有约 1px 的残留：走到端部时中点一旦点出掩膜就停住，臂根端比
   * 真实端面短约 1px（占 200px 臂长的 0.5%）。这个量级对曲率的影响可以忽略
   * —— 无噪声下曲率误差仍只有 1.6%。
   */  traceStep: number;
  /**
   * 臂根大致位置的提示（图像像素坐标）。
   *
   * **中轴追踪无法自己判断哪端是臂根**：两段常曲率曲线从两头看都成立，
   * 拟合残差也一样（对称弯时甚至完全相等）。而 κ₁/κ₂ 对应不同的驱动通道，
   * 顺序反了整个标定就反了。
   *
   * 所以要求调用方给一个提示点（标定时让操作员在画面上点一下臂的夹持端即可）。
   * 不提供时会把最靠图像下方的一端当作臂根 —— 这只是个常见情况的猜测，
   * 正式标定请务必显式给出。
   */
  rootHintPx?: Point;
}

export const DEFAULT_ANALYZE_OPTIONS: AnalyzeOptions = {
  mode: "dark",
  threshold: "otsu",
  closeRadius: 2,
  sampleCount: 60,
  tubeDiameterMm: 60,
  armLengthMm: 400,
  sgHalfWindow: 15,
  sgOrder: 3,
  traceStep: 1,
};

export interface AnalyzeResult {
  ok: boolean;
  /** ok=false 时说明原因。 */
  reason: string;
  /** 实际使用的二值化阈值。 */
  threshold: number;
  /** 最大连通域的面积（像素）。 */
  maskArea: number;

  /** 亚像素中轴线（未重采样，点数由几何决定）。 */
  centerline: CenterlinePoint[];
  /** 中轴线的总弧长（像素）。 */
  centerlineLengthPx: number;

  /** 重采样后的等弧长点（像素坐标）。 */
  pointsPx: Point[];
  /** 同上，换算成 mm 且已平移到「臂根为原点、根处切向朝 +y」。 */
  pointsMm: Point[];

  /** 比例尺（mm/像素），由中位宽度与已知直径推出。 */
  scaleMmPerPx: number;
  /** 剪影宽度的中位数（像素）。 */
  widthMedianPx: number;
  /** 宽度一致性 0~1：1 表示沿线宽度完全一致（分割质量好）。 */
  widthConsistency: number;

  /** 每点的带符号曲率，单位 1/mm（长度 = sampleCount）。 */
  curvaturePerMm: number[];
  /** 同上换算成 1/m，与动力学模型同量纲。 */
  curvaturePerM: number[];

  /** 两段常曲率模型拟合；点太少或退化时为 null。 */
  pccFit: PccFit | null;
}
