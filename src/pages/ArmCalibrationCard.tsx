import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Crosshair, Download, Trash2 } from "lucide-react";

import { downloadText, fileTimestamp } from "../utils/download";
import { previewTipPoseCommand } from "../robot/curvatureBridge";
import { modelTipToPhysicalMm } from "../robot/frameCalibration";
import { useDisplacementGain } from "../robot/displacementGain";
import { ARM_LENGTH_MM, ShapeCalibrationPanel } from "./ShapeCalibrationCard";
import type { LiveLatest } from "../softuiTypes";

/**
 * 「臂体标定（手动）」：逐条记录当前位姿、曲率、电机位移与目测角度，导出 CSV。
 */

interface CalibrationRecord {
  id: number;
  atMs: number;
  motorsMm: number[];
  dlMm: number[];
  tipMm: number[];
  kxPerM: number[];
  kyPerM: number[];
  segmentMm: number;
  distance: number;
  totalAngleDeg: number;
  directionDeg: number;
  equivalentKappa: number;
  section1Kappa: number;
  section2Kappa: number;
  measuredBendDeg: string;
  measuredRotDeg: string;
}

export interface ArmCalibrationPanelProps {
  deviceId: string;
  /** 记录的臂体初态（六路电机位置 mm）；没有它就无法把实测位置还原成模型 dL */
  initialState: number[] | null;
  onNotify: (message: string, tone?: "ok" | "warn" | "error") => void;
}

const RAD2DEG = 180 / Math.PI;

function formatTime(atMs: number): string {
  return new Date(atMs).toLocaleString("zh-CN", { hour12: false });
}

