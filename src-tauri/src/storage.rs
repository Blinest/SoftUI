use serde::Serialize;
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Debug, Clone)]
pub struct SqliteStore {
    path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct SessionRow {
    pub id: String,
    pub name: String,
    pub start_time: String,
    pub end_time: Option<String>,
    pub operator: Option<String>,
    pub notes: Option<String>,
    pub tags_json: String,
    pub device_ids_json: String,
    pub record_count: u64,
    pub csv_path: String,
}

#[derive(Debug, Clone)]
pub struct LogRow {
    pub id: u64,
    pub timestamp_ms: u64,
    pub level: String,
    pub scope: String,
    pub message: String,
    pub device_id: Option<String>,
    pub frame_hex: Option<String>,
}

impl SqliteStore {
    pub fn new(path: PathBuf) -> Self {
        let store = Self { path };
        let _ = store.init();
        store
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn init(&self) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }

        self.run_sql(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                start_time TEXT NOT NULL,
                end_time TEXT,
                operator TEXT,
                notes TEXT,
                tags_json TEXT NOT NULL DEFAULT '[]',
                device_ids_json TEXT NOT NULL DEFAULT '[]',
                record_count INTEGER NOT NULL DEFAULT 0,
                csv_path TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS session_snapshots (
                session_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                received_at_ms INTEGER NOT NULL,
                device_id TEXT NOT NULL,
                snapshot_json TEXT NOT NULL,
                PRIMARY KEY (session_id, sequence, device_id)
            );

            CREATE TABLE IF NOT EXISTS control_commands (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp_ms INTEGER NOT NULL,
                username TEXT,
                device_id TEXT NOT NULL,
                command TEXT NOT NULL,
                frame_hex TEXT NOT NULL,
                payload_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS audit_logs (
                id INTEGER PRIMARY KEY,
                timestamp_ms INTEGER NOT NULL,
                level TEXT NOT NULL,
                scope TEXT NOT NULL,
                message TEXT NOT NULL,
                device_id TEXT,
                frame_hex TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_session_snapshots_time
                ON session_snapshots(session_id, received_at_ms);
            CREATE INDEX IF NOT EXISTS idx_audit_scope_time
                ON audit_logs(scope, timestamp_ms);
            "#,
        )
        .map(|_| ())
    }

    pub fn upsert_session(&self, row: &SessionRow) -> Result<(), String> {
        self.run_sql(&format!(
            r#"
            INSERT INTO sessions (
                id, name, start_time, end_time, operator, notes, tags_json,
                device_ids_json, record_count, csv_path, updated_at_ms
            )
            VALUES ({id}, {name}, {start_time}, {end_time}, {operator}, {notes}, {tags_json},
                {device_ids_json}, {record_count}, {csv_path}, {updated_at_ms})
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                start_time = excluded.start_time,
                end_time = excluded.end_time,
                operator = excluded.operator,
                notes = excluded.notes,
                tags_json = excluded.tags_json,
                device_ids_json = excluded.device_ids_json,
                record_count = excluded.record_count,
                csv_path = excluded.csv_path,
                updated_at_ms = excluded.updated_at_ms;
            "#,
            id = sql_string(&row.id),
            name = sql_string(&row.name),
            start_time = sql_string(&row.start_time),
            end_time = sql_optional(row.end_time.as_deref()),
            operator = sql_optional(row.operator.as_deref()),
            notes = sql_optional(row.notes.as_deref()),
            tags_json = sql_string(&row.tags_json),
            device_ids_json = sql_string(&row.device_ids_json),
            record_count = row.record_count,
            csv_path = sql_string(&row.csv_path),
            updated_at_ms = now_ms(),
        ))
        .map(|_| ())
    }

    pub fn delete_session(&self, id: &str) -> Result<(), String> {
        self.run_sql(&format!(
            r#"
            DELETE FROM session_snapshots WHERE session_id = {id};
            DELETE FROM sessions WHERE id = {id};
            "#,
            id = sql_string(id),
        ))
        .map(|_| ())
    }

    pub fn insert_snapshot<T: Serialize>(
        &self,
        session_id: &str,
        sequence: u64,
        received_at_ms: u64,
        device_id: &str,
        snapshot: &T,
    ) -> Result<(), String> {
        let snapshot_json = serde_json::to_string(snapshot).map_err(|error| error.to_string())?;
        self.run_sql(&format!(
            r#"
            INSERT OR REPLACE INTO session_snapshots
                (session_id, sequence, received_at_ms, device_id, snapshot_json)
            VALUES ({session_id}, {sequence}, {received_at_ms}, {device_id}, {snapshot_json});
            "#,
            session_id = sql_string(session_id),
            sequence = sequence,
            received_at_ms = received_at_ms,
            device_id = sql_string(device_id),
            snapshot_json = sql_string(&snapshot_json),
        ))
        .map(|_| ())
    }

    pub fn read_snapshot_json(
        &self,
        session_id: &str,
        limit: usize,
    ) -> Result<Vec<String>, String> {
        let output = self.run_sql(&format!(
            r#"
            SELECT snapshot_json
            FROM session_snapshots
            WHERE session_id = {session_id}
            ORDER BY received_at_ms ASC, sequence ASC
            LIMIT {limit};
            "#,
            session_id = sql_string(session_id),
            limit = limit,
        ))?;
        Ok(output
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && *line != "wal")
            .map(ToOwned::to_owned)
            .collect())
    }

