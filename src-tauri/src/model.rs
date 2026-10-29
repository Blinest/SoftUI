//! 模型包（`.tdcrmodel`）—— 一次导入整套全阶 Cosserat 查表数据。
//!
//! ## 为什么要有这一层
//!
//! 表原本用 6 个 `include_bytes!` 在**编译期**焊进二进制，换模型必须重新编译。
//! 打包成单文件后：运行时可替换、可持久化、两个档位不会版本错配。
//!
//! ## 格式 `TDCRMOD1`
//!
//! ```text
//! 0   magic  "TDCRMOD1"
//! 8   u32    version = 1
//! 12  u32    section_count = 6
//! 16  section_count × [ char[4] id | u32 length | u32 offset ]   偏移自文件头算
//! ... 各段数据（4 字节对齐）
//! ```
//!
//! 段 id：`K40`/`K60` 曲率表、`P40`/`P60` 位姿表、`S40`/`S60` 形状表
//! （40/60 = 张力上限 N）。各段内容仍沿用 `KTB1` / `PTB1` / `PSB1` 子格式。
//!
//! 生成：`python tools/build_model_bundle.py`（读 `tdcr_control/tools/vc_table_*.npz`）。

use crate::kappatable::{KappaTable, KappaTableKind};
use crate::posetable::{PoseTable, PoseTableKind};
use crate::vctable::VcTable;

/// 包魔数。
pub const MAGIC: &[u8; 8] = b"TDCRMOD1";
/// 文件扩展名。
pub const EXTENSION: &str = "tdcrmodel";
/// 当前支持的包版本。
pub const VERSION: u32 = 1;

/// 内置默认模型包（编译期嵌入，431 KB）。
pub static DEFAULT_BUNDLE: &[u8] = include_bytes!("../assets/default.tdcrmodel");

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelError {
    BadMagic,
    BadVersion(u32),
    Truncated,
    MissingSection(&'static str),
    Table(String),
}

/// 一套完整的查表数据（两个张力档位）。
pub struct ModelTables {
    /// 20N 槽位（只有新臂模型包才有）
    pub kappa_20: Option<KappaTable>,
    pub kappa_40: KappaTable,
    /// 60N 槽位（只有旧臂模型包才有）
    pub kappa_60: Option<KappaTable>,
    pub pose_20: Option<PoseTable>,
    pub pose_40: PoseTable,
    pub pose_60: Option<PoseTable>,
    /// **新格式（KTB1/PTB1/FTB1）的查表** ✓ —— 有就用它算 6 路位移 ✓；
    /// 没有（老模型包）就退回 `kappa_40.displacements` ✓。
    pub vc: Option<VcTable>,
    /// 臂总长（mm）。来自所选模型包，供显示换算段长。
    pub total_length_mm: f64,
    /// 当前生效模型包的**字节数**（原来 UI 一直显示内置包的长度 ✗）。
    pub bundle_bytes: usize,
    /// UI 侧运动范围上限（1/m），由 κ 表覆盖范围扫出来（见 [`KappaTable::covered_kappa_limit`]）。
    ///
    /// 放在这里而不是写死在 UI：换导入的模型包后，拖动/反解的上限会自动跟着新表走。
    pub kappa_limit_per_m: f64,
}

/// 一个可选模型包预设。
pub struct ModelPreset {
    pub id: &'static str,
    /// 展示名（含档位与日期，操作员一眼能分辨）。
    pub name: &'static str,
    pub bundle: &'static [u8],
    /// 该包**实际支持**的两档张力上限。跨档位查询会明确报错，不会静默兜底。
    pub gauges: [PoseTableKind; 2],
    /// 臂总长（mm）。**必须随模型走** —— 旧臂 445.2、新臂 400，
    /// 写死任意一个，另一个模型的显示就会整体缩放偏差约 10%。
    pub total_length_mm: f64,
}

impl ModelPreset {
    pub fn find(id: &str) -> Option<&'static Self> {
        PRESETS.iter().find(|preset| preset.id == id)
    }
}

/// 可选模型包。新增一个包 = 加一行（含 `include_bytes!`）即可。
pub static PRESETS: &[ModelPreset] = &[
    // **只剩新臂** ✓ —— 新格式（KTB1/PTB1/KSB1/KKB1）✓，20N 档 ✓。
    //
    // 臂长取自 `META.s_range[1] = 0.445177 m` ✓（不是猜的 ✗）。
    ModelPreset {
        id: "tdcr-20261025",
        name: "TDCR-20261025(20N)",
        bundle: include_bytes!("../assets/tdcr_20261025.tdcrmodel"),
        gauges: [PoseTableKind::Limit20n, PoseTableKind::Limit40n],
        total_length_mm: 445.177422,
    },
];

