/**
 * **模型位移 ↔ 实机电机位移的增益**（标定用）。
 *
 * 现场现象：方向已对，但**实际曲率比理论曲率大** —— 同样的模型 dL，
 * 实机弯得更多。等价于实机的“每 mm 位移 → 弯曲”比模型更灵敏。
 *
 * 用法（两条路必须同一个 k）：
 *   · 下发：电机 = 初态 + (dL_straight − dL) / k
 *   · 反查：dL   = dL_straight − k × (电机 − 初态)
 *
 * k > 1：实机偏灵敏（实际曲率偏大），把下发的位移缩小；
 * k = 1：不补偿；k < 1：实机偏迟钝时用。
 */
import { useEffect, useState } from "react";

const STORAGE_KEY = "softui:displacement-gain";
const MIN_GAIN = 0.2;
const MAX_GAIN = 10;

function clampGain(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(MAX_GAIN, Math.max(MIN_GAIN, value));
}

function readStoredGain(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw == null) return 1;
    return clampGain(Number(raw));
  } catch {
    return 1;
  }
}

let currentGain = readStoredGain();
const listeners = new Set<(value: number) => void>();

export function getDisplacementGain(): number {
  return currentGain;
}

export function setDisplacementGain(value: number): void {
  currentGain = clampGain(value);
  try {
    window.localStorage.setItem(STORAGE_KEY, String(currentGain));
  } catch {
    /* 存不了就只在本页生效 */
  }
  listeners.forEach((listener) => listener(currentGain));
}

/** React hook：读写增益，跨组件同步。 */
export function useDisplacementGain(): [number, (value: number) => void] {
  const [value, setValue] = useState<number>(getDisplacementGain);
  useEffect(() => {
    const listener = (next: number) => setValue(next);
    listeners.add(listener);
    listener(getDisplacementGain());
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return [value, setDisplacementGain];
}
