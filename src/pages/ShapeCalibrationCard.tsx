import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Play, Ruler, Trash2 } from "lucide-react";

import { SEGMENT_LENGTH_M } from "../dynamics/svcModel";
import { fetchShapeFromDisplacements } from "../robot/modelBridge";
import { previewTipPoseCommand, sendMultiMotorCommand } from "../robot/curvatureBridge";
import { downloadText, fileTimestamp } from "../utils/download";
import {
  applyAngleCalibration,
  applyDirectionCalibration,
  fitAngleCalibration,
  fitDirectionCalibration,
  IDENTITY_CALIBRATION,
  isIdentityCalibration,
  loadShapeCalibration,
  saveShapeCalibration,
  wrapDeg180,
  type ShapeCalibration,
} from "../robot/shapeCalibration";
import type { DeviceSnapshot, LiveLatest } from "../softuiTypes";

/**
 * 「典型臂形标定」—— 把臂体驱动到几个**已知的名义形状**，
 * 由操作员用角度尺量出实际弯曲角并录入，从而判断模型准不准。
 *
 * 为什么用名义形状而不是自由位姿 ✗：
 *   自由位姿没有独立的"真值"✓，模型说到了就是到了 ✗，测不出系统偏差 ✓。
 *   30° 上/下/左/右是可以用角度尺直接量的 ✓，误差才有意义 ✓。
 *
 * 为什么用 `send_multi_motor_command` 而不是 `send_tip_pose_command` ✗：
 *   后者为了拖动平滑会对上一帧下发量做低通（α=0.35）✓ —— 单个姿态只发一次
 *   只会走 35% 的行程 ✗。这里**先查表拿到目标位移**（`lookup_tip_pose_shape`）✓，
 *   再按位移一次性下发 ✓，每次都是准确的表内解 ✓。
 *
 * 测量数据的三个来源（互相对照）：
 *   1. 人工角度尺（唯一独立基准 ✓）→ 「实测角」输入框
 *   2. 固件回传的两段弯曲角（`frame.bend`）
 *   3. 模型反算角：**实测电机位移 → 查表 → 12 节点 κ 积分**（`shape_from_displacements`）
 */

/** 名义臂长（mm）：两段各 `SEGMENT_LENGTH_M`。 */
export const ARM_LENGTH_MM = SEGMENT_LENGTH_M * 2 * 1000;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export type CalibrationDirection = "up" | "right" | "down" | "left";

/**
 * 四个典型臂形。方向角沿用项目既有口径（`directionNameToDeg`）：
 * 上=0°、右=90°、下=180°、左=270°，与 κ 矢量 `kx = -κ·sinφ, ky = κ·cosφ` 一致。
 */
export const CALIBRATION_SHAPES: ReadonlyArray<{
  key: CalibrationDirection;
  label: string;
  phiDeg: number;
}> = [
  { key: "up", label: "向上弯曲", phiDeg: 0 },
  { key: "right", label: "向右弯曲", phiDeg: 90 },
  { key: "down", label: "向下弯曲", phiDeg: 180 },
  { key: "left", label: "向左弯曲", phiDeg: 270 },
];

/**
 * 名义弯曲角 → 末端位置（**svc 系，mm**）。
 *
 * 整根臂按**等曲率圆弧**处理（总弯曲角 θ、总长 L）：
 *   R = L / θ
 *   横向 = R·(1 − cosθ)、轴向 = R·sinθ
 * 弯曲平面由方向角 φ 给出：`u = (−sinφ, cosφ)`（与 κ 矢量同向）。
 * 末端切线与根部的夹角正好是 θ ✓ —— 也就是角度尺量到的那个角 ✓。
 */
export function tipPoseForBend(
  angleDeg: number,
  phiDeg: number,
  lengthMm: number = ARM_LENGTH_MM,
): [number, number, number] {
  const theta = angleDeg * DEG2RAD;
  if (!(Math.abs(theta) > 1e-6) || !(lengthMm > 0)) return [0, 0, lengthMm];
  const radius = lengthMm / theta;
  const phi = phiDeg * DEG2RAD;
  const transverse = radius * (1 - Math.cos(theta));
  const axial = radius * Math.sin(theta);
  return [-Math.sin(phi) * transverse, Math.cos(phi) * transverse, axial];
}

