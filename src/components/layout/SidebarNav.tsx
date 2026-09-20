import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { memo } from "react";
import { NavLink } from "react-router-dom";

import { navigationGroups } from "../../app/navigation";

interface SidebarNavProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

/** 主导航：唯一导航入口，顶部状态栏不再重复导航。 */
export const SidebarNav = memo(function SidebarNav({ collapsed, onToggleCollapsed }: SidebarNavProps) {
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;

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
      <nav className="sidebar-nav">
        {navigationGroups.map((group) => (
          <section className="sidebar-nav-group" key={group.label} aria-label={group.label}>
            <h2>{group.label}</h2>
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  className={({ isActive }) => `sidebar-nav-link${isActive ? " is-active" : ""}`}
                  key={item.key}
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
