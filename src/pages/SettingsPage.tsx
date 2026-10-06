import { useCallback, useEffect, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, Cpu, RefreshCw, ShieldX, SunMedium, Users } from "lucide-react";

import Badge from "../components/Badge";
import { SettingsNavigation } from "../components/SettingsNavigation";
import { SettingsLayout } from "../layouts/SettingsLayout";
import { settingsSections, type SettingsSection } from "./settingsSections";
import { hasPermission, CAPABILITY_MATRIX, PERMISSION_REASON, ROLE_DUTY } from "../state/permissions";
import type {
  ClientSessionView,
  RecorderStatus,
  RuntimeSnapshot,
} from "../softuiTypes";
import "../styles/settings.css";

/** 把时间戳说成"刚刚 / N 分钟前"，后台列表里比一串 ISO 时间好读得多。 */
function formatRelative(timestampMs: number): string {
  if (!timestampMs) return "—";
  const delta = Date.now() - timestampMs;
  if (delta < 5_000) return "刚刚";
  if (delta < 60_000) return `${Math.round(delta / 1000)} 秒前`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)} 小时前`;
  return new Date(timestampMs).toLocaleString("zh-CN", { hour12: false });
}

export interface SettingsPageProps {
  snapshot: RuntimeSnapshot;
  recorderStatus: RecorderStatus;
  diagnosticsPath: string;
  onToggleTheme: () => void;
  onExportDiagnostics: () => void;
  onResetLayouts: () => void;
}

/** 设置页：左侧分类导航 + 右侧单分类内容。 */
export function SettingsPage({
  snapshot,
  recorderStatus,
  diagnosticsPath,
  onToggleTheme,
  onExportDiagnostics,
  onResetLayouts,
}: SettingsPageProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>("application");
  const [accountMessage, setAccountMessage] = useState("");
  /** 本账号已登录的设备 —— 自助查询，只包含自己。 */
  const [mySessions, setMySessions] = useState<ClientSessionView[]>([]);
  const [ownOldPassword, setOwnOldPassword] = useState("");
  const [ownNewPassword, setOwnNewPassword] = useState("");
  /** 本账号各设备的 IP 属地（由网关代查并缓存）。查不到就显示"—"。 */
  const [geoByIp, setGeoByIp] = useState<Record<string, string>>({});

  const canDiagnostics = hasPermission(snapshot, "viewDiagnostics");

  /* 注意这里查的是 `list_my_sessions`（自助接口），不是管理员的 `list_clients`。
   * 前台只该看到自己的设备 —— 全站在线设备、别人在哪个 IP、账号列表这些都归
   * 后台管，不该出现在操作员日常用的界面上。 */
  const loadMySessions = useCallback(async () => {
    try {
      const list = await invoke<ClientSessionView[]>("list_my_sessions");
      setMySessions(list);
    } catch {
      // 未登录或网络问题：静默为空，不影响本页其它设置项
      setMySessions([]);
    }
  }, []);

  useEffect(() => {
    void loadMySessions();
  }, [loadMySessions]);

  /* 查自己设备的 IP 属地。和后台用的是同一个网关接口。
   * 查不到（离线 / 被限流 / 桌面版没有网关）就保持空，界面显示"—"。 */
  useEffect(() => {
    const ips = Array.from(
      new Set(
        mySessions
          .map((item) => (item.ip ?? "").trim())
          .filter((ip) => ip.length > 0),
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
  }, [mySessions]);

  const runAccountAction = async (action: () => Promise<void>, successMessage: string) => {
    setAccountMessage("");
    try {
      await action();
      setAccountMessage(successMessage);
    } catch (invokeError) {
      setAccountMessage(invokeError instanceof Error ? invokeError.message : String(invokeError));
    }
  };

  /** 退掉本账号的某台设备。不要求管理员权限：后端只允许操作自己的会话。 */
  const revokeMySession = async (sessionId: string) => {
    await runAccountAction(async () => {
      await invoke("revoke_my_session", { sessionId });
      await loadMySessions();
    }, "已退掉那台设备");
  };

  const submitOwnPassword = async (event: FormEvent) => {
    event.preventDefault();
    await runAccountAction(async () => {
      // username 传 null = 改**自己**的密码；后端要求同时提供旧密码
      await invoke("change_password", {
        request: { username: null, oldPassword: ownOldPassword, newPassword: ownNewPassword },
      });
      setOwnOldPassword("");
      setOwnNewPassword("");
      await loadMySessions();
    }, "密码已修改");
  };

  const activeLabel = settingsSections.find((section) => section.id === activeSection)?.label ?? "";

  const sectionBody = () => {
    switch (activeSection) {
      case "application":
        return (
          <section className="settings-panel">
            <header><div><span className="panel-kicker">settings</span><h2>应用信息</h2></div></header>
            <div className="settings-stack">
              <div className="settings-row"><span>后端</span><strong>{snapshot.appInfo.backend}</strong></div>
              <div className="settings-row"><span>版本</span><strong>{snapshot.appInfo.version}</strong></div>
              <div className="settings-row"><span>数据目录</span><strong title={snapshot.settings.dataDirectory}>{snapshot.settings.dataDirectory}</strong></div>
              <div className="settings-row"><span>模型目录</span><strong title={snapshot.settings.modelDirectory}>{snapshot.settings.modelDirectory}</strong></div>
              <div className="settings-row"><span>当前会话</span><strong>{snapshot.dashboard.currentSession || "—"}</strong></div>
            </div>

            <div className="settings-subheader">
              <h3>连接</h3>
              <span>串口与连接配置。要新增配置，可在设备工作台里连接后勾选「保存为配置」。</span>
            </div>
            <div className="settings-stack">
              <div className="settings-row"><span>连接状态</span><strong>{snapshot.connection.state}</strong></div>
              <div className="settings-row"><span>握手步骤</span><strong>{snapshot.connection.handshakeStep || "—"}</strong></div>
              <div className="settings-row"><span>订阅串口</span><strong>{snapshot.connection.ports.length}</strong></div>
              <div className="settings-row"><span>激活配置</span><strong>{snapshot.connection.activeProfileName || "—"}</strong></div>
              <div className="settings-row"><span>自动重连</span><strong>{snapshot.settings.autoReconnect ? "启用" : "关闭"}</strong></div>
            </div>
            {snapshot.connection.profiles.length === 0 ? (
              <div className="settings-result">还没有保存的连接配置。</div>
            ) : (
              <div className="settings-profile-list">
                {snapshot.connection.profiles.map((profile) => (
                  <div className="settings-row" key={profile.id}>
                    <span>{profile.name}</span>
                    <strong>{profile.port} @ {profile.baudRate.toLocaleString()}</strong>
                  </div>
                ))}
              </div>
            )}
          </section>
        );

      case "appearance":
        return (
          <section className="settings-panel">
            <header><div><span className="panel-kicker">settings</span><h2>外观与布局</h2></div></header>
            <div className="settings-stack">
              <div className="settings-row"><span>主题</span><strong>{snapshot.settings.theme}</strong></div>
              <div className="settings-row"><span>界面密度</span><strong>{snapshot.settings.workspaceDensity}</strong></div>
              <div className="settings-row"><span>退出时保存布局</span><strong>{snapshot.settings.saveLayoutOnExit ? "启用" : "关闭"}</strong></div>
            </div>
            <div className="settings-actions-row">
              <button type="button" className="ghost-btn" onClick={onToggleTheme}>
                <SunMedium size={16} /><span>切换主题</span>
              </button>
              <button type="button" className="ghost-btn" onClick={onResetLayouts}>
                <span>重置卡片布局</span>
              </button>
            </div>
          </section>
        );

      case "accounts":
        return (
          <section className="settings-panel">
            <header>
              <div><span className="panel-kicker">auth</span><h2>我的账号</h2></div>
              <button type="button" className="ghost-btn" onClick={() => void loadMySessions()}>
                <RefreshCw size={16} /><span>刷新设备</span>
              </button>
            </header>
            <div className="settings-stack">
              <div className="settings-row"><span>当前用户</span><strong>{snapshot.authSession.authenticated ? snapshot.authSession.username : "未登录"}</strong></div>
              <div className="settings-row"><span>角色</span><strong>{snapshot.authSession.role}</strong></div>
              <div className="settings-row"><span>角色职责</span><strong>{ROLE_DUTY[snapshot.authSession.role] ?? "—"}</strong></div>
              <div className="settings-row">
                <span>我的设备</span>
                <strong>
                  {mySessions.length
                    ? `${mySessions.filter((item) => item.online).length} 在线 / ${mySessions.length} 台`
                    : "—"}
                </strong>
              </div>
            </div>

            <div className="settings-subheader">
              <h3>我的权限</h3>
              <span>界面会按角色禁用无权使用的操作，后端对每条命令也会再校验一次。</span>
            </div>
            <div className="settings-stack">
              {CAPABILITY_MATRIX.map((item) => {
                const allowed = hasPermission(snapshot, item.permission);
                return (
                  <div className="settings-row" key={item.permission}>
                    <span>{item.label}</span>
                    <Badge tone={allowed ? "ok" : "warn"}>
                      {allowed ? "可用" : `需 ${item.since}`}
                    </Badge>
                  </div>
                );
              })}
            </div>

            <div className="settings-subheader">
              <h3>我的设备</h3>
              <span>本账号登录过的设备。看到不认识的设备就退掉它，然后改密码。</span>
            </div>
            {mySessions.length === 0 ? (
              <div className="settings-result">暂无记录。</div>
            ) : (
              <div className="settings-client-list">
                {mySessions.map((item) => (
                  <div className="settings-client-row" key={item.sessionId}>
                    <div className="settings-client-main">
                      <strong>
                        {item.label}
                        <span className="settings-client-tag">{item.role}</span>
                      </strong>
                      <span>
                        {item.ip || "地址未知"}
                        {geoByIp[item.ip] ? ` · ${geoByIp[item.ip]}` : ""} · 最近活动{" "}
                        {formatRelative(item.lastSeenMs)}
                      </span>
                      <span className="settings-client-agent" title={item.userAgent}>
                        {item.userAgent || "—"}
                      </span>
                    </div>
                    <Badge tone={item.online ? "ok" : "warn"}>{item.online ? "在线" : "离线"}</Badge>
                    <button
                      type="button"
                      className="ghost-btn"
                      onClick={() => void revokeMySession(item.sessionId)}
                    >
                      <ShieldX size={16} /><span>退掉这台设备</span>
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="settings-subheader">
              <h3>修改我的密码</h3>
              <span>改完其它设备需要用新密码重新登录。忘了旧密码请联系管理员在后台重置。</span>
            </div>
            <form className="account-form" onSubmit={submitOwnPassword}>
              <label><span>当前密码</span>
                <input
                  type="password"
                  value={ownOldPassword}
                  onChange={(event) => setOwnOldPassword(event.target.value)}
                  autoComplete="current-password"
                />
              </label>
              <label><span>新密码</span>
                <input
                  type="password"
                  value={ownNewPassword}
                  onChange={(event) => setOwnNewPassword(event.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <button
                type="submit"
                className="primary-btn full"
                disabled={!ownOldPassword || ownNewPassword.length < 4}
              >
                <CheckCircle2 size={16} /><span>修改密码</span>
              </button>
            </form>

            <div className="settings-result">
              需要管理**其它**账号（新建 / 停用 / 重置密码 / 踢下线 / 设备上限 / 注册审批）请到后台管理站点操作。
            </div>
            {accountMessage ? <div className="settings-result">{accountMessage}</div> : null}
          </section>
        );

      case "diagnostics":
        return (
          <section className="settings-panel">
            <header><div><span className="panel-kicker">diagnostics</span><h2>日志与诊断</h2></div></header>
            <div className="settings-stack">
              <div className="settings-row"><span>诊断级别</span><strong>{snapshot.settings.diagnosticsLevel}</strong></div>
              <div className="settings-row"><span>存储帧</span><strong>{snapshot.runtimeDiagnostics.storedFrames} / {snapshot.runtimeDiagnostics.liveCapacity}</strong></div>
              <div className="settings-row"><span>丢弃帧</span><strong>{snapshot.runtimeDiagnostics.droppedFrames}</strong></div>
              <div className="settings-row"><span>协议错误</span><strong>{snapshot.runtimeDiagnostics.protocolErrors}</strong></div>
              <div className="settings-row"><span>重连次数</span><strong>{snapshot.runtimeDiagnostics.reconnectAttempts}</strong></div>
              <div className="settings-row"><span>录制状态</span><strong>{recorderStatus.active ? (recorderStatus.paused ? "已暂停" : "录制中") : "空闲"}</strong></div>
            </div>
            <div className="settings-actions-row">
              <button
                type="button"
                className="ghost-btn"
                disabled={!canDiagnostics}
                title={canDiagnostics ? undefined : PERMISSION_REASON.viewDiagnostics}
                onClick={onExportDiagnostics}
              >
                <Cpu size={16} /><span>导出诊断包</span>
              </button>
            </div>
            {diagnosticsPath ? <div className="settings-result" title={diagnosticsPath}>诊断包：{diagnosticsPath}</div> : null}
          </section>
        );

    }
  };

  return (
    <SettingsLayout
      navigationLabel="设置分类"
      navigation={
        <SettingsNavigation
          active={activeSection}
          sections={settingsSections.map((section) => ({ id: section.id, label: section.label }))}
          onSelect={(id) => setActiveSection(id as SettingsSection)}
        />
      }
      actions={<div className="settings-actions-label"><Users aria-hidden="true" size={14} />当前：{activeLabel}</div>}
    >
      {sectionBody()}
    </SettingsLayout>
  );
}
