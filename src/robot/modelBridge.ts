import { invoke } from "@tauri-apps/api/core";

/**
 * 模型包（`.tdcrmodel`）管理。
 *
 * 表原本用 `include_bytes!` 在编译期焊进二进制，换模型必须重编译。导入接口让模型
 * 在**运行时可替换**：校验通过后写入可执行文件同目录的 `model.tdcrmodel`，
 * 下次启动自动加载；「恢复内置」则删除该文件。
 *
 * 包内是 6 段（κ 表 / 位姿表 / 形状表 × 40N/60N），生成方式见
 * `tools/build_model_bundle.py`。
 */

/** 可选模型包（后端内置的预设）。 */
export interface ModelPresetInfo {
  id: string;
  /** 展示名，含档位与日期，例如 `TDCR-v1(20/40N)-2026-10-20`。 */
  name: string;
  /** 该包支持的两档张力上限（N）。 */
  gauges: number[];
  active: boolean;
}

export async function fetchModelPresets(): Promise<ModelPresetInfo[]> {
  return invoke<ModelPresetInfo[]>("list_model_presets", {});
}

/** 选中一个模型包（后端会校验、落盘并立即生效）。 */
export async function selectModelPreset(id: string): Promise<ModelStatus> {
  return invoke<ModelStatus>("select_model", { id });
}

/** 由驱动丝位移反查的表内形状。 */
export interface TableShape {
  /** 12 个节点的 κx / κy（1/m）。 */
  kxPerM: number[];
  kyPerM: number[];
  /** 每段长度（mm）。跟随模型（旧臂 37.10 / 新臂 33.33）。 */
  segmentMm: number;
  /** 归一化后的最近邻距离，越小越接近表内样本。 */
  nearest: number;
}

/**
 * 按**驱动丝位移**查表，拿到表里真实存在的形状。
 *
 * 显示以它为主（准 ✓）；它没回来时用 SDM 兜底（顺 ✓，保证不跳变/不空白）。
 */
export async function fetchShapeFromDisplacements(displacementMm: number[]): Promise<TableShape | null> {
  const values = await invoke<number[]>("shape_from_displacements", { displacementMm });
  if (!Array.isArray(values) || values.length < 26) return null;
  const nearest = values[values.length - 2];
  const segmentMm = values[values.length - 1];
  const nodes = values.slice(0, values.length - 2);
  return {
    kxPerM: nodes.filter((_, index) => index % 2 === 0),
    kyPerM: nodes.filter((_, index) => index % 2 === 1),
    segmentMm,
    nearest,
  };
}

export interface ModelStatus {
  /** `builtin` 或 `imported` */
  source: "builtin" | "imported";
  name: string | null;
  summary: string;
  bundleBytes: number;
  persistedPath: string | null;
  /**
   * UI 侧运动范围上限（1/m，单段）。
   *
   * 由后端从当前生效模型（内置包或导入的 `.tdcrmodel`）的 κ 表覆盖范围里扫出来 ——
   * 拖动反解、等效折算、下发前检查都用它，不再用写死的「85°/段长 ≈ 7.85」。
   * 超出这个值的形状后端查不到，下发只会回一句「曲率超出 κ 表覆盖范围」。
   */
  kappaLimitPerM: number;
  /**
   * 8 个方向各自的覆盖上限（0°, 45°, … 315°）。
   *
   * `kappaLimitPerM` 是这 8 个的**最小值** ✗ —— 宽的方位实际能弯到 ~1.9。
   * 老后端可能不返回该字段，所以是可选的 ✓。
   */
  kappaLimitByDirection?: number[];
}

/** 查询当前生效的模型。 */
export async function fetchModelStatus(): Promise<ModelStatus> {
  return invoke<ModelStatus>("model_status");
}

/** 导入模型包并立即生效。 */
export async function importModelFromFile(file: File): Promise<ModelStatus> {
  const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
  return invoke<ModelStatus>("import_model", { bytes, name: file.name });
}

/** 恢复内置默认模型。 */
export async function resetModel(): Promise<ModelStatus> {
  return invoke<ModelStatus>("reset_model");
}

/* ── 模型库管理（增删改查导）───────────────────────────────────────── */

/** 模型包的臂体参数（导入时填写 ✓，存在 sidecar 里 ✓）。 */
export interface ModelParams {
  /** 臂长（mm）—— 导入时可从包内自动带出 ✓ */
  lengthMm?: number | null;
  outerDiameterMm?: number | null;
  wallThicknessMm?: number | null;
  driveWireRadiusMm?: number | null;
  /** 额定尖端力（N） */
  tipForceN?: number | null;
  material?: string | null;
  calibratedAt?: string | null;
  weightG?: number | null;
  note?: string | null;
}

/** 保存模型参数（内建模型会被后端拒绝 ✓）。 */
export async function saveModelParams(id: string, params: ModelParams): Promise<ModelLibraryEntry[]> {
  return invoke<ModelLibraryEntry[]>("save_model_params", { id, params });
}

/** 模型库条目：内建预设 + 用户导入的。 */
export interface ModelLibraryEntry {
  /** slug（文件名），用作 key；内建预设用 preset id。 */
  id: string;
  /** 显示名（可重命名）。 */
  name: string;
  bundleBytes: number;
  summary: string;
  kappaLimitPerM: number;
  kappaLimitByDirection: number[];
  /** 内建模型**不可删除 / 不可重命名** ✓。 */
  builtin: boolean;
  selected: boolean;
  /** 臂体参数（内建为 null ✓） */
  params?: ModelParams | null;
  /** 臂总长（mm ✓）—— 内建来自预设常量 ✓，用户模型来自参数 ✓，未填则 undefined ✓ */
  totalLengthMm?: number | null;
}

/**
 * **模型库列表** ✓ —— 结果**一定是数组** ✓。
 *
 * 为什么要在这一层兜 ✗：`models` 直接进组件的渲染路径（`models.find(...)` ✓），
 * 一旦上游给的不是数组（RPC 返回了包了一层的对象 / 走仿真兜底 / 后端刚重启 ✓），
 * 就是 `s.find is not a function` ✗ → **整页白屏**✗（实际踩到 ✓）。
 * 这里统一归一化 ✓，上层永远拿到数组 ✓。
 */
export async function listModels(): Promise<ModelLibraryEntry[]> {
  const raw = await invoke<unknown>("list_models");
  if (Array.isArray(raw)) return raw as ModelLibraryEntry[];
  const nested = (raw as { models?: unknown } | null)?.models;
  if (Array.isArray(nested)) return nested as ModelLibraryEntry[];
  console.warn("[models] list_models 返回了非数组，按空列表处理", raw);
  return [];
}

export async function deleteModel(id: string): Promise<ModelLibraryEntry[]> {
  return invoke<ModelLibraryEntry[]>("delete_model", { id });
}

export async function renameModel(id: string, name: string): Promise<ModelLibraryEntry[]> {
  return invoke<ModelLibraryEntry[]>("rename_model", { id, name });
}

/** 导出为 base64（内建也能导出 ✓）。 */
export async function exportModelBase64(id: string): Promise<string> {
  return invoke<string>("export_model", { id });
}

/**
 * 以 base64 导入模型包。
 *
 * 必须走 base64 ✗ —— 直接把 `Uint8Array` 交给 RPC 会被序列化成几十万个数字（体积 ×3 ✗）。
 */
export async function importModelBase64(data: string, name?: string): Promise<ModelStatus> {
  return invoke<ModelStatus>("import_model_base64", { data, name });
}
