use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    Admin,
    Operator,
    Maintainer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    ViewDashboard,
    ConnectDevice,
    SendMotionCommand,
    RunCalibration,
    RunCycleLife,
    ManageSessions,
    ViewDiagnostics,
    ManageSettings,
    ManageUsers,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub authenticated: bool,
    pub username: String,
    pub role: Role,
    pub permissions: Vec<Permission>,
    pub must_change_password: bool,
}

impl Default for AuthSession {
    fn default() -> Self {
        Self::signed_out()
    }
}

impl AuthSession {
    pub fn signed_out() -> Self {
        Self {
            authenticated: false,
            username: String::new(),
            role: Role::Operator,
            permissions: Vec::new(),
            must_change_password: false,
        }
    }

    pub fn local_admin() -> Self {
        Self {
            authenticated: true,
            username: "local-admin".to_string(),
            role: Role::Admin,
            permissions: permissions_for_role(Role::Admin),
            must_change_password: false,
        }
    }

    pub fn for_role(username: impl Into<String>, role: Role) -> Self {
        Self::for_user(username, role, false)
    }

    pub fn for_user(username: impl Into<String>, role: Role, must_change_password: bool) -> Self {
        Self {
            authenticated: true,
            username: username.into(),
            role,
            permissions: permissions_for_role(role),
            must_change_password,
        }
    }

    pub fn has_permission(&self, permission: Permission) -> bool {
        self.authenticated && self.permissions.contains(&permission)
    }
}

pub fn permissions_for_role(role: Role) -> Vec<Permission> {
    use Permission::*;
    match role {
        Role::Admin => vec![
            ViewDashboard,
            ConnectDevice,
            SendMotionCommand,
            RunCalibration,
            RunCycleLife,
            ManageSessions,
            ViewDiagnostics,
            ManageSettings,
            ManageUsers,
        ],
        Role::Operator => vec![
            ViewDashboard,
            ConnectDevice,
            SendMotionCommand,
            RunCalibration,
            RunCycleLife,
            ManageSessions,
        ],
        Role::Maintainer => vec![
            ViewDashboard,
            ConnectDevice,
            SendMotionCommand,
            RunCalibration,
            RunCycleLife,
            ManageSessions,
            ViewDiagnostics,
            ManageSettings,
        ],
    }
}

