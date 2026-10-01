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

export interface ModelStatus {
  /** `builtin` 或 `imported` */
  source: "builtin" | "imported";
  name: string | null;
  summary: string;
  bundleBytes: number;
  persistedPath: string | null;
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