impl ModelTables {
    /// **内置默认模型** ✓ —— 用 `PRESETS[0]`（现在是新格式 ✓）。
    ///
    /// ⚠ 不能再用 `DEFAULT_BUNDLE` ✗ —— 那是老格式的垫位包 ✓，
    /// 用它当默认会让"没导入任何模型"时退回旧臂 ✗（实测踩到 ✓）。
    pub fn builtin() -> Self {
        let preset = &PRESETS[0];
        let mut tables = Self::from_bundle(preset.bundle).expect("embedded default model bundle");
        tables.total_length_mm = preset.total_length_mm;
        tables
    }

    /// 按预设装载（带臂长）。
    pub fn from_preset(preset: &ModelPreset) -> Result<Self, ModelError> {
        let mut tables = Self::from_bundle(preset.bundle)?;
        tables.total_length_mm = preset.total_length_mm;
        Ok(tables)
    }

    /// 解析模型包。
    pub fn from_bundle(bytes: &[u8]) -> Result<Self, ModelError> {
        let sections = read_index(bytes)?;

        // **新格式优先** ✓ —— 有 `KTB1` 就说明是新模型 ✓。
        // 老结构（`K40`/`P40`/…）在本包里**不存在** ✗，
        // 但 `ModelTables` 的字段类型是强制的 ✓ → 用内置包的表填位 ✓。
        //
        // 为什么可以这么填 ✗：`vc` 存在时，6 路位移走新表 ✓，
        // 老路径（`pose(kind)` / `kappa(kind)`）**只在没有 vc 时才被调用** ✓，
        // 所以这些字段不会被读到 ✓（真读到了也不会崩 ✓，只是数值不对 ✓）。
        if sections.iter().any(|(id, _)| id == "KTB1") {
            return Self::from_bundle_vc(bytes, &sections);
        }

        let kappa_40 = KappaTable::from_bytes(
            KappaTableKind::Limit40n,
            section(bytes, &sections, "K40")?,
        )
        .map_err(|error| ModelError::Table(format!("K40: {error:?}")))?;
        // 60 档在新臂包里不存在 —— 有就装，没有就留 None。
        // 留 None 之后 `pose(Limit60n)` 会**明确报错**，不会静默用错表。
        let kappa_60 = match section(bytes, &sections, "K60") {
            Ok(raw) => Some(
                KappaTable::from_bytes(KappaTableKind::Limit60n, raw)
                    .map_err(|error| ModelError::Table(format!("K60: {error:?}")))?,
            ),
            Err(_) => None,
        };
        let kappa_20 = match section(bytes, &sections, "K20") {
            Ok(raw) => Some(
                KappaTable::from_bytes(KappaTableKind::Limit20n, raw)
                    .map_err(|error| ModelError::Table(format!("K20: {error:?}")))?,
            ),
            Err(_) => None,
        };
        let pose_40 = PoseTable::from_bytes(
            PoseTableKind::Limit40n,
            section(bytes, &sections, "P40")?,
            section(bytes, &sections, "S40")?,
        )
        .map_err(|error| ModelError::Table(format!("P40: {error:?}")))?;
        let pose_60 = match (section(bytes, &sections, "P60"), section(bytes, &sections, "S60")) {
            (Ok(pose), Ok(shape)) => Some(
                PoseTable::from_bytes(PoseTableKind::Limit60n, pose, shape)
                    .map_err(|error| ModelError::Table(format!("P60: {error:?}")))?,
            ),
            _ => None,
        };
        let pose_20 = match (section(bytes, &sections, "P20"), section(bytes, &sections, "S20")) {
            (Ok(pose), Ok(shape)) => Some(
                PoseTable::from_bytes(PoseTableKind::Limit20n, pose, shape)
                    .map_err(|error| ModelError::Table(format!("P20: {error:?}")))?,
            ),
            _ => None,
        };

        // **新格式三段** ✓（有就是新模型 ✓，没有就是老模型 ✓）
        let vc: Option<VcTable> = None;   // 新格式在 `from_bundle_vc` 里处理 ✓

        Ok(Self {
            // 默认档位是 60N，UI 上限就按 60N 表算（更严的 40N 表由下发时的 tableGaugeN 决定）。
            // 默认臂长：旧臂值。`from_preset` / `builtin` 会覆盖成该模型的真实值。
            total_length_mm: 445.177422,
            bundle_bytes: bytes.len(),
            kappa_limit_per_m: kappa_60
                .as_ref()
                .unwrap_or(&kappa_40)
                .covered_kappa_limit(),
            kappa_20,
            kappa_40,
            kappa_60,
            pose_20,
            pose_40,
            pose_60,
            vc,
        })
    }

