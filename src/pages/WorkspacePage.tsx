import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  Database,
  Eye,
  Logs,
  PauseCircle,
  Play,
  SlidersHorizontal,
  Table2,
} from "lucide-react";
import { useSearchParams } from "react-router-dom";

import Badge from "../components/Badge";
import { CardGrid } from "../components/cards/CardGrid";
import { DeviceContextPanel } from "../components/DeviceContextPanel";
import { WorkbenchLayout } from "../layouts/WorkbenchLayout";
import { monitorCardRegistry } from "./monitorCards";
import { clamp, isoFull, toneForLevel } from "../utils";
import { useCardLayout } from "../state/layoutStore";
import {
  buildBackboneFromCurvatureDistribution,
  curvatureDistributionFromSnapshot,
  DEFAULT_DYNAMICS_CONFIG,
  summarizeBackbone,
  type CurvatureDistribution,
} from "../dynamics/svcModel";
import { sectionEquivalents } from "../dynamics/curvatureDrag";
import {
  curvatureOf,
  distributionFromTipSections,
  solveTipPose,
  type SectionCurvature,
} from "../robot/pose3d";
import { CurvatureDragPreview } from "../robot/CurvatureDragPreview";
import type {
  DeviceConnectionRecord,
  DeviceRuntimeStatusView,
  MonitorCardId,
  RuntimeSnapshot,
  SerialPortDescriptor,
} from "../softuiTypes";
import "../styles/workspace.css";

export type WorkspaceTab = "monitor" | "live-data" | "manual" | "automatic" | "playback";
export type SystemControlAction = "enable" | "disable" | "emergencyStop";
export type WorkspaceCommand = "home" | "calibrateSensor" | "bend" | "activeTick";

export type MotorCommandDraft = {
  motorId: number;
  positionMm: number;
  velocityMmPerSec: number;
  accelerationMmPerSec2: number;
};

/**
 * 下发给后端的载荷。
 *
 * 手动控制有两路输入，最终都折算成「两段曲率 + 方向」才发出去：
 *   - 三维拖动：12 段分布 → `sectionEquivalents` → 这里的曲率/方向；
 *   - 末端位姿：6 个位姿分量 → `solveTipPose` → 两段曲率 → 同样落到这里。
 *
 * **不让后端做反解**：反解要用到臂长、曲率上限、姿态权重这些参数，它们都在
 * 前端（和 3D 视图共用同一份），后端 `send_bend_command` 仍然吃角度。把反解
 * 放前端，预览与下发走的就是同一个函数，不会出现「预览是这个形状、发下去是
 * 另一个」。
 */
export type WorkspaceCommandPayload = {
  sensorId?: number;
  calibrationValue?: number;
  direction1?: number;
  section1CurvaturePerM?: number;
  direction2?: number;
  section2CurvaturePerM?: number;
};

export interface WorkspacePageProps {
  snapshot: RuntimeSnapshot;
  serialPorts: SerialPortDescriptor[];
  serialPortsError: string | null;
  connectedDevices: DeviceConnectionRecord[];
  deviceStatuses: Record<string, DeviceRuntimeStatusView>;
  connectionError: string | null;
  onOpenConnectDialog: () => void;
  onDisconnectDevice: (deviceId: string) => void;
  onRefreshSerialPorts: () => void;
  onSystemControl: (action: SystemControlAction) => void;
  onSendMotor: (command: MotorCommandDraft) => void;
  onWorkspaceCommand: (command: WorkspaceCommand, payload?: WorkspaceCommandPayload) => void;
}

const WORKSPACE_TABS: Array<{ key: WorkspaceTab; title: string; icon: typeof Activity }> = [
  { key: "monitor", title: "监控", icon: Activity },
  { key: "live-data", title: "实时数据", icon: Table2 },
  { key: "manual", title: "手动控制", icon: SlidersHorizontal },
  { key: "automatic", title: "自动控制", icon: PauseCircle },
  { key: "playback", title: "回放", icon: Play },
];

function isWorkspaceTab(value: string | null): value is WorkspaceTab {
  return WORKSPACE_TABS.some((tab) => tab.key === value);
}

/**
 * 设备工作台。
 *
 * 标签用 ?tab= 驱动而不是本地 state：页面每秒都会被新的 snapshot 重渲染，
 * URL 化的标签能保证跨刷新、跨设备切换时视图不漂移。
 *
 * 注意：主动控制（200ms tick）与循环寿命检测这两个循环依赖下面这些 state，
 * 它们挂在页面级而不是标签内容里，切标签不能重置。
 */
