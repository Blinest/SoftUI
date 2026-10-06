use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
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

/// 角色 → 权限。设计目标是**每个角色都有独占职责**，不留概念空转的角色：
///
/// | 角色       | 职责                                                   |
/// |------------|--------------------------------------------------------|
/// | operator   | 只读 + 操作：看仪表盘、连设备、下发运动指令             |
/// | maintainer | 维护：录制/回放/导出会话、校准、参数整定、循环寿命、诊断 |
/// | admin      | 管理：账号与设备访问                                    |
///
/// 两处关键取舍：
/// 1. **校准（RunCalibration）与循环寿命（RunCycleLife）不给 operator** ——
///    校准会改写传感器基线、循环寿命会持续往复磨损臂体，都改变设备行为。
/// 2. **会话管理（ManageSessions）不给 operator** —— 录制/回放/导出会在服务端
///    留下数据（以及 SQLite 落库），属于维护与实验职责，不是日常操作。
///    于是 operator 被压到最小：**看、连、下发指令**，三件事。
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
        ],
        Role::Maintainer => vec![
            ViewDashboard,
            ConnectDevice,
            SendMotionCommand,
            // ↓ 以下五项是 maintainer 相对 operator 的独占职责
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
    /// 自助注册后等待管理员审批。为 true 时**不能登录**。
    ///
    /// 为什么不复用 `disabled`：两者语义不同 —— `disabled` 是管理员主动停用，
    /// 后台要能分开看「待审批的人」和「已被停用的人」。
    pub pending: bool,
    /// 该账号允许同时在线的设备台数，`0` 表示不限。
    /// 这就是"管理设备的访问"里可调的那一档：一人一机、还是一人多机。
    #[serde(default)]
    pub max_devices: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
    /// 客户端（设备）自报的稳定标识，由浏览器桩生成并存 sessionStorage。
    /// 用来把"这条会话"和"哪台设备"关联起来，管理员才能按设备踢人。
    #[serde(default)]
    pub client_id: Option<String>,
    /// 设备显示名，例如「桌面」「手机」。仅用于后台列表展示。
    #[serde(default)]
    pub label: Option<String>,
}

/// `login` 的返回值：除了会话本身，还必须把 token 交给客户端保存。
///
/// 为什么不能只返回 `AuthSession`：token 是**这台设备**的身份凭证，
/// 客户端要把它存进 localStorage 并随每次请求带回，服务端才能区分设备。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    pub token: String,
    pub session: AuthSession,
    /// 当前账号的设备上限（0 = 不限）与已在线台数，便于界面提示。
    pub device_limit: u32,
    pub active_devices: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateUserRequest {
    pub username: String,
    pub password: String,
    pub role: Role,
    /// 不传 = 不限设备。老前端（不带该字段）依然可用。
    #[serde(default)]
    pub max_devices: Option<u32>,
}

/// 自助注册请求。只有用户名和口令 —— 角色由服务端定死为 `operator`，
/// 否则任何人都能注册出一个 admin。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRequest {
    pub username: String,
    pub password: String,
}

/// 自助注册开关。
///
/// 默认 `Approval`：这套系统的指令能真的让臂体运动，公网开放"注册即可用"
/// 等于把控制权交给任意访客。所以默认先进待审批队列。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RegistrationMode {
    /// 关闭自助注册，只能由管理员建号
    Closed,
    /// 注册后需管理员审批（默认）
    Approval,
    /// 注册即可登录（仅在明确信任来访者时使用）
    Open,
}

/// `auth-config.json` 的格式。单独存一个文件，避免动 `auth-users.json`
/// 里"用户数组"这个既有格式。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistrationConfig {
    #[serde(default = "default_registration_mode")]
    mode: RegistrationMode,
}

fn default_registration_mode() -> RegistrationMode {
    RegistrationMode::Approval
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
    /// 老 `auth-users.json` 没有这个字段，缺省按"不限设备"读入。
    #[serde(default)]
    max_devices: u32,
    /// 自助注册待审批。老文件没有该字段 → 默认视为已审批，不影响既有账号。
    #[serde(default)]
    pending: bool,
    password_hash: String,
}

pub struct AuthStore {
    path: PathBuf,
    /// 注册开关的落盘位置（`auth-config.json`），与用户表分开存。
    registration_path: PathBuf,
    users: Mutex<Vec<UserRecord>>,
    throttles: Mutex<HashMap<String, LoginThrottle>>,
    registration: Mutex<RegistrationMode>,
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

