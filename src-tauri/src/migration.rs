use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationPreview {
    pub source_dir: String,
    pub target_dir: String,
    pub exists: bool,
    pub user_files: usize,
    pub config_files: usize,
    pub csv_files: usize,
    pub log_files: usize,
    pub skipped_files: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationReport {
    pub preview: LegacyMigrationPreview,
    pub copied_files: usize,
    pub report_path: String,
}

pub fn preview_legacy_migration(
    source_dir: PathBuf,
    target_dir: PathBuf,
) -> LegacyMigrationPreview {
    let mut preview = LegacyMigrationPreview {
        source_dir: source_dir.to_string_lossy().to_string(),
        target_dir: target_dir.to_string_lossy().to_string(),
        exists: source_dir.exists(),
        user_files: 0,
        config_files: 0,
        csv_files: 0,
        log_files: 0,
        skipped_files: 0,
        warnings: Vec::new(),
    };

    if !preview.exists {
        preview
            .warnings
            .push("legacy source directory does not exist".to_string());
        return preview;
    }

    for path in collect_files(&source_dir) {
        classify_file(&path, &mut preview);
    }

    preview
}

pub fn run_legacy_migration(
    source_dir: PathBuf,
    target_dir: PathBuf,
) -> Result<LegacyMigrationReport, String> {
    let preview = preview_legacy_migration(source_dir.clone(), target_dir.clone());
    if !preview.exists {
        return Err("legacy source directory does not exist".to_string());
    }

    let archive_dir = target_dir.join(format!("legacy-import-{}", now_ms()));
    fs::create_dir_all(&archive_dir).map_err(|error| error.to_string())?;

    let mut copied_files = 0usize;
    for path in collect_files(&source_dir) {
        if !should_copy(&path) {
            continue;
        }
        let relative = path.strip_prefix(&source_dir).unwrap_or(&path);
        let target = archive_dir.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::copy(&path, &target).map_err(|error| error.to_string())?;
        copied_files = copied_files.saturating_add(1);
    }

    let report = LegacyMigrationReport {
        preview,
        copied_files,
        report_path: archive_dir
            .join("migration-report.json")
            .to_string_lossy()
            .to_string(),
    };
    let report_json = serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?;
    fs::write(&report.report_path, report_json).map_err(|error| error.to_string())?;
    Ok(report)
}

fn collect_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_files_inner(root, &mut files);
    files
}

fn collect_files_inner(root: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files_inner(&path, files);
        } else if path.is_file() {
            files.push(path);
        }
    }
}

fn classify_file(path: &Path, preview: &mut LegacyMigrationPreview) {
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        preview.skipped_files = preview.skipped_files.saturating_add(1);
        return;
    };
    let lower = file_name.to_ascii_lowercase();
    if lower == "users.json" {
        preview.user_files = preview.user_files.saturating_add(1);
        preview.warnings.push(
            "legacy users.json detected; weak hashes must be upgraded on first login".to_string(),
        );
    } else if lower.ends_with(".json") || lower.ends_with(".ini") || lower.ends_with(".toml") {
        preview.config_files = preview.config_files.saturating_add(1);
    } else if lower.ends_with(".csv") {
        preview.csv_files = preview.csv_files.saturating_add(1);
    } else if lower.ends_with(".log") || lower.ends_with(".txt") {
        preview.log_files = preview.log_files.saturating_add(1);
    } else {
        preview.skipped_files = preview.skipped_files.saturating_add(1);
    }
}

fn should_copy(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| {
            let lower = name.to_ascii_lowercase();
            lower == "users.json"
                || lower.ends_with(".json")
                || lower.ends_with(".ini")
                || lower.ends_with(".toml")
                || lower.ends_with(".csv")
                || lower.ends_with(".log")
                || lower.ends_with(".txt")
        })
        .unwrap_or(false)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "softui-migration-test-{}-{name}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create test dir");
        path
    }

    #[test]
    fn preview_counts_legacy_files() {
        let source = test_dir("preview-source");
        let target = test_dir("preview-target");
        fs::write(source.join("users.json"), "{}").expect("users");
        fs::write(source.join("sample.csv"), "a,b").expect("csv");
        fs::write(source.join("run.log"), "log").expect("log");
        fs::write(source.join("cache.bin"), [0u8]).expect("skip");

        let preview = preview_legacy_migration(source.clone(), target.clone());

        assert!(preview.exists);
        assert_eq!(preview.user_files, 1);
        assert_eq!(preview.csv_files, 1);
        assert_eq!(preview.log_files, 1);
        assert_eq!(preview.skipped_files, 1);

        let _ = fs::remove_dir_all(source);
        let _ = fs::remove_dir_all(target);
    }

    #[test]
    fn run_migration_copies_only_supported_files() {
        let source = test_dir("run-source");
        let target = test_dir("run-target");
        fs::create_dir_all(source.join("nested")).expect("nested");
        fs::write(source.join("nested").join("session.csv"), "a,b").expect("csv");
        fs::write(source.join("cache.bin"), [0u8]).expect("skip");

        let report = run_legacy_migration(source.clone(), target.clone()).expect("migration");

        assert_eq!(report.copied_files, 1);
        assert!(PathBuf::from(report.report_path).exists());

        let _ = fs::remove_dir_all(source);
        let _ = fs::remove_dir_all(target);
    }
}
