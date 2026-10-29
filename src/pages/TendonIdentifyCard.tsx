import { useCallback, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Cable, Download, RotateCcw } from "lucide-react";

import { downloadText, fileTimestamp } from "../utils/download";
import { wrapDeg180 } from "../robot/shapeCalibration";
import type { LiveLatest } from "../softuiTypes";

/**
 * **驱动丝识别** —— 判断"哪根丝接在哪个电机上、方向对不对"。
 *
 * 为什么需要它 ✗：
 *   模型包里的 6 路位移是按**丝的角度位置**排的 ✓（第 i 路 ↔ α = (i−1)×60°）✗，
 *   但实机的电机线序完全可能接错 ✗ —— 表现就是"命令向上弯、实际往别处弯"✓，
 *   而且这种错**不是旋转/镜像**：四个方向的偏差各不相同 ✓（现场数据正是如此 ✗）。
 *
 * 为什么不用"量弯曲角/位移"来标 ✗：
 *   角度尺只能量平面内的夹角 ✓，量不出"这一路丝在哪"✗；位移的绝对值又受预紧影响 ✗。
 *
 * 单丝点动为什么可靠 ✓：
 *   只动一根丝 2~3 mm，臂体一定**朝这根丝的一侧**弯 ✓（丝在弯曲内侧缩短 ✓）。
 *   观察一次弯曲方向 = 直接读出这根丝的角位置 ✓，不需要任何量具 ✓。
 *   六根各点一次，就得到完整的"电机 → 丝角度"映射（以及哪几路方向接反 ✓）。
 */

const TENDON_ALPHA_DEG = [0, 60, 120, 180, 240, 300];

const DIRECTION_OPTIONS = Array.from({ length: 12 }, (_, index) => {
  const deg = index * 30;
  const label =
    deg === 0 ? "上" : deg === 90 ? "右" : deg === 180 ? "下" : deg === 270 ? "左"
      : deg === 30 ? "上偏右" : deg === 60 ? "右上" : deg === 120 ? "右下" : deg === 150 ? "下偏右"
        : deg === 210 ? "下偏左" : deg === 240 ? "左下" : deg === 300 ? "左上" : "上偏左";
  return { deg, label };
});

