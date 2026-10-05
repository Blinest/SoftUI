import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { automaticCardDraggable, automaticCardRegistry } from "./automaticCards";
import { manualCardDraggable, manualCardRegistry } from "./manualCards";
import { clamp, errorText, isoFull, toneForLevel } from "../utils";
import { useCardLayout } from "../state/layoutStore";
import {
  buildBackboneFromCurvatureDistribution,
  clampCurvatureDistribution,
  curvatureDistributionFromSnapshot,
  setModelCurvatureLimitPerM,
  summarizeBackbone,
  type CurvatureDistribution,
} from "../dynamics/svcModel";
import { CurvatureDragPreview } from "../robot/CurvatureDragPreview";
import { WorkspaceCard } from "../components/WorkspaceCard";
import {
  KAPPA_TABLE_COVERAGE_PER_M,
  lookupTipPoseShape,
  sendTipPoseCommand,
  type TipPoseShapeLookup,
} from "../robot/curvatureBridge";
import { tipPoseOfDistribution } from "../robot/pose3d";
import { fetchModelStatus, importModelFromFile, resetModel, type ModelStatus } from "../robot/modelBridge";

/** 度 → 弧度（曲率方向换算用）。 */
const DEG2RAD = Math.PI / 180;
import type { AutomaticCardId, DeviceConnectionRecord, DeviceRuntimeStatusView, ManualCardId, MonitorCardId, RuntimeSnapshot, SerialPortDescriptor } from "../softuiTypes";
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
 *   - 三维拖动：12 段分布 → 积分出**末端位姿** → 位姿表（6 维键）取 6 个 ΔL；
 *   - 末端位姿：6 个位姿分量 → **全阶 Cosserat 位姿查表** → 形状 + ΔL，同样落到这里。
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
  /**
   * 把命令反馈抛到页面顶层（App 的横幅）。
   *
   * 反馈不落在各张卡片的标题栏里 —— 同一条消息在多个卡片重复出现，反而看不出
   * 到底是哪一步出的问题。传 `null` 表示清空。
   */
  onNotice?: (notice: CommandNotice | null) => void;
  /**
   * 操作员最后一次成功的系统操作（启动 / 关闭 / 急停）。
   *
   * 只用于左栏「使能状态」的措辞：关闭后要显示「已失能」，而不是和「从未使能」一样的
   * 「未使能」——状态帧里的 system_state 只有 0/1，区分不了这两件事。
   */
  systemControlAction?: SystemControlAction | null;
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
 * 需要「系统已使能」才会真正下发的指令。
 *
 * 与后端 `CommandSafety::Enabled` 一一对应（`send_curvature_command` /
 * `send_tip_pose_command` / `send_motor_command` / `send_home_command` / `send_bend_command` /
 * `send_active_control_tick`）；`calibrateSensor` 只要求「已连接」，不在此列。
 */
const WORKSPACE_COMMAND_LABELS: Partial<Record<WorkspaceCommand, string>> = {
  home: "一键归中命令",
  bend: "弯曲命令",
  activeTick: "主动控制 tick",
};

/** 固定末端位姿的漂移阈值在 localStorage 里的键。 */
const TIP_DRIFT_TOLERANCE_KEY = "softui:tipDriftToleranceMm";