function num(value: number | null | undefined, digits = 2): string {
  return value != null && Number.isFinite(value) ? value.toFixed(digits) : "";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ArmCalibrationPanel({ deviceId, initialState, onNotify }: ArmCalibrationPanelProps) {
  const [records, setRecords] = useState<CalibrationRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [displacementGain, setDisplacementGain] = useDisplacementGain();
  const straightRef = useRef<number[] | null>(null);
  const nextIdRef = useRef(1);

  const ensureStraightDl = useCallback(async (): Promise<number[]> => {
    if (straightRef.current && straightRef.current.length >= 6) return straightRef.current;
    const preview = await previewTipPoseCommand([0, 0, ARM_LENGTH_MM], [0, 0, 0], { deviceId });
    const values = preview.targetDisplacementMm.slice(0, 6);
    if (values.length < 6) throw new Error("模型没有返回伸直位的 6 路位移");
    straightRef.current = values;
    return values;
  }, [deviceId]);

  const record = useCallback(async () => {
    if (!deviceId) {
      onNotify("未选择目标设备：请先在左栏连接设备", "warn");
      return;
    }
    if (!initialState || initialState.length < 6) {
      onNotify(
        "还没有记录臂体初态：先在「控制 → 电机控制」记录初态（臂体伸直时），记录姿态要用它把实测位置还原成模型位移",
        "warn",
      );
      return;
    }
    setBusy(true);
    try {
      const live = await invoke<LiveLatest>("fetch_live_latest");
      const motors = [...(live.latest?.motors ?? [])]
        .sort((left, right) => left.id - right.id)
        .slice(0, 6);
      if (motors.length < 6) throw new Error("还没读到六路电机的实测位置");
      const actual = motors.map((motor) => motor.positionMm);
      const straight = await ensureStraightDl();
      // 电机 + = 拉紧；k 为位移增益（实际曲率偏大时 k>1，反查要乘回去）
      const dl = actual.map((value, index) =>
        straight[index] - displacementGain * (value - initialState[index]),
      );

      const pose = await invoke<{
        tipMm: number[];
        kappa: number[];
        segmentMm: number;
        distance: number;
      }>("calibration_pose_from_displacements", { displacementMm: dl });
      if (pose.kappa.length < 24) throw new Error("模型返回的曲率节点不足 12 个");

      const kxPerM = pose.kappa.filter((_, index) => index % 2 === 0);
      const kyPerM = pose.kappa.filter((_, index) => index % 2 === 1);
      const segmentMm = pose.segmentMm;
      let angleRad = 0;
      let sumX = 0;
      let sumY = 0;
      for (let node = 0; node < kxPerM.length; node += 1) {
        const kx = kxPerM[node] ?? 0;
        const ky = kyPerM[node] ?? 0;
        angleRad += Math.hypot(kx, ky) * (segmentMm / 1000);
        sumX += kx * segmentMm;
        sumY += ky * segmentMm;
      }
      const directionDeg = ((Math.atan2(-sumX, sumY) * RAD2DEG) % 360 + 360) % 360;
      const sectionMean = (from: number, to: number) => {
        const values = kxPerM.slice(from, to).map((kx, offset) => Math.hypot(kx, kyPerM[from + offset] ?? 0));
        return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
      };

      const entry: CalibrationRecord = {
        id: nextIdRef.current++,
        atMs: Date.now(),
        motorsMm: actual,
        dlMm: dl,
        // 模型末端 → 实机全局（绕 z 旋转 90°，见 frameCalibration.ts）
        tipMm: modelTipToPhysicalMm(pose.tipMm),
        kxPerM,
        kyPerM,
        segmentMm,
        distance: pose.distance,
        totalAngleDeg: angleRad * RAD2DEG,
        directionDeg,
        equivalentKappa: angleRad / (ARM_LENGTH_MM / 1000),
        section1Kappa: sectionMean(0, 6),
        section2Kappa: sectionMean(6, 12),
        measuredBendDeg: "",
        measuredRotDeg: "",
      };
      setRecords((previous) => [...previous, entry]);
      onNotify(
        `已记录第 ${entry.id} 条：末端 ${entry.tipMm.map((value) => value.toFixed(1)).join(" / ")} mm · ` +
          `模型弯曲 ${entry.totalAngleDeg.toFixed(1)}° @ ${entry.directionDeg.toFixed(0)}°`,
        "ok",
      );
    } catch (error) {
      onNotify(`记录失败：${errorText(error)}`, "error");
    } finally {
      setBusy(false);
    }
  }, [deviceId, ensureStraightDl, initialState, onNotify, displacementGain]);

  const updateMeasured = useCallback((id: number, patch: Partial<CalibrationRecord>) => {
    setRecords((previous) => previous.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const remove = useCallback((id: number) => {
    setRecords((previous) => previous.filter((item) => item.id !== id));
  }, []);

  const exportCsv = useCallback(() => {
    const NODE_COUNT = 12;
    const header = [
      "序号", "时间", "末端X(mm)", "末端Y(mm)", "末端Z(mm)", "最近样本(dL)",
      "总弯曲角(deg)", "净方向(deg)", "等效曲率(1/m)", "段1平均曲率(1/m)", "段2平均曲率(1/m)",
      ...Array.from({ length: 6 }, (_, index) => `实测M${index + 1}(mm)`),
      ...Array.from({ length: 6 }, (_, index) => `dL${index + 1}(mm)`),
      ...Array.from({ length: NODE_COUNT }, (_, index) => `s${index + 1}(mm)`),
      ...Array.from({ length: NODE_COUNT }, (_, index) => [
        `k${index + 1}x(1/m)`, `k${index + 1}y(1/m)`, `k${index + 1}(1/m)`,
      ]).flat(),
      "目测弯曲角(deg)", "目测旋转角(deg)",
    ];
    const cell = (value: string | number) => {
      const text = String(value ?? "");
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [header.map(cell).join(",")];
    records.forEach((item, index) => {
      const values = [
        index + 1,
        formatTime(item.atMs),
        num(item.tipMm[0], 2),
        num(item.tipMm[1], 2),
        num(item.tipMm[2], 2),
        num(item.distance, 4),
        num(item.totalAngleDeg, 2),
        num(item.directionDeg, 1),
        num(item.equivalentKappa, 3),
        num(item.section1Kappa, 3),
        num(item.section2Kappa, 3),
        ...Array.from({ length: 6 }, (_, slot) => num(item.motorsMm[slot], 2)),
        ...Array.from({ length: 6 }, (_, slot) => num(item.dlMm[slot], 2)),
        ...Array.from({ length: NODE_COUNT }, (_, node) => num(item.segmentMm * node, 1)),
        ...Array.from({ length: NODE_COUNT }, (_, node) => [
          num(item.kxPerM[node], 4),
          num(item.kyPerM[node], 4),
          num(Math.hypot(item.kxPerM[node] ?? 0, item.kyPerM[node] ?? 0), 4),
        ]).flat(),
        item.measuredBendDeg,
        item.measuredRotDeg,
      ];
      lines.push(values.map(cell).join(","));
    });
    downloadText(`臂体标定-${fileTimestamp()}.csv`, lines.join("\r\n"));
    onNotify("已导出臂体标定 CSV", "ok");
  }, [onNotify, records]);

  return (
    <div className="shape-calib">
      <div className="workspace-form-grid shape-calib-controls">
        <label className="workspace-field">
          <span>位移增益 k</span>
          <input
            type="number"
            min={0.2}
            max={10}
            step={0.05}
            value={displacementGain}
            onChange={(event) => setDisplacementGain(Number(event.target.value))}
          />
        </label>
      </div>

      <div className="workspace-action-row">
        <button
          type="button"
          className="primary-btn"
          disabled={busy || !deviceId}
          onClick={() => { void record(); }}
        >
          <Crosshair size={15} />
          <span>{busy ? "读取中…" : "记录当前位姿"}</span>
        </button>
        <button type="button" className="ghost-btn" disabled={records.length === 0} onClick={exportCsv}>
          <Download size={15} />
          <span>导出 CSV</span>
        </button>
        <button
          type="button"
          className="ghost-btn"
          disabled={records.length === 0 || busy}
          onClick={() => setRecords([])}
        >
          <Trash2 size={15} />
          <span>清空</span>
        </button>
        <span className="shape-calib-summary">已记录 {records.length} 条</span>
      </div>

      <div className="shape-calib-list">
        {records.length === 0 ? (
          <p className="feature-empty-compact">还没有记录：把臂摆到姿态后点「记录当前位姿」</p>
        ) : (
          records.map((item, index) => (
            <div className="shape-calib-row" key={item.id}>
              <div className="shape-calib-row-head">
                <strong>#{index + 1}</strong>
                <span className="shape-calib-status is-done">{formatTime(item.atMs)}</span>
                <button type="button" className="ghost-btn danger" onClick={() => remove(item.id)}>
                  删除
                </button>
              </div>
              <div className="shape-calib-detail">
                <span>
                  末端 {item.tipMm.map((value) => value.toFixed(1)).join(" / ")} mm
                </span>
                <span>
                  模型弯曲 {item.totalAngleDeg.toFixed(1)}° @ {item.directionDeg.toFixed(0)}°
                </span>
                <span>等效 κ {item.equivalentKappa.toFixed(3)} 1/m</span>
                <span>
                  段1 {item.section1Kappa.toFixed(2)} · 段2 {item.section2Kappa.toFixed(2)} 1/m
                </span>
                <span>最近样本 {item.distance.toFixed(3)}</span>
              </div>
              <div className="shape-calib-measured">
                <label>
                  目测弯曲角(°)
                  <input
                    type="number"
                    step="0.5"
                    value={item.measuredBendDeg}
                    onChange={(event) => updateMeasured(item.id, { measuredBendDeg: event.target.value })}
                  />
                </label>
                <label>
                  目测旋转角(°)
                  <input
                    type="number"
                    step="1"
                    value={item.measuredRotDeg}
                    onChange={(event) => updateMeasured(item.id, { measuredRotDeg: event.target.value })}
                  />
                </label>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

type ArmCalibrationTab = "calibrate" | "record";

export interface ArmCalibrationCardProps {
  deviceId: string;
  /** 记录的臂体初态（六路电机位置 mm）；相对下发与记录都需要 */
  initialState: number[] | null;
  ensureMotion: (what: string) => boolean;
  onCommandedTargets?: (targets: number[] | null) => void;
  onNotify: (message: string, tone?: "ok" | "warn" | "error") => void;
}

/** 臂体标定：一张卡片内切换「标定」与「记录」。 */
export function ArmCalibrationCard({
  deviceId,
  initialState,
  ensureMotion,
  onCommandedTargets,
  onNotify,
}: ArmCalibrationCardProps) {
  const [tab, setTab] = useState<ArmCalibrationTab>("calibrate");

  return (
    <div className="admin-card-content shape-calib">
      <div className="shape-calib-tabs" role="tablist" aria-label="臂体标定功能">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "calibrate"}
          className={`shape-calib-tab ${tab === "calibrate" ? "is-active" : ""}`}
          onClick={() => setTab("calibrate")}
        >
          标定
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "record"}
          className={`shape-calib-tab ${tab === "record" ? "is-active" : ""}`}
          onClick={() => setTab("record")}
        >
          记录
        </button>
      </div>

      <div role="tabpanel" aria-label="标定" style={tab === "calibrate" ? undefined : { display: "none" }}>
        <ShapeCalibrationPanel
          deviceId={deviceId}
          initialState={initialState}
          ensureMotion={ensureMotion}
          onCommandedTargets={onCommandedTargets}
          onNotify={onNotify}
        />
      </div>
      <div role="tabpanel" aria-label="记录" style={tab === "record" ? undefined : { display: "none" }}>
        <ArmCalibrationPanel
          deviceId={deviceId}
          initialState={initialState}
          onNotify={onNotify}
        />
      </div>
    </div>
  );
}
