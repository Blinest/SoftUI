import { useState, type FormEvent } from "react";
import { CheckCircle2, Cpu, Database, Eye, Save, SunMedium, Users } from "lucide-react";

import Badge from "../components/Badge";
import { SettingsNavigation } from "../components/SettingsNavigation";
import { SettingsLayout } from "../layouts/SettingsLayout";
import { settingsSections, type SettingsSection } from "./settingsSections";
import type {
  LegacyMigrationPreview,
  LegacyMigrationReport,
  RecorderStatus,
  Role,
  RuntimeSnapshot,
  UserAccount,
} from "../softuiTypes";
import "../styles/settings.css";

export interface SettingsPageProps {
  snapshot: RuntimeSnapshot;
  users: UserAccount[];
  recorderStatus: RecorderStatus;
  diagnosticsPath: string;
  migrationSource: string;
  migrationPreview: LegacyMigrationPreview | null;
  migrationReport: LegacyMigrationReport | null;
  onToggleTheme: () => void;
  onExportDiagnostics: () => void;
  onMigrationSourceChange: (value: string) => void;
  onPreviewMigration: () => void;
  onRunMigration: () => void;
  onCreateUser: (username: string, password: string, role: Role) => Promise<void>;
  onResetUserPassword: (username: string, newPassword: string) => Promise<void>;
  onSetUserDisabled: (username: string, disabled: boolean) => Promise<void>;
  onResetLayouts: () => void;
}