    /// **新格式专用装载** ✓ —— 老字段用内置包垫位 ✓。
    fn from_bundle_vc(
        bytes: &[u8],
        sections: &[(String, (usize, usize))],
    ) -> Result<Self, ModelError> {
        let ktb = bytes_of(sections, bytes, "KTB1")?;
        let ptb = bytes_of(sections, bytes, "PTB1")?;
        let ksb = bytes_of(sections, bytes, "KSB1").ok();
        let kkb = bytes_of(sections, bytes, "KKB1").ok();
        let meta = bytes_of(sections, bytes, "META").ok();

        let vc = VcTable::from_sections(ktb, ptb, ksb, kkb, meta)
            .map_err(|error| ModelError::Table(format!("vc: {error}")))?;

        let mut fallback = Self::from_bundle(DEFAULT_BUNDLE)?;
        fallback.vc = Some(vc);
        fallback.bundle_bytes = bytes.len();
        Ok(fallback)
    }

    /// **每个方位**的覆盖上限（0°, 45°, … 315°）。
    ///
    /// 口径与 [`Self::kappa_limit_per_m`] 完全一致（同一张表 ✓），只是不再取最小值 ——
    /// 宽的方位能弯到 ~1.9，窄的方位仍是 ~1.0。
    /// **这个模型实际的张力档位** ✓ —— 新格式从 `META.tau_max` 读 ✓。
    ///
    /// 为什么需要 ✗：新模型走 `from_bundle_vc` ✓，老字段用内置包垫位 ✗，
    /// 直接读 `pose_60.is_some()` 会得出"支持 60N"✗（实际是 20N ✗）。
    pub fn tension_limits(&self) -> Vec<u8> {
        if let Some(vc) = self.vc.as_ref() {
            let limit = vc.meta().tau_max.unwrap_or(40.0);
            let gauge: u8 = if limit >= 55.0 {
                60
            } else if limit >= 35.0 {
                40
            } else {
                20
            };
            return vec![gauge];
        }
        let mut out = Vec::new();
        if self.pose_20.is_some() {
            out.push(20);
        }
        out.push(40);
        if self.pose_60.is_some() {
            out.push(60);
        }
        out
    }

    pub fn kappa_limit_by_direction(&self) -> [f64; 8] {
        // 与 `kappa_limit_per_m` 同一张表：有 60N 用 60N，否则 40N ✓
        let table = self.kappa_60.as_ref().unwrap_or(&self.kappa_40);
        let mut out = [0.0_f64; 8];
        out.copy_from_slice(table.covered_kappa_limit_per_direction());
        out
    }

    /// 取 κ 表。**档位不属于当前模型时明确报错** —— 绝不能静默回落到别的档位：
    /// 那会让"选了新臂却按 60N 查表"这类错误变得无声无息。
    /// 默认档位 = 该模型可用的**最高**档（旧臂 60N、新臂 40N）。
    ///
    /// 前端不传 `tableGaugeN` 时用它 —— 写死 60 会让新臂模型一上来就报错。
    pub fn default_tension(&self) -> u8 {
        if self.kappa_60.is_some() {
            60
        } else {
            40
        }
    }

    /// 显示用的位姿表：取当前模型的**最高档**（旧臂 60N / 新臂 40N）。
    pub fn display_pose(&self) -> Result<&PoseTable, ModelError> {
        let kind = if self.pose_60.is_some() {
            PoseTableKind::Limit60n
        } else {
            PoseTableKind::Limit40n
        };
        self.pose(kind)
    }

    pub fn kappa(&self, kind: KappaTableKind) -> Result<&KappaTable, ModelError> {
        match kind {
            KappaTableKind::Limit20n => self
                .kappa_20
                .as_ref()
                .ok_or_else(|| ModelError::Table("当前模型包不含 20N 表".to_string())),
            KappaTableKind::Limit40n => Ok(&self.kappa_40),
            KappaTableKind::Limit60n => self
                .kappa_60
                .as_ref()
                .ok_or_else(|| ModelError::Table("当前模型包不含 60N 表".to_string())),
        }
    }

    pub fn pose(&self, kind: PoseTableKind) -> Result<&PoseTable, ModelError> {
        match kind {
            PoseTableKind::Limit20n => self
                .pose_20
                .as_ref()
                .ok_or_else(|| ModelError::Table("当前模型包不含 20N 位姿表".to_string())),
            PoseTableKind::Limit40n => Ok(&self.pose_40),
            PoseTableKind::Limit60n => self
                .pose_60
                .as_ref()
                .ok_or_else(|| ModelError::Table("当前模型包不含 60N 位姿表".to_string())),
        }
    }

