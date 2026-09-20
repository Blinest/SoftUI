import { useState, type ReactNode } from "react";
import { ResponsiveRail } from "../components/layout/ResponsiveRail";

export interface SettingsLayoutProps {
  navigation: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  navigationLabel?: string;
}

/** 设置页模板：左侧分类导航 + 右侧单分类内容，一次只显示一类。 */
export function SettingsLayout({
  navigation,
  actions,
  children,
  navigationLabel = "设置分类",
}: SettingsLayoutProps) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className="settings-layout">
      <ResponsiveRail
        className="settings-navigation"
        label={navigationLabel}
        collapsed={collapsed}
        onToggleCollapsed={setCollapsed}
      >
        {navigation}
      </ResponsiveRail>
      {actions ? <header className="settings-actions">{actions}</header> : null}
      <main className="layout-scroll-region">{children}</main>
    </section>
  );
}