pub fn require_permission(session: &AuthSession, permission: Permission) -> Result<(), String> {
    if session.has_permission(permission) {
        Ok(())
    } else {
        Err(format!(
            "permission denied: {:?} is required for role {:?}",
            permission, session.role
        ))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserAccount {
    pub username: String,
    pub role: Role,
    pub disabled: bool,
    pub must_change_password: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateUserRequest {
    pub username: String,
    pub password: String,
    pub role: Role,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePasswordRequest {
    pub username: Option<String>,
    pub old_password: Option<String>,
    pub new_password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserRecord {
    username: String,
    role: Role,
    disabled: bool,
    must_change_password: bool,
    password_hash: String,
}

pub struct AuthStore {
    path: PathBuf,
    users: Mutex<Vec<UserRecord>>,
    throttles: Mutex<HashMap<String, LoginThrottle>>,
}

#[derive(Debug, Clone, Default)]
struct LoginThrottle {
    failures: u32,
    locked_until_ms: u64,
}

impl AuthStore {
    pub fn load(path: PathBuf) -> Self {
        let mut users = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Vec<UserRecord>>(&raw).ok())
            .unwrap_or_default();

        if users.is_empty() {
            users.push(default_admin_record());
            if let Some(parent) = path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if let Ok(raw) = serde_json::to_string_pretty(&users) {
                let _ = fs::write(&path, raw);
            }
        }

        Self {
            path,
            users: Mutex::new(users),
            throttles: Mutex::new(HashMap::new()),
        }
    }

    pub fn list_users(&self) -> Vec<UserAccount> {
        self.users
            .lock()
            .expect("auth store poisoned")
            .iter()
            .map(public_account)
            .collect()
    }

    pub fn login(&self, request: LoginRequest) -> Result<AuthSession, String> {
        let username = request.username.trim();
        if username.is_empty() || request.password.is_empty() {
            return Err("username and password are required".to_string());
        }

        self.guard_login_window(username)?;

        let users = self
            .users
            .lock()
            .map_err(|_| "auth store poisoned".to_string())?;
        let user = users
            .iter()
            .find(|user| user.username == username)
            .ok_or_else(|| {
                self.record_login_failure(username);
                "invalid username or password".to_string()
            })?;

        if user.disabled {
            return Err("user is disabled".to_string());
        }

        if !verify_password(&user.password_hash, &request.password) {
            self.record_login_failure(username);
            return Err("invalid username or password".to_string());
        }

        self.clear_login_failures(username);
        Ok(AuthSession::for_user(
            user.username.clone(),
            user.role,
            user.must_change_password,
        ))
    }

    pub fn create_user(&self, request: CreateUserRequest) -> Result<UserAccount, String> {
        let username = normalize_username(&request.username)?;
        validate_password(&request.password)?;

        let mut users = self
            .users
            .lock()
            .map_err(|_| "auth store poisoned".to_string())?;
        if users.iter().any(|user| user.username == username) {
            return Err("user already exists".to_string());
        }

        let record = UserRecord {
            username,
            role: request.role,
            disabled: false,
            must_change_password: false,
            password_hash: hash_password(&request.password)?,
        };
        let account = public_account(&record);
        users.push(record);
        self.persist_locked(&users)?;
        Ok(account)
    }

    pub fn change_password(
        &self,
        session: &AuthSession,
        request: ChangePasswordRequest,
    ) -> Result<(), String> {
        validate_password(&request.new_password)?;

        let target_username = request
            .username
            .clone()
            .unwrap_or_else(|| session.username.clone());
        if target_username.trim().is_empty() {
            return Err("target username is required".to_string());
        }

        let changing_self = target_username == session.username;
        if !changing_self {
            require_permission(session, Permission::ManageUsers)?;
        }

        let mut users = self
            .users
            .lock()
            .map_err(|_| "auth store poisoned".to_string())?;
        let user = users
            .iter_mut()
            .find(|user| user.username == target_username)
            .ok_or_else(|| "user not found".to_string())?;

        if changing_self {
            let old_password = request
                .old_password
                .as_deref()
                .ok_or_else(|| "old password is required".to_string())?;
            if !verify_password(&user.password_hash, old_password) {
                return Err("old password is incorrect".to_string());
            }
        }

        user.password_hash = hash_password(&request.new_password)?;
        user.must_change_password = false;
        self.persist_locked(&users)
    }

    pub fn set_disabled(&self, username: String, disabled: bool) -> Result<UserAccount, String> {
        let mut users = self
            .users
            .lock()
            .map_err(|_| "auth store poisoned".to_string())?;
        let user = users
            .iter_mut()
            .find(|user| user.username == username)
            .ok_or_else(|| "user not found".to_string())?;
        user.disabled = disabled;
        let account = public_account(user);
        self.persist_locked(&users)?;
        Ok(account)
    }

    fn persist_locked(&self, users: &[UserRecord]) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let raw = serde_json::to_string_pretty(users).map_err(|error| error.to_string())?;
        fs::write(&self.path, raw).map_err(|error| error.to_string())
    }

    fn guard_login_window(&self, username: &str) -> Result<(), String> {
        let now = now_ms();
        let throttles = self
            .throttles
            .lock()
            .map_err(|_| "auth throttle poisoned".to_string())?;
        if let Some(throttle) = throttles.get(username) {
            if throttle.locked_until_ms > now {
                let remaining = ((throttle.locked_until_ms - now) / 1000).max(1);
                return Err(format!(
                    "too many failed login attempts; retry in {remaining}s"
                ));
            }
        }
        Ok(())
    }

    fn record_login_failure(&self, username: &str) {
        if let Ok(mut throttles) = self.throttles.lock() {
            let entry = throttles.entry(username.to_string()).or_default();
            entry.failures = entry.failures.saturating_add(1);
            if entry.failures >= 5 {
                entry.locked_until_ms = now_ms().saturating_add(60_000);
            }
        }
    }

    fn clear_login_failures(&self, username: &str) {
        if let Ok(mut throttles) = self.throttles.lock() {
            throttles.remove(username);
        }
    }
}

fn public_account(user: &UserRecord) -> UserAccount {
    UserAccount {
        username: user.username.clone(),
        role: user.role,
        disabled: user.disabled,
        must_change_password: user.must_change_password,
    }
}

fn default_admin_record() -> UserRecord {
    UserRecord {
        username: "admin".to_string(),
        role: Role::Admin,
        disabled: false,
        must_change_password: true,
        password_hash: hash_password("admin123").expect("default admin hash should be valid"),
    }
}

fn normalize_username(username: &str) -> Result<String, String> {
    let normalized = username.trim().to_string();
    if normalized.len() < 2 || normalized.len() > 32 {
        return Err("username length must be between 2 and 32".to_string());
    }
    if !normalized
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err("username may only contain letters, numbers, '_' and '-'".to_string());
    }
    Ok(normalized)
}

fn validate_password(password: &str) -> Result<(), String> {
    if password.len() < 8 {
        return Err("password must contain at least 8 characters".to_string());
    }
    Ok(())
}

fn hash_password(password: &str) -> Result<String, String> {
    let salt = format!("{:016x}", now_ms() ^ ((std::process::id() as u64) << 32));
    let digest = password_digest(password, &salt, 120_000);
    Ok(format!("softui-local-v1$120000${salt}${digest:016x}"))
}

fn verify_password(hash: &str, password: &str) -> bool {
    let parts = hash.split('$').collect::<Vec<_>>();
    if parts.len() != 4 || parts[0] != "softui-local-v1" {
        return false;
    }
    let Ok(iterations) = parts[1].parse::<u32>() else {
        return false;
    };
    let Ok(expected) = u64::from_str_radix(parts[3], 16) else {
        return false;
    };
    let actual = password_digest(password, parts[2], iterations);
    actual == expected
}

fn password_digest(password: &str, salt: &str, iterations: u32) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for _ in 0..iterations.max(1) {
        for byte in salt.bytes().chain(password.bytes()) {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(0x100000001b3);
            hash ^= hash.rotate_left(13);
        }
        hash ^= (password.len() as u64).rotate_left(7);
        hash = hash.wrapping_mul(0x9e3779b185ebca87);
    }
    hash
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

    #[test]
    fn admin_has_user_management_permission() {
        let session = AuthSession::local_admin();
        assert!(session.has_permission(Permission::ManageUsers));
    }

    #[test]
    fn default_session_is_signed_out() {
        let session = AuthSession::default();
        assert!(!session.authenticated);
        assert!(session.permissions.is_empty());
    }

    #[test]
    fn operator_cannot_manage_settings_or_users() {
        let session = AuthSession::for_role("op", Role::Operator);
        assert!(!session.has_permission(Permission::ManageSettings));
        assert!(!session.has_permission(Permission::ManageUsers));
    }

    #[test]
    fn permission_guard_rejects_missing_permission() {
        let session = AuthSession::for_role("op", Role::Operator);
        let result = require_permission(&session, Permission::ViewDiagnostics);
        assert!(result.is_err());
    }

    fn test_auth_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "softui-auth-test-{}-{name}.json",
            std::process::id()
        ))
    }

    #[test]
    fn auth_store_creates_default_admin() {
        let path = test_auth_path("default-admin");
        let _ = fs::remove_file(&path);

        let store = AuthStore::load(path.clone());
        let users = store.list_users();

        assert_eq!(users.len(), 1);
        assert_eq!(users[0].username, "admin");
        assert_eq!(users[0].role, Role::Admin);
        assert!(users[0].must_change_password);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn auth_store_logs_in_and_rejects_bad_password() {
        let path = test_auth_path("login");
        let _ = fs::remove_file(&path);
        let store = AuthStore::load(path.clone());

        assert!(store
            .login(LoginRequest {
                username: "admin".to_string(),
                password: "wrong".to_string(),
            })
            .is_err());
        let session = store
            .login(LoginRequest {
                username: "admin".to_string(),
                password: "admin123".to_string(),
            })
            .expect("login");

        assert!(session.authenticated);
        assert_eq!(session.role, Role::Admin);
        assert!(session.must_change_password);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn auth_store_creates_user_and_changes_password() {
        let path = test_auth_path("create-change");
        let _ = fs::remove_file(&path);
        let store = AuthStore::load(path.clone());
        let admin = AuthSession::local_admin();

        let account = store
            .create_user(CreateUserRequest {
                username: "operator_1".to_string(),
                password: "operator123".to_string(),
                role: Role::Operator,
            })
            .expect("create user");
        assert_eq!(account.role, Role::Operator);

        let session = store
            .login(LoginRequest {
                username: "operator_1".to_string(),
                password: "operator123".to_string(),
            })
            .expect("operator login");
        store
            .change_password(
                &session,
                ChangePasswordRequest {
                    username: None,
                    old_password: Some("operator123".to_string()),
                    new_password: "operator456".to_string(),
                },
            )
            .expect("self password change");
        store
            .change_password(
                &admin,
                ChangePasswordRequest {
                    username: Some("operator_1".to_string()),
                    old_password: None,
                    new_password: "operator789".to_string(),
                },
            )
            .expect("admin password reset");

        let _ = fs::remove_file(path);
    }
}
