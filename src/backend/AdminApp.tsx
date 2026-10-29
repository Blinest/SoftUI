import { useCallback, useEffect, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  approveUiStore,
  approveUiStoreEntry,
  listPendingUiStore,
  loadUiStore,
  rejectUiStore,
  type PendingUiChange,
} from "../robot/uiStore";
import { createPortal } from "react-dom";
import { CardGrid } from "../components/cards/CardGrid";
import { useCardLayout } from "../state/layoutStore";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Fingerprint,
  LayoutDashboard,
  LogOut,
  MonitorSmartphone,
  RefreshCw,
  Save,
  ShieldCheck,
  ShieldX,
  Trash2,
  UserPlus,
  Ban,
  Power,
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
  /** 后台卡片布局（**每个管理员各自一份** ✓ —— 用用户名做 key ✓）。 */
  const adminLayout = useCardLayout(session?.username ?? "", "admin");
  const [pendingCount, setPendingCount] = useState(0);
  /** 动作库 / 策略编排的待审批改动 ✓（admin 批准后才生效 ✓）*/
  const [pendingChanges, setPendingChanges] = useState<PendingUiChange[]>([]);
  /** 已生效的数据条数 ✓（概览统计用 ✓）*/
  const [sharedCounts, setSharedCounts] = useState({ actions: 0, policies: 0 });
  const [regMode, setRegMode] = useState<RegistrationMode>("approval");
  const [limitDrafts, setLimitDrafts] = useState<Record<string, string>>({});
  /** 角色下拉草稿（用户名 → 角色）。 */
  const [roleDrafts, setRoleDrafts] = useState<Record<string, Role>>({});
  /** 等待二次确认删除的用户名：删除不可逆，不做确认太危险。 */
  const [confirmDelete, setConfirmDelete] = useState("");
  /** 重置密码弹窗（null = 关闭）。比 window.prompt 好用：有确认框、样式统一 ✓ */
  const [resetModal, setResetModal] = useState<{ username: string; password: string; confirm: string } | null>(null);
  /** 正在查看哪个账号的待审批 ✓（弹窗 ✓）*/
  const [approvalModalUser, setApprovalModalUser] = useState<string | null>(null);

  /** 点「操作」以外的地方自动收起该下拉 ✓（原生 details 不会自己关 ✗） */
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".admin-row-menu")) return;
      document.querySelectorAll<HTMLDetailsElement>(".admin-row-menu[open]").forEach((el) => {
        el.open = false;
      });
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);
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
      const [clientList, userList, pending, mode, changes, actions, schemes] = await Promise.all([
        invoke<ClientSessionView[]>("list_clients"),
        invoke<UserAccount[]>("list_users"),
        invoke<number>("pending_user_count"),
        invoke<RegistrationMode>("registration_mode"),
        listPendingUiStore(),
        loadUiStore<unknown[]>("motion-actions"),
        loadUiStore<{ schemes?: unknown[] }>("policy-schemes"),
      ]);
      setClients(clientList);
      setUsers(userList);
      setPendingCount(pending);
      setRegMode(mode);
      setPendingChanges(changes);
      setSharedCounts({
        actions: Array.isArray(actions) ? actions.length : 0,
        policies: Array.isArray(schemes?.schemes) ? (schemes!.schemes as unknown[]).length : 0,
      });
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

      {/* ⚠ 必须给 CardGrid 一个**有界高度**的 viewport 容器 ✗：
          否则它把父元素（admin-body = 整页）当可用区，行高会被撑到 400px 上限 ✗。
          前台用的是 <main className="layout-fill-region" data-card-grid-viewport> ✓。 */}
      <div className="admin-body" data-card-grid-viewport>
        {/* 概览：一张卡里放 4 个统计数字 ✓ —— 现在它是**可拖动/缩放的卡片** ✓ */}
        {/* 固定高度 200px ✓ —— CardGrid 量的是这个容器 ✓，不再受整页高度影响 ✗ */}
        <div data-card-grid-viewport style={{ minHeight: 200 }}>
        <CardGrid
          layout={adminLayout.layout}
          layoutKey="admin"
          ariaLabel="后台卡片布局"
          headerForCard={(cardId) => {
            if (cardId === "deviceAccess") {
              return { title: "设备访问", icon: <MonitorSmartphone aria-hidden="true" size={17} /> };
            }
            if (cardId === "users") {
              return { title: "账号管理", icon: <ShieldCheck aria-hidden="true" size={17} /> };
            }
            if (cardId === "account") {
              return { title: "新建账号", icon: <UserPlus aria-hidden="true" size={17} /> };
            }
            return { title: "概览", icon: <LayoutDashboard aria-hidden="true" size={17} /> };
          }}
          bodyClassForCard={() => "admin-card-body"}
          onLayoutChange={adminLayout.commit}
          maxRowHeight={200}
          draggableForCard={() => true}
          childrenForCard={(cardId) => {
            if (cardId === "users") {
              return (
                <div className="admin-card-content">
                  {/* 待审批区标题 ✓ —— 原来的 panel-head 在外壳替换时被去掉了 ✗ */}
                  {pendingUsers.length > 0 ? (
                    <>
                      <div className="admin-card-section-title">待审批注册（{pendingUsers.length}）</div>
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
                    </>
                    ) : null}

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
                        <label className="admin-limit">
                          <span>设备上限</span>
                          <input
                            type="number"
                            min={0}
                            max={99}
                            value={limitDrafts[user.username] ?? String(user.maxDevices ?? 0)}
                            onChange={(event) =>
                              setLimitDrafts((prev) => ({ ...prev, [user.username]: event.target.value }))
                            }
                          />
                        </label>
                      {/* 待审批 ✓ —— 点了**弹窗** ✓（浮层在卡片里会被裁 ✗）*/}
                      {(() => {
                        const mine = pendingChanges.filter(
                          (change) => change.submittedBy === user.username,
                        );
                        if (mine.length === 0) return null;
                        return (
                          <button
                            type="button"
                            className="admin-approvals-trigger"
                            onClick={() => setApprovalModalUser(user.username)}
                            title="查看并审批这个账号的改动"
                          >
                            待审批 <em>{mine.length}</em>
                          </button>
                        );
                      })()}
                        <details className="admin-row-menu">
                          <summary>操作</summary>
                          <button
                            type="button"
                            className="admin-btn"
                            disabled={
                              (roleDrafts[user.username] ?? user.role) === user.role &&
                              (limitDrafts[user.username] ?? String(user.maxDevices ?? 0)) ===
                                String(user.maxDevices ?? 0)
                            }
                            onClick={() =>
                              void runAction(async () => {
                                // 一次提交**角色 + 设备上限** ✓（原来是两个按钮，容易只点一个 ✗）
                                const nextRole = roleDrafts[user.username] ?? user.role;
                                const parsed = Number.parseInt(limitDrafts[user.username] ?? "0", 10);
                                await invoke("set_user_role", { username: user.username, role: nextRole });
                                await invoke("set_user_device_limit", {
                                  username: user.username,
                                  maxDevices: Number.isFinite(parsed) && parsed > 0 ? parsed : 0,
                                });
                                await refresh();
                              }, `${user.username} 的角色与设备上限已更新`)
                            }
                          >
                            <Save size={15} />
                            <span>保存</span>
                          </button>
                          <button
                            type="button"
                            className="admin-btn"
                            onClick={() => setResetModal({ username: user.username, password: "", confirm: "" })}
                          >
                            <Fingerprint size={15} />
                            <span>重置密码</span>
                          </button>
                          <button
                            type="button"
                            className="admin-btn"
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
                            {user.disabled ? <Power size={15} /> : <Ban size={15} />}
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
                        </details>
                      </div>
                    ))}
                  </div>

                </div>
              );
            }
            if (cardId === "deviceAccess") {
              return (
                <div className="admin-card-content">
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
                </div>
              );
            }
            if (cardId === "account") {
              return (
                <div className="admin-card-content">
      <div className="admin-grid-2">
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
      </div>

                </div>
              );
            }
            if (cardId !== "overview") return null;
            return (
              <>
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
                  <span>待审账号</span>
                  <strong>{pendingCount}</strong>
                </div>
                <div className={`admin-stat${pendingChanges.length > 0 ? " attention" : ""}`}>
                  <span>待审改动</span>
                  <strong>{pendingChanges.length}</strong>
                  <em className="admin-stat-note">
                    动作 {pendingChanges.filter((c) => c.namespace === "motion-actions").length} ·
                    策略 {pendingChanges.filter((c) => c.namespace === "policy-schemes").length}
                  </em>
                </div>
                <div className="admin-stat">
                  <span>已生效动作</span>
                  <strong>{sharedCounts.actions}</strong>
                </div>
                <div className="admin-stat">
                  <span>已生效方案</span>
                  <strong>{sharedCounts.policies}</strong>
                </div>
                <div className="admin-stat">
                  <span>注册策略</span>
                  <select
                    className="admin-stat-select"
                    value={regMode}
                    onChange={(event) => {
                      const mode = event.target.value as RegistrationMode;
                      if (mode === regMode) return;
                      void runAction(async () => {
                        await invoke("set_registration_mode", { mode });
                        await refresh();
                      }, `注册策略已改为：${REGISTRATION_LABELS[mode]}`);
                    }}
                  >
                    {(["closed", "approval", "open"] as RegistrationMode[]).map((mode) => (
                      <option key={mode} value={mode}>
                        {REGISTRATION_LABELS[mode]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              </>
            );
          }}
        />
        </div>

        {notice ? <div className="admin-alert">{notice}</div> : null}




      </div>

      {approvalModalUser ? createPortal(
        <div className="admin-modal-backdrop" role="dialog" aria-modal="true" aria-label="待审批改动">
          <div className="admin-modal admin-modal-wide">
            <h2>待审批改动 · {approvalModalUser}</h2>
            {(() => {
              const mine = pendingChanges.filter(
                (change) => change.submittedBy === approvalModalUser,
              );
              if (mine.length === 0) {
                return <p className="admin-empty">这个账号没有待审批的改动。</p>;
              }
              // 把每条待审批**拆成条目** ✓ —— 一条待审批里通常打包了多个动作 ✓
              // **只列有变化的条目** ✓ —— 已同步没动的不出现 ✗
              const rows = mine.flatMap((change) => {
                // 两种形状 ✓：动作库是数组 ✓，方案库是 `{ schemes: [...] }` ✓
                const raw = change.data as
                  | Array<{ id?: string; name?: string; points?: unknown[]; pendingDelete?: boolean }>
                  | { schemes?: Array<{ id?: string; name?: string; timeline?: unknown[]; interrupts?: unknown[] }> }
                  | null;
                const items: Array<{
                  id?: string;
                  name?: string;
                  points?: unknown[];
                  pendingDelete?: boolean;
                  timeline?: unknown[];
                  interrupts?: unknown[];
                }> = Array.isArray(raw) ? raw : (raw?.schemes ?? []);
                const isScheme = !Array.isArray(raw);
                if (items.length === 0) {
                  // ⚠ **空改动不出一行** ✗ —— 原来会渲染一行只有 `change.summary`
                  //   （例如"0 项"）✓，点进去看着就是**空白**✗（本 bug ✓）。
                  return [];
                }
                const changed = change.changedIds ?? items.map((item) => item.id ?? "");
                return items
                  .filter((item) => changed.includes(item.id ?? ""))
                  .map((item) => ({
                    change,
                    entryId: (item.id ?? null) as string | null,
                    label: isScheme
                      ? `${item.name ?? "(未命名方案)"} · ${item.timeline?.length ?? 0} 段 · ${
                          item.interrupts?.length ?? 0
                        } 条中断`
                      : `${item.name ?? "(未命名)"}${item.pendingDelete ? "（删除）" : "（新增/修改）"} · ${
                          Array.isArray(item.points) ? item.points.length : 0
                        } 个采样点`,
                  }));
              });
              return (
                <ul className="admin-approval-modal-list">
                  {rows.length === 0 ? (
                    <li className="admin-approval-modal-item">
                      <div className="admin-approval-modal-main">
                        <strong>没有可比对的条目</strong>
                        <span>
                          这些审批单是**空改动**（0 项，多半是客户端把没变化的数据又提交了一次）。
                          直接「驳回」即可，不会影响线上数据。
                        </span>
                      </div>
                    </li>
                  ) : null}
                  {rows.map(({ change, entryId, label }) => (
                    <li key={change.id} className="admin-approval-modal-item">
                      <div className="admin-approval-modal-main">
                        <strong>
                          {change.namespace === "motion-actions" ? "动作库" : "策略编排"}
                        </strong>
                        <span>{label}</span>
                        <em>
                          {new Date(Number(change.submittedAt)).toLocaleString("zh-CN", {
                            hour12: false,
                          })}
                        </em>
                      </div>
                      <div className="admin-approval-modal-actions">
                        <button
                          type="button"
                          className="admin-primary-btn"
                          onClick={() => {
                            void runAction(async () => {
                              const next = entryId
                                ? await approveUiStoreEntry(change.id, entryId)
                                : await approveUiStore(change.id);
                              setPendingChanges(next);
                              if (
                                next.filter((item) => item.submittedBy === approvalModalUser)
                                  .length === 0
                              ) {
                                setApprovalModalUser(null);
                              }
                              await refresh();
                            }, "已批准，所有设备 5 秒内同步");
                          }}
                        >
                          批准
                        </button>
                        <button
                          type="button"
                          className="admin-ghost-btn"
                          onClick={() => {
                            void runAction(async () => {
                              const next = await rejectUiStore(change.id);
                              setPendingChanges(next);
                              if (
                                next.filter((item) => item.submittedBy === approvalModalUser)
                                  .length === 0
                              ) {
                                setApprovalModalUser(null);
                              }
                              await refresh();
                            }, "已驳回");
                          }}
                        >
                          驳回
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              );
            })()}
            <div className="admin-modal-actions">
              <button
                type="button"
                className="admin-ghost-btn"
                onClick={() => setApprovalModalUser(null)}
              >
                关闭
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}

      {resetModal ? createPortal(
        <div className="admin-modal-backdrop" role="dialog" aria-modal="true" aria-label="重置密码">
          <form
            className="admin-modal"
            onSubmit={(event) => {
              event.preventDefault();
              if (resetModal.password.length < 4) return;
              if (resetModal.password !== resetModal.confirm) return;
              const { username, password } = resetModal;
              setResetModal(null);
              void runAction(async () => {
                await invoke("change_password", {
                  request: { username, oldPassword: null, newPassword: password },
                });
                await refresh();
              }, `${username} 的密码已重置（其所有设备已下线）`);
            }}
          >
            <h2>重置密码 · {resetModal.username}</h2>
            <label>
              <span>新密码</span>
              <input
                autoFocus
                type="password"
                value={resetModal.password}
                onChange={(event) => setResetModal({ ...resetModal, password: event.target.value })}
              />
            </label>
            <label>
              <span>确认新密码</span>
              <input
                type="password"
                value={resetModal.confirm}
                onChange={(event) => setResetModal({ ...resetModal, confirm: event.target.value })}
              />
            </label>
            <p className="admin-hint">
              {resetModal.password.length > 0 && resetModal.password.length < 4
                ? "密码至少 4 位"
                : resetModal.confirm && resetModal.password !== resetModal.confirm
                  ? "两次输入不一致"
                  : "重置后该账号的所有设备会被踢下线。"}
            </p>
            <div className="admin-modal-actions">
              <button type="button" className="admin-btn" onClick={() => setResetModal(null)}>
                取消
              </button>
              <button
                type="submit"
                className="admin-btn primary"
                disabled={
                  resetModal.password.length < 4 || resetModal.password !== resetModal.confirm
                }
              >
                确认重置
              </button>
            </div>
          </form>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
