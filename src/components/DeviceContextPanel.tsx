import { Cable, RefreshCw, Wifi } from "lucide-react";

import Badge from "./Badge";
import DeviceCard from "./DeviceCard";
import type {
  DeviceConnectionRecord,
  DeviceRuntimeStatusView,
  RuntimeSnapshot,
  SerialPortDescriptor,
} from "../softuiTypes";

export interface DeviceContextPanelProps {
  snapshot: RuntimeSnapshot;
  serialPorts: SerialPortDescriptor[];
  serialPortsError: string | null;
  connectedDevices: DeviceConnectionRecord[];
  deviceStatuses: Record<string, DeviceRuntimeStatusView>;
  connectionError: string | null;
  curvatureSummary: { maxKappaPerM: number; meanKappaPerM: number; tipOffsetMm: number; basisSegmentCount: number };
  hasFrame: boolean;
  onOpenConnectDialog: () => void;
  onDisconnectDevice: (deviceId: string) => void;
  onRefreshSerialPorts: () => void;
}

/**
 * 设备工作台左侧上下文栏：连接、设备选择、串口发现。
 * 这些信息在所有标签页都需要，因此常驻而不是放进某个标签。
 */
export function DeviceContextPanel({
  snapshot,
  serialPorts,
  serialPortsError,
  connectedDevices,
  deviceStatuses,
  connectionError,
  curvatureSummary,
  hasFrame,
  onOpenConnectDialog,
  onDisconnectDevice,
  onRefreshSerialPorts,
}: DeviceContextPanelProps) {
  const frame = snapshot.live.latest;
  const motors = frame?.motors.length ?? 0;
  const sensors = frame?.sensors.length ?? 0;

  return (
    <div className="device-context-panel">
      <header className="device-context-header">
        <Cable aria-hidden="true" size={17} />
        <div>
          <span>当前设备</span>
          <strong title={snapshot.live.selectedDeviceId || undefined}>
            {snapshot.live.selectedDeviceId || "未选择设备"}
          </strong>
        </div>
      </header>

      <div className="context-status-list">
        <div><span>连接状态</span><strong>{snapshot.connection.state}</strong></div>
        <div><span>握手进度</span><strong>{snapshot.connection.handshakeProgress}%</strong></div>
        <div><span>采样 / 帧率</span><strong>{snapshot.dashboard.sampleRateHz} Hz / {snapshot.dashboard.frameRateHz} fps</strong></div>
        <div><span>协议 / 帧号</span><strong>{frame ? `${frame.protocolVersion} / #${frame.sequence}` : "无数据"}</strong></div>
        <div><span>电机 / 传感器</span><strong>{motors} / {sensors} 路</strong></div>
      </div>

      <div className="context-metric-list">
        <div><span>曲率峰值</span><strong>{hasFrame ? curvatureSummary.maxKappaPerM.toFixed(2) : "--"} 1/m</strong></div>
        <div><span>曲率均值</span><strong>{hasFrame ? curvatureSummary.meanKappaPerM.toFixed(2) : "--"} 1/m</strong></div>
        <div><span>末端偏移</span><strong>{hasFrame ? curvatureSummary.tipOffsetMm.toFixed(1) : "--"} mm</strong></div>
      </div>

      <div className="context-action-stack">
        <button type="button" className="ghost-btn full" onClick={onRefreshSerialPorts}>
          <RefreshCw size={15} /><span>扫描串口</span>
        </button>
        <button type="button" className="ghost-btn full" onClick={onOpenConnectDialog}>
          <Wifi size={15} /><span>连接新设备</span>
        </button>
      </div>

      <section className="context-section" aria-label="串口发现">
        <h3>串口发现</h3>
        {connectionError ? (
          <div className="connection-error"><span>{connectionError}</span></div>
        ) : null}
        {connectedDevices.length > 0 ? (
          <div className="context-device-list">
            {connectedDevices.map((device) => (
              <DeviceCard
                key={device.deviceId}
                device={device}
                runtimeStatus={deviceStatuses[device.deviceId] ?? null}
                onDisconnect={onDisconnectDevice}
              />
            ))}
          </div>
        ) : null}
        <div className="context-port-list">
          {serialPorts.length === 0 ? (
            <div className="context-port-row">
              <div>
                <strong>未发现真实串口</strong>
                <span>{serialPortsError ?? "可继续使用 Simulator；连接硬件后点击扫描串口。"}</span>
              </div>
              <Badge tone="warn">无串口</Badge>
            </div>
          ) : serialPorts.map((port) => (
            <div className="context-port-row" key={port.portName}>
              <div>
                <strong>{port.portName}</strong>
                <span title={port.description ?? port.product ?? undefined}>
                  {port.description ?? port.product ?? "Serial port"}
                </span>
              </div>
              <Badge tone={port.likelyAvailable ? "ok" : "warn"}>{port.portType.toUpperCase()}</Badge>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
