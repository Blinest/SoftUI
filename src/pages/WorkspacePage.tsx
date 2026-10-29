import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  Logs,
  PauseCircle,
  Play,
  SlidersHorizontal,
} from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";

import Badge from "../components/Badge";
import { CardGrid } from "../components/cards/CardGrid";
import { hasPermission, PERMISSION_REASON } from "../state/permissions";
import { DeviceContextPanel } from "../components/DeviceContextPanel";
import { WorkbenchLayout } from "../layouts/WorkbenchLayout";
import { monitorCardRegistry } from "./monitorCards";
import { automaticCardDraggable, automaticCardRegistry } from "./automaticCards";
import { manualCardDraggable, manualCardRegistry } from "./manualCards";
import { clamp, errorText, toneForLevel } from "../utils";
import type { SessionInfo } from "../softuiTypes";
import { gestureDistribution, type GestureBend } from "../robot/gestureCurvature";
import { useCardLayout } from "../state/layoutStore";
import {
  buildBackboneFromCurvatureDistribution,
  clampCurvatureDistribution,
  curvatureDistributionFromSnapshot,
  setModelCurvatureLimitByDirection,
  setModelCurvatureLimitPerM,
  summarizeBackbone,
  type CurvatureDistribution,
} from "../dynamics/svcModel";
import { CurvatureDragPreview } from "../robot/CurvatureDragPreview";
import { WorkspaceCard } from "../components/WorkspaceCard";
import { ModelLibraryDialog } from "../components/ModelLibraryDialog";
import { PolicyRulesCard } from "./PolicyRulesCard";
import { MotionLibraryCard } from "./MotionLibraryCard";
import { ShapeCalibrationCard } from "./ShapeCalibrationCard";
import { TendonIdentifyCard } from "./TendonIdentifyCard";
import {
  getCurrentActionName,
  getCurrentPlaybackTimes,
  getPlaybackOwner,
  hasCurrentPlayback,
  isCurrentPlaybackPaused,
  setCurrentActionName,
  setPlaybackOwner,
  stopActivePlayback,
  type PlaybackController,
  playMotion,
} from "../robot/motionPlayer";
import {
  advanceTimeline,
  createTimelineState,
  interruptHit,
  resumeTimeline,
  suspendTimeline,
  timelineProgress,
  type TimelineState,
} from "../robot/policyRunner";
import { baseDistributionFromModel } from "../robot/motionPlan";
import {
  clearPreviewOverride,
  getCurrentDisplacement,
  getPreviewOverride,
  getPlaybackDisplacementAt,
  getPlaybackDisplacementsLength,
  setPreviewOverride,
  setPreviewPath,
} from "../robot/previewOverride";
import { setAuthContext } from "../robot/uiStore";
import {
  appendPolicyLog,
  evaluateIntervalRules,
  evaluateTensionRules,
  tipForceFromSensors,
  readEngineEnabled,
  type IntervalMarks,
  type PolicyStoreLike,
  type TensionHistory,
} from "../robot/policyEngine";
import { directHome, directMultiMotor } from "../robot/directDispatch";
import { clearLocalTable, ensureLocalTable, hasLocalTable, lookupLocal } from "../robot/localTable";
import { PLAY_REQUEST_KEY, type PlayRequest } from "../robot/motionPlayer";
import {
  KAPPA_TABLE_COVERAGE_PER_M,
  lookupTipPoseShape,
  previewTipPoseCommand,
  sendMultiMotorCommand,
  sendTipPoseCommand,
  type TipPoseShapeLookup,
} from "../robot/curvatureBridge";
import { tipPoseOfDistribution } from "../robot/pose3d";
import { fetchModelPresets, fetchModelStatus, fetchShapeFromDisplacements, importModelFromFile, resetModel, selectModelPreset, type ModelPresetInfo, type ModelStatus, type TableShape } from "../robot/modelBridge";

/** 度 → 弧度（曲率方向换算用）。 */
const DEG2RAD = Math.PI / 180;

/**
 * 播完后**钉终点**的次数与间隔 ✓。
 *
 * ⚠ 别调密 ✗ —— 每条 0x04 多电机命令都会让电机**按自己的加减速重新起步** ✓，
 * 180ms 连钉 5 次 = 让它重启 5 次 ✓ → 始终走不完 → 结束差几毫米 ✗（实测 5mm ✓）。
 * 改成「发一次 → 等 1 秒 → 再确认一次」✓，给电机真正跑完的时间 ✓。
 */
const PLAYBACK_SETTLE_TIMES = 2;
const PLAYBACK_SETTLE_INTERVAL_MS = 1000;

/**
 * **下发节拍与单步上限** ✓ —— 顿挫的根治点 ✓。
 *
 * 一顿一顿的原因 ✗：每 250ms 才发一次 ✓，一跳就是 3~5mm ✗；
 * 而且每条 0x04 命令都会让电机**重新起步（加减速）** ✗ → 走走停停 ✓。
 *
 * 现在改成**小步连续推进** ✓：每 120ms 发一次 ✓，每次最多前进 1.2mm ✓
 * （≈ 上限 10mm/s ✓）。步长小 → 电机不用反复加速到高速再刹车 ✗，
 * 观感就是连续运动 ✓；目标始终取最新那帧 ✓ → 不积压 ✓、
 * 最终仍然精确收敛到终点 ✓。
 */
const PLAYBACK_TICK_MS = 200;

/**
 * **自适应放慢（时间拉伸）** ✓ —— 让 3D 等电机 ✓。
 *
 * 为什么需要 ✗：动作规划时长是按"末端速度"算的 ✓，但电机有物理上限 ✗。
 * 一味加快下发没用 ✓（实测滞后更明显 ✓），只会把队列和误差都拉大 ✗。
 *
 * 做法：每拍用**实测位置**算落后量 `max|目标−实际|` ✓
 *   - 落后 > 6mm → **暂停播放推进** ✓（3D 停在当前帧等 ✓）
 *   - 追到 < 2mm → 继续播 ✓
 * 效果：整条轨迹自动被"拉长"到电机跟得上的速度 ✓ —— 3D 与实机同步 ✓，
 * 不会出现"仿真播完了电机还在跑"✗，也不会越落越远 ✗。
 */
import type { AutomaticCardId, DeviceConnectionRecord, DeviceRuntimeStatusView, ManualCardId, MonitorCardId, RuntimeSnapshot, SerialPortDescriptor } from "../softuiTypes";
import "../styles/workspace.css";

export type WorkspaceTab = "monitor" | "manual" | "automatic" | "playback";
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
 * 控制有两路输入，最终都折算成「两段曲率 + 方向」才发出去：
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
  /** 真实录制会话 ✓（来自 list_sessions ✓，不是 snapshot 里那份 ✗）*/
  sessions: SessionInfo[];
  serialPorts: SerialPortDescriptor[];
  serialPortsError: string | null;
  connectedDevices: DeviceConnectionRecord[];
  deviceStatuses: Record<string, DeviceRuntimeStatusView>;
  connectionError: string | null;
  /** 打开连接对话框；可带上预选端口。 */
  onOpenConnectDialog: (portName?: string) => void;
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
  /**
   * 告诉外层"当前需要多快的实时刷新"。
   *
   * 实时数据页与控制页要**高刷**：拖动实时跟随要求反馈跟得上手，
   * 500ms 的通用节拍会让人以为臂体没动。其余页面按通用节拍即可，别白白多打 RPC。
   */
  onLiveFastChange?: (fast: boolean) => void;
}

