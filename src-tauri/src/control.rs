use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PidConfig {
    pub kp: f64,
    pub ki: f64,
    pub kd: f64,
    pub deadband_deg: f64,
    pub integral_limit: f64,
    pub output_limit: f64,
    pub sample_period_ms: u64,
}

impl Default for PidConfig {
    fn default() -> Self {
        Self {
            kp: 0.35,
            ki: 0.04,
            kd: 0.08,
            deadband_deg: 0.2,
            integral_limit: 30.0,
            output_limit: 8.0,
            sample_period_ms: 50,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CycleLifeConfig {
    pub enabled: bool,
    pub lower_angle_deg: f64,
    pub upper_angle_deg: f64,
    pub tolerance_deg: f64,
    pub dwell_ms: u64,
    pub max_cycles: u32,
}

impl Default for CycleLifeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            lower_angle_deg: 12.0,
            upper_angle_deg: 48.0,
            tolerance_deg: 1.0,
            dwell_ms: 250,
            max_cycles: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CycleLifePhase {
    Idle,
    MovingUpper,
    HoldingUpper,
    MovingLower,
    HoldingLower,
    Complete,
    Stopped,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SafetyInput {
    pub connected: bool,
    pub enabled: bool,
    pub emergency_latched: bool,
    pub playback_mode: bool,
}

impl SafetyInput {
    pub fn allows_control(&self) -> bool {
        self.connected && self.enabled && !self.emergency_latched && !self.playback_mode
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ControlFeedback {
    pub angle_deg: f64,
    pub target_angle_deg: f64,
    pub pressure: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ControlDecision {
    pub active: bool,
    pub allowed: bool,
    pub reason: Option<String>,
    pub phase: CycleLifePhase,
    pub target_angle_deg: f64,
    pub pid_output: f64,
    pub motor_delta_mm: f64,
    pub cycles_completed: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ControlStatus {
    pub pid: PidConfig,
    pub cycle: CycleLifeConfig,
    pub phase: CycleLifePhase,
    pub active: bool,
    pub allowed: bool,
    pub reason: Option<String>,
    pub target_angle_deg: f64,
    pub pid_output: f64,
    pub motor_delta_mm: f64,
    pub cycles_completed: u32,
}

impl Default for ControlStatus {
    fn default() -> Self {
        Self {
            pid: PidConfig::default(),
            cycle: CycleLifeConfig::default(),
            phase: CycleLifePhase::Idle,
            active: false,
            allowed: false,
            reason: Some("cycle life inactive".to_string()),
            target_angle_deg: 0.0,
            pid_output: 0.0,
            motor_delta_mm: 0.0,
            cycles_completed: 0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PidController {
    config: PidConfig,
    integral: f64,
    previous_error: Option<f64>,
}

impl PidController {
    pub fn new(config: PidConfig) -> Self {
        Self {
            config,
            integral: 0.0,
            previous_error: None,
        }
    }

    pub fn config(&self) -> PidConfig {
        self.config
    }

    pub fn update_config(&mut self, config: PidConfig) {
        self.config = config;
        self.reset();
    }

    pub fn reset(&mut self) {
        self.integral = 0.0;
        self.previous_error = None;
    }

    pub fn step(&mut self, error: f64, dt_ms: u64) -> f64 {
        if !error.is_finite() || error.abs() <= self.config.deadband_deg {
            self.reset();
            return 0.0;
        }

        let dt_s = (dt_ms.max(1) as f64) / 1000.0;
        self.integral = (self.integral + error * dt_s)
            .clamp(-self.config.integral_limit, self.config.integral_limit);
        let derivative = self
            .previous_error
            .map(|prev| (error - prev) / dt_s)
            .unwrap_or(0.0);
        self.previous_error = Some(error);

        (self.config.kp * error + self.config.ki * self.integral + self.config.kd * derivative)
            .clamp(-self.config.output_limit, self.config.output_limit)
    }
}

#[derive(Debug, Clone)]
pub struct ControlRuntime {
    pid: PidController,
    cycle: CycleLifeConfig,
    phase: CycleLifePhase,
    active: bool,
    allowed: bool,
    reason: Option<String>,
    target_angle_deg: f64,
    pid_output: f64,
    motor_delta_mm: f64,
    cycles_completed: u32,
    dwell_elapsed_ms: u64,
}

impl Default for ControlRuntime {
    fn default() -> Self {
        Self::new(PidConfig::default(), CycleLifeConfig::default())
    }
}

impl ControlRuntime {
    pub fn new(pid: PidConfig, cycle: CycleLifeConfig) -> Self {
        Self {
            pid: PidController::new(pid),
            cycle,
            phase: CycleLifePhase::Idle,
            active: false,
            allowed: false,
            reason: Some("cycle life inactive".to_string()),
            target_angle_deg: 0.0,
            pid_output: 0.0,
            motor_delta_mm: 0.0,
            cycles_completed: 0,
            dwell_elapsed_ms: 0,
        }
    }

    pub fn status(&self) -> ControlStatus {
        ControlStatus {
            pid: self.pid.config(),
            cycle: self.cycle,
            phase: self.phase,
            active: self.active,
            allowed: self.allowed,
            reason: self.reason.clone(),
            target_angle_deg: self.target_angle_deg,
            pid_output: self.pid_output,
            motor_delta_mm: self.motor_delta_mm,
            cycles_completed: self.cycles_completed,
        }
    }

    pub fn update_pid(&mut self, config: PidConfig) -> ControlStatus {
        self.pid.update_config(config);
        self.status()
    }

    pub fn configure_cycle(&mut self, config: CycleLifeConfig) -> ControlStatus {
        self.cycle = config;
        if !self.cycle.enabled {
            self.stop("cycle life disabled");
        }
        self.status()
    }

    pub fn start_cycle(&mut self, config: Option<CycleLifeConfig>) -> ControlStatus {
        if let Some(config) = config {
            self.cycle = config;
        }
        self.cycle.enabled = true;
        self.phase = CycleLifePhase::MovingUpper;
        self.active = true;
        self.allowed = false;
        self.reason = Some("waiting for safe feedback".to_string());
        self.target_angle_deg = self.cycle.upper_angle_deg;
        self.pid_output = 0.0;
        self.motor_delta_mm = 0.0;
        self.cycles_completed = 0;
        self.dwell_elapsed_ms = 0;
        self.pid.reset();
        self.status()
    }

    pub fn stop(&mut self, reason: impl Into<String>) -> ControlStatus {
        self.active = false;
        self.allowed = false;
        self.reason = Some(reason.into());
        self.phase = CycleLifePhase::Stopped;
        self.pid_output = 0.0;
        self.motor_delta_mm = 0.0;
        self.dwell_elapsed_ms = 0;
        self.pid.reset();
        self.status()
    }

    pub fn step_cycle(
        &mut self,
        feedback: ControlFeedback,
        safety: SafetyInput,
        dt_ms: u64,
    ) -> ControlDecision {
        if !self.active || !self.cycle.enabled {
            self.allowed = false;
            self.reason = Some("cycle life inactive".to_string());
            self.pid_output = 0.0;
            self.motor_delta_mm = 0.0;
            return self.decision();
        }

        if !safety.allows_control() {
            self.stop(safety_reason(safety));
            return self.decision();
        }

        self.allowed = true;
        self.reason = None;
        self.advance_phase(feedback.angle_deg, dt_ms);

        if matches!(self.phase, CycleLifePhase::Complete) {
            self.active = false;
            self.allowed = false;
            self.reason = Some("cycle life complete".to_string());
            self.pid_output = 0.0;
            self.motor_delta_mm = 0.0;
            self.pid.reset();
            return self.decision();
        }

        let error = self.target_angle_deg - feedback.angle_deg;
        self.pid_output = self.pid.step(error, dt_ms);
        self.motor_delta_mm = self.pid_output;
        self.decision()
    }

    fn advance_phase(&mut self, angle_deg: f64, dt_ms: u64) {
        match self.phase {
            CycleLifePhase::MovingUpper => {
                self.target_angle_deg = self.cycle.upper_angle_deg;
                if close_enough(
                    angle_deg,
                    self.cycle.upper_angle_deg,
                    self.cycle.tolerance_deg,
                ) {
                    self.phase = CycleLifePhase::HoldingUpper;
                    self.dwell_elapsed_ms = 0;
                    self.pid.reset();
                }
            }
            CycleLifePhase::HoldingUpper => {
                self.target_angle_deg = self.cycle.upper_angle_deg;
                self.dwell_elapsed_ms = self.dwell_elapsed_ms.saturating_add(dt_ms);
                if self.dwell_elapsed_ms >= self.cycle.dwell_ms {
                    self.phase = CycleLifePhase::MovingLower;
                    self.dwell_elapsed_ms = 0;
                    self.pid.reset();
                }
            }
            CycleLifePhase::MovingLower => {
                self.target_angle_deg = self.cycle.lower_angle_deg;
                if close_enough(
                    angle_deg,
                    self.cycle.lower_angle_deg,
                    self.cycle.tolerance_deg,
                ) {
                    self.phase = CycleLifePhase::HoldingLower;
                    self.dwell_elapsed_ms = 0;
                    self.pid.reset();
                }
            }
            CycleLifePhase::HoldingLower => {
                self.target_angle_deg = self.cycle.lower_angle_deg;
                self.dwell_elapsed_ms = self.dwell_elapsed_ms.saturating_add(dt_ms);
                if self.dwell_elapsed_ms >= self.cycle.dwell_ms {
                    self.cycles_completed = self.cycles_completed.saturating_add(1);
                    if self.cycle.max_cycles > 0 && self.cycles_completed >= self.cycle.max_cycles {
                        self.phase = CycleLifePhase::Complete;
                    } else {
                        self.phase = CycleLifePhase::MovingUpper;
                        self.target_angle_deg = self.cycle.upper_angle_deg;
                    }
                    self.dwell_elapsed_ms = 0;
                    self.pid.reset();
                }
            }
            CycleLifePhase::Idle | CycleLifePhase::Complete | CycleLifePhase::Stopped => {}
        }
    }

    fn decision(&self) -> ControlDecision {
        ControlDecision {
            active: self.active,
            allowed: self.allowed,
            reason: self.reason.clone(),
            phase: self.phase,
            target_angle_deg: self.target_angle_deg,
            pid_output: self.pid_output,
            motor_delta_mm: self.motor_delta_mm,
            cycles_completed: self.cycles_completed,
        }
    }
}

fn close_enough(value: f64, target: f64, tolerance: f64) -> bool {
    (value - target).abs() <= tolerance.abs()
}

fn safety_reason(safety: SafetyInput) -> String {
    if safety.playback_mode {
        "playback mode blocks active control".to_string()
    } else if safety.emergency_latched {
        "emergency stop latched".to_string()
    } else if !safety.connected {
        "device is not connected".to_string()
    } else {
        "device control is not enabled".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn safe() -> SafetyInput {
        SafetyInput {
            connected: true,
            enabled: true,
            emergency_latched: false,
            playback_mode: false,
        }
    }

    #[test]
    fn pid_output_is_limited() {
        let mut pid = PidController::new(PidConfig {
            kp: 10.0,
            output_limit: 3.0,
            ..PidConfig::default()
        });

        assert_eq!(pid.step(5.0, 50), 3.0);
        assert_eq!(pid.step(-5.0, 50), -3.0);
    }

    #[test]
    fn pid_deadband_resets_output() {
        let mut pid = PidController::new(PidConfig {
            deadband_deg: 0.5,
            ..PidConfig::default()
        });

        assert!(pid.step(2.0, 50).abs() > 0.0);
        assert_eq!(pid.step(0.2, 50), 0.0);
    }

    #[test]
    fn unsafe_cycle_stops_immediately() {
        let mut runtime = ControlRuntime::default();
        runtime.start_cycle(Some(CycleLifeConfig::default()));

        let decision = runtime.step_cycle(
            ControlFeedback {
                angle_deg: 10.0,
                target_angle_deg: 48.0,
                pressure: 0.0,
            },
            SafetyInput {
                emergency_latched: true,
                ..safe()
            },
            50,
        );

        assert!(!decision.active);
        assert_eq!(decision.phase, CycleLifePhase::Stopped);
        assert_eq!(decision.reason.as_deref(), Some("emergency stop latched"));
    }

    #[test]
    fn cycle_life_advances_and_completes() {
        let mut runtime = ControlRuntime::default();
        runtime.start_cycle(Some(CycleLifeConfig {
            enabled: true,
            lower_angle_deg: 10.0,
            upper_angle_deg: 20.0,
            tolerance_deg: 0.5,
            dwell_ms: 100,
            max_cycles: 1,
        }));

        let feedback = |angle_deg| ControlFeedback {
            angle_deg,
            target_angle_deg: angle_deg,
            pressure: 0.0,
        };

        assert_eq!(
            runtime.step_cycle(feedback(19.8), safe(), 50).phase,
            CycleLifePhase::HoldingUpper
        );
        assert_eq!(
            runtime.step_cycle(feedback(20.0), safe(), 100).phase,
            CycleLifePhase::MovingLower
        );
        assert_eq!(
            runtime.step_cycle(feedback(10.1), safe(), 50).phase,
            CycleLifePhase::HoldingLower
        );
        let complete = runtime.step_cycle(feedback(10.0), safe(), 100);

        assert_eq!(complete.phase, CycleLifePhase::Complete);
        assert_eq!(complete.cycles_completed, 1);
        assert!(!complete.active);
    }
}