/** 顶层命令反馈：成功 / 未使能警告 / 失败原因，统一一种结构（由 App 在页面顶部渲染）。 */
export type CommandNotice = { tone: "ok" | "warn" | "error"; message: string };

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
  onNotice,
  systemControlAction,
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
  /**
   * 「启动控制系统」的驱动方。
   *
   * 这个开关和别的输入不同：打开后**本端**会每 200ms 发一条主动控制 tick。
   * 所以远端只镜像显示、绝不能跟着发 tick —— 否则两端各发一条，设备收到双份。
   * `local` = 本端开启并负责驱动；`remote` = 镜像显示，不驱动。
   */
  const [controlEnabledBy, setControlEnabledBy] = useState<"local" | "remote" | null>(null);
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
  /**
   * 是否允许下发运动指令。
   *
   * 两个来源任一成立即可：状态帧说已使能，或操作员点过「启动控制系统」。后者必须有 ——
   * 下位机不把使能状态回写进状态帧（STM32 的 `CR.state` 恒 0）时，光看帧会让所有按钮永远是死的。
   * 与后端 `RuntimeStatus::control_enabled` 同一口径。
   */
  const motionAllowed = isSystemEnabled || systemControlAction === "enable";

  const curvatureDistribution = useMemo(() => curvatureDistributionFromSnapshot(latestFrame, { basisSegmentCount: 12 }), [latestFrame]);
  const backbone = useMemo(() => buildBackboneFromCurvatureDistribution(curvatureDistribution), [curvatureDistribution]);
  const curvatureSummary = useMemo(() => summarizeBackbone(backbone), [backbone]);

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

  /**
   * 「固定末端位姿」开关：打开后三维拖动只改臂体形状，末端位置/姿态保持不变
   * （实现见 `curvatureDrag.solveDragLockingTip`，末端漂移会实时显示在视图下方）。
   */
  const [lockTipPose, setLockTipPose] = useState(false);
  /**
   * 固定末端位姿的**漂移阈值**（mm）：超过它就在视图下方标黄提示
   * 「形状到极限、末端开始被拖着走」。数值在 localStorage 里记住。
   */
  /**
   * 「位姿目标是否已激活」。
   *
   * 手动输入或三维拖动都会置 true；「清空目标」置 false。用它把「没有目标」和
   * 「目标恰好等于某个位姿」区分开 —— 否则清空之后防抖查表会马上把目标算回来。
   */
  const [tipTargetActive, setTipTargetActive] = useState(false);

  const [tipDriftToleranceMm, setTipDriftToleranceMm] = useState(() => {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(TIP_DRIFT_TOLERANCE_KEY) : null;
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
  });

  useEffect(() => {
    window.localStorage.setItem(TIP_DRIFT_TOLERANCE_KEY, String(tipDriftToleranceMm));
  }, [tipDriftToleranceMm]);

  /** 当前模型包（内置 or 导入）。 */
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  /**
   * 当前模型的曲率上限（1/m）——`model_status` 里由 κ 表覆盖范围扫出来的值。
   *
   * 拖动/反解/下发检查全部用它，不再用写死的上限；`setModelCurvatureLimitPerM` 同时在
   * `svcModel` 里生效（拖动反解内部读的是那份），这里的 state 只用于渲染阈值与文案。
   */
  const [modelKappaLimit, setModelKappaLimit] = useState(KAPPA_TABLE_COVERAGE_PER_M);
  const modelFileRef = useRef<HTMLInputElement | null>(null);

  /** 模型状态到手就同步上限：换模型包（内置/导入）后 UI 运动范围跟着变。 */
  const applyModelStatus = useCallback((status: ModelStatus) => {
    setModelStatus(status);
    if (Number.isFinite(status.kappaLimitPerM) && status.kappaLimitPerM > 0) {
      setModelKappaLimit(status.kappaLimitPerM);
      setModelCurvatureLimitPerM(status.kappaLimitPerM);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        applyModelStatus(await fetchModelStatus());
      } catch { /* 忽略：拿不到就只显示未加载 */ }
    })();
  }, [applyModelStatus]);

  const handleImportModel = useCallback(async (file: File) => {
    try {
      applyModelStatus(await importModelFromFile(file));
      setCommandStatus({ tone: "ok", message: `模型已导入：${file.name}` });
    } catch (err) {
      setCommandStatus({ tone: "error", message: errorText(err, "模型导入失败") });
    }
  }, [applyModelStatus]);

  const handleResetModel = useCallback(async () => {
    try {
      applyModelStatus(await resetModel());
      setCommandStatus({ tone: "ok", message: "已恢复内置模型" });
    } catch (err) {
      setCommandStatus({ tone: "error", message: errorText(err, "恢复失败") });
    }
  }, [applyModelStatus]);

  /** 末端位姿 → .py 表的真实形状（3D 预览用，只读）。 */
  const [tableShape, setTableShape] = useState<TipPoseShapeLookup | null>(null);

  /**
   * 位姿一变就去查表取形状（150ms 防抖，避免每次按键都打一次 IPC）。
   *
   * 预览**只认表里真实存在的解**：查不到（超覆盖）就退回显示实际形状，
   * 而不是拿前端拟合出来的形状糊弄。
   */
  useEffect(() => {
    // 拖动模式下目标来自 12 段分布，这里的查询（基于输入框位姿）用不上，
    // 拖动过程中每 150ms 打一次 IPC 纯属浪费；「清空目标」后也没有目标可查。
    if (dragTarget || !tipTargetActive) return;
    const rollRad = (tipDraft.roll * Math.PI) / 180;
    const pitchRad = (tipDraft.pitch * Math.PI) / 180;
    const yawRad = (tipDraft.yaw * Math.PI) / 180;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const shape = await lookupTipPoseShape(
            [tipDraft.x, tipDraft.y, tipDraft.z],
            [rollRad, pitchRad, yawRad],
          );
          if (!cancelled) setTableShape(shape);
        } catch {
          if (!cancelled) setTableShape(null);
        }
      })();
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [tipDraft, dragTarget, tipTargetActive]);

  /** 由查表结果拼出 12 段曲率分布（喂给既有的 3D 骨架积分器）。 */
  const tableDistribution = useMemo<CurvatureDistribution | null>(() => {
    // 没激活（或刚清空）时不算目标：否则「清空」之后位姿表又会立刻把它算回来。
    if (!tipTargetActive || !tableShape || !tableShape.covered) return null;
    const segLen = tableShape.segmentLengthMm;
    return {
      totalLengthMm: tableShape.totalLengthMm,
      basisSegmentCount: tableShape.segmentCount,
      source: "deviceCurvature",
      segments: tableShape.kxPerM.map((kx, index) => ({
        index,
        sStartMm: index * segLen,
        sEndMm: (index + 1) * segLen,
        sMidMm: (index + 0.5) * segLen,
        lengthMm: segLen,
        kxPerM: kx,
        kyPerM: tableShape.kyPerM[index] ?? 0,
        kappaAbsPerM: tableShape.kappaAbsPerM[index] ?? 0,
        phiRad: tableShape.phiRad[index] ?? 0,
      })),
    };
  }, [tableShape, tipTargetActive]);


  /**
   * 当前目标对应的 12 段分布（拖动或末端反解都算）。
   *
   * 这是整页唯一的「目标形状」来源：3D 预览、末端位姿读数、峰值曲率、下发 payload
   * 全部从它派生，避免出现「预览是一个形状、发下去是另一个」。
   *
   * ⚠ 这里按**当前模型 κ 表覆盖上限**钳一道：拖动反解已经带了上限，但末端位姿查表回来的
   * 形状、以及历史遗留的 dragTarget 都可能超界。钳在分布上，预览与下发才是同一个形状。
   */
  const rawTargetDistribution = useMemo<CurvatureDistribution | null>(() => {
    if (dragTarget) return dragTarget;
    // 末端位姿分支：形状**只**来自 .py 表；表外不再兜底（前端已无内置 PCC 反解）
    if (tableDistribution) return tableDistribution;
    return null;
  }, [dragTarget, tableDistribution]);

  const targetDistribution = useMemo<CurvatureDistribution | null>(
    () => (rawTargetDistribution ? clampCurvatureDistribution(rawTargetDistribution, modelKappaLimit) : null),
    [rawTargetDistribution, modelKappaLimit],
  );

  /** 原始目标是否被模型上限钳过（下发时提示「已按上限钳制」）。 */
  const targetClamped = useMemo(() => {
    if (!rawTargetDistribution) return false;
    const rawPeak = rawTargetDistribution.segments.reduce(
      (max, segment) => Math.max(max, segment.kappaAbsPerM),
      0,
    );
    return rawPeak > modelKappaLimit + 1e-9;
  }, [rawTargetDistribution, modelKappaLimit]);

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
   * 命令反馈统一往上抛一层（App 顶部横幅）。
   *
   * 页面自己的 `commandStatus` 只作为「本页最近一次命令结果」的记账，实际显示交给顶层 ——
   * 用户点的是手动控制里的按钮，提示就必须出现在他视线所在的顶层，而不是散到各张卡片上。
   */
  useEffect(() => {
    onNotice?.(commandStatus);
  }, [commandStatus, onNotice]);

  // 离开工作台时把横幅收掉，免得别的页面还挂着上一页的提示。
  useEffect(() => () => onNotice?.(null), [onNotice]);

  /**
   * 运动指令的前置条件：系统未使能就直接给出警告，不发请求。
   *
   * 后端 `guard_command_allowed(CommandSafety::Enabled)` 要求设备处于使能态；「点过启动控制系统」
   * 本身就算（后端 `RuntimeStatus::control_enabled`），所以下位机状态帧不回写 `system_state`
   * 时也能正常下发 —— 否则按钮永远是死的。
   *
   * @returns true = 可以下发
   */
  const requireSystemEnabled = useCallback((what: string): boolean => {
    if (motionAllowed) return true;
    setCommandStatus({
      tone: "warn",
      message: `${what}未下发：系统未使能。请到「自动控制 → 系统操作」点「启动控制系统」后再试。`,
    });
    return false;
  }, [motionAllowed]);

  /**
   * 未使能时给按钮换色（警告色）。
   *
   * 刻意**不禁用**按钮：禁用只会让用户以为界面坏了；保持可点，点下去在顶层横幅给出
   * 原因，同时颜色本身已经提示「现在点它没用」。
   */
  const blockedClass = (base: string) => (motionAllowed ? base : `${base} is-blocked`);
  const blockedHint = (label: string) =>
    motionAllowed ? undefined : `系统未使能：点击「${label}」不会下发，请先到「自动控制 → 系统操作」启动控制系统`;

  /**
   * 使能状态措辞：与左栏同口径。
   *
   * 「点过启动控制系统」即视为已使能（后端 `control_enabled` 同样口径）；状态帧的
   * `system_state` 只作为额外来源。关闭后显示「已失能」而不是「未使能」。
   */
  const enableStateLabel = systemControlAction === "emergencyStop"
    ? "急停锁定"
    : systemControlAction === "disable"
      ? "已失能"
      : motionAllowed
        ? "已使能"
        : "未使能";
  const enableStateTone = systemControlAction === "emergencyStop" ? "error" : motionAllowed ? "ok" : "warn";

  /** 正在应用远端状态时为 true，用于掐断「本端 → 远端 → 本端」的回环。 */
  const applyingRemoteUiRef = useRef(false);

  /** 把本端 UI 状态广播给其它端。换一个 key 就能同步一种新状态，不用改传输层。 */
  const publishUi = useCallback((key: string, payload: unknown) => {
    if (applyingRemoteUiRef.current) return;
    window.dispatchEvent(new CustomEvent("softui:local-ui", { detail: { key, payload } }));
  }, []);

  /**
   * 清空目标：拖动目标、位姿目标、查表结果一起清掉，6 个输入框一并归零。
   *
   * 「清空」必须三样都清：只清拖动目标的话，`tipDraft` 还在，防抖查表会立刻把目标形状
   * 重新算出来 —— 表现就是「点了清空，3D 视图里目标还在」。
   */
  const clearTargets = useCallback(() => {
    setDragTarget(null);
    setTipTargetActive(false);
    setTableShape(null);
    const zeroDraft = { x: 0, y: 0, z: 0, roll: 0, pitch: 0, yaw: 0 };
    setTipDraft(zeroDraft);
    // 「清空」必须把三样一起广播：只发 drag=null 的话，对端的 tipDraft 还是旧值，
    // 它的防抖查表会立刻把目标形状重新算出来 —— 表现就是"点了清空，对面目标还在"。
    publishUi("drag", null);
    publishUi("tip", zeroDraft);
    publishUi("tipTargetActive", false);
  }, [publishUi]);

  /**
   * 手输目标末端位姿（拖动卡片里的 6 个格子）。
   *
   * 与「三维拖动」是同一个「目标」的两种来源，**互斥**：一改数值就清掉拖动目标，
   * 否则会出现「界面显示拖动形状、下发用的是位姿目标」这种说不清的状态。
   * 改完由既有的防抖查表 effect 去反查位姿表，3D 预览随即切到表里那条真实形状。
   */
  const editTipDraft = useCallback(
    (key: "x" | "y" | "z" | "roll" | "pitch" | "yaw", value: number) => {
      setDragTarget(null);
      setTipTargetActive(true);
      // 整份草稿下发，而不是只发改动的那个字段：
      // 通道只保留最新值，发差分一旦漏一帧，别的端就会永久错位。
      const next = { ...tipDraft, [key]: value };
      setTipDraft(next);
      publishUi("tip", next);
      publishUi("tipTargetActive", true);
    },
    [tipDraft, publishUi],
  );

  /**
   * 三维拖动接管目标。
   *
   * 拖动时清掉末端反解的结果 —— 否则「当前目标」会有两个来源打架：
   * `targetDistribution` 优先取拖动值，但末端面板还在显示上一次的解，用户会
   * 以为两者是一致的。让最后一次操作说了算。
   *
   * 同时把拖动结果的**末端位姿直接写回输入框**：界面上只有一处「目标末端位姿」，
   * 不另开一行文字说明「当前来自拖动」—— 数值本身就是说明。
   */
  const handleDragTarget = useCallback((next: CurvatureDistribution | null) => {
    // 只广播本端真实操作的拖动；应用远端来的值时不往回复发
    publishUi("drag", next);
    setDragTarget(next);
    if (!next) return;
    setTipTargetActive(true);
    publishUi("tipTargetActive", true);
    const tip = tipPoseOfDistribution(next.segments);
    setTipDraft({
      x: tip.positionM[0] * 1000,
      y: tip.positionM[1] * 1000,
      z: tip.positionM[2] * 1000,
      roll: (tip.rpyRad[0] * 180) / Math.PI,
      pitch: (tip.rpyRad[1] * 180) / Math.PI,
      yaw: (tip.rpyRad[2] * 180) / Math.PI,
    });
  }, []);

  /**
   * 接收其它端的拖动预览。
   *
   * 拖动目标原来只存在本端 React 状态里，别的端的浏览器根本无从得知
   * （实测：手机端拖动，电脑端毫无反应）。现在由 shim 经后端单槽通道转发，
   * 这里只负责**应用**，不回报、也不下发指令 ——
   * 指令始终由发起拖动的那一端发出，远端只做同步预览。
   */
  useEffect(() => {
    const onRemoteUi = (event: Event) => {
      const detail = ((event as CustomEvent).detail || {}) as { key?: string; payload?: unknown };
      applyingRemoteUiRef.current = true;
      try {
        if (detail.key === "drag") {
          handleDragTarget(detail.payload as CurvatureDistribution | null);
        } else if (detail.key === "tip" && detail.payload) {
          // 激活位由独立的 tipTargetActive 键决定，这里不擅自置 true ——
          // 否则"清空"时两个键会打架，最终状态取决于应用顺序。
          setDragTarget(null);
          setTipDraft(detail.payload as typeof tipDraft);
        } else if (detail.key === "tipTargetActive" && typeof detail.payload === "boolean") {
          setTipTargetActive(detail.payload);
        } else if (detail.key === "motor" && detail.payload) {
          setMotorDraft(detail.payload as typeof motorDraft);
        } else if (detail.key === "sensorDraft" && detail.payload) {
          setSensorDraft(detail.payload as typeof sensorDraft);
        } else if (detail.key === "pidDraft" && detail.payload) {
          setPidDraft(detail.payload as typeof pidDraft);
        } else if (detail.key === "cycleParams" && detail.payload) {
          const p = detail.payload as { low: number; high: number; target: number };
          setCycleLowThreshold(p.low);
          setCycleHighThreshold(p.high);
          setCycleTargetPosition(p.target);
        } else if (detail.key === "sensorThreshold" && typeof detail.payload === "number") {
          setSensorThreshold(detail.payload);
        } else if (detail.key === "tipDriftTolerance" && typeof detail.payload === "number") {
          setTipDriftToleranceMm(detail.payload);
        } else if (detail.key === "cycleLifeEnabled" && typeof detail.payload === "boolean") {
          setCycleLifeEnabled(detail.payload);
        } else if (detail.key === "activeControlEnabled" && typeof detail.payload === "boolean") {
          // 远端置位：只镜像显示，驱动方标记为 remote，本端不发 tick
          setActiveControlEnabled(detail.payload);
          setControlEnabledBy(detail.payload ? "remote" : null);
        } else if (detail.key === "dragEnabled" && typeof detail.payload === "boolean") {
          // 先开开关再给目标，顺序反了的话预览会被 enabled=false 挡掉一帧
          setDragEnabled(detail.payload);
          if (!detail.payload) setDragTarget(null);
        } else if (detail.key === "lockTipPose" && typeof detail.payload === "boolean") {
          setLockTipPose(detail.payload);
        }
      } finally {
        applyingRemoteUiRef.current = false;
      }
    };
    window.addEventListener("softui:remote-ui", onRemoteUi);
    return () => window.removeEventListener("softui:remote-ui", onRemoteUi);
  }, [handleDragTarget]);

  const runSystemControl = useCallback(async (action: SystemControlAction) => {
    if (action === "disable" || action === "emergencyStop") {
      setActiveControlEnabled(false);
      setCycleLifeEnabled(false);
    }
    try {
      await onSystemControl(action);
      setCommandStatus({ tone: "ok", message: action === "enable" ? "系统已使能" : action === "disable" ? "系统已失能" : "紧急停止已发送" });
    } catch (err) {
      setCommandStatus({ tone: "error", message: errorText(err) });
    }
  }, [onSystemControl]);

  /**
   * 「拖动编辑」开关。
   *
   * 必须同步：三维编辑器是 `enabled={dragEnabled}`，没勾选就不渲染目标预览 ——
   * 所以手机端勾上了、电脑端没勾，电脑端即使收到拖动目标也不会显示，
   * 表现就是"拖了但对面没反应"。这是根因，不是传输问题。
   */
  const editDragEnabled = useCallback(
    (next: boolean) => {
      setDragEnabled(next);
      // 关掉编辑时一并清掉目标，视图立刻回到真实形状。
      if (!next) setDragTarget(null);
      publishUi("dragEnabled", next);
    },
    [publishUi],
  );

  /** 「固定末端位姿」开关，同样影响三维预览的语义，一并同步。 */
  const editLockTipPose = useCallback(
    (next: boolean) => {
      setLockTipPose(next);
      publishUi("lockTipPose", next);
    },
    [publishUi],
  );

  /** PID 三个参数：整份下发，避免差分漏帧导致对端错位。 */
  const applyPidDraft = useCallback(
    (next: typeof pidDraft) => {
      setPidDraft(next);
      publishUi("pidDraft", next);
    },
    [publishUi],
  );

  /** 循环寿命的三个参数，合成一个 key 一起发。 */
  const editCycleParams = useCallback(
    (patch: { low?: number; high?: number; target?: number }) => {
      const next = {
        low: patch.low ?? cycleLowThreshold,
        high: patch.high ?? cycleHighThreshold,
        target: patch.target ?? cycleTargetPosition,
      };
      if (patch.low !== undefined) setCycleLowThreshold(patch.low);
      if (patch.high !== undefined) setCycleHighThreshold(patch.high);
      if (patch.target !== undefined) setCycleTargetPosition(patch.target);
      publishUi("cycleParams", next);
    },
    [cycleLowThreshold, cycleHighThreshold, cycleTargetPosition, publishUi],
  );

  const editSensorThreshold = useCallback(
    (next: number) => {
      setSensorThreshold(next);
      publishUi("sensorThreshold", next);
    },
    [publishUi],
  );

  const editTipDriftTolerance = useCallback(
    (next: number) => {
      setTipDriftToleranceMm(next);
      publishUi("tipDriftTolerance", next);
    },
    [publishUi],
  );

  const editCycleLifeEnabled = useCallback(
    (next: boolean) => {
      editCycleLifeEnabled(next);
      publishUi("cycleLifeEnabled", next);
    },
    [publishUi],
  );

  /** 「启动控制系统」：本端开启时由本端驱动 tick，远端只镜像。 */
  const editActiveControl = useCallback(
    (next: boolean) => {
      editActiveControl(next);
      setControlEnabledBy(next ? "local" : null);
      publishUi("activeControlEnabled", next);
    },
    [publishUi],
  );

  /**
   * 压力传感器校准草稿（传感器 ID + 校准值）。
   *
   * 压力实时数据表本身是服务端共享数据，本来就同步；缺的是这张卡上的**输入**，
   * 它原来只存在本端 state 里，别的端看到的校准参数是旧的。
   */
  const editSensorDraft = useCallback(
    (patch: Partial<typeof sensorDraft>) => {
      const next = { ...sensorDraft, ...patch };
      setSensorDraft(next);
      publishUi("sensorDraft", next);
    },
    [sensorDraft, publishUi],
  );

  /** 电机草稿改值：本端改完广播；别的端只同步显示，不下发指令。 */
  const editMotorDraft = useCallback(
    (patch: Partial<MotorCommandDraft>) => {
      const next = { ...motorDraft, ...patch };
      setMotorDraft(next);
      publishUi("motor", next);
    },
    [motorDraft, publishUi],
  );

  const runMotorCommand = useCallback(async (command: MotorCommandDraft, message = "电机命令已发送") => {
    if (!requireSystemEnabled("电机命令")) return;
    try {
      await onSendMotor(command);
      setCommandStatus({ tone: "ok", message });
    } catch (err) {
      setCommandStatus({ tone: "error", message: errorText(err) });
    }
  }, [onSendMotor, requireSystemEnabled]);

  const runWorkspaceCommand = useCallback(async (command: WorkspaceCommand, payload?: WorkspaceCommandPayload, message = "命令已发送") => {
    const motionLabel = WORKSPACE_COMMAND_LABELS[command];
    if (motionLabel && !requireSystemEnabled(motionLabel)) return;
    try {
      await onWorkspaceCommand(command, payload);
      setCommandStatus({ tone: "ok", message });
    } catch (err) {
      setCommandStatus({ tone: "error", message: errorText(err) });
    }
  }, [onWorkspaceCommand, requireSystemEnabled]);

  /**
   * 下发当前的**目标**形状（拖动或末端位姿反解产生的）。
   *
   * 统一走**位姿表**：把 12 段分布积分成末端位姿（6 维白化键）→ 命中样本的 6 个 ΔL
   * 用 0x04 多电机同步帧发出。拖动 / 末端位姿两条入口因此是同一量纲、同一个键。
   */
  const sendTarget = useCallback(() => {
    if (!targetDistribution) return;
    if (!requireSystemEnabled("按此曲率下发")) return;
    const source = dragTarget ? "三维拖动" : "末端位姿";
    // 12 段目标分布 → **真实末端位姿** → 走位姿表（6 维键）。
    //
    // 为什么不走原来的曲率键：`send_curvature_command` 用的是 κ 表 4 维键
    // `[mean(κx,κy)|前半段, mean(κx,κy)|后半段]`，那是把连续 κ(s) 对半求均值，
    // 段内形状直接丢掉；位姿表是 6 维键，且返回的 6 个 ΔL 对应表里那条真实形状。
    const tip = tipPoseOfDistribution(targetDistribution.segments);
    const positionMm: [number, number, number] = [
      tip.positionM[0] * 1000,
      tip.positionM[1] * 1000,
      tip.positionM[2] * 1000,
    ];
    // 解不可达时把残差一起报出来 —— 操作员按下去的是一条真的会驱动电机的命令，
    // 必须知道他拿到的不是他要的那个点。
    const clampedNote = targetClamped
      ? `；注意：目标峰值曲率超过模型上限 ${modelKappaLimit.toFixed(2)} 1/m，已按上限钳制后下发`
      : "";
    void (async () => {
      try {
        const shape = await lookupTipPoseShape(positionMm, tip.rpyRad);
        if (!shape.covered) {
          setCommandStatus({
            tone: "warn",
            message:
              `目标形状的末端位姿超出位姿表覆盖范围（最近邻 ${shape.nearestDistance.toFixed(2)}），未下发。` +
              `请把目标拖小一点，或改用「按位姿下发」指定表内可达的位姿。`,
          });
          return;
        }
        await sendTipPoseCommand(positionMm, tip.rpyRad, {
          deviceId: snapshot.live.selectedDeviceId,
        });
        setCommandStatus({
          tone: "ok",
          message:
            `已下发（${source} → 位姿表 6 维键，末端 ${positionMm.map((v) => v.toFixed(0)).join("/")} mm，` +
            `最近邻 ${shape.nearestDistance.toFixed(2)}）${clampedNote}`,
        });
      } catch (err) {
        setCommandStatus({
          tone: "error",
          message: `按此曲率下发失败：${errorText(err)}`,
        });
      }
    })();
  }, [
    targetDistribution,
    dragTarget,
    targetClamped,
    modelKappaLimit,
    snapshot.live.selectedDeviceId,
    requireSystemEnabled,
  ]);

  /**
   * 末端位姿**直接走全阶 Cosserat 位姿查表**下发（0x04）。
   *
   * 与「按此曲率下发」的区别：这里把位姿本身交给后端查表，
   * 不再先在前端做 PCC 反解折成两段曲率。
   */
  const sendTipPoseToTable = useCallback(() => {
    if (!requireSystemEnabled("按位姿下发")) return;
    if (tableShape && !tableShape.covered) {
      setCommandStatus({ tone: "warn", message: "超出可达空间范围：该位姿不在全阶 Cosserat 表的覆盖内" });
      return;
    }
    const warn = "";
    void (async () => {
      try {
        await sendTipPoseCommand(
          [tipDraft.x, tipDraft.y, tipDraft.z],
          [tipDraft.roll * DEG2RAD, tipDraft.pitch * DEG2RAD, tipDraft.yaw * DEG2RAD],
          { deviceId: snapshot.live.selectedDeviceId },
        );
        setCommandStatus({
          tone: "ok",
          message: `已按位姿下发（全阶 Cosserat 位姿查表，x=${tipDraft.x} y=${tipDraft.y} z=${tipDraft.z}）${warn}`,
        });
      } catch (err) {
        setCommandStatus({
          tone: "error",
          message: `按位姿下发失败：${errorText(err)}`,
        });
      }
    })();
  }, [tipDraft, tableShape, snapshot.live.selectedDeviceId, requireSystemEnabled]);

  /**
   * 卡片上的**唯一下发入口**（「按位姿下发」按钮）。
   *
   * - 拖动模式（`dragTarget` 有值）：目标形状是 12 段分布 → 积分出末端位姿 → 查位姿表下发。
   * - 位姿模式：目标就是输入框里的 `tipDraft` → 直接按它查表下发，省掉「分布 → 位姿」这次多余重投影。
   *
   * 两条路最终都是「位姿表 6 维键 → 6 个 ΔL → 0x04 帧」，所以只需要一个按钮。
   */
  const dispatchTarget = useCallback(() => {
    if (dragTarget) {
      sendTarget();
      return;
    }
    sendTipPoseToTable();
  }, [dragTarget, sendTarget, sendTipPoseToTable]);

  // 主动控制：开启后每 200ms 发一次 tick，直到失能或手动停止。
  useEffect(() => {
    // 只有本端开启时才驱动 tick；远端镜像来的 activeControlEnabled 不发 tick，
    // 否则两端各发一条 200ms tick，设备收到双份主动控制。
    if (!activeControlEnabled || controlEnabledBy !== "local" || !motionAllowed) return;
    runWorkspaceCommand("activeTick", undefined, "主动控制 tick 已发送");
    const timer = window.setInterval(() => {
      // tick 直接走 onWorkspaceCommand（不刷新 commandStatus，200ms 一条太吵）；
      // 失败（例如中途失能）只吞掉，不让未处理的 reject 冒到控制台。
      void Promise.resolve(onWorkspaceCommand("activeTick")).catch(() => undefined);
    }, 200);
    return () => window.clearInterval(timer);
  }, [activeControlEnabled, controlEnabledBy, motionAllowed, onWorkspaceCommand, runWorkspaceCommand, snapshot.live.selectedDeviceId]);

  useEffect(() => {
    if (activeControlEnabled && !motionAllowed) setActiveControlEnabled(false);
  }, [activeControlEnabled, motionAllowed]);

  // 循环寿命检测：压力反馈跨过阈值就换向，一个来回计一次。
  useEffect(() => {
    if (!cycleLifeEnabled || !motionAllowed || !latestFrame) return;
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
  }, [cycleHighThreshold, cycleLastTrigger, cycleLifeEnabled, cycleLowThreshold, cycleTargetPosition, motionAllowed, latestFrame, runMotorCommand]);

  const sensorMax = sensors.reduce((max, sensor) => Math.max(max, sensor.filtered[0]), 0);
  const sensorAlarmCount = sensors.filter((sensor) => sensor.filtered[0] >= sensorThreshold).length;

  // 监控卡片布局：拖动 / 缩放后由 useCardLayout 原地写盘，不走页面级状态。
  const { layout, commit: commitLayout } = useCardLayout(snapshot.authSession.username, "workspace-monitor");
  // 自动控制卡片布局：拖动 / 缩放后由 useCardLayout 原地写盘，不走页面级状态。
  const automaticLayout = useCardLayout(snapshot.authSession.username, "workspace-automatic");

  // 手动控制卡片布局。
  const manualLayout = useCardLayout(snapshot.authSession.username, "workspace-manual");

  const manualHeaderForCard = useCallback(
    (cardId: string) => {
      const meta = manualCardRegistry[cardId as ManualCardId];
      const Icon = meta.icon;
      // 3D 拖动卡片的标题栏右侧是「拖动编辑」开关。
      // 命令反馈（未使能警告 / 失败原因）统一走顶层横幅，不再挂到卡片标题栏。
      const action =
        cardId === "curvatureDrag" ? (
          <div className="curvature-drag-toggles">
            <label className="curvature-drag-toggle">
              <input
                type="checkbox"
                checked={dragEnabled}
                onChange={(event) => editDragEnabled(event.target.checked)}
              />
              <span>拖动编辑</span>
            </label>
            <label className="curvature-drag-toggle" title="打开后只改臂体形状，末端位置与姿态保持不变">
              <input
                type="checkbox"
                checked={lockTipPose}
                onChange={(event) => editLockTipPose(event.target.checked)}
              />
              <span>固定末端位姿</span>
            </label>
            {lockTipPose ? (
              <label className="curvature-drag-tolerance" title="末端漂移超过这个值就提示「形状已到极限」">
                <span>漂移阈值</span>
                <input
                  max={20}
                  min={0.2}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next)) editTipDriftTolerance(Math.min(20, Math.max(0.2, next)));
                  }}
                  step={0.5}
                  type="number"
                  value={tipDriftToleranceMm}
                />
                <span>mm</span>
              </label>
            ) : null}
          </div>
        ) : undefined;
      return { title: meta.title, icon: <Icon aria-hidden="true" size={17} />, action };
    },
    [dragEnabled, lockTipPose, tipDriftToleranceMm],
  );

  const automaticHeaderForCard = useCallback(
    (cardId: string) => {
      const meta = automaticCardRegistry[cardId as AutomaticCardId];
      const Icon = meta.icon;
      // 系统操作卡片的标题栏右侧挂命令状态徽标。
      const action =
        cardId === "systemControl" && commandStatus ? (
          <Badge tone={commandStatus.tone}>{commandStatus.message}</Badge>
        ) : undefined;
      return { title: meta.title, icon: <Icon aria-hidden="true" size={17} />, action };
    },
    [commandStatus],
  );

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
      systemControlAction={systemControlAction}
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
                onSensorThresholdChange: editSensorThreshold,
                curvatureSummary,
              })}
          />
        ) : null}

        {/* ---------- 实时数据 ---------- */}
        {activeTab === "live-data" ? (
          <div className="workspace-pane-grid live-data-pane">
            <WorkspaceCard
              title="电机实时数据"
              wide
              actions={<Badge tone={enableStateTone}>{enableStateLabel}</Badge>}
            >
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
            </WorkspaceCard>

            <WorkspaceCard title="压力传感器实时数据" wide>
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
            </WorkspaceCard>
          </div>
        ) : null}

        {/* ---------- 手动控制 ---------- */}
        {activeTab === "manual" ? (
          <CardGrid
            layout={manualLayout.layout}
            ariaLabel="手动控制卡片"
            layoutKey="workspace-manual"
            onLayoutChange={manualLayout.commit}
            draggableForCard={manualCardDraggable}
            bodyClassForCard={(cardId) => (cardId === "curvatureDrag" ? "manual-volume-panel" : undefined)}
            headerForCard={manualHeaderForCard}
            childrenForCard={(cardId) => {
              switch (cardId as ManualCardId) {
                case "modelPackage":
                  return (
                    <>
              <div className="workspace-action-row">
                <input
                  ref={modelFileRef}
                  type="file"
                  accept=".tdcrmodel"
                  style={{ display: "none" }}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void handleImportModel(file);
                    event.target.value = "";
                  }}
                />
                <button type="button" className="ghost-btn" onClick={() => modelFileRef.current?.click()}>
                  <span>导入模型包</span>
                </button>
                <button type="button" className="ghost-btn" onClick={() => void handleResetModel()}
                  disabled={modelStatus?.source !== "imported"}>
                  <span>恢复内置模型</span>
                </button>
              </div>
              <p className="curvature-drag-note">
                当前模型：
                {modelStatus
                  ? (modelStatus.source === "imported"
                      ? `${modelStatus.name ?? "已导入"} · ${modelStatus.summary}`
                      : `内置默认 · ${modelStatus.summary}`)
                  : "加载中…"}
              </p>
                    </>
                  );
                case "curvatureDrag":
                  return (
                    <>
              <CurvatureDragPreview
                actual={backbone}
                // 预览显示的是**目标**分布：拖动与末端位姿反解是两个入口，
                // 但都落到 targetDistribution 上，3D 视图与下发永远一致。
                target={targetDistribution}
                enabled={dragEnabled}
                lockTipPose={lockTipPose}
                tipDriftToleranceMm={tipDriftToleranceMm}
                onTargetChange={handleDragTarget}
              />
              <div className="curvature-summary">
                <div>
                  <span>目标末端位置 mm</span>
                  <div className="curvature-summary-fields">
                    {(["x", "y", "z"] as const).map((key) => (
                      <input
                        aria-label={`末端位置 ${key.toUpperCase()} (mm)`}
                        key={key}
                        onChange={(event) => editTipDraft(key, Number(event.target.value))}
                        step={1}
                        title={`${key.toUpperCase()} mm`}
                        type="number"
                        value={tipDraft[key]}
                      />
                    ))}
                  </div>
                </div>
                <div>
                  <span>目标末端姿态（°）</span>
                  <div className="curvature-summary-fields">
                    {(["roll", "pitch", "yaw"] as const).map((key) => (
                      <input
                        aria-label={`末端姿态 ${key} (°)`}
                        key={key}
                        onChange={(event) => editTipDraft(key, Number(event.target.value))}
                        step={0.5}
                        title={`${key} °`}
                        type="number"
                        value={tipDraft[key]}
                      />
                    ))}
                  </div>
                </div>
                <div>
                  <span>沿臂峰值曲率</span>
                  <strong
                    className={peakCurvature > modelKappaLimit - 1e-9 ? "is-warn" : undefined}
                    title={`当前模型 κ 表上限 ${modelKappaLimit.toFixed(2)} 1/m（来自模型包）；拖动与反解都已按它钳制`}
                  >
                    {peakCurvature.toFixed(2)} 1/m（上限 {modelKappaLimit.toFixed(2)}）
                  </strong>
                </div>
              </div>
              {tipTargetActive && !dragTarget ? (
                /* 位姿模式才显示查表结果：拖动模式下 tableShape 查的是 tipDraft，
                   与拖动目标不是一回事，显示出来会误导；清空后也不该再显示残留结果。 */
                <div className="tip-pose-result">
                  <div>
                    <span>全阶查表</span>
                    <strong className={tableShape?.covered ? undefined : "is-warn"}>
                      {tableShape
                        ? (tableShape.covered
                            ? `命中表点（${tableShape.nearestDistance.toFixed(0)}）`
                            : "超出可达空间范围")
                        : "查询中…"}
                    </strong>
                  </div>
                  <div>
                    <span>最近表点距离</span>
                    <strong className={tableShape?.covered ? undefined : "is-warn"}>
                      {tableShape ? tableShape.nearestDistance.toFixed(0) : "--"}
                    </strong>
                  </div>
                  <div>
                    <span>查表峰值曲率</span>
                    <strong>
                      {tableShape && tableShape.kappaAbsPerM.length > 0
                        ? `${Math.max(...tableShape.kappaAbsPerM).toFixed(2)} 1/m`
                        : "--"}
                    </strong>
                  </div>
                  {tableShape && !tableShape.covered ? (
                    <p className="curvature-drag-note is-warn">
                      超出可达空间范围：该位姿不在全阶 Cosserat 表的覆盖内，3D 视图不显示目标骨架
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="curvature-drag-actions">
                <div className="workspace-action-row">
                  <button type="button" className={blockedClass("primary-btn")} disabled={!targetDistribution}
                    title={blockedHint("按位姿下发")}
                    onClick={dispatchTarget}>
                    <ArrowRightLeft size={15} /><span>按位姿下发</span>
                  </button>
                  <button type="button" className="ghost-btn" disabled={!targetDistribution}
                    onClick={clearTargets}>
                    <span>清空目标</span>
                  </button>
                </div>
              </div>

              <p className="curvature-drag-note">
                两种输入等效：三维拖动（需打开「拖动编辑」）或直接改「目标末端位姿」。
                下发走位姿表 6 维键，运动范围上限 {modelKappaLimit.toFixed(2)} 1/m（来自当前模型包的 κ 表）。
              </p>
                    </>
                  );
                case "motorControl":
                  return (
                    <>
              <div className="workspace-form-grid workspace-form-grid-motor">
                <label className="workspace-field">
                  <span>电机 ID</span>
                  <select value={motorDraft.motorId} onChange={(event) => editMotorDraft({ motorId: Number(event.target.value) })}>
                    {motors.map((motor) => <option key={motor.id} value={motor.id}>{motor.id}</option>)}
                  </select>
                </label>
                <label className="workspace-field">
                  <span>位移 mm</span>
                  <input type="number" min={-80} max={80} step={0.1} value={motorDraft.positionMm}
                    onChange={(event) => editMotorDraft({ positionMm: clamp(Number(event.target.value), -80, 80) })} />
                </label>
                <label className="workspace-field">
                  <span>速度 mm/s</span>
                  <input type="number" min={0} step={0.1} value={motorDraft.velocityMmPerSec}
                    onChange={(event) => editMotorDraft({ velocityMmPerSec: Number(event.target.value) })} />
                </label>
                <label className="workspace-field">
                  <span>加速度 mm/s²</span>
                  <input type="number" min={0} step={0.1} value={motorDraft.accelerationMmPerSec2}
                    onChange={(event) => editMotorDraft({ accelerationMmPerSec2: Number(event.target.value) })} />
                </label>
                <button type="button" className={blockedClass("primary-btn")}
                  title={blockedHint("发至电机")}
                  onClick={() => runMotorCommand(motorDraft)}>
                  <ArrowRightLeft size={15} /><span>发至电机</span>
                </button>
                <button type="button" className={blockedClass("ghost-btn")}
                  title={blockedHint("一键归中")}
                  onClick={() => runWorkspaceCommand("home", undefined, "已发送一键归中命令")}>
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
                    </>
                  );
                case "sensorMonitor":
                  return (
                    <>
              <div className="workspace-form-grid">
                <label className="workspace-field">
                  <span>压力传感器 ID</span>
                  <select value={sensorDraft.sensorId} onChange={(event) => editSensorDraft({ sensorId: Number(event.target.value) })}>
                    {sensors.map((sensor) => <option key={sensor.id} value={sensor.id}>{sensor.id}</option>)}
                  </select>
                </label>
                <label className="workspace-field">
                  <span>校准值 N</span>
                  <input type="number" step={0.01} value={sensorDraft.calibrationValue}
                    onChange={(event) => editSensorDraft({ calibrationValue: Number(event.target.value) })} />
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
                    </>
                  );
                default:
                  return null;
              }
            }}
          />
        ) : null}

        {/* ---------- 自动控制 ---------- */}
        {activeTab === "automatic" ? (
          <CardGrid
            layout={automaticLayout.layout}
            ariaLabel="自动控制卡片"
            layoutKey="workspace-automatic"
            onLayoutChange={automaticLayout.commit}
            draggableForCard={automaticCardDraggable}
            headerForCard={automaticHeaderForCard}
            childrenForCard={(cardId) => {
              switch (cardId as AutomaticCardId) {
                case "systemControl":
                  return (
                    <>
              <div className="automatic-status-grid">
                <div><span>连接状态</span><strong>{snapshot.connection.state}</strong></div>
                <div><span>使能状态</span><strong>{enableStateLabel}</strong></div>
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
                    </>
                  );
                case "pidControl":
                  return (
                    <>
              <div className="workspace-form-grid workspace-form-grid-pid">
                {(["kp", "ki", "kd"] as const).map((key) => (
                  <label className="workspace-field" key={key}>
                    <span>{key.toUpperCase()}</span>
                    <input type="number" step={0.01} value={pidDraft[key]}
                      onChange={(event) => applyPidDraft({ ...pidDraft, [key]: Number(event.target.value) })} />
                  </label>
                ))}
              </div>
              <div className="workspace-action-row">
                <button type="button"
                  className={`ghost-btn ${activeControlEnabled ? "active" : ""}`}
                  disabled={!motionAllowed}
                  onClick={() => {
                    const next = !activeControlEnabled;
                    setActiveControlEnabled(next);
                    notifyCommand(next ? "主动控制已开启，每 200ms 发送 tick" : "主动控制已停止", next ? "ok" : "warn");
                  }}>
                  <span>{activeControlEnabled ? "停止主动控制" : "主动控制"}</span>
                </button>
              </div>
                    </>
                  );
                case "cycleLife":
                  return (
                    <>
              <div className="workspace-form-grid workspace-form-grid-cycle">
                <label className="workspace-field"><span>低阈值</span>
                  <input type="number" step={0.1} value={cycleLowThreshold}
                    onChange={(event) => editCycleParams({ low: Number(event.target.value) })} />
                </label>
                <label className="workspace-field"><span>高阈值</span>
                  <input type="number" step={0.1} value={cycleHighThreshold}
                    onChange={(event) => editCycleParams({ high: Number(event.target.value) })} />
                </label>
                <label className="workspace-field"><span>伸出位移</span>
                  <input type="number" step={0.1} value={cycleTargetPosition}
                    onChange={(event) => editCycleParams({ target: Number(event.target.value) })} />
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
                  disabled={!motionAllowed}
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
                    </>
                  );
                default:
                  return null;
              }
            }}
          />
        ) : null}

        {/* ---------- 回放 ---------- */}
        {activeTab === "playback" ? (
          <div className="workspace-pane-grid playback-pane">
            <WorkspaceCard
              title="会话与回放"
              kicker="workspace"
              wide
              actions={<Badge tone={snapshot.playbackMode ? "info" : "neutral"}>{snapshot.playbackMode ? "回放中" : "实时"}</Badge>}
            >
              <div className="timeline">
                <div className="timeline-bar"><div className="timeline-fill" style={{ width: `${progress}%` }} /></div>
                <div className="timeline-meta">
                  <span>{isoFull(snapshot.playback.cursorMs)}</span>
                  <span>{snapshot.playback.speed.toFixed(1)}x</span>
                  <span>{snapshot.playback.durationMs / 1000}s</span>
                </div>
              </div>
              <div className="mini-info">当前会话：<strong>{activeSession?.name ?? "--"}</strong></div>
            </WorkspaceCard>

            <WorkspaceCard title="会话列表" kicker="workspace" wide>
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
            </WorkspaceCard>

            <WorkspaceCard title="最近日志" kicker="workspace" wide>
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
            </WorkspaceCard>
          </div>
        ) : null}
      </div>
    </WorkbenchLayout>
  );
}
