import { AlertTriangle, Cable, RefreshCw, Wifi } from "lucide-react";

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
  /**
   * 操作员最后一次成功的系统操作：用来区分「已失能」和「未使能」。
   *
   * 与后端 `RuntimeStatus::control_enabled` 同口径：点过「启动控制系统」即视为已使能，
   * 不依赖下位机把 `system_state` 回写进状态帧。
   */
  systemControlAction?: "enable" | "disable" | "emergencyStop" | null;
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
  systemControlAction,
  onOpenConnectDialog,
  onDisconnectDevice,
  onRefreshSerialPorts,
}: DeviceContextPanelProps) {
  const frame = snapshot.live.latest;
  const motors = frame?.motors.length ?? 0;
  const sensors = frame?.sensors.length ?? 0;
  /**
   * 三态：`null` = 还没收到状态帧（不知道）；`false` = 收到帧且 system_state == 0。
   *
   * 这个字节来自下位机 `CR.state`，也是后端 `CommandSafety::Enabled` 的唯一门槛：
   * 为 0 时所有运动指令会被直接拒绝、**一个字节都不会写进串口**。
   */
  const systemEnabled = frame ? frame.systemEnabled : null;
  /**
   * 是否按操作员意图已使能。
   *
   * 点过「启动控制系统」就算 —— 后端 `RuntimeStatus::control_enabled` 是同一口径，
   * 状态帧的 `system_state` 只作为额外来源（下位机不回写时它是恒 0）。
   */
  const operatorEnabled = systemControlAction === "enable";
  const motionEnabled = systemEnabled === true || operatorEnabled;
  /**
   * 「使能状态」的显示口径（与顶部状态条、卡片徽标一致）：
   *   急停 → 急停锁定；点过关闭 → 已失能；点过启动（或帧说已使能）→ 已使能；
   *   都没点过 → 未使能 / 无数据。
   */
  const enableLabel =
    systemControlAction === "emergencyStop"
      ? "急停锁定"
      : systemControlAction === "disable"
        ? "已失能"
        : motionEnabled
          ? "已使能"
          : systemEnabled === null
            ? "无数据"
            : "未使能";
  const enableTone =
    systemControlAction === "emergencyStop" ? "is-error" : motionEnabled ? undefined : "is-warn";
  /**
   * 不动时的说明文案：区分「没点过使能」「刚被关闭」「急停锁存」三种原因，
   * 三者的下一步动作完全不同（分别对应：去启动、去重新启动、先确认现场安全）。
   */
  const enableHint =
    systemControlAction === "emergencyStop"
      ? {
          title: "急停已锁存，运动指令不会下发",
          body: <>重新使能（「启动控制系统」）会解除锁存，请先确认现场安全。</>,
        }
      : systemControlAction === "disable"
        ? {
            title: "系统已失能，运动指令不会下发",
            body: <>需要动作时请到「自动控制 → 系统操作」点「启动控制系统」重新使能。</>,
          }
        : {
            title: "系统未使能，运动指令不会下发",
            body: (
              <>
                「按此曲率下发 / 按位姿下发 / 发至电机 / 一键归中 / 主动控制」都会被拦截，
                也不会向串口写入任何字节。请到「自动控制 → 系统操作」点
                <b>「启动控制系统」</b>后再下发。
              </>
            ),
          };
  const showEnableHint = !motionEnabled && (systemControlAction != null || systemEnabled === false);

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
        <div>
          <span>使能状态</span>
          <strong className={enableTone}>{enableLabel}</strong>
        </div>
        <div><span>握手进度</span><strong>{snapshot.connection.handshakeProgress}%</strong></div>
        <div><span>采样 / 帧率</span><strong>{snapshot.dashboard.sampleRateHz} Hz / {snapshot.dashboard.frameRateHz} fps</strong></div>
        <div><span>协议 / 帧号</span><strong>{frame ? `${frame.protocolVersion} / #${frame.sequence}` : "无数据"}</strong></div>
        <div><span>电机 / 传感器</span><strong>{motors} / {sensors} 路</strong></div>
      </div>

      {/* 未使能警告：运动指令会被后端 CommandSafety::Enabled 拦下（串口一个字节都不写），
          必须在这里先讲清楚，否则用户看到的是「按了没反应」，还会以为是串口/固件的问题。 */}
      {showEnableHint ? (
        <div className="context-warning" role="alert">
          <AlertTriangle aria-hidden="true" size={15} />
          <div>
            <strong>{enableHint.title}</strong>
            <span>{enableHint.body}</span>
          </div>
        </div>
      ) : null}

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