export interface CalibrationRow {
  key: CalibrationDirection;
  label: string;
  targetAngleDeg: number;
  status: "idle" | "running" | "done" | "error";
  /** 名义方向（上=0 右=90 下=180 左=270） */
  nominalPhiDeg: number;
  /** 经过方向标定后**实际下发**的方向（度） */
  commandedPhiDeg: number | null;
  /** 经过角度标定后**实际下发**的弯曲角（度） */
  commandedAngleDeg: number | null;
  /** 6 路目标位移（mm，模型查表） */
  targetMm: number[] | null;
  /** 6 路实测电机位置（mm） */
  actualMm: number[] | null;
  /** 固件回传：两段弯曲角（deg）与方向 */
  firmwareAngles: [number | null, number | null];
  firmwareDirs: [string, string];
  /** 实测位移经模型反算出来的总弯曲角（deg） */
  modelAngleDeg: number | null;
  modelDirectionDeg: number | null;
  /**
   * **目标位移**回查模型得到的弯曲角（deg）。
   *
   * 为什么不等于目标角 ✗：查表是按**末端位置**找最近样本 ✓，同一个末端位置可能对应
   * 形状略有差别的样本 ✗ —— 这个值能区分"表里没有 30° 的解"和"电机没走到位" ✓。
   */
  modelTargetAngleDeg: number | null;
  /** 目标位姿在表里的最近邻距离（mm） */
  nearestMm: number | null;
  /** 从下发到判定稳定用了多久（ms） */
  settledMs: number | null;
  /** 人工用角度尺量到的值（留空 = 还没量） */
  measuredAngle: string;
  /** 人工目测/量到的实际弯曲方向（度，0=上 90=右 180=下 270=左） */
  observedDirection: string;
  message: string | null;
  atMs: number | null;
}

