use crate::{BendSnapshot, BendState, DeviceSnapshot, FrameQuality, FrameStatus, MotorState};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetadata {
    pub operator: String,
    pub notes: String,
    pub tags: Vec<String>,
    pub device_ids: Vec<String>,
    pub connection_profile_id: String,
    pub control_profile_id: String,
    pub filter_profile_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSidecar {
    pub name: String,
    #[serde(flatten)]
    pub meta: SessionMetadata,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub name: String,
    pub start_time: String,
    pub end_time: Option<String>,
    pub device_id: String,
    pub frame_count: u64,
    pub file_size: u64,
    pub file_path: String,
    pub operator: Option<String>,
    pub notes: Option<String>,
    pub tags: Option<Vec<String>>,
    pub device_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecorderStatus {
    pub active: bool,
    pub session_id: String,
    pub session_name: String,
    pub frame_count: u64,
    pub elapsed_secs: u64,
    pub paused: bool,
}

pub struct SessionRecorder {
    record_dir: PathBuf,
    active: bool,
    paused: bool,
    session_id: String,
    session_name: String,
    writer: Option<BufWriter<File>>,
    last_seq: u64,
    frame_count: u64,
    file_path: Option<PathBuf>,
    start_ms: u64,
}

impl SessionRecorder {
    pub fn new(record_dir: PathBuf) -> Self {
        fs::create_dir_all(&record_dir).ok();
        Self {
            record_dir,
            active: false,
            paused: false,
            session_id: String::new(),
            session_name: String::new(),
            writer: None,
            last_seq: 0,
            frame_count: 0,
            file_path: None,
            start_ms: 0,
        }
    }

    pub fn start(&mut self, name: String) -> Result<SessionInfo, String> {
        if self.active {
            return Err("已经有正在进行的录制".to_string());
        }
        let now = now_ms();
        let session_id = format!("session-{}", now);
        let file_name = format!("{}.csv", session_id);
        let file_path = self.record_dir.join(&file_name);

        let file = File::create(&file_path).map_err(|e| e.to_string())?;
        let mut writer = BufWriter::new(file);
        // UTF-8 BOM for Excel compatibility
        writer
            .write_all(&[0xEF, 0xBB, 0xBF])
            .map_err(|e| e.to_string())?;
        let header = "timestamp_ms,sequence,device_id".to_string()
            + &(1..=6)
                .flat_map(|i| {
                    [
                        format!("motor_{}_pos_mm", i),
                        format!("motor_{}_vel_mmps", i),
                        format!("motor_{}_acc_mmps2", i),
                    ]
                })
                .chain([
                    "bend_s1_angle_deg".to_string(),
                    "bend_s2_angle_deg".to_string(),
                ])
                .collect::<Vec<_>>()
                .join(",");
        writeln!(writer, "{}", header).map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())?;

        // Write initial metadata sidecar
        let sidecar = SessionSidecar {
            name: name.clone(),
            meta: SessionMetadata {
                operator: String::new(),
                notes: String::new(),
                tags: Vec::new(),
                device_ids: Vec::new(),
                connection_profile_id: String::new(),
                control_profile_id: String::new(),
                filter_profile_id: String::new(),
            },
        };
        if let Ok(json) = serde_json::to_string_pretty(&sidecar) {
            let json_path = file_path.with_extension("json");
            fs::write(&json_path, json).ok();
        }

        self.active = true;
        self.paused = false;
        self.session_id = session_id;
        self.session_name = name.clone();
        self.writer = Some(writer);
        self.last_seq = 0;
        self.frame_count = 0;
        self.file_path = Some(file_path.clone());
        self.start_ms = now;

        Ok(SessionInfo {
            id: self.session_id.clone(),
            name,
            start_time: format_ts(now),
            end_time: None,
            device_id: String::new(),
            frame_count: 0,
            file_size: 0,
            file_path: file_path.to_string_lossy().to_string(),
            operator: None,
            notes: None,
            tags: None,
            device_ids: None,
        })
    }

    pub fn stop(&mut self) -> Result<SessionInfo, String> {
        if !self.active {
            return Err("没有正在进行的录制".to_string());
        }
        // Close writer to flush + release file handle
        drop(self.writer.take());
        let now = now_ms();
        let file_size = self
            .file_path
            .as_ref()
            .and_then(|p| fs::metadata(p).ok())
            .map(|m| m.len())
            .unwrap_or(0);

        // Update metadata end_time
        if let Some(ref path) = self.file_path {
            if let Some(sidecar) = Self::read_sidecar_raw(path) {
                if let Ok(json) = serde_json::to_string_pretty(&sidecar) {
                    let json_path = path.with_extension("json");
                    fs::write(&json_path, json).ok();
                }
            }
        }

        let info = SessionInfo {
            id: self.session_id.clone(),
            name: self.session_name.clone(),
            start_time: format_ts(self.start_ms),
            end_time: Some(format_ts(now)),
            device_id: String::new(),
            frame_count: self.frame_count,
            file_size,
            file_path: self
                .file_path
                .as_ref()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default(),
            operator: None,
            notes: None,
            tags: None,
            device_ids: None,
        };

        self.active = false;
        self.paused = false;
        self.session_id.clear();
        self.session_name.clear();
        self.last_seq = 0;
        self.frame_count = 0;
        self.file_path = None;

        Ok(info)
    }

    pub fn pause(&mut self) -> Result<(), String> {
        if !self.active {
            return Err("没有正在进行的录制".to_string());
        }
        self.paused = true;
        Ok(())
    }

    pub fn resume(&mut self) -> Result<(), String> {
        if !self.active {
            return Err("没有正在进行的录制".to_string());
        }
        self.paused = false;
        Ok(())
    }

    pub(crate) fn write_frame(&mut self, frame: &DeviceSnapshot) {
        if !self.active || self.paused {
            return;
        }
        if frame.sequence <= self.last_seq {
            return;
        }

        let Some(ref mut writer) = self.writer else {
            return;
        };

        write!(
            writer,
            "{},{},{}",
            frame.received_at_ms, frame.sequence, frame.device_id
        )
        .ok();

        for i in 0..6 {
            if let Some(m) = frame.motors.get(i) {
                write!(
                    writer,
                    ",{:.3},{:.3},{:.3}",
                    m.position_mm, m.velocity_mm_per_sec, m.acceleration_mm_per_sec2
                )
                .ok();
            } else {
                write!(writer, ",,,").ok();
            }
        }

        writeln!(
            writer,
            ",{},{}",
            frame.bend.section1.angle_deg, frame.bend.section2.angle_deg
        )
        .ok();

        self.frame_count = self.frame_count.saturating_add(1);
        // Flush periodically for crash safety
        if self.frame_count % 20 == 0 {
            writer.flush().ok();
        }

        self.last_seq = frame.sequence;
    }

    /// Write full metadata to the JSON sidecar for the active session.
    pub fn write_metadata(&self, meta: &SessionMetadata) -> Result<(), String> {
        let Some(ref path) = self.file_path else {
            return Err("没有活动的录制".to_string());
        };
        let sidecar = SessionSidecar {
            name: self.session_name.clone(),
            meta: meta.clone(),
        };
        let json = serde_json::to_string_pretty(&sidecar).map_err(|e| e.to_string())?;
        fs::write(path.with_extension("json"), json).map_err(|e| e.to_string())
    }

    /// Read the sidecar JSON for a given CSV or JSON path.
    fn read_sidecar(path: &PathBuf) -> Option<SessionSidecar> {
        let json_path = if path.extension().and_then(|e| e.to_str()) == Some("json") {
            path.clone()
        } else {
            path.with_extension("json")
        };
        if !json_path.exists() {
            return None;
        }
        fs::read_to_string(&json_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
    }

    /// Read raw sidecar as serde_json::Value for field-level updates.
    fn read_sidecar_raw(path: &PathBuf) -> Option<serde_json::Value> {
        let json_path = if path.extension().and_then(|e| e.to_str()) == Some("json") {
            path.clone()
        } else {
            path.with_extension("json")
        };
        if !json_path.exists() {
            return None;
        }
        fs::read_to_string(&json_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
    }

    /// Read SessionMetadata for an existing session (by CSV path).
    pub fn read_metadata(path: &PathBuf) -> Option<SessionMetadata> {
        Self::read_sidecar(path).map(|s| s.meta)
    }

    /// Delete a session's CSV + JSON files by session id.
    pub fn delete_session(&self, id: &str) -> Result<(), String> {
        let csv_path = self.record_dir.join(format!("{}.csv", id));
        let json_path = self.record_dir.join(format!("{}.json", id));
        if csv_path.exists() {
            fs::remove_file(&csv_path).map_err(|e| e.to_string())?;
        }
        if json_path.exists() {
            fs::remove_file(&json_path).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Rename a session by updating its JSON sidecar name field.
    pub fn rename_session(&self, id: &str, name: &str) -> Result<(), String> {
        let json_path = self.record_dir.join(format!("{}.json", id));
        if !json_path.exists() {
            return Err("元数据文件不存在".to_string());
        }
        let mut value = Self::read_sidecar_raw(&json_path).unwrap_or(serde_json::json!({}));
        value["name"] = serde_json::Value::String(name.to_string());
        let json = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
        fs::write(&json_path, json).map_err(|e| e.to_string())
    }

    /// Update metadata for an existing session.
    pub fn update_metadata(&self, id: &str, meta: &SessionMetadata) -> Result<(), String> {
        let json_path = self.record_dir.join(format!("{}.json", id));
        if !json_path.exists() {
            return Err("元数据文件不存在".to_string());
        }
        let mut value = Self::read_sidecar_raw(&json_path).unwrap_or(serde_json::json!({}));
        // Flatten the SessionMetadata fields into the top-level value
        if let Ok(meta_value) = serde_json::to_value(meta) {
            if let Some(obj) = meta_value.as_object() {
                for (k, v) in obj {
                    value[k] = v.clone();
                }
            }
        }
        let json = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
        fs::write(&json_path, json).map_err(|e| e.to_string())
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    /// Get the CSV path for a session ID, if it exists.
    pub fn session_csv_path(&self, id: &str) -> Option<PathBuf> {
        let p = self.record_dir.join(format!("{}.csv", id));
        if p.exists() {
            Some(p)
        } else {
            None
        }
    }

    pub fn status(&self) -> RecorderStatus {
        RecorderStatus {
            active: self.active,
            session_id: self.session_id.clone(),
            session_name: self.session_name.clone(),
            frame_count: self.frame_count,
            elapsed_secs: if self.active {
                (now_ms().saturating_sub(self.start_ms)) / 1000
            } else {
                0
            },
            paused: self.paused,
        }
    }

    pub fn list_sessions(&self) -> Vec<SessionInfo> {
        let mut sessions = Vec::new();
        let entries = match fs::read_dir(&self.record_dir) {
            Ok(e) => e,
            Err(_) => return sessions,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("csv") {
                continue;
            }
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            let file_stem = path
                .file_stem()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            // Try to read sidecar for enriched metadata
            let sidecar = Self::read_sidecar(&path);

            let start_time = String::new();
            let mut device_ids: Option<Vec<String>> = None;
            let mut operator: Option<String> = None;
            let mut notes: Option<String> = None;
            let mut tags: Option<Vec<String>> = None;

            if let Some(ref sc) = sidecar {
                operator = Some(sc.meta.operator.clone());
                notes = Some(sc.meta.notes.clone());
                tags = Some(sc.meta.tags.clone());
                device_ids = if sc.meta.device_ids.is_empty() {
                    None
                } else {
                    Some(sc.meta.device_ids.clone())
                };
            }

            // Approximate start_time from file name (placeholder)
            let _frame_count = 0;

            sessions.push(SessionInfo {
                id: file_stem.clone(),
                name: sidecar
                    .as_ref()
                    .map(|s| s.name.clone())
                    .unwrap_or_else(|| file_stem.clone()),
                start_time,
                end_time: None,
                device_id: String::new(),
                frame_count: 0,
                file_size: meta.len(),
                file_path: path.to_string_lossy().to_string(),
                operator,
                notes,
                tags,
                device_ids,
            });
        }
        sessions.sort_by(|a, b| b.id.cmp(&a.id));
        sessions
    }
}

/// Read CSV file contents into Vec<DeviceSnapshot> for playback / history.
pub(crate) fn read_session_csv(path: &PathBuf) -> Result<Vec<DeviceSnapshot>, String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    // Strip BOM if present
    let content = content.trim_start_matches('\u{feff}');
    let mut lines = content.lines();
    let _header = lines.next().ok_or("CSV 为空")?; // skip header

    let mut frames = Vec::new();
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let cols: Vec<&str> = line.split(',').collect();
        if cols.len() < 23 {
            continue; // malformed row — skip
        }

        let timestamp_ms: u64 = cols[0].parse().unwrap_or(0);
        let sequence: u64 = cols[1].parse().unwrap_or(0);
        let device_id = cols[2].to_string();

        let mut motors = Vec::with_capacity(6);
        for i in 0..6 {
            let base = 3 + i * 3;
            let pos: f64 = cols.get(base).and_then(|s| s.parse().ok()).unwrap_or(0.0);
            let vel: f64 = cols
                .get(base + 1)
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0);
            let acc: f64 = cols
                .get(base + 2)
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0);
            motors.push(MotorState {
                id: (i + 1) as u32,
                position_mm: pos,
                velocity_mm_per_sec: vel,
                acceleration_mm_per_sec2: acc,
                running: true,
                target_position_mm: pos,
            });
        }

        let bend_s1: f64 = cols.get(21).and_then(|s| s.parse().ok()).unwrap_or(0.0);
        let bend_s2: f64 = cols.get(22).and_then(|s| s.parse().ok()).unwrap_or(0.0);

        frames.push(DeviceSnapshot {
            device_id,
            connection_id: String::new(),
            received_at_ms: timestamp_ms,
            sequence,
            protocol_version: "CSV Playback".to_string(),
            system_enabled: true,
            motors,
            sensors: Vec::new(),
            bend: BendSnapshot {
                section1: BendState {
                    angle_deg: bend_s1,
                    target_angle_deg: bend_s1,
                    direction: "up".to_string(),
                    quality: FrameQuality::Ok,
                },
                section2: BendState {
                    angle_deg: bend_s2,
                    target_angle_deg: bend_s2,
                    direction: "right".to_string(),
                    quality: FrameQuality::Ok,
                },
            },
            quality: FrameStatus {
                status: FrameQuality::Ok,
                latency_ms: 0,
                dropped_frames: 0,
                checksum_ok: true,
            },
        });
    }

    Ok(frames)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn format_ts(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let nanos = ((ms % 1000) * 1_000_000) as u32;
    match OffsetDateTime::from_unix_timestamp(secs) {
        Ok(dt) => {
            let dt = dt.replace_nanosecond(nanos).unwrap_or(dt);
            dt.format(&Rfc3339).unwrap_or_else(|_| ms.to_string())
        }
        Err(_) => ms.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_frame(device_id: &str, seq: u64) -> DeviceSnapshot {
        DeviceSnapshot {
            device_id: device_id.to_string(),
            connection_id: "conn-1".to_string(),
            received_at_ms: now_ms(),
            sequence: seq,
            protocol_version: "Legacy V1".to_string(),
            system_enabled: true,
            motors: (1..=6)
                .map(|i| MotorState {
                    id: i,
                    position_mm: i as f64 * 2.0 + seq as f64,
                    velocity_mm_per_sec: i as f64 * 0.5,
                    acceleration_mm_per_sec2: i as f64 * 0.1,
                    running: true,
                    target_position_mm: i as f64 * 2.0 + seq as f64 + 1.0,
                })
                .collect(),
            sensors: Vec::new(),
            bend: BendSnapshot {
                section1: BendState {
                    angle_deg: 10.0 + seq as f64,
                    target_angle_deg: 14.0,
                    direction: "up".to_string(),
                    quality: FrameQuality::Ok,
                },
                section2: BendState {
                    angle_deg: 5.0 + seq as f64,
                    target_angle_deg: 9.0,
                    direction: "right".to_string(),
                    quality: FrameQuality::Ok,
                },
            },
            quality: FrameStatus {
                status: FrameQuality::Ok,
                latency_ms: 10,
                dropped_frames: 0,
                checksum_ok: true,
            },
        }
    }

    #[test]
    fn recorder_starts_and_stops() {
        let dir = std::env::temp_dir().join("softui-test-recorder");
        let _ = fs::remove_dir_all(&dir);
        let mut rec = SessionRecorder::new(dir.clone());

        let info = rec.start("test-session".to_string()).expect("start");
        assert!(rec.is_active());
        assert!(info.id.starts_with("session-"));

        let info = rec.stop().expect("stop");
        assert!(!rec.is_active());
        assert_eq!(info.name, "test-session");
        assert!(info.file_size > 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recorder_writes_frames_to_csv() {
        let dir = std::env::temp_dir().join("softui-test-csv");
        let _ = fs::remove_dir_all(&dir);
        let mut rec = SessionRecorder::new(dir.clone());
        rec.start("csv-test".to_string()).expect("start");

        for seq in 1..=5 {
            rec.write_frame(&dummy_frame("dev:0", seq));
        }

        let info = rec.stop().expect("stop");
        assert_eq!(info.frame_count, 5);

        // Verify CSV content
        let csv = fs::read_to_string(info.file_path).expect("read csv");
        assert!(csv.starts_with("\u{feff}timestamp_ms")); // BOM + header
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines.len(), 6); // header + 5 data rows
        assert!(lines[1].contains("dev:0")); // first data row
        assert!(lines[1].contains("2.000")); // motor 1 pos for seq 1
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recorder_idle_writes_are_noop() {
        let dir = std::env::temp_dir().join("softui-test-idle");
        let _ = fs::remove_dir_all(&dir);
        let mut rec = SessionRecorder::new(dir.clone());

        // Write without starting — should not crash
        rec.write_frame(&dummy_frame("dev:0", 1));
        assert!(!rec.is_active());

        let sessions = rec.list_sessions();
        assert!(sessions.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recorder_skips_duplicate_sequences() {
        let dir = std::env::temp_dir().join("softui-test-dedup");
        let _ = fs::remove_dir_all(&dir);
        let mut rec = SessionRecorder::new(dir);
        rec.start("dedup-test".to_string()).expect("start");

        rec.write_frame(&dummy_frame("dev:0", 1));
        rec.write_frame(&dummy_frame("dev:0", 1)); // duplicate
        rec.write_frame(&dummy_frame("dev:0", 2));

        let info = rec.stop().expect("stop");
        assert_eq!(info.frame_count, 2);
    }

    #[test]
    fn recorder_pause_resume() {
        let dir = std::env::temp_dir().join("softui-test-pause");
        let _ = fs::remove_dir_all(&dir);
        let mut rec = SessionRecorder::new(dir.clone());
        rec.start("pause-test".to_string()).expect("start");

        // Write some frames
        rec.write_frame(&dummy_frame("dev:0", 1));
        rec.write_frame(&dummy_frame("dev:0", 2));
        assert_eq!(rec.frame_count, 2);

        // Pause — writes should be skipped
        rec.pause().expect("pause");
        assert!(rec.is_paused());
        rec.write_frame(&dummy_frame("dev:0", 3));
        rec.write_frame(&dummy_frame("dev:0", 4));
        assert_eq!(
            rec.frame_count, 2,
            "frames written while paused should be discarded"
        );

        // Resume — writes should resume
        rec.resume().expect("resume");
        assert!(!rec.is_paused());
        rec.write_frame(&dummy_frame("dev:0", 3));
        rec.write_frame(&dummy_frame("dev:0", 4));
        assert_eq!(rec.frame_count, 4);

        rec.stop().expect("stop");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recorder_metadata_roundtrip() {
        let dir = std::env::temp_dir().join("softui-test-meta");
        let _ = fs::remove_dir_all(&dir);
        let mut rec = SessionRecorder::new(dir.clone());
        rec.start("meta-test".to_string()).expect("start");
        rec.stop().expect("stop");

        // Check that sidecar JSON was created
        let sessions = rec.list_sessions();
        assert!(!sessions.is_empty());
        let s = &sessions[0];
        assert_eq!(s.name, "meta-test");

        // Read metadata back
        let path = PathBuf::from(&s.file_path);
        let meta = SessionRecorder::read_metadata(&path);
        assert!(meta.is_some(), "sidecar JSON should exist");
        if let Some(m) = meta {
            assert_eq!(m.operator, "");
        }

        // Write metadata
        let updated = SessionMetadata {
            operator: "researcher".to_string(),
            notes: "test run".to_string(),
            tags: vec!["test".to_string(), "calibration".to_string()],
            device_ids: vec!["softui-sim-01".to_string()],
            connection_profile_id: "sim-default".to_string(),
            control_profile_id: String::new(),
            filter_profile_id: String::new(),
        };
        let rec2 = SessionRecorder::new(dir.clone());
        rec2.update_metadata(&s.id, &updated).expect("update");

        // Verify
        let meta2 = SessionRecorder::read_metadata(&path);
        assert!(meta2.is_some());
        let m2 = meta2.unwrap();
        assert_eq!(m2.operator, "researcher");
        assert_eq!(m2.notes, "test run");
        assert_eq!(m2.tags, vec!["test", "calibration"]);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recorder_csv_readback() {
        let dir = std::env::temp_dir().join("softui-test-readback");
        let _ = fs::remove_dir_all(&dir);
        let mut rec = SessionRecorder::new(dir.clone());
        rec.start("readback-test".to_string()).expect("start");

        let seqs = [1u64, 2, 3];
        for s in &seqs {
            rec.write_frame(&dummy_frame("dev:0", *s));
        }
        let info = rec.stop().expect("stop");

        // Read back the CSV
        let csv_path = PathBuf::from(&info.file_path);
        let frames = read_session_csv(&csv_path).expect("read csv");
        assert_eq!(frames.len(), seqs.len());

        // Check first frame data
        assert_eq!(frames[0].device_id, "dev:0");
        assert_eq!(frames[0].sequence, 1);
        assert_eq!(frames[0].motors.len(), 6);
        // motor 1 (index 0): position = i*2.0 + seq = 1*2+1 = 3.0
        assert!((frames[0].motors[0].position_mm - 3.0).abs() < 0.001);

        // Check bend data
        assert!((frames[0].bend.section1.angle_deg - 11.0).abs() < 0.001); // 10+seq=11
        assert!((frames[0].bend.section2.angle_deg - 6.0).abs() < 0.001); // 5+seq=6

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn recorder_delete_session() {
        let dir = std::env::temp_dir().join("softui-test-delete");
        let _ = fs::remove_dir_all(&dir);
        let mut rec = SessionRecorder::new(dir.clone());
        rec.start("delete-me".to_string()).expect("start");
        rec.write_frame(&dummy_frame("dev:0", 1));
        let info = rec.stop().expect("stop");

        // Verify files exist
        let csv_path = PathBuf::from(&info.file_path);
        assert!(csv_path.exists());
        assert!(csv_path.with_extension("json").exists());

        // Delete
        rec.delete_session(&info.id).expect("delete");
        assert!(!csv_path.exists());
        assert!(!csv_path.with_extension("json").exists());

        let sessions = rec.list_sessions();
        assert!(sessions.is_empty());

        let _ = fs::remove_dir_all(&dir);
    }
}
