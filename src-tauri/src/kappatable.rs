//! 全阶 Cosserat 查表：曲率 → 6 肌腱位移（ΔL）。
//!
//! 数据源：`tdcr_control/tools/vc_table_40.npz` / `vc_table_60.npz`
//! （各 1200 个打靶样本，字段 `kK` = κ(s) 场 601 节点、`dL_mm` = 6 丝位移）。
//! 导出为 `assets/kappa_table_{40,60}.bin`（各 46.9 KB）。
//!
//! ## 索引降维
//!
//! 把 κ(s) 场按段长 `L1 = L2 = 0.2225887 m` 切成两段，各取 `(κx, κy)` 均值
//! ⇒ 4 维特征 `[κxA, κyA, κxB, κyB]`（1/m）。与 UI 侧「两段曲率 + 方向」的下发
//! 口径一致，拖拽结果可直接作为查询键。
//!
//! ## ★ 直臂归零（重要）
//!
//! 表内**全部是受力态**样本：即便 κ≈0 也存在 15~38mm 的**轴向共模压缩**，
//! 且同一形状可由不同张力分布得到（多余度），ΔL 因此不唯一。
//! 实测：40N 表 `|κ|<0.2` 的 7 个样本，ΔL 跨度达 20.5mm。
//!
//! ⇒ 下发量取「**相对直臂参考态的增量**」，参考态 = 查询原点 `κ=0` 处的插值结果。
//! 这样拖到"直"就真的不动，而不是让臂体猛缩。
//!
//! ## 插值
//!
//! 照搬 `ik_table.PoseTable._interp_dL`（表点 ΔL 残差中位 5.11mm → 1.12mm）：
//!
//! 1. 取最近 `K_INTERP = 8` 个样本
//! 2. 精确命中（距离 ≈ 0）直接返回该样本
//! 3. 局部加权线性拟合 ΔL（权重 `1/(d+1)`，加 `RIDGE` 正则）
//! 4. **Shepard(IDW) 残差修正** `1/(d²+ε)`，保证插值**穿过表点**
//!
//! > ⚠ 不上二阶：`ik_table` 实测邻域交叉项病态（29.5mm）。
//!
//! 超出覆盖半径（[`COVERAGE_RADIUS_PER_M`]）时 `covered = false`，
//! 调用方可退回解析模型（见 [`crate::curvature`]）。

const MAGIC: &[u8; 4] = b"KTB1";
const N_FEATURES: usize = 4;
const N_DISPLACEMENTS: usize = 6;
const STRIDE: usize = N_FEATURES + N_DISPLACEMENTS;

/// 参与插值的近邻数（与 `ik_table` 的 `k_interp=8` 一致）。
pub const K_INTERP: usize = 8;
/// 岭正则（对应 `np.linalg.lstsq(rcond=1e-6)`）。
const RIDGE: f64 = 1e-6;
/// 表覆盖半径（4 维特征空间的欧氏距离，单位 1/m）。
///
/// 依据：两组表的最近邻距离中位 ≈ 0.19 / 0.22、p90 ≈ 0.32 / 0.41、max ≈ 0.79 / 1.01。
pub const COVERAGE_RADIUS_PER_M: f64 = 1.0;

/// 表内**A 段** κ 的上限（1/m）。
///
/// 由 `assets/kappa_table_*.bin` 的样本统计得到（40N: 1.68、60N: 1.81），只用于
/// 「超出覆盖范围」这类错误信息里给出可操作的范围提示 —— 不在查表逻辑里使用。
pub const SEGMENT_A_MAX_KAPPA_PER_M: f64 = 1.8;
/// 表内**B 段** κ 的上限（1/m）（40N: 2.83、60N: 4.24）。
pub const SEGMENT_B_MAX_KAPPA_PER_M: f64 = 4.2;

static TABLE_40: &[u8] = include_bytes!("../assets/kappa_table_40.bin");
static TABLE_60: &[u8] = include_bytes!("../assets/kappa_table_60.bin");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KappaTableKind {
    /// 40 N 张力上限的表。
    Limit40n,
    /// 60 N 张力上限的表（默认，弯曲范围更深）。
    Limit60n,
}

