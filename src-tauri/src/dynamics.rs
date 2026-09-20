use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

// ── Config ──

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DynamicsConfig {
    pub segment_length_m: [f64; 2],
    pub cable_radius_m: f64,
    pub bending_stiffness: f64,
    pub force_base_n: f64,
    pub force_amp_n: [f64; 2],
    pub backbone_points_per_segment: usize,
    pub max_curvature_per_m: [f64; 2],
}

impl Default for DynamicsConfig {
    fn default() -> Self {
        Self {
            segment_length_m: [0.200, 0.200],
            cable_radius_m: 0.006,
            bending_stiffness: 0.2,
            force_base_n: 4.0,
            force_amp_n: [90.0, 55.0],
            backbone_points_per_segment: 60,
            max_curvature_per_m: [85.0_f64.to_radians() / 0.200, 85.0_f64.to_radians() / 0.200],
        }
    }
}

impl DynamicsConfig {
    pub fn segment_count(&self) -> usize {
        2
    }

    pub fn total_length_m(&self) -> f64 {
        self.segment_length_m.iter().sum()
    }

    /// Effective EI per segment = stiffness * length.
    pub fn ei(&self, segment_index: usize) -> f64 {
        self.bending_stiffness
            * self
                .segment_length_m
                .get(segment_index)
                .copied()
                .unwrap_or(0.200)
    }
}

