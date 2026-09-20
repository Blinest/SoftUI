import type { ThemeMode } from "../softuiTypes";

const STORAGE_KEY = "softui:themePreference";

/** 用户偏好：显式浅色 / 显式深色 / 跟随系统。 */
export type ThemePreference = ThemeMode | "system";

/**
 * 主题状态由 Rust 端持有（set_theme 会往返一次），这里只负责把最终结果
 * 落到 <html data-theme> 上，让 styles/*.css 的 token 生效。
 */
export function applyTheme(theme: ThemeMode) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ThemeMode {
  if (preference === "light" || preference === "dark") return preference;
  return systemPrefersDark ? "dark" : "light";
}

export function readThemePreference(username?: string): ThemePreference {
  try {
    const raw = localStorage.getItem(username ? `${STORAGE_KEY}:${username}` : STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    /* localStorage 不可用时按系统默认 */
  }
  return "system";
}

export function writeThemePreference(username: string, preference: ThemePreference) {
  const key = `${STORAGE_KEY}:${username}`;
  try {
    localStorage.setItem(key, preference);
    // index.html 的预水合脚本按写入时间挑最新的那条，避免多账号之间互相污染。
    localStorage.setItem(`${key}:stamp`, String(Date.now()));
  } catch {
    /* 忽略写入失败 */
  }
}