function emptyRow(shape: (typeof CALIBRATION_SHAPES)[number], angleDeg: number): CalibrationRow {
  return {
    key: shape.key,
    label: shape.label,
    targetAngleDeg: angleDeg,
    status: "idle",
    nominalPhiDeg: shape.phiDeg,
    commandedPhiDeg: null,
    commandedAngleDeg: null,
    targetMm: null,
    actualMm: null,
    firmwareAngles: [null, null],
    firmwareDirs: ["", ""],
    modelAngleDeg: null,
    modelDirectionDeg: null,
    modelTargetAngleDeg: null,
    nearestMm: null,
    settledMs: null,
    measuredAngle: "",
    observedDirection: "",
    message: null,
    atMs: null,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 本次实测位移经模型反查形状 → 总弯曲角 / 方向。 */
async function modelBendFromDisplacements(displacementMm: number[]): Promise<{
  angleDeg: number;
  directionDeg: number;
  nearest: number;
} | null> {
  if (displacementMm.length < 6) return null;
  const shape = await fetchShapeFromDisplacements(displacementMm.slice(0, 6));
  if (!shape) return null;
  const dsMm = shape.segmentMm;
  let angleRad = 0;
  let sumX = 0;
  let sumY = 0;
  for (let index = 0; index < shape.kxPerM.length; index += 1) {
    const kx = shape.kxPerM[index] ?? 0;
    const ky = shape.kyPerM[index] ?? 0;
    const magnitude = Math.hypot(kx, ky);
    angleRad += magnitude * (dsMm / 1000);
    sumX += kx * dsMm;
    sumY += ky * dsMm;
  }
  const directionDeg = ((Math.atan2(-sumX, sumY) * RAD2DEG) % 360 + 360) % 360;
  return { angleDeg: angleRad * RAD2DEG, directionDeg, nearest: shape.nearest };
}

/** 下发后等电机稳定：连续 3 次采样（250ms 一次）位移变化 < 0.2mm。 */
async function waitForStableFrame(
  deviceId: string,
  maxMs: number,
): Promise<{ frame: DeviceSnapshot | null; elapsedMs: number; timedOut: boolean }> {
  const started = performance.now();
  let previous: number[] | null = null;
  let stableCount = 0;
  let lastFrame: DeviceSnapshot | null = null;
  while (performance.now() - started < maxMs) {
    await sleep(250);
    const live = await invoke<LiveLatest>("fetch_live_latest");
    if (live.selectedDeviceId && deviceId && live.selectedDeviceId !== deviceId) {
      return { frame: lastFrame, elapsedMs: performance.now() - started, timedOut: true };
    }
    const frame = live.latest;
    if (!frame || frame.motors.length < 6) continue;
    lastFrame = frame;
    const positions = frame.motors.slice(0, 6).map((motor) => motor.positionMm);
    if (previous) {
      const maxDelta = Math.max(
        ...positions.map((value, index) => Math.abs(value - (previous as number[])[index])),
      );
      stableCount = maxDelta < 0.2 ? stableCount + 1 : 0;
    }
    previous = positions;
    // 至少 1s，避免"刚发下去还没动"就被判稳
    if (stableCount >= 3 && performance.now() - started > 1000) {
      return { frame, elapsedMs: performance.now() - started, timedOut: false };
    }
  }
  return { frame: lastFrame, elapsedMs: performance.now() - started, timedOut: true };
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function mm(value: number | null | undefined, digits = 3): string {
  return value != null && Number.isFinite(value) ? value.toFixed(digits) : "";
}

export interface ShapeCalibrationCardProps {
  deviceId: string;
  /** 未使能时给出提示并返回 false（复用工作台统一的告警文案）。 */
  ensureMotion: (what: string) => boolean;
  onNotify: (message: string, tone?: "ok" | "warn" | "error") => void;
}

export function ShapeCalibrationCard({ deviceId, ensureMotion, onNotify }: ShapeCalibrationCardProps) {
  const [angleDeg, setAngleDeg] = useState(30);
  const [timeoutMs, setTimeoutMs] = useState(12_000);
  const [rows, setRows] = useState<CalibrationRow[]>(() =>
    CALIBRATION_SHAPES.map((shape) => emptyRow(shape, 30)),
  );
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  /**
   * 方向 / 角度标定（本机持久化 ✓）。
   *
   * 方向：`observed = s·commanded + Δ` ⇒ 下发 `φ' = s·(φ − Δ)`；
   * 角度：`measured = gain·commanded + offset` ⇒ 下发 `(目标 − offset) / gain`。
   * 默认恒等 ✓ —— 不点"拟合/应用"就与原行为完全一致 ✓。
   */
  const [calibration, setCalibration] = useState<ShapeCalibration>(() => loadShapeCalibration());
  const [calibrationNote, setCalibrationNote] = useState<string | null>(null);

  useEffect(() => {
    saveShapeCalibration(calibration);
  }, [calibration]);

  const updateRow = useCallback(
    (key: CalibrationDirection, patch: Partial<CalibrationRow>) => {
      setRows((previous) =>
        previous.map((row) => (row.key === key ? { ...row, ...patch } : row)),
      );
    },
    [],
  );

  /** 角度改了以后，还没跑过的行同步成新目标（跑过的保留当时的目标 ✓）。 */
  const applyAngle = useCallback((next: number) => {
    const clamped = Number.isFinite(next) ? Math.min(80, Math.max(5, next)) : 30;
    setAngleDeg(clamped);
    setRows((previous) =>
      previous.map((row) => (row.status === "idle" ? { ...row, targetAngleDeg: clamped } : row)),
    );
  }, []);

  const runOne = useCallback(
    async (shape: (typeof CALIBRATION_SHAPES)[number]) => {
      if (!ensureMotion("典型臂形标定")) return false;
      if (!deviceId) {
        onNotify("未选择目标设备：请先在左栏连接设备", "warn");
        return false;
      }
      const targetAngle = angleDeg;
      // 标定后的**实际下发值**：方向按镜像/旋转补偿，角度按增益/偏移补偿 ✓
      const commandedAngle = applyAngleCalibration(targetAngle, calibration.angle);
      const commandedPhi = applyDirectionCalibration(shape.phiDeg, calibration.direction);
      if (!(Math.abs(commandedAngle) <= 85)) {
        onNotify(
          `角度标定后的下发角 ${commandedAngle.toFixed(1)}° 超出安全范围（±85°），请先检查角度增益/偏移`,
          "error",
        );
        return false;
      }
      const target = tipPoseForBend(commandedAngle, commandedPhi);
      updateRow(shape.key, {
        status: "running",
        targetAngleDeg: targetAngle,
        nominalPhiDeg: shape.phiDeg,
        commandedAngleDeg: commandedAngle,
        commandedPhiDeg: commandedPhi,
        message:
          `目标末端 ${target.map((value) => value.toFixed(1)).join(" / ")} mm · ` +
          `下发 ${commandedAngle.toFixed(1)}° @ φ=${commandedPhi.toFixed(0)}°`,
        measuredAngle: "",
        observedDirection: "",
        modelAngleDeg: null,
        modelTargetAngleDeg: null,
        nearestMm: null,
        settledMs: null,
        atMs: null,
      });

      try {
        // ① 只查表：拿到表内最接近解 + 6 路位移（`preview_tip_pose_command` 走 vc 表）
        const preview = await previewTipPoseCommand(target, [0, 0, 0], { deviceId });
        if (!Array.isArray(preview.targetDisplacementMm) || preview.targetDisplacementMm.length < 6) {
          throw new Error("模型没有返回 6 路位移");
        }
        updateRow(shape.key, {
          targetMm: preview.targetDisplacementMm.slice(0, 6),
          nearestMm: preview.nearestDistance,
        });

        // ①b 目标位移本身在表里对应多少度？（区分"表里没有这个角"和"电机没到位"）
        try {
          const predicted = await modelBendFromDisplacements(preview.targetDisplacementMm);
          if (predicted) updateRow(shape.key, { modelTargetAngleDeg: predicted.angleDeg });
        } catch {
          /* 反算失败不影响下发 */
        }

        // ② 按位移下发（不走低通，一次到位）
        await sendMultiMotorCommand(preview.targetDisplacementMm.slice(0, 6), { deviceId });

        // ③ 等稳定后采样
        const settled = await waitForStableFrame(deviceId, timeoutMs);
        const frame = settled.frame;
        if (!frame) throw new Error("没有收到设备状态帧");
        const actual = frame.motors.slice(0, 6).map((motor) => motor.positionMm);

        // ④ 实测位移 → 模型反算的总弯曲角（参考值，不是基准）
        let modelAngleDeg: number | null = null;
        let modelDirectionDeg: number | null = null;
        try {
          const inverted = await modelBendFromDisplacements(actual);
          modelAngleDeg = inverted?.angleDeg ?? null;
          modelDirectionDeg = inverted?.directionDeg ?? null;
        } catch {
          /* 反算失败不影响本行记录 */
        }

        updateRow(shape.key, {
          status: "done",
          actualMm: actual,
          firmwareAngles: [frame.bend.section1.angleDeg, frame.bend.section2.angleDeg],
          firmwareDirs: [frame.bend.section1.direction, frame.bend.section2.direction],
          modelAngleDeg,
          modelDirectionDeg,
          settledMs: Math.round(settled.elapsedMs),
          atMs: Date.now(),
          message: settled.timedOut ? "等待稳定超时，按最后一条状态帧采样" : null,
        });
        return true;
      } catch (error) {
        updateRow(shape.key, { status: "error", message: errorText(error) });
        onNotify(`「${shape.label} ${targetAngle}°」失败：${errorText(error)}`, "error");
        return false;
      }
    },
    [angleDeg, calibration, deviceId, ensureMotion, onNotify, timeoutMs, updateRow],
  );

  const runAll = useCallback(async () => {
    if (runningRef.current) return;
    if (!ensureMotion("典型臂形标定")) return;
    if (!window.confirm(
      `将依次把臂体驱动到 4 个 ${angleDeg}° 典型姿态（上 / 右 / 下 / 左）。\n` +
      "请确认臂体运动范围内没有障碍物，操作员已在位。是否继续？",
    )) return;
    runningRef.current = true;
    setRunning(true);
    let completed = 0;
    try {
      for (const shape of CALIBRATION_SHAPES) {
        const ok = await runOne(shape);
        // 失败就停下：剩下的姿态继续下发没有意义，也不安全
        if (!ok) break;
        completed += 1;
        await sleep(400);
      }
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
    if (completed === CALIBRATION_SHAPES.length) {
      onNotify("典型臂形标定执行完成，请用角度尺测量并录入实测角", "ok");
    } else {
      onNotify(`典型臂形标定中断：完成 ${completed}/${CALIBRATION_SHAPES.length} 个姿态`, "warn");
    }
  }, [angleDeg, ensureMotion, onNotify, runOne]);

  const runSingle = useCallback(
    async (shape: (typeof CALIBRATION_SHAPES)[number]) => {
      if (runningRef.current) return;
      runningRef.current = true;
      setRunning(true);
      try {
        await runOne(shape);
      } finally {
        runningRef.current = false;
        setRunning(false);
      }
    },
    [runOne],
  );

  const clearAll = useCallback(() => {
    if (running) return;
    setRows(CALIBRATION_SHAPES.map((shape) => emptyRow(shape, angleDeg)));
  }, [angleDeg, running]);

  /** 回直臂：同样走模型查表（不是简单发 0 位移 —— 表里的"直"未必是 dL=0）。 */  const returnStraight = useCallback(async () => {
    if (runningRef.current) return;
    if (!ensureMotion("回直臂")) return;
    if (!deviceId) {
      onNotify("未选择目标设备：请先在左栏连接设备", "warn");
      return;
    }
    runningRef.current = true;
    setRunning(true);
    try {
      const target: [number, number, number] = [0, 0, ARM_LENGTH_MM];
      const preview = await previewTipPoseCommand(target, [0, 0, 0], { deviceId });
      await sendMultiMotorCommand(preview.targetDisplacementMm.slice(0, 6), { deviceId });
      onNotify("已下发回直臂指令（模型查表）", "ok");
    } catch (error) {
      onNotify(`回直臂失败：${errorText(error)}`, "error");
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }, [deviceId, ensureMotion, onNotify]);

  /* ── 方向 / 角度标定 ───────────────────────────────────────────── */

  /** 可用的方向标定样本：跑过 + 填了实测方向。 */
  const directionFitSamples = useMemo(
    () =>
      rows.flatMap((row) => {
        if (row.commandedPhiDeg == null || row.observedDirection.trim() === "") return [];
        const observed = Number(row.observedDirection);
        if (!Number.isFinite(observed)) return [];
        return [{ commandedDeg: row.commandedPhiDeg, observedDeg: observed }];
      }),
    [rows],
  );

  /** 可用的角度标定样本：跑过 + 填了实测角。 */
  const angleFitSamples = useMemo(
    () =>
      rows.flatMap((row) => {
        if (row.commandedAngleDeg == null || row.measuredAngle.trim() === "") return [];
        const measured = Number(row.measuredAngle);
        if (!Number.isFinite(measured)) return [];
        return [{ commandedDeg: row.commandedAngleDeg, measuredDeg: measured }];
      }),
    [rows],
  );

  const fitDirection = useCallback(() => {
    const fit = fitDirectionCalibration(directionFitSamples);
    if (!fit) {
      setCalibrationNote("方向拟合至少需要 1 组「已执行 + 已填实测方向」的数据");
      return;
    }
    setCalibration((previous) => ({
      ...previous,
      direction: { mirror: fit.mirror, offsetDeg: fit.offsetDeg },
    }));
    setCalibrationNote(
      `方向拟合：${fit.mirror ? "镜像 + " : ""}偏移 ${fit.offsetDeg.toFixed(1)}°，` +
      `残差 ${fit.residualRmsDeg.toFixed(1)}°（${fit.count} 组）` +
      (fit.count < 2 ? "；只有 1 组时无法区分镜像，建议 4 个姿态都跑一遍" : ""),
    );
  }, [directionFitSamples]);

  const fitAngle = useCallback(() => {
    const fit = fitAngleCalibration(angleFitSamples);
    if (!fit) {
      setCalibrationNote("角度拟合至少需要 2 组「已执行 + 已填实测角」的数据（且两个下发角不能相同）");
      return;
    }
    setCalibration((previous) => ({
      ...previous,
      angle: { gain: fit.gain, offsetDeg: fit.offsetDeg },
    }));
    setCalibrationNote(
      `角度拟合：增益 ${fit.gain.toFixed(3)}、偏移 ${fit.offsetDeg.toFixed(2)}°，` +
      `残差 ${fit.residualRmsDeg.toFixed(2)}°（${fit.count} 组）`,
    );
  }, [angleFitSamples]);

  const updateDirectionCalibration = useCallback(
    (patch: Partial<ShapeCalibration["direction"]>) => {
      setCalibration((previous) => ({
        ...previous,
        direction: { ...previous.direction, ...patch },
      }));
    },
    [],
  );

  const updateAngleCalibration = useCallback((patch: Partial<ShapeCalibration["angle"]>) => {
    setCalibration((previous) => ({ ...previous, angle: { ...previous.angle, ...patch } }));
  }, []);

  const resetCalibration = useCallback(() => {
    setCalibration({
      direction: { ...IDENTITY_CALIBRATION.direction },
      angle: { ...IDENTITY_CALIBRATION.angle },
    });
    setCalibrationNote("已恢复恒等标定（方向偏移 0°、不镜像；角度增益 1、偏移 0）");
  }, []);

  const exportCsv = useCallback(() => {
    const header = [
      "序号", "姿态", "目标角(deg)", "下发角(deg)",
      "名义方向(deg)", "下发方向(deg)", "实测方向(deg)", "方向误差(deg)",
      ...Array.from({ length: 6 }, (_, index) => `目标M${index + 1}(mm)`),
      ...Array.from({ length: 6 }, (_, index) => `实测M${index + 1}(mm)`),
      "固件段1角(deg)", "固件段1方向", "固件段2角(deg)", "固件段2方向",
      "模型反算角(deg)", "模型目标角(deg)", "模型反算方向(deg)", "最近邻(mm)",
      "稳定耗时(ms)", "人工实测角(deg)", "角度误差(deg)", "状态", "备注", "时间",
    ];
    const lines = [header.map(csvCell).join(",")];
    rows.forEach((row, index) => {
      const measured = Number(row.measuredAngle);
      const hasMeasured = row.measuredAngle.trim() !== "" && Number.isFinite(measured);
      const errorDeg = hasMeasured ? measured - row.targetAngleDeg : null;
      const observed = Number(row.observedDirection);
      const hasObserved = row.observedDirection.trim() !== "" && Number.isFinite(observed);
      const directionError = hasObserved ? wrapDeg180(observed - row.nominalPhiDeg) : null;
      const cells = [
        index + 1,
        row.label,
        row.targetAngleDeg,
        row.commandedAngleDeg != null ? mm(row.commandedAngleDeg, 2) : "",
        row.nominalPhiDeg,
        row.commandedPhiDeg != null ? mm(row.commandedPhiDeg, 1) : "",
        hasObserved ? mm(observed, 1) : "",
        directionError != null ? mm(directionError, 1) : "",
        ...Array.from({ length: 6 }, (_, slot) => mm(row.targetMm?.[slot])),
        ...Array.from({ length: 6 }, (_, slot) => mm(row.actualMm?.[slot])),
        row.firmwareAngles[0] != null ? mm(row.firmwareAngles[0], 2) : "",
        row.firmwareDirs[0],
        row.firmwareAngles[1] != null ? mm(row.firmwareAngles[1], 2) : "",
        row.firmwareDirs[1],
        row.modelAngleDeg != null ? mm(row.modelAngleDeg, 2) : "",
        row.modelTargetAngleDeg != null ? mm(row.modelTargetAngleDeg, 2) : "",
        row.modelDirectionDeg != null ? mm(row.modelDirectionDeg, 1) : "",
        row.nearestMm != null ? mm(row.nearestMm, 2) : "",
        row.settledMs ?? "",
        hasMeasured ? mm(measured, 2) : "",
        errorDeg != null ? mm(errorDeg, 2) : "",
        row.status,
        row.message ?? "",
        row.atMs ? new Date(row.atMs).toLocaleString("zh-CN", { hour12: false }) : "",
      ];
      lines.push(cells.map(csvCell).join(","));
    });
    const stamp = fileTimestamp();
    downloadText(`典型臂形标定-${angleDeg}deg-${stamp}.csv`, lines.join("\r\n"));
    onNotify("已导出本次标定结果（CSV）", "ok");
  }, [angleDeg, onNotify, rows]);

  const doneCount = rows.filter((row) => row.status === "done").length;
  const measuredRows = rows.filter((row) => row.measuredAngle.trim() !== "");
  const meanAbsError = useMemo(() => {
    if (measuredRows.length === 0) return null;
    const total = measuredRows.reduce((sum, row) => {
      const measured = Number(row.measuredAngle);
      return Number.isFinite(measured) ? sum + Math.abs(measured - row.targetAngleDeg) : sum;
    }, 0);
    return total / measuredRows.length;
  }, [measuredRows]);

  return (
    <div className="admin-card-content shape-calib">
      <div className="workspace-form-grid shape-calib-controls">
        <label className="workspace-field">
          <span>目标弯曲角(°)</span>
          <input
            type="number"
            min={5}
            max={80}
            step={5}
            value={angleDeg}
            disabled={running}
            onChange={(event) => applyAngle(Number(event.target.value))}
          />
        </label>
        <label className="workspace-field">
          <span>稳定等待上限(ms)</span>
          <input
            type="number"
            min={2000}
            max={30000}
            step={1000}
            value={timeoutMs}
            disabled={running}
            onChange={(event) => {
              const next = Number(event.target.value);
              setTimeoutMs(Number.isFinite(next) ? Math.min(30_000, Math.max(2_000, next)) : 12_000);
            }}
          />
        </label>
      </div>

      <p className="model-params-hint">
        名义形状按<strong>等曲率圆弧</strong>换算成末端位置，再查表得到 6 路位移。
        执行后量两个数：<strong>根部与末端切线的夹角</strong>填「实测角」，
        <strong>实际弯曲方向</strong>填「实测方向」（0=上 90=右 180=下 270=左）。
        若方向整体转了一个角度、或左右反了，用下面的「方向标定」补偿；
        若角度按比例偏大/偏小，用「角度标定」补偿。两项都默认恒等，不点就不生效。
        「模型反算角」是<strong>实测位移</strong>回查模型得到的参考值，不是基准。
      </p>

      <div className="workspace-action-row">
        <button
          type="button"
          className="primary-btn"
          disabled={running || !deviceId}
          onClick={() => { void runAll(); }}
        >
          <Play size={15} />
          <span>{running ? "执行中…" : "依次执行 4 个姿态"}</span>
        </button>
        <button type="button" className="ghost-btn" disabled={running || !deviceId} onClick={() => { void returnStraight(); }}>
          <span>回直臂</span>
        </button>
        <button type="button" className="ghost-btn" disabled={running} onClick={clearAll}>
          <Trash2 size={15} />
          <span>清空</span>
        </button>
        <button type="button" className="ghost-btn" onClick={exportCsv} disabled={doneCount === 0}>
          <Ruler size={15} />
          <span>导出 CSV</span>
        </button>
        <span className="shape-calib-summary">
          已完成 {doneCount}/4
          {meanAbsError != null ? ` · 平均 |误差| ${meanAbsError.toFixed(2)}°` : ""}
        </span>
      </div>

      <div className="shape-calib-calib">
        <div className="shape-calib-calib-head">
          <strong>方向 / 角度标定</strong>
          <span className={`shape-calib-tag ${isIdentityCalibration(calibration) ? "" : "is-active"}`}>
            {isIdentityCalibration(calibration) ? "未标定（恒等）" : "已生效"}
          </span>
          <button type="button" className="ghost-btn shape-calib-run" onClick={resetCalibration} disabled={running}>
            重置
          </button>
        </div>
        <div className="shape-calib-calib-grid">
          <label>
            <span>方向偏移 Δ(°)</span>
            <input
              type="number"
              step={1}
              value={calibration.direction.offsetDeg}
              onChange={(event) => updateDirectionCalibration({ offsetDeg: Number(event.target.value) })}
            />
          </label>
          <label className="shape-calib-check">
            <input
              type="checkbox"
              checked={calibration.direction.mirror}
              onChange={(event) => updateDirectionCalibration({ mirror: event.target.checked })}
            />
            <span>左右镜像</span>
          </label>
          <button type="button" className="ghost-btn" onClick={fitDirection} disabled={directionFitSamples.length === 0}>
            按实测方向拟合
          </button>
          <label>
            <span>角度增益</span>
            <input
              type="number"
              step={0.01}
              min={0.2}
              max={5}
              value={calibration.angle.gain}
              onChange={(event) => {
                const next = Number(event.target.value);
                updateAngleCalibration({
                  gain: Number.isFinite(next) ? Math.min(5, Math.max(0.2, next)) : 1,
                });
              }}
            />
          </label>
          <label>
            <span>角度偏移(°)</span>
            <input
              type="number"
              step={0.1}
              value={calibration.angle.offsetDeg}
              onChange={(event) => updateAngleCalibration({ offsetDeg: Number(event.target.value) })}
            />
          </label>
          <button type="button" className="ghost-btn" onClick={fitAngle} disabled={angleFitSamples.length < 2}>
            按实测角拟合
          </button>
        </div>
        <p className="shape-calib-calib-hint">
          方向：实测 = {calibration.direction.mirror ? "−" : ""}下发 + {calibration.direction.offsetDeg.toFixed(1)}°
          ⇒ 下发 φ′ = {calibration.direction.mirror ? "−" : ""}(φ − {calibration.direction.offsetDeg.toFixed(1)}°)；
          角度：实测 = {calibration.angle.gain.toFixed(3)} × 下发 + {calibration.angle.offsetDeg.toFixed(2)}°
          ⇒ 下发 = (目标 − {calibration.angle.offsetDeg.toFixed(2)}°) / {calibration.angle.gain.toFixed(3)}。
          改完标定要<strong>重新执行</strong>姿态才按新映射走。
          {calibrationNote ? <><br />{calibrationNote}</> : null}
        </p>
      </div>

      <div className="shape-calib-list">
        {rows.map((row) => {
          const measured = Number(row.measuredAngle);
          const hasMeasured = row.measuredAngle.trim() !== "" && Number.isFinite(measured);
          const errorDeg = hasMeasured ? measured - row.targetAngleDeg : null;
          const observed = Number(row.observedDirection);
          const hasObserved = row.observedDirection.trim() !== "" && Number.isFinite(observed);
          const directionError = hasObserved ? wrapDeg180(observed - row.nominalPhiDeg) : null;
          return (
            <div className={`shape-calib-row is-${row.status}`} key={row.key}>
              <div className="shape-calib-row-head">
                <strong>{row.label} {row.targetAngleDeg}°</strong>
                <span className={`shape-calib-status is-${row.status}`}>
                  {row.status === "idle" ? "未执行"
                    : row.status === "running" ? "执行中…"
                    : row.status === "error" ? "失败" : "已采样"}
                </span>
                <button
                  type="button"
                  className="ghost-btn shape-calib-run"
                  disabled={running || !deviceId}
                  onClick={() => { void runSingle(CALIBRATION_SHAPES.find((item) => item.key === row.key)!); }}
                >
                  执行
                </button>
              </div>

              <div className="shape-calib-measured">
                <label>
                  <span>实测角(°)</span>
                  <input
                    type="number"
                    step={0.1}
                    inputMode="decimal"
                    placeholder="角度尺读数"
                    value={row.measuredAngle}
                    onChange={(event) => updateRow(row.key, { measuredAngle: event.target.value })}
                  />
                </label>
                <div className="shape-calib-error">
                  <span>角度误差</span>
                  <strong className={
                    errorDeg == null ? "" : Math.abs(errorDeg) <= 1 ? "is-good"
                      : Math.abs(errorDeg) <= 3 ? "is-warn" : "is-bad"
                  }>
                    {errorDeg == null ? "—" : `${errorDeg >= 0 ? "+" : ""}${errorDeg.toFixed(2)}°`}
                  </strong>
                </div>
                <label>
                  <span>实测方向(°)</span>
                  <input
                    type="number"
                    step={1}
                    inputMode="numeric"
                    placeholder="0上 90右 180下 270左"
                    value={row.observedDirection}
                    onChange={(event) => updateRow(row.key, { observedDirection: event.target.value })}
                  />
                </label>
                <div className="shape-calib-error">
                  <span>方向误差</span>
                  <strong className={
                    directionError == null ? "" : Math.abs(directionError) <= 5 ? "is-good"
                      : Math.abs(directionError) <= 20 ? "is-warn" : "is-bad"
                  }>
                    {directionError == null ? "—" : `${directionError >= 0 ? "+" : ""}${directionError.toFixed(0)}°`}
                  </strong>
                </div>
              </div>

              {row.targetMm || row.actualMm ? (
                <div className="shape-calib-detail">
                  {row.commandedAngleDeg != null ? (
                    <span>
                      下发 {row.commandedAngleDeg.toFixed(1)}°
                      {row.commandedPhiDeg != null ? ` @ φ=${row.commandedPhiDeg.toFixed(0)}°` : ""}
                      {`（名义 ${row.targetAngleDeg}° @ φ=${row.nominalPhiDeg}°）`}
                    </span>
                  ) : null}
                  {row.targetMm ? (
                    <span>目标位移 {row.targetMm.map((value) => value.toFixed(1)).join(" / ")} mm</span>
                  ) : null}
                  {row.modelTargetAngleDeg != null ? (
                    <span>模型目标角 {row.modelTargetAngleDeg.toFixed(1)}°</span>
                  ) : null}
                  {row.actualMm ? (
                    <span>实测位移 {row.actualMm.map((value) => value.toFixed(1)).join(" / ")} mm</span>
                  ) : null}
                  <span>
                    固件角 {row.firmwareAngles[0]?.toFixed(1) ?? "—"}° / {row.firmwareAngles[1]?.toFixed(1) ?? "—"}°
                  </span>
                  <span>
                    模型反算 {row.modelAngleDeg != null ? `${row.modelAngleDeg.toFixed(1)}°` : "—"}
                    {row.modelDirectionDeg != null ? ` @ ${row.modelDirectionDeg.toFixed(0)}°` : ""}
                  </span>
                  {row.nearestMm != null ? <span>最近邻 {row.nearestMm.toFixed(1)} mm</span> : null}
                  {row.settledMs != null ? <span>稳定 {row.settledMs} ms</span> : null}
                </div>
              ) : null}

              {row.message ? <div className="shape-calib-message">{row.message}</div> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
