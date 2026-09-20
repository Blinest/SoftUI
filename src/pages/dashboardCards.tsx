import type { ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  Cable,
  CircleGauge,
  History,
  Radio,
  Save,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { sessionBelongsToDevice } from "../robot/sessionMatch";
import type {
  DashboardCardId,
  DeviceConnectionRecord,
  DeviceRuntimeStatusView,
  RecorderStatus,
  RuntimeSnapshot,
  SessionInfo,
} from "../softuiTypes";

export interface DashboardCardContext {
  snapshot: RuntimeSnapshot;
  connectedDevices: DeviceConnectionRecord[];
  deviceStatuses: Record<string, DeviceRuntimeStatusView>;
  recorderStatus: RecorderStatus;
  sessions: SessionInfo[];
}

export interface DashboardCardDefinition {
  title: string;
  icon: LucideIcon;
  render: (context: DashboardCardContext) => ReactNode;
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="feature-metric">
      <span>{label}</span>
      <strong title={typeof value === "string" ? value : undefined}>{value}</strong>
    </div>
  );
}

function frameForDevice(snapshot: RuntimeSnapshot, deviceId: string) {
  return snapshot.live.latest?.deviceId === deviceId ? snapshot.live.latest : null;
}

export const dashboardCardRegistry: Record<DashboardCardId, DashboardCardDefinition> = {
  connection: {
    title: "连接状态",
    icon: Cable,
    render: ({ snapshot, connectedDevices, deviceStatuses }) => {
      const deviceId = snapshot.live.selectedDeviceId;
      const frame = frameForDevice(snapshot, deviceId);
      const connection = connectedDevices.find((device) => device.deviceId === deviceId);
      const runtime = deviceStatuses[deviceId];
      const hasData = Boolean(frame || connection || runtime);
      return (
        <div className="feature-metric-grid">
          <Metric label="当前配置" value={hasData ? snapshot.connection.activeProfileName || "未配置" : "无数据"} />
          <Metric label="连接阶段" value={connection?.state ?? runtime?.state ?? (frame ? snapshot.connection.state : "无数据")} />
          <Metric label="已连接设备" value={connectedDevices.length || snapshot.dashboard.connectedDevices} />
          <Metric label="握手进度" value={hasData ? `${snapshot.connection.handshakeProgress}%` : "无数据"} />
        </div>
      );
    },
  },

  sampling: {
    title: "采样状态",
    icon: Radio,
    render: ({ snapshot }) => (frameForDevice(snapshot, snapshot.live.selectedDeviceId) ? (
      <div className="feature-metric-grid">
        <Metric label="采样率" value={`${snapshot.dashboard.sampleRateHz} Hz`} />
        <Metric label="界面帧率" value={`${snapshot.dashboard.frameRateHz} fps`} />
        <Metric label="存储帧" value={snapshot.runtimeDiagnostics.storedFrames} />
        <Metric label="丢弃帧" value={snapshot.runtimeDiagnostics.droppedFrames} />
      </div>
    ) : <div className="feature-empty-compact">当前设备没有采样数据</div>),
  },

  recording: {
    title: "记录状态",
    icon: Save,
    render: ({ recorderStatus, sessions, snapshot }) => {
      const session = sessions.find((item) => item.id === recorderStatus.sessionId);
      const activeHere = recorderStatus.active
        && Boolean(session)
        && sessionBelongsToDevice(session as SessionInfo, snapshot.live.selectedDeviceId);
      return (
        <div className="feature-card-primary-state compact">
          <span className={`status-chip ${activeHere ? "is-ok" : ""}`}>
            {activeHere ? (recorderStatus.paused ? "已暂停" : "记录中") : "未记录"}
          </span>
          <strong title={activeHere ? recorderStatus.sessionName : undefined}>
            {activeHere ? recorderStatus.sessionName || "未命名会话" : "当前设备尚未开始会话"}
          </strong>
          <span>
            {activeHere
              ? `${recorderStatus.frameCount.toLocaleString()} 帧 · ${recorderStatus.elapsedSecs.toFixed(1)} 秒`
              : "0 帧 · 0.0 秒"}
          </span>
        </div>
      );
    },
  },

  alerts: {
    title: "当前告警",
    icon: AlertTriangle,
    render: ({ snapshot }) => {
      const deviceId = snapshot.live.selectedDeviceId;
      const alerts = snapshot.logs
        .filter((entry) => (entry.level === "error" || entry.level === "warn")
          && (!entry.deviceId || entry.deviceId === deviceId))
        .slice(0, 3);
      return alerts.length > 0 ? (
        <div className="feature-list">
          {alerts.map((entry) => (
            <div className="feature-list-row" key={entry.id}>
              <span className={`status-dot is-${entry.level}`} aria-hidden="true" />
              <span title={entry.message}>{entry.message}</span>
            </div>
          ))}
        </div>
      ) : <div className="feature-empty-compact">当前设备没有活动告警</div>;
    },
  },

  deviceHealth: {
    title: "设备健康",
    icon: CircleGauge,
    render: ({ snapshot, deviceStatuses }) => {
      const frame = frameForDevice(snapshot, snapshot.live.selectedDeviceId);
      const runtime = deviceStatuses[snapshot.live.selectedDeviceId];
      return (
        <div className="feature-metric-grid feature-metric-grid-wide">
          <Metric label="帧质量" value={frame?.quality.status ?? "无数据"} />
          <Metric label="传输延迟" value={frame ? `${frame.quality.latencyMs} ms` : "-"} />
          <Metric label="协议错误" value={runtime?.protocolErrors ?? snapshot.runtimeDiagnostics.protocolErrors} />
          <Metric label="重连次数" value={runtime?.reconnectAttempts ?? snapshot.runtimeDiagnostics.reconnectAttempts} />
          <Metric label="待发命令" value={snapshot.runtimeDiagnostics.pendingCommands} />
          <Metric label="后台状态" value={runtime?.state ?? (frame ? snapshot.connection.state : "无数据")} />
        </div>
      );
    },
  },

  recentSessions: {
    title: "最近会话",
    icon: History,
    render: ({ sessions, snapshot }) => {
      const recent = sessions
        .filter((session) => sessionBelongsToDevice(session, snapshot.live.selectedDeviceId))
        .slice(0, 4);
      return recent.length > 0 ? (
        <div className="feature-list">
          {recent.map((session) => (
            <div className="feature-list-row feature-list-row-split" key={session.id}>
              <span title={session.name}>{session.name}</span>
              <strong>{session.frameCount.toLocaleString()} 帧</strong>
            </div>
          ))}
        </div>
      ) : <div className="feature-empty-compact">当前设备没有最近会话</div>;
    },
  },

  recentEvents: {
    title: "最近关键事件",
    icon: Activity,
    render: ({ snapshot }) => {
      const events = snapshot.logs
        .filter((entry) => !entry.deviceId || entry.deviceId === snapshot.live.selectedDeviceId)
        .slice(0, 5);
      return events.length > 0 ? (
        <div className="feature-list">
          {events.map((entry) => (
            <div className="feature-list-row feature-list-row-event" key={entry.id}>
              <span className={`status-chip is-${entry.level}`}>{entry.level.toUpperCase()}</span>
              <span title={entry.scope}>{entry.scope}</span>
              <span title={entry.message}>{entry.message}</span>
            </div>
          ))}
        </div>
      ) : <div className="feature-empty-compact">当前设备没有最近事件</div>;
    },
  },
};
