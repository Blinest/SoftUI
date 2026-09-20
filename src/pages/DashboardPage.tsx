import { CardGrid } from "../components/cards/CardGrid";
import { DashboardLayout } from "../layouts/DashboardLayout";
import { useCardLayout } from "../state/layoutStore";
import type {
  DashboardCardId,
  DeviceConnectionRecord,
  DeviceRuntimeStatusView,
  RecorderStatus,
  RuntimeSnapshot,
  SessionInfo,
} from "../softuiTypes";
import { dashboardCardRegistry } from "./dashboardCards";
import "../styles/dashboard-cards.css";

export interface DashboardPageProps {
  snapshot: RuntimeSnapshot;
  connectedDevices: DeviceConnectionRecord[];
  deviceStatuses: Record<string, DeviceRuntimeStatusView>;
  recorderStatus: RecorderStatus;
  sessions: SessionInfo[];
}

function frameForDevice(snapshot: RuntimeSnapshot, deviceId: string) {
  return snapshot.live.latest?.deviceId === deviceId ? snapshot.live.latest : null;
}

/** 总览页：顶部全局摘要带 + 卡片栅格。 */
export function DashboardPage({
  snapshot,
  connectedDevices,
  deviceStatuses,
  recorderStatus,
  sessions,
}: DashboardPageProps) {
  const username = snapshot.authSession.username;
  const deviceId = snapshot.live.selectedDeviceId;
  const frame = frameForDevice(snapshot, deviceId);
  const runtime = deviceStatuses[deviceId];
  const connection = connectedDevices.find((device) => device.deviceId === deviceId);
  const connectionState = connection?.state ?? runtime?.state ?? (frame ? snapshot.connection.state : "无数据");
  const globalFault = snapshot.runtimeDiagnostics.lastError
    ?? snapshot.dashboard.lastError
    ?? "无";

  // 卡片布局可拖动 / 可缩放，改动由 useCardLayout 直接写盘。
  const { layout, commit: commitLayout } = useCardLayout(username, "dashboard");

  const summary = (
    <div className="dashboard-summary-bar" aria-label="全局设备摘要">
      <div className="dashboard-summary-heading">
        <span>运行总览</span>
        <strong title={deviceId || undefined}>{deviceId || "未选择设备"}</strong>
      </div>
      <div className="critical-status-strip">
        <div><span>连接状态</span><strong>{connectionState}</strong></div>
        <div><span>使能状态</span><strong>{frame ? (frame.systemEnabled ? "已使能" : "未使能") : "无数据"}</strong></div>
        <div><span>急停状态</span><strong>{snapshot.runtimeDiagnostics.emergencyLatched ? "已锁定" : "正常"}</strong></div>
        <div><span>采样 / 帧率</span><strong>{snapshot.dashboard.sampleRateHz} Hz / {snapshot.dashboard.frameRateHz} fps</strong></div>
        <div><span>全局故障</span><strong title={globalFault}>{globalFault}</strong></div>
      </div>
    </div>
  );

  return (
    <DashboardLayout summary={summary}>
      <CardGrid
        layout={layout}
        ariaLabel="总览卡片"
        layoutKey="dashboard"
        onLayoutChange={commitLayout}
        headerForCard={(cardId) => {
          const definition = dashboardCardRegistry[cardId as DashboardCardId];
          const Icon = definition.icon;
          return { title: definition.title, icon: <Icon aria-hidden="true" size={17} /> };
        }}
        childrenForCard={(cardId) =>
          dashboardCardRegistry[cardId as DashboardCardId].render({
            snapshot,
            connectedDevices,
            deviceStatuses,
            recorderStatus,
            sessions,
          })}
      />
    </DashboardLayout>
  );
}