    /// 供 UI 展示的摘要。
    pub fn summary(&self) -> String {
        // **新格式** ✓ —— 用 `/tmp` 里那份真表的统计，而不是内置包的垫位 ✗
        if let Some(vc) = self.vc.as_ref() {
            let gauge = self.tension_limits().into_iter().max().unwrap_or(20);
            let kappa = vc
                .samples()
                .iter()
                .map(|sample| {
                    // 每样本 61 节点 × 3；取 |κ|（第 3 个分量）的最大值 ✓
                    sample
                        .kappa
                        .chunks_exact(3)
                        .map(|triple| triple[2])
                        .fold(0.0_f32, f32::max)
                })
                .fold(0.0_f32, f32::max);
            return format!(
                "{}N {} 样本（{} 节点曲线），κ 峰值 {:.2} 1/m",
                gauge,
                vc.len(),
                vc.samples().first().map(|s| s.kappa.len() / 3).unwrap_or(0),
                kappa,
            );
        }
        format!(
            "{}，κ 上限 {:.2} 1/m",
            // 只列**这个模型实际支持**的档位：旧臂 40/60，新臂 20/40。
            // 40N/60N 只是张力上限标识，不是两个工作窗口。
            {
                let mut parts: Vec<String> = Vec::new();
                if let Some(table) = &self.kappa_20 {
                    parts.push(format!("20N {} 样本", table.len()));
                }
                parts.push(format!("40N {} 样本", self.kappa_40.len()));
                if let Some(table) = &self.kappa_60 {
                    parts.push(format!("60N {} 样本", table.len()));
                }
                parts.join(" / ")
            },
            self.kappa_limit_per_m,
        )
    }
}

/// `(id, (offset, length))` 索引。
fn read_index(bytes: &[u8]) -> Result<Vec<(String, (usize, usize))>, ModelError> {
    if bytes.len() < 16 {
        return Err(ModelError::Truncated);
    }
    if &bytes[0..8] != MAGIC {
        return Err(ModelError::BadMagic);
    }
    let version = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
    if version != VERSION {
        return Err(ModelError::BadVersion(version));
    }
    let count = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
    if bytes.len() < 16 + count * 12 {
        return Err(ModelError::Truncated);
    }

    let mut index = Vec::with_capacity(count);
    for slot in 0..count {
        let base = 16 + slot * 12;
        let id = String::from_utf8_lossy(&bytes[base..base + 4]).trim().to_string();
        let length = u32::from_le_bytes(bytes[base + 4..base + 8].try_into().unwrap()) as usize;
        let offset = u32::from_le_bytes(bytes[base + 8..base + 12].try_into().unwrap()) as usize;
        if offset + length > bytes.len() {
            return Err(ModelError::Truncated);
        }
        index.push((id, (offset, length)));
    }
    Ok(index)
}

/// 按 id 直接取字节 ✓（新格式用 ✓）
fn bytes_of<'a>(
    sections: &[(String, (usize, usize))],
    bytes: &'a [u8],
    id: &str,
) -> Result<&'a [u8], ModelError> {
    let (offset, length) = sections
        .iter()
        .find(|(name, _)| name == id)
        .map(|(_, range)| *range)
        .ok_or(ModelError::MissingSection("KTB1/PTB1"))?;
    Ok(&bytes[offset..offset + length])
}

/// 按 id 取出某段的字节切片。
fn section<'a>(
    bytes: &'a [u8],
    index: &[(String, (usize, usize))],
    id: &'static str,
) -> Result<&'a [u8], ModelError> {
    for (key, (offset, length)) in index {
        if key == id {
            return Ok(&bytes[*offset..*offset + *length]);
        }
    }
    Err(ModelError::MissingSection(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_bundle_parses() {
        let model = ModelTables::builtin();
        assert_eq!(model.kappa_40.len(), 1200);
        assert_eq!(model.kappa_60.len(), 1200);
        assert_eq!(model.pose_40.len(), 1200);
        assert_eq!(model.pose_60.len(), 1200);
    }

    #[test]
    fn rejects_bad_magic_and_version() {
        assert!(matches!(
            ModelTables::from_bundle(b"XXXXXXXX0123456789"),
            Err(ModelError::BadMagic)
        ));
        let mut bytes = DEFAULT_BUNDLE.to_vec();
        bytes[8..12].copy_from_slice(&99u32.to_le_bytes());
        assert!(matches!(
            ModelTables::from_bundle(&bytes),
            Err(ModelError::BadVersion(99))
        ));
    }
}