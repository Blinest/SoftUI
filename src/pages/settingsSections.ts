import type { LucideIcon } from "lucide-react";
import {
  Download,
  Info,
  Monitor,
  PauseCircle,
  Users,
} from "lucide-react";

export type SettingsSection =
  | "application"
  | "appearance"
  | "accounts"
  | "diagnostics"
  | "export";

export interface SettingsSectionMeta {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
}

/** 设置页分类。一次只显示一类，避免多个面板并排堆叠。 */
export const settingsSections: SettingsSectionMeta[] = [
  { id: "application", label: "应用信息", icon: Info },
  { id: "appearance", label: "外观与布局", icon: Monitor },
  { id: "accounts", label: "我的账号", icon: Users },
  { id: "diagnostics", label: "日志与诊断", icon: PauseCircle },
  { id: "export", label: "数据导出", icon: Download },
];
