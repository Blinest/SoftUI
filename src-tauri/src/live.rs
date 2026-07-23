use crate::DeviceSnapshot;
use serde::Serialize;
use std::collections::{HashSet, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameStats {
    pub stored_frames: usize,
    pub capacity: usize,
    pub total_frames: u64,
    pub dropped_frames: u64,
    pub frame_rate_hz: f64,
}

pub struct LiveDataRing {
    buffer: VecDeque<DeviceSnapshot>,
    max_len: usize,
    total_frames: u64,
    dropped_frames: u64,
    last_frame_ms: u64,
}

impl LiveDataRing {
    pub(crate) fn new(max_len: usize) -> Self {
        Self {
            buffer: VecDeque::with_capacity(max_len),
            max_len,
            total_frames: 0,
            dropped_frames: 0,
            last_frame_ms: 0,
        }
    }

    pub(crate) fn push(&mut self, frame: DeviceSnapshot) {
        self.total_frames = self.total_frames.saturating_add(1);
        let now = now_ms();
        if self.last_frame_ms > 0 && now.saturating_sub(self.last_frame_ms) > 200 {
            self.dropped_frames = self.dropped_frames.saturating_add(1);
        }
        self.last_frame_ms = now;

        if self.buffer.len() >= self.max_len {
            self.buffer.pop_front();
        }
        self.buffer.push_back(frame);
    }

    #[allow(dead_code)]
    pub(crate) fn latest(&self) -> Option<DeviceSnapshot> {
        self.buffer.back().cloned()
    }

    pub(crate) fn latest_per_device(&self) -> Vec<DeviceSnapshot> {
        let mut seen = HashSet::new();
        let mut result = Vec::new();
        for frame in self.buffer.iter().rev() {
            if seen.insert(&frame.device_id) {
                result.push(frame.clone());
            }
        }
        result
    }

    pub(crate) fn window(&self, count: usize) -> Vec<DeviceSnapshot> {
        let count = count.min(self.buffer.len());
        self.buffer.iter().rev().take(count).cloned().collect()
    }

    pub(crate) fn stats(&self) -> FrameStats {
        let frame_rate_hz = if self.buffer.len() >= 2 {
            let first = self.buffer.front().unwrap();
            let last = self.buffer.back().unwrap();
            let elapsed_s =
                (last.received_at_ms.saturating_sub(first.received_at_ms)) as f64 / 1000.0;
            if elapsed_s > 0.001 {
                (self.buffer.len() as f64 - 1.0) / elapsed_s
            } else {
                0.0
            }
        } else {
            0.0
        };

        FrameStats {
            stored_frames: self.buffer.len(),
            capacity: self.max_len,
            total_frames: self.total_frames,
            dropped_frames: self.dropped_frames,
            frame_rate_hz,
        }
    }

    pub(crate) fn clear(&mut self) {
        self.buffer.clear();
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

    fn dummy_frame(device_id: &str, seq: u64, received_at_ms: u64) -> DeviceSnapshot {
        DeviceSnapshot {
            device_id: device_id.to_string(),
            connection_id: "conn-1".to_string(),
            received_at_ms,
            sequence: seq,
            protocol_version: "Legacy V1".to_string(),
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
        }
    }

    #[test]
    fn ring_buffer_evicts_oldest_when_full() {
        let mut ring = LiveDataRing::new(3);
        ring.push(dummy_frame("dev:0", 1, 1000));
        ring.push(dummy_frame("dev:0", 2, 1100));
        ring.push(dummy_frame("dev:0", 3, 1200));
        ring.push(dummy_frame("dev:0", 4, 1300));

        assert_eq!(ring.buffer.len(), 3);
        assert_eq!(ring.buffer.front().unwrap().sequence, 2);
        assert_eq!(ring.buffer.back().unwrap().sequence, 4);
    }

    #[test]
    fn ring_returns_window_of_last_n_frames() {
        let mut ring = LiveDataRing::new(10);
        for i in 1..=5 {
            ring.push(dummy_frame("dev:0", i, i * 100));
        }

        let window = ring.window(3);
        assert_eq!(window.len(), 3);
        assert_eq!(window[0].sequence, 5);
        assert_eq!(window[2].sequence, 3);
    }

    #[test]
    fn ring_latest_returns_newest_frame() {
        let mut ring = LiveDataRing::new(10);
        ring.push(dummy_frame("dev:0", 1, 1000));
        ring.push(dummy_frame("dev:0", 2, 1100));

        let latest = ring.latest().expect("should have latest");
        assert_eq!(latest.sequence, 2);
    }

    #[test]
    fn ring_stats_reports_correct_counts() {
        let mut ring = LiveDataRing::new(5);
        for i in 1..=3 {
            ring.push(dummy_frame("dev:0", i, i * 100));
        }

        let stats = ring.stats();
        assert_eq!(stats.stored_frames, 3);
        assert_eq!(stats.capacity, 5);
        assert_eq!(stats.total_frames, 3);
    }

    #[test]
    fn ring_latest_per_device_deduplicates() {
        let mut ring = LiveDataRing::new(10);
        ring.push(dummy_frame("dev:A", 1, 1000));
        ring.push(dummy_frame("dev:B", 1, 1100));
        ring.push(dummy_frame("dev:A", 2, 1200));
        ring.push(dummy_frame("dev:B", 2, 1300));

        let per_dev = ring.latest_per_device();
        assert_eq!(per_dev.len(), 2);
        assert!(per_dev
            .iter()
            .any(|f| f.device_id == "dev:A" && f.sequence == 2));
        assert!(per_dev
            .iter()
            .any(|f| f.device_id == "dev:B" && f.sequence == 2));
    }

    #[test]
    fn ring_empty_returns_defaults() {
        let ring: LiveDataRing = LiveDataRing::new(10);

        assert!(ring.latest().is_none());
        assert!(ring.latest_per_device().is_empty());
        assert!(ring.window(5).is_empty());
        let stats = ring.stats();
        assert_eq!(stats.stored_frames, 0);
        assert_eq!(stats.total_frames, 0);
    }
}
