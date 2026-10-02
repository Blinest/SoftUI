import { LogOut, OctagonX, SunMedium, MoonStar } from "lucide-react";
import { memo } from "react";

interface GlobalStatusBarProps {
  currentDeviceLabel: string;
  connectionLabel: string;
  currentUserLabel: string;
  /** 三态：未知（还没收到帧）/ 已使能 / 未使能。 */
  systemEnabled: boolean | null;
  /**
   * 操作员最后一次成功的系统操作。
   *
   * 下位机状态帧只有 0/1，分不出「从未使能」和「刚被关闭」；这里用操作意图补齐，
   * 关闭后显示「已失能」而不是「未使能」。
   */
  systemControlAction?: "enable" | "disable" | "emergencyStop" | null;
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
  if (
    label.includes("等待") ||
    label.includes("录制中") ||
    label.includes("已失能") ||
    label.includes("未确认") ||
    normalized.includes("warning")
  ) {
    return "warning";
  }
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
  systemControlAction,
  recording,
  emergencyLatched,
  theme,
  onEmergencyStop,
  onToggleTheme,
  onLogout,
}: GlobalStatusBarProps) {
  /**
   * 使能状态的显示口径：
   *   帧说已使能 → 已使能；刚点过关闭 → 已失能；刚点过启动但帧里还是 0 → 已使能（未确认）。
   */
  const enabledLabel =
    systemEnabled === true
      ? "已使能"
      : systemControlAction === "emergencyStop"
        ? "急停锁定"
        : systemControlAction === "disable"
          ? "已失能"
          : systemControlAction === "enable"
            ? "已使能（未确认）"
            : systemEnabled === null
              ? "无数据"
              : "未使能";
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