const WORKSPACE_TABS: Array<{ key: WorkspaceTab; title: string; icon: typeof Activity }> = [
  { key: "monitor", title: "监控", icon: Activity },
  // 名称与图标按最新约定：控制 → 「控制」，参数调整 → 「参数调整」，
  // 两者**图标互换**（控制=暂停式圆形、参数调整=滑块）
  { key: "manual", title: "控制", icon: PauseCircle },
  { key: "automatic", title: "参数调整", icon: SlidersHorizontal },
  { key: "playback", title: "数据回放", icon: Play },
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
  home: "一键归零命令",
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
/** 回放时间轴用的**相对时间** ✓（`m:ss.d`，如 `01:23.4`）*/
function formatPlaybackClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "00:00.0";
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(1).padStart(4, "0")}`;
}

/**
 * **持久化的布尔开关** ✓ —— 切页签 / 刷新都不丢 ✓。
 *
 * 和 `CurvatureDragPreview` 里的同名 hook 等价 ✓，
 * 但那边把 `.tsx` 的内部函数 export 出来不值当 ✓，这里各写一份 ✓。
 */
function usePersistedFlag(storageKey: string, fallback = false): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      return raw == null ? fallback : raw === "1";
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, value ? "1" : "0");
    } catch {
      /* 忽略 ✓ */
    }
  }, [storageKey, value]);
  return [value, setValue];
}

/** `12345` → `12.3s` ✓；`0` → `0.0s` ✓ */
function formatSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

export function WorkspacePage({
  snapshot,
  sessions,
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
  onLiveFastChange,
}: WorkspacePageProps) {
  /* 权限门控只解决"看得见 / 点得动"，安全边界仍在后端。
   * 校准会改写传感器基线，属维护员（maintainer）职责，操作员不该有可用按钮。 */
  const canCalibrate = hasPermission(snapshot, "runCalibration");

  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const activeTab: WorkspaceTab = isWorkspaceTab(tabParam) ? tabParam : "monitor";
  /** 最新页签 ✓（播放轮询的 effect 依赖是 [] ✗ → 用 ref 读 ✓）*/
  const activeTabRef = useRef<WorkspaceTab>(activeTab);
  activeTabRef.current = activeTab;

  const [motorDraft, setMotorDraft] = useState<MotorCommandDraft>({
    motorId: 1,
    positionMm: 0,
    velocityMmPerSec: 2,
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
  /**
   * **模型算出来的、正在下发的 6 路电机目标位移**（mm）。
   *
   * 与状态帧里的 `motor.targetPositionMm` 是两回事：
   *   - `targetPositionMm` 是**设备自己上报**的目标（晚一个来回，且设备可能没照做）；
   *   - 这里是**我们刚刚发下去**的目标（位姿表查出来的 6 个 ΔL）。
   * 实时拖动时要看的是后者 —— 前者看不出发了什么。
   *
   * 由后端 `send_tip_pose_command` 的返回值带回来，不在前端重复查表：
   * 跟随是逐帧下发的，多一次 RPC 就多一次往返延迟。
   */
  const [commandedTargets, setCommandedTargets] = useState<number[] | null>(null);


  const motors = latestFrame?.motors ?? [];
  const sensors = latestFrame?.sensors ?? [];
  const selectedSensor = sensors.find((sensor) => sensor.id === sensorDraft.sensorId) ?? sensors[0];
  // 用**真实会话列表** ✓ —— `snapshot.playback.sessions` 是后端另一份数据 ✗，
  // 和「回放录制」页对不上 ✓（用户看到的"回放录制里没有、回放列表却有 2 条"✗）
  const activeSession = sessions.find((session) => session.id === snapshot.playback.activeSessionId) ?? sessions[0];
  const progress = clamp((snapshot.playback.cursorMs / Math.max(snapshot.playback.durationMs, 1)) * 100, 0, 100);
  const isSystemEnabled = latestFrame?.systemEnabled ?? false;
  /**
   * 是否允许下发运动指令 ✓。
   *
   * **本地意图优先，服务器状态帧只做对账** ✓：
   *   · 点「启动控制系统」→ 立刻视为已使能 ✓（不用等 RPC / 状态帧 ✓）
   *   · 点「停止控制 / 紧急停止」→ **立刻视为未使能** ✓
   *     （原来要等状态帧回写 `systemEnabled=false` ✓ → 网络一慢界面就还在"可动"✗，
   *      现场表现：点了失能还得等服务器反馈才真的禁用 ✓ 本 bug ✓）
   *   · 没点过任何系统按钮 → 以状态帧为准 ✓（兼容下位机不回写使能位的情形 ✓）
   *
   * 安全方向：失能**提前生效**是保守的 ✓ —— 宁可早一点认为"不可动"，
   * 也不能晚一点 ✗；真失败时 App 侧会回滚 `lastSystemControl` 并报错 ✓。
   */
  const motionAllowed =
    systemControlAction === "enable"
      ? true
      : systemControlAction === "disable" || systemControlAction === "emergencyStop"
        ? false
        : isSystemEnabled;

  // 模型推导（SDM）：**兜底用** —— 查表结果没回来时保证显示连续、不跳变。
  const sdmDistribution = useMemo(
    () => curvatureDistributionFromSnapshot(latestFrame, { basisSegmentCount: 12 }),
    [latestFrame],
  );

  /** 表驱动形状（12 节点 κ + 段长）。为主，因为它和实机同源。 */
  const [liveTableShape, setLiveTableShape] = useState<TableShape | null>(null);

  useEffect(() => {
    const frame = latestFrame;
    if (!frame || frame.motors.length === 0) {
      setLiveTableShape(null);
      return;
    }
    const displacementMm = frame.motors.map((motor) => motor.positionMm);
    if (displacementMm.some((value) => !Number.isFinite(value))) return;
    let cancelled = false;
    void fetchShapeFromDisplacements(displacementMm)
      .then((shape) => {
        if (!cancelled) setLiveTableShape(shape);
      })
      .catch(() => {
        // 查表失败 → 退回 SDM 兜底，界面不空、不跳
        if (!cancelled) setLiveTableShape(null);
      });
    return () => {
      cancelled = true;
    };
  }, [latestFrame]);

  /** 表 → 12 段曲率分布（段长由后端按模型给出，不写死）。 */
  const liveTableDistribution = useMemo<CurvatureDistribution | null>(() => {
    if (!liveTableShape || liveTableShape.kxPerM.length === 0) return null;
    const count = liveTableShape.kxPerM.length;
    const segmentMm = liveTableShape.segmentMm;
    return {
      totalLengthMm: segmentMm * count,
      basisSegmentCount: count,
      source: "deviceCurvature",
      segments: Array.from({ length: count }, (_, index) => {
        const kxPerM = liveTableShape.kxPerM[index] ?? 0;
        const kyPerM = liveTableShape.kyPerM[index] ?? 0;
        return {
          index,
          sStartMm: index * segmentMm,
          sEndMm: (index + 1) * segmentMm,
          sMidMm: (index + 0.5) * segmentMm,
          lengthMm: segmentMm,
          kxPerM,
          kyPerM,
          kappaAbsPerM: Math.hypot(kxPerM, kyPerM),
          phiRad: Math.atan2(kyPerM, kxPerM),
        };
      }),
    };
  }, [liveTableShape]);

  /** **表为主、SDM 兜底**：表保证和实机一致，SDM 保证帧间连续。 */
  /** 当前真实分布 ✓（播放要用它当结构模板 ✓）*/
  const curvatureDistributionRef = useRef<CurvatureDistribution | null>(null);
  // 把当前登录者告诉 uiStore ✓ —— 它据此决定"直传"还是"提交审批"✓
  setAuthContext(snapshot.authSession.username, snapshot.authSession.role);

  const curvatureDistribution = liveTableDistribution ?? sdmDistribution;
  // 每帧跟上最新分布 ✓（effect 闭包里的值会过期 ✗）
  curvatureDistributionRef.current = curvatureDistribution;
  const backbone = useMemo(() => buildBackboneFromCurvatureDistribution(curvatureDistribution), [curvatureDistribution]);
  const curvatureSummary = useMemo(() => summarizeBackbone(backbone), [backbone]);

  /**
   * 三维拖动控制的状态。
   *
   * `dragEnabled` 默认关闭：控制页是操作员高频使用的地方，进来就抢走
   * 左键会让「转视角」这件最常做的事变难。打开后左键才变成拖臂。
   *
   * `dragTarget` 只在拖动过程中非空。反解的基准始终是**当前实际分布**
   * （见 curvatureDrag 的说明），所以这里存的是一份**绝对**目标分布，
   * 不随新帧累积。清空它即可让 3D 视图回到真实形状。
   */
  // **持久化** ✓ —— 切页签 / 刷新不丢 ✓
  const [dragEnabled, setDragEnabled] = usePersistedFlag("softui.dragEnabled");
  const [dragTarget, setDragTarget] = useState<CurvatureDistribution | null>(null);
  /**
   * 拖动**实时跟随**：勾选后，拖动目标一变就下发一次位置指令，让臂体跟着手走。
   *
   * 只存本端、**不参与跨端同步**：真正写串口的是持有串口的那一端，这个开关属于
   * "这台机器要不要跟随"。而 `dragTarget` 本身是同步的，所以手机端拖动、电脑端跟随
   * 也能成立 —— 那正是需要的架构（只有拿着串口的那端能下发）。
   */
  const [dragFollowEnabled, setDragFollowEnabled] = useState(false);

  /**
   * 手势跟随：用摄像头识别到的**手指弯折**直接驱动臂体弯曲。
   *
   * 与「实时跟随」共用同一条下发泵（只发最新值、链路自动背压），手势只是
   * **换一个目标来源**。开启时**手势优先**，拖动不再参与 —— 两个来源同时活跃
   * 会互相抢，而"当前是哪个在控制"必须一眼看得出来。
   */
  const [gestureFollowEnabled, setGestureFollowEnabled] = useState(false);
  /** 摄像头每处理一帧回调一次；`null` = 未锁定（必须停发，不能沿用上一帧）。 */
  const [gestureBend, setGestureBend] = useState<GestureBend | null>(null);

  /**
   * 跟随的**实时状态**，就显示在「实时跟随」勾选框旁边。
   *
   * 为什么必须有：这条链路的失败原本**全是静默的** —— 没使能、还没拖动、位姿超界、
   * 串口写失败，在界面上长得一模一样（目标列都是 `--`）。看不到分别就只能靠猜。
   * 这是操作信息，不是调试信息：操作员需要知道"我拖了但它没跟"还是"它跟了"。
   */
  const [dragFollowState, setDragFollowState] = useState<{
    kind: "idle" | "waiting" | "sending" | "failed";
    sent: number;
    message?: string;
  }>({ kind: "idle", sent: 0 });

  /**
   * 拖动组件**实际交过来的目标次数**。
   *
   * 用来把"没反应"劈成两半：这个数不涨 = 拖动那一段根本没产出目标（拾取没命中 /
   * 阈值没过 / 指针事件没到画布）；这个数在涨而"已发帧数"不涨 = 目标有了但下发失败。
   * 没有这个数就只能靠猜 —— 上面那两种情况在界面上长得一模一样。
   */
  const [dragEmitCount, setDragEmitCount] = useState(0);

  /**
   * 本端最新一次**成功下发**拿到的目标值。远端同步的值**不覆盖**它。
   *
   * 为什么：同步槽位是共享的，别的端发过的 `null`（或某个从未下发过的端）会经由
   * UI 同步回灌到本端，把本端刚拿到的 6 个目标值冲掉 —— 现象就是状态行明明显示
   * "目标值 6 项"，实时数据表里却全是 `--`。本端自己发过就以本端为准。
   */
  const localTargetsRef = useRef<number[] | null>(null);

  /**
   * 实时数据表「目标 mm」列读这个值。
   *
   * **ref 是唯一真相**：它只由本端成功下发那一次写入，不参与任何同步，所以不会被
   * 远端槽位、失败分支或别处的 `setCommandedTargets(null)` 改写。
   * `commandedTargets` 这个 state 只保留作为**重渲染触发器** ——
   * 否则"值明明写进去了、表格读出来还是 null"这种事会一再发生（已经发生过两轮）。
   */
  const shownCommandedTargets = localTargetsRef.current ?? commandedTargets;



  /** 最近一次下发**实际拿到的目标值形状**（`6 项` / `无（undefined）`…），只用于显示。 */
  const [lastTargetsHint, setLastTargetsHint] = useState("尚未下发");

  /**
   * 实时数据 / 控制两页要求高刷，其余页面按通用节拍。
   *
   * 为什么这两页：控制页是**拖动实时跟随**发生的地方（要点下发、要看刀位跟上没有），
   * 实时数据页是看反馈的地方。500ms 的通用节拍在这里会明显滞后 ——
   * 设备本身 200ms 出一帧，再叠 500ms 轮询，显示就可能晚 700ms。
   */
  useEffect(() => {
    // 实时数据页已并入监控：这两页都要高刷（手动页是拖动跟随发生的地方）
    onLiveFastChange?.(activeTab === "monitor" || activeTab === "manual");
    return () => {
      onLiveFastChange?.(false);
    };
  }, [activeTab, onLiveFastChange]);

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
  const [lockTipPose, setLockTipPose] = usePersistedFlag("softui.lockTipPose");
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
  /** 后端内置的可选模型包（含 active 标记）。 */
  const [modelPresets, setModelPresets] = useState<ModelPresetInfo[]>([]);
  /**
   * 当前模型的曲率上限（1/m）——`model_status` 里由 κ 表覆盖范围扫出来的值。
   *
   * 拖动/反解/下发检查全部用它，不再用写死的上限；`setModelCurvatureLimitPerM` 同时在
   * `svcModel` 里生效（拖动反解内部读的是那份），这里的 state 只用于渲染阈值与文案。
   */
  const [modelKappaLimit, setModelKappaLimit] = useState(KAPPA_TABLE_COVERAGE_PER_M);
  /** 8 方向覆盖上限（后端给；老后端没有则为 null，回落到标量 ✓）。 */
  const [modelKappaByDirection, setModelKappaByDirection] = useState<number[] | null>(null);
  /**
   * 臂体**不染色** ✗ —— 试过按模型换色，但银灰金属本身很好看 ✓，
   * HSL 染色后会变"塑料感"✗。模型之间的区分交给：
   *   ① 臂长（445 / 400mm ✓）② 卡片上的模型摘要 ✓ ③ 3D 角标（后续）
   */
  const armAccent = null;

  /**
   * 表面质地：不同模型包用**金属感 / 哑光**区分 ✓。
   *
   * 用摘要做种子（确定性 ✓）：同一个模型永远同一种质地 ✓；
   * 换模型包 → 质地切换 ✓，一眼能分辨 ✓。
   */
  const armFinish = useMemo<"metal" | "matte">(() => {
    // ⚠ 原来用"哈希奇偶"决定质地 ✗ —— 两个模型**有 50% 概率撞到同一档** ✗，
    // 表现就是"切换模型颜色没变化"✗。
    // 改成按**臂长**决定 ✓：旧臂 445mm / 新臂 400mm，两者必然不同 ✓，
    // 且同一模型永远同一种质地 ✓（确定性 ✓）。
    const length = curvatureDistribution.totalLengthMm;
    return length > 420 ? "matte" : "metal";
  }, [curvatureDistribution.totalLengthMm]);

  // ── 策略执行引擎 ✓ ───────────────────────────────────────────
  /** 引擎总开关 ✓（默认关 ✗，避免一进页面就自动切模型 ✗）*/
  const [policyRunning, setPolicyRunning] = useState(() => readEngineEnabled());
  const policyMarksRef = useRef<IntervalMarks>({});
  const policyHistoryRef = useRef<TensionHistory>({});
  /** 最新快照 ✓（放 ref 里，避免 effect 依赖它而每秒重建 ✗）*/
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const readPolicyStore = (): PolicyStoreLike | null => {
    try {
      const raw = window.localStorage.getItem("softui:policySchemes");
      if (!raw) return null;
      const parsed = JSON.parse(raw) as PolicyStoreLike;
      return Array.isArray(parsed.schemes) ? parsed : null;
    } catch {
      return null;
    }
  };

  /** 执行一条命中 ✓：切模型 / 跑动作 ✓ */
  const executePolicyHit = useCallback(
    async (hit: { schemeName: string; rule: { id: string; note: string; targetKind?: string; targetModelId: string; targetActionId?: string }; reason: string }) => {
      const kind = hit.rule.targetKind ?? "model";
      const base = {
        id: `log-${Date.now()}-${hit.rule.id}`,
        at: new Date().toISOString(),
        schemeName: hit.schemeName,
        ruleNote: hit.rule.note || hit.reason,
        reason: hit.reason,
      };
      try {
        if (kind === "model") {
          const status = await selectModelPreset(hit.rule.targetModelId);
          applyModelStatus(status);
          appendPolicyLog({ ...base, target: `模型 ${hit.rule.targetModelId}`, ok: true });
        } else {
          // 动作：把它的落点写入目标分布 ✓（真正的时序播放下一步接 ✓）
          appendPolicyLog({
            ...base,
            target: `动作 ${hit.rule.targetActionId ?? "（未选择）"}`,
            ok: Boolean(hit.rule.targetActionId),
            error: hit.rule.targetActionId ? undefined : "规则没有选择动作",
          });
        }
      } catch (error) {
        appendPolicyLog({ ...base, target: kind, ok: false, error: String(error) });
      }
    },
    [],
  );

  // ── 动作播放 ✓ ───────────────────────────────────────────────
  /** 时间线要播放的动作 ✓（用 state 触发 ✓，不走 localStorage 中转 ✗）*/
  const [policyPlayRequest, setPolicyPlayRequest] = useState<PlayRequest | null>(null);


  /**
   * **播放动作名** ✓ —— 从 `motionPlayer` 读 ✗（原来是自己 state ✓，切页签就丢 ✗）。
   * 用一个 tick 让它能跟上模块变量的变化 ✓。
   */
  const [, setPlaybackTick] = useState(0);
  const playingAction = getCurrentActionName();
  /** **暂停状态也从模块读** ✗ —— 本地 `playbackPaused` 只在控制页按钮里更新 ✓，
   *  按钮搬到动作库后**没人改它** ✗ → 永远显示"正在播放"✗（本 bug ✓）。*/
  const playbackPaused = isCurrentPlaybackPaused();
  /** 当前 / 总时长 ✓ */
  const playbackTimes = getCurrentPlaybackTimes();
  // 🔊 诊断：看蓝条有没有跟着渲染
  if (typeof window !== "undefined") {
    (window as unknown as { __playingPaused?: boolean }).__playingPaused = playbackPaused;
  }
  useEffect(() => {
    const timer = window.setInterval(() => setPlaybackTick((n) => n + 1), 300);
    return () => window.clearInterval(timer);
  }, []);
  /** 诊断：最近一帧的 κ 最大值与进度 ✓（0 = 几乎平直 ✗）*/
  const [playbackInfo, setPlaybackInfo] = useState<{ maxKappa: number; progress: number } | null>(null);
  const frameCountRef = useRef(0);
  const stopPlaybackRef = useRef<PlaybackController | null>(null);

  /**
   * **动作组 / 动作播放时的下发泵** ✓ —— 勾了「实时跟随」才会真发 ✓。
   *
   * 为什么单独一条泵 ✗：播放的 6 路位移在播放开始时**已经批量算好**了 ✓，
   * 直接按帧发 ✓（`send_multi_motor_command` ✓），不必再按末端位姿查一次表 ✓。
   *
   * 三条约束（和拖动实时跟随同一套 ✓）：
   *   ① **只发最新一帧** ✓（在途就跳过 ✓，绝不排队 ✗）
   *   ② 未使能（`motionAllowed` 为假 ✓）**一帧都不发** ✓
   *   ③ 连续失败 5 次 → 自动关掉跟随 ✓ 并报一次 ✓，不刷屏 ✗
   *
   * ⚠ 用 ref 而不是 useCallback ✗：`onFrame` 是播放实例里的闭包 ✓，
   *   它拿不到最新的 state ✓ → 这里每次渲染刷新 ref ✓，闭包读 ref 就永远是最新值 ✓。
   */
  const playbackSendBusyRef = useRef(false);
  const playbackSendFailRef = useRef(0);
  const playbackPumpingRef = useRef(false);

  /** 「目标值」回执的广播节流 ✓ —— 12Hz 下发不必每帧都广播给其他端 ✗ */
  const lastTargetBroadcastRef = useRef(0);

  /** 真正发一帧 ✓（失败计数 ✓，失败 5 次自动关跟随并报一次 ✗不刷屏）*/
  const sendPlaybackDisplacement = async (displacement: number[], deviceId?: string) => {
    playbackSendBusyRef.current = true;
    try {
      /**
       * **动作组直发优先** ✓ —— `0x11` 是六路**绝对目标位移** ✓，幂等 ✓，
       * 直连串口写出去是 ms 级 ✓；成功就**不再转后端** ✗（转了设备会多收一帧 ✓）。
       * 本端没有串口（手机/远端）→ 返回 null → 自动回退走后端排队 ✓。
       */
      const directHex = directMultiMotor(displacement, 1);
      if (directHex) {
        playbackSendFailRef.current = 0;
        const now = performance.now();
        if (now - lastTargetBroadcastRef.current > 400) {
          lastTargetBroadcastRef.current = now;
          applyCommandedTargets(displacement);
        }
        void invoke("control_frame_log", {
          request: {
            deviceId: snapshot.live.selectedDeviceId,
            kind: "multi-motor",
            frameHex: directHex,
            action: null,
          },
        }).catch(() => undefined);
        return;
      }

      /**
       * **发送超时** ✓ —— 串口写挂住时不能让泵永远卡在这个 `await` 上 ✗。
       * 一旦卡住，`playbackPumpingRef` 永远是 true ✓ → 之后再也起不来泵 ✗
       * → 表现就是"指令再也发不出去" ✗（踩过两次 ✓）。
       */
      await Promise.race([
        sendMultiMotorCommand(displacement, { deviceId }),
        /**
         * ⚠ 超时从 4s 提到 **12s** ✗ —— 4s 会误报 ✓。
         *
         * 站点经 Cloudflare 隧道 ✓，单次 RPC 往返约 150~300ms ✓；
         * 同时还有 `fetch_live_window`(10Hz) / `webserial_push`(20Hz) /
         * `frame_ingest`(10Hz) 在跑 ✓ → 浏览器对同一域名只有 6 个并发连接 ✗ →
         * 我们的下发请求会**排队** ✓ → 4s 就报"串口无响应"是误判 ✗（现场现象 ✓）。
         */
        new Promise<never>((_, reject) =>
          window.setTimeout(() => reject(new Error("下发超时（请求排队超过 12s）")), 12000),
        ),
      ]);
      playbackSendFailRef.current = 0;
      /**
       * ⚠ **下发成功要更新「目标值」回执** ✗ —— 这是"动作组在跑、目标值却空着"的原因 ✓。
       *
       * `monitorCards` 的显示是 `playback ?? commandedTargets` ✓：
       *   · `playback` 读 `getCurrentDisplacement()`（播放器的逐帧值 ✓）
       *   · `commandedTargets` 只在**别的下发入口**（拖动跟随 / 单条命令）里更新 ✓，
       *     播放泵从来没写过它 ✗ → 播放路径一旦 `playback` 为空就整列 `--` ✗（本 bug ✓）。
       * 这里补上 ✓（节流 400ms ✓，免得 12Hz 广播刷爆同步槽 ✓）。
       */
      const now = performance.now();
      if (now - lastTargetBroadcastRef.current > 400) {
        lastTargetBroadcastRef.current = now;
        applyCommandedTargets(displacement);
      }
      // **回执可见** ✓ —— 「实时跟随」旁边的计数就是它 ✓
      setDragFollowState((prev) => ({ kind: "sending", sent: prev.sent + 1 }));
    } catch (error) {
      playbackSendFailRef.current += 1;
      setDragFollowState((prev) => ({
        kind: "failed",
        sent: prev.sent,
        message: errorText(error),
      }));
      if (playbackSendFailRef.current >= 15) {
        setDragFollowEnabled(false);
        setCommandStatus({
          tone: "warn",
          message: `动作组下发已停止：${errorText(error)}`,
        });
      }
    } finally {
      playbackSendBusyRef.current = false;
    }
  };
  /**
   * **只保留最新一帧** ✓ —— 不排队 ✗。
   *
   * 上一版用 `.then` 拼链（串行链 ✓），电机慢的时候帧全部堆在链尾 ✗ →
   * 仿真早播完了 ✓，队列里还有几十帧旧目标 ✗ → 电机按过期目标继续跑十几秒 ✗
   * （本次现象 ✓）。
   *
   * 现在：`latest` 槽 + 一个泵循环 ✓。新帧来了**覆盖**旧帧 ✓，
   * 在途那帧发完立刻取"此刻最新"的 ✓ → 延迟恒定 ✓、不积压 ✓。
   * 终点帧单独放 `final` 槽 ✓，保证一定发到 ✓。
   */
  /**
   * **下发泵：按「播放时钟」发插值位移** ✓。
   *
   * 之前三种做法都把轨迹改坏了：
   *   ① 最新帧覆盖 ✗ → 丢帧 → 轨迹被跳过 ✗
   *   ② 单步限幅 ✗ → 人为限速 → 越落越远 ✗
   *   ③ 落后就暂停播放 ✗ → **轨迹被拉长，不是想要的轨迹** ✗（用户明确否决 ✓）
   *
   * 现在以 `getCurrentPlaybackTimes().elapsedMs`（播放时钟 ✓，暂停时会停 ✓）为唯一基准 ✓：
   * 按 progress 在位移序列上**线性插值** ✓ → 每拍发一个严格对应时刻的位移 ✓。
   *   - **不丢帧** ✓（拍间位移由插值补齐 ✓）
   *   - **不改轨迹** ✓（时间轴 = 规划时长 ✓）
   *   - 暂停 / 恢复自动跟上 ✓（`elapsedMs` 自己会停 ✓）
   */
  const runPlaybackPump = () => {
    if (playbackPumpingRef.current) return;
    playbackPumpingRef.current = true;
    const deviceId = snapshot.live.selectedDeviceId;
    // **诊断**：泵启动时打一行，确认"动作组下发"这条链路有没有起来
    console.info("[playback-dispatch] 下发泵启动", {
      deviceId,
      totalMs: getCurrentPlaybackTimes().totalMs,
      displacementCount: getPlaybackDisplacementsLength(),
    });
    void (async () => {
      try {
        for (;;) {
          /**
           * **存活判据不能只看 `actionName`** ✗ —— 它会先于播放器被清掉 ✓
           * （蓝条自愈 / 统一收尾都会把它置 null ✓），
           * 而 `motionPlayer` 还在跑 ✓ → 泵误判"播完了"就退出 ✗ →
           * 目标值在变、指令却再也不发 ✓（本 bug ✓）。
           *
           * 现在：**控制器还在** 或 **播放时钟还没走完** 都算在播 ✓。
           */
          const times = getCurrentPlaybackTimes();
          const stillPlaying =
            hasCurrentPlayback() ||
            (times.totalMs > 0 && times.elapsedMs < times.totalMs - 30);
          if (!stillPlaying) {
            // **结束** → 补发一次终点 ✓ 然后收泵 ✓
            const count = getPlaybackDisplacementsLength();
            const last = count > 0 ? getPlaybackDisplacementAt(count - 1) : getCurrentDisplacement();
            if (last && last.length >= 6) await sendPlaybackDisplacement(last, deviceId);
            break;
          }

          const { totalMs, elapsedMs } = times;
          const count = getPlaybackDisplacementsLength();
          let target: number[] | null = null;

          if (totalMs > 0 && count > 0) {
            const progress = Math.min(1, Math.max(0, elapsedMs / totalMs));
            const position = progress * (count - 1);
            const index = Math.floor(position);
            const nextIndex = Math.min(count - 1, index + 1);
            const blend = position - index;
            const first = getPlaybackDisplacementAt(index);
            const second = getPlaybackDisplacementAt(nextIndex) ?? first;
            if (first && second && first.length >= 6 && second.length >= 6) {
              target = first.map((value, axis) => value + (second[axis] - value) * blend);
            }
          }

          /**
           * ⚠ **序列还没算出来也要发** ✗ —— 这是"电机完全不动"的死角 ✓。
           *
           * 播放开始时 6 路位移是**异步批量查表**算出来的 ✓（`preview_tip_pose_batch`），
           * 算回来之前 `playbackDisplacements` 是空的 ✓ → 上面那段一帧都取不到 ✗ →
           * 泵空转 ✓、电机纹丝不动 ✓，而且**界面上没有任何报错** ✗（本 bug ✓）。
           * 兜底：用播放器每帧写的**当前帧位移** ✓（`getCurrentDisplacement`）先顶上 ✓。
           */
          if (!target) {
            const fallback = getCurrentDisplacement();
            if (Array.isArray(fallback) && fallback.length >= 6) target = [...fallback];
          }

          if (target) await sendPlaybackDisplacement(target, deviceId);

          await new Promise<void>((resolve) => window.setTimeout(resolve, PLAYBACK_TICK_MS));
        }
      } finally {
        playbackPumpingRef.current = false;
      }
    })();
  };

  /**
   * `onFrame` 每帧调一次 ✓ —— 它只负责**启动泵** ✓。
   * 发什么由泵按**播放时钟**决定 ✓（不再由某一帧的位移决定 ✗，那会引入帧率抖动 ✓）。
   */
  const playbackDispatchRef = useRef<() => void>(() => {});
  let playbackDispatchWarned = false;
  playbackDispatchRef.current = () => {
    if (!dragFollowEnabled || !motionAllowed) {
      // **只提示一次** ✓ —— 免得每帧刷屏 ✗
      if (!playbackDispatchWarned) {
        playbackDispatchWarned = true;
        console.warn("[playback-dispatch] 不下发：", {
          dragFollowEnabled,
          motionAllowed,
        });
      }
      return;
    }
    runPlaybackPump();
  };

  /**
   * **播完把终点钉住** ✓ —— 补发终点帧若干次，等电机真的走到位 ✓。
   *
   * 为什么需要 ✗：电机从收到目标到走完要时间 ✓；最后一张命令若因串口背压
   * 或电机忙没吃进去 ✓，就会停在半路 ✗（实测差 6mm ✓）。
   * 位移指令**幂等** ✓（设的是绝对目标 ✓），重发同一帧安全 ✓。
   */
  const settlePlaybackTargetRef = useRef<() => void>(() => {});
  settlePlaybackTargetRef.current = () => {
    let tries = 0;
    const step = () => {
      // 期间用户又起播了 → 让新播放接管，别再钉旧终点 ✗
      if (getCurrentActionName()) return;
      if (tries >= PLAYBACK_SETTLE_TIMES) return;
      tries += 1;
      playbackDispatchRef.current();
      window.setTimeout(step, PLAYBACK_SETTLE_INTERVAL_MS);
    };
    window.setTimeout(step, PLAYBACK_SETTLE_INTERVAL_MS);
  };

  /**
   * **播放诊断探针** ✓ —— 控制台执行 `__SOFTUI_PLAYBACK__` 一把看全 ✓。
   *
   * 为什么要它 ✗：播放这条链有 7 个环节（请求 → 实例 → 时钟 → 位移序列 →
   * onFrame → 注入 → 下发泵 ✓），任何一环断了都表现为"什么都不动"✗，
   * 靠猜要猜很久 ✓。
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      (window as unknown as { __SOFTUI_PLAYBACK__?: unknown }).__SOFTUI_PLAYBACK__ = {
        actionName: getCurrentActionName(),
        hasController: hasCurrentPlayback(),
        paused: isCurrentPlaybackPaused(),
        times: getCurrentPlaybackTimes(),
        displacementCount: getPlaybackDisplacementsLength(),
        currentDisplacement: getCurrentDisplacement(),
        hasOverride: Boolean(getPreviewOverride()),
        dragFollowEnabled,
        motionAllowed,
        dragEnabled,
        activeTab,
        policyRunning,
        pumpRunning: playbackPumpingRef.current,
      };
    }, 500);
    return () => window.clearInterval(timer);
  }, [dragFollowEnabled, motionAllowed, dragEnabled, activeTab, policyRunning]);

  /**
   * **蓝条自愈** ✓ —— "名字还在、但其实没有播放"就清掉。
   *
   * 为什么需要 ✗：只要有任何一条路径把 `currentActionName` 写上了、却没走到
   * `onDone` / `stop()`（被顶掉的实例会**跳过**清理 ✓），蓝条就永久残留 ✗ ——
   * 表现是"动作早就停了，横幅还写着正在播放"✗（本 bug ✓）。
   * 这里每 500ms 校一次 ✓，正常播放时 `hasCurrentPlayback()` 为真 ✓ 不会被误清 ✓。
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!getCurrentActionName() || hasCurrentPlayback()) return;
      setCurrentActionName(null);
      setPlaybackTick((n) => n + 1);
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      let request: PlayRequest | null = null;
      try {
        const raw = window.localStorage.getItem(PLAY_REQUEST_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as PlayRequest & { requestedAt: number };
          // 只处理**新**请求 ✓（旧的每次都重放 ✗）
          // 窗口放到 60s ✓ —— 用户可能在参数调整页点播放 ✓，
          // 慢慢切到控制页 ✓，原来 3 秒就过期了 ✗。
          if (parsed && Date.now() - parsed.requestedAt < 60_000) request = parsed;
        }
      } catch {
        request = null;
      }
      if (!request) return;
      // **控制页没打开就不开始** ✓ —— 3D 场景还没挂载 ✓，
      // 播了没人看 ✗，而且播完会清掉注入 ✓ → 切回来就"播放了但没动"✗。
      // 请求留在 localStorage 里 ✓，等切到控制页再取 ✓。
      if (activeTabRef.current !== "manual") return;

      try {
        window.localStorage.removeItem(PLAY_REQUEST_KEY);
      } catch {
        /* 忽略 ✓ */
      }

      try {
        // **权威停止** ✓ —— 先清掉上一个实例的名字/位移/控制器 ✓，
        // 否则"上个动作停了、蓝条还写着它"✗（本 bug ✓）
        stopActivePlayback();
        setPlaybackOwner("manual");
        frameCountRef.current = 0;
        setCurrentActionName(request.actionName);
        setPlaybackInfo({ maxKappa: 0, progress: 0 });   // 立刻给个 0% ✓
      } catch (error) {
        console.error("[softui] 播放启动失败", error);
        setCurrentActionName(null);
        return;
      }
      // 用**真实分布**当结构模板 ✓
      // ⚠ 没有真实分布时（未连设备 / 还没收到帧 ✓）要**兜底** ✗ ——
      //   原来是静默 return ✓ → 横幅显示"正在播放"✓，但手臂不动、进度不走 ✗（本次 bug ✓）。
      const liveBase = curvatureDistributionRef.current;
      const base =
        liveBase && Array.isArray(liveBase.segments) && liveBase.segments.length > 0
          ? liveBase
          : baseDistributionFromModel({ totalLengthMm: request.totalLengthMm });
      // 轨迹线 ✓ —— 采样点的末端坐标（已是 three 系 ✓）
      setPreviewPath(
        request.samples.map((sample) => [sample.x, sample.y, sample.z] as [number, number, number]),
      );

      stopPlaybackRef.current = playMotion({
        samples: request.samples.map((sample) => ({ ...sample })),
        base,
        durationMs: request.durationMs,
        // 名字由实例自己写 ✓（避免"点动作二、蓝条写动作一"✗）
        actionName: request.actionName,
        onFrame: (distribution, progress) => {
          // ⚠ 每帧 setState 会以 60fps 触发重渲染 ✗ → 卡顿甚至白屏 ✗
          //   所以只**每 10 帧**更新一次诊断 ✓
          frameCountRef.current += 1;
          // **每 4 帧**更新一次进度 ✓（30fps → 约 7.5 次/秒 ✓，够顺滑又不卡 ✗）
          if (frameCountRef.current % 4 === 0) {
            const maxKappa = distribution.segments.reduce(
              (max, segment) => Math.max(max, segment.kappaAbsPerM),
              0,
            );
            setPlaybackInfo({ maxKappa, progress });
          }
          // **直接注入 3D** ✓（两跳 ✓）—— 不再走 handleDragTarget 的长链路 ✗
          setPreviewOverride(distribution);
          // **动作组下发** ✓ —— 勾了「实时跟随」才真的发 ✓（未使能时泵内部直接 return ✓）
          playbackDispatchRef.current();
        },
        onDone: () => {
          setCurrentActionName(null);
          /**
           * **钉住终点** ✓ —— 先补一帧 ✓，再重发几次让电机真的走到位 ✓。
           * 顺序很重要 ✗：必须**先清动作名** ✓，否则 `settle` 的守卫
           * （`getCurrentActionName()` 非空就当"新播放开始了"→ 退出 ✓）会把它自己挡掉 ✗。
           */
          playbackDispatchRef.current();
          settlePlaybackTargetRef.current();
          setPlaybackInfo(null);
          stopPlaybackRef.current = null;
          // ⚠ **不在这里 clear** ✗ ——
          //   原来播完就清 ✓，如果用户当时不在控制页 ✓，切回来 3D 拿到的是 null
          //   → "播放了但手臂不动"✗（本次 bug ✓）。
          //   保留最后一帧 ✓，下次播放开始时会覆盖 ✓；切走页签时清 ✓（见另一个 effect）。
        },
      });
    }, 600);
    return () => window.clearInterval(timer);
  }, []);

  /**
   * 离开控制页 → 清掉播放注入 ✓。
   *
   * 为什么在这里清 ✗：播完**不清**（保留最后一帧 ✓，见 onDone 注释）；
   * 但用户切到别的页签后 ✓，3D 已经不在了 ✓，注入留着没意义 ✓，
   * 下次进来不该看到"上次播完的画面"✗。
   */
  useEffect(() => {
    if (activeTab === "manual") return;
    // **播放中不清** ✗ —— 切走再回来，臂体应该还在动的姿态 ✓。
    //   原来无脑清 ✗ → `shown` 退回实际形状 ✓ → 末端几乎不动 ✓
    //   → 拖动累积的轨迹只有 2~3 个点 ✓ → **画出来是一条短线** ✗（本 bug ✓）。
    if (getCurrentActionName()) return;
    // ⚠ **拖动控制开着就保留** ✗ —— 实时跟随的理论形位就存在这个注入里 ✓，
    //   清掉的话监控页的"理论曲线"就永远是空的 ✓（`有理论: false` ✓ 本 bug ✓）。
    if (dragEnabled) return;
    clearPreviewOverride();
  }, [activeTab, dragEnabled]);

  /** 执行时间线里的一个片段 ✓ */
  const runTimelineBlock = useCallback(
    async (block: { kind: string; actionId?: string; modelId?: string; durationSec: number; note: string }) => {
      try {
        if (block.kind === "switch-model" && block.modelId) {
          const status = await selectModelPreset(block.modelId);
          applyModelStatus(status);
          appendPolicyLog({
            id: `log-${Date.now()}-block`,
            at: new Date().toISOString(),
            schemeName: "时间线",
            ruleNote: block.note || "切换模型",
            reason: `时间线片段（${block.durationSec}s）`,
            target: `模型 ${block.modelId}`,
            ok: true,
          });
          return;
        }
        if (block.kind === "action" && block.actionId) {
          // 从动作库读这条动作的**可行性缓存** ✓ 拿采样点 ✓
          const raw = window.localStorage.getItem("softui:motionActions");
          const actions = raw ? (JSON.parse(raw) as Array<{
            id: string;
            name: string;
            feasibility?: { models?: Array<{ ok: boolean; modelId: string; modelName: string; durationMs: number; samples?: Array<{ kx: number[]; ky: number[]; x: number; y: number; z: number }> }> } | null;
            plan?: { durationMs: number; samples?: Array<{ kx: number[]; ky: number[]; x: number; y: number; z: number }> } | null;
          }>) : [];
          const action = actions.find((item) => item.id === block.actionId);
          const hit = action?.feasibility?.models?.find((m) => m.ok && m.samples?.length);
          const samples = hit?.samples ?? action?.plan?.samples;
          if (!action || !samples || samples.length === 0) {
            appendPolicyLog({
              id: `log-${Date.now()}-block`,
              at: new Date().toISOString(),
              schemeName: "时间线",
              ruleNote: block.note || "执行动作",
              reason: "采样点缺失（先做可行性检查）",
              target: `动作 ${block.actionId}`,
              ok: false,
              error: "没有可用的规划结果",
            });
            return;
          }
          const request = {
            actionId: action.id,
            actionName: action.name,
            modelId: hit?.modelId ?? "",
            modelName: hit?.modelName ?? "",
            durationMs: hit?.durationMs ?? action.plan?.durationMs ?? block.durationSec * 1000,
            samples,
            totalLengthMm: curvatureDistributionRef.current?.totalLengthMm ?? 400,
            requestedAt: Date.now(),
          };
          // **直接触发播放** ✓ —— 原来只写 localStorage ✓，
          // 依赖另一个 600ms 轮询去取 ✓，中间任何一环断了就"显示在跑、臂不动"✗。
          setPolicyPlayRequest(request as PlayRequest);
          appendPolicyLog({
            id: `log-${Date.now()}-block`,
            at: new Date().toISOString(),
            schemeName: "时间线",
            ruleNote: block.note || "执行动作",
            reason: `时间线片段（${block.durationSec}s）`,
            target: `动作 ${action.name}`,
            ok: true,
          });
        }
      } catch (error) {
        console.error("[softui] 时间线片段执行失败", error);
      }
    },
    [],
  );

  /**
   * 时间线请求的动作 → **直接启动播放** ✓
   * （和「动作库点播放」共用同一段逻辑 ✓，不再靠 localStorage 中转 ✗）
   *
   * ⚠ **引擎已经关掉就丢掉这个请求** ✗ —— 关引擎前时间线可能刚好触发过一次 ✓，
   *   这个 state 是异步落地的 ✓ → 会在用户手动点播放**之后**才起播 ✗ →
   *   把他刚点的动作顶掉 ✓，蓝条变成上一个动作 ✗，被顶掉的实例结束时又跳过清理 ✗
   *   → **蓝条残留**✗（本 bug ✓）。
   */
  useEffect(() => {
    if (!policyPlayRequest) return;
    setPolicyPlayRequest(null);
    if (!readEngineEnabled()) return;
    const request = policyPlayRequest;
    try {
      stopActivePlayback();
      setPlaybackOwner("policy");
      frameCountRef.current = 0;
      setCurrentActionName(request.actionName);
      setPlaybackInfo({ maxKappa: 0, progress: 0 });
    } catch {
      return;
    }
    const liveBase = curvatureDistributionRef.current;
    const base =
      liveBase && Array.isArray(liveBase.segments) && liveBase.segments.length > 0
        ? liveBase
        : baseDistributionFromModel({ totalLengthMm: request.totalLengthMm });
    setPreviewPath(
      request.samples.map((sample) => [sample.x, sample.y, sample.z] as [number, number, number]),
    );
    stopPlaybackRef.current = playMotion({
      samples: request.samples.map((sample) => ({ ...sample })),
      base,
      durationMs: request.durationMs,
      actionName: request.actionName,
      onFrame: (distribution, progress) => {
        frameCountRef.current += 1;
        if (frameCountRef.current % 4 === 0) {
          setPlaybackInfo({ maxKappa: 0, progress });
        }
        setPreviewOverride(distribution);
        // **动作组下发** ✓（时间线走的是这条 onFrame ✓）
        playbackDispatchRef.current();
      },
      onDone: () => {
        setCurrentActionName(null);
        // **钉住终点** ✓（时间线这条同样要 ✓，否则每段都短几毫米 ✗）
        playbackDispatchRef.current();
        settlePlaybackTargetRef.current();
        setPlaybackInfo(null);
        stopPlaybackRef.current = null;
      },
    });
  }, [policyPlayRequest]);

  // ── 策略时间线执行 ✓ ────────────────────────────────────────

  /** 中断判定用的张力窗口 ✓ */
  const interruptSamplesRef = useRef<Array<{ at: number; n: number }>>([]);
  /** 恢复定时器 ✓ */
  const resumeTimerRef = useRef(0);

  /** 时间线状态 ✓（跨 tick 保留 ✓）*/
  const timelineRef = useRef<TimelineState | null>(null);
  /** 给臂体控制显示用 ✓ */
  const [timelineInfo, setTimelineInfo] = useState<{
    index: number;
    elapsedSec: number;
    totalSec: number;
    label: string;
  } | null>(null);

  /**
   * **中断判定：每 200ms 一次** ✓（原来跟着 1s 心跳 ✗）。
   *
   * 为什么必须更快 ✗：窗口填 500ms 时 ✓，1 秒才采一次样 ✓
   * → 只能拿到 1~2 个点 ✓ → `interruptHit` 要求 ≥ 3 点 ✗ → **永远不触发** ✗。
   * 200ms 采样下 ✓，500ms 窗口能拿到 ~3 个点 ✓，够判定 ✓。
   */
  useEffect(() => {
    if (!policyRunning) return;
    const timer = window.setInterval(() => {
      const store = readPolicyStore();
      if (!store) return;
      const active = store.schemes.find((item) => item.id === store.activeId);
      const interrupts = (active as { interrupts?: Array<{
        enabled: boolean;
        thresholdN: number;
        windowMs: number;
        targetKind: "model" | "action";
        targetId: string;
        resume: boolean;
        note: string;
      }> } | undefined)?.interrupts ?? [];
      if (interrupts.length === 0) return;

      const now = Date.now();
      // 采样（带时间戳 ✓），只留最近 60 秒 ✓
      const tipForce = tipForceFromSensors(snapshotRef.current.live.latest?.sensors ?? []);
      if (tipForce != null) interruptSamplesRef.current.push({ at: now, n: tipForce });
      interruptSamplesRef.current = interruptSamplesRef.current.filter(
        (sample) => now - sample.at <= 60_000,
      );

      const state = timelineRef.current;
      if (!state || state.suspended) return;

      for (const intr of interrupts) {
        const series = interruptSamplesRef.current
          .filter((sample) => now - sample.at <= Math.max(200, intr.windowMs))
          .map((sample) => sample.n);
        if (!interruptHit(intr, series)) continue;

        timelineRef.current = suspendTimeline(state, now);
        appendPolicyLog({
          id: `log-${now}-intr`,
          at: new Date().toISOString(),
          schemeName: "中断",
          ruleNote: intr.note || "张力陡增",
          reason: `窗口内张力变化 ≥ ${intr.thresholdN}N`,
          target: intr.targetKind === "model" ? `模型 ${intr.targetId}` : `动作 ${intr.targetId}`,
          ok: true,
        });
        void (async () => {
          try {
            if (intr.targetKind === "model") {
              const status = await selectModelPreset(intr.targetId);
              applyModelStatus(status);
            } else {
              await runTimelineBlock({
                kind: "action",
                actionId: intr.targetId,
                durationSec: 5,
                note: intr.note || "中断动作",
              });
            }
          } finally {
            if (intr.resume) {
              window.clearTimeout(resumeTimerRef.current);
              resumeTimerRef.current = window.setTimeout(() => {
                if (timelineRef.current) {
                  timelineRef.current = resumeTimeline(timelineRef.current, Date.now());
                }
              }, 5000);
            }
          }
        })();
        break;   // 一次只处理一个中断 ✓
      }
    }, 200);
    return () => window.clearInterval(timer);
  }, [policyRunning, runTimelineBlock]);

  /** 每 1s 求值一次 ✓（不用 setInterval 累加 ✗，用绝对时间比较 ✓）*/
  // 卡片里改了开关 → 这里跟上 ✓（storage 事件只在别的标签页触发 ✗，所以额外轮询 ✓）
  useEffect(() => {
    const timer = window.setInterval(() => {
      const enabled = readEngineEnabled();
      setPolicyRunning((prev) => (prev === enabled ? prev : enabled));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!policyRunning) return;
    const timer = window.setInterval(() => {
      const store = readPolicyStore();
      if (!store) return;
      const now = Date.now();
      const intervalEval = evaluateIntervalRules(store, now, policyMarksRef.current);
      policyMarksRef.current = intervalEval.nextMarks;
      for (const hit of intervalEval.hits) void executePolicyHit(hit);

      // 真实合成值 ✓（原来是 null ✗ → 张力规则永远不触发 ✗）
      const liveSensors = snapshotRef.current.live.latest?.sensors ?? [];
      const tipForce = tipForceFromSensors(liveSensors);
      const tensionEval = evaluateTensionRules(store, now, tipForce, policyHistoryRef.current);
      policyHistoryRef.current = tensionEval.nextHistory;
      for (const hit of tensionEval.hits) void executePolicyHit(hit);

      // ── **时间线推进** ✓ ────────────────────────────────────
      const active = store.schemes.find((item) => item.id === store.activeId);
      const blocks = active?.timeline ?? [];
      if (blocks.length > 0) {
        const state = timelineRef.current ?? createTimelineState(now);
        const { state: nextState, effect } = advanceTimeline(blocks, state, now);
        timelineRef.current = nextState;
        const progress = timelineProgress(blocks, nextState, now);
        const current = blocks[progress.index];
        setTimelineInfo({
          index: progress.index,
          elapsedSec: progress.elapsedSec,
          totalSec: progress.totalSec,
          label:
            current?.kind === "action"
              ? "执行动作"
              : current?.kind === "switch-model"
                ? "切换模型"
                : "等待",
        });
        if (effect.kind === "start-block") void runTimelineBlock(effect.block);
        if (effect.kind === "finish-timeline") {
          timelineRef.current = createTimelineState(Date.now());
        }
      } else {
        setTimelineInfo(null);
        timelineRef.current = null;
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [policyRunning, executePolicyHit]);

  /**
   * **引擎一停，时间线蓝条立刻收** ✓ —— 原来只在轮询里清 ✗。
   *
   * 上面那个 effect 是 `if (!policyRunning) return` ✓：引擎关掉后整个轮询
   * 直接不跑了 ✓ → **没有任何人把 `timelineInfo` 设回 `null`** ✗ →
   * 蓝条永久停在"▶ 时间线 N · …"，看起来像还在执行 ✗（本 bug ✓）。
   */
  useEffect(() => {
    if (policyRunning) return;
    setTimelineInfo(null);
    timelineRef.current = null;
    // **策略起播的那个动作也一起收** ✓ —— 引擎停了还挂在"正在播放"就是残留 ✗
    if (getPlaybackOwner() === "policy") stopActivePlayback();
  }, [policyRunning]);

  /** 模型库管理弹窗是否打开 ✓。 */
  const [modelLibraryOpen, setModelLibraryOpen] = useState(false);

  /** 按方位取上限：8 个方向之间线性插值（与 Rust 侧同一套规则 ✓）。 */
  const kappaLimitForDirection = (phiRad: number): number => {
    const table = modelKappaByDirection;
    if (!table || table.length !== 8) return modelKappaLimit;
    const twoPi = Math.PI * 2;
    let p = phiRad % twoPi;
    if (p < 0) p += twoPi;
    const scaled = (p / twoPi) * 8;
    const i = Math.floor(scaled) % 8;
    const j = (i + 1) % 8;
    const t = scaled - Math.floor(scaled);
    return table[i] * (1 - t) + table[j] * t;
  };


  /**
   * 手势弯折 → 12 段等曲率目标。
   *
   * 量程上限直接用 `modelKappaLimit`（**来自动力学模型**）—— 手势永远发不出
   * 模型不允许的曲率；真超了也只会被位姿表整帧拒掉。
   */
  const gestureTarget = useMemo(
    () =>
      gestureFollowEnabled
        ? gestureDistribution(gestureBend, {
            kappaLimitPerM: kappaLimitForDirection(gestureBend?.directionRad ?? 0),
            totalLengthMm: curvatureDistribution.totalLengthMm,
            segments: 12,
          })
        : null,
    [gestureFollowEnabled, gestureBend, modelKappaLimit, modelKappaByDirection, curvatureDistribution.totalLengthMm],
  );

  /** 下发泵的**目标来源**：手势优先，否则三维拖动。 */
  /**
   * **拖动跟随的末端限速** ✓ —— 单位 mm/s ✓。
   *
   * 为什么需要 ✗：`0x11` 多电机同步帧**只带目标位移、不带速度** ✓，
   * 速度完全由驱动器自己的参数决定 ✓ → 手一拖，电机就按驱动器速度冲过去 ✗。
   * 要在软件侧"降速"，只能控制**目标推进的速率** ✓：
   * 每 100ms 把目标朝手指位置推进最多 `2 × 0.1 = 0.2mm` ✓，
   * 等效末端速度就是 2mm/s ✓（末端位置 -> 查表 -> 六路位移 -> 直发 ✓）。
   *
   * 行为变化：臂体会**平滑地追着手指走** ✓，而不是瞬间跳到位 ✓；
   * 手指停住时目标不动，臂体继续按 2mm/s 逼近，直到到达 ✓。
   */
  const DRAG_FOLLOW_MAX_MM_PER_S = 2;
  const DRAG_FOLLOW_TICK_MS = 100;

  const followSource = gestureFollowEnabled ? gestureTarget : dragTarget;

  const modelFileRef = useRef<HTMLInputElement | null>(null);

  /** 模型状态到手就同步上限：换模型包（内置/导入）后 UI 运动范围跟着变。 */
  // 模型状态一变（导入 / 恢复 / 切换）就重拉预设列表，保证下拉的选中态是真的。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const presets = await fetchModelPresets();
        if (!cancelled) setModelPresets(presets);
      } catch {
        if (!cancelled) setModelPresets([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modelStatus]);

  const applyModelStatus = useCallback((status: ModelStatus) => {
    // **换模型 → 本地表必须作废** ✗（否则还在用旧表的位移 ✓）
    clearLocalTable();
    void ensureLocalTable();
    setModelStatus(status);
    if (Number.isFinite(status.kappaLimitPerM) && status.kappaLimitPerM > 0) {
      setModelKappaLimit(status.kappaLimitPerM);
      setModelKappaByDirection(status.kappaLimitByDirection ?? null);
      setModelCurvatureLimitByDirection(status.kappaLimitByDirection ?? null);
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
   * 用户点的是控制里的按钮，提示就必须出现在他视线所在的顶层，而不是散到各张卡片上。
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
      message: `${what}未下发：服务器尚未同步使能状态。请到「控制 → 系统操作」点「启动控制系统」后再试。`,
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
    motionAllowed ? undefined : `服务器未同步使能：点击「${label}」不会下发，请先到「控制 → 系统操作」启动控制系统`;

  /**
   * **状态标签只说"服务器同步到哪一步"** ✓ —— 不再声称"设备已使能" ✗。
   *
   * 为什么要改 ✗：上位机**无法确认下位机真的使能了** ✓（状态帧 `system_state`
   * 只有 0/1 ✓，而当前固件校验未对齐时连帧都收不到 ✓）。
   * 写"已使能"会让操作员以为设备已经在等指令 ✗ —— 这是歧义，也是安全隐患 ✓。
   * 统一表述为「服务器已同步：使能 / 失能」✓，实际能否动作由 `motionAllowed` 决定 ✓。
   */
  const enableStateLabel = systemControlAction === "emergencyStop"
    ? "急停锁定（服务器）"
    : systemControlAction === "disable"
      ? "服务器已同步：失能"
      : motionAllowed
        ? "服务器已同步：使能"
        : "未同步使能";

  /** 正在应用远端状态时为 true，用于掐断「本端 → 远端 → 本端」的回环。 */
  const applyingRemoteUiRef = useRef(false);

  /** 把本端 UI 状态广播给其它端。换一个 key 就能同步一种新状态，不用改传输层。 */
  const publishUi = useCallback((key: string, payload: unknown) => {
    if (applyingRemoteUiRef.current) return;
    window.dispatchEvent(new CustomEvent("softui:local-ui", { detail: { key, payload } }));
  }, []);

  /**
   * 记下"刚刚下发的 6 路目标"，**并广播给别端**。
   *
   * 目标值属于**共享事实**，不是本端私有状态：下发只发生在持有串口的那一端，
   * 而看数据的人可能在另一台机器上（实测就是"拖动端看得见、观看端永远是 --"）。
   * 走既有 UI 同步槽位，后端单槽转发 —— 所以它确实是"服务器传过来的"。
   */
  const applyCommandedTargets = useCallback(
    (targets: number[] | null) => {
      // 只有"真是 6 个数的数组"才算拿到了目标值；其余（undefined / 对象 / 空）一律当没有。
      // 同时把**实际拿到的形状**记下来并显示在状态行 —— 因为"后端没回这个字段"和
      // "还没下发过"在界面上长得完全一样，只看到一个 -- 分不出是哪一边空。
      const ok = Array.isArray(targets) && targets.length > 0;
      if (ok) localTargetsRef.current = targets as number[];
      setLastTargetsHint(
        ok ? `${targets!.length} 项` : `无（${targets === undefined ? "undefined" : Array.isArray(targets) ? "空数组" : typeof targets}）`,
      );
      setCommandedTargets(ok ? (targets as number[]) : null);
      publishUi("commandedTargets", ok ? targets : null);
    },
    [publishUi],
  );

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
    /**
     * ⚠ **拖动时立刻清掉播放注入** ✗ ——
     * 播放结束后我们**故意保留**最后一帧（`previewOverride` ✓），
     * 但那个注入会**盖住**拖动结果 ✓ → 拖了看不出变化 ✗
     * → 用户以为"拖不动"✓，切到别的页签（被动清掉注入 ✓）回来就好了 ✓（本 bug ✓）。
     */
    if (next) {
      // **拖动 = 理论形位** ✓ —— 曲线卡的"理论曲率"读它 ✓
      setPreviewOverride(next);
    } else {
      clearPreviewOverride();
    }
    // 只广播本端真实操作的拖动；应用远端来的值时不往回复发
    if (next) setDragEmitCount((n) => n + 1);
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
        } else if (detail.key === "commandedTargets") {
          // 别端下发的目标值（本端不产数据时也要显示得出来）。
          // **本端自己下发过就不接受远端值** —— 否则远端槽位里的 null 会把本端
          // 刚拿到的 6 个目标值冲掉，表现为"状态行有值、表格里是 --"。
          if (localTargetsRef.current) return;
          const next = detail.payload;
          setCommandedTargets(Array.isArray(next) ? (next as number[]) : null);
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
    // 挂载（或从别的页切回来）时补要一次：桩早早派发的那批事件在本组件挂载前就丢了
    window.dispatchEvent(new CustomEvent("softui:ui-resync"));
    return () => window.removeEventListener("softui:remote-ui", onRemoteUi);
  }, [handleDragTarget]);

  const runSystemControl = useCallback(async (action: SystemControlAction) => {
    if (action === "disable" || action === "emergencyStop") {
      setActiveControlEnabled(false);
      setCycleLifeEnabled(false);
    }
    try {
      await onSystemControl(action);
      setCommandStatus({
        tone: "ok",
        message:
          action === "enable"
            ? "服务器数据已同步（使能）"
            : action === "disable"
              ? "服务器数据已同步（失能）"
              : "紧急停止已发送（服务器已同步）",
      });
    } catch (err) {
      setCommandStatus({ tone: "error", message: errorText(err) });
    }
  }, [onSystemControl]);

  /**
   * 「拖动控制」开关。
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

  /**
   * 响应别端的重发请求：把本端全部 UI 状态再发布一遍。
   *
   * 同步槽位是纯内存的，网关重启即清空。新端加入时若后端已经空了，
   * 只有老端重新发布才能把状态补齐 —— 否则要手动碰每个控件才同步。
   */
  useEffect(() => {
    const onRepublish = () => {
      publishUi("drag", dragTarget);
      publishUi("dragEnabled", dragEnabled);
      publishUi("lockTipPose", lockTipPose);
      publishUi("tip", tipDraft);
      publishUi("tipTargetActive", tipTargetActive);
      publishUi("motor", motorDraft);
      publishUi("sensorDraft", sensorDraft);
      publishUi("pidDraft", pidDraft);
      publishUi("cycleParams", {
        low: cycleLowThreshold,
        high: cycleHighThreshold,
        target: cycleTargetPosition,
      });
      publishUi("sensorThreshold", sensorThreshold);
      publishUi("tipDriftTolerance", tipDriftToleranceMm);
      publishUi("cycleLifeEnabled", cycleLifeEnabled);
      publishUi("activeControlEnabled", activeControlEnabled);
    };
    window.addEventListener("softui:ui-republish", onRepublish);
    return () => window.removeEventListener("softui:ui-republish", onRepublish);
  }, [
    publishUi, dragTarget, dragEnabled, lockTipPose, tipDraft, tipTargetActive,
    motorDraft, sensorDraft, pidDraft, cycleLowThreshold, cycleHighThreshold,
    cycleTargetPosition, sensorThreshold, tipDriftToleranceMm, cycleLifeEnabled,
    activeControlEnabled,
  ]);

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
  /**
   * 电机参数改动 ✓。
   *
   * ⚠ 依赖数组里**不能放 `motorDraft`** ✗ —— 放进去的话每敲一个字符都会生成
   * 新回调 ✓ → 下游所有 `memo` 失效 ✓ → 整个 2258 行的 WorkspacePage 重渲染 ✗
   * → 输入卡顿 ✓（本次问题 ✓）。
   * 改成**从 ref 读最新值** ✓，回调身份永远稳定 ✓。
   */
  const motorDraftRef = useRef(motorDraft);
  motorDraftRef.current = motorDraft;

  const editMotorDraft = useCallback(
    (patch: Partial<MotorCommandDraft>) => {
      const next = { ...motorDraftRef.current, ...patch };
      setMotorDraft(next);
      publishUi("motor", next);
    },
    [publishUi],
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

    /**
     * **一键归零走本机直发** ✓ —— 归零是"六路目标位移 = 0"的绝对量 ✓，
     * 幂等 ✓，重复发无害 ✓，所以可以直发之后**再让后端记一份** ✓。
     * 直发在本端没有串口时返回 false ✓ → 自动回退走后端排队 ✓（手机/远端）✓。
     */
    const homeHex = command === "home" ? directHome(6, 1) : null;
    if (homeHex) {
      /**
       * **本机直发后不再转后端** ✓ —— 转一次等于让设备**再收一遍同样的帧** ✗。
       * 后端只做"记录不发送"的对账（`control_frame_log`）✓：
       * 更新状态 + 审计 + 会话录制 ✓，绝不碰串口 ✓。
       */
      setCommandStatus({ tone: "ok", message: "已直连串口下发" });
      void invoke("control_frame_log", {
        request: {
          deviceId: snapshot.live.selectedDeviceId,
          kind: "home",
          frameHex: homeHex,
          action: null,
        },
      }).catch((error: unknown) =>
        console.warn("[direct-dispatch] 后端对账失败（指令已发出）", error),
      );
      return;
    }

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
        /**
         * **曲率/位姿下发：查表仍走后端，发送走本机直发** ✓。
         *
         * 为什么不能全本地 ✗：位移表在后端 ✓（1.1MB，`interpolate_by_tip_mm` 也在后端 ✓）。
         * 但"发送"这一段完全可以本地化 ✓：拿到 6 路位移后直接写串口 ✓ →
         * 省掉一条 RPC 往返 + 排队 ✓（实测这条能省 200ms~十几秒 ✓）。
         */
        /**
         * **本地查表优先** ✓ —— 表已拉到前端时纯本地算位移 ✓（零 RPC ✓）；
         * 表还没加载好 → 回退后端 `preview_tip_pose_command` ✓（口径一致 ✓）。
         */
        let displacement: number[] | null = null;
        if (hasLocalTable() || (await ensureLocalTable())) {
          const local = lookupLocal(positionMm);
          if (local) {
            displacement = local.displacementMm;
          } else {
            setCommandStatus({
              tone: "warn",
              message:
                `目标位姿超出位姿表覆盖范围（本地最近邻超域），未下发。` +
                `请把目标拖小一点，或改用「按位姿下发」指定表内可达的位姿。`,
            });
            return;
          }
        }
        if (!displacement) {
          const preview = await previewTipPoseCommand(positionMm, tip.rpyRad, {
            deviceId: snapshot.live.selectedDeviceId,
          });
          displacement = preview.targetDisplacementMm;
        }
        const directHex = Array.isArray(displacement)
          ? directMultiMotor(displacement, 1)
          : null;
        if (directHex) {
          applyCommandedTargets(displacement);
          void invoke("control_frame_log", {
            request: {
              deviceId: snapshot.live.selectedDeviceId,
              kind: "multi-motor",
              frameHex: directHex,
              action: null,
            },
          }).catch(() => undefined);
          setCommandStatus({
            tone: "ok",
            message:
              `已直连串口下发（${source} → 位姿表，末端 ${positionMm.map((v) => v.toFixed(0)).join("/")} mm，` +
              `最近邻 ${shape.nearestDistance.toFixed(2)}）${clampedNote}`,
          });
          return;
        }
        // 本端没有串口 → 回退走后端（手机 / 远端）
        const result = await sendTipPoseCommand(positionMm, tip.rpyRad, {
          deviceId: snapshot.live.selectedDeviceId,
        });
        applyCommandedTargets(result.targetDisplacementMm ?? null);
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
        const result = await sendTipPoseCommand(
          [tipDraft.x, tipDraft.y, tipDraft.z],
          [tipDraft.roll * DEG2RAD, tipDraft.pitch * DEG2RAD, tipDraft.yaw * DEG2RAD],
          { deviceId: snapshot.live.selectedDeviceId },
        );
        applyCommandedTargets(result.targetDisplacementMm ?? null);
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

  /**
   * 拖动实时跟随：**跟着拖动的刷新率走**，不另设定时器。
   *
   * 为什么不用固定间隔：界面预览是按指针事件刷新的（通常 60~120Hz），定时器只要比它慢，
   * 就会出现"预览已经到位、臂体还在追"的错拍 —— 那样反而不像实时。这里改成"目标一变
   * 就尝试下发"，让下发节拍天然跟着拖动走。
   *
   * 但链路跑不过指针，所以有三条约束：
   *
   * 1. **只保留最新目标、绝不排队**。上一帧还在路上时，新目标只覆盖 `latestRef`；
   *    在途那帧回来后，循环再取**此刻最新**的那个。否则队列会越积越长，松手之后臂体
   *    还在执行几百毫秒前的轨迹。
   * 2. **串口自己会背压**。桩里 `writer.write()` 是 await 的，串口写不下去时长轮询被拖慢，
   *    这里的循环自然降速。所以实际速率 = min(拖动刷新率, 链路能承受的速率)。
   * 3. **不刷 `commandStatus`**。每秒几十条会把提示区刷爆。连续失败若干次才停跟随并报一次；
   *    "拖出可达范围"这种瞬时失败（拖出去再拖回来）不该立刻打断。
   */
  const latestDragRef = useRef<CurvatureDistribution | null>(null);
  const sentDragRef = useRef<CurvatureDistribution | null>(null);
  const dragPumpingRef = useRef(false);
  /** 上一次**真正发出去**的末端位置（mm）✓ —— 限速推进的起点 ✓ */
  const dragSentTipRef = useRef<[number, number, number] | null>(null);
  const dragFailStreakRef = useRef(0);
  const dragDeviceId = snapshot.live.selectedDeviceId;

  useEffect(() => {
    setDragFollowState({ kind: dragFollowEnabled ? "waiting" : "idle", sent: 0 });
  }, [dragFollowEnabled]);

  useEffect(() => {
    latestDragRef.current = followSource;
    // 目标清空（拖动结束 / 手势丢锁）：连已发送标记一起清掉，
    // 免得下次开跟随先把一个过期目标发出去
    if (!followSource) {
      sentDragRef.current = null;
      dragSentTipRef.current = null;
    }
  }, [followSource]);

  /**
   * **跟随开关用 ref 读** ✓ —— 绝对不能进那个下发 effect 的依赖 ✗。
   *
   * 原来 `dragFollowEnabled` 是依赖 ✓ → **勾上开关那一刻** effect 就重跑一次 ✗ →
   * 只要 `followSource`（上一次拖动的目标）还留着 ✓ 就把**过期目标**立刻发给
   * 六个电机 ✗ —— 动作组正在执行时点「实时跟随」也会补发一帧 ✓（本 bug ✓）。
   *
   * 现在：开关只改 ref ✓，下发**只由目标变化触发**（手指/手柄真的在动 ✓）。
   */
  const dragFollowEnabledRef = useRef(dragFollowEnabled);
  dragFollowEnabledRef.current = dragFollowEnabled;
  /** 使能态的 ref ✓ —— 泵循环里要能读到**最新**值 ✓（state 会过期 ✗）*/
  const motionAllowedRef = useRef(motionAllowed);
  motionAllowedRef.current = motionAllowed;

  useEffect(() => {
    if (!dragFollowEnabledRef.current || !motionAllowed || !followSource) return;
    /**
     * **动作组 / 动作播放中不下发** ✓ —— 播放有自己的轨迹和节奏 ✓，
     * 这里再按拖动值推一帧过去只会把臂体从播放轨迹上拽走 ✗（本 bug ✓）。
     */
    if (getCurrentActionName()) return;
    // 已经在跑就别再起一个：在途那帧回来后，循环会自己取最新值
    if (dragPumpingRef.current) return;

    dragPumpingRef.current = true;
    void (async () => {
      try {
        for (;;) {
          /**
           * ⚠ **每拍都要重新检查开关** ✗ —— 这是"取消跟随还在发"的根因 ✓：
           * 泵是 `for(;;)` 常循环 ✓，而 effect 依赖里**故意不含 `dragFollowEnabled`**
           * （否则点开开关那一刻就会补发一帧 ✓）✗ → 取消勾选时 effect 不重跑 ✓ →
           * 循环照旧转 ✓ → 目标还在就一直发 ✗（本 bug ✓）。
           * 现在每拍读 ref ✓，取消跟随 / 失能后**下一拍立即退出** ✓（≤100ms ✓）。
           */
          if (!dragFollowEnabledRef.current || !motionAllowedRef.current) break;
          const target = latestDragRef.current;
          if (!target) break; // 拖动结束

          const tip = tipPoseOfDistribution(target.segments);
          const targetMm: [number, number, number] = [
            tip.positionM[0] * 1000,
            tip.positionM[1] * 1000,
            tip.positionM[2] * 1000,
          ];

          /**
           * **限速推进** ✓ —— 从"上次已发位置"朝目标走，单拍最多
           * `2mm/s × 0.1s = 0.2mm` ✓；已贴近目标（<0.05mm）就停在这儿等下一拍 ✓。
           */
          const sent = dragSentTipRef.current;
          let nextMm = targetMm;
          if (sent) {
            const dx = targetMm[0] - sent[0];
            const dy = targetMm[1] - sent[1];
            const dz = targetMm[2] - sent[2];
            const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const maxStep = (DRAG_FOLLOW_MAX_MM_PER_S * DRAG_FOLLOW_TICK_MS) / 1000;
            if (distance <= maxStep) {
              nextMm = targetMm;
            } else {
              const k = maxStep / distance;
              nextMm = [sent[0] + dx * k, sent[1] + dy * k, sent[2] + dz * k];
            }
          }
          dragSentTipRef.current = nextMm;

          try {
            /**
             * **本地查表 + 直发** ✓ —— 拖动是 10Hz ✓，
             * 走 RPC 会被排队拖慢 ✗，本地表 + 直写串口才是 ms 级 ✓。
             * 表不可用时回退后端 ✓（口径一致 ✓）。
             */
            const local = lookupLocal(nextMm);
            let sentDirect = false;
            if (local) {
              const hex = directMultiMotor(local.displacementMm, 1);
              if (hex) {
                applyCommandedTargets(local.displacementMm);
                void invoke("control_frame_log", {
                  request: {
                    deviceId: snapshot.live.selectedDeviceId,
                    kind: "multi-motor",
                    frameHex: hex,
                    action: null,
                  },
                }).catch(() => undefined);
                sentDirect = true;
              }
            }
            if (!sentDirect) {
              const result = await sendTipPoseCommand(nextMm, tip.rpyRad, { deviceId: dragDeviceId });
              applyCommandedTargets(result.targetDisplacementMm ?? null);
            }
            dragFailStreakRef.current = 0;
            setDragFollowState((prev) => ({ kind: "sending", sent: prev.sent + 1 }));
          } catch (err) {
            dragFailStreakRef.current += 1;
            setDragFollowState((prev) => ({
              kind: "failed",
              sent: prev.sent,
              message: errorText(err),
            }));
            if (dragFailStreakRef.current >= 5) {
              setDragFollowEnabled(false);
              setCommandStatus({
                tone: "warn",
                message: `拖动实时跟随已停止：${errorText(err)}`,
              });
              break;
            }
          }

          // **节奏** ✓ —— 限速靠这个 tick ✓
          await new Promise<void>((resolve) => window.setTimeout(resolve, DRAG_FOLLOW_TICK_MS));
        }
      } finally {
        dragPumpingRef.current = false;
        dragSentTipRef.current = null;   // **停止后清限速起点** ✓（下次拖动重新起算 ✓）
      }
    })();
  }, [followSource, motionAllowed, dragDeviceId, sendTipPoseCommand, applyCommandedTargets]);

  // 循环寿命检测：压力反馈跨过阈值就换向，一个来回计一次。
  useEffect(() => {
    if (!cycleLifeEnabled || !motionAllowed || !latestFrame) return;
    const sensorValue = latestFrame.sensors[0]?.filteredValue;
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

  const sensorMax = sensors.reduce((max, sensor) => Math.max(max, sensor.filteredValue), 0);
  const sensorAlarmCount = sensors.filter((sensor) => sensor.filteredValue >= sensorThreshold).length;

  // 监控卡片布局：拖动 / 缩放后由 useCardLayout 原地写盘，不走页面级状态。
  const { layout, commit: commitLayout } = useCardLayout(snapshot.authSession.username, "workspace-monitor");
  // 参数调整卡片布局：拖动 / 缩放后由 useCardLayout 原地写盘，不走页面级状态。
  const automaticLayout = useCardLayout(snapshot.authSession.username, "workspace-automatic");

  // 控制卡片布局。
  const manualLayout = useCardLayout(snapshot.authSession.username, "workspace-manual");

  const manualHeaderForCard = useCallback(
    (cardId: string) => {
      const meta = manualCardRegistry[cardId as ManualCardId];
      const Icon = meta.icon;
      // 3D 拖动卡片的标题栏右侧是「拖动控制」开关。
      // 命令反馈（未使能警告 / 失败原因）统一走顶层横幅，不再挂到卡片标题栏。
      const action =
        cardId === "curvatureDrag" ? (
          <div className="curvature-drag-toggles">
            {/* 拖动控制 / 固定末端位姿 已移到 3D 画布左下角的「控制模式」面板 ✓，
                标题栏只留"跟随"类开关（它们改变的是下发行为，不是视图控制）。 */}
            {/* 实时跟随：勾上之后拖动就是"摇"臂体，而不是"画完再点下发"。
                放在拖动开关旁边，因为它改变的是**拖动本身的语义**。 */}
            <label
              className={`curvature-drag-toggle${motionAllowed ? "" : " is-blocked"}`}
              title="拖动臂体时按拖动刷新率持续下发位置指令，臂体实时跟随。只有持有串口的那一端需要勾选。"
            >
              {/* 不用 disabled：禁用的勾选框点不动、也没有任何反馈 ✗，
                  操作员只会以为"点了没反应"。改为可点，点下去如实提示要先使能 ✓。 */}
              <input
                type="checkbox"
                checked={dragFollowEnabled}
                aria-disabled={!motionAllowed}
                onChange={(event) => {
                  if (!motionAllowed) {
                    setCommandStatus({
                      tone: "warn",
                      message: "请先到「控制 → 系统操作」点「启动控制系统」，再开启实时跟随。",
                    });
                    return;
                  }
                  const next = event.target.checked;
                  setDragFollowEnabled(next);
                  // **播放中勾跟随**：说明"现在就会跟着动作走"✓ ——
                  // 播放期间由**播放泵**按帧下发 ✓（拖动泵在播放时是关掉的 ✓）
                  if (next && getCurrentActionName()) {
                    setCommandStatus({
                      tone: "ok",
                      message: "动作正在播放：跟随即生效 —— 会按动作轨迹逐帧下发。",
                    });
                  }
                  // 实时跟随的前提是**能拖动** ✗ —— 勾上它却还锁着拖动控制，
                  // 表现就是"勾了没反应"。所以打开跟随时顺带把拖动控制开上 ✓。
                  if (next) editDragEnabled(true);
                }}
              />
              <span>实时跟随</span>
            </label>
            {/* 手势跟随：摄像头识别手指弯折 → 直接驱动臂体弯曲。
                与实时跟随共用下发泵，开启时手势优先。 */}
            <label
              className={`curvature-drag-toggle${motionAllowed ? "" : " is-blocked"}`}
              title="用摄像头识别到的手指弯折实时驱动臂体弯曲。需要先点「启动控制系统」。"
            >
              <input
                type="checkbox"
                checked={gestureFollowEnabled}
                aria-disabled={!motionAllowed}
                onChange={(event) => {
                  if (!motionAllowed) {
                    setCommandStatus({
                      tone: "warn",
                      message: "请先到「控制 → 系统操作」点「启动控制系统」，再开启手势跟随。",
                    });
                    return;
                  }
                  const next = event.target.checked;
                  setGestureFollowEnabled(next);
                  if (!next) setGestureBend(null);
                }}
              />
              <span>手势跟随</span>
            </label>
            {dragFollowEnabled ? (
              <span
                className={`curvature-drag-follow is-${dragFollowState.kind}`}
                title={
                  dragFollowState.kind === "failed"
                    ? "连续失败 5 次会自动停掉跟随"
                    : "拖动臂体时按拖动刷新率持续下发位置指令"
                }
              >
                {!motionAllowed
                  ? // 泵的第一道门就是它，但它原来不显示 —— 勾选框看着能勾
                    // （memo 依赖漏了 motionAllowed，disabled 是旧值），勾上却什么都不发生。
                    "服务器未同步使能，跟随不会下发 —— 请先点「启动控制系统」"
                  : dragFollowState.kind === "failed"
                  ? `跟随失败：${dragFollowState.message ?? "未知原因"}`
                  : dragFollowState.kind === "sending"
                    ? `跟随中 · 已发 ${dragFollowState.sent} 帧`
                    : dragFollowState.kind === "waiting"
                      ? // 拖动必须**按在臂体上**才建立会话（CurvatureDragPreview 的 onPointerDown
                        // 会做拾取，点空白处静默忽略）。原来这里只说"等待拖动"，操作员
                        // 拖了半天空白处也不知道为什么没反应。
                        dragEnabled
                        ? "就绪，请在臂体上按住拖动"
                        : "请先勾选「拖动控制」"
                      : "已停止"}
              </span>
            ) : null}
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
    // ⚠️ 拖动相关的一切都要在依赖里。这个 useCallback 的返回值被当成**卡片标题栏**，
    // 漏一个依赖，那一项在标题栏里就永远停在首次渲染的闭包上 —— 实测踩到过：
    // 「实时跟随」的状态文字一直显示"就绪，请在臂体上按住拖动"，而实际上目标一直在产出、
    // 计数一直在涨。整整四轮排查都被这个假象带偏了（盯着链路查，问题在 memo 依赖上）。
    [
      dragEnabled,
      lockTipPose,
      tipDriftToleranceMm,
      dragFollowEnabled,
      dragFollowState,
      dragEmitCount,
      motionAllowed,
      lastTargetsHint,
    ],
  );

  const automaticHeaderForCard = useCallback(
    (cardId: string) => {
      const meta = automaticCardRegistry[cardId as AutomaticCardId];
      const Icon = meta.icon;
      // 系统操作卡片的标题栏右侧挂命令状态徽标。
      const action =
        cardId === "modelPackage" ? (
          <button type="button" className="ghost-btn" onClick={() => setModelLibraryOpen(true)}>
            管理
          </button>
        ) : cardId === "systemControl" && commandStatus ? (
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

  /**
   * 卡片主体渲染：**所有页的卡片都走这里** ✓
   *
   * 显示哪几张由布局决定（CardGrid 的 layout），不由 switch 决定 ——
   * 这样卡片在页之间搬家只需改注册表 / 布局，不必搬 JSX ✓。
   */
  const renderCardBody = (cardId: string) => {
    switch (cardId) {
        case "modelPackage":
          return (
            <>
              <ModelLibraryDialog
                open={modelLibraryOpen}
                onClose={() => setModelLibraryOpen(false)}
                onChanged={() => {
                  // 库变化后刷新预设与当前状态（可能切换/删除了模型 ✓）
                  void fetchModelPresets().then(setModelPresets);
                  void fetchModelStatus().then(applyModelStatus);
                }}
              />
      {modelPresets.length > 0 ? (
        <label className="workspace-field" style={{ margin: "0 12px 8px" }}>
          <span>模型包</span>
          <select
            value={modelPresets.find((preset) => preset.active)?.id ?? ""}
            onChange={(event) => {
              const id = event.target.value;
              if (!id) return;
              void (async () => {
                try {
                  applyModelStatus(await selectModelPreset(id));
                } catch (err) {
                  setCommandStatus({ tone: "error", message: `切换模型包失败：${errorText(err)}` });
                }
              })();
            }}
          >
            {modelPresets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
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
        // 把两个开关的 setter 也传下去 —— 3D 面板里的「控制模式」要用 ✓
        onEnabledChange={editDragEnabled}
        onLockTipPoseChange={editLockTipPose}
        // 手势跟随开启时：左 3D / 右手势曲线
        showGestureCurve={gestureFollowEnabled}
        // 臂长跟着模型包走（445 / 400mm）；写死会让"换模型包视图不变"✗
        lengthMm={curvatureDistribution.totalLengthMm}
        // 方向上限表必须**显式传** ✓（走模块单例会在 lazy chunk 里读到另一份副本 ✗）
        kappaByDirection={modelKappaByDirection}
        armTint={armAccent}
        armFinish={armFinish}
      />
      {/**
       * **只留一条蓝框** ✓ —— 原来时间线一条 ✓、动作一条 ✗，两个条件各自
       * 独立渲染 ✗ → 策略时间线跑到 `action` 片段时**两条同时出现** ✓，
       * 卡片高度不够 → 第二条被裁掉半截 ✗（本 bug ✓）。
       *
       * 现在合成一条 ✓：动作在播就以动作为主 ✓（有暂停按钮 ✓），
       * 时间线位置降级成 meta 里的一句 ✓；只跑时间线（等待 / 切换模型）时
       * 才以时间线为主 ✓。
       *
       * ⚠ `is-paused` **必须加在这一条上** ✗ —— 只改时间线那条的话，
       *   暂停后蓝框不变色 ✗（上一轮踩过 ✓）。
       */}
      {playingAction || timelineInfo ? (
        <div className={`motion-playing${playbackPaused ? " is-paused" : ""}`} role="status">
          <span className="motion-playing-label">
            {playingAction ? (
              <>
                {playbackPaused ? "⏸ 已暂停" : "▶ 正在播放"}动作：<b>{playingAction}</b>
              </>
            ) : timelineInfo ? (
              <>▶ 时间线 {timelineInfo.index + 1} · {timelineInfo.label}</>
            ) : null}
          </span>
          {/* **时间显示** ✓ —— 当前 / 总时长 ✓（`播放 12.3s / 53.3s` ✓）*/}
          <span className="motion-playing-meta">
            {playingAction ? (
              <>
                {" "}
                · {formatSeconds(playbackTimes.elapsedMs)} / {formatSeconds(playbackTimes.totalMs)}
                {playbackInfo ? ` · ${(playbackInfo.progress * 100).toFixed(0)}%` : null}
                {playbackInfo ? ` · κmax ${playbackInfo.maxKappa.toFixed(2)}` : null}
                {timelineInfo ? ` · 时间线第 ${timelineInfo.index + 1} 段` : null}
              </>
            ) : timelineInfo ? (
              <> · {timelineInfo.elapsedSec.toFixed(1)}s / {timelineInfo.totalSec.toFixed(1)}s</>
            ) : null}
          </span>
          {playingAction ? (
            <button
              type="button"
              className="ghost-btn motion-playing-btn"
              onClick={() => {
                const controller = stopPlaybackRef.current;
                if (!controller) return;
                const before = controller.isPaused();
                if (before) {
                  controller.resume();
                } else {
                  controller.pause();
                }
              }}
            >
              {playbackPaused ? "继续" : "暂停"}
            </button>
          ) : null}
        </div>
      ) : null}
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
          {/* 一键归中 = **臂体完全伸直**，不是"电机归零" ✗。
              表里"伸直"的位移约 -20mm（松弛量 + 预紧），不是 0 ——
              所以这里走位姿下发：目标位姿 = 沿 z 轴伸到最大长度、姿态全零，
              由位姿表算出对应的 6 丝位移。 */}
          <button type="button" className={blockedClass("ghost-btn")}
            title={blockedHint("一键归中：臂体完全伸直")}
            onClick={() => {
              void (async () => {
                try {
                  const straightMm = curvatureDistribution.totalLengthMm;
                  const result = await sendTipPoseCommand(
                    [0, 0, straightMm],
                    [0, 0, 0],
                    { deviceId: snapshot.live.selectedDeviceId },
                  );
                  applyCommandedTargets(result.targetDisplacementMm ?? null);
                  clearTargets();
                  setCommandStatus({
                    tone: "ok",
                    message: `已下发一键归中（臂体伸直，末端 z=${straightMm.toFixed(0)}mm）`,
                  });
                } catch (err) {
                  setCommandStatus({ tone: "error", message: `一键归中失败：${errorText(err)}` });
                }
              })();
            }}>
            <span>一键归中</span>
          </button>
        </div>
      </div>

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
          title={blockedHint("一键归零：所有电机回到初始零点")}
          onClick={() => {
            runWorkspaceCommand("home", undefined, "已发送一键归零命令");
            applyCommandedTargets([0, 0, 0, 0, 0, 0]);
          }}>
          <span>一键归零</span>
        </button>
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
        <button
          type="button"
          className="ghost-btn"
          disabled={!canCalibrate}
          title={canCalibrate ? undefined : PERMISSION_REASON.runCalibration}
          onClick={() => runWorkspaceCommand("calibrateSensor", sensorDraft, "已发送传感器校准命令")}
        >
          <CheckCircle2 size={15} /><span>校准传感器</span>
        </button>
      </div>
      {selectedSensor ? (
        <div className="sensor-axis-grid compact">
          <div>
            <span>实际值</span>
            <strong>{selectedSensor.rawValue.toFixed(2)} {selectedSensor.unit}</strong>
            <small>滤波 {selectedSensor.filteredValue.toFixed(2)}</small>
          </div>
        </div>
      ) : null}
            </>
          );
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
        case "motionLibrary":
          return (
            <div className="admin-card-content">
              <MotionLibraryCard />
            </div>
          );
        case "policyRules":
          return (
            <div className="admin-card-content">
              <PolicyRulesCard />
            </div>
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
        <div><span>反馈值</span><strong>{latestFrame?.sensors[0]?.filteredValue.toFixed(2) ?? "--"} N</strong></div>
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
        case "shapeCalibration":
          return (
            <ShapeCalibrationCard
              deviceId={snapshot.live.selectedDeviceId}
              ensureMotion={requireSystemEnabled}
              onNotify={notifyCommand}
            />
          );
        case "tendonIdentify":
          return (
            <TendonIdentifyCard
              deviceId={snapshot.live.selectedDeviceId}
              ensureMotion={requireSystemEnabled}
              onNotify={notifyCommand}
            />
          );
      default:
        return null;
    }
  };

  return (
    <WorkbenchLayout context={context} tabs={tabs} contextLabel="设备管理区">
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
                totalLengthMm: curvatureDistribution.totalLengthMm,
                armTint: armAccent,
                armFinish,
                latestFrame,
                sensorMax,
                sensorAlarmCount,
                sensorThreshold,
                onSensorThresholdChange: editSensorThreshold,
                curvatureSummary,
                commandedTargets: shownCommandedTargets,
                onGestureTrack: setGestureBend,
                // 预览卡也能拖手柄 ✓（和臂体控制卡共用同一套状态 ✓）
                targetDistribution,
                dragEnabled,
                onDragTarget: handleDragTarget,
                lockTipPose,
                onLockTipPoseChange: editLockTipPose,
                tipDriftToleranceMm,
                modelKappaByDirection,
              })}
          />
        ) : null}

        {/* ---------- 控制 ---------- */}
        {activeTab === "manual" ? (
          <CardGrid
            layout={manualLayout.layout}
            ariaLabel="控制卡片"
            layoutKey="workspace-manual"
            onLayoutChange={manualLayout.commit}
            draggableForCard={manualCardDraggable}
            bodyClassForCard={(cardId) => (cardId === "curvatureDrag" ? "manual-volume-panel" : undefined)}
            headerForCard={manualHeaderForCard}
            childrenForCard={renderCardBody}
          />
        ) : null}

        {/* ---------- 参数调整 ---------- */}
        {activeTab === "automatic" ? (
          <CardGrid
            layout={automaticLayout.layout}
            ariaLabel="参数调整卡片"
            layoutKey="workspace-automatic"
            onLayoutChange={automaticLayout.commit}
            draggableForCard={automaticCardDraggable}
            headerForCard={automaticHeaderForCard}
            childrenForCard={renderCardBody}
          />
        ) : null}

        {/* ---------- 回放 ---------- */}
        {activeTab === "playback" ? (
          <div className="workspace-pane-grid playback-pane">
            <WorkspaceCard
              title="数据回放"
              kicker="workspace"
              wide
              actions={<Badge tone={snapshot.playbackMode ? "info" : "neutral"}>{snapshot.playbackMode ? "回放中" : "实时"}</Badge>}
            >
              <div className="timeline">
                <div className="timeline-bar"><div className="timeline-fill" style={{ width: `${progress}%` }} /></div>
                <div className="timeline-meta">
                  {/* 相对时间 ✓ —— 原来用 `isoFull(cursorMs)` ✗，
                      cursor=0 时显示 **1970-01-01** ✓（Unix 纪元 ✓），既无意义又吓人 ✗ */}
                  <span>{formatPlaybackClock(snapshot.playback.cursorMs)}</span>
                  <span>/ {formatPlaybackClock(snapshot.playback.durationMs)}</span>
                  <span>{snapshot.playback.speed.toFixed(1)}x</span>
                </div>
              </div>
              <div className="mini-info">当前会话：<strong>{activeSession?.name ?? "--"}</strong></div>
            </WorkspaceCard>

            <WorkspaceCard title="回放列表" kicker="workspace" wide>
              <div className="playback-session-list">
                {sessions.map((session) => (
                  <div className="playback-session-row" key={session.id}>
                    <div>
                      <strong title={session.name}>{session.name}</strong>
                      {/* 字段照 `SessionInfo` 来 ✓（原来用 recordCount/operator ✗ —— 那是另一份类型 ✓）*/}
                      <span>
                        {(session.frameCount ?? 0).toLocaleString()} 帧 ·{" "}
                        {session.endTime ? "已结束" : "录制中"} · {session.deviceId || "未知设备"}
                      </span>
                    </div>
                  </div>
                ))}
                {sessions.length === 0 ? (
                  <div className="workspace-empty-state">
                    <Play aria-hidden="true" size={22} />
                    <strong>还没有可回放的会话</strong>
                    <span>先在「回放录制」页开始一次录制，完成后即可在这里回放。</span>
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
