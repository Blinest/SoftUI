//! 位姿查表：末端位姿 → 6 肌腱位移（ΔL）。
//!
//! 与 [`crate::kappatable`] 同源（同一批打靶样本），但索引键换成**位姿**，
//! 即 `ik_table.PoseTable` 的原设计：
//!
//! ```text
//! q = [ σ_p · p_tip(mm) ,  w_f · rotvec(mrad) ]      (6 维白化空间)
//!      σ_p = 5.0 mm,  mm_per_mrad = 0.5  ⇒  w_f = 10.0
//! ```
//!
//! 相对 [`crate::kappatable`] 的优势：**位姿键天然包含轴向长度**，
//! 不会被「直臂但压缩」与「直臂且放松」的多余度混淆。
//!
//! 数据源：`vc_table_{40,60}.npz` 的 `p_tip` / `R_tip` / `dL_mm`
//! → `assets/pose_table_{40,60}.bin`（各 56.3 KB）。
//!
//! 直臂参考态 = 查询 `p = [0, 0, L_geom]`、`R = I` 处的原始插值，
//! 使「下发直臂位姿」严格对应零位移。

use crate::tablecore::{self, TableError, N_DISPLACEMENTS};

const MAGIC: &[u8; 4] = b"PTB1";
const DIM: usize = 6;

/// 参数化尺度 σ_p（mm）。
pub const SIGMA_P_MM: f64 = 5.0;
/// 1 mm 位置误差 ≙ 0.5 mrad 姿态误差。
pub const MM_PER_MRAD: f64 = 0.5;
/// 姿态权重 `w_f = σ_p / mm_per_mrad = 10 mm/mrad`。
pub const W_F: f64 = SIGMA_P_MM / MM_PER_MRAD;

/// 几何臂长（m）—— 与 `tools/tendon_coupling.py` 的 `L1 = L2 = 0.2225887` 一致。
pub const L_TOTAL_M: f64 = 0.445177422;

/// 覆盖半径（白化空间）。依据：40N/60N 表最近邻距离中位 ≈ 232 / 309、p90 ≈ 430 / 554。
pub const COVERAGE_RADIUS: f64 = 700.0;

/// 提示半径：最近邻超过它时结果可信度下降。
pub const WARN_RADIUS: f64 = 430.0;

static TABLE_40: &[u8] = include_bytes!("../assets/pose_table_40.bin");
static TABLE_60: &[u8] = include_bytes!("../assets/pose_table_60.bin");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PoseTableKind {
    Limit40n,
    Limit60n,
}

impl PoseTableKind {
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

#[derive(Debug, Clone, PartialEq)]
pub struct PoseLookup {
    /// 6 根丝位移增量（mm，已相对直臂参考态归零）。
    pub displacement_mm: [f64; N_DISPLACEMENTS],
    /// 白化空间最近邻距离。
    pub nearest_distance: f64,
    /// 是否落在覆盖半径内。
    pub covered: bool,
    /// 最近邻是否已进入可信度下降区。
    pub degraded: bool,
}

pub struct PoseTable {
    kind: PoseTableKind,
    samples: Vec<Vec<f64>>,
    displacements: Vec<[f64; N_DISPLACEMENTS]>,
    shapes: Vec<[f32; N_SHAPE_NODES * N_SHAPE_COMPONENTS]>,
    reference: [f64; N_DISPLACEMENTS],
}

impl PoseTable {
    /// 从内置资源加载。
    pub fn load(kind: PoseTableKind) -> Result<Self, TableError> {
        Self::from_bytes(kind, kind.bytes(), kind.shape_bytes())
    }

