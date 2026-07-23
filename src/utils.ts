import type { ConnectionState, FrameQuality, LogLevel, PageKey } from "./softuiTypes";

export function isoShort(ms: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

export function isoFull(ms: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function toneForLevel(level: LogLevel) {
  switch (level) {
    case "warn":
      return "warn" as const;
    case "error":
      return "error" as const;
    case "debug":
      return "neutral" as const;
    default:
      return "info" as const;
  }
}

export function routeToPage(pathname: string): PageKey {
  if (pathname.startsWith("/workspace")) return "Workspace";
  if (pathname.startsWith("/connection")) return "Workspace";
  if (pathname.startsWith("/live-table")) return "Workspace";
  if (pathname.startsWith("/charts")) return "Charts";
  if (pathname.startsWith("/model")) return "Model";
  if (pathname.startsWith("/calibration")) return "Workspace";
  if (pathname.startsWith("/playback")) return "Workspace";
  if (pathname.startsWith("/logs")) return "Logs";
  if (pathname.startsWith("/settings")) return "Settings";
  return "Dashboard";
}

export function connectionStateLabel(state: ConnectionState): string {
  const map: Partial<Record<ConnectionState, string>> = {
    idle: "空闲",
    connecting: "连接中",
    handshaking: "握手中",
    ready: "已连接",
    disabled: "已禁用",
    error: "错误",
  };
  return map[state] ?? state;
}

export function qualityLabel(quality: FrameQuality): string {
  const map: Record<FrameQuality, string> = {
    ok: "正常",
    warning: "警告",
    invalid: "无效",
  };
  return map[quality] ?? quality;
}

export function runningLabel(running: boolean): string {
  return running ? "运行" : "停止";
}