/** 设置页：左侧分类导航 + 右侧单分类内容。 */
export function SettingsPage({
  snapshot,
  users,
  recorderStatus,
  diagnosticsPath,
  migrationSource,
  migrationPreview,
  migrationReport,
  onToggleTheme,
  onExportDiagnostics,
  onMigrationSourceChange,
  onPreviewMigration,
  onRunMigration,
  onCreateUser,
  onResetUserPassword,
  onSetUserDisabled,
  onResetLayouts,
}: SettingsPageProps) {
  const [activeSection, setActiveSection] = useState<SettingsSection>("application");
  const [newUsername, setNewUsername] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [newUserRole, setNewUserRole] = useState<Role>("operator");
  const [resetUsername, setResetUsername] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [accountMessage, setAccountMessage] = useState("");

  const migrationTotal = migrationPreview
    ? migrationPreview.userFiles + migrationPreview.configFiles + migrationPreview.csvFiles + migrationPreview.logFiles
    : 0;
  const canManageUsers = snapshot.authSession.permissions.includes("manageUsers");

  const runAccountAction = async (action: () => Promise<void>, successMessage: string) => {
    setAccountMessage("");
    try {
      await action();
      setAccountMessage(successMessage);
    } catch (invokeError) {
      setAccountMessage(invokeError instanceof Error ? invokeError.message : String(invokeError));
    }
  };

  const submitCreateUser = async (event: FormEvent) => {
    event.preventDefault();
    await runAccountAction(async () => {
      await onCreateUser(newUsername, newUserPassword, newUserRole);
      setNewUsername("");
      setNewUserPassword("");
      setNewUserRole("operator");
    }, "用户已创建");
  };

  const submitResetPassword = async (event: FormEvent) => {
    event.preventDefault();
    await runAccountAction(async () => {
      await onResetUserPassword(resetUsername, resetPassword);
      setResetPassword("");
    }, "密码已重置");
  };

  const activeLabel = settingsSections.find((section) => section.id === activeSection)?.label ?? "";

  const sectionBody = () => {
    switch (activeSection) {
      case "application":
        return (
          <section className="settings-panel">
            <header><div><span className="panel-kicker">settings</span><h2>应用与路径</h2></div></header>
            <div className="settings-stack">
              <div className="settings-row"><span>数据目录</span><strong title={snapshot.settings.dataDirectory}>{snapshot.settings.dataDirectory}</strong></div>
              <div className="settings-row"><span>模型目录</span><strong title={snapshot.settings.modelDirectory}>{snapshot.settings.modelDirectory}</strong></div>
              <div className="settings-row"><span>当前会话</span><strong>{snapshot.dashboard.currentSession || "—"}</strong></div>
              <div className="settings-row"><span>激活配置</span><strong>{snapshot.connection.activeProfileName || "—"}</strong></div>
              <div className="settings-row"><span>后端</span><strong>{snapshot.appInfo.backend}</strong></div>
              <div className="settings-row"><span>版本</span><strong>{snapshot.appInfo.version}</strong></div>
            </div>
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

      case "connection":
        return (
          <section className="settings-panel">
            <header><div><span className="panel-kicker">settings</span><h2>连接配置</h2></div></header>
            <div className="settings-stack">
              <div className="settings-row"><span>连接状态</span><strong>{snapshot.connection.state}</strong></div>
              <div className="settings-row"><span>握手步骤</span><strong>{snapshot.connection.handshakeStep || "—"}</strong></div>
              <div className="settings-row"><span>订阅串口</span><strong>{snapshot.connection.ports.length}</strong></div>
              <div className="settings-row"><span>自动重连</span><strong>{snapshot.settings.autoReconnect ? "启用" : "关闭"}</strong></div>
            </div>
            {snapshot.connection.profiles.length === 0 ? (
              <div className="settings-result">还没有保存的连接配置。可在设备工作台里连接后保存。</div>
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

      case "accounts":
        return (
          <section className="settings-panel">
            <header><div><span className="panel-kicker">auth</span><h2>账户与权限</h2></div></header>
            <div className="settings-stack">
              <div className="settings-row"><span>当前用户</span><strong>{snapshot.authSession.authenticated ? snapshot.authSession.username : "未登录"}</strong></div>
              <div className="settings-row"><span>角色</span><strong>{snapshot.authSession.role}</strong></div>
              <div className="settings-row"><span>用户数量</span><strong>{users.length || "无权限查看"}</strong></div>
            </div>

            {canManageUsers ? (
              <>
                <div className="settings-user-list">
                  {users.map((user) => (
                    <div className="settings-user-row" key={user.username}>
                      <div className="settings-user-main">
                        <strong>{user.username}</strong>
                        <span>{user.role}{user.mustChangePassword ? " / 需改密" : ""}</span>
                      </div>
                      <Badge tone={user.disabled ? "error" : "ok"}>{user.disabled ? "停用" : "启用"}</Badge>
                      <button
                        type="button"
                        className="ghost-btn"
                        onClick={() => void runAccountAction(
                          () => onSetUserDisabled(user.username, !user.disabled),
                          user.disabled ? "用户已启用" : "用户已停用",
                        )}
                        disabled={user.username === snapshot.authSession.username}
                      >
                        <span>{user.disabled ? "启用" : "停用"}</span>
                      </button>
                    </div>
                  ))}
                </div>

                <form className="account-form" onSubmit={submitCreateUser}>
                  <label><span>新用户</span>
                    <input value={newUsername} onChange={(event) => setNewUsername(event.target.value)} placeholder="operator_1" />
                  </label>
                  <label><span>初始密码</span>
                    <input type="password" value={newUserPassword} onChange={(event) => setNewUserPassword(event.target.value)} />
                  </label>
                  <label><span>角色</span>
                    <select value={newUserRole} onChange={(event) => setNewUserRole(event.target.value as Role)}>
                      <option value="operator">operator</option>
                      <option value="maintainer">maintainer</option>
                      <option value="admin">admin</option>
                    </select>
                  </label>
                  <button type="submit" className="primary-btn full" disabled={!newUsername.trim() || newUserPassword.length < 8}>
                    <CheckCircle2 size={16} /><span>创建用户</span>
                  </button>
                </form>

                <form className="account-form" onSubmit={submitResetPassword}>
                  <label><span>重置用户</span>
                    <select value={resetUsername} onChange={(event) => setResetUsername(event.target.value)}>
                      <option value="">选择用户</option>
                      {users.map((user) => <option value={user.username} key={user.username}>{user.username}</option>)}
                    </select>
                  </label>
                  <label><span>新密码</span>
                    <input type="password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} />
                  </label>
                  <button type="submit" className="ghost-btn full" disabled={!resetUsername || resetPassword.length < 8}>
                    <Save size={16} /><span>重置密码</span>
                  </button>
                </form>
              </>
            ) : (
              <div className="settings-result">当前角色没有用户管理权限。</div>
            )}
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
              <button type="button" className="ghost-btn" onClick={onExportDiagnostics}>
                <Cpu size={16} /><span>导出诊断包</span>
              </button>
            </div>
            {diagnosticsPath ? <div className="settings-result" title={diagnosticsPath}>诊断包：{diagnosticsPath}</div> : null}
          </section>
        );

      case "migration":
        return (
          <section className="settings-panel">
            <header><div><span className="panel-kicker">migration</span><h2>数据迁移</h2></div></header>
            <div className="migration-form">
              <label>
                <span>旧版目录</span>
                <input
                  type="text"
                  value={migrationSource}
                  onChange={(event) => onMigrationSourceChange(event.target.value)}
                  placeholder="例如 D:\\...\\SoftUI"
                />
              </label>
              <button type="button" className="ghost-btn" onClick={onPreviewMigration}>
                <Eye size={16} /><span>预览</span>
              </button>
              <button type="button" className="primary-btn" onClick={onRunMigration} disabled={!migrationPreview?.exists}>
                <Database size={16} /><span>执行迁移</span>
              </button>
            </div>

            {migrationPreview ? (
              <div className="migration-summary">
                <div><span>用户</span><strong>{migrationPreview.userFiles}</strong></div>
                <div><span>配置</span><strong>{migrationPreview.configFiles}</strong></div>
                <div><span>CSV</span><strong>{migrationPreview.csvFiles}</strong></div>
                <div><span>日志</span><strong>{migrationPreview.logFiles}</strong></div>
                <div><span>可迁移</span><strong>{migrationTotal}</strong></div>
                <div><span>跳过</span><strong>{migrationPreview.skippedFiles}</strong></div>
              </div>
            ) : null}

            {migrationPreview?.warnings.length ? (
              <div className="settings-warning">
                {migrationPreview.warnings.slice(0, 3).map((warning) => <span key={warning}>{warning}</span>)}
              </div>
            ) : null}

            {migrationReport ? <div className="settings-result" title={migrationReport.reportPath}>报告：{migrationReport.reportPath}</div> : null}
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