interface TendonRow {
  motor: number;
  /** 记录基线时的电机位置（mm） */
  baseMm: number | null;
  /** 最近一次下发的目标（mm） */
  targetMm: number | null;
  /** 下发后回读的实际位置（mm）—— 用来判断"电机到底动没动" */
  actualMm: number | null;
  /** 观察到的弯曲方向（度） */
  observedDeg: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface TendonIdentifyCardProps {
  deviceId: string;
  ensureMotion: (what: string) => boolean;
  onNotify: (message: string, tone?: "ok" | "warn" | "error") => void;
}

export function TendonIdentifyCard({ deviceId, ensureMotion, onNotify }: TendonIdentifyCardProps) {
  const [rows, setRows] = useState<TendonRow[]>(() =>
    Array.from({ length: 6 }, (_, index) => ({
      motor: index + 1,
      baseMm: null,
      targetMm: null,
      actualMm: null,
      observedDeg: "",
    })),
  );
  const [deltaMm, setDeltaMm] = useState(3);
  const [speedMmPerSec, setSpeedMmPerSec] = useState(5);
  const [busy, setBusy] = useState<number | null>(null);

  const updateRow = useCallback((motor: number, patch: Partial<TendonRow>) => {
    setRows((previous) => previous.map((row) => (row.motor === motor ? { ...row, ...patch } : row)));
  }, []);

  /** 读当前 6 路位置，作为"点动基线"（复位用）。 */
  const captureBaseline = useCallback(async () => {
    if (!deviceId) {
      onNotify("未选择目标设备：请先在左栏连接设备", "warn");
      return;
    }
    try {
      const live = await invoke<LiveLatest>("fetch_live_latest");
      const motors = live.latest?.motors ?? [];
      if (motors.length === 0) {
        onNotify("没有收到设备状态帧，无法记录当前位置", "warn");
        return;
      }
      setRows((previous) =>
        previous.map((row) => {
          const motor = motors.find((item) => item.id === row.motor) ?? motors[row.motor - 1];
          const position = motor?.positionMm ?? null;
          return { ...row, baseMm: position, targetMm: position };
        }),
      );
      onNotify("已记录 6 路电机当前位置（作为点动基线）", "ok");
    } catch (error) {
      onNotify(`读取当前位置失败：${errorText(error)}`, "error");
    }
  }, [deviceId, onNotify]);

  const moveMotor = useCallback(
    async (motor: number, targetMm: number, what: string) => {
      if (!deviceId) {
        onNotify("未选择目标设备：请先在左栏连接设备", "warn");
        return;
      }
      if (!ensureMotion("驱动丝识别")) return;
      setBusy(motor);
      try {
        await invoke("send_motor_command", {
          request: {
            deviceId,
            motorId: motor,
            positionMm: targetMm,
            velocityMmPerSec: speedMmPerSec,
          },
        });
        updateRow(motor, { targetMm });
        // 回读实际位置：没动就是没动（没使能 / 接线 / 地址错），别让操作员对着一根不动的丝猜方向
        await sleep(900);
        let actual: number | null = null;
        try {
          const live = await invoke<LiveLatest>("fetch_live_latest");
          const motors = live.latest?.motors ?? [];
          const found = motors.find((item) => item.id === motor) ?? motors[motor - 1];
          actual = found?.positionMm ?? null;
        } catch {
          actual = null;
        }
        updateRow(motor, { actualMm: actual });
        if (actual != null && Math.abs(actual - targetMm) > 1.0) {
          onNotify(
            `${what}：电机 ${motor} 目标 ${targetMm.toFixed(1)} mm，实测 ${actual.toFixed(1)} mm —— ` +
            "没有到位，先检查使能/接线再判断方向",
            "warn",
          );
        } else {
          onNotify(
            `${what}：电机 ${motor} → ${targetMm.toFixed(1)} mm` +
            `${actual != null ? `（实测 ${actual.toFixed(1)} mm）` : ""}`,
            "ok",
          );
        }
      } catch (error) {
        onNotify(`电机 ${motor} 下发失败：${errorText(error)}`, "error");
      } finally {
        setBusy(null);
      }
    },
    [deviceId, ensureMotion, onNotify, speedMmPerSec, updateRow],
  );

  const restoreAll = useCallback(async () => {
    if (!deviceId) {
      onNotify("未选择目标设备：请先在左栏连接设备", "warn");
      return;
    }
    const pending = rows.filter((row) => row.baseMm != null && row.targetMm !== row.baseMm);
    if (pending.length === 0) return;
    if (!ensureMotion("复位电机")) return;
    for (const row of pending) {
      try {
        await invoke("send_motor_command", {
          request: {
            deviceId,
            motorId: row.motor,
            positionMm: row.baseMm,
            velocityMmPerSec: speedMmPerSec,
          },
        });
        updateRow(row.motor, { targetMm: row.baseMm, actualMm: row.baseMm });
      } catch (error) {
        onNotify(`电机 ${row.motor} 复位失败：${errorText(error)}`, "error");
      }
    }
    onNotify("已把点动过的电机送回基线位置", "ok");
  }, [deviceId, ensureMotion, onNotify, rows, speedMmPerSec, updateRow]);

  /** 每个电机实测方向与"表内第 i 路"的偏差。 */
  const analysis = useMemo(() => {
    return rows.map((row) => {
      const expected = TENDON_ALPHA_DEG[row.motor - 1];
      const observed = Number(row.observedDeg);
      const hasObserved = row.observedDeg.trim() !== "" && Number.isFinite(observed);
      const deviation = hasObserved ? wrapDeg180(observed - expected) : null;
      return { motor: row.motor, expected, observed: hasObserved ? observed : null, deviation };
    });
  }, [rows]);

  /** 由实测方向反推"表内第 j 路应该接哪个电机"。 */
  const mapping = useMemo(() => {
    const measured = analysis.filter((item) => item.observed != null);
    if (measured.length === 0) return [];
    return TENDON_ALPHA_DEG.map((alpha, index) => {
      let best: { motor: number; distance: number } | null = null;
      for (const item of measured) {
        const distance = Math.abs(wrapDeg180((item.observed as number) - alpha));
        if (!best || distance < best.distance) best = { motor: item.motor, distance };
      }
      return { tendon: index + 1, alpha, motor: best?.motor ?? null, distance: best?.distance ?? null };
    });
  }, [analysis]);

  const measuredCount = analysis.filter((item) => item.observed != null).length;
  const suspicious = analysis.filter(
    (item) => item.deviation != null && Math.abs(item.deviation) > 20,
  ).length;

  const exportCsv = useCallback(() => {
    const lines = [
      ["电机", "表内期望方向(deg)", "实测弯曲方向(deg)", "偏差(deg)", "基线位置(mm)", "目标(mm)", "实测(mm)"].join(","),
      ...rows.map((row) => {
        const expected = TENDON_ALPHA_DEG[row.motor - 1];
        const observed = row.observedDeg.trim() === "" ? null : Number(row.observedDeg);
        const deviation = observed != null && Number.isFinite(observed) ? wrapDeg180(observed - expected) : null;
        return [
          row.motor,
          expected,
          observed != null && Number.isFinite(observed) ? observed.toFixed(1) : "",
          deviation != null ? deviation.toFixed(1) : "",
          row.baseMm != null ? row.baseMm.toFixed(2) : "",
          row.targetMm != null ? row.targetMm.toFixed(2) : "",
          row.actualMm != null ? row.actualMm.toFixed(2) : "",
        ].join(",");
      }),
      "",
      ["表内第几路", "丝角度(deg)", "推断电机", "最近距离(deg)"].join(","),
      ...mapping.map((item) =>
        [item.tendon, item.alpha, item.motor ?? "", item.distance != null ? item.distance.toFixed(1) : ""].join(","),
      ),
    ];
    const stamp = fileTimestamp();
    downloadText(`驱动丝识别-${stamp}.csv`, lines.join("\r\n"));
    onNotify("已导出驱动丝识别结果", "ok");
  }, [mapping, onNotify, rows]);

  return (
    <div className="admin-card-content shape-calib">
      <div className="workspace-form-grid shape-calib-controls">
        <label className="workspace-field">
          <span>点动幅度(mm)</span>
          <input
            type="number"
            min={0.5}
            max={8}
            step={0.5}
            value={deltaMm}
            disabled={busy != null}
            onChange={(event) => {
              const next = Number(event.target.value);
              setDeltaMm(Number.isFinite(next) ? Math.min(8, Math.max(0.5, next)) : 3);
            }}
          />
        </label>
        <label className="workspace-field">
          <span>速度(mm/s)</span>
          <input
            type="number"
            min={1}
            max={20}
            step={1}
            value={speedMmPerSec}
            disabled={busy != null}
            onChange={(event) => {
              const next = Number(event.target.value);
              setSpeedMmPerSec(Number.isFinite(next) ? Math.min(20, Math.max(1, next)) : 5);
            }}
          />
        </label>
      </div>

      <p className="model-params-hint">
        只动<strong>一根丝</strong> {deltaMm} mm，臂体一定朝这根丝的一侧弯（丝在弯曲内侧缩短）。
        看清方向后在下拉框里选一个角度 —— 这样不用量角、也不用管位移绝对值。
        六根各做一次，就能判断电机线序是否与模型一致。
        <br />
        ⚠ 点动前先「记录当前位姿」，做完点「全部复位」；单丝点动会让臂体偏离原形状，注意运动范围。
      </p>

      <div className="workspace-action-row">
        <button type="button" className="primary-btn" onClick={() => { void captureBaseline(); }} disabled={busy != null || !deviceId}>
          <Cable size={15} />
          <span>记录当前位姿</span>
        </button>
        <button type="button" className="ghost-btn" onClick={() => { void restoreAll(); }} disabled={busy != null}>
          <RotateCcw size={15} />
          <span>全部复位</span>
        </button>
        <button type="button" className="ghost-btn" onClick={exportCsv} disabled={measuredCount === 0}>
          <Download size={15} />
          <span>导出 CSV</span>
        </button>
        <span className="shape-calib-summary">
          已识别 {measuredCount}/6
          {suspicious > 0 ? ` · ${suspicious} 路偏差 > 20°` : ""}
        </span>
      </div>

      <div className="shape-calib-list">
        {rows.map((row) => {
          const expected = TENDON_ALPHA_DEG[row.motor - 1];
          const observed = row.observedDeg.trim() === "" ? null : Number(row.observedDeg);
          const deviation = observed != null && Number.isFinite(observed) ? wrapDeg180(observed - expected) : null;
          return (
            <div className="shape-calib-row" key={row.motor}>
              <div className="shape-calib-row-head">
                <strong>电机 {row.motor}</strong>
                <span className="shape-calib-status">表内期望 α={expected}°</span>
                <span className={`shape-calib-status ${deviation == null ? "" : Math.abs(deviation) <= 20 ? "is-done" : "is-error"}`}>
                  {deviation == null ? "未识别" : `偏差 ${deviation >= 0 ? "+" : ""}${deviation.toFixed(0)}°`}
                </span>
              </div>

              <div className="shape-calib-measured">
                <div className="shape-calib-error">
                  <span>基线 / 目标 / 实测</span>
                  <strong style={{ fontSize: 12 }}>
                    {row.baseMm != null ? row.baseMm.toFixed(1) : "—"} /{" "}
                    {row.targetMm != null ? row.targetMm.toFixed(1) : "—"} /{" "}
                    {row.actualMm != null ? row.actualMm.toFixed(1) : "—"} mm
                  </strong>
                </div>
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={busy != null || row.baseMm == null}
                  onClick={() => { if (row.baseMm != null) void moveMotor(row.motor, row.baseMm + deltaMm, "点动 +Δ"); }}
                >
                  +{deltaMm} mm
                </button>
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={busy != null || row.baseMm == null}
                  onClick={() => { if (row.baseMm != null) void moveMotor(row.motor, row.baseMm - deltaMm, "点动 −Δ"); }}
                >
                  −{deltaMm} mm
                </button>
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={busy != null || row.baseMm == null || row.targetMm === row.baseMm}
                  onClick={() => { if (row.baseMm != null) void moveMotor(row.motor, row.baseMm, "复位"); }}
                >
                  复位
                </button>
                <label>
                  <span>实测弯曲方向</span>
                  <select
                    value={row.observedDeg}
                    onChange={(event) => updateRow(row.motor, { observedDeg: event.target.value })}
                  >
                    <option value="">未观察</option>
                    {DIRECTION_OPTIONS.map((option) => (
                      <option key={option.deg} value={option.deg}>
                        {option.deg}°（{option.label}）
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          );
        })}
      </div>

      {measuredCount > 0 ? (
        <div className="shape-calib-calib">
          <div className="shape-calib-calib-head">
            <strong>推断的丝序</strong>
            <span className="shape-calib-tag is-active">按实测方向最近匹配</span>
          </div>
          <p className="shape-calib-calib-hint">
            {mapping.map((item) =>
              `表内第 ${item.tendon} 路(α=${item.alpha}°) ← 电机 ${item.motor ?? "?"}` +
              `${item.distance != null ? `（差 ${item.distance.toFixed(0)}°）` : ""}`,
            ).join("；")}
            <br />
            如果映射不是 1→1、2→2…，就是**线序接反了**：按这里的顺序把模型下发的 6 路位移重排后再发即可。
            偏差接近 ±180° 的那一路，是**方向接反**（收/放相反），需要单独取反。
          </p>
        </div>
      ) : null}
    </div>
  );
}
