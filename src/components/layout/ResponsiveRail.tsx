import { ChevronDown, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";

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

  /**
   * 分组折叠状态，默认只展开第一组。
   *
   * 三组各 6 个通道全部铺开时侧栏有二十多行，想找的通道得一直滚 —— 这就是"拥挤"的
   * 来源。做成下拉后按需展开；默认留一组开着，是为了让人一眼看出标题是可以点的，
   * 不至于以为侧栏是空的。
   *
   * 初值依赖 groups，而首帧 channels 还可能是空的，所以用"渲染期修正状态"这个写法
   * （React 允许，会在提交前立刻重渲染）。放 useEffect 里会先闪一下"全展开"的样子。
   */
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set<string>());
  const seededRef = useRef(false);
  if (!seededRef.current && groups.length > 0) {
    seededRef.current = true;
    setOpenKeys(new Set([groups[0][0]]));
  }

  const toggleGroup = (key: string) => {
    setOpenKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="charts-sidebar">
      {groups.map(([key, items]) => {
        const open = openKeys.has(key);
        const shown = items.filter((item) => visibleNames.has(item.name)).length;
        return (
          <section className={`channel-group${open ? " is-open" : ""}`} key={key}>
            <button
              aria-expanded={open}
              className="channel-group-header"
              onClick={() => toggleGroup(key)}
              type="button"
            >
              <ChevronDown aria-hidden="true" className="channel-group-chevron" size={14} />
              <span className="channel-group-title">{chartTitles[key] ?? key}</span>
              {/* 显示"已勾选 / 总数"：收起状态下也能看出这一组开了几条通道 */}
              <span className="channel-count">{shown}/{items.length}</span>
            </button>
            {open ? (
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
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

