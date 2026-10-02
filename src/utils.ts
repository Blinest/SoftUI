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

/**
 * 从任意抛出物里取一段可读的错误文本。
 *
 * Tauri 的 `invoke` 在命令返回 `Err(String)`（Rust 侧的 `Result<_, String>`）时，reject 的是
 * **字符串本身**，不是 `Error` 实例。所以 `err instanceof Error ? err.message : "命令失败"`
 * 这种写法会把后端的真实原因整段吞掉，界面上只剩下无信息量的「命令失败」——
 * 未使能、曲率超表、串口错误全都长一样。这里统一处理 string / Error / 带 message 的对象。
 */
export function errorText(error: unknown, fallback = "命令失败"): string {
  if (typeof error === "string") return error.trim() || fallback;
  if (error instanceof Error) return error.message.trim() || fallback;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
    try {
      return JSON.stringify(error);
    } catch {
      /* 循环引用：退回 fallback */
    }
  }
  return fallback;
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
