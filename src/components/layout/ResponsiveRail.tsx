import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import type { ChartSection } from "../../softuiTypes";

export interface ResponsiveRailProps {
  label: string;
  children: ReactNode;
  className?: string;
  /** 置 false 时不给折叠按钮。 */
  collapsible?: boolean;
  /** 受控折叠状态；由页面模板持有，因为主区有时需要感知（例如 uPlot 重算尺寸）。 */
  collapsed: boolean;
  onToggleCollapsed: (collapsed: boolean) => void;
}

/**
 * 左侧栏容器：窄屏（<=1119px）时由 layouts.css 折成整宽横条。
 * 折叠状态受控，页面模板决定语义。
 */
export function ResponsiveRail({
  label,
  children,
  className,
  collapsible = true,
  collapsed,
  onToggleCollapsed,
}: ResponsiveRailProps) {
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <aside
      className={`responsive-rail${collapsed ? " is-collapsed" : ""} ${className ?? ""}`.trim()}
      aria-label={label}
    >
      <div className="responsive-rail-title">
        <span>{label}</span>
        {collapsible ? (
          <button
            aria-label={collapsed ? `展开${label}` : `收起${label}`}
            aria-expanded={!collapsed}
            className="responsive-rail-toggle"
            onClick={() => onToggleCollapsed(!collapsed)}
            type="button"
          >
            <Icon aria-hidden="true" size={15} />
          </button>
        ) : null}
      </div>
      <div className="responsive-rail-scroll" aria-hidden={collapsed}>
        {children}
      </div>
    </aside>
  );
}

interface ChannelSidebarProps {
  /** 所有通道（用于分组）。 */
  channels: ChartSection["channels"];
  /** 已勾选显示的通道名。 */
  visibleNames: Set<string>;
  /** 每个通道所属的图表 key。 */
  chartKeyFor: (channel: ChartSection["channels"][number]) => string | null;
  /** 每个图表 key 的标题。 */
  chartTitles: Record<string, string>;
  onToggleChannel: (name: string) => void;
}

/** 通道控制栏内容：按图表分组列出通道，勾选控制显示。 */
export function ChannelSidebar({
  channels,
  visibleNames,
  chartKeyFor,
  chartTitles,
  onToggleChannel,
}: ChannelSidebarProps) {
  const groups = useMemo(() => {
    const byKey = new Map<string, ChartSection["channels"]>();
    for (const channel of channels) {
      const key = chartKeyFor(channel);
      if (!key) continue;
      const bucket = byKey.get(key);
      if (bucket) bucket.push(channel);
      else byKey.set(key, [channel]);
    }
    return [...byKey.entries()];
  }, [channels, chartKeyFor]);

  return (
    <div className="charts-sidebar">
      {groups.map(([key, items]) => (
        <section className="channel-group" key={key}>
          <div className="channel-group-header">
            <span>{chartTitles[key] ?? key}</span>
            <span className="channel-count">{items.length}</span>
          </div>
          <div className="channel-items">
            {items.map((channel) => (
              <label
                className={`channel-item${visibleNames.has(channel.name) ? " is-assigned" : ""}`}
                key={channel.name}
              >
                <input
                  type="checkbox"
                  checked={visibleNames.has(channel.name)}
                  onChange={() => onToggleChannel(channel.name)}
                />
                <span className="channel-name" title={channel.name}>{channel.name}</span>
                <span className="channel-unit">{channel.unit}</span>
              </label>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
