import {
  BarChart3,
  Cpu,
  Database,
  LayoutDashboard,
  Logs,
  Settings2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { PageKey } from "../softuiTypes";

export interface NavigationItem {
  key: PageKey;
  path: string;
  title: string;
  subtitle: string;
  icon: LucideIcon;
}

/** 侧边栏分组。分组只是视觉分层，不影响路由。 */
export const navigationGroups: Array<{ label: string; items: NavigationItem[] }> = [
  {
    label: "运行",
    items: [
      { key: "Dashboard", path: "/dashboard", title: "总览", subtitle: "运行概况", icon: LayoutDashboard },
      { key: "Workspace", path: "/workspace", title: "设备工作台", subtitle: "串口 / 状态 / 控制", icon: Cpu },
      { key: "Charts", path: "/charts", title: "曲线分析", subtitle: "实时与历史曲线", icon: BarChart3 },
    ],
  },
  {
    label: "数据",
    items: [
      { key: "Sessions", path: "/sessions", title: "会话与记录", subtitle: "录制与导出", icon: Database },
      { key: "Logs", path: "/logs", title: "日志与诊断", subtitle: "诊断与审计", icon: Logs },
    ],
  },
  {
    label: "系统",
    items: [
      { key: "Settings", path: "/settings", title: "系统设置", subtitle: "路径与主题", icon: Settings2 },
    ],
  },
];

export const pageTitles: Record<PageKey, string> = {
  Dashboard: "总览",
  Workspace: "设备工作台",
  Charts: "曲线分析",
  Sessions: "会话与记录",
  Logs: "日志与诊断",
  Settings: "系统设置",
  Model: "3D 窗口",
};

export const pageDescriptions: Record<PageKey, string> = {
  Dashboard: "查看设备、采样、会话和最近异常。",
  Workspace: "把串口、设备状态、实时表格、控制和回放放在同一工作区。",
  Charts: "查看电机、传感器和曲率曲线。",
  Sessions: "录制实验数据、管理会话和导出 CSV。",
  Logs: "筛选运行日志和审计记录。",
  Settings: "调整主题、路径和布局偏好。",
  Model: "打开 3D 窗口壳子，后续再接模型内容。",
};

export function routeToPage(pathname: string): PageKey {
  if (pathname.startsWith("/workspace")) return "Workspace";
  if (pathname.startsWith("/connection")) return "Workspace";
  if (pathname.startsWith("/live-table")) return "Workspace";
  if (pathname.startsWith("/charts")) return "Charts";
  if (pathname.startsWith("/model")) return "Model";
  if (pathname.startsWith("/calibration")) return "Workspace";
  if (pathname.startsWith("/playback")) return "Workspace";
  if (pathname.startsWith("/logs")) return "Logs";
  if (pathname.startsWith("/sessions")) return "Sessions";
  if (pathname.startsWith("/settings")) return "Settings";
  return "Dashboard";
}
