import { useState, type ReactNode } from "react";
import { ResponsiveRail } from "../components/layout/ResponsiveRail";

export interface WorkbenchLayoutProps {
  context: ReactNode;
  /** 可选：不传时不渲染顶部标签条。 */
  tabs?: ReactNode;
  children: ReactNode;
  contextLabel?: string;
}

/** 设备工作台模板：左侧设备上下文栏 + 顶部视图标签 + 右侧任务区。 */
export function WorkbenchLayout({
  context,
  tabs,
  children,
  contextLabel = "设备上下文",
}: WorkbenchLayoutProps) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className="workbench-layout">
      <ResponsiveRail
        className="workbench-context"
        label={contextLabel}
        collapsed={collapsed}
        onToggleCollapsed={setCollapsed}
      >
        {context}
      </ResponsiveRail>
      {tabs ? <header className="workbench-tabs">{tabs}</header> : null}
      <main className="layout-fill-region" data-card-grid-viewport="">
        {children}
      </main>
    </section>
  );
}
