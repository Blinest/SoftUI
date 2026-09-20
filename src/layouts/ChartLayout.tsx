import { useState, type ReactNode } from "react";
import { ResponsiveRail } from "../components/layout/ResponsiveRail";

export interface ChartLayoutProps {
  channels: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
  channelsLabel?: string;
  /** 折叠通道栏会改变主区宽度；uPlot 需要配合 ResizeObserver，见 charts.tsx。 */
  collapsibleChannels?: boolean;
}

/** 曲线页模板：左侧通道控制栏 + 顶部工具栏 + 全高曲线主区。 */
export function ChartLayout({
  channels,
  toolbar,
  children,
  channelsLabel = "曲线通道",
  collapsibleChannels = true,
}: ChartLayoutProps) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className="chart-layout">
      <ResponsiveRail
        className="chart-channels"
        label={channelsLabel}
        collapsible={collapsibleChannels}
        collapsed={collapsed}
        onToggleCollapsed={setCollapsed}
      >
        {channels}
      </ResponsiveRail>
      {toolbar ? <header className="chart-toolbar">{toolbar}</header> : null}
      <main className="layout-scroll-region">{children}</main>
    </section>
  );
}