    /// 从任意字节加载（运行时导入的模型包用这条路径）。
    pub fn from_bytes(
        kind: PoseTableKind,
        table_bytes: &[u8],
        shape_bytes: &[u8],
    ) -> Result<Self, TableError> {
        let (samples, displacements) = tablecore::parse_table(table_bytes, MAGIC, DIM)?;

        // 直臂参考态：几何臂长 + 单位姿态
        let straight = encode_pose_mm([0.0, 0.0, L_TOTAL_M * 1000.0], [0.0, 0.0, 0.0]);
        let reference = tablecore::raw_interp(&samples, &displacements, &straight, 8, 1e-6)?.value;
        let shapes = parse_shapes(shape_bytes, samples.len())?;

        Ok(Self {
            kind,
            samples,
            displacements,
            shapes,
            reference,
        })
    }

    pub fn kind(&self) -> PoseTableKind {
        self.kind
    }

    pub fn len(&self) -> usize {
        self.samples.len()
    }

    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    /// 直臂参考态 ΔL（mm）。
    pub fn reference(&self) -> [f64; N_DISPLACEMENTS] {
        self.reference
    }

    pub fn lookup(&self, query: &[f64; DIM]) -> Result<PoseLookup, TableError> {
        let interp = tablecore::raw_interp(&self.samples, &self.displacements, query, 8, 1e-6)?;
        let mut displacement_mm = interp.value;
        for out in 0..N_DISPLACEMENTS {
            displacement_mm[out] -= self.reference[out];
        }
        Ok(PoseLookup {
            displacement_mm,
            nearest_distance: interp.nearest_distance,
            covered: interp.nearest_distance <= COVERAGE_RADIUS,
            degraded: interp.nearest_distance > WARN_RADIUS,
        })
    }
}

/// 位置(mm) + 旋转向量(mrad) → 白化 6 维查询键。
pub fn encode_pose_mm(position_mm: [f64; 3], rotvec_mrad: [f64; 3]) -> [f64; DIM] {
    [
        SIGMA_P_MM * position_mm[0],
        SIGMA_P_MM * position_mm[1],
        SIGMA_P_MM * position_mm[2],
        W_F * rotvec_mrad[0],
        W_F * rotvec_mrad[1],
        W_F * rotvec_mrad[2],
    ]
}

/// 位置(mm) + roll/pitch/yaw(rad, ZYX 内旋) → 白化 6 维查询键。
pub fn encode_rpy_mm(position_mm: [f64; 3], roll: f64, pitch: f64, yaw: f64) -> [f64; DIM] {
    let rotation = rotation_from_rpy_zyx(roll, pitch, yaw);
    let rotvec = so3_log(&rotation);
    encode_pose_mm(
        position_mm,
        [rotvec[0] * 1000.0, rotvec[1] * 1000.0, rotvec[2] * 1000.0],
    )
}

/// ZYX 内旋：`R = Rz(yaw)·Ry(pitch)·Rx(roll)`，与 `ik_table.rot_to_rpy` 互逆。
pub fn rotation_from_rpy_zyx(roll: f64, pitch: f64, yaw: f64) -> [[f64; 3]; 3] {
    let (sr, cr) = (roll.sin(), roll.cos());
    let (sp, cp) = (pitch.sin(), pitch.cos());
    let (sy, cy) = (yaw.sin(), yaw.cos());
    [
        [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
        [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
        [-sp, cp * sr, cp * cr],
    ]
}

/// SO(3) 对数映射（旋转向量，rad）。与 `ik_table.so3_log` 同口径。
pub fn so3_log(rotation: &[[f64; 3]; 3]) -> [f64; 3] {
    let trace = rotation[0][0] + rotation[1][1] + rotation[2][2];
    let cosine = ((trace - 1.0) / 2.0).clamp(-1.0, 1.0);
    let theta = cosine.acos();
    if theta < 1e-9 {
        return [0.0; 3];
    }
    let axis = [
        rotation[2][1] - rotation[1][2],
        rotation[0][2] - rotation[2][0],
        rotation[1][0] - rotation[0][1],
    ];
    if (std::f64::consts::PI - theta).abs() < 1e-6 {
        // θ≈π：由 (R+I)/2 的对角线恢复轴
        let diag = [
            ((rotation[0][0] + 1.0) / 2.0).max(0.0).sqrt(),
            ((rotation[1][1] + 1.0) / 2.0).max(0.0).sqrt(),
            ((rotation[2][2] + 1.0) / 2.0).max(0.0).sqrt(),
        ];
        let dominant = if diag[0] >= diag[1] && diag[0] >= diag[2] {
            0
        } else if diag[1] >= diag[2] {
            1
        } else {
            2
        };
        if diag[dominant] > 1e-12 {
            let unit = [
                diag[0] / diag[dominant],
                diag[1] / diag[dominant],
                diag[2] / diag[dominant],
            ];
            let norm = (unit[0] * unit[0] + unit[1] * unit[1] + unit[2] * unit[2]).sqrt();
            return [
                theta * unit[0] / norm,
                theta * unit[1] / norm,
                theta * unit[2] / norm,
            ];
        }
        return [0.0; 3];
    }
    let factor = theta / (2.0 * theta.sin());
    [
        factor * axis[0],
        factor * axis[1],
        factor * axis[2],
    ]
}

// ==================== 形状（3D 预览用） ====================

/// 形状节点数：沿弧长均匀 12 段（与 UI 的 `CurvatureBasisSegment[]` 对齐）。
pub const N_SHAPE_NODES: usize = 12;
/// 形状分量数：κx / κy。
pub const N_SHAPE_COMPONENTS: usize = 2;
/// 几何臂长（mm）。
pub const L_TOTAL_MM: f64 = L_TOTAL_M * 1000.0;

static SHAPE_40: &[u8] = include_bytes!("../assets/pose_shape_40.bin");
static SHAPE_60: &[u8] = include_bytes!("../assets/pose_shape_60.bin");

/// 一次形状查询的结果（供 3D 预览渲染）。
#[derive(Debug, Clone, PartialEq)]
pub struct PoseShape {
    pub nearest_distance: f64,
    pub covered: bool,
    pub degraded: bool,
    /// 12 个节点的 (κx, κy)，单位 1/m —— 交错存放。
    pub kappa: [f32; N_SHAPE_NODES * N_SHAPE_COMPONENTS],
    /// 该表点的 6 丝位移（mm，未归零）。
    pub displacement_mm: [f64; N_DISPLACEMENTS],
}

impl PoseTableKind {
    pub fn shape_bytes(self) -> &'static [u8] {
        match self {
            Self::Limit40n => SHAPE_40,
            Self::Limit60n => SHAPE_60,
        }
    }
}

impl PoseTable {
    /// 位姿 → **该表点的真实形状**（0 阶：取最近表点）。
    ///
    /// 仅用于 3D 预览：预览显示的必须是表里真实存在的解，而不是前端拟合出来的
    /// 形状。1 阶插值会给出表里没有的中间形状，与下发量对不上，故这里不上插值。
    pub fn lookup_shape(&self, query: &[f64; DIM]) -> Result<PoseShape, TableError> {
        if self.samples.is_empty() {
            return Err(TableError::Empty);
        }
        let (nearest_index, nearest_distance) = tablecore::nearest(&self.samples, query);
        Ok(PoseShape {
            nearest_distance,
            covered: nearest_distance <= COVERAGE_RADIUS,
            degraded: nearest_distance > WARN_RADIUS,
            kappa: self.shapes[nearest_index],
            displacement_mm: self.displacements[nearest_index],
        })
    }
}

/// 解析形状表：`PSB1` + n + nodes + comps + `n × nodes × comps` 个 f32。
fn parse_shapes(
    bytes: &[u8],
    expected: usize,
) -> Result<Vec<[f32; N_SHAPE_NODES * N_SHAPE_COMPONENTS]>, TableError> {
    if bytes.len() < 16 {
        return Err(TableError::Truncated);
    }
    if &bytes[0..4] != b"PSB1" {
        return Err(TableError::BadMagic);
    }
    let count = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let nodes = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    let comps = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
    if nodes != N_SHAPE_NODES || comps != N_SHAPE_COMPONENTS || count != expected {
        return Err(TableError::Dimension);
    }
    let stride = nodes * comps;
    if bytes.len() < 16 + count * stride * 4 {
        return Err(TableError::Truncated);
    }
    let mut shapes = Vec::with_capacity(count);
    for index in 0..count {
        let base = 16 + index * stride * 4;
        let mut shape = [0.0f32; N_SHAPE_NODES * N_SHAPE_COMPONENTS];
        for (slot, item) in shape.iter_mut().enumerate() {
            let offset = base + slot * 4;
            *item = f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
        }
        shapes.push(shape);
    }
    Ok(shapes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_both_pose_tables() {
        for kind in [PoseTableKind::Limit40n, PoseTableKind::Limit60n] {
            let table = PoseTable::load(kind).expect("load");
            assert_eq!(table.len(), 1200, "{}", kind.label());
        }
    }

    #[test]
    fn identity_pose_has_zero_rotvec() {
        let r = rotation_from_rpy_zyx(0.0, 0.0, 0.0);
        let log = so3_log(&r);
        for value in log {
            assert!(value.abs() < 1e-12, "{value}");
        }
    }

    #[test]
    fn rotvec_round_trips_a_known_rotation() {
        // 绕 Z 轴 30°
        let r = rotation_from_rpy_zyx(0.0, 0.0, std::f64::consts::PI / 6.0);
        let log = so3_log(&r);
        assert!(log[0].abs() < 1e-9 && log[1].abs() < 1e-9);
        assert!((log[2] - std::f64::consts::PI / 6.0).abs() < 1e-9, "{}", log[2]);
    }

    #[test]
    fn straight_pose_maps_to_zero_displacement() {
        let table = PoseTable::load(PoseTableKind::Limit60n).expect("load");
        let query = encode_pose_mm([0.0, 0.0, L_TOTAL_M * 1000.0], [0.0, 0.0, 0.0]);
        let hit = table.lookup(&query).expect("lookup");
        for value in hit.displacement_mm {
            assert!(value.abs() < 1e-6, "straight pose must be 0, got {value}");
        }
    }

    #[test]
    fn shape_lookup_returns_a_real_table_sample() {
        let table = PoseTable::load(PoseTableKind::Limit60n).expect("load");
        let query = encode_pose_mm([0.0, 0.0, L_TOTAL_MM], [0.0, 0.0, 0.0]);
        let shape = table.lookup_shape(&query).expect("shape");
        assert!(shape.covered);
        // 直臂样本的曲率必须很小
        let magnitude: f32 = shape
            .kappa
            .chunks(2)
            .map(|pair| (pair[0] * pair[0] + pair[1] * pair[1]).sqrt())
            .fold(0.0f32, f32::max);
        assert!(magnitude < 1.0, "straight sample |kappa| = {magnitude}");
    }

    #[test]
    fn far_pose_is_reported_as_uncovered() {
        let table = PoseTable::load(PoseTableKind::Limit60n).expect("load");
        let query = encode_pose_mm([0.0, 0.0, 4000.0], [0.0, 0.0, 0.0]);
        let hit = table.lookup(&query).expect("lookup");
        assert!(!hit.covered);
        assert!(hit.nearest_distance > COVERAGE_RADIUS);
    }

    #[test]
    fn bending_pose_shortens_opposite_wires_differently() {
        let table = PoseTable::load(PoseTableKind::Limit60n).expect("load");
        // 臂沿 +Z 伸直；向 +X 弯 ⇒ 尖端 x>0
        let query = encode_pose_mm([120.0, 0.0, 400.0], [0.0, 0.0, 0.0]);
        let hit = table.lookup(&query).expect("lookup");
        assert!(hit.covered, "distance {}", hit.nearest_distance);
        // 至少要有显著的差分运动
        let spread = hit.displacement_mm.iter().cloned().fold(f64::MIN, f64::max)
            - hit.displacement_mm.iter().cloned().fold(f64::MAX, f64::min);
        assert!(spread > 1.0, "expect differential motion, spread = {spread}");
    }
}
