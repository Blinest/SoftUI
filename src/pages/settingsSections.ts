import type { LucideIcon } from "lucide-react";
import {
  Database,
  Info,
  Monitor,
  PauseCircle,
  Plug,
  Users,
} from "lucide-react";

export type SettingsSection =
  | "application"
  | "appearance"
  | "connection"
  | "accounts"
  | "diagnostics"
  | "migration";

export interface SettingsSectionMeta {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
}

/** 设置页分类。一次只显示一类，避免多个面板并排堆叠。 */
export const settingsSections: SettingsSectionMeta[] = [
  { id: "application", label: "应用与路径", icon: Info },
  { id: "appearance", label: "外观与布局", icon: Monitor },
  { id: "connection", label: "连接配置", icon: Plug },
  { id: "accounts", label: "账户与权限", icon: Users },
  { id: "diagnostics", label: "日志与诊断", icon: PauseCircle },
  { id: "migration", label: "数据迁移", icon: Database },
];
