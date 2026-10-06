import { useCallback, useEffect, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Fingerprint,
  LogOut,
  MonitorSmartphone,
  RefreshCw,
  Save,
  ShieldCheck,
  ShieldX,
  Trash2,
  UserCheck,
  UserPlus,
} from "lucide-react";

import type {
  AuthSession,
  ClientSessionView,
  LoginResult,
  RegistrationMode,
  Role,
  UserAccount,
} from "../softuiTypes";
import { groupByAccessIp, UNKNOWN_IP_LABEL } from "./accessGroups";

/* ── 后台管理站点 ───────────────────────────────────────────────────────
 * 独立入口（backend.html），由 serve/server.mjs 按 Host 分流到
 * softui-backend.blinest.icu，与前台站点分开：
 *   - 不同源 → localStorage 隔离，后台登录不会带进前台的会话
 *   - 后台只做"管人、管设备访问"，不做设备控制
 *
 * 权限仍由后端把守：这里每个命令都要求 manageUsers，非管理员即使打开
 * 这个页面也只会拿到 permission denied。
 * ──────────────────────────────────────────────────────────────────── */

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 把时间戳说成"刚刚 / N 分钟前"，比一串 ISO 时间好读。 */
function formatRelative(timestampMs: number): string {
  if (!timestampMs) return "—";
  const delta = Date.now() - timestampMs;
  if (delta < 5_000) return "刚刚";
  if (delta < 60_000) return `${Math.round(delta / 1000)} 秒前`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)} 小时前`;
  return new Date(timestampMs).toLocaleString("zh-CN", { hour12: false });
}

const REGISTRATION_LABELS: Record<RegistrationMode, string> = {
  closed: "关闭自助注册",
  approval: "注册后需审批（推荐）",
  open: "注册即可登录",
};

export default function AdminApp() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const [loginForm, setLoginForm] = useState({ username: "admin", password: "" });

  const [clients, setClients] = useState<ClientSessionView[]>([]);
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [regMode, setRegMode] = useState<RegistrationMode>("approval");
  const [limitDrafts, setLimitDrafts] = useState<Record<string, string>>({});
  /** 角色下拉草稿（用户名 → 角色）。 */
  const [roleDrafts, setRoleDrafts] = useState<Record<string, Role>>({});
  /** 等待二次确认删除的用户名：删除不可逆，不做确认太危险。 */
  const [confirmDelete, setConfirmDelete] = useState("");
  /** 已展开设备明细的访问来源（IP）。默认全部收起。 */
  const [expandedIps, setExpandedIps] = useState<Record<string, boolean>>({});
  /** IP → 属地文案（由网关代查并缓存）。查不到就是空串，界面显示"—"。 */
  const [geoByIp, setGeoByIp] = useState<Record<string, string>>({});

  const [newUser, setNewUser] = useState({
    username: "",
    password: "",
    role: "operator" as Role,
    maxDevices: "0",
  });
  const [resetTarget, setResetTarget] = useState("");
  const [resetPassword, setResetPassword] = useState("");

  const canManage =
    !!session?.authenticated && session.permissions.includes("manageUsers");

  /* ── 启动：先看本机是否已有后台会话 ── */
  useEffect(() => {
    void (async () => {
      try {
        const current = await invoke<AuthSession>("current_auth_session");
        setSession(current);
      } catch {
        setSession(null);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const refresh = useCallback(async () => {
    if (!canManage) return;
    try {
      const [clientList, userList, pending, mode] = await Promise.all([
        invoke<ClientSessionView[]>("list_clients"),
        invoke<UserAccount[]>("list_users"),
        invoke<number>("pending_user_count"),
        invoke<RegistrationMode>("registration_mode"),
      ]);
      setClients(clientList);
      setUsers(userList);
      setPendingCount(pending);
      setRegMode(mode);
      setLimitDrafts((prev) => {
        const next: Record<string, string> = {};
        for (const user of userList) {
          next[user.username] = prev[user.username] ?? String(user.maxDevices ?? 0);
        }
        return next;
      });
      setRoleDrafts((prev) => {
        const next: Record<string, Role> = {};
        for (const user of userList) {
          next[user.username] = prev[user.username] ?? user.role;
        }
        return next;
      });
    } catch (refreshError) {
      setNotice(errorText(refreshError));
    }
  }, [canManage]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /* ── 会话心跳 + 设备列表自动刷新 ──
   * 10 秒一次：既让"谁在线"保持新鲜，也确保后台自己被踢下线时能回到登录页。 */
  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const current = await invoke<AuthSession>("current_auth_session");
          if (cancelled) return;
          if (!current.authenticated) {
            setSession(current);
            return;
          }
          await refresh();
        } catch {
          /* 网络抖动：下个周期再试 */
        }
      })();
    }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [canManage, refresh]);

  /* 查 IP 属地。放在网关代查（原因见 serve/server.mjs 的说明）。
   * 查不到 / 被限流 / 离线都只是少显示一个标签，不能影响这个面板。 */
  useEffect(() => {
    const ips = Array.from(
      new Set(
        clients
          .map((client) => (client.ip ?? "").trim())
          .filter((ip) => ip.length > 0 && ip !== UNKNOWN_IP_LABEL),
      ),
    );
    if (ips.length === 0) {
      setGeoByIp({});
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const resp = await fetch(`/geo?ips=${encodeURIComponent(ips.join(","))}`);
        const payload = (await resp.json()) as { data?: Record<string, string> };
        if (!cancelled) setGeoByIp(payload?.data ?? {});
      } catch {
        if (!cancelled) setGeoByIp({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clients]);

  const runAction = async (action: () => Promise<void>, successMessage: string) => {    setNotice("");
    setError(null);
    try {
      await action();
      setNotice(successMessage);
    } catch (actionError) {
      setNotice(errorText(actionError));
    }
  };

  const submitLogin = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<LoginResult>("login", {
        request: { username: loginForm.username.trim(), password: loginForm.password },
      });
      if (!result.session.permissions.includes("manageUsers")) {
        // 非管理员登进来没有意义：直接撤销这条会话，避免留下一个"登着但什么都做不了"的状态
        await invoke("logout");
        throw new Error("该账号没有后台管理权限，请用管理员账号登录。");
      }
      setSession(result.session);
      setLoginForm((prev) => ({ ...prev, password: "" }));
    } catch (loginError) {
      setError(errorText(loginError));
    } finally {
      setBusy(false);
    }
  };

  const logoutAdmin = async () => {
    try {
      const next = await invoke<AuthSession>("logout");
      setSession(next);
      setClients([]);
      setUsers([]);
    } catch (logoutError) {
      setError(errorText(logoutError));
    }
  };

  /* ── 登录页 ── */
  if (!ready) {
    return <div className="admin-loading">正在载入后台…</div>;
  }

  if (!canManage) {
    return (
      <div className="admin-login-shell">
        <form className="admin-login-card" onSubmit={submitLogin}>
          <div className="admin-brand">
            <Fingerprint size={20} />
            <div>
              <strong>SoftUI 后台管理</strong>
              <span>设备访问与账号管理</span>
            </div>
          </div>

          <label>
            <span>管理员账号</span>
            <input
              value={loginForm.username}
              onChange={(event) =>
                setLoginForm((prev) => ({ ...prev, username: event.target.value }))
              }
              autoComplete="username"
            />
          </label>
          <label>
            <span>密码</span>
            <input
              type="password"
              value={loginForm.password}
              onChange={(event) =>
                setLoginForm((prev) => ({ ...prev, password: event.target.value }))
              }
              autoComplete="current-password"
            />
          </label>

          {error ? <div className="admin-alert error">{error}</div> : null}

          <button type="submit" className="admin-btn primary full" disabled={busy}>
            <ShieldCheck size={16} />
            <span>{busy ? "登录中…" : "登录后台"}</span>
          </button>
          <p className="admin-hint">
            后台与前台登录互相独立：这里登录不会让前台设备进入已登录状态。
          </p>
        </form>
      </div>
    );
  }

  /** 按来源 IP 汇总后的设备访问列表：同一个 IP 只占一行。 */
  const accessGroups = groupByAccessIp(clients);
  const pendingUsers = users.filter((user) => user.pending);

  /* ── 管理台 ── */
  return (
    <div className="admin-shell">
      <header className="admin-header">
        <div className="admin-brand">
          <Fingerprint size={18} />
          <div>
            <strong>SoftUI 后台管理</strong>
            <span>设备访问与账号管理</span>
          </div>
        </div>
        <div className="admin-header-actions">
          <span className="admin-who">
            {session?.username} · {session?.role}
          </span>
          <button type="button" className="admin-btn" onClick={() => void refresh()}>
            <RefreshCw size={15} />
            <span>刷新</span>
          </button>
          <button type="button" className="admin-btn" onClick={() => void logoutAdmin()}>
            <LogOut size={15} />
            <span>退出</span>
          </button>
        </div>
      </header>

      <div className="admin-body">
        <div className="admin-stats">
          <div className="admin-stat">
            <span>访问来源</span>
            <strong>{accessGroups.length} 个</strong>
          </div>
          <div className="admin-stat">
            <span>账号总数</span>
            <strong>{users.length}</strong>
          </div>
          <div className={`admin-stat${pendingCount > 0 ? " attention" : ""}`}>
            <span>待审批</span>
            <strong>{pendingCount}</strong>
          </div>
          <div className="admin-stat">
            <span>注册策略</span>
            <strong>{REGISTRATION_LABELS[regMode]}</strong>
          </div>
        </div>

        {notice ? <div className="admin-alert">{notice}</div> : null}

        {/* ── 待审批 ── */}
        {pendingUsers.length > 0 ? (
          <section className="admin-panel">
            <div className="admin-panel-head">
              <h2>
                <UserCheck size={16} /> 待审批注册
              </h2>
              <span>{pendingUsers.length} 个账号等待处理，通过后才能登录。</span>
            </div>
            <div className="admin-rows">
              {pendingUsers.map((user) => (
                <div className="admin-row" key={user.username}>
                  <div className="admin-row-main">
                    <strong>{user.username}</strong>
                    <span>申请角色 operator · 设备上限 {user.maxDevices || "不限"}</span>
                  </div>
                  <button
                    type="button"
                    className="admin-btn ok"
                    onClick={() =>
                      void runAction(async () => {
                        await invoke("approve_user", { username: user.username });
                        await refresh();
                      }, `已通过：${user.username}`)
                    }
                  >
                    <CheckCircle2 size={15} />
                    <span>通过</span>
                  </button>
                  <button
                    type="button"
                    className="admin-btn danger"
                    onClick={() =>
                      void runAction(async () => {
                        await invoke("set_user_disabled", {
                          username: user.username,
                          disabled: true,
                        });
                        await refresh();
                      }, `已拒绝并停用：${user.username}`)
                    }
                  >
                    <ShieldX size={15} />
                    <span>拒绝</span>
                  </button>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {/* ── 设备访问 ── */}
        <section className="admin-panel">
          <div className="admin-panel-head">
            <h2>
              <MonitorSmartphone size={16} /> 设备访问
            </h2>
            <span>按访问来源 IP 汇总。展开可看该来源下的每台设备，并只踢掉其中某一台。</span>
          </div>
          {accessGroups.length === 0 ? (
            <div className="admin-empty">暂无已登录的设备。</div>
          ) : (
            <div className="admin-rows">
              {accessGroups.map((group) => {
                const expanded = !!expandedIps[group.ip];
                return (
                  <div className="admin-group" key={group.ip}>
                    <div className="admin-row">
                      <button
                        type="button"
                        className="admin-expand"
                        aria-expanded={expanded}
                        title={expanded ? "收起设备明细" : "展开设备明细"}
                        onClick={() =>
                          setExpandedIps((prev) => ({ ...prev, [group.ip]: !prev[group.ip] }))
                        }
                      >
                        {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        <span>{group.devices.length} 台设备</span>
                      </button>
                      <div className="admin-row-main">
                        <strong>
                          {group.ip}
                          <span className="admin-tag">{geoByIp[group.ip] || "属地未知"}</span>
                        </strong>
                      </div>
                      <span className="admin-cell">
                        最新访问 <strong>{formatRelative(group.lastSeenMs)}</strong>
                      </span>
                      <span className="admin-cell">
                        访问 <strong>{group.count}</strong> 次
                      </span>
                      <button
                        type="button"
                        className="admin-btn danger"
                        title={`踢掉该来源下的全部 ${group.count} 条会话（含 ${group.devices.length} 台设备）`}
                        onClick={() =>
                          void runAction(async () => {
                            // 同一 IP 下可能有多条会话，逐条撤销
                            for (const session of group.sessions) {
                              await invoke("revoke_client", { sessionId: session.sessionId });
                            }
                            await refresh();
                          }, `已踢下线：${group.ip}（${group.count} 条会话）`)
                        }
                      >
                        <ShieldX size={15} />
                        <span>全部踢下线</span>
                      </button>
                    </div>

                    {expanded ? (
                      <div className="admin-device-list">
                        {group.devices.map((device) => (
                          <div className="admin-device-row" key={device.key}>
                            <div className="admin-row-main">
                              <strong>
                                {device.label}
                                <span className="admin-tag">{device.username}</span>
                                <span className="admin-tag">{device.role}</span>
                              </strong>
                              <span>最近活动 {formatRelative(device.lastSeenMs)}</span>
                              <span className="admin-agent" title={device.userAgent}>
                                {device.userAgent || "—"}
                              </span>
                            </div>
                            <span className="admin-cell">
                              访问 <strong>{device.count}</strong> 次
                            </span>
                            <button
                              type="button"
                              className="admin-btn danger"
                              title="只踢掉这台设备，同一来源下的其它设备不受影响"
                              onClick={() =>
                                void runAction(async () => {
                                  // 同一台设备可能有多条会话（多个标签页），逐条撤销
                                  for (const session of device.sessions) {
                                    await invoke("revoke_client", { sessionId: session.sessionId });
                                  }
                                  await refresh();
                                }, `已踢下线：${device.label}（${device.count} 条会话）`)
                              }
                            >
                              <ShieldX size={15} />
                              <span>踢下线</span>
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ── 账号 ── */}
        <section className="admin-panel">
          <div className="admin-panel-head">
            <h2>
              <ShieldCheck size={16} /> 账号
            </h2>
            <span>设备上限 0 = 不限；达到上限时新设备会被拒绝登录。</span>
          </div>
          <div className="admin-rows">
            {users.map((user) => (
              <div className="admin-row" key={user.username}>
                <div className="admin-row-main">
                  <strong>
                    {user.username}
                    <span className="admin-tag">{user.role}</span>
                    {user.pending ? <span className="admin-tag warn">待审批</span> : null}
                    {user.mustChangePassword ? (
                      <span className="admin-tag warn">需改密</span>
                    ) : null}
                  </strong>
                  <span>{user.disabled ? "已停用" : "正常"}</span>
                </div>
                <label className="admin-limit">
                  <span>角色</span>
                  <select
                    value={roleDrafts[user.username] ?? user.role}
                    onChange={(event) =>
                      setRoleDrafts((prev) => ({ ...prev, [user.username]: event.target.value as Role }))
                    }
                  >
                    <option value="operator">operator</option>
                    <option value="maintainer">maintainer</option>
                    <option value="admin">admin</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="admin-btn"
                  disabled={(roleDrafts[user.username] ?? user.role) === user.role}
                  onClick={() =>
                    void runAction(async () => {
                      const nextRole = roleDrafts[user.username] ?? user.role;
                      await invoke("set_user_role", { username: user.username, role: nextRole });
                      await refresh();
                    }, `${user.username} 的角色已更新（立即生效，无需对方重新登录）`)
                  }
                >
                  <Save size={15} />
                  <span>保存角色</span>
                </button>
                <label className="admin-limit">
                  <span>设备上限</span>
                  <input
                    type="number"
                    min={0}
                    max={99}
                    value={limitDrafts[user.username] ?? String(user.maxDevices ?? 0)}
                    onChange={(event) =>
                      setLimitDrafts((prev) => ({
                        ...prev,
                        [user.username]: event.target.value,
                      }))
                    }
                  />
                </label>
                <button
                  type="button"
                  className="admin-btn"
                  onClick={() =>
                    void runAction(async () => {
                      const parsed = Number.parseInt(limitDrafts[user.username] ?? "0", 10);
                      await invoke("set_user_device_limit", {
                        username: user.username,
                        maxDevices: Number.isFinite(parsed) && parsed > 0 ? parsed : 0,
                      });
                      await refresh();
                    }, `${user.username} 的设备上限已更新`)
                  }
                >
                  <Save size={15} />
                  <span>保存</span>
                </button>
                <button
                  type="button"
                  className="admin-btn danger"
                  onClick={() =>
                    void runAction(async () => {
                      await invoke("revoke_user_sessions", { username: user.username });
                      await refresh();
                    }, `已踢下线：${user.username} 的全部设备`)
                  }
                >
                  <ShieldX size={15} />
                  <span>全部踢下线</span>
                </button>
                <button
                  type="button"
                  className="admin-btn"
                  disabled={user.username === session?.username}
                  onClick={() =>
                    void runAction(async () => {
                      await invoke("set_user_disabled", {
                        username: user.username,
                        disabled: !user.disabled,
                      });
                      await refresh();
                    }, user.disabled ? `${user.username} 已启用` : `${user.username} 已停用`)
                  }
                >
                  <span>{user.disabled ? "启用" : "停用"}</span>
                </button>
                {confirmDelete === user.username ? (
                  <button
                    type="button"
                    className="admin-btn danger"
                    onClick={() =>
                      void runAction(async () => {
                        await invoke("delete_user", { username: user.username });
                        setConfirmDelete("");
                        await refresh();
                      }, `已删除账号：${user.username}（其所有设备已下线）`)
                    }
                  >
                    <Trash2 size={15} />
                    <span>确认删除</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="admin-btn"
                    disabled={user.username === session?.username}
                    title={user.username === session?.username ? "不能删除当前登录的账号" : undefined}
                    onClick={() => setConfirmDelete(user.username)}
                  >
                    <Trash2 size={15} />
                    <span>删除</span>
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* ── 注册策略 ── */}
        <section className="admin-panel">
          <div className="admin-panel-head">
            <h2>
              <UserPlus size={16} /> 自助注册策略
            </h2>
            <span>注册入口是公网匿名入口，策略直接决定谁能进这套系统。</span>
          </div>
          <div className="admin-mode-row">
            {(["closed", "approval", "open"] as RegistrationMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`admin-mode${regMode === mode ? " active" : ""}`}
                onClick={() =>
                  void runAction(async () => {
                    await invoke("set_registration_mode", { mode });
                    await refresh();
                  }, `注册策略已改为：${REGISTRATION_LABELS[mode]}`)
                }
              >
                {REGISTRATION_LABELS[mode]}
              </button>
            ))}
          </div>
          <p className="admin-hint">
            「注册即可登录」意味着任何拿到网址的人注册后就能下发控制指令，仅在完全可信的网络里使用。
          </p>
        </section>

        {/* ── 新建账号 / 重置密码 ── */}
        <div className="admin-grid-2">
          <section className="admin-panel">
            <div className="admin-panel-head">
              <h2>
                <UserPlus size={16} /> 新建账号
              </h2>
            </div>
            <form
              className="admin-form"
              onSubmit={(event) => {
                event.preventDefault();
                void runAction(async () => {
                  const parsed = Number.parseInt(newUser.maxDevices, 10);
                  await invoke("create_user", {
                    request: {
                      username: newUser.username.trim(),
                      password: newUser.password,
                      role: newUser.role,
                      maxDevices: Number.isFinite(parsed) && parsed > 0 ? parsed : 0,
                    },
                  });
                  setNewUser({ username: "", password: "", role: "operator", maxDevices: "0" });
                  await refresh();
                }, "账号已创建（管理员建的号无需审批）");
              }}
            >
              <label>
                <span>用户名</span>
                <input
                  value={newUser.username}
                  onChange={(event) =>
                    setNewUser((prev) => ({ ...prev, username: event.target.value }))
                  }
                  placeholder="operator_1"
                />
              </label>
              <label>
                <span>初始密码</span>
                <input
                  type="password"
                  value={newUser.password}
                  onChange={(event) =>
                    setNewUser((prev) => ({ ...prev, password: event.target.value }))
                  }
                />
              </label>
              <label>
                <span>角色</span>
                <select
                  value={newUser.role}
                  onChange={(event) =>
                    setNewUser((prev) => ({ ...prev, role: event.target.value as Role }))
                  }
                >
                  <option value="operator">operator</option>
                  <option value="maintainer">maintainer</option>
                  <option value="admin">admin</option>
                </select>
              </label>
              <label>
                <span>设备上限</span>
                <input
                  type="number"
                  min={0}
                  max={99}
                  value={newUser.maxDevices}
                  onChange={(event) =>
                    setNewUser((prev) => ({ ...prev, maxDevices: event.target.value }))
                  }
                />
              </label>
              <button
                type="submit"
                className="admin-btn primary full"
                disabled={!newUser.username.trim() || newUser.password.length < 4}
              >
                <UserPlus size={15} />
                <span>创建账号</span>
              </button>
            </form>
          </section>

          <section className="admin-panel">
            <div className="admin-panel-head">
              <h2>
                <Save size={16} /> 重置密码
              </h2>
              <span>重置后，该账号所有设备会被踢下线。</span>
            </div>
            <form
              className="admin-form"
              onSubmit={(event) => {
                event.preventDefault();
                void runAction(async () => {
                  await invoke("change_password", {
                    request: { username: resetTarget, oldPassword: null, newPassword: resetPassword },
                  });
                  setResetPassword("");
                  await refresh();
                }, `已重置：${resetTarget} 的密码`);
              }}
            >
              <label>
                <span>目标账号</span>
                <select
                  value={resetTarget}
                  onChange={(event) => setResetTarget(event.target.value)}
                >
                  <option value="">选择账号</option>
                  {users.map((user) => (
                    <option value={user.username} key={user.username}>
                      {user.username}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>新密码</span>
                <input
                  type="password"
                  value={resetPassword}
                  onChange={(event) => setResetPassword(event.target.value)}
                />
              </label>
              <button
                type="submit"
                className="admin-btn full"
                disabled={!resetTarget || resetPassword.length < 4}
              >
                <Save size={15} />
                <span>重置密码</span>
              </button>
            </form>
          </section>
        </div>
      </div>
    </div>
  );
}
