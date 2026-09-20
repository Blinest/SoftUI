import type { ReactNode } from "react";

export interface DashboardLayoutProps {
  summary: ReactNode;
  children: ReactNode;
}

/** 总览页模板：顶部一条全局摘要带，下方自适应卡片栅格。 */
export function DashboardLayout({ summary, children }: DashboardLayoutProps) {
  return (
    <section className="dashboard-layout">
      <header className="dashboard-summary">{summary}</header>
      <main className="layout-fill-region" data-card-grid-viewport="">{children}</main>
    </section>
  );
}
