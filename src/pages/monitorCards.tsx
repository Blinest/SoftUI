import { lazy, Suspense, type ReactNode } from "react";
import { Activity, AlertTriangle, Box, Camera, Gauge, Radio, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { BackboneOutput } from "../dynamics/svcModel";
import type { DeviceSnapshot, MotorState, RuntimeSnapshot, SensorState } from "../softuiTypes";
import "../styles/workspace.css";

const RobotScene = lazy(() => import("../RobotScene"));
const SVCCharts = lazy(() => import("../SVCCharts"));
const ArmObjectTracker = lazy(() => import("../components/ArmObjectTracker"));

export interface MonitorCardContext {
  snapshot: RuntimeSnapshot;
  motors: MotorState[];
  sensors: SensorState[];
  latestFrame: DeviceSnapshot | null;
  backbone: BackboneOutput;
  curvatureSummary: { maxKappaPerM: number; meanKappaPerM: number; tipOffsetMm: number; basisSegmentCount: number };
  sensorMax: number;
  sensorAlarmCount: number;
  sensorThreshold: number;
  onSensorThresholdChange: (value: number) => void;
}

export interface MonitorCardDefinition {
  title: string;
  icon: LucideIcon;
  render: (context: MonitorCardContext) => ReactNode;
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="feature-metric">
      <span>{label}</span>
      <strong title={typeof value === "string" ? value : undefined}>{value}</strong>
    </div>
  );
}

const sceneFallback = <div className="feature-empty-compact">场景加载中…</div>;

/** 设备工作台「监控」标签的卡片集合。 */
export const monitorCardRegistry: Record<string, MonitorCardDefinition> = {
  deviceState: {
    title: "设备状态",
    icon: Gauge,
    render: ({ snapshot, latestFrame }) => (
      <div className="feature-metric-grid">
        <Metric label="协议版本" value={latestFrame?.protocolVersion ?? "无数据"} />
        <Metric label="帧号" value={latestFrame ? `#${latestFrame.sequence}` : "--"} />
        <Metric label="帧质量" value={latestFrame?.quality.status ?? "无数据"} />
        <Metric label="传输延迟" value={latestFrame ? `${latestFrame.quality.latencyMs} ms` : "-"} />
        <Metric label="系统" value={latestFrame ? (latestFrame.systemEnabled ? "已使能" : "未使能") : "无数据"} />
        <Metric label="连接" value={snapshot.connection.state} />
      </div>
    ),
  },

  commandQueue: {
    title: "命令与协议",
    icon: Zap,
    render: ({ snapshot }) => (
      <div className="feature-metric-grid">
        <Metric label="待发命令" value={snapshot.runtimeDiagnostics.pendingCommands} />
        <Metric label="已发命令" value={snapshot.runtimeDiagnostics.sentCommands} />
        <Metric label="协议错误" value={snapshot.runtimeDiagnostics.protocolErrors} />
        <Metric label="重连次数" value={snapshot.runtimeDiagnostics.reconnectAttempts} />
        <Metric label="丢弃帧" value={snapshot.runtimeDiagnostics.droppedFrames} />
        <Metric label="存储帧" value={`${snapshot.runtimeDiagnostics.storedFrames}/${snapshot.runtimeDiagnostics.liveCapacity}`} />
      </div>
    ),
  },

  motorSummary: {
    title: "电机概览",
    icon: Activity,
    render: ({ motors }) => (motors.length > 0 ? (
      <div className="monitor-summary-grid">
        {motors.map((motor) => (
          <div className="monitor-motor-summary-cell" key={motor.id}>
            <div className="monitor-motor-summary-head">
              <span>电机 {motor.id}</span>
              <i className={`monitor-motor-status-lamp${motor.running ? " is-running" : ""}`} aria-hidden="true" />
            </div>
            <strong className="monitor-motor-summary-value">{motor.positionMm.toFixed(1)} mm</strong>
            <small>{motor.velocityMmPerSec.toFixed(1)} mm/s</small>
          </div>
        ))}
      </div>
    ) : <div className="feature-empty-compact">当前设备没有电机数据</div>),
  },

  sensorSummary: {
    title: "压力传感器概览",
    icon: Radio,
    render: ({ sensors, sensorMax, sensorAlarmCount, sensorThreshold, onSensorThresholdChange }) => (sensors.length > 0 ? (
      <>
        <div className="feature-metric-grid feature-metric-grid-wide">
          <Metric label="最高值" value={`${sensorMax.toFixed(2)} N`} />
          <Metric label="报警点" value={sensorAlarmCount} />
          <div className="feature-metric">
            <span>阈值 (N)</span>
            <input type="number" step={0.1} value={sensorThreshold}
              onChange={(event) => onSensorThresholdChange(Number(event.target.value))} />
          </div>
        </div>
        <div className="monitor-summary-grid">
          {sensors.map((sensor) => (
            <div className="monitor-motor-summary-cell" key={sensor.id}>
              <div className="monitor-motor-summary-head">
                <span>传感器 {sensor.id}</span>
                <i className={`monitor-motor-status-lamp${sensor.filtered[0] < sensorThreshold ? " is-running" : ""}`} aria-hidden="true" />
              </div>
              <strong className="monitor-motor-summary-value">{sensor.filtered[0].toFixed(2)} {sensor.unit}</strong>
              <small>{sensor.alias.join(" / ")}</small>
            </div>
          ))}
        </div>
      </>
    ) : <div className="feature-empty-compact">当前设备没有传感器数据</div>),
  },

  model3d: {
    title: "3D 模型",
    icon: Box,
    render: ({ backbone }) => (
      <div className="model-scene-col">
        <Suspense fallback={sceneFallback}>
          <RobotScene backbone={backbone} />
        </Suspense>
      </div>
    ),
  },

  camera: {
    title: "摄像头",
    icon: Camera,
    render: () => (
      <Suspense fallback={sceneFallback}>
        <ArmObjectTracker />
      </Suspense>
    ),
  },

  armCharts: {
    title: "柔性臂数据曲线",
    icon: Activity,
    render: ({ backbone }) => (
      <Suspense fallback={sceneFallback}>
        <SVCCharts backbone={backbone} />
      </Suspense>
    ),
  },

  recentAlerts: {
    title: "最近告警",
    icon: AlertTriangle,
    render: ({ snapshot }) => {
      const deviceId = snapshot.live.selectedDeviceId;
      const alerts = snapshot.logs
        .filter((entry) => (entry.level === "error" || entry.level === "warn")
          && (!entry.deviceId || entry.deviceId === deviceId))
        .slice(0, 5);
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
};
