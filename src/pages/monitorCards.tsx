import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { Activity, AlertTriangle, Box, Camera, Gauge, Radio, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import {
  theoreticalTendonForcesN,
  type BackboneOutput,
  type CurvatureDistribution,
} from "../dynamics/svcModel";
import type { DeviceSnapshot, MotorState, RuntimeSnapshot, SensorState } from "../softuiTypes";
import {
  getCurrentDisplacement,
  getPreviewOverride,
  getPreviewOverrideVersion,
  pushTargetHistory,
} from "../robot/previewOverride";
import "../styles/workspace.css";

const SVCCharts = lazy(() => import("../SVCCharts"));
const RobotScene = lazy(() => import("../RobotScene"));
const ArmObjectTracker = lazy(() => import("../components/ArmObjectTracker"));

/**
 * **播放中的 6 路目标位移** ✓ —— 只算不发 ✓。
 *
 * ⚠ 必须在**卡片内部**轮询 ✗ —— 放到 WorkspacePage 里每 250ms `setState`
 * 会让整页重渲染 ✓，和 3D 渲染循环抢帧 ✗ → 臂体抽搐 ✗（上一版就是这样 ✓）。
 * 这里只重渲染**这一张卡** ✓。
 */
function usePlaybackTargets(enabled: boolean): number[] | null {
  const [targets, setTargets] = useState<number[] | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      /**
       * ⚠ **不要拿 `previewOverride` 当开关** ✗ ——
       * 它只是"3D 形位注入" ✓，有自己的生命周期（切页签 / 统一收尾都会清 ✓），
       * 和"这一帧要下发的位移"不是一回事 ✗。
       * 原来 override 一空就把目标值清掉 ✓ → 播放还在跑、目标值却消失了 ✗（本 bug ✓）。
       * 现在只要**当前帧位移**有值就显示 ✓，override 只用于回退判断 ✓。
       */
      const next = getCurrentDisplacement();
      if (next) pushTargetHistory(next);   // 曲线页要用历史 ✓

      if (!next) {
        const override = getPreviewOverride();
        if (!override) setTargets((prev) => (prev ? null : prev));
        return;
      }
      setTargets((prev) =>
        prev && prev.length === next.length && next.every((v, i) => Math.abs(v - prev[i]) < 0.005)
          ? prev            // 没变 → 不重渲染 ✓
          : next,
      );
    }, 100);
    return () => window.clearInterval(timer);
  }, [enabled]);

  return targets;
}

/**
 * **播放中的形位** ✓ —— 曲线卡用它算理论张力 / 曲率 ✓。
 *
 * 为什么需要 ✗：曲线卡原来只吃快照的 `backbone` ✓，
 * 播放时快照**没变** ✗ → 理论张力和曲率都**不动** ✗（本 bug ✓）。
 *
 * ⚠ 只在这张卡内部轮询 ✓ —— 不能放 `WorkspacePage` ✗（会整页重渲染 ✓ → 3D 抽搐 ✗）。
 */
function usePlayingBackbone(): BackboneOutput | null {
  /**
   * ⚠ 不能直接 `return getPreviewOverride()` ✗ ——
   * `previewOverride` 是**模块变量** ✓，React 不知道它变了 ✓。
   * 用 `getPreviewOverrideVersion()` 当**依赖** ✓，版本一变就重渲染 ✓。
   */
  const [version, setVersion] = useState(() => getPreviewOverrideVersion());
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = getPreviewOverrideVersion();
      setVersion((previous) => (next === previous ? previous : next));
    }, 120);
    return () => window.clearInterval(timer);
  }, []);
  // `version` 只是为了触发重渲染 ✓；真正读值还是 getter ✓
  void version;
  const value = getPreviewOverride();
  return value;
}

export interface MonitorCardContext {
  snapshot: RuntimeSnapshot;
  motors: MotorState[];
  sensors: SensorState[];
  latestFrame: DeviceSnapshot | null;
  backbone: BackboneOutput;
  /** 当前模型包的臂长（mm）—— 3D 视图要按它取景与建骨 ✓ */
  totalLengthMm: number;
  /** 臂体标识色（**当前不染色** ✓，恒为 null —— 保留字段以免再次改动接口）*/ 
  armTint: string | null;
  /** 表面质地 ✓ */
  armFinish: "metal" | "matte";
  curvatureSummary: { maxKappaPerM: number; meanKappaPerM: number; tipOffsetMm: number; basisSegmentCount: number };
  sensorMax: number;
  sensorAlarmCount: number;
  sensorThreshold: number;
  onSensorThresholdChange: (value: number) => void;
  /**
   * 模型算出来、**刚下发下去**的 6 路目标位移（mm）。
   *
   * 原来放在独立的「实时数据」页，那一页与监控页的电机/传感器卡片信息重叠，
   * 已合并进监控卡片。为 `null` 表示本端与别端都还没下发过。
   */
  commandedTargets: number[] | null;
  /** 摄像头手势弯折回调（由 WorkspacePage 提供，喂给实时跟随泵）。 */
  onGestureTrack?: (track: { bendRad: number; directionRad: number; spanPx: number } | null) => void;

