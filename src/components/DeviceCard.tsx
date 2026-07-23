import type { DeviceConnectionRecord } from "../softuiTypes";
import { Wifi, X } from "lucide-react";

interface DeviceCardProps {
  device: DeviceConnectionRecord;
  runtimeStatus?: {
    receivedFrames: number;
    protocolErrors: number;
    pendingCommands: number;
  } | null;
  onDisconnect: (deviceId: string) => void;
}

function stateTone(state: string): "ok" | "info" | "warn" | "error" | "neutral" {
  switch (state) {
    case "ready":
    case "enabled":
      return "ok";
    case "connecting":
    case "handshaking":
      return "info";
    case "reconnecting":
      return "warn";
    case "error":
      return "error";
    default:
      return "neutral";
  }
}

function stateLabel(state: string): string {
  switch (state) {
    case "idle": return "空闲";
    case "connecting": return "连接中";
    case "handshaking": return "握手中";
    case "ready": return "就绪";
    case "enabled": return "已使能";
    case "emergencystopped": return "紧急停止";
    case "reconnecting": return "重连中";
    case "error": return "错误";
    case "closed": return "已关闭";
    default: return state;
  }
}

function relativeTime(ms: number): string {
  const elapsed = Date.now() - ms;
  const secs = Math.floor(elapsed / 1000);
  if (secs < 60) return `${secs}s 前`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m 前`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h 前`;
}

export default function DeviceCard({ device, runtimeStatus, onDisconnect }: DeviceCardProps) {
  const tone = stateTone(device.state);
  const label = stateLabel(device.state);

  return (
    <article className="device-card">
      <div className="device-card-head">
        <div className="device-card-title">
          <Wifi size={14} />
          <strong>{device.deviceId}</strong>
        </div>
        <span className={`badge ${tone}`}>{label}</span>
      </div>

      <div className="device-card-meta">
        <span>
          {device.portName} @ {device.baudRate.toLocaleString()} baud
        </span>
      </div>

      <div className="device-card-stats">
        <div className="device-card-stat">
          <span className="device-card-stat-label">连接时长</span>
          <strong>{relativeTime(device.connectedAtMs)}</strong>
        </div>
        {runtimeStatus ? (
          <>
            <div className="device-card-stat">
              <span className="device-card-stat-label">接收帧</span>
              <strong>{runtimeStatus.receivedFrames.toLocaleString()}</strong>
            </div>
            <div className="device-card-stat">
              <span className="device-card-stat-label">协议错误</span>
              <strong>{runtimeStatus.protocolErrors}</strong>
            </div>
          </>
        ) : null}
      </div>

      <div className="device-card-actions">
        <button
          type="button"
          className="ghost-btn danger full"
          onClick={() => onDisconnect(device.deviceId)}
        >
          <X size={14} />
          <span>断开连接</span>
        </button>
      </div>
    </article>
  );
}
