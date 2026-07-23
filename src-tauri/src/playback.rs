use crate::session;
use crate::DeviceSnapshot;
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStatus {
    pub active: bool,
    pub session_id: String,
    pub playing: bool,
    pub speed: f64,
    pub cursor_ms: u64,
    pub duration_ms: u64,
    pub cursor_pct: f64,
    pub total_frames: usize,
    pub current_frame_idx: usize,
}

pub struct PlaybackEngine {
    active: bool,
    session_id: String,
    frames: Vec<DeviceSnapshot>,
    cursor_idx: usize,
    cursor_ms: u64,
    start_ms: u64,
    end_ms: u64,
    speed: f64,
    playing: bool,
    started_at_real: u64,      // real‑time clock when play() was last called
    started_at_cursor_ms: u64, // cursor position at that same moment
}

impl PlaybackEngine {
    pub fn new() -> Self {
        Self {
            active: false,
            session_id: String::new(),
            frames: Vec::new(),
            cursor_idx: 0,
            cursor_ms: 0,
            start_ms: 0,
            end_ms: 0,
            speed: 1.0,
            playing: false,
            started_at_real: 0,
            started_at_cursor_ms: 0,
        }
    }

    /// Load a session CSV into the engine.  Returns true on success.
    pub fn load(&mut self, session_id: String, csv_path: &std::path::Path) -> Result<(), String> {
        let frames = session::read_session_csv(&csv_path.to_path_buf())?;
        if frames.is_empty() {
            return Err("CSV 中没有数据帧".to_string());
        }

        let start_ms = frames[0].received_at_ms;
        let end_ms = frames.last().unwrap().received_at_ms;

        self.active = true;
        self.session_id = session_id;
        self.frames = frames;
        self.cursor_idx = 0;
        self.cursor_ms = start_ms;
        self.start_ms = start_ms;
        self.end_ms = end_ms;
        self.speed = 1.0;
        self.playing = false;
        self.started_at_real = 0;
        self.started_at_cursor_ms = start_ms;
        Ok(())
    }

    pub fn play(&mut self) {
        if !self.active || self.frames.is_empty() {
            return;
        }
        let now = now_ms();
        self.started_at_real = now;
        self.started_at_cursor_ms = self.cursor_ms;
        self.playing = true;
    }

    pub fn pause(&mut self) {
        // Sync cursor to current playback position before stopping the clock
        if self.playing {
            let now = now_ms();
            self.cursor_ms = self.compute_cursor_ms(now);
            self.cursor_idx = self.find_frame(self.cursor_ms);
        }
        self.playing = false;
    }

    pub fn stop(&mut self) {
        self.playing = false;
        self.cursor_idx = 0;
        self.cursor_ms = self.start_ms;
        self.started_at_real = 0;
        self.started_at_cursor_ms = self.start_ms;
    }

    pub fn seek_to_ms(&mut self, ms: u64) {
        let clamped = ms.clamp(self.start_ms, self.end_ms);
        self.cursor_ms = clamped;
        self.cursor_idx = self.find_frame(clamped);
        // If playing, reset the clock so playback continues from here
        if self.playing {
            let now = now_ms();
            self.started_at_real = now;
            self.started_at_cursor_ms = clamped;
        }
    }

    pub fn set_speed(&mut self, speed: f64) {
        // Clamp between 0.25 and 4.0
        if self.playing {
            let now = now_ms();
            self.cursor_ms = self.compute_cursor_ms(now);
            self.cursor_idx = self.find_frame(self.cursor_ms);
            self.started_at_real = now;
            self.started_at_cursor_ms = self.cursor_ms;
        }
        self.speed = speed.clamp(0.25, 4.0);
    }

    /// Advance playback based on elapsed real time.
    /// Call this periodically (e.g. from the 1‑second tick).
    /// Returns a reference to the current frame, if any.
    pub(crate) fn tick(&mut self, now_ms: u64) -> Option<&DeviceSnapshot> {
        if !self.active || self.frames.is_empty() {
            return None;
        }
        if self.playing {
            self.cursor_ms = self.compute_cursor_ms(now_ms);
            self.cursor_idx = self.find_frame(self.cursor_ms);

            // Stop at the end
            if self.cursor_ms >= self.end_ms {
                self.playing = false;
                self.cursor_idx = self.frames.len().saturating_sub(1);
                self.cursor_ms = self.end_ms;
            }
        }
        self.frames.get(self.cursor_idx)
    }

    pub(crate) fn current_frame(&self) -> Option<&DeviceSnapshot> {
        self.frames.get(self.cursor_idx)
    }