// ── DTOs exposed to Tauri frontend ──

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MotorDynamicsState {
    pub id: u32,
    pub position_mm: f64,
    pub velocity_mm_per_sec: f64,
    pub acceleration_mm_per_sec2: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SensorDynamicsState {
    pub id: u32,
    pub force_n: [f64; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SectionCurvatureState {
    pub curvature_per_m: f64,
    pub direction_deg: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DynamicsInput {
    pub device_id: String,
    pub timestamp_ms: u64,
    pub dt_ms: u64,
    pub motors: Vec<MotorDynamicsState>,
    pub sensors: Vec<SensorDynamicsState>,
    pub sections: Vec<SectionCurvatureState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CurvatureProfile {
    pub s_mm: Vec<f64>,
    pub kx_per_m: Vec<f64>,
    pub ky_per_m: Vec<f64>,
    pub kappa_abs_per_m: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TipPose {
    pub position_m: [f64; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DynamicsDiagnostics {
    pub frame_valid: bool,
    pub max_curvature_per_m: f64,
    pub all_forces_finite: bool,
    pub force_max_n: f64,
    pub input_mode: String,
    pub legacy_angle_derived: bool,
    pub sensor_derived: bool,
    pub motor_derived: bool,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DynamicsOutput {
    pub device_id: String,
    pub timestamp_ms: u64,
    pub sections: Vec<SectionCurvatureState>,
    pub tendon_forces_n: [f64; 6],
    pub curvature: CurvatureProfile,
    pub tip_pose: TipPose,
    pub diagnostics: DynamicsDiagnostics,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DynamicsStatus {
    pub config: DynamicsConfig,
    pub last_output: Option<DynamicsOutput>,
    pub computed_frame_count: u64,
}

// ── Pure computation functions (mirrored from PCCCharts.tsx) ──

/// Cable angular positions on each segment cross-section.
const SEG0_ALPHA: [f64; 3] = [0.0, 2.0 * PI / 3.0, 4.0 * PI / 3.0];
const SEG1_ALPHA: [f64; 3] = [PI / 3.0, PI, 5.0 * PI / 3.0];

/// Map segment 0 cables: indices 0, 2, 4.
/// Map segment 1 cables: indices 1, 3, 5.
fn cable_indices(segment_index: usize) -> [usize; 3] {
    if segment_index == 0 {
        [0, 2, 4]
    } else {
        [1, 3, 5]
    }
}

/// Convert a legacy bend angle to curvature for protocol/history adapters.
pub fn curvature_from_legacy_angle_deg(angle_deg: f64, segment_length_m: f64) -> f64 {
    if !angle_deg.is_finite() || !segment_length_m.is_finite() || segment_length_m <= 0.0 {
        return 0.0;
    }
    angle_deg.to_radians() / segment_length_m
}

/// Convert curvature back to a protocol bend angle at the hardware boundary.
pub fn legacy_angle_deg_from_curvature(curvature_per_m: f64, segment_length_m: f64) -> f64 {
    if !curvature_per_m.is_finite() || !segment_length_m.is_finite() || segment_length_m <= 0.0 {
        return 0.0;
    }
    curvature_per_m * segment_length_m * 180.0 / PI
}


/// Compute per-cable tendon force distribution from section curvature.
pub fn compute_tendon_forces(
    config: &DynamicsConfig,
    curvature_per_m: f64,
    direction_deg: f64,
    segment_index: usize,
) -> [f64; 6] {
    let mut forces = [0.0f64; 6];
    if !curvature_per_m.is_finite() || !direction_deg.is_finite() {
        return forces;
    }

    let idx = cable_indices(segment_index);
    let alphas = if segment_index == 0 { &SEG0_ALPHA } else { &SEG1_ALPHA };
    let dir_rad = direction_deg.to_radians() + if curvature_per_m >= 0.0 { 0.0 } else { PI };
    let max_curvature = config
        .max_curvature_per_m
        .get(segment_index)
        .copied()
        .unwrap_or(config.max_curvature_per_m[0])
        .abs()
        .max(1e-9);
    let magnitude = (curvature_per_m.abs() / max_curvature).clamp(0.0, 1.0);
    let amp = config.force_amp_n.get(segment_index).copied().unwrap_or(config.force_amp_n[0]);

    for j in 0..3 {
        let wi = idx[j];
        forces[wi] = config.force_base_n + amp * magnitude * (0.5 + 0.5 * (alphas[j] - dir_rad).cos());
    }

    forces
}

/// Compute both sections' tendon forces and merge into a single 6-element array.
pub fn compute_tendon_forces_dual(
    config: &DynamicsConfig,
    sections: &[SectionCurvatureState],
) -> [f64; 6] {
    let zero = SectionCurvatureState { curvature_per_m: 0.0, direction_deg: 0.0 };
    let s0_ref = sections.get(0).unwrap_or(&zero);
    let s1_default = SectionCurvatureState { curvature_per_m: 0.0, direction_deg: 60.0 };
    let s1_ref = sections.get(1).unwrap_or(&s1_default);
    let mut forces = [0.0f64; 6];
    let f0 = compute_tendon_forces(config, s0_ref.curvature_per_m, s0_ref.direction_deg, 0);
    let f1 = compute_tendon_forces(config, s1_ref.curvature_per_m, s1_ref.direction_deg, 1);
    for i in 0..6 {
        forces[i] = f0[i] + f1[i];
    }
    forces
}

/// PCC pose for a constant-curvature segment at arc-length `s`.
///
/// * `theta` — total bend angle of the segment (rad).
/// * `phi` — bending plane angle (rad).
/// * `segment_length` — length of the segment (m).
/// * `s` — arc-length position within the segment (m).
/// Returns [x, y, z] in the segment's local frame (m).
pub fn pcc_pose(
    theta: f64,
    phi: f64,
    segment_length: f64,
    s: f64,
) -> [f64; 3] {
    if !theta.is_finite() || !phi.is_finite() || segment_length <= 0.0 {
        return [0.0, 0.0, s];
    }
    let kappa = theta / segment_length;
    if kappa.abs() < 1e-12 || theta.abs() < 1e-12 {
        return [0.0, 0.0, s];
    }
    let r = 1.0 / kappa;
    let x = r * (1.0 - (kappa * s).cos()) * phi.cos();
    let y = r * (1.0 - (kappa * s).cos()) * phi.sin();
    let z = r * (kappa * s).sin();
    [x, y, z]
}

fn mat_mul_4(h: &[[f64; 4]; 4], v: &[f64; 4]) -> [f64; 4] {
    let mut r = [0.0; 4];
    for i in 0..4 {
        r[i] = h[i][0] * v[0] + h[i][1] * v[1] + h[i][2] * v[2] + h[i][3] * v[3];
    }
    r
}

/// Segment homogeneous transform for a constant-curvature micro-step.
fn segment_h_matrix(theta: f64, phi: f64, seg_len: f64, sub_steps: usize) -> [[f64; 4]; 4] {
    let ds = seg_len / sub_steps as f64;
    let kappa = if theta.abs() < 1e-12 { 0.0 } else { theta / seg_len };
    let k_ds = kappa * ds;

    let mut sum_sin = 0.0;
    let mut sum_cos = 0.0;
    for j in 1..=sub_steps {
        sum_sin += (j as f64 * k_ds).sin();
        sum_cos += (j as f64 * k_ds).cos();
    }
    let cp = phi.cos();
    let sp = phi.sin();
    let cth = theta.cos();
    let sth = theta.sin();

    let rot: [[f64; 3]; 3] = [
        [cp * cp * (cth - 1.0) + 1.0, sp * cp * (cth - 1.0), cp * sth],
        [sp * cp * (cth - 1.0), cp * cp * (1.0 - cth) + cth, sp * sth],
        [-cp * sth, -sp * sth, cth],
    ];
    let p = [ds * sum_sin * cp, ds * sum_sin * sp, ds * sum_cos];

    let mut h = [[0.0; 4]; 4];
    for i in 0..3 {
        for j in 0..3 {
            h[i][j] = rot[i][j];
        }
        h[i][3] = p[i];
    }
    h[3][3] = 1.0;
    h
}

/// Build the full backbone (discrete points + curvature series) from section curvature inputs.
///
/// Uses variable-curvature blending between segments (same approach as PCCCharts.tsx).
pub fn build_backbone(
    config: &DynamicsConfig,
    sections: &[SectionCurvatureState],
) -> (CurvatureProfile, TipPose) {
    let forces = compute_tendon_forces_dual(config, sections);
    let ei0 = config.ei(0);

    // Helper: compute moment from cable forces on a given segment.
    fn add_moment(
        forces: &[f64; 6],
        idx: [usize; 3],
        alphas: &[f64; 3],
        cable_radius: f64,
    ) -> (f64, f64) {
        let mut mx = 0.0;
        let mut my = 0.0;
        for j in 0..3 {
            let f = forces[idx[j]].max(0.0);
            mx += cable_radius * f * (-alphas[j].sin());
            my += cable_radius * f * alphas[j].cos();
        }
        (mx, my)
    }
    let (mx0, my0) = add_moment(&forces, cable_indices(0), &SEG0_ALPHA, config.cable_radius_m);
    let (mx1, my1) = add_moment(&forces, cable_indices(1), &SEG1_ALPHA, config.cable_radius_m);

    let total_pts = config.segment_count() * config.backbone_points_per_segment;
    let ds = config.total_length_m() / total_pts as f64;

    let mut pts: Vec<[f64; 3]> = Vec::with_capacity(total_pts + 1);
    let mut s_vals: Vec<f64> = Vec::with_capacity(total_pts + 1);
    let mut kx_vals: Vec<f64> = Vec::with_capacity(total_pts + 1);
    let mut ky_vals: Vec<f64> = Vec::with_capacity(total_pts + 1);

    pts.push([0.0, 0.0, 0.0]);
    s_vals.push(0.0);
    kx_vals.push(0.0);
    ky_vals.push(0.0);

    let mut h_curr = [[0.0f64; 4]; 4];
    h_curr[0][0] = 1.0;
    h_curr[1][1] = 1.0;
    h_curr[2][2] = 1.0;
    h_curr[3][3] = 1.0;

    let seg0_len = config.segment_length_m[0];
    let seg1_len = config.segment_length_m[1];
    let n_pts_per_seg = config.backbone_points_per_segment;

    for i in 0..total_pts {
        let seg = i / n_pts_per_seg;
        let j = i - seg * n_pts_per_seg + 1; // 1..n_pts_per_seg
        let s_local = (j as f64 / n_pts_per_seg as f64)
            * if seg == 0 { seg0_len } else { seg1_len };
        let s_abs = if seg == 0 { s_local } else { seg0_len + s_local };

        // Variable curvature blending (same PCCCharts.tsx logic)
        let t_seg = s_local / (if seg == 0 { seg0_len } else { seg1_len }); // 0→1 within segment
        let (wx, wy) = if seg == 0 {
            let wx = (mx0 + mx1 * t_seg) / ei0;
            let wy = (my0 + my1 * t_seg) / ei0;
            (wx, wy)
        } else {
            let w = 1.0 - t_seg;
            let wx = (mx0 * w + mx1) / ei0;
            let wy = (my0 * w + my1) / ei0;
            (wx, wy)
        };

        let km = wx.hypot(wy);
        let phi = (-wx).atan2(wy);
        let theta_step = km * ds;

        let local_p = pcc_pose(theta_step, phi, ds, ds);
        let global_p = mat_mul_4(&h_curr, &[local_p[0], local_p[1], local_p[2], 1.0]);
        pts.push([global_p[0], global_p[1], global_p[2]]);
        s_vals.push(s_abs);
        kx_vals.push(wx);
        ky_vals.push(wy);

        // Accumulate micro transform for this sub-step.
        let micro_h = segment_h_matrix(theta_step, phi, ds, 5);
        let mut new_h = [[0.0; 4]; 4];
        for r in 0..4 {
            for c in 0..4 {
                for k in 0..4 {
                    new_h[r][c] += h_curr[r][k] * micro_h[k][c];
                }
            }
        }
        h_curr = new_h;
    }

    let kappa_abs: Vec<f64> = kx_vals
        .iter()
        .zip(ky_vals.iter())
        .map(|(kx, ky)| kx.hypot(*ky))
        .collect();
    let s_mm: Vec<f64> = s_vals.iter().map(|s| s * 1000.0).collect();

    let tip = pts.last().copied().unwrap_or([0.0, 0.0, 0.0]);
    let tip_pose = TipPose {
        position_m: [tip[0], tip[1], tip[2]],
    };
    let curvature = CurvatureProfile {
        s_mm,
        kx_per_m: kx_vals,
        ky_per_m: ky_vals,
        kappa_abs_per_m: kappa_abs,
    };

    (curvature, tip_pose)
}

/// Build dynamics diagnostics from an output and input.
fn build_diagnostics(
    curvature: &CurvatureProfile,
    tendon_forces_n: &[f64; 6],
    input: &DynamicsInput,
    source: &str,
    sensor_valid: bool,
    motor_valid: bool,
) -> DynamicsDiagnostics {
    let max_kappa = curvature
        .kappa_abs_per_m
        .iter()
        .cloned()
        .fold(0.0_f64, f64::max);
    let all_forces_finite = tendon_forces_n.iter().all(|f| f.is_finite());
    let force_max = tendon_forces_n
        .iter()
        .cloned()
        .fold(0.0_f64, f64::max);
    DynamicsDiagnostics {
        frame_valid: input.dt_ms > 0 && !input.device_id.is_empty(),
        max_curvature_per_m: max_kappa,
        all_forces_finite,
        force_max_n: force_max,
        input_mode: if source == "legacyBendFallback" {
            "legacyAngleDerived".to_string()
        } else {
            "sensorMotorDerived".to_string()
        },
        legacy_angle_derived: source == "legacyBendFallback",
        sensor_derived: sensor_valid,
        motor_derived: motor_valid,
        source: source.to_string(),
    }
}

// ── SDM derivation from pressure sensors and motor displacements ──

const GROUP_A_CABLES: [usize; 3] = [0, 2, 4];
const GROUP_B_CABLES: [usize; 3] = [1, 3, 5];
const GROUP_A_ALPHAS: [f64; 3] = [0.0, 2.0 * PI / 3.0, 4.0 * PI / 3.0];
const GROUP_B_ALPHAS: [f64; 3] = [PI / 3.0, PI, 5.0 * PI / 3.0];

fn sensor_value(input: &DynamicsInput, sensor_id: u32, axis: usize) -> Option<f64> {
    input
        .sensors
        .iter()
        .find(|s| s.id == sensor_id)
        .and_then(|s| s.force_n.get(axis).copied())
        .filter(|v| v.is_finite())
}

fn motor_position(input: &DynamicsInput, motor_id: u32) -> Option<f64> {
    input
        .motors
        .iter()
        .find(|m| m.id == motor_id)
        .map(|m| m.position_mm)
        .filter(|v| v.is_finite())
}

/// Extract per-cable tendon forces from sensors (sensor id i maps to cable i-1, axis 0).
pub(crate) fn derive_tendon_forces_from_sensors(input: &DynamicsInput) -> ([f64; 6], usize) {
    let mut forces = [0.0f64; 6];
    let mut present = 0usize;
    for (cable_index, entry) in forces.iter_mut().enumerate() {
        if let Some(value) = sensor_value(input, (cable_index + 1) as u32, 0) {
            *entry = value.max(0.0);
            present += 1;
        }
    }
    (forces, present)
}

/// Extract per-cable displacements from motor positions (motor id i maps to cable i-1).
pub(crate) fn derive_cable_displacements_from_motors(input: &DynamicsInput) -> ([f64; 6], usize) {
    let mut displacements = [0.0f64; 6];
    let mut present = 0usize;
    for (cable_index, entry) in displacements.iter_mut().enumerate() {
        if let Some(value) = motor_position(input, (cable_index + 1) as u32) {
            *entry = value;
            present += 1;
        }
    }
    (displacements, present)
}

fn moment_from_three(forces: &[f64; 3], alphas: &[f64; 3], radius: f64) -> (f64, f64) {
    let mut mx = 0.0;
    let mut my = 0.0;
    for i in 0..3 {
        mx += radius * forces[i] * -alphas[i].sin();
        my += radius * forces[i] * alphas[i].cos();
    }
    (mx, my)
}

/// Fuse tendon-force estimate and motor-displacement estimate into per-sample curvature.
pub(crate) fn derive_fused_curvature(
    config: &DynamicsConfig,
    input: &DynamicsInput,
) -> (CurvatureProfile, [f64; 6], [f64; 6], String, bool, bool) {
    let (sensor_forces, sensor_count) = derive_tendon_forces_from_sensors(input);
    let (displacements, motor_count) = derive_cable_displacements_from_motors(input);
    let sensor_valid = sensor_count >= 3 && sensor_forces.iter().any(|f| *f > 0.0);
    let motor_valid = motor_count >= 3;
    let source = if sensor_valid && motor_valid {
        "sensorMotorFusion"
    } else if sensor_valid {
        "forceOnly"
    } else if motor_valid {
        "motorOnly"
    } else {
        "legacyBendFallback"
    };
    let mut curvature = build_backbone(config, &input.sections).0;
    if source != "legacyBendFallback" {
        let group_count = config.segment_count();
        let n_per_group = config.backbone_points_per_segment;
        let kx_vals = curvature.kx_per_m.clone();
        let ky_vals = curvature.ky_per_m.clone();
        let mut fused_kx = kx_vals;
        let mut fused_ky = ky_vals;
        for i in 0..(config.segment_count() * config.backbone_points_per_segment + 1) {
            let group = (i / n_per_group).min(group_count - 1);
            let local = (i % n_per_group) as f64 / n_per_group as f64;
            let cables = if group == 0 { &GROUP_A_CABLES } else { &GROUP_B_CABLES };
            let alphas = if group == 0 { &GROUP_A_ALPHAS } else { &GROUP_B_ALPHAS };
            let mut forces3 = [0.0f64; 3];
            for j in 0..3 {
                forces3[j] = sensor_forces[cables[j]].max(0.0);
            }
            let (mx, my) = moment_from_three(&forces3, alphas, config.cable_radius_m);
            let ei = config.ei(group);
            let force_kx = (mx / ei) * (1.0 - local);
            let force_ky = (my / ei) * (1.0 - local);

            let mut disp3 = [0.0f64; 3];
            for j in 0..3 {
                disp3[j] = displacements[cables[j]];
            }
            let mean = (disp3[0] + disp3[1] + disp3[2]) / 3.0;
            let c: [f64; 3] = [disp3[0] - mean, disp3[1] - mean, disp3[2] - mean];
            let mut a = 0.0;
            let mut b = 0.0;
            for j in 0..3 {
                a += c[j] * alphas[j].cos();
                b += c[j] * alphas[j].sin();
            }
            a *= 2.0 / 3.0;
            b *= 2.0 / 3.0;
            let rho_mm = a.hypot(b);
            let phi = b.atan2(a);
            let seg_len = config.segment_length_m[group];
            let kappa = rho_mm / (config.cable_radius_m * seg_len);
            let motor_kx = -kappa * phi.sin();
            let motor_ky = kappa * phi.cos();

            let (wf, wd) = if source == "forceOnly" { (1.0, 0.0) } else if source == "motorOnly" { (0.0, 1.0) } else { (0.35, 0.65) };
            let sum = wf + wd;
            fused_kx[i] = (wf * force_kx + wd * motor_kx) / sum;
            fused_ky[i] = (wf * force_ky + wd * motor_ky) / sum;
        }
        curvature.kx_per_m = fused_kx;
        curvature.ky_per_m = fused_ky;
        curvature.kappa_abs_per_m = curvature
            .kx_per_m
            .iter()
            .zip(curvature.ky_per_m.iter())
            .map(|(kx, ky)| kx.hypot(*ky))
            .collect();
    }

    (
        curvature,
        sensor_forces,
        displacements,
        source.to_string(),
        sensor_valid,
        motor_valid,
    )
}

/// Integrate a curvature profile into a tip pose.
pub(crate) fn integrate_backbone_from_profile(curvature: &CurvatureProfile) -> [f64; 3] {
    if curvature.s_mm.len() < 2 {
        return [0.0, 0.0, 0.0];
    }
    let mut h_curr = [[0.0f64; 4]; 4];
    h_curr[0][0] = 1.0;
    h_curr[1][1] = 1.0;
    h_curr[2][2] = 1.0;
    h_curr[3][3] = 1.0;
    let mut tip = [0.0f64; 3];
    for i in 1..curvature.s_mm.len() {
        let ds_m = (curvature.s_mm[i] - curvature.s_mm[i - 1]).max(1e-9) / 1000.0;
        let km = curvature.kappa_abs_per_m[i].max(0.0);
        let phi = (-curvature.kx_per_m[i]).atan2(curvature.ky_per_m[i]);
        let theta_step = km * ds_m;
        let local_p = pcc_pose(theta_step, phi, ds_m, ds_m);
        let global_p = mat_mul_4(&h_curr, &[local_p[0], local_p[1], local_p[2], 1.0]);
        tip = [global_p[0], global_p[1], global_p[2]];
        let micro_h = segment_h_matrix(theta_step, phi, ds_m, 5);
        let mut new_h = [[0.0; 4]; 4];
        for r in 0..4 {
            for c in 0..4 {
                for k in 0..4 {
                    new_h[r][c] += h_curr[r][k] * micro_h[k][c];
                }
            }
        }
        h_curr = new_h;
    }
    tip
}

/// Convert a `crate::DeviceSnapshot` into a `DynamicsInput`.
pub(crate) fn dynamics_input_from_frame(
    frame: &crate::DeviceSnapshot,
    dt_ms: u64,
) -> DynamicsInput {
    let motors: Vec<MotorDynamicsState> = frame
        .motors
        .iter()
        .map(|m| MotorDynamicsState {
            id: m.id,
            position_mm: m.position_mm,
            velocity_mm_per_sec: m.velocity_mm_per_sec,
            acceleration_mm_per_sec2: m.acceleration_mm_per_sec2,
        })
        .collect();

    let sensors: Vec<SensorDynamicsState> = frame
        .sensors
        .iter()
        .map(|s| SensorDynamicsState {
            id: s.id,
            force_n: s.filtered,
        })
        .collect();

    let dir_to_deg = |dir: &str| -> f64 {
        match dir {
            "up" => 0.0,
            "right" => 90.0,
            "down" => 180.0,
            "left" => 270.0,
            _ => 0.0,
        }
    };

    let sections = vec![
        SectionCurvatureState {
            curvature_per_m: curvature_from_legacy_angle_deg(frame.bend.section1.angle_deg, DynamicsConfig::default().segment_length_m[0]),
            direction_deg: dir_to_deg(&frame.bend.section1.direction),
        },
        SectionCurvatureState {
            curvature_per_m: curvature_from_legacy_angle_deg(frame.bend.section2.angle_deg, DynamicsConfig::default().segment_length_m[1]),
            direction_deg: dir_to_deg(&frame.bend.section2.direction),
        },
    ];

    DynamicsInput {
        device_id: frame.device_id.clone(),
        timestamp_ms: frame.received_at_ms,
        dt_ms,
        motors,
        sensors,
        sections,
    }
}

// ── Runtime ──

#[derive(Debug, Clone)]
pub struct DynamicsRuntime {
    config: DynamicsConfig,
    last_output: Option<DynamicsOutput>,
    computed_frame_count: u64,
}

impl Default for DynamicsRuntime {
    fn default() -> Self {
        Self {
            config: DynamicsConfig::default(),
            last_output: None,
            computed_frame_count: 0,
        }
    }
}

impl DynamicsRuntime {
    pub fn status(&self) -> DynamicsStatus {
        DynamicsStatus {
            config: self.config.clone(),
            last_output: self.last_output.clone(),
            computed_frame_count: self.computed_frame_count,
        }
    }

    pub fn update_config(
        &mut self,
        config: DynamicsConfig,
    ) -> Result<DynamicsStatus, String> {
        // Validate config.
        if config.backbone_points_per_segment < 2 {
            return Err("backbone_points_per_segment must be >= 2".to_string());
        }
        if config.segment_length_m.iter().any(|l| *l <= 0.0) {
            return Err("segment_length_m must be positive".to_string());
        }
        if config.cable_radius_m <= 0.0 {
            return Err("cable_radius_m must be positive".to_string());
        }
        if config.max_curvature_per_m.iter().any(|k| !k.is_finite() || *k <= 0.0) {
            return Err("max_curvature_per_m must be positive and finite".to_string());
        }
        self.config = config;
        // Force re-computation on next step.
        self.last_output = None;
        Ok(self.status())
    }

    pub fn reset(&mut self) -> DynamicsStatus {
        self.last_output = None;
        self.computed_frame_count = 0;
        self.status()
    }

    pub(crate) fn step_frame(
        &mut self,
        frame: &crate::DeviceSnapshot,
        dt_ms: u64,
    ) -> Result<DynamicsOutput, String> {
        let input = dynamics_input_from_frame(frame, dt_ms);

        if input.sections.len() < 2 {
            return Err("DynamicsInput requires at least 2 sections".to_string());
        }

        // SDM derivation prefers pressure sensors + motor displacements; falls back to legacy bend.
        let (curvature, measured_forces, _displacements, source, sensor_valid, motor_valid) =
            derive_fused_curvature(&self.config, &input);

        let tip_position = integrate_backbone_from_profile(&curvature);
        let tip_pose = TipPose { position_m: tip_position };
        let forces = measured_forces;

        let sections = input.sections.clone();
        let diagnostics = build_diagnostics(&curvature, &forces, &input, &source, sensor_valid, motor_valid);

        let output = DynamicsOutput {
            device_id: input.device_id.clone(),
            timestamp_ms: input.timestamp_ms,
            sections,
            tendon_forces_n: forces,
            curvature,
            tip_pose,
            diagnostics,
        };

        self.last_output = Some(output.clone());
        self.computed_frame_count = self.computed_frame_count.saturating_add(1);
        Ok(output)
    }
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BendSnapshot, BendState, DeviceSnapshot, FrameQuality, FrameStatus, MotorState, SensorState};

    fn dummy_frame(angle1_deg: f64, angle2_deg: f64) -> DeviceSnapshot {
        DeviceSnapshot {
            device_id: "dynamics-test".to_string(),
            connection_id: String::new(),
            received_at_ms: 1_000_000,
            sequence: 1,
            protocol_version: "Test".to_string(),
            system_enabled: true,
            motors: (1..=6)
                .map(|i| MotorState {
                    id: i,
                    position_mm: i as f64 * 2.0,
                    velocity_mm_per_sec: 0.0,
                    acceleration_mm_per_sec2: 0.0,
                    running: true,
                    target_position_mm: i as f64 * 2.0,
                })
                .collect(),
            sensors: (1..=6)
                .map(|i| SensorState {
                    id: i,
                    raw: [i as f64, 0.0, 0.0],
                    filtered: [i as f64, 0.0, 0.0],
                    alias: ["X".into(), "Y".into(), "Z".into()],
                    unit: "N".into(),
                    quality: FrameQuality::Ok,
                })
                .collect(),
            bend: BendSnapshot {
                section1: BendState {
                    angle_deg: angle1_deg,
                    target_angle_deg: angle1_deg,
                    direction: "up".into(),
                    quality: FrameQuality::Ok,
                },
                section2: BendState {
                    angle_deg: angle2_deg,
                    target_angle_deg: angle2_deg,
                    direction: "right".into(),
                    quality: FrameQuality::Ok,
                },
            },
            quality: FrameStatus {
                status: FrameQuality::Ok,
                latency_ms: 0,
                dropped_frames: 0,
                checksum_ok: true,
            },
        }
    }

    #[test]
    fn default_config_matches_pcc_constants() {
        let config = DynamicsConfig::default();
        assert!((config.segment_length_m[0] - 0.200).abs() < 1e-9);
        assert!((config.cable_radius_m - 0.006).abs() < 1e-9);
        assert!((config.bending_stiffness - 0.2).abs() < 1e-9);
        assert!((config.force_base_n - 4.0).abs() < 1e-9);
        assert!((config.force_amp_n[0] - 90.0).abs() < 1e-9);
        assert!((config.force_amp_n[1] - 55.0).abs() < 1e-9);
        assert_eq!(config.backbone_points_per_segment, 60);
        assert!((config.max_curvature_per_m[0] - 85.0_f64.to_radians() / 0.200).abs() < 1e-9);
    }

    #[test]
    fn compute_tendon_forces_zero_curvature_returns_base() {
        let config = DynamicsConfig::default();
        let forces_s0 = compute_tendon_forces(&config, 0.0, 0.0, 0);
        let forces_s1 = compute_tendon_forces(&config, 0.0, 0.0, 1);

        // Segment 0 cables (0,2,4) should be base force.
        assert!((forces_s0[0] - config.force_base_n).abs() < 1e-9);
        assert!((forces_s0[2] - config.force_base_n).abs() < 1e-9);
        assert!((forces_s0[4] - config.force_base_n).abs() < 1e-9);
        // Segment 1 cables (1,3,5) should be base force.
        assert!((forces_s1[1] - config.force_base_n).abs() < 1e-9);
        assert!((forces_s1[3] - config.force_base_n).abs() < 1e-9);
        assert!((forces_s1[5] - config.force_base_n).abs() < 1e-9);
        // Non-assigned cables should be zero.
        assert!((forces_s0[1] - 0.0).abs() < 1e-9);
        assert!((forces_s1[0] - 0.0).abs() < 1e-9);
    }

    #[test]
    fn positive_segment_0_curvature_loads_cable_0_more_than_cable_2() {
        let config = DynamicsConfig::default();
        let forces = compute_tendon_forces(&config, curvature_from_legacy_angle_deg(60.0, config.segment_length_m[0]), 0.0, 0);
        // Cable 0 (index 0) at alpha=0, direction=0 → cos(0)=1 → max.
        // Cable 2 (index 2) at alpha=2PI/3, direction=0 → cos(2PI/3)=-0.5 → less.
        assert!(
            forces[0] > forces[2],
            "cable 0 force {} should exceed cable 2 force {}",
            forces[0],
            forces[2]
        );
        // But both should be > base.
        assert!(forces[0] > config.force_base_n);
        assert!(forces[2] > config.force_base_n);
    }

    #[test]
    fn tendon_forces_non_finite_input_is_safe() {
        let config = DynamicsConfig::default();
        let forces = compute_tendon_forces(&config, f64::NAN, 0.0, 0);
        assert!(forces.iter().all(|f| *f == 0.0));

        let forces2 = compute_tendon_forces(&config, curvature_from_legacy_angle_deg(30.0, config.segment_length_m[1]), f64::INFINITY, 1);
        assert!(forces2.iter().all(|f| *f == 0.0));
    }

    #[test]
    fn pcc_pose_straight_gives_z_only() {
        let pose = pcc_pose(0.0, 0.0, 0.200, 0.100);
        assert!((pose[0]).abs() < 1e-9);
        assert!((pose[1]).abs() < 1e-9);
        assert!((pose[2] - 0.100).abs() < 1e-9);
    }

    #[test]
    fn pcc_pose_bent_gives_non_zero_xy() {
        let pose = pcc_pose(PI / 4.0, 0.0, 0.200, 0.200);
        // Tip should be non-zero in x and z.
        assert!(pose[0].abs() > 0.0, "bent should have x displacement");
        assert!(pose[2].abs() > 0.0, "bent should have z displacement");
        // All values should be finite.
        assert!(pose[0].is_finite());
        assert!(pose[1].is_finite());
        assert!(pose[2].is_finite());
    }

    #[test]
    fn build_backbone_output_length() {
        let config = DynamicsConfig::default();
        let sections = vec![
            SectionCurvatureState { curvature_per_m: curvature_from_legacy_angle_deg(30.0, config.segment_length_m[0]), direction_deg: 0.0 },
            SectionCurvatureState { curvature_per_m: curvature_from_legacy_angle_deg(20.0, config.segment_length_m[1]), direction_deg: 60.0 },
        ];
        let (curvature, tip) = build_backbone(&config, &sections);

        let expected_len = 2 * config.backbone_points_per_segment + 1;
        assert_eq!(
            curvature.s_mm.len(),
            expected_len,
            "s_mm length matches backbone points"
        );
        assert_eq!(
            curvature.kx_per_m.len(),
            expected_len,
            "kx length matches"
        );
        assert_eq!(
            curvature.ky_per_m.len(),
            expected_len,
            "ky length matches"
        );

        // Final s_mm should be approximately total length in mm.
        let total_m = config.total_length_m();
        let last_s = curvature.s_mm.last().copied().unwrap_or(0.0);
        assert!(
            (last_s - total_m * 1000.0).abs() < 1.0,
            "last s_mm {} ≈ total mm {}",
            last_s,
            total_m * 1000.0
        );

        // Tip position should be finite.
        assert!(tip.position_m[0].is_finite());
        assert!(tip.position_m[1].is_finite());
        assert!(tip.position_m[2].is_finite());
    }

    #[test]
    fn build_backbone_zero_bend_gives_straight_line() {
        let config = DynamicsConfig::default();
        let sections = vec![
            SectionCurvatureState { curvature_per_m: 0.0, direction_deg: 0.0 },
            SectionCurvatureState { curvature_per_m: 0.0, direction_deg: 0.0 },
        ];
        let (curvature, tip) = build_backbone(&config, &sections);

        // Tip should be roughly at [0, 0, total_length_m].
        let total_m = config.total_length_m();
        assert!(
            (tip.position_m[2] - total_m).abs() < 0.01,
            "straight tip z ≈ {}m, got {}",
            total_m,
            tip.position_m[2]
        );
        assert!(
            tip.position_m[0].abs() < 0.01,
            "straight tip x ≈ 0, got {}",
            tip.position_m[0]
        );
        assert!(
            tip.position_m[1].abs() < 0.01,
            "straight tip y ≈ 0, got {}",
            tip.position_m[1]
        );

        // Maximum curvature should be very small when un-bent.
        let max_k = curvature
            .kappa_abs_per_m
            .iter()
            .cloned()
            .fold(0.0_f64, f64::max);
        assert!(max_k < 1.0, "max curvature for straight backbone: {}", max_k);
    }

    #[test]
    fn dynamics_input_from_frame_converts_correctly() {
        let frame = dummy_frame(15.0, 25.0);
        let input = dynamics_input_from_frame(&frame, 50);

        assert_eq!(input.device_id, "dynamics-test");
        assert_eq!(input.dt_ms, 50);
        assert_eq!(input.motors.len(), 6);
        assert_eq!(input.sensors.len(), 6);
        assert_eq!(input.sections.len(), 2);
        assert!((input.sections[0].curvature_per_m - curvature_from_legacy_angle_deg(15.0, DynamicsConfig::default().segment_length_m[0])).abs() < 1e-9);
        assert!((input.sections[1].curvature_per_m - curvature_from_legacy_angle_deg(25.0, DynamicsConfig::default().segment_length_m[1])).abs() < 1e-9);
        assert!((input.sections[0].direction_deg - 0.0).abs() < 1e-9);
        assert!((input.sections[1].direction_deg - 90.0).abs() < 1e-9);
    }

    #[test]
    fn runtime_step_frame_updates_last_output() {
        let mut runtime = DynamicsRuntime::default();
        assert!(runtime.last_output.is_none());
        assert_eq!(runtime.status().computed_frame_count, 0);

        let frame = dummy_frame(30.0, 10.0);
        let output = runtime.step_frame(&frame, 50).expect("step should succeed");

        assert_eq!(output.device_id, "dynamics-test");
        assert!(output.tendon_forces_n.iter().all(|f| f.is_finite()));
        assert!(!output.curvature.s_mm.is_empty());
        assert!(output.diagnostics.frame_valid);

        let status = runtime.status();
        assert!(status.last_output.is_some());
        assert_eq!(status.computed_frame_count, 1);

        // Second step.
        let _ = runtime.step_frame(&frame, 50).expect("second step");
        assert_eq!(runtime.status().computed_frame_count, 2);
    }

    #[test]
    fn runtime_reset_clears_output() {
        let mut runtime = DynamicsRuntime::default();
        let frame = dummy_frame(10.0, 10.0);
        let _ = runtime.step_frame(&frame, 50);
        assert!(runtime.last_output.is_some());

        runtime.reset();
        assert!(runtime.last_output.is_none());
        assert_eq!(runtime.computed_frame_count, 0);
    }

    #[test]
    fn runtime_update_config_validation_rejects_bad_params() {
        let mut runtime = DynamicsRuntime::default();

        let mut bad_config = DynamicsConfig::default();
        bad_config.backbone_points_per_segment = 1;
        assert!(runtime.update_config(bad_config).is_err());

        let mut bad_cable = DynamicsConfig::default();
        bad_cable.cable_radius_m = -1.0;
        assert!(runtime.update_config(bad_cable).is_err());

        let mut bad_seg = DynamicsConfig::default();
        bad_seg.segment_length_m[0] = 0.0;
        assert!(runtime.update_config(bad_seg).is_err());
    }

    #[test]
    fn runtime_config_update_applies() {
        let mut runtime = DynamicsRuntime::default();
        let mut new_config = DynamicsConfig::default();
        new_config.force_base_n = 8.0;

        let status = runtime
            .update_config(new_config.clone())
            .expect("valid config should be accepted");
        assert!((status.config.force_base_n - 8.0).abs() < 1e-9);

        // Subsequent computation should use new config.
        let frame = dummy_frame(30.0, 20.0);
        let output = runtime.step_frame(&frame, 50).expect("step");
        // All forces should be at least 8N base.
        assert!(output.tendon_forces_n[0] >= 8.0);
    }
}