export function WorkspacePage({
  snapshot,
  serialPorts,
  serialPortsError,
  connectedDevices,
  deviceStatuses,
  connectionError,
  onOpenConnectDialog,
  onDisconnectDevice,
  onRefreshSerialPorts,
  onSystemControl,
  onSendMotor,
  onWorkspaceCommand,
}: WorkspacePageProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const activeTab: WorkspaceTab = isWorkspaceTab(tabParam) ? tabParam : "monitor";

  const [motorDraft, setMotorDraft] = useState<MotorCommandDraft>({
    motorId: 1,
    positionMm: 0,
    velocityMmPerSec: 10,
    accelerationMmPerSec2: 3,
  });
  const [sensorDraft, setSensorDraft] = useState({ sensorId: 1, calibrationValue: 0 });
  const [pidDraft, setPidDraft] = useState({ kp: 0.5, ki: 0.01, kd: 0.01 });  const [activeControlEnabled, setActiveControlEnabled] = useState(false);
  const [cycleLifeEnabled, setCycleLifeEnabled] = useState(false);
  const [cycleCount, setCycleCount] = useState(0);
  const [cycleLowThreshold, setCycleLowThreshold] = useState(4);
  const [cycleHighThreshold, setCycleHighThreshold] = useState(10);
  const [cycleTargetPosition, setCycleTargetPosition] = useState(-7);
  const [cycleLastTrigger, setCycleLastTrigger] = useState<"low" | "high" | null>(null);
  const [sensorThreshold, setSensorThreshold] = useState(10);
  const [commandStatus, setCommandStatus] = useState<{ tone: "ok" | "warn" | "error"; message: string } | null>(null);

  const latestFrame = snapshot.live.latest;
  const motors = latestFrame?.motors ?? [];
  const sensors = latestFrame?.sensors ?? [];
  const selectedSensor = sensors.find((sensor) => sensor.id === sensorDraft.sensorId) ?? sensors[0];
  const activeSession = snapshot.playback.sessions.find((session) => session.id === snapshot.playback.activeSessionId) ?? snapshot.playback.sessions[0];
  const progress = clamp((snapshot.playback.cursorMs / Math.max(snapshot.playback.durationMs, 1)) * 100, 0, 100);
  const isSystemEnabled = latestFrame?.systemEnabled ?? false;

  const curvatureDistribution = useMemo(() => curvatureDistributionFromSnapshot(latestFrame, { basisSegmentCount: 12 }), [latestFrame]);
  const backbone = useMemo(() => buildBackboneFromCurvatureDistribution(curvatureDistribution), [curvatureDistribution]);
  const curvatureSummary = useMemo(() => summarizeBackbone(backbone), [backbone]);

  /**
   * 当前实际的「两段等效曲率」，作为末端反解的迭代初值。
   *
   * 取分布里两半的积分平均（和下发时的折算同一套口径），比直接读某一端的
   * 采样更稳 —— 传感融合出来的分布在段与段的交界处会有过渡带。
   */
  const actualTipSections = useMemo<[SectionCurvature, SectionCurvature]>(() => {
    const eq = sectionEquivalents(curvatureDistribution);
    return [
      { kxPerM: -eq.curvaturePerM[0] * Math.sin((eq.directionDeg[0] * Math.PI) / 180), kyPerM: eq.curvaturePerM[0] * Math.cos((eq.directionDeg[0] * Math.PI) / 180) },
      { kxPerM: -eq.curvaturePerM[1] * Math.sin((eq.directionDeg[1] * Math.PI) / 180), kyPerM: eq.curvaturePerM[1] * Math.cos((eq.directionDeg[1] * Math.PI) / 180) },
    ];
  }, [curvatureDistribution]);

  /** 方向度（0 上 / 90 右 / 180 下 / 270 左）→ 中文标签，用于等效曲率展示。 */
  const directionLabel = (deg: number): string => {
    const labels = ["上", "右", "下", "左"];
    return labels[((Math.round(deg / 90) % 4) + 4) % 4] ?? "上";
  };

  /**
   * 三维拖动编辑的状态。
   *
   * `dragEnabled` 默认关闭：手动控制页是操作员高频使用的地方，进来就抢走
   * 左键会让「转视角」这件最常做的事变难。打开后左键才变成拖臂。
   *
   * `dragTarget` 只在拖动过程中非空。反解的基准始终是**当前实际分布**
   * （见 curvatureDrag 的说明），所以这里存的是一份**绝对**目标分布，
   * 不随新帧累积。清空它即可让 3D 视图回到真实形状。
   */
  const [dragEnabled, setDragEnabled] = useState(false);
  const [dragTarget, setDragTarget] = useState<CurvatureDistribution | null>(null);

  /**
   * 末端位姿输入（右侧的控制卡片）。
   *
   * 解出来的曲率单独存一份，**不写回输入框**：反解只决定位置、姿态是尽力逼近
   * 的（4 个自由度对 6 个约束），如果把解出来的精确位姿回填，用户就会发现
   * 自己输的 rpy 被悄悄改了。输入框保留用户填的值，实际能达到的位姿另外显示。
   */
  const [tipDraft, setTipDraft] = useState({ x: 0, y: 0, z: 320, roll: 0, pitch: 0, yaw: 0 });
  const [tipSections, setTipSections] = useState<[SectionCurvature, SectionCurvature] | null>(null);

  const segmentLengthM = DEFAULT_DYNAMICS_CONFIG.segmentLengthM;
  /** 曲率上限沿用原来粗控通道的限幅：段 1 是 8、段 2 是 6.5 1/m。 */
  const maxCurvaturePerM = useMemo<readonly [number, number]>(() => [8, 6.5], []);

  const tipSolution = useMemo(() => solveTipPose({
    target: {
      positionM: [tipDraft.x / 1000, tipDraft.y / 1000, tipDraft.z / 1000],
      rpyRad: [
        (tipDraft.roll * Math.PI) / 180,
        (tipDraft.pitch * Math.PI) / 180,
        (tipDraft.yaw * Math.PI) / 180,
      ],
    },
    // 初值取「当前实际曲率」：反解非凸，从现实状态出发既能保证输入框不动时
    // 解是稳定的，也避免每次微调都跳到另一个完全不同的解上。
    base: tipSections ?? actualTipSections,
    segmentLengthM,
    maxCurvaturePerM,
  }), [tipDraft, tipSections, actualTipSections, segmentLengthM, maxCurvaturePerM]);

  /**
   * 当前目标对应的 12 段分布（拖动或末端反解都算）。
   *
   * 这是整页唯一的「目标形状」来源：3D 预览、等效曲率、峰值曲率、下发 payload
   * 全部从它派生，避免出现「预览是一个形状、发下去是另一个」。
   */
  const targetDistribution = useMemo<CurvatureDistribution | null>(() => {
    if (dragTarget) return dragTarget;
    if (tipSections) return distributionFromTipSections(tipSections, segmentLengthM);
    return null;
  }, [dragTarget, tipSections, segmentLengthM]);

  const equivalents = useMemo(
    () => sectionEquivalents(targetDistribution ?? curvatureDistribution),
    [targetDistribution, curvatureDistribution],
  );

  /** 沿整条分布取最大曲率（两段等效值会把峰值平均掉，限位检查必须看原始分布）。 */
  const peakCurvature = useMemo(
    () => (targetDistribution ?? curvatureDistribution).segments.reduce(
      (max, segment) => Math.max(max, segment.kappaAbsPerM),
      0,
    ),
    [targetDistribution, curvatureDistribution],
  );

  const setActiveTab = useCallback((next: WorkspaceTab) => {
    setSearchParams(next === "monitor" ? {} : { tab: next }, { replace: true });
  }, [setSearchParams]);

  const notifyCommand = useCallback((message: string, tone: "ok" | "warn" | "error" = "ok") => {
    setCommandStatus({ tone, message });
  }, []);

  /**
   * 按末端位姿求解并把结果固定下来。
   *
   * 输入框里的位姿是**实时**求解的（每敲一个字符就解一次），但那个结果不进
   * 3D 预览 —— 预览要有「确认」这个动作才不会在打字过程中乱跳。按下按钮才把
   * 当前解冻结成目标曲率，预览与下发随之更新。
   */
  const applyTipPose = useCallback(() => {
    const solved = tipSolution;
    // 末端位姿接管目标：清掉可能还挂着的拖动结果，保证「当前目标」只有一个来源。
    setDragTarget(null);
    setTipSections(solved.sections);
    if (!solved.reachable) {
      notifyCommand(
        `末端点超出工作空间：位置差 ${(solved.positionErrorM * 1000).toFixed(1)} mm，已取最近的可行解`,
        "warn",
      );
      return;
    }
    notifyCommand(
      `已按末端位姿求解（位置残差 ${(solved.positionErrorM * 1000).toFixed(2)} mm，`
      + `姿态残差 ${((solved.orientationErrorRad * 180) / Math.PI).toFixed(1)}°）—— 臂只有 4 个自由度，姿态无法完全指定`,
      "ok",
    );
  }, [tipSolution, notifyCommand]);

  const clearTargets = useCallback(() => {
    setDragTarget(null);
    setTipSections(null);
  }, []);

  /**
   * 三维拖动接管目标。
   *
   * 拖动时清掉末端反解的结果 —— 否则「当前目标」会有两个来源打架：
   * `targetDistribution` 优先取拖动值，但末端面板还在显示上一次的解，用户会
   * 以为两者是一致的。让最后一次操作说了算。
   */
  const handleDragTarget = useCallback((next: CurvatureDistribution | null) => {
    setDragTarget(next);
    if (next) setTipSections(null);
  }, []);

  const runSystemControl = useCallback(async (action: SystemControlAction) => {
    if (action === "disable" || action === "emergencyStop") {
      setActiveControlEnabled(false);
      setCycleLifeEnabled(false);
    }
    try {
      await onSystemControl(action);
      setCommandStatus({ tone: "ok", message: action === "enable" ? "系统已使能" : action === "disable" ? "系统已失能" : "紧急停止已发送" });
    } catch (err) {
      setCommandStatus({ tone: "error", message: err instanceof Error ? err.message : "命令失败" });
    }
  }, [onSystemControl]);

  const runMotorCommand = useCallback(async (command: MotorCommandDraft, message = "电机命令已发送") => {
    try {
      await onSendMotor(command);
      setCommandStatus({ tone: "ok", message });
    } catch (err) {
      setCommandStatus({ tone: "error", message: err instanceof Error ? err.message : "命令失败" });
    }
  }, [onSendMotor]);

  const runWorkspaceCommand = useCallback(async (command: WorkspaceCommand, payload?: WorkspaceCommandPayload, message = "命令已发送") => {
    try {
      await onWorkspaceCommand(command, payload);
      setCommandStatus({ tone: "ok", message });
    } catch (err) {
      setCommandStatus({ tone: "error", message: err instanceof Error ? err.message : "命令失败" });
    }
  }, [onWorkspaceCommand]);

  /**
   * 下发当前的**目标**曲率（拖动或末端位姿反解产生的）。
   *
   * 走的是和原来「发送粗控」完全同一条路径：先折回两段等效曲率，再由 App
   * 转成角度发给 `send_bend_command`。所以拖动 / 末端位姿 / 手输三者发出的
   * 东西是同一量纲，不会出现几条通道各发各的。
   */
  const sendTarget = useCallback(() => {
    if (!targetDistribution) return;
    const source = dragTarget ? "三维拖动" : "末端位姿";
    // 解不可达时把残差一起报出来 —— 操作员按下去的是一条真的会驱动电机的命令，
    // 必须知道他拿到的不是他要的那个点。
    const warn = tipSections && !tipSolution.reachable
      ? `（注意：位置差 ${(tipSolution.positionErrorM * 1000).toFixed(1)} mm，已取最近可行解）`
      : "";
    void runWorkspaceCommand("bend", {
      direction1: equivalents.directionCode[0],
      section1CurvaturePerM: equivalents.curvaturePerM[0],
      direction2: equivalents.directionCode[1],
      section2CurvaturePerM: equivalents.curvaturePerM[1],
    }, `已按${source}曲率下发（峰值 ${peakCurvature.toFixed(2)} 1/m）${warn}`);
  }, [targetDistribution, dragTarget, tipSections, tipSolution, equivalents, peakCurvature, runWorkspaceCommand]);

  // 主动控制：开启后每 200ms 发一次 tick，直到失能或手动停止。
  useEffect(() => {
    if (!activeControlEnabled || !isSystemEnabled) return;
    runWorkspaceCommand("activeTick", undefined, "主动控制 tick 已发送");
    const timer = window.setInterval(() => onWorkspaceCommand("activeTick"), 200);
    return () => window.clearInterval(timer);
  }, [activeControlEnabled, isSystemEnabled, onWorkspaceCommand, runWorkspaceCommand, snapshot.live.selectedDeviceId]);

  useEffect(() => {
    if (activeControlEnabled && !isSystemEnabled) setActiveControlEnabled(false);
  }, [activeControlEnabled, isSystemEnabled]);

  // 循环寿命检测：压力反馈跨过阈值就换向，一个来回计一次。
  useEffect(() => {
    if (!cycleLifeEnabled || !isSystemEnabled || !latestFrame) return;
    const sensorValue = latestFrame.sensors[0]?.filtered[0];
    if (sensorValue == null) return;
    if (sensorValue >= cycleHighThreshold && cycleLastTrigger !== "high") {
      runMotorCommand({ motorId: 1, positionMm: 0, velocityMmPerSec: 10, accelerationMmPerSec2: 3 }, "循环寿命：高阈值触发，电机回收");
      setCycleLastTrigger("high");
      if (cycleLastTrigger === "low") setCycleCount((count) => count + 1);
    } else if (sensorValue <= cycleLowThreshold && cycleLastTrigger !== "low") {
      runMotorCommand({ motorId: 1, positionMm: cycleTargetPosition, velocityMmPerSec: 10, accelerationMmPerSec2: 3 }, "循环寿命：低阈值触发，电机伸出");
      setCycleLastTrigger("low");
    }
  }, [cycleHighThreshold, cycleLastTrigger, cycleLifeEnabled, cycleLowThreshold, cycleTargetPosition, isSystemEnabled, latestFrame, runMotorCommand]);

  const sensorMax = sensors.reduce((max, sensor) => Math.max(max, sensor.filtered[0]), 0);
  const sensorAlarmCount = sensors.filter((sensor) => sensor.filtered[0] >= sensorThreshold).length;

  // 监控卡片布局：拖动 / 缩放后由 useCardLayout 原地写盘，不走页面级状态。
  const { layout, commit: commitLayout } = useCardLayout(snapshot.authSession.username, "workspace-monitor");

  const context = (
    <DeviceContextPanel
      snapshot={snapshot}
      serialPorts={serialPorts}
      serialPortsError={serialPortsError}
      connectedDevices={connectedDevices}
      deviceStatuses={deviceStatuses}
      connectionError={connectionError}
      curvatureSummary={curvatureSummary}
      hasFrame={Boolean(latestFrame)}
      onOpenConnectDialog={onOpenConnectDialog}
      onDisconnectDevice={onDisconnectDevice}
      onRefreshSerialPorts={onRefreshSerialPorts}
    />
  );

  const tabs = (
    <div className="workspace-page-tabs" role="tablist" aria-label="设备工作台视图">
      {WORKSPACE_TABS.map((tab) => {
        const Icon = tab.icon;
        return (
          <button
            aria-controls={`workspace-panel-${tab.key}`}
            aria-selected={activeTab === tab.key}
            className={`workspace-page-tab${activeTab === tab.key ? " is-active" : ""}`}
            id={`workspace-tab-${tab.key}`}
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            role="tab"
            type="button"
          >
            <Icon aria-hidden="true" size={15} />
            {tab.title}
          </button>
        );
      })}
    </div>
  );

  return (
    <WorkbenchLayout context={context} tabs={tabs} contextLabel="设备上下文">
      <div
        aria-labelledby={`workspace-tab-${activeTab}`}
        className="workspace-active-pane"
        id={`workspace-panel-${activeTab}`}
        role="tabpanel"
      >
        {/* ---------- 监控 ---------- */}
        {activeTab === "monitor" ? (
          <CardGrid
            layout={layout}
            ariaLabel="设备监控卡片"
            layoutKey={snapshot.live.selectedDeviceId || "workspace-monitor"}
            onLayoutChange={commitLayout}
            headerForCard={(cardId) => {
              const definition = monitorCardRegistry[cardId as MonitorCardId];
              const Icon = definition.icon;
              return { title: definition.title, icon: <Icon aria-hidden="true" size={17} /> };
            }}
            bodyClassForCard={(cardId) =>
              cardId === "model3d" || cardId === "camera" ? "model-card-body" : undefined}
            childrenForCard={(cardId) =>
              monitorCardRegistry[cardId as MonitorCardId].render({
                snapshot,
                motors,
                sensors,
                backbone,
                latestFrame,
                sensorMax,
                sensorAlarmCount,
                sensorThreshold,
                onSensorThresholdChange: setSensorThreshold,
                curvatureSummary,
              })}
          />
        ) : null}

        {/* ---------- 实时数据 ---------- */}
        {activeTab === "live-data" ? (
          <div className="workspace-pane-grid live-data-pane">
            <section className="workspace-panel workspace-panel-wide">
              <header>
                <div><span>DeviceTab</span><h2>电机实时数据</h2></div>
                <Badge tone={isSystemEnabled ? "ok" : "warn"}>{isSystemEnabled ? "已使能" : "未使能"}</Badge>
              </header>
              <div className="workspace-table" role="table" aria-label="电机实时数据">
                <div className="workspace-table-row is-head" role="row">
                  <span role="columnheader">电机</span>
                  <span role="columnheader">运行</span>
                  <span role="columnheader">位移 mm</span>
                  <span role="columnheader">速度 mm/s</span>
                  <span role="columnheader">加速度 mm/s²</span>
                  <span role="columnheader">目标 mm</span>
                </div>
                {motors.map((motor) => (
                  <div className="workspace-table-row" role="row" key={motor.id}>
                    <span role="cell">电机 {motor.id}</span>
                    <span role="cell">{motor.running ? "运行" : "停止"}</span>
                    <span role="cell">{motor.positionMm.toFixed(2)}</span>
                    <span role="cell">{motor.velocityMmPerSec.toFixed(2)}</span>
                    <span role="cell">{motor.accelerationMmPerSec2.toFixed(2)}</span>
                    <span role="cell">{motor.targetPositionMm.toFixed(2)}</span>
                  </div>
                ))}
              </div>
              {motors.length === 0 ? (
                <div className="workspace-empty-state">
                  <Eye aria-hidden="true" size={22} />
                  <strong>暂无实时数据</strong>
                  <span>请先在左侧连接设备或启动模拟器，数据会随采样自动刷新。</span>
                </div>
              ) : null}
            </section>

            <section className="workspace-panel workspace-panel-wide">
              <header><div><span>DeviceTab</span><h2>压力传感器实时数据</h2></div></header>
              <div className="workspace-table" role="table" aria-label="压力传感器实时数据">
                <div className="workspace-table-row is-head" role="row">
                  <span role="columnheader">传感器</span>
                  <span role="columnheader">质量</span>
                  <span role="columnheader">{sensors[0]?.alias[0] ?? "X"}</span>
                  <span role="columnheader">{sensors[0]?.alias[1] ?? "Y"}</span>
                  <span role="columnheader">{sensors[0]?.alias[2] ?? "Z"}</span>
                  <span role="columnheader">原始值</span>
                </div>
                {sensors.map((sensor) => (
                  <div className="workspace-table-row" role="row" key={sensor.id}>
                    <span role="cell">传感器 {sensor.id}</span>
                    <span role="cell">{sensor.quality}</span>
                    <span role="cell">{sensor.filtered[0].toFixed(2)} {sensor.unit}</span>
                    <span role="cell">{sensor.filtered[1].toFixed(2)} {sensor.unit}</span>
                    <span role="cell">{sensor.filtered[2].toFixed(2)} {sensor.unit}</span>
                    <span role="cell">{sensor.raw[0].toFixed(2)} / {sensor.raw[1].toFixed(2)} / {sensor.raw[2].toFixed(2)}</span>
                  </div>
                ))}
              </div>
              {sensors.length === 0 ? (
                <div className="workspace-empty-state">
                  <Database aria-hidden="true" size={22} />
                  <strong>暂无传感器数据</strong>
                  <span>请先在左侧连接设备或启动模拟器。</span>
                </div>
              ) : null}
            </section>
          </div>
        ) : null}

        {/* ---------- 手动控制 ---------- */}
        {activeTab === "manual" ? (
          <div className="workspace-pane-grid manual-control-pane">
            <section className="workspace-panel manual-volume-panel">
              <header>
                <div><span>DeviceTab</span><h2>三维曲率拖动控制</h2></div>
                <label className="curvature-drag-toggle">
                  <input type="checkbox" checked={dragEnabled}
                    onChange={(event) => {
                      const next = event.target.checked;
                      setDragEnabled(next);
                      // 关掉编辑时一并清掉目标，视图立刻回到真实形状。
                      if (!next) setDragTarget(null);
                    }} />
                  <span>拖动编辑</span>
                </label>
              </header>
              <CurvatureDragPreview
                actual={backbone}
                // 预览显示的是**目标**分布：拖动与末端位姿反解是两个入口，
                // 但都落到 targetDistribution 上，3D 视图与下发永远一致。
                target={targetDistribution}
                enabled={dragEnabled}
                onTargetChange={handleDragTarget}
              />
              <div className="curvature-equivalent">
                <div>
                  <span>通道 A 等效曲率</span>
                  <strong>{equivalents.curvaturePerM[0].toFixed(2)} 1/m · {directionLabel(equivalents.directionDeg[0])}</strong>
                </div>
                <div>
                  <span>通道 B 等效曲率</span>
                  <strong>{equivalents.curvaturePerM[1].toFixed(2)} 1/m · {directionLabel(equivalents.directionDeg[1])}</strong>
                </div>
                <div>
                  <span>沿臂峰值曲率</span>
                  <strong className={peakCurvature > maxCurvaturePerM[0] ? "is-warn" : undefined}>{peakCurvature.toFixed(2)} 1/m</strong>
                </div>
              </div>
              <div className="curvature-drag-actions">
                <div className="workspace-action-row">
                  <button type="button" className="ghost-btn" disabled={!targetDistribution}
                    onClick={clearTargets}>
                    <span>清空目标</span>
                  </button>
                  <button type="button" className="primary-btn" disabled={!targetDistribution}
                    onClick={sendTarget}>
                    <ArrowRightLeft size={15} /><span>按此曲率下发</span>
                  </button>
                </div>
              </div>
              <p className="curvature-drag-note">
                点击「按此曲率下发」下发命令
              </p>
            </section>

            <div className="manual-side-stack">
            <section className="workspace-panel">
              <header>
                <div><span>DeviceTab</span><h2>末端位姿控制</h2></div>
              </header>
              <div className="tip-pose-grid">
                {([
                  ["x", "X mm"], ["y", "Y mm"], ["z", "Z mm"],
                  ["roll", "Roll °"], ["pitch", "Pitch °"], ["yaw", "Yaw °"],
                ] as const).map(([key, label]) => (
                  <label className="workspace-field" key={key}>
                    <span>{label}</span>
                    <input type="number" step={key === "z" ? 1 : 0.5} value={tipDraft[key]}
                      onChange={(event) => setTipDraft((draft) => ({ ...draft, [key]: Number(event.target.value) }))} />
                  </label>
                ))}
              </div>

              {/* 实时求解结果：用户每改一个数字这里就更新，但只有按下按钮才进 3D 预览。 */}
              <div className="tip-pose-result">
                <div>
                  <span>可达性</span>
                  <strong className={tipSolution.reachable ? undefined : "is-warn"}>
                    {tipSolution.reachable ? "位置可达" : `不可达（差 ${(tipSolution.positionErrorM * 1000).toFixed(1)} mm）`}
                  </strong>
                </div>
                <div>
                  <span>位置残差</span>
                  <strong>{(tipSolution.positionErrorM * 1000).toFixed(2)} mm</strong>
                </div>
                <div>
                  <span>姿态残差</span>
                  <strong className={tipSolution.orientationErrorRad > 0.1 ? "is-warn" : undefined}>
                    {((tipSolution.orientationErrorRad * 180) / Math.PI).toFixed(1)}°
                  </strong>
                </div>
                <div>
                  <span>解出曲率</span>
                  <strong>
                    {curvatureOf(tipSolution.sections[0]).curvaturePerM.toFixed(2)} /{" "}
                    {curvatureOf(tipSolution.sections[1]).curvaturePerM.toFixed(2)} 1/m
                  </strong>
                </div>
              </div>

              <div className="workspace-action-row">
                <button type="button" className="primary-btn" onClick={applyTipPose}>
                  <span>按位姿求解</span>
                </button>
                <button type="button" className="ghost-btn" onClick={clearTargets} disabled={!tipSections}>
                  <span>清除</span>
                </button>
              </div>
            </section>

            <section className="workspace-panel">
              <header><div><span>DeviceTab</span><h2>电机控制</h2></div></header>
              <div className="workspace-form-grid workspace-form-grid-motor">
                <label className="workspace-field">
                  <span>电机 ID</span>
                  <select value={motorDraft.motorId} onChange={(event) => setMotorDraft((draft) => ({ ...draft, motorId: Number(event.target.value) }))}>
                    {motors.map((motor) => <option key={motor.id} value={motor.id}>{motor.id}</option>)}
                  </select>
                </label>
                <label className="workspace-field">
                  <span>位移 mm</span>
                  <input type="number" min={-80} max={80} step={0.1} value={motorDraft.positionMm}
                    onChange={(event) => setMotorDraft((draft) => ({ ...draft, positionMm: clamp(Number(event.target.value), -80, 80) }))} />
                </label>
                <label className="workspace-field">
                  <span>速度 mm/s</span>
                  <input type="number" min={0} step={0.1} value={motorDraft.velocityMmPerSec}
                    onChange={(event) => setMotorDraft((draft) => ({ ...draft, velocityMmPerSec: Number(event.target.value) }))} />
                </label>
                <label className="workspace-field">
                  <span>加速度 mm/s²</span>
                  <input type="number" min={0} step={0.1} value={motorDraft.accelerationMmPerSec2}
                    onChange={(event) => setMotorDraft((draft) => ({ ...draft, accelerationMmPerSec2: Number(event.target.value) }))} />
                </label>
                <button type="button" className="primary-btn" onClick={() => runMotorCommand(motorDraft)}>
                  <ArrowRightLeft size={15} /><span>发至电机</span>
                </button>
                <button type="button" className="ghost-btn" onClick={() => runWorkspaceCommand("home", undefined, "已发送一键归中命令")}>
                  <span>一键归中</span>
                </button>
              </div>
              <div className="motor-state-strip" aria-label="电机当前状态">
                {motors.map((motor) => (
                  <div key={motor.id}>
                    <span>电机 {motor.id}</span>
                    <strong>{motor.positionMm.toFixed(1)} mm · {motor.velocityMmPerSec.toFixed(1)} mm/s</strong>
                    <small>{motor.running ? "运行中" : "停止"}</small>
                  </div>
                ))}
                {motors.length === 0 ? <div><span>电机</span><strong>无数据</strong><small>未连接</small></div> : null}
              </div>
            </section>

            <section className="workspace-panel">
              <header><div><span>DeviceTab</span><h2>压力数据监控 / 校准</h2></div></header>
              <div className="workspace-form-grid">
                <label className="workspace-field">
                  <span>压力传感器 ID</span>
                  <select value={sensorDraft.sensorId} onChange={(event) => setSensorDraft((draft) => ({ ...draft, sensorId: Number(event.target.value) }))}>
                    {sensors.map((sensor) => <option key={sensor.id} value={sensor.id}>{sensor.id}</option>)}
                  </select>
                </label>
                <label className="workspace-field">
                  <span>校准值 N</span>
                  <input type="number" step={0.01} value={sensorDraft.calibrationValue}
                    onChange={(event) => setSensorDraft((draft) => ({ ...draft, calibrationValue: Number(event.target.value) }))} />
                </label>
              </div>
              <div className="workspace-action-row">
                <button type="button" className="ghost-btn" onClick={() => runWorkspaceCommand("calibrateSensor", sensorDraft, "已发送传感器校准命令")}>
                  <CheckCircle2 size={15} /><span>校准传感器</span>
                </button>
              </div>
              {selectedSensor ? (
                <div className="sensor-axis-grid compact">
                  {selectedSensor.alias.map((axis, index) => (
                    <div key={axis}>
                      <span>{axis}</span>
                      <strong>{selectedSensor.filtered[index].toFixed(2)} {selectedSensor.unit}</strong>
                      <small>raw {selectedSensor.raw[index].toFixed(2)}</small>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
            </div>
          </div>
        ) : null}

        {/* ---------- 自动控制 ---------- */}
        {activeTab === "automatic" ? (
          <div className="workspace-pane-grid automatic-control-pane">
            <section className="workspace-panel workspace-panel-wide">
              <header>
                <div><span>DeviceTab</span><h2>系统操作权限</h2></div>
                {commandStatus ? <Badge tone={commandStatus.tone}>{commandStatus.message}</Badge> : null}
              </header>
              <div className="automatic-status-grid">
                <div><span>连接状态</span><strong>{snapshot.connection.state}</strong></div>
                <div><span>使能状态</span><strong>{isSystemEnabled ? "已使能" : "已失能"}</strong></div>
                <div><span>急停锁存</span><strong>{snapshot.runtimeDiagnostics.emergencyLatched ? "已锁定" : "正常"}</strong></div>
                <div><span>控制阶段</span><strong>{snapshot.controlRuntime.active ? snapshot.controlRuntime.phase : "inactive"}</strong></div>
                <div><span>目标曲率</span><strong>{snapshot.controlRuntime.targetCurvaturePerM.toFixed(2)} 1/m</strong></div>
                <div><span>已完成循环</span><strong>{snapshot.controlRuntime.cyclesCompleted}</strong></div>
              </div>
              <div className="workspace-action-row">
                <button type="button" className="primary-btn" onClick={() => runSystemControl("enable")} disabled={!snapshot.live.selectedDeviceId}>
                  <CheckCircle2 size={15} /><span>启动控制系统</span>
                </button>
                <button type="button" className="ghost-btn" onClick={() => runSystemControl("disable")} disabled={!snapshot.live.selectedDeviceId}>
                  <PauseCircle size={15} /><span>关闭控制系统</span>
                </button>
                <button type="button" className="ghost-btn danger" onClick={() => runSystemControl("emergencyStop")}>
                  <AlertTriangle size={15} /><span>紧急停止</span>
                </button>
              </div>
            </section>

            <section className="workspace-panel">
              <header><div><span>DeviceTab</span><h2>PID 参数</h2></div></header>
              <div className="workspace-form-grid workspace-form-grid-pid">
                {(["kp", "ki", "kd"] as const).map((key) => (
                  <label className="workspace-field" key={key}>
                    <span>{key.toUpperCase()}</span>
                    <input type="number" step={0.01} value={pidDraft[key]}
                      onChange={(event) => setPidDraft((draft) => ({ ...draft, [key]: Number(event.target.value) }))} />
                  </label>
                ))}
              </div>
              <div className="workspace-action-row">
                <button type="button"
                  className={`ghost-btn ${activeControlEnabled ? "active" : ""}`}
                  disabled={!isSystemEnabled}
                  onClick={() => {
                    const next = !activeControlEnabled;
                    setActiveControlEnabled(next);
                    notifyCommand(next ? "主动控制已开启，每 200ms 发送 tick" : "主动控制已停止", next ? "ok" : "warn");
                  }}>
                  <span>{activeControlEnabled ? "停止主动控制" : "主动控制"}</span>
                </button>
              </div>
            </section>

            <section className="workspace-panel">
              <header><div><span>frontend loop</span><h2>循环寿命检测</h2></div></header>
              <div className="workspace-form-grid workspace-form-grid-cycle">
                <label className="workspace-field"><span>低阈值</span>
                  <input type="number" step={0.1} value={cycleLowThreshold}
                    onChange={(event) => setCycleLowThreshold(Number(event.target.value))} />
                </label>
                <label className="workspace-field"><span>高阈值</span>
                  <input type="number" step={0.1} value={cycleHighThreshold}
                    onChange={(event) => setCycleHighThreshold(Number(event.target.value))} />
                </label>
                <label className="workspace-field"><span>伸出位移</span>
                  <input type="number" step={0.1} value={cycleTargetPosition}
                    onChange={(event) => setCycleTargetPosition(Number(event.target.value))} />
                </label>
              </div>
              <div className="automatic-status-grid">
                <div><span>循环次数</span><strong>{cycleCount}</strong></div>
                <div><span>反馈值</span><strong>{latestFrame?.sensors[0]?.filtered[0].toFixed(2) ?? "--"} N</strong></div>
                <div><span>上次触发</span><strong>{cycleLastTrigger ?? "无"}</strong></div>
              </div>
              <div className="workspace-action-row">
                <button type="button"
                  className={`ghost-btn ${cycleLifeEnabled ? "active" : ""}`}
                  disabled={!isSystemEnabled}
                  onClick={() => {
                    const next = !cycleLifeEnabled;
                    setCycleLifeEnabled(next);
                    notifyCommand(next ? "循环寿命检测已开启" : "循环寿命检测已停止", next ? "ok" : "warn");
                  }}>
                  <span>{cycleLifeEnabled ? "停止循环寿命检测" : "循环寿命检测"}</span>
                </button>
                <button type="button" className="ghost-btn"
                  onClick={() => { setCycleCount(0); setCycleLastTrigger(null); }}>
                  <span>重置计数</span>
                </button>
              </div>
            </section>
          </div>
        ) : null}

        {/* ---------- 回放 ---------- */}
        {activeTab === "playback" ? (
          <div className="workspace-pane-grid playback-pane">
            <section className="workspace-panel workspace-panel-wide">
              <header>
                <div><span>workspace</span><h2>会话与回放</h2></div>
                <Badge tone={snapshot.playbackMode ? "info" : "neutral"}>{snapshot.playbackMode ? "回放中" : "实时"}</Badge>
              </header>
              <div className="timeline">
                <div className="timeline-bar"><div className="timeline-fill" style={{ width: `${progress}%` }} /></div>
                <div className="timeline-meta">
                  <span>{isoFull(snapshot.playback.cursorMs)}</span>
                  <span>{snapshot.playback.speed.toFixed(1)}x</span>
                  <span>{snapshot.playback.durationMs / 1000}s</span>
                </div>
              </div>
              <div className="mini-info">当前会话：<strong>{activeSession?.name ?? "--"}</strong></div>
            </section>

            <section className="workspace-panel workspace-panel-wide">
              <header><div><span>workspace</span><h2>会话列表</h2></div></header>
              <div className="playback-session-list">
                {snapshot.playback.sessions.map((session) => (
                  <div className="playback-session-row" key={session.id}>
                    <div>
                      <strong title={session.name}>{session.name}</strong>
                      <span>{(session.recordCount ?? 0).toLocaleString()} 条记录 · {session.operator}</span>
                    </div>
                  </div>
                ))}
                {snapshot.playback.sessions.length === 0 ? (
                  <div className="workspace-empty-state">
                    <Play aria-hidden="true" size={22} />
                    <strong>还没有可回放的会话</strong>
                    <span>先在「会话与记录」页开始一次录制，完成后即可在这里回放。</span>
                  </div>
                ) : null}
              </div>
            </section>

            <section className="workspace-panel workspace-panel-wide">
              <header><div><span>workspace</span><h2>最近日志</h2></div></header>
              <div className="log-list compact">
                {snapshot.logs.slice(0, 4).map((entry) => (
                  <div className="log-row" key={entry.id}>
                    <Badge tone={toneForLevel(entry.level)}>{entry.level.toUpperCase()}</Badge>
                    <span className="log-scope">{entry.scope}</span>
                    <span className="log-message">{entry.message}</span>
                  </div>
                ))}
                {snapshot.logs.length === 0 ? (
                  <div className="workspace-empty-state">
                    <Logs aria-hidden="true" size={22} />
                    <strong>暂无日志</strong>
                  </div>
                ) : null}
              </div>
            </section>
          </div>
        ) : null}
      </div>
    </WorkbenchLayout>
  );
}