impl KappaTableKind {
    pub fn bytes(self) -> &'static [u8] {
        match self {
            Self::Limit40n => TABLE_40,
            Self::Limit60n => TABLE_60,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Limit40n => "40N",
            Self::Limit60n => "60N",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KappaTableError {
    BadMagic,
    Truncated,
    Empty,
    Singular,
}

#[derive(Debug, Clone, PartialEq)]
pub struct KappaLookup {
    /// 6 根丝的位移增量（mm，带符号，已相对直臂参考态归零）。
    pub displacement_mm: [f64; N_DISPLACEMENTS],
    /// 最近表点到查询点的距离（1/m）。
    pub nearest_distance: f64,
    /// 是否落在表的覆盖半径内。
    pub covered: bool,
}

pub struct KappaTable {
    kind: KappaTableKind,
    features: Vec<[f64; N_FEATURES]>,
    displacements: Vec<[f64; N_DISPLACEMENTS]>,
    /// 直臂参考态 ΔL（mm）= 查询原点处的原始插值。
    reference: [f64; N_DISPLACEMENTS],
}

impl KappaTable {
    /// 从内置资源加载（编译期嵌入的 `assets/kappa_table_*.bin`）。
    pub fn load(kind: KappaTableKind) -> Result<Self, KappaTableError> {
        Self::from_bytes(kind, kind.bytes())
    }

    /// 从任意字节加载（运行时导入的模型包走这条路径）。
    pub fn from_bytes(kind: KappaTableKind, bytes: &[u8]) -> Result<Self, KappaTableError> {
        if bytes.len() < 16 {
            return Err(KappaTableError::Truncated);
        }
        if &bytes[0..4] != MAGIC {
            return Err(KappaTableError::BadMagic);
        }
        let count = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let features_dim = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
        let displacement_dim = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
        if features_dim != N_FEATURES || displacement_dim != N_DISPLACEMENTS {
            return Err(KappaTableError::BadMagic);
        }
        if count == 0 {
            return Err(KappaTableError::Empty);
        }
        if bytes.len() < 16 + count * STRIDE * 4 {
            return Err(KappaTableError::Truncated);
        }

        let mut features = Vec::with_capacity(count);
        let mut displacements = Vec::with_capacity(count);
        for index in 0..count {
            let base = 16 + index * STRIDE * 4;
            let mut feature = [0.0f64; N_FEATURES];
            let mut displacement = [0.0f64; N_DISPLACEMENTS];
            for (slot, item) in feature.iter_mut().enumerate() {
                let offset = base + slot * 4;
                *item = f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as f64;
            }
            for (slot, item) in displacement.iter_mut().enumerate() {
                let offset = base + (N_FEATURES + slot) * 4;
                *item = f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as f64;
            }
            features.push(feature);
            displacements.push(displacement);
        }

        // 直臂参考态 = 查询原点 κ=0 处的原始插值 ⇒ `lookup(原点)` 严格为 0。
        let (reference, _, _) = raw_interp(&features, &displacements, [0.0; N_FEATURES])?;

        Ok(Self {
            kind,
            features,
            displacements,
            reference,
        })
    }

    pub fn kind(&self) -> KappaTableKind {
        self.kind
    }

    pub fn len(&self) -> usize {
        self.features.len()
    }

    pub fn is_empty(&self) -> bool {
        self.features.is_empty()
    }

    /// 直臂参考态 ΔL（mm）。所有下发量都是相对它的**增量**。
    pub fn reference(&self) -> [f64; N_DISPLACEMENTS] {
        self.reference
    }

    /// 逐样本原始 ΔL（mm），供诊断/测试使用。
    pub fn sample_displacement(&self, index: usize) -> [f64; N_DISPLACEMENTS] {
        self.displacements[index]
    }

    pub fn sample_feature(&self, index: usize) -> [f64; N_FEATURES] {
        self.features[index]
    }

    /// 只做最近邻（不插值），便于诊断。
    pub fn nearest_index(&self, query: &[f64; N_FEATURES]) -> (usize, f64) {
        let mut best = 0usize;
        let mut best_distance_sq = f64::INFINITY;
        for (index, feature) in self.features.iter().enumerate() {
            let mut sum = 0.0;
            for axis in 0..N_FEATURES {
                let delta = feature[axis] - query[axis];
                sum += delta * delta;
            }
            if sum < best_distance_sq {
                best_distance_sq = sum;
                best = index;
            }
        }
        (best, best_distance_sq.sqrt())
    }

    /// 曲率特征 → ΔL 增量（mm）。算法同 `ik_table.PoseTable._interp_dL`。
    pub fn lookup(&self, query: [f64; N_FEATURES]) -> Result<KappaLookup, KappaTableError> {
        let (raw, nearest_distance, exact_index) =
            raw_interp(&self.features, &self.displacements, query)?;

        let mut displacement_mm = raw;
        let index = exact_index.unwrap_or(0);
        let _ = index;
        for out in 0..N_DISPLACEMENTS {
            displacement_mm[out] -= self.reference[out];
        }

        Ok(KappaLookup {
            displacement_mm,
            nearest_distance,
            covered: nearest_distance <= COVERAGE_RADIUS_PER_M,
        })
    }

    /// 两段同向、方向遍历一圈时**仍被表覆盖**的最大曲率 κ（1/m）。
    ///
    /// 用途：UI 侧拖动 / 反解的运动范围上限。
    ///
    /// 背景：UI 原来的上限是写死的「85°/0.2m ≈ 7.4 1/m」，比表覆盖大 4 倍还多 —— 拖出来的形状
    /// 后端根本查不到，下发必然报「曲率超出 κ 表覆盖范围」。这个值直接**从表数据扫出来**，
    /// 所以换成导入的模型包（`model.tdcrmodel`）后，UI 上限会自动跟着变。
    ///
    /// 扫描口径偏保守（两段等大、方向任意都要落在覆盖半径内），宁可少给一点，
    /// 也不要给一个「发出去必失败」的上限。
    pub fn covered_kappa_limit(&self) -> f64 {
        const DIRECTIONS: usize = 8;
        const COARSE_STEP: f64 = 0.2;
        const MAX_KAPPA: f64 = 16.0;

        let covered_at = |kappa: f64| -> bool {
            (0..DIRECTIONS).all(|step| {
                let phi = std::f64::consts::TAU * step as f64 / DIRECTIONS as f64;
                let (sin, cos) = phi.sin_cos();
                let query = [kappa * cos, kappa * sin, kappa * cos, kappa * sin];
                matches!(self.lookup(query), Ok(hit) if hit.covered)
            })
        };

        if !covered_at(0.0) {
            return 0.0;
        }
        let mut low = 0.0_f64;
        let mut high = MAX_KAPPA;
        let mut probe = 0.0_f64;
        while probe < MAX_KAPPA {
            probe = (probe + COARSE_STEP).min(MAX_KAPPA);
            if !covered_at(probe) {
                break;
            }
            low = probe;
        }
        high = (low + COARSE_STEP).min(MAX_KAPPA);
        // 二分细化到 0.01
        for _ in 0..12 {
            let mid = 0.5 * (low + high);
            if covered_at(mid) {
                low = mid;
            } else {
                high = mid;
            }
        }
        (low * 100.0).floor() / 100.0
    }
}

/// 原始插值：返回 `(ΔL, 最近邻距离, 是否精确命中某样本)`。
fn raw_interp(
    features: &[[f64; N_FEATURES]],
    displacements: &[[f64; N_DISPLACEMENTS]],
    query: [f64; N_FEATURES],
) -> Result<([f64; N_DISPLACEMENTS], f64, Option<usize>), KappaTableError> {
    for value in query.iter() {
        if !value.is_finite() {
            return Err(KappaTableError::Singular);
        }
    }
    if features.is_empty() {
        return Err(KappaTableError::Empty);
    }

    // ① K_INTERP 近邻
    let mut candidates: Vec<(usize, f64)> = Vec::with_capacity(K_INTERP + 1);
    for (index, feature) in features.iter().enumerate() {
        let mut sum = 0.0;
        for axis in 0..N_FEATURES {
            let delta = feature[axis] - query[axis];
            sum += delta * delta;
        }
        let distance = sum.sqrt();
        if candidates.len() < K_INTERP {
            candidates.push((index, distance));
            candidates.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
        } else if distance < candidates[K_INTERP - 1].1 {
            candidates[K_INTERP - 1] = (index, distance);
            candidates.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
        }
    }

    let (nearest_index, nearest_distance) = candidates[0];

    // ② 精确命中
    if nearest_distance < 1e-9 {
        return Ok((displacements[nearest_index], nearest_distance, Some(nearest_index)));
    }
    // ③ 邻域太少 → 退回最近邻
    if candidates.len() < 4 {
        return Ok((displacements[nearest_index], nearest_distance, Some(nearest_index)));
    }

    // ④ 局部加权线性：A = [1, dq]，w = 1/(d+1)，解 (AᵀW²A + ridge·I) c = AᵀW²B
    let mut normal = [[0.0f64; 8]; 8];
    let mut rhs = [[0.0f64; N_DISPLACEMENTS]; 8];
    let mut a_row = [0.0f64; 8];
    for &(index, distance) in &candidates {
        a_row[0] = 1.0;
        for axis in 0..N_FEATURES {
            a_row[1 + axis] = features[index][axis] - query[axis];
        }
        let weight = 1.0 / (distance + 1.0);
        let w2 = weight * weight;
        for row in 0..8 {
            for col in 0..8 {
                normal[row][col] += w2 * a_row[row] * a_row[col];
            }
            for out in 0..N_DISPLACEMENTS {
                rhs[row][out] += w2 * a_row[row] * displacements[index][out];
            }
        }
    }
    for (axis, row) in normal.iter_mut().enumerate() {
        row[axis] += RIDGE;
    }

    let Some(coefficients) = solve(&mut normal, &mut rhs) else {
        return Ok((displacements[nearest_index], nearest_distance, Some(nearest_index)));
    };

    // ⑤ Shepard(IDW) 残差修正
    let mut corrected = [0.0f64; N_DISPLACEMENTS];
    let mut weight_sum = 0.0f64;
    for &(index, distance) in &candidates {
        let mut predicted = [0.0f64; N_DISPLACEMENTS];
        for out in 0..N_DISPLACEMENTS {
            let mut value = coefficients[0][out];
            for axis in 0..N_FEATURES {
                value += coefficients[1 + axis][out] * (features[index][axis] - query[axis]);
            }
            predicted[out] = value;
        }
        let ww = 1.0 / (distance * distance + 1e-12);
        for out in 0..N_DISPLACEMENTS {
            corrected[out] += ww * (displacements[index][out] - predicted[out]);
        }
        weight_sum += ww;
    }

    let mut result = [0.0f64; N_DISPLACEMENTS];
    for out in 0..N_DISPLACEMENTS {
        let value = coefficients[0][out] + corrected[out] / weight_sum;
        if !value.is_finite() {
            return Ok((displacements[nearest_index], nearest_distance, Some(nearest_index)));
        }
        result[out] = value;
    }

    Ok((result, nearest_distance, None))
}

/// 解 `8×8` 线性方程组（含 `N_DISPLACEMENTS` 个右端项），列主元高斯消元。
fn solve(
    matrix: &mut [[f64; 8]; 8],
    rhs: &mut [[f64; N_DISPLACEMENTS]; 8],
) -> Option<[[f64; N_DISPLACEMENTS]; 8]> {
    const N: usize = 8;
    for pivot in 0..N {
        let mut best = pivot;
        for row in (pivot + 1)..N {
            if matrix[row][pivot].abs() > matrix[best][pivot].abs() {
                best = row;
            }
        }
        if matrix[best][pivot].abs() < 1e-18 {
            return None;
        }
        if best != pivot {
            matrix.swap(pivot, best);
            rhs.swap(pivot, best);
        }
        let diagonal = matrix[pivot][pivot];
        for col in pivot..N {
            matrix[pivot][col] /= diagonal;
        }
        for out in 0..N_DISPLACEMENTS {
            rhs[pivot][out] /= diagonal;
        }
        for row in 0..N {
            if row == pivot {
                continue;
            }
            let factor = matrix[row][pivot];
            if factor == 0.0 {
                continue;
            }
            for col in pivot..N {
                matrix[row][col] -= factor * matrix[pivot][col];
            }
            for out in 0..N_DISPLACEMENTS {
                rhs[row][out] -= factor * rhs[pivot][out];
            }
        }
    }
    Some(*rhs)
}

/// `(κ, φ)` 两段 → 4 维查表特征 `[κxA, κyA, κxB, κyB]`。
pub fn features_from_segments(
    segment_curvature_per_m: [f64; 2],
    segment_direction_rad: [f64; 2],
) -> [f64; N_FEATURES] {
    [
        segment_curvature_per_m[0] * segment_direction_rad[0].cos(),
        segment_curvature_per_m[0] * segment_direction_rad[0].sin(),
        segment_curvature_per_m[1] * segment_direction_rad[1].cos(),
        segment_curvature_per_m[1] * segment_direction_rad[1].sin(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_both_tables() {
        for kind in [KappaTableKind::Limit40n, KappaTableKind::Limit60n] {
            let table = KappaTable::load(kind).expect("load");
            assert_eq!(table.len(), 1200, "{}", kind.label());
        }
    }

    #[test]
    fn straight_arm_maps_to_zero_displacement() {
        let table = KappaTable::load(KappaTableKind::Limit60n).expect("load");
        let hit = table.lookup([0.0, 0.0, 0.0, 0.0]).expect("lookup");
        for value in hit.displacement_mm {
            assert!(value.abs() < 1e-6, "straight arm must be 0, got {value}");
        }
    }

    #[test]
    fn reference_is_the_straight_arm_baseline() {
        for kind in [KappaTableKind::Limit40n, KappaTableKind::Limit60n] {
            let table = KappaTable::load(kind).expect("load");
            for value in table.reference() {
                assert!((-80.0..0.0).contains(&value), "{} ref {value}", kind.label());
            }
        }
    }

    #[test]
    fn table_point_is_reproduced_as_offset_from_reference() {
        let table = KappaTable::load(KappaTableKind::Limit60n).expect("load");
        for probe in [0usize, 300, 777, 1199] {
            let hit = table.lookup(table.sample_feature(probe)).expect("lookup");
            let raw = table.sample_displacement(probe);
            for out in 0..N_DISPLACEMENTS {
                let want = raw[out] - table.reference()[out];
                assert!(
                    (hit.displacement_mm[out] - want).abs() < 1e-6,
                    "probe {probe} wire {out}: {} vs {want}",
                    hit.displacement_mm[out],
                );
            }
            assert!(hit.covered);
        }
    }

    #[test]
    fn far_query_is_reported_as_uncovered() {
        let table = KappaTable::load(KappaTableKind::Limit60n).expect("load");
        let hit = table.lookup([50.0, 50.0, 50.0, 50.0]).expect("lookup");
        assert!(!hit.covered);
        assert!(hit.nearest_distance > COVERAGE_RADIUS_PER_M);
    }

    #[test]
    fn bending_moves_opposite_wires_in_opposite_directions() {
        let table = KappaTable::load(KappaTableKind::Limit60n).expect("load");
        // 段A 向 α=0° 弯 ⇒ wire0 应比 wire3 更短（负得更多）
        let hit = table
            .lookup(features_from_segments([2.0, 0.0], [0.0, 0.0]))
            .expect("lookup");
        assert!(
            hit.displacement_mm[0] < hit.displacement_mm[3],
            "wire0 {} should shorten more than wire3 {}",
            hit.displacement_mm[0],
            hit.displacement_mm[3],
        );
    }

    #[test]
    fn covered_kappa_limit_is_inside_table_range() {
        for kind in [KappaTableKind::Limit40n, KappaTableKind::Limit60n] {
            let table = KappaTable::load(kind).expect("load");
            let limit = table.covered_kappa_limit();
            // 实测：40N ≈ 1.0、60N ≈ 1.0 上下；只要在 (0.3, 4.0) 内就说明扫描没跑飞。
            assert!(
                limit > 0.3 && limit < 4.0,
                "{} limit={limit}",
                kind.label()
            );
            // 上限处仍覆盖，再往外就应判超表（两段等大、方向 0）。
            let at_limit = table
                .lookup(features_from_segments([limit, limit], [0.0, 0.0]))
                .expect("lookup");
            assert!(at_limit.covered, "{} limit not covered", kind.label());
            let beyond = table
                .lookup(features_from_segments([limit + 1.0, limit + 1.0], [0.0, 0.0]))
                .expect("lookup");
            assert!(!beyond.covered, "{} beyond limit still covered", kind.label());
        }
    }

    #[test]
    fn features_follow_curvature_direction() {
        let f = features_from_segments([2.0, 0.0], [0.0, 0.0]);
        assert!((f[0] - 2.0).abs() < 1e-12 && f[1].abs() < 1e-12);
        let g = features_from_segments([2.0, 0.0], [core::f64::consts::FRAC_PI_2, 0.0]);
        assert!(g[0].abs() < 1e-12 && (g[1] - 2.0).abs() < 1e-12);
    }
}
