//! **新模型格式的查表** ✓ —— `KTB1` / `PTB1` / `KSB1` / `KKB1`。
//!
//! 与老格式（`K40`/`P40`/`K20`/`P20`…）**并存** ✓：老路径一行不动 ✗，新的走这里 ✓。
//!
//! ## 段布局（全部 float32 小端，行主序）
//!
//! | 段 | 每样本 | 内容 |
//! |---|---|---|
//! | `KTB1` | 12 | `tau(n,6)` + `dL_mm(n,6)` |
//! | `PTB1` | 12 | `p_tip(n,3)` 米 + `R_tip(n,9)` 行主序 3×3 |
//! | `KSB1` | 61 | 弧长网格 `s`（米）|
//! | `KKB1` | 183 | `61 × 3` 曲率矢量 `(kx, ky, |κ|)`（1/m）|
//!
//! 四段行数一致 ✓，`samples[i]` 一一对应 ✓。

use serde::Serialize;

const KTB_STRIDE: usize = 12;
const PTB_STRIDE: usize = 12;
/// 位移分量数 ✓
const N_TENDONS: usize = 6;

/// 一个样本的完整数据 ✓
#[derive(Debug, Clone)]
pub struct VcSample {
    /// 6 路肌腱目标力（N）✓
    pub tau: [f32; N_TENDONS],
    /// 6 路肌腱目标位移（mm）✓ —— 这就是**要显示/下发**的量 ✓
    pub dl_mm: [f32; N_TENDONS],
    /// 末端位置（米）✓（`PTB1.p_tip`）
    pub tip_m: [f32; 3],
    /// 末端姿态矩阵（行主序 3×3）✓（`PTB1.R_tip`）
    pub rot: [f32; 9],
    /// 弧长网格（米）✓ 61 点；没有 `KSB1` 时为空 ✓
    pub s_m: Vec<f32>,
    /// 曲率矢量 `(kx, ky, |κ|)` ✓ 61 × 3；没有 `KKB1` 时为空 ✓
    pub kappa: Vec<f32>,
}