  // ── 拖动相关 ✓（预览卡和臂体控制卡共用同一套状态 ✓）
  /** 3D 显示的目标分布（null = 尚未编辑，显示实际形状 ✓）*/
  targetDistribution?: CurvatureDistribution | null;
  /** 拖动是否开启 ✓ */
  dragEnabled?: boolean;
  /** 拖动结果回写 ✓ */
  onDragTarget?: (next: CurvatureDistribution | null) => void;
  lockTipPose?: boolean;
  onLockTipPoseChange?: (value: boolean) => void;
  tipDriftToleranceMm?: number;
  /** 8 方向上限表 ✓ */
  modelKappaByDirection?: number[] | null;
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
    render: ({ motors, commandedTargets }) => {
      // **播放中的位移优先** ✓（只重渲染这张卡 ✓）
      const playback = usePlaybackTargets(motors.length > 0);
      const shown = playback ?? commandedTargets;
      return motors.length > 0 ? (
      <div className="monitor-summary-grid">
        {motors.map((motor) => (
          <div className="monitor-motor-summary-cell" key={motor.id}>
            <div className="monitor-motor-summary-head">
              <span>电机 {motor.id}</span>
              <i className={`monitor-motor-status-lamp${motor.running ? " is-running" : ""}`} aria-hidden="true" />
            </div>
            {/* 两个量都用**文字**标出、都加粗、用不同颜色 —— 它们一个是意图一个是事实，
                颜色相近或都用弱化的小字就分不出来（原来用小字+浅色，实测看不清）。 */}
            <span className="monitor-value-actual">实际 {motor.positionMm.toFixed(2)} mm</span>
            <span className="monitor-value-target">
              目标 {shown?.[motor.id - 1] != null
                ? `${shown[motor.id - 1].toFixed(2)} mm`
                : "--"}
              {playback ? " ▶" : ""}
            </span>
            <small>{motor.velocityMmPerSec.toFixed(1)} mm/s</small>
          </div>
        ))}
      </div>
      ) : (
        <div className="feature-empty-compact">当前设备没有电机数据</div>
      );
    },
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
                <i className={`monitor-motor-status-lamp${sensor.filteredValue < sensorThreshold ? " is-running" : ""}`} aria-hidden="true" />
              </div>
              <span className="monitor-value-actual">实际 {sensor.rawValue.toFixed(2)} {sensor.unit}</span>
              <span className="monitor-value-target">滤波 {sensor.filteredValue.toFixed(2)} {sensor.unit}</span>
            </div>
          ))}
        </div>
      </>
    ) : <div className="feature-empty-compact">当前设备没有传感器数据</div>),
  },

  model3d: {
    title: "臂体形位预览",
    icon: Box,
    // **只读监控** ✓ —— 控制全部集中在「臂体控制」卡 ✓（这里不接管指针 ✗）
    render: ({ backbone, totalLengthMm, armTint, armFinish }) => (
      <div className="model-scene-col">
        <Suspense fallback={sceneFallback}>
          <RobotScene backbone={backbone} lengthMm={totalLengthMm} armTint={armTint} armFinish={armFinish} />
        </Suspense>
      </div>
    ),
  },

  camera: {
    title: "摄像头",
    icon: Camera,
    render: (context) => (
      <Suspense fallback={sceneFallback}>
        <ArmObjectTracker onTrack={context.onGestureTrack} />
      </Suspense>
    ),
  },

  armCharts: {
    title: "柔性臂数据曲线",
    icon: Activity,
    render: ({ backbone, sensors }) => {
      /**
       * 这里必须是**实际** ✗ —— 柔性臂数据曲线的语义是"设备真实状态"
       * （曲率 / 张力都来自快照 ✓）。
       * 上一版让播放时用 `previewOverride` 替代 ✗ → 实际曲率被理论值污染 ✗，语义错了。
       * 理论值单独通过 `theoryBackbone` 传进去 ✓，由图表自己区分画。
       */
      const theoryBackbone = usePlayingBackbone();
      const shown = backbone;
      return (
      <Suspense fallback={sceneFallback}>
        <SVCCharts
          backbone={shown}
          theoryBackbone={theoryBackbone}
          // 腱张力柱状图必须和「压力传感器概览」同源：都用各路传感器的**滤波值**。
          tendonForcesN={sensors.map((sensor) => sensor.filteredValue)}
          // ⚠ **理论张力必须来自"理论形位"** ✗ —— 用 `shown`（实际快照 ✓）
          //   算出来的是"当前实际形位对应的理论张力"✓ → 拖动时**永远不变** ✗（本 bug ✓）。
          theoreticalForcesN={theoreticalTendonForcesN(
            (theoryBackbone ?? shown).distribution.segments,
          )}
        />
      </Suspense>
      );
    },
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