        // 注册开关单独存一个文件，避免动 auth-users.json 里"用户数组"这个既有格式。
        // 文件名由用户表**派生**（auth-users.json → auth-users-config.json）：
        // 这样单元测试各自用不同的临时文件名时，也不会串到同一个配置文件上。
        let registration_path = {
            let stem = path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("auth-users");
            path.with_file_name(format!("{stem}-config.json"))
        };
        let registration_mode = fs::read_to_string(&registration_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<RegistrationConfig>(&raw).ok())
            .map(|config| config.mode)
            .unwrap_or_else(default_registration_mode);

        Self {
            path,
            registration_path: registration_path.clone(),
            registration: Mutex::new(registration_mode),
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

        // 待审批账号同样不能登录。这里必须**在签发 token 之前**拦住，
        // 否则待审批的人也能拿到凭证。
        if user.pending {
            return Err("账号正在等待管理员审批，暂时无法登录".to_string());
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
            max_devices: request.max_devices.unwrap_or(0),
            // 管理员建的号直接可用，不需要审批
            pending: false,
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

    /// 读取账号的设备上限（账号不存在时返回 0 = 不限）。
    pub fn max_devices(&self, username: &str) -> u32 {
        self.users
            .lock()
            .ok()
            .and_then(|users| {
                users
                    .iter()
                    .find(|user| user.username == username)
                    .map(|user| user.max_devices)
            })
            .unwrap_or(0)
    }

    /// 设置账号的设备上限。`0` = 不限。
    pub fn set_max_devices(&self, username: &str, max_devices: u32) -> Result<UserAccount, String> {
        let mut users = self
            .users
            .lock()
            .map_err(|_| "auth store poisoned".to_string())?;
        let user = users
            .iter_mut()
            .find(|user| user.username == username)
            .ok_or_else(|| "user not found".to_string())?;
        user.max_devices = max_devices;
        let account = public_account(user);
        self.persist_locked(&users)?;
        Ok(account)
    }

    /* ── 自助注册 ───────────────────────────────────────────────────── */

    pub fn registration_mode(&self) -> RegistrationMode {
        self.registration
            .lock()
            .map(|mode| *mode)
            .unwrap_or(RegistrationMode::Approval)
    }

    pub fn set_registration_mode(&self, mode: RegistrationMode) -> Result<RegistrationMode, String> {
        {
            let mut current = self
                .registration
                .lock()
                .map_err(|_| "registration mode poisoned".to_string())?;
            *current = mode;
        }
        if let Some(parent) = self.registration_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let raw = serde_json::to_string_pretty(&RegistrationConfig { mode })
            .map_err(|error| error.to_string())?;
        fs::write(&self.registration_path, raw).map_err(|error| error.to_string())?;
        Ok(mode)
    }

    /// 待审批人数（后台要显示这个数字，管理员才知道有没有人等着）。
    pub fn pending_count(&self) -> usize {
        self.users
            .lock()
            .map(|users| users.iter().filter(|user| user.pending).count())
            .unwrap_or(0)
    }

    /// 自助注册。`client_key` 用于限流，由调用方传客户端 IP。
    pub fn register(
        &self,
        request: RegisterRequest,
        client_key: &str,
    ) -> Result<UserAccount, String> {
        let mode = self.registration_mode();
        if mode == RegistrationMode::Closed {
            return Err("本站已关闭自助注册，请联系管理员开通账号".to_string());
        }

        // 注册是**匿名**入口，必须复用登录那套限流，否则会被拿来刷账号
        self.guard_login_window(client_key)?;

        let username = normalize_username(&request.username)?;
        validate_password(&request.password)?;

        let mut users = self
            .users
            .lock()
            .map_err(|_| "auth store poisoned".to_string())?;
        if users.iter().any(|user| user.username == username) {
            drop(users);
            self.record_login_failure(client_key);
            return Err("该用户名已被占用".to_string());
        }

        let record = UserRecord {
            username,
            // 角色由服务端定死为 operator：自助注册不允许自己提权
            role: Role::Operator,
            disabled: false,
            pending: mode == RegistrationMode::Approval,
            must_change_password: false,
            max_devices: 0,
            password_hash: hash_password(&request.password)?,
        };
        let account = public_account(&record);
        users.push(record);
        self.persist_locked(&users)?;
        drop(users);
        self.clear_login_failures(client_key);
        Ok(account)
    }

    /// 审批通过：清掉 pending 标记，账号才能登录。
    pub fn approve(&self, username: &str) -> Result<UserAccount, String> {
        let mut users = self
            .users
            .lock()
            .map_err(|_| "auth store poisoned".to_string())?;
        let user = users
            .iter_mut()
            .find(|user| user.username == username)
            .ok_or_else(|| "user not found".to_string())?;
        user.pending = false;
        let account = public_account(user);
        self.persist_locked(&users)?;
        Ok(account)
    }

    /// 修改账号角色。
    ///
    /// 两条保命规则（都为了不把自己锁在门外）：
    ///   - 不能把**最后一个可登录的管理员**降级 —— 否则再没人能管账号
    ///   - 目标不存在时报错，不静默成功
    pub fn set_role(&self, username: &str, role: Role) -> Result<UserAccount, String> {
        let mut users = self
            .users
            .lock()
            .map_err(|_| "auth store poisoned".to_string())?;
        let index = users
            .iter()
            .position(|user| user.username == username)
            .ok_or_else(|| "user not found".to_string())?;

        if users[index].role == Role::Admin
            && role != Role::Admin
            && users[index].disabled == false
            && users[index].pending == false
            && active_admin_count(&users) <= 1
        {
            return Err("这是最后一个可用管理员，不能降级".to_string());
        }

        users[index].role = role;
        let account = public_account(&users[index]);
        self.persist_locked(&users)?;
        Ok(account)
    }

    /// 删除账号。调用方负责先确认"不是自己"（需要知道当前登录者是谁）。
    ///
    /// 保命规则：不能删掉**最后一个可登录的管理员**。
    pub fn delete_user(&self, username: &str) -> Result<(), String> {
        let mut users = self
            .users
            .lock()
            .map_err(|_| "auth store poisoned".to_string())?;
        let index = users
            .iter()
            .position(|user| user.username == username)
            .ok_or_else(|| "user not found".to_string())?;

        if users[index].role == Role::Admin
            && users[index].disabled == false
            && users[index].pending == false
            && active_admin_count(&users) <= 1
        {
            return Err("这是最后一个可用管理员，不能删除".to_string());
        }

        users.remove(index);
        self.persist_locked(&users)
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

/// 还能正常登录的管理员数量。
/// 用来做"不能删掉 / 降级最后一个管理员"这类保命判断 —— 判据要排除已停用和待审批的，
/// 因为他们实际上进不来，不算"还能管账号的人"。
fn active_admin_count(users: &[UserRecord]) -> usize {
    users
        .iter()
        .filter(|user| user.role == Role::Admin && !user.disabled && !user.pending)
        .count()
}

fn public_account(user: &UserRecord) -> UserAccount {
    UserAccount {
        username: user.username.clone(),
        role: user.role,
        disabled: user.disabled,
        must_change_password: user.must_change_password,
        pending: user.pending,
        max_devices: user.max_devices,
    }
}

fn default_admin_record() -> UserRecord {
    UserRecord {
        username: "admin".to_string(),
        role: Role::Admin,
        disabled: false,
        must_change_password: true,
        max_devices: 0,
        pending: false,
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
    // 原为 8 位。按部署方要求放宽到 4 位，便于使用简短口令。
    // 注意：这是一处**安全策略放宽**，公网部署时应评估是否可接受。
    if password.len() < 4 {
        return Err("password must contain at least 4 characters".to_string());
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

/* ── 会话注册表：按 token 隔离多设备登录 ───────────────────────────────
 * 背景（部署实录「已知问题 1」）：原来 `AppState.auth_session` 只存**一份**，
 * 于是任何一台设备登录后，后端整体变成"已登录"，其他设备一打开就直接进去了。
 *
 * 现在每台设备持有自己的 token，服务端按 token 解析会话：
 *   - 权限互不影响（手机端可以只登录 observer 账号）
 *   - 管理员能看到"谁在哪台设备上"，并能单独踢掉某一台
 *   - 数据仍然只有一份（设备表 / 环形缓冲 / 录制都在 AppState 里共享），
 *     所以"多用户同步调用一份数据"这件事不需要额外机制
 *
 * 会话持久化到 `data/sessions.json`：网关重启（每次部署都要重启）后各端不必
 * 重新登录。文件里是明文 token —— 与同目录的 auth-users.json 同属受信数据
 * 目录，且 8787 只监听回环，公网到不了。
 * ──────────────────────────────────────────────────────────────────── */

/// 判定「在线」的活动窗口：超过这段时间没有任何请求，后台列表标为离线。
pub const ONLINE_WINDOW_MS: u64 = 60_000;

/// 空闲多久之后自动清理会话（7 天），避免 sessions.json 无限增长。
pub const SESSION_IDLE_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRecord {
    token: String,
    username: String,
    role: Role,
    must_change_password: bool,
    client_id: String,
    label: String,
    ip: String,
    user_agent: String,
    created_at_ms: u64,
    last_seen_ms: u64,
}

/// 后台「设备访问」列表的一行。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientSessionView {
    /// token 前缀。踢下线时用它定位，避免把完整 token 下发到前端与日志。
    pub session_id: String,
    pub username: String,
    pub role: Role,
    pub label: String,
    pub client_id: String,
    pub ip: String,
    pub user_agent: String,
    pub created_at_ms: u64,
    pub last_seen_ms: u64,
    pub online: bool,
}

pub struct SessionStore {
    path: PathBuf,
    sessions: Mutex<HashMap<String, SessionRecord>>,
}

static TOKEN_COUNTER: AtomicU64 = AtomicU64::new(0);

/// 进程级随机盐：让 token 无法由"当前时间 + pid"猜出来。
fn process_salt() -> u64 {
    static SALT: OnceLock<u64> = OnceLock::new();
    *SALT.get_or_init(|| {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        // 再混入一次堆地址，避免同秒内不同进程撞盐
        let probe = Box::new(0u8);
        let addr = &*probe as *const u8 as u64;
        password_digest(
            &format!("{nanos}:{addr}:{}", std::process::id()),
            "softui-session-salt",
            32,
        )
    })
}

/// 128 位 token：两次同源哈希拼接，输入含进程盐、纳秒、自增序号。
fn make_token(username: &str) -> String {
    let now = now_ms();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    let seq = TOKEN_COUNTER.fetch_add(1, Ordering::Relaxed);
    let seed = format!("{now}:{nanos}:{}:{seq}:{username}", process_salt());
    let a = password_digest(&seed, "softui-token-a", 64);
    let b = password_digest(&seed, "softui-token-b", 64);
    format!("{a:016x}{b:016x}")
}

impl SessionStore {
    pub fn load(path: PathBuf) -> Self {
        let now = now_ms();
        let sessions: HashMap<String, SessionRecord> = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Vec<SessionRecord>>(&raw).ok())
            .unwrap_or_default()
            .into_iter()
            // 载入时顺手清掉过期会话，省得再起一个定时线程
            .filter(|record| now.saturating_sub(record.last_seen_ms) < SESSION_IDLE_TTL_MS)
            .map(|record| (record.token.clone(), record))
            .collect();
        Self {
            path,
            sessions: Mutex::new(sessions),
        }
    }

    /// 为一次成功登录登记会话，返回该设备的 token。
    pub fn create(
        &self,
        session: &AuthSession,
        client_id: String,
        label: String,
        ip: String,
        user_agent: String,
    ) -> Result<String, String> {
        let now = now_ms();
        let token = make_token(&session.username);
        let record = SessionRecord {
            token: token.clone(),
            username: session.username.clone(),
            role: session.role,
            must_change_password: session.must_change_password,
            client_id,
            label,
            ip,
            user_agent,
            created_at_ms: now,
            last_seen_ms: now,
        };
        let mut map = self
            .sessions
            .lock()
            .map_err(|_| "session store poisoned".to_string())?;
        map.insert(token.clone(), record);
        self.prune_locked(&mut map, now);
        // 落盘的时机只有"登录/踢人"两处，不跟着热路径写盘
        let _ = self.persist_locked(&map);
        Ok(token)
    }

    /// 按 token 解析会话，顺带刷新 `last_seen_ms` —— 后台列表的「最近活动」就来自这里，
    /// 前端每 500ms 一次的 `bootstrap_state` 就足以当心跳，不需要另开通道。
    pub fn resolve(&self, token: &str) -> Option<AuthSession> {
        let mut map = self.sessions.lock().ok()?;
        let record = map.get_mut(token)?;
        record.last_seen_ms = now_ms();
        Some(AuthSession::for_user(
            record.username.clone(),
            record.role,
            record.must_change_password,
        ))
    }

    /// 按 `session_id`（token 前缀）踢掉一台设备。
    pub fn revoke(&self, session_id: &str) -> Result<usize, String> {
        if session_id.trim().is_empty() {
            return Err("session id is required".to_string());
        }
        let mut map = self
            .sessions
            .lock()
            .map_err(|_| "session store poisoned".to_string())?;
        let before = map.len();
        map.retain(|token, _| !token.starts_with(session_id));
        let removed = before - map.len();
        if removed == 0 {
            return Err("session not found".to_string());
        }
        let _ = self.persist_locked(&map);
        Ok(removed)
    }

    /// 踢掉某个账号的全部设备（禁用账号 / 改密码时用）。
    pub fn revoke_user(&self, username: &str) -> usize {
        let Ok(mut map) = self.sessions.lock() else {
            return 0;
        };
        let before = map.len();
        map.retain(|_, record| record.username != username);
        let removed = before - map.len();
        if removed > 0 {
            let _ = self.persist_locked(&map);
        }
        removed
    }

    /// 该账号当前在线的设备台数（按「在线窗口」判定，而不是历史登录数）。
    pub fn active_count_for_user(&self, username: &str) -> usize {
        let now = now_ms();
        self.sessions
            .lock()
            .map(|map| {
                map.values()
                    .filter(|record| {
                        record.username == username
                            && now.saturating_sub(record.last_seen_ms) < ONLINE_WINDOW_MS
                    })
                    .count()
            })
            .unwrap_or(0)
    }

    pub fn list(&self) -> Vec<ClientSessionView> {
        let now = now_ms();
        let mut rows: Vec<ClientSessionView> = self
            .sessions
            .lock()
            .map(|map| {
                map.values()
                    .map(|record| ClientSessionView {
                        session_id: record.token.chars().take(12).collect(),
                        username: record.username.clone(),
                        role: record.role,
                        label: record.label.clone(),
                        client_id: record.client_id.clone(),
                        ip: record.ip.clone(),
                        user_agent: record.user_agent.clone(),
                        created_at_ms: record.created_at_ms,
                        last_seen_ms: record.last_seen_ms,
                        online: now.saturating_sub(record.last_seen_ms) < ONLINE_WINDOW_MS,
                    })
                    .collect()
            })
            .unwrap_or_default();
        // 在线的排前面，其次按最近活动倒序 —— 后台一眼看到"现在谁在用"
        rows.sort_by(|a, b| {
            b.online
                .cmp(&a.online)
                .then(b.last_seen_ms.cmp(&a.last_seen_ms))
        });
        rows
    }

    /// 某个账号自己的会话列表 —— 前台「我的账号」用它显示"我在哪些设备上登录着"。
    /// 直接复用 `list()` 再按用户名过滤，避免两份视图构造逻辑各自漂移。
    pub fn list_for_user(&self, username: &str) -> Vec<ClientSessionView> {
        self.list()
            .into_iter()
            .filter(|row| row.username == username)
            .collect()
    }

    /// 自助踢下线的**安全版本**：只允许踢掉属于该账号的会话。
    ///
    /// 与 `revoke` 的唯一区别就是这道归属校验 —— 否则任何登录用户都能拿一个
    /// 猜到的 sessionId 去踢别人（sessionId 只是 token 前 12 位，不该被当成
    /// 权限边界）。
    pub fn revoke_owned(&self, session_id: &str, username: &str) -> Result<usize, String> {
        if session_id.trim().is_empty() {
            return Err("session id is required".to_string());
        }
        let mut map = self
            .sessions
            .lock()
            .map_err(|_| "session store poisoned".to_string())?;
        let before = map.len();
        map.retain(|token, record| {
            !(token.starts_with(session_id) && record.username == username)
        });
        let removed = before - map.len();
        if removed == 0 {
            return Err("session not found".to_string());
        }
        let _ = self.persist_locked(&map);
        Ok(removed)
    }

    /// 角色变更后同步到该账号**已登录**的会话，让改动立即生效。
    ///
    /// 为什么必须做：`SessionRecord.role` 是**登录那一刻**的快照。不同步的话，
    /// 被降级的人会拿着旧角色一直用到会话过期（7 天）—— 权限变更等于没生效，
    /// 这在"降低某人权限"的场景下是绝对不能接受的。
    pub fn update_role(&self, username: &str, role: Role) -> usize {
        let Ok(mut map) = self.sessions.lock() else {
            return 0;
        };
        let mut touched = 0;
        for record in map.values_mut() {
            if record.username == username {
                record.role = role;
                touched += 1;
            }
        }
        if touched > 0 {
            let _ = self.persist_locked(&map);
        }
        touched
    }

    /// 密码已改：清掉该账号所有会话的"必须改密"标记。
    /// （会话记录才是 `must_change_password` 的真源，`AuthSession` 由它派生。）
    pub fn mark_password_changed(&self, username: &str) {
        let Ok(mut map) = self.sessions.lock() else {
            return;
        };
        let mut changed = false;
        for record in map.values_mut() {
            if record.username == username && record.must_change_password {
                record.must_change_password = false;
                changed = true;
            }
        }
        if changed {
            let _ = self.persist_locked(&map);
        }
    }

    fn prune_locked(&self, map: &mut HashMap<String, SessionRecord>, now: u64) {
        map.retain(|_, record| now.saturating_sub(record.last_seen_ms) < SESSION_IDLE_TTL_MS);
    }

    fn persist_locked(&self, map: &HashMap<String, SessionRecord>) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut records: Vec<&SessionRecord> = map.values().collect();
        records.sort_by_key(|record| record.created_at_ms);
        let raw = serde_json::to_string_pretty(&records).map_err(|error| error.to_string())?;
        fs::write(&self.path, raw).map_err(|error| error.to_string())
    }
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
    fn roles_have_disjoint_exclusive_duties() {
        // 设计目标：每个角色都要有"只有我能做"的事，不留概念空转的角色。
        // 这个测试就是防它回归成"maintainer 没职责"。
        let operator = permissions_for_role(Role::Operator);
        let maintainer = permissions_for_role(Role::Maintainer);
        let admin = permissions_for_role(Role::Admin);

        // 校准 / 循环寿命会改变设备行为（改写基线、持续磨损），不给 operator
        for permission in [Permission::RunCalibration, Permission::RunCycleLife] {
            assert!(
                !operator.contains(&permission),
                "operator 不该有 {permission:?}"
            );
        }

        // maintainer 相对 operator 的独占项
        for permission in [
            Permission::RunCalibration,
            Permission::RunCycleLife,
            Permission::ManageSessions,
            Permission::ViewDiagnostics,
            Permission::ManageSettings,
        ] {
            assert!(
                maintainer.contains(&permission),
                "maintainer 应有 {permission:?}"
            );
            assert!(
                !operator.contains(&permission),
                "operator 不该有 {permission:?}"
            );
        }

        // operator 被压到最小：看、连、下发指令 —— 就这三件事。
        // 这条断言是防止有人"顺手"把权限加回 operator 的硬闸。
        assert_eq!(
            operator.len(),
            3,
            "operator 权限被意外放宽了：{operator:?}"
        );

        // admin 相对 maintainer 的独占项
        assert!(admin.contains(&Permission::ManageUsers));
        assert!(!maintainer.contains(&Permission::ManageUsers));

        // 三个角色都不能是空集
        assert!(!operator.is_empty() && !maintainer.is_empty() && !admin.is_empty());
        // 角色之间必须真的不一样（否则就是同一档角色挂两个名字）
        assert_ne!(operator, maintainer);
        assert_ne!(maintainer, admin);
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

    /// 注册开关的配置文件路径，与 `AuthStore::load` 的派生规则保持一致。
    fn test_config_path(name: &str) -> PathBuf {
        let users = test_auth_path(name);
        let stem = users
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("auth-users")
            .to_string();
        users.with_file_name(format!("{stem}-config.json"))
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
                client_id: None,
                label: None,
            })
            .is_err());
        let session = store
            .login(LoginRequest {
                username: "admin".to_string(),
                password: "admin123".to_string(),
                client_id: None,
                label: None,
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
                max_devices: None,
            })
            .expect("create user");
        assert_eq!(account.role, Role::Operator);

        let session = store
            .login(LoginRequest {
                username: "operator_1".to_string(),
                password: "operator123".to_string(),
                client_id: None,
                label: None,
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

    /* ── 会话注册表：多设备访问隔离的核心行为 ───────────────────────── */

    #[test]
    fn session_store_isolates_devices_and_revokes() {
        let path = test_auth_path("sessions");
        let _ = fs::remove_file(&path);
        let store = SessionStore::load(path.clone());
        let session = AuthSession::for_role("operator_1", Role::Operator);

        let token_a = store
            .create(
                &session,
                "client-a".to_string(),
                "桌面".to_string(),
                "1.1.1.1".to_string(),
                "UA-A".to_string(),
            )
            .expect("create a");
        let token_b = store
            .create(
                &session,
                "client-b".to_string(),
                "手机".to_string(),
                "2.2.2.2".to_string(),
                "UA-B".to_string(),
            )
            .expect("create b");

        // 两台设备必须拿到不同 token，否则又变回"一份会话"
        assert_ne!(token_a, token_b);
        assert_eq!(store.active_count_for_user("operator_1"), 2);
        assert_eq!(
            store.resolve(&token_a).expect("resolve a").username,
            "operator_1"
        );
        assert_eq!(store.list().len(), 2);

        // 按 token 前缀踢掉**一台**，另一台不受影响
        let prefix: String = token_a.chars().take(12).collect();
        assert_eq!(store.revoke(&prefix).expect("revoke"), 1);
        assert!(store.resolve(&token_a).is_none());
        assert!(store.resolve(&token_b).is_some());

        // 按账号踢全部
        assert_eq!(store.revoke_user("operator_1"), 1);
        assert!(store.resolve(&token_b).is_none());
        assert_eq!(store.active_count_for_user("operator_1"), 0);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn session_store_survives_reload() {
        let path = test_auth_path("sessions-reload");
        let _ = fs::remove_file(&path);

        let token = {
            let store = SessionStore::load(path.clone());
            store
                .create(
                    &AuthSession::for_role("operator_1", Role::Operator),
                    "client-a".to_string(),
                    "桌面".to_string(),
                    String::new(),
                    String::new(),
                )
                .expect("create")
        };

        // 模拟网关重启（每次部署都会重启）：从文件重新加载后会话仍在，
        // 各端不必重新登录
        let reloaded = SessionStore::load(path.clone());
        assert!(reloaded.resolve(&token).is_some());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn session_unknown_token_is_signed_out() {
        let path = test_auth_path("sessions-unknown");
        let _ = fs::remove_file(&path);
        let store = SessionStore::load(path.clone());
        // token 不存在 → 视作未登录，绝不能回退成"某个已登录的人"
        assert!(store.resolve("deadbeef").is_none());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn self_service_revoke_refuses_other_users_sessions() {
        let path = test_auth_path("revoke-owned");
        let _ = fs::remove_file(&path);
        let store = SessionStore::load(path.clone());

        let alice = AuthSession::for_role("alice", Role::Operator);
        let bob = AuthSession::for_role("bob", Role::Operator);
        let alice_token = store
            .create(&alice, "a1".to_string(), "桌面".to_string(), String::new(), String::new())
            .expect("alice");
        let bob_token = store
            .create(&bob, "b1".to_string(), "桌面".to_string(), String::new(), String::new())
            .expect("bob");

        // alice 拿 bob 的 sessionId 去踢：必须失败。
        // sessionId 只是 token 前 12 位，不该被当成权限边界。
        let bob_id: String = bob_token.chars().take(12).collect();
        assert!(store.revoke_owned(&bob_id, "alice").is_err());
        assert!(store.resolve(&bob_token).is_some());

        // 踢自己的：成功
        let alice_id: String = alice_token.chars().take(12).collect();
        assert_eq!(store.revoke_owned(&alice_id, "alice").expect("own"), 1);
        assert!(store.resolve(&alice_token).is_none());

        // 自助列表只返回自己的设备，bob 看不到 alice
        let rows = store.list_for_user("bob");
        assert_eq!(rows.len(), 1);
        assert!(rows.iter().all(|row| row.username == "bob"));

        let _ = fs::remove_file(path);
    }

    /* ── 改角色 / 删账号 ─────────────────────────────────────────────── */

    fn create_req(username: &str, password: &str, role: Role) -> CreateUserRequest {
        CreateUserRequest {
            username: username.to_string(),
            password: password.to_string(),
            role,
            max_devices: None,
        }
    }

    #[test]
    fn cannot_delete_or_demote_the_last_admin() {
        let path = test_auth_path("last-admin");
        let _ = fs::remove_file(&path);
        let store = AuthStore::load(path.clone());

        // 默认只有一个 admin：两条路都要堵死，否则谁都管不了账号了
        assert!(store.delete_user("admin").is_err());
        assert!(store.set_role("admin", Role::Operator).is_err());

        // 出现第二个管理员之后，降级/删除就放行
        store
            .create_user(create_req("admin2", "admin2345", Role::Admin))
            .expect("create admin2");
        assert_eq!(
            store.set_role("admin", Role::Operator).expect("demote").role,
            Role::Operator
        );
        assert!(store.delete_user("admin").is_ok());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn delete_user_removes_account_and_rejects_repeat() {
        let path = test_auth_path("delete-user");
        let _ = fs::remove_file(&path);
        let store = AuthStore::load(path.clone());
        store
            .create_user(create_req("temp", "temp1234", Role::Operator))
            .expect("create");
        assert_eq!(store.list_users().len(), 2);

        store.delete_user("temp").expect("delete");
        assert_eq!(store.list_users().len(), 1);
        // 重复删除必须报错，不能静默成功（否则界面会以为删掉了）
        assert!(store.delete_user("temp").is_err());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn role_change_takes_effect_on_existing_sessions() {
        let path = test_auth_path("role-sync");
        let _ = fs::remove_file(&path);
        let sessions = SessionStore::load(path.clone());
        let token = sessions
            .create(
                &AuthSession::for_role("u1", Role::Admin),
                "c".to_string(),
                "桌面".to_string(),
                String::new(),
                String::new(),
            )
            .expect("create");

        // 登录时是 admin
        assert!(sessions
            .resolve(&token)
            .expect("resolve")
            .has_permission(Permission::ManageUsers));

        // ★ 降级后必须**立刻**生效。会话里的 role 是登录那一刻的快照，
        //   不主动同步的话对方会拿旧角色一直用到会话过期（7 天）。
        assert_eq!(sessions.update_role("u1", Role::Operator), 1);
        let after = sessions.resolve(&token).expect("resolve");
        assert_eq!(after.role, Role::Operator);
        assert!(!after.has_permission(Permission::ManageUsers));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn auth_store_tracks_device_limit() {
        let path = test_auth_path("device-limit");
        let _ = fs::remove_file(&path);
        let store = AuthStore::load(path.clone());

        // 老 auth-users.json 没有 maxDevices 字段 → 按"不限"读入
        assert_eq!(store.max_devices("admin"), 0);
        assert_eq!(store.set_max_devices("admin", 2).expect("set").max_devices, 2);
        assert_eq!(store.max_devices("admin"), 2);
        // 账号不存在时不 panic，按"不限"处理
        assert_eq!(store.max_devices("nobody"), 0);

        let _ = fs::remove_file(path);
    }

    /* ── 自助注册 ───────────────────────────────────────────────────── */

    fn login_req(username: &str, password: &str) -> LoginRequest {
        LoginRequest {
            username: username.to_string(),
            password: password.to_string(),
            client_id: None,
            label: None,
        }
    }

    fn register_req(username: &str, password: &str) -> RegisterRequest {
        RegisterRequest {
            username: username.to_string(),
            password: password.to_string(),
        }
    }

    #[test]
    fn registration_defaults_to_approval_and_blocks_login_until_approved() {
        let path = test_auth_path("register-approval");
        let config = test_config_path("register-approval");
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(&config);
        let store = AuthStore::load(path.clone());

        // 默认必须是"待审批"：公网开放注册 + 这套系统能下发运动指令
        assert_eq!(store.registration_mode(), RegistrationMode::Approval);

        let account = store
            .register(register_req("newbie", "pass1234"), "9.9.9.9")
            .expect("register");
        // 自助注册角色由服务端定死，不能自己提权
        assert_eq!(account.role, Role::Operator);
        assert!(account.pending);
        assert_eq!(store.pending_count(), 1);

        // ★ 审批前连登录都过不了（必须在签发 token 之前拦住）
        assert!(store.login(login_req("newbie", "pass1234")).is_err());

        store.approve("newbie").expect("approve");
        assert_eq!(store.pending_count(), 0);
        let session = store.login(login_req("newbie", "pass1234")).expect("login");
        assert_eq!(session.role, Role::Operator);

        let _ = fs::remove_file(path);
        let _ = fs::remove_file(config);
    }

    #[test]
    fn registration_mode_closed_rejects_and_persists() {
        let path = test_auth_path("register-closed");
        let config = test_config_path("register-closed");
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(&config);
        let store = AuthStore::load(path.clone());

        store
            .set_registration_mode(RegistrationMode::Closed)
            .expect("set mode");
        assert!(store.register(register_req("newbie", "pass1234"), "9.9.9.9").is_err());

        // 换一个实例重新加载：开关要能从配置文件读回来（网关重启后仍然生效）
        let reloaded = AuthStore::load(path.clone());
        assert_eq!(reloaded.registration_mode(), RegistrationMode::Closed);

        let _ = fs::remove_file(path);
        let _ = fs::remove_file(config);
    }

    #[test]
    fn registration_open_mode_is_immediately_usable() {
        let path = test_auth_path("register-open");
        let config = test_config_path("register-open");
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(&config);
        let store = AuthStore::load(path.clone());

        store
            .set_registration_mode(RegistrationMode::Open)
            .expect("set mode");
        let account = store
            .register(register_req("newbie", "pass1234"), "9.9.9.9")
            .expect("register");
        assert!(!account.pending);
        assert!(store.login(login_req("newbie", "pass1234")).is_ok());

        let _ = fs::remove_file(path);
        let _ = fs::remove_file(config);
    }
}