    /// Return a window of `count` frames centered on the current cursor.
    pub(crate) fn frame_window(&self, count: usize) -> Vec<&DeviceSnapshot> {
        if self.frames.is_empty() {
            return Vec::new();
        }
        let half = count / 2;
        let start = self.cursor_idx.saturating_sub(half);
        let end = (start + count).min(self.frames.len());
        // Adjust start if we clipped at the end
        let actual_start = if end == self.frames.len() {
            self.frames.len().saturating_sub(count)
        } else {
            start
        };
        self.frames[actual_start..end].iter().collect()
    }

    pub fn status(&self) -> PlaybackStatus {
        let duration = if self.end_ms > self.start_ms {
            self.end_ms - self.start_ms
        } else {
            0
        };
        PlaybackStatus {
            active: self.active,
            session_id: self.session_id.clone(),
            playing: self.playing,
            speed: self.speed,
            cursor_ms: self.cursor_ms,
            duration_ms: duration,
            cursor_pct: if duration > 0 {
                (self.cursor_ms.saturating_sub(self.start_ms)) as f64 / duration as f64
            } else {
                0.0
            },
            total_frames: self.frames.len(),
            current_frame_idx: self.cursor_idx,
        }
    }

    /// Unload the engine to inactive state.
    pub fn unload(&mut self) {
        self.active = false;
        self.session_id.clear();
        self.frames.clear();
        self.cursor_idx = 0;
        self.cursor_ms = 0;
        self.start_ms = 0;
        self.end_ms = 0;
        self.speed = 1.0;
        self.playing = false;
        self.started_at_real = 0;
        self.started_at_cursor_ms = 0;
    }

    // ── helpers ──

    fn compute_cursor_ms(&self, now: u64) -> u64 {
        let elapsed_real = now.saturating_sub(self.started_at_real);
        let elapsed_playback = (elapsed_real as f64 * self.speed) as u64;
        let candidate = self.started_at_cursor_ms + elapsed_playback;
        if candidate >= self.end_ms {
            self.end_ms
        } else {
            candidate
        }
    }

