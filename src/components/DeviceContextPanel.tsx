import { AlertTriangle, Cable, Wifi } from "lucide-react";

import { useEffect, useMemo } from "react";

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
  /** 打开连接对话框；可带上预选端口（点「串口发现」里的一行时）。 */
  onOpenConnectDialog: (portName?: string) => void;
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
  /**
   * ⚠ 措辞统一到「服务器同步」口径 ✗ —— 上位机无法确认下位机真的使能了 ✓。
   * 写"已使能"会让操作员以为设备在等指令 ✓，实际可能只是服务器记了这笔 ✓ —— 歧义 ✓。
   */
  const enableLabel =
    systemControlAction === "emergencyStop"
      ? "急停锁定（服务器）"
      : systemControlAction === "disable"
        ? "服务器已同步：失能"
        : motionEnabled
          ? "服务器已同步：使能"
          : systemEnabled === null
            ? "服务器无数据"
            : "服务器未同步使能";
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
            body: <>需要动作时请到「控制 → 系统操作」点「启动控制系统」重新使能。</>,
          }
        : {
            title: "系统未使能，运动指令不会下发",
            body: (
              <>
                「按此曲率下发 / 按位姿下发 / 发至电机 / 一键归零 / 主动控制」都会被拦截，
                也不会向串口写入任何字节。请到「控制 → 系统操作」点
                <b>「启动控制系统」</b>后再下发。
              </>
            ),
          };
  const showEnableHint = !motionEnabled && (systemControlAction != null || systemEnabled === false);

  // 挂载即枚举一次，之后每 5 秒刷新（getPorts 很轻，不会弹窗）。
  useEffect(() => {
    const tick = () => onRefreshSerialPorts();
    tick();
    const timer = window.setInterval(tick, 5000);

  return () => window.clearInterval(timer);
  }, [onRefreshSerialPorts]);

  /**
   * **已经连上的端口名** ✓ —— 「串口发现」要把它排除掉 ✗。
   *
   * 现场问题：设备连上以后，同一行还挂在「串口发现」里 ✓ →
   * 用户以为"还能再连一次"✓ → 点进去重复连接 ✓（本 bug ✓）。
   * 已连接的设备在**上方设备卡**里已经有一条了 ✓，这里不该再出现 ✓。
   */
  const connectedPortNames = useMemo(
    () => new Set(connectedDevices.map((device) => device.portName).filter(Boolean)),
    [connectedDevices],
  );

  /** 只列 USB 串口；`vid == null` 的是主板 COM / 蓝牙 SPP 之类，对本设备没意义。 */
  const usbPorts = useMemo(
    () => serialPorts.filter((port) => port.vid != null && !connectedPortNames.has(port.portName)),
    [serialPorts, connectedPortNames],
  );

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
        <button type="button" className="ghost-btn full" onClick={() => onOpenConnectDialog()}>
          <Wifi size={15} /><span>连接新设备</span>
        </button>
      </div>

      {/* 打开即自动枚举，之后每 5 秒刷新一次。
          没有「扫描串口」按钮了，这一栏要自己保持最新 —— 它叫「串口发现」，
          就该是**持续发现**，而不是等用户点一下。
          ⚠️ 调用必须包一层箭头函数：直接把 onRefreshSerialPorts 挂到 onClick 上时，
          点击事件对象会被当成 forcePick 传下去，于是"刷新"变成"每次弹窗"。 */}
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
          {/* 只列 **USB 串口**：`vid == null` 的是主板 COM / 蓝牙 SPP 之类的
              非 USB 端口，浏览器连端口号都不提供，对"连我这台设备"没有意义。 */}
          {usbPorts.length === 0 ? (
            <div className="context-port-row">
              <div>
                {/* 全部已连接时**不能说"未发现串口"** ✗ —— 那会把"已经连上了"说成"没有设备"✗ */}
                <strong>
                  {connectedPortNames.size > 0 ? "当前串口都已连接" : "未发现真实串口"}
                </strong>
                <span>
                  {connectedPortNames.size > 0
                    ? "要连接另一台设备，点上方「连接新设备」，在浏览器弹窗里授权新的串口。"
                    : (serialPortsError ?? "可继续使用 Simulator；插上硬件后这里会自动出现，或点上方「连接新设备」手动选择。")}
                </span>
              </div>
              <Badge tone={connectedPortNames.size > 0 ? "ok" : "warn"}>
                {connectedPortNames.size > 0 ? "已连接" : "无串口"}
              </Badge>
            </div>
          ) : usbPorts.map((port) => (
            // 点一行就直接进「连接」的参数界面（波特率等），并把这一条预选上 ——
            // 已经发现的端口不该还要用户再点一次「连接新设备」去挑一遍。
            <button
              type="button"
              className="context-port-row is-clickable"
              key={port.portName}
              onClick={() => onOpenConnectDialog(port.portName)}
              title="点此设置波特率并连接"
            >
              <div>
                <strong>{port.portName}</strong>
                <span title={port.description ?? port.product ?? undefined}>
                  {port.description ?? port.product ?? "Serial port"}
                </span>
              </div>
              <Badge tone={port.likelyAvailable ? "ok" : "warn"}>{port.portType.toUpperCase()}</Badge>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
