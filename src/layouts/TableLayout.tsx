import type { ReactNode } from "react";

export interface TableLayoutProps {
  toolbar: ReactNode;
  children: ReactNode;
  detail?: ReactNode;
  detailLabel?: string;
}

/** 检索类页面模板：顶部筛选条 + 全高表格 + 右侧详情抽屉。 */
export function TableLayout({ toolbar, children, detail, detailLabel = "详情" }: TableLayoutProps) {
  return (
    <section className="table-layout">
      <header className="table-toolbar">{toolbar}</header>
      <div className="table-layout-content">
        <main className="layout-scroll-region">{children}</main>
        {detail ? (
          <aside className="table-detail layout-scroll-region" aria-label={detailLabel}>
            {detail}
          </aside>
        ) : null}
      </div>
    </section>
  );
}
