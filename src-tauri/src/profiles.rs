use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub port: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub parity: String,
    pub stop_bits: u8,
    pub flow_control: String,
    pub auto_reconnect: bool,
}

pub struct ProfileStore {
    path: PathBuf,
    profiles: Mutex<Vec<ConnectionProfile>>,
}

impl ProfileStore {
    pub fn load(path: PathBuf) -> Self {
        let profiles = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Vec<ConnectionProfile>>(&raw).ok())
            .unwrap_or_else(default_profiles);

        Self {
            path,
            profiles: Mutex::new(profiles),
        }
    }

    pub fn list(&self) -> Vec<ConnectionProfile> {
        self.profiles
            .lock()
            .expect("profile store poisoned")
            .clone()
    }

    pub fn save(&self, profile: ConnectionProfile) -> Result<ConnectionProfile, String> {
        let mut profiles = self.profiles.lock().expect("profile store poisoned");
        // Replace existing profile with same id, or append
        if let Some(pos) = profiles.iter().position(|p| p.id == profile.id) {
            profiles[pos] = profile.clone();
        } else {
            profiles.push(profile.clone());
        }
        self.persist_locked(&profiles)?;
        Ok(profile)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut profiles = self.profiles.lock().expect("profile store poisoned");
        profiles.retain(|p| p.id != id);
        self.persist_locked(&profiles)
    }

    fn persist_locked(&self, profiles: &[ConnectionProfile]) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let raw = serde_json::to_string_pretty(profiles).map_err(|err| err.to_string())?;
        fs::write(&self.path, raw).map_err(|err| err.to_string())
    }
}

fn default_profiles() -> Vec<ConnectionProfile> {
    vec![
        ConnectionProfile {
            id: "sim-default".to_string(),
            name: "Simulator".to_string(),
            port: "SIM".to_string(),
            baud_rate: 115_200,
            data_bits: 8,
            parity: "none".to_string(),
            stop_bits: 1,
            flow_control: "none".to_string(),
            auto_reconnect: true,
        },
        ConnectionProfile {
            id: "serial-9600".to_string(),
            name: "Legacy USB".to_string(),
            port: "COM3".to_string(),
            baud_rate: 9_600,
            data_bits: 8,
            parity: "none".to_string(),
            stop_bits: 1,
            flow_control: "none".to_string(),
            auto_reconnect: false,
        },
    ]
}
