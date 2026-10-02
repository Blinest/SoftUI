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
    pub kappa_40: KappaTable,
    pub kappa_60: KappaTable,
    pub pose_40: PoseTable,
    pub pose_60: PoseTable,
    /// UI 侧运动范围上限（1/m），由 κ 表覆盖范围扫出来（见 [`KappaTable::covered_kappa_limit`]）。
    ///
    /// 放在这里而不是写死在 UI：换导入的模型包后，拖动/反解的上限会自动跟着新表走。
    pub kappa_limit_per_m: f64,
}

impl ModelTables {
    /// 内置默认模型。
    pub fn builtin() -> Self {
        Self::from_bundle(DEFAULT_BUNDLE).expect("embedded default model bundle")
    }

    /// 解析模型包。
    pub fn from_bundle(bytes: &[u8]) -> Result<Self, ModelError> {
        let sections = read_index(bytes)?;

        let kappa_40 = KappaTable::from_bytes(
            KappaTableKind::Limit40n,
            section(bytes, &sections, "K40")?,
        )
        .map_err(|error| ModelError::Table(format!("K40: {error:?}")))?;
        let kappa_60 = KappaTable::from_bytes(
            KappaTableKind::Limit60n,
            section(bytes, &sections, "K60")?,
        )
        .map_err(|error| ModelError::Table(format!("K60: {error:?}")))?;
        let pose_40 = PoseTable::from_bytes(
            PoseTableKind::Limit40n,
            section(bytes, &sections, "P40")?,
            section(bytes, &sections, "S40")?,
        )
        .map_err(|error| ModelError::Table(format!("P40: {error:?}")))?;
        let pose_60 = PoseTable::from_bytes(
            PoseTableKind::Limit60n,
            section(bytes, &sections, "P60")?,
            section(bytes, &sections, "S60")?,
        )
        .map_err(|error| ModelError::Table(format!("P60: {error:?}")))?;

        Ok(Self {
            // 默认档位是 60N，UI 上限就按 60N 表算（更严的 40N 表由下发时的 tableGaugeN 决定）。
            kappa_limit_per_m: kappa_60.covered_kappa_limit(),
            kappa_40,
            kappa_60,
            pose_40,
            pose_60,
        })
    }

    pub fn kappa(&self, kind: KappaTableKind) -> &KappaTable {
        match kind {
            KappaTableKind::Limit40n => &self.kappa_40,
            KappaTableKind::Limit60n => &self.kappa_60,
        }
    }

    pub fn pose(&self, kind: PoseTableKind) -> &PoseTable {
        match kind {
            PoseTableKind::Limit40n => &self.pose_40,
            PoseTableKind::Limit60n => &self.pose_60,
        }
    }

    /// 供 UI 展示的摘要。
    pub fn summary(&self) -> String {
        format!(
            "40N {} 样本 / 60N {} 样本，κ 上限 {:.2} 1/m",
            self.kappa_40.len(),
            self.kappa_60.len(),
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