import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { memo } from "react";
import { NavLink, useLocation } from "react-router-dom";

import { routeToPage, visibleNavigationGroups } from "../../app/navigation";
import { SlidingIndicator, useSlidingIndicator } from "../SlidingIndicator";
import type { Permission } from "../../softuiTypes";

interface SidebarNavProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** 当前会话权限：用它把无权进入的入口藏掉。 */
  permissions: Permission[];
}

/** 主导航：唯一导航入口，顶部状态栏不再重复导航。 */
export const SidebarNav = memo(function SidebarNav({ collapsed, onToggleCollapsed, permissions }: SidebarNavProps) {
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const groups = visibleNavigationGroups(permissions);
  // 滑块需要知道"当前选中的是哪个键"，而这份状态只存在于路由里 ——
  // 不能让每个 NavLink 各自报 isActive，那样谁也拼不出滑块的落点。
  // routeToPage 与 navigation.ts 里 item.key 用的是同一套映射，不会对不上。
  const activeKey = routeToPage(useLocation().pathname);
  const { containerRef, setItemRef, rect } = useSlidingIndicator<string, HTMLElement>(activeKey);

  return (
    <aside className={`app-sidebar${collapsed ? " is-collapsed" : ""}`} aria-label="主导航">
      <div className="sidebar-brand">
        <span>SoftUI</span>
        <button
          aria-label={collapsed ? "展开主导航" : "收起主导航"}
          className="sidebar-collapse-button"
          onClick={onToggleCollapsed}
          title={collapsed ? "展开主导航" : "收起主导航"}
          type="button"
        >
          <ToggleIcon aria-hidden="true" size={17} />
        </button>
      </div>
      <nav className="sidebar-nav" ref={containerRef}>
        <SlidingIndicator rect={rect} />
        {groups.map((group) => (
          <section className="sidebar-nav-group" key={group.label} aria-label={group.label}>
            <h2>{group.label}</h2>
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  className={({ isActive }) => `sidebar-nav-link${isActive ? " is-active" : ""}`}
                  key={item.key}
                  ref={setItemRef(item.key)}
                  title={`${item.title} · ${item.subtitle}`}
                  to={item.path}
                >
                  <Icon aria-hidden="true" size={18} />
                  <span>{item.title}</span>
                </NavLink>
              );
            })}
          </section>
        ))}
      </nav>
    </aside>
  );
});