    pub fn insert_control_command<T: Serialize>(
        &self,
        timestamp_ms: u64,
        username: Option<&str>,
        device_id: &str,
        command: &str,
        frame_hex: &str,
        payload: &T,
    ) -> Result<(), String> {
        let payload_json = serde_json::to_string(payload).map_err(|error| error.to_string())?;
        self.run_sql(&format!(
            r#"
            INSERT INTO control_commands
                (timestamp_ms, username, device_id, command, frame_hex, payload_json)
            VALUES ({timestamp_ms}, {username}, {device_id}, {command}, {frame_hex}, {payload_json});
            "#,
            timestamp_ms = timestamp_ms,
            username = sql_optional(username),
            device_id = sql_string(device_id),
            command = sql_string(command),
            frame_hex = sql_string(frame_hex),
            payload_json = sql_string(&payload_json),
        ))
        .map(|_| ())
    }

    pub fn insert_log(&self, row: &LogRow) -> Result<(), String> {
        self.run_sql(&format!(
            r#"
            INSERT OR IGNORE INTO audit_logs
                (id, timestamp_ms, level, scope, message, device_id, frame_hex)
            VALUES ({id}, {timestamp_ms}, {level}, {scope}, {message}, {device_id}, {frame_hex});
            "#,
            id = row.id,
            timestamp_ms = row.timestamp_ms,
            level = sql_string(&row.level),
            scope = sql_string(&row.scope),
            message = sql_string(&row.message),
            device_id = sql_optional(row.device_id.as_deref()),
            frame_hex = sql_optional(row.frame_hex.as_deref()),
        ))
        .map(|_| ())
    }

    pub fn count_rows(&self, table: &str) -> Result<u64, String> {
        let allowed = [
            "sessions",
            "session_snapshots",
            "control_commands",
            "audit_logs",
        ];
        if !allowed.contains(&table) {
            return Err("unsupported table".to_string());
        }
        self.run_sql(&format!("SELECT COUNT(*) FROM {table};"))?
            .lines()
            .find_map(|line| line.trim().parse::<u64>().ok())
            .ok_or_else(|| "sqlite count result is empty".to_string())
    }

    fn run_sql(&self, sql: &str) -> Result<String, String> {
        let mut last_error = None;
        for executable in sqlite_candidates() {
            let output = Command::new(&executable)
                .arg(self.path.as_os_str())
                .arg("-batch")
                .arg("-noheader")
                .arg(sql)
                .output();

            match output {
                Ok(output) if output.status.success() => {
                    return Ok(String::from_utf8_lossy(&output.stdout).to_string());
                }
                Ok(output) => {
                    last_error = Some(String::from_utf8_lossy(&output.stderr).trim().to_string());
                }
                Err(error) => {
                    last_error = Some(error.to_string());
                }
            }
        }

        Err(format!(
            "sqlite3 command failed: {}",
            last_error.unwrap_or_else(|| "unknown error".to_string())
        ))
    }
}

fn sqlite_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(value) = env::var("SOFTUI_SQLITE3") {
        if !value.trim().is_empty() {
            candidates.push(PathBuf::from(value));
        }
    }
    candidates.push(PathBuf::from("sqlite3"));

    let anaconda = PathBuf::from(r"E:\Anaconda\Library\bin\sqlite3.exe");
    if anaconda.exists() {
        candidates.push(anaconda);
    }
    candidates
}

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn sql_optional(value: Option<&str>) -> String {
    value.map(sql_string).unwrap_or_else(|| "NULL".to_string())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_store_persists_session_and_audit_rows() {
        let path = std::env::temp_dir().join(format!("softui-sqlite-test-{}.db", now_ms()));
        let _ = fs::remove_file(&path);
        let store = SqliteStore::new(path.clone());

        store
            .upsert_session(&SessionRow {
                id: "s1".to_string(),
                name: "bench".to_string(),
                start_time: "2026-07-23T00:00:00+08:00".to_string(),
                end_time: None,
                operator: Some("admin".to_string()),
                notes: None,
                tags_json: "[]".to_string(),
                device_ids_json: "[\"simulator:0\"]".to_string(),
                record_count: 0,
                csv_path: "s1.csv".to_string(),
            })
            .expect("session");
        store
            .insert_log(&LogRow {
                id: 1,
                timestamp_ms: 1,
                level: "info".to_string(),
                scope: "test".to_string(),
                message: "ok".to_string(),
                device_id: None,
                frame_hex: None,
            })
            .expect("log");

        assert_eq!(store.count_rows("sessions").expect("count sessions"), 1);
        assert_eq!(store.count_rows("audit_logs").expect("count logs"), 1);

        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("db-shm"));
        let _ = fs::remove_file(path.with_extension("db-wal"));
    }
}