    /// Binary‑search for the frame whose `received_at_ms` is closest to `ms`.
    fn find_frame(&self, ms: u64) -> usize {
        if self.frames.is_empty() {
            return 0;
        }
        let idx = match self.frames.binary_search_by(|f| f.received_at_ms.cmp(&ms)) {
            Ok(i) => i,
            Err(i) => {
                if i == 0 {
                    0
                } else if i >= self.frames.len() {
                    self.frames.len() - 1
                } else {
                    // Pick the closest of the two neighbours
                    let prev = self.frames[i - 1].received_at_ms;
                    let next = self.frames[i].received_at_ms;
                    if ms - prev <= next - ms {
                        i - 1
                    } else {
                        i
                    }
                }
            }
        };
        idx
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_dummy_frames() -> Vec<DeviceSnapshot> {
        let mut frames = Vec::new();
        let base = 1_000_000_000u64; // some epoch base
        for i in 0..10 {
            frames.push(DeviceSnapshot {
                device_id: "test-dev".to_string(),
                connection_id: String::new(),
                received_at_ms: base + i * 100, // 100ms apart
                sequence: i,
                protocol_version: "Test".to_string(),
                system_enabled: true,
                motors: Vec::new(),
                sensors: Vec::new(),
                bend: crate::BendSnapshot {
                    section1: crate::BendState {
                        angle_deg: 0.0,
                        target_angle_deg: 0.0,
                        direction: "up".to_string(),
                        quality: crate::FrameQuality::Ok,
                    },
                    section2: crate::BendState {
                        angle_deg: 0.0,
                        target_angle_deg: 0.0,
                        direction: "right".to_string(),
                        quality: crate::FrameQuality::Ok,
                    },
                },
                quality: crate::FrameStatus {
                    status: crate::FrameQuality::Ok,
                    latency_ms: 0,
                    dropped_frames: 0,
                    checksum_ok: true,
                },
            });
        }
        frames
    }

    #[test]
    fn engine_initial_state_is_inactive() {
        let engine = PlaybackEngine::new();
        assert!(!engine.active);
        assert!(!engine.playing);
        assert_eq!(engine.speed, 1.0);
    }

    #[test]
    fn engine_load_frames() {
        let mut engine = PlaybackEngine::new();
        // We can't easily test load() without a real CSV, but we can test the
        // internal state by manually setting frames (white‑box style).
        let frames = make_dummy_frames();
        engine.active = true;
        engine.session_id = "test-session".to_string();
        engine.frames = frames.clone();
        engine.start_ms = frames[0].received_at_ms;
        engine.end_ms = frames[9].received_at_ms;
        engine.started_at_cursor_ms = engine.start_ms;

        assert!(engine.active);
        assert_eq!(engine.frames.len(), 10);
        assert_eq!(engine.status().total_frames, 10);
    }

    #[test]
    fn engine_play_pause_tick() {
        let mut engine = PlaybackEngine::new();
        let frames = make_dummy_frames();
        engine.active = true;
        engine.session_id = "test-session".to_string();
        engine.frames = frames.clone();
        engine.start_ms = frames[0].received_at_ms;
        engine.end_ms = frames[9].received_at_ms;
        engine.started_at_cursor_ms = engine.start_ms;
        engine.cursor_ms = engine.start_ms;

        engine.play();
        assert!(engine.playing);

        // Override started_at_real to align with fake timestamps so
        // compute_cursor_ms works deterministically.
        engine.started_at_real = engine.start_ms;

        // Tick with a later timestamp
        let now = engine.start_ms + 50; // 50ms later
        let frame = engine.tick(now);
        assert!(frame.is_some());
        // At 1x speed after 50ms we should still be at frame 0 (100ms spacing)
        assert_eq!(engine.cursor_idx, 0);

        // Tick at 150ms → should be at frame 1
        let frame = engine.tick(engine.start_ms + 150);
        assert!(frame.is_some());
        assert_eq!(engine.cursor_idx, 1);

        // Manually pause (don't call pause() which uses real now_ms())
        engine.playing = false;
        assert!(!engine.playing);
        // Cursor stays after pause
        assert_eq!(engine.cursor_idx, 1);
    }

    #[test]
    fn engine_stops_at_end() {
        let mut engine = PlaybackEngine::new();
        let frames = make_dummy_frames();
        engine.active = true;
        engine.session_id = "test-session".to_string();
        engine.frames = frames.clone();
        engine.start_ms = frames[0].received_at_ms;
        engine.end_ms = frames[9].received_at_ms;
        engine.started_at_cursor_ms = engine.start_ms;
        engine.cursor_ms = engine.start_ms;

        engine.play();
        // Align started_at_real with the fake timestamp domain
        engine.started_at_real = engine.start_ms;
        // Advance way past the end
        let far_future = engine.end_ms + 10_000;
        let frame = engine.tick(far_future);
        assert!(frame.is_some());
        assert!(!engine.playing, "should auto‑stop at end");
        assert_eq!(engine.cursor_idx, 9);
    }

    #[test]
    fn engine_seek() {
        let mut engine = PlaybackEngine::new();
        let frames = make_dummy_frames();
        engine.active = true;
        engine.session_id = "test-session".to_string();
        engine.frames = frames.clone();
        engine.start_ms = frames[0].received_at_ms;
        engine.end_ms = frames[9].received_at_ms;
        engine.started_at_cursor_ms = engine.start_ms;
        engine.cursor_ms = engine.start_ms;

        engine.seek_to_ms(frames[5].received_at_ms);
        assert_eq!(engine.cursor_idx, 5);
        assert_eq!(engine.cursor_ms, frames[5].received_at_ms);
    }

    #[test]
    fn engine_speed_clamping() {
        let mut engine = PlaybackEngine::new();
        engine.set_speed(0.1);
        assert!((engine.speed - 0.25).abs() < 1e-9);
        engine.set_speed(10.0);
        assert!((engine.speed - 4.0).abs() < 1e-9);
        engine.set_speed(2.0);
        assert!((engine.speed - 2.0).abs() < 1e-9);
    }

    #[test]
    fn engine_unload_resets_state() {
        let mut engine = PlaybackEngine::new();
        let frames = make_dummy_frames();
        engine.active = true;
        engine.frames = frames;
        engine.session_id = "s".to_string();
        engine.playing = true;

        engine.unload();
        assert!(!engine.active);
        assert!(!engine.playing);
        assert!(engine.frames.is_empty());
    }

    #[test]
    fn engine_frame_window() {
        let mut engine = PlaybackEngine::new();
        let frames = make_dummy_frames();
        engine.active = true;
        engine.frames = frames;
        engine.cursor_idx = 5;
        engine.start_ms = engine.frames[0].received_at_ms;
        engine.end_ms = engine.frames[9].received_at_ms;

        let window = engine.frame_window(4);
        assert_eq!(window.len(), 4);
        // centered at 5, half=2 → start=3, end=7
        assert_eq!(window[0].sequence, 3);
        assert_eq!(window[3].sequence, 6);
    }
}
