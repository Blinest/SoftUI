//! 查表内核：k 近邻 + 加权局部线性 + Shepard 残差修正。
//!
//! 算法照搬 `tdcr_control/tools/ik_table.py` 的 `PoseTable._interp_dL`
//! （表点 ΔL 残差中位 5.11mm → 1.12mm），与特征维数无关。
//!
//! 1. 取最近 `k_interp` 个样本
//! 2. 精确命中（距离 ≈ 0）→ 直接返回该样本
//! 3. 局部加权线性 `A = [1, dq]`（权重 `1/(d+1)`，对角加 `ridge`）
//! 4. **Shepard(IDW) 残差修正** `1/(d²+ε)` —— 保证插值**穿过表点**
//!
//! > ⚠ 不上二阶：`ik_table` 实测邻域交叉项病态（29.5mm）。

/// 输出维数：6 根驱动丝。
pub const N_DISPLACEMENTS: usize = 6;
/// 求解时的最大参数个数（`1 + 特征维`，特征维 ≤ 7）。
const MAX_PARAMS: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TableError {
    Empty,
    BadMagic,
    Truncated,
    Dimension,
    NotFinite,
    Singular,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TableInterp {
    pub value: [f64; N_DISPLACEMENTS],
    pub nearest_distance: f64,
    pub exact_index: Option<usize>,
}

pub fn distance(feature: &[f64], query: &[f64]) -> f64 {
    let mut sum = 0.0;
    for axis in 0..feature.len() {
        let delta = feature[axis] - query[axis];
        sum += delta * delta;
    }
    sum.sqrt()
}

/// 最近邻样本 `(下标, 距离)`。
pub fn nearest(samples: &[Vec<f64>], query: &[f64]) -> (usize, f64) {
    let mut best = 0usize;
    let mut best_distance = f64::INFINITY;
    for (index, feature) in samples.iter().enumerate() {
        let dist = distance(feature, query);
        if dist < best_distance {
            best_distance = dist;
            best = index;
        }
    }
    (best, best_distance)
}

/// 原始插值。`samples[i]` 与 `displacements[i]` 一一对应。
pub fn raw_interp(
    samples: &[Vec<f64>],
    displacements: &[[f64; N_DISPLACEMENTS]],
    query: &[f64],
    k_interp: usize,
    ridge: f64,
) -> Result<TableInterp, TableError> {
    if samples.is_empty() || samples.len() != displacements.len() {
        return Err(TableError::Empty);
    }
    let dim = query.len();
    if dim == 0 || dim + 1 > MAX_PARAMS || samples[0].len() != dim {
        return Err(TableError::Dimension);
    }
    if query.iter().any(|value| !value.is_finite()) {
        return Err(TableError::NotFinite);
    }
    let k = k_interp.max(4).min(samples.len());

    // ① k 近邻
    let mut candidates: Vec<(usize, f64)> = Vec::with_capacity(k + 1);
    for (index, feature) in samples.iter().enumerate() {
        let dist = distance(feature, query);
        if candidates.len() < k {
            candidates.push((index, dist));
            candidates.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
        } else if dist < candidates[k - 1].1 {
            candidates[k - 1] = (index, dist);
            candidates.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
        }
    }
    let (nearest_index, nearest_distance) = candidates[0];

    // ② 精确命中 / ③ 邻域太少
    if nearest_distance < 1e-12 || candidates.len() < 4 {
        return Ok(TableInterp {
            value: displacements[nearest_index],
            nearest_distance,
            exact_index: Some(nearest_index),
        });
    }

    // ④ 加权局部线性
    let params = dim + 1;
    let mut normal = vec![vec![0.0f64; params]; params];
    let mut rhs = vec![[0.0f64; N_DISPLACEMENTS]; params];
    let mut a_row = vec![0.0f64; params];
    for &(index, dist) in &candidates {
        a_row[0] = 1.0;
        for axis in 0..dim {
            a_row[1 + axis] = samples[index][axis] - query[axis];
        }
        let w2 = (1.0 / (dist + 1.0)).powi(2);
        for row in 0..params {
            for col in 0..params {
                normal[row][col] += w2 * a_row[row] * a_row[col];
            }
            for out in 0..N_DISPLACEMENTS {
                rhs[row][out] += w2 * a_row[row] * displacements[index][out];
            }
        }
    }
    for (axis, row) in normal.iter_mut().enumerate() {
        row[axis] += ridge;
    }

    let Some(coef) = solve(&mut normal, &mut rhs) else {
        return Ok(TableInterp {
            value: displacements[nearest_index],
            nearest_distance,
            exact_index: Some(nearest_index),
        });
    };

    // ⑤ Shepard 残差修正
    let mut corrected = [0.0f64; N_DISPLACEMENTS];
    let mut weight_sum = 0.0f64;
    for &(index, dist) in &candidates {
        let mut predicted = [0.0f64; N_DISPLACEMENTS];
        for out in 0..N_DISPLACEMENTS {
            let mut value = coef[0][out];
            for axis in 0..dim {
                value += coef[1 + axis][out] * (samples[index][axis] - query[axis]);
            }
            predicted[out] = value;
        }
        let ww = 1.0 / (dist * dist + 1e-12);
        for out in 0..N_DISPLACEMENTS {
            corrected[out] += ww * (displacements[index][out] - predicted[out]);
        }
        weight_sum += ww;
    }

    let mut value = [0.0f64; N_DISPLACEMENTS];
    for out in 0..N_DISPLACEMENTS {
        let candidate = coef[0][out] + corrected[out] / weight_sum;
        if !candidate.is_finite() {
            return Ok(TableInterp {
                value: displacements[nearest_index],
                nearest_distance,
                exact_index: Some(nearest_index),
            });
        }
        value[out] = candidate;
    }

    Ok(TableInterp {
        value,
        nearest_distance,
        exact_index: None,
    })
}

/// 列主元高斯消元，解 `n×n` 含 `N_DISPLACEMENTS` 个右端项。
fn solve(
    matrix: &mut [Vec<f64>],
    rhs: &mut [[f64; N_DISPLACEMENTS]],
) -> Option<Vec<[f64; N_DISPLACEMENTS]>> {
    let n = matrix.len();
    for pivot in 0..n {
        let mut best = pivot;
        for row in (pivot + 1)..n {
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
        for col in pivot..n {
            matrix[pivot][col] /= diagonal;
        }
        for out in 0..N_DISPLACEMENTS {
            rhs[pivot][out] /= diagonal;
        }
        for row in 0..n {
            if row == pivot {
                continue;
            }
            let factor = matrix[row][pivot];
            if factor == 0.0 {
                continue;
            }
            for col in pivot..n {
                matrix[row][col] -= factor * matrix[pivot][col];
            }
            for out in 0..N_DISPLACEMENTS {
                rhs[row][out] -= factor * rhs[pivot][out];
            }
        }
    }
    Some(rhs.to_vec())
}

/// 解析 `<magic><u32 n><u32 dim><u32 ndl>` + `n × (dim + ndl)` 个 f32。
pub fn parse_table(
    bytes: &[u8],
    magic: &[u8; 4],
    dim: usize,
) -> Result<(Vec<Vec<f64>>, Vec<[f64; N_DISPLACEMENTS]>), TableError> {
    if bytes.len() < 16 {
        return Err(TableError::Truncated);
    }
    if &bytes[0..4] != magic {
        return Err(TableError::BadMagic);
    }
    let count = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let feature_dim = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    let displacement_dim = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
    if feature_dim != dim || displacement_dim != N_DISPLACEMENTS {
        return Err(TableError::Dimension);
    }
    if count == 0 {
        return Err(TableError::Empty);
    }
    let stride = dim + N_DISPLACEMENTS;
    if bytes.len() < 16 + count * stride * 4 {
        return Err(TableError::Truncated);
    }

    let read = |offset: usize| -> f64 {
        f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as f64
    };

    let mut samples = Vec::with_capacity(count);
    let mut displacements = Vec::with_capacity(count);
    for index in 0..count {
        let base = 16 + index * stride * 4;
        let feature = (0..dim).map(|slot| read(base + slot * 4)).collect();
        let mut displacement = [0.0f64; N_DISPLACEMENTS];
        for (slot, item) in displacement.iter_mut().enumerate() {
            *item = read(base + (dim + slot) * 4);
        }
        samples.push(feature);
        displacements.push(displacement);
    }
    Ok((samples, displacements))
}
