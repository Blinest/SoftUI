import { LogOut, OctagonX, SunMedium, MoonStar } from "lucide-react";
import { memo } from "react";

interface GlobalStatusBarProps {
  currentDeviceLabel: string;
  connectionLabel: string;
  currentUserLabel: string;
  /** 三态：未知（还没收到帧）/ 已使能 / 未使能。 */
  systemEnabled: boolean | null;
  recording: boolean;
  emergencyLatched: boolean;
  theme: "dark" | "light";
  onEmergencyStop: () => void;
  onToggleTheme: () => void;
  onLogout: () => void;
}

type StatusSeverity = "danger" | "muted" | "ok" | "warning";

function statusSeverity(label: string): StatusSeverity {
  const normalized = label.toLowerCase();
  if (label.includes("急停") || label.includes("故障") || normalized.includes("error")) return "danger";
  if (label.includes("等待") || label.includes("录制中") || normalized.includes("warning")) return "warning";
  if (["ready", "enabled", "正常", "已使能"].includes(label)) return "ok";
  return "muted";
}

function statusChipClass(label: string, extraClass = "") {
  return `status-chip status-indicator is-${statusSeverity(label)}${extraClass ? ` ${extraClass}` : ""}`;
}

/**
 * 全局状态栏：设备与连接状态始终可见（不可折叠、不可隐藏），
 * 右侧固定急停与账户操作。页面级的刷新/连接/录制动作不放这里。
 */
export const GlobalStatusBar = memo(function GlobalStatusBar({
  currentDeviceLabel,
  connectionLabel,
  currentUserLabel,
  systemEnabled,
  recording,
  emergencyLatched,
  theme,
  onEmergencyStop,
  onToggleTheme,
  onLogout,
}: GlobalStatusBarProps) {
  const enabledLabel = systemEnabled === null ? "无数据" : systemEnabled ? "已使能" : "未使能";
  const recordingLabel = recording ? "录制中" : "未录制";
  const ThemeIcon = theme === "dark" ? SunMedium : MoonStar;

  return (
    <header className="global-status-bar">
      <div className="global-status-items" aria-label="全局设备状态">
        <span className="global-status-device" title={currentDeviceLabel}>{currentDeviceLabel}</span>
        <span className={statusChipClass(connectionLabel, "global-status-connection")}>{connectionLabel}</span>
        <span className={statusChipClass(enabledLabel)}>{enabledLabel}</span>
        <span className={statusChipClass(recordingLabel)}>{recordingLabel}</span>
        {emergencyLatched ? (
          <span aria-live="assertive" className={statusChipClass("急停锁定", "is-emergency")}>急停锁定</span>
        ) : null}
      </div>
      <div className="global-status-actions">
        <button
          aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
          className="global-account-control"
          onClick={onToggleTheme}
          type="button"
        >
          <ThemeIcon size={16} />
          <span>{theme === "dark" ? "浅色" : "深色"}</span>
        </button>
        <button
          aria-label={`退出 ${currentUserLabel}`}
          className="global-account-control"
          onClick={onLogout}
          type="button"
        >
          <LogOut size={16} />
          <span>{currentUserLabel}</span>
        </button>
        <button
          aria-label="紧急停止"
          aria-pressed={emergencyLatched}
          className="emergency-stop-button"
          onClick={onEmergencyStop}
          type="button"
        >
          <OctagonX aria-hidden="true" size={18} />
          <span>紧急停止</span>
        </button>
      </div>
    </header>
  );
});