impl VcSample {
    /// 末端位置换算成 **`svc` 系 mm** ✓ —— **全系统统一用 svc 系** ✓。
    ///
    /// 模型里存的是 `svc` 系**米** ✓（`z` 朝上 ✓），这里只换单位 ✗（不换轴 ✓）。
    /// 前端调用方负责把 `three` 系换算成 `svc` 再传进来 ✓。
    pub fn tip_svc_mm(&self) -> [f64; 3] {
        [
            self.tip_m[0] as f64 * 1000.0,
            self.tip_m[1] as f64 * 1000.0,
            self.tip_m[2] as f64 * 1000.0,
        ]
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VcMeta {
    pub n: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tau_max: Option<f64>,
}

/// **新格式查表** ✓ —— 按末端位置找最近样本 ✓。
#[derive(Debug, Clone)]
pub struct VcTable {
    samples: Vec<VcSample>,
    meta: VcMeta,
}

impl VcTable {
    /// 从各段解析 ✓。`KSB1` / `KKB1` / `META` 都可选 ✓。
    pub fn from_sections(
        ktb: &[u8],
        ptb: &[u8],
        ksb: Option<&[u8]>,
        kkb: Option<&[u8]>,
        meta_raw: Option<&[u8]>,
    ) -> Result<Self, String> {
        let kappa_force: Vec<[f32; KTB_STRIDE]> = read_rows(ktb)?;
        let pose: Vec<[f32; PTB_STRIDE]> = read_rows(ptb)?;

        if kappa_force.len() != pose.len() {
            return Err(format!(
                "行数不一致：KTB1={} PTB1={}",
                kappa_force.len(),
                pose.len()
            ));
        }
        if kappa_force.is_empty() {
            return Err("表是空的".to_string());
        }
        let n = kappa_force.len();

        // 弧长 / 曲率是**每样本一条曲线** ✓，所以按 n 分组 ✓
        let s_rows: Vec<Vec<f32>> = ksb
            .map(|raw| read_nested(raw, n))
            .transpose()?
            .unwrap_or_else(|| vec![Vec::new(); n]);
        let kappa_rows: Vec<Vec<f32>> = kkb
            .map(|raw| read_nested(raw, n))
            .transpose()?
            .unwrap_or_else(|| vec![Vec::new(); n]);

        let mut samples = Vec::with_capacity(n);
        for index in 0..n {
            let kt = kappa_force[index];
            let pp = pose[index];
            let mut tau = [0.0_f32; N_TENDONS];
            let mut dl_mm = [0.0_f32; N_TENDONS];
            tau.copy_from_slice(&kt[0..N_TENDONS]);
            dl_mm.copy_from_slice(&kt[N_TENDONS..KTB_STRIDE]);

            samples.push(VcSample {
                tau,
                dl_mm,
                tip_m: [pp[0], pp[1], pp[2]],
                rot: [
                    pp[3], pp[4], pp[5], pp[6], pp[7], pp[8], pp[9], pp[10], pp[11],
                ],
                s_m: s_rows[index].clone(),
                kappa: kappa_rows[index].clone(),
            });
        }

        let meta = meta_raw
            .and_then(|raw| serde_json::from_slice::<serde_json::Value>(raw).ok())
            .map(|value| VcMeta {
                n,
                tau_max: value.get("tau_max").and_then(|item| item.as_f64()),
            })
            .unwrap_or(VcMeta { n, tau_max: None });

        Ok(Self { samples, meta })
    }

    pub fn len(&self) -> usize {
        self.samples.len()
    }

    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }

    /// 只读访问样本 ✓（摘要统计用 ✓）
    pub fn samples(&self) -> &[VcSample] {
        &self.samples
    }

    pub fn meta(&self) -> &VcMeta {
        &self.meta
    }

    /// **按 6 路位移找最近样本** ✓ —— 3D「使能/实时跟随」用它 ✓。
    ///
    /// 为什么和 `interpolate_by_tip_mm` 不同 ✗：
    ///   那条路是"给目标位置 → 算该下发多少位移"✓；
    ///   这条是**反过来**"已知实际位移 → 反查它对应的形状"✗（要的是**表内真实解** ✓，
    ///   插值会造出表里没有的中间形状 ✗，和实际对不上 ✓）。
    pub fn nearest_by_dl(&self, dl_mm: [f64; 6]) -> Option<(usize, f64)> {
        if self.samples.is_empty() {
            return None;
        }
        // 每根丝的离散度（表内范围）✓ —— 归一化后再算距离 ✓，
        // 否则范围大的那根丝会主导距离 ✗。
        let mut scale = [1.0_f64; 6];
        for axis in 0..6 {
            let mut lo = f64::MAX;
            let mut hi = f64::MIN;
            for sample in &self.samples {
                let value = sample.dl_mm[axis] as f64;
                lo = lo.min(value);
                hi = hi.max(value);
            }
            if hi - lo > 1e-9 {
                scale[axis] = hi - lo;
            }
        }
        let mut best = 0usize;
        let mut best_distance = f64::MAX;
        for (index, sample) in self.samples.iter().enumerate() {
            let mut sum = 0.0;
            for axis in 0..6 {
                let delta = (sample.dl_mm[axis] as f64 - dl_mm[axis]) / scale[axis];
                sum += delta * delta;
            }
            if sum < best_distance {
                best_distance = sum;
                best = index;
            }
        }
        Some((best, best_distance.sqrt()))
    }

    /// **按 6 路位移插值出 12 节点形状** ✓ —— 取最近 4 个样本加权 ✓。
    ///
    /// 为什么必须插值 ✗：只用最近样本时 ✓，样本一换形状就**跳** ✓ →
    /// 使能后 3D 显示**一下一下地抽** ✗（实测 ✓）。
    /// 加权平均后形状**连续变化** ✓。
    pub fn shape_12x2_interpolated(&self, dl_mm: [f64; 6]) -> Option<(Vec<f32>, f64)> {
        const K: usize = 4;
        if self.samples.is_empty() {
            return None;
        }
        let mut scale = [1.0_f64; 6];
        for axis in 0..6 {
            let mut lo = f64::MAX;
            let mut hi = f64::MIN;
            for sample in &self.samples {
                let value = sample.dl_mm[axis] as f64;
                lo = lo.min(value);
                hi = hi.max(value);
            }
            if hi - lo > 1e-9 {
                scale[axis] = hi - lo;
            }
        }

        let mut best: Vec<(usize, f64)> = Vec::with_capacity(K + 1);
        for (index, sample) in self.samples.iter().enumerate() {
            let mut sum = 0.0;
            for axis in 0..6 {
                let delta = (sample.dl_mm[axis] as f64 - dl_mm[axis]) / scale[axis];
                sum += delta * delta;
            }
            let distance = sum.sqrt();
            if best.len() < K {
                best.push((index, distance));
                best.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
            } else if let Some(last) = best.last() {
                if distance < last.1 {
                    best.pop();
                    best.push((index, distance));
                    best.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
                }
            }
        }
        let nearest = best.first().map(|(_, d)| *d)?;

        let mut weights = Vec::with_capacity(best.len());
        let mut total = 0.0_f64;
        for (_, distance) in &best {
            let weight = 1.0 / ((distance + 1.0) * (distance + 1.0));
            weights.push(weight);
            total += weight;
        }

        let mut out = vec![0.0_f32; 24];
        for (slot, (index, _)) in best.iter().enumerate() {
            let shape = self.shape_12x2(*index)?;
            let share = (weights[slot] / total) as f32;
            for at in 0..24 {
                out[at] += shape[at] * share;
            }
        }
        Some((out, nearest))
    }

    /// 某样本的曲率 → **12 节点 × (kx, ky)** ✓（老接口要的格式 ✓）。
    ///
    /// 表里是 **61 节点 × 3**（kx, ky, |κ|）✗，这里按**端点对齐**等距抽 12 个节点 ✓，
    /// 节点间线性插值 ✓。第 3 个分量（|κ|）不用 ✗ —— 老接口自己会 `hypot` ✓。
    pub fn shape_12x2(&self, index: usize) -> Option<Vec<f32>> {
        let sample = self.samples.get(index)?;
        let nodes = sample.kappa.len() / 3;
        if nodes < 2 {
            return None;
        }
        let mut out = Vec::with_capacity(24);
        for slot in 0..12 {
            // 端点对齐：slot=0 → 0 号节点，slot=11 → 最后一个 ✓
            let position = slot as f64 * (nodes - 1) as f64 / 11.0;
            let low = position.floor() as usize;
            let high = (low + 1).min(nodes - 1);
            let t = position - low as f64;
            for axis in 0..2 {
                let a = sample.kappa[low * 3 + axis] as f64;
                let b = sample.kappa[high * 3 + axis] as f64;
                out.push((a + (b - a) * t) as f32);
            }
        }
        Some(out)
    }

    /// **插值查表** ✓ —— 取最近 4 个样本，按距离倒数平方加权 ✓。
    ///
    /// 为什么必须插值 ✗：只用最近样本时 ✓，`dL` 是**阶跃**的 ✓（样本一换就跳 ✓），
    /// 差分出来的速度必然是尖峰 ✗（实测 20mm/s，而实际只有 1mm/s ✗）。
    /// 插值后 `dL` **随位置连续变化** ✓，速度才有物理意义 ✓。
    pub fn interpolate_by_tip_mm(&self, tip_mm: [f64; 3]) -> Option<([f64; 6], f64)> {
        /**
         * **邻居数 4 → 10** ✓
         *
         * 为什么 ✗：只用 4 个邻居时 ✓，"第 4 个"换人权重和会突变 ✗ →
         * `dL` 跳 1.6mm ✗ → 速度算出 20mm/s ✗（实测 ✓）。
         * 10 个邻居把突变摊薄 ✓（每个只占约 10% ✓）→ 跳变降到 ~0.4mm ✓。
         *
         * 代价 ✓：每次查表多 6 次距离计算 ✓ —— 240 点 × 10 = 2400 次 ✓，
         * 微秒级 ✓，完全可以接受 ✓。
         */
        const K: usize = 10;
        let mut best: Vec<(usize, f64)> = Vec::with_capacity(K + 1);
        for (index, sample) in self.samples.iter().enumerate() {
            let actual = sample.tip_svc_mm();
            let dx = actual[0] - tip_mm[0];
            let dy = actual[1] - tip_mm[1];
            let dz = actual[2] - tip_mm[2];
            let distance = (dx * dx + dy * dy + dz * dz).sqrt();
            if best.len() < K {
                best.push((index, distance));
                best.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
            } else if let Some(last) = best.last() {
                if distance < last.1 {
                    best.pop();
                    best.push((index, distance));
                    best.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
                }
            }
        }
        let nearest = best.first().map(|(_, d)| *d)?;

        // 权重 = 1 / (d + 1)²  ✓（+1 避免除零 ✓）
        let mut weights = Vec::with_capacity(best.len());
        let mut total = 0.0_f64;
        for (_, distance) in &best {
            let weight = 1.0 / ((distance + 1.0) * (distance + 1.0));
            weights.push(weight);
            total += weight;
        }

        let mut out = [0.0_f64; 6];
        for (slot, (index, _)) in best.iter().enumerate() {
            let share = weights[slot] / total;
            for axis in 0..6 {
                out[axis] += (self.samples[*index].dl_mm[axis] as f64) * share;
            }
        }
        Some((out, nearest))
    }

    /// **导出轻量索引** ✓ —— 只给前端本地查表用 ✓：尖端位置（svc mm）+ 6 路位移 ✓。
    ///
    /// 只导 `PTB1` 前 3 个数与 `KTB1` 后 6 个数 ✓ → 1031 × 9 个数字 ✓（约 90KB JSON ✓），
    /// 前端加载后在本地做 K 邻域 IDW 反查 ✓ → 拖动 / 位姿下发不再需要 RPC ✓。
    pub fn dump_index(&self) -> Vec<([f64; 3], [f64; 6])> {
        self.samples
            .iter()
            .map(|sample| {
                let tip = sample.tip_svc_mm();
                let mut dl = [0.0_f64; 6];
                for axis in 0..6 {
                    dl[axis] = sample.dl_mm[axis] as f64;
                }
                (tip, dl)
            })
            .collect()
    }

    /// **按末端位置找最近样本** ✓（位置单位 mm ✓）。
    ///
    /// 返回 `(样本, 距离 mm)` ✓ —— 距离用来判断"这个结果可不可信"✓：
    /// 太远说明表里没有附近的点 ✗，调用方应拒绝使用 ✓（显示 `--` 而不是编造值 ✗）。
    pub fn nearest_by_tip_mm(&self, tip_mm: [f64; 3]) -> Option<(&VcSample, f64)> {
        let mut best: Option<(&VcSample, f64)> = None;
        for sample in &self.samples {
            let actual = sample.tip_svc_mm();
            let dx = actual[0] - tip_mm[0];
            let dy = actual[1] - tip_mm[1];
            let dz = actual[2] - tip_mm[2];
            let distance = (dx * dx + dy * dy + dz * dz).sqrt();
            if best.map(|(_, previous)| distance < previous).unwrap_or(true) {
                best = Some((sample, distance));
            }
        }
        best
    }
}

/// 读"`u32 n` + `n × N × f32`"✓。
fn read_rows<const N: usize>(bytes: &[u8]) -> Result<Vec<[f32; N]>, String> {
    if bytes.len() < 4 {
        return Err("段太短".to_string());
    }
    let n = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
    let need = 4 + n * N * 4;
    if bytes.len() < need {
        return Err(format!("段长度不足：需要 {need}，实际 {}", bytes.len()));
    }
    let mut rows = Vec::with_capacity(n);
    for index in 0..n {
        let mut row = [0.0_f32; N];
        let base = 4 + index * N * 4;
        for slot in 0..N {
            let offset = base + slot * 4;
            row[slot] = f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
        }
        rows.push(row);
    }
    Ok(rows)
}

/// 读"`u32 n` + `u32 nodes` + `n × (nodes × comps) × f32`"✓。
///
/// ⚠ 第二个 u32 是**节点数**（61 ✓），**不是每行 f32 的个数** ✗ ——
///   `KKB1` 每行是 `61 × 3 = 183` 个 ✗（曲率矢量有 3 个分量 ✓）。
///   按 61 去读只会取到前 1/3 ✗ → 形状完全错乱 ✓ → 使能后臂体狂抖 ✗（本 bug ✓）。
///
/// 每行宽度从**段长度**反推 ✓（不受分量数影响 ✓）：
///   `KSB1` 251572 → (251572-8)/4/1031 = 61   ✓
///   `KKB1` 754700 → (754700-8)/4/1031 = 183  ✓
fn read_nested(bytes: &[u8], expect_n: usize) -> Result<Vec<Vec<f32>>, String> {
    if bytes.len() < 8 {
        return Err("段太短".to_string());
    }
    let n = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
    if n != expect_n {
        return Err(format!("行数不一致：{n} vs {expect_n}"));
    }
    let total = (bytes.len() - 8) / 4;
    if n == 0 || total % n != 0 {
        return Err(format!("段长度不是整数倍：{total}/{n}"));
    }
    let width = total / n;
    let need = 8 + n * width * 4;
    if bytes.len() < need {
        return Err(format!("段长度不足：需要 {need}，实际 {}", bytes.len()));
    }
    let mut rows = Vec::with_capacity(n);
    for index in 0..n {
        let base = 8 + index * width * 4;
        let mut row = Vec::with_capacity(width);
        for slot in 0..width {
            let offset = base + slot * 4;
            row.push(f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()));
        }
        rows.push(row);
    }
    Ok(rows)
}
