import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import {
  deleteModel,
  exportModelBase64,
  importModelBase64,
  listModels,
  saveModelParams,
  renameModel,
  selectModelPreset,
  type ModelLibraryEntry,
} from "../robot/modelBridge";

/**
 * 模型库管理弹窗。
 *
 * 设计取舍：
 * - **列表用 `id` 做 key**（slug ✓）、**显示 `name`**（可重命名 ✓）—— 两者必须分开 ✗，
 *   混用会出现"改名后删掉了别的模型"这类事故。
 * - **内建模型**：可导出 ✓、可设为当前 ✓，但**不能删 / 不能改名** ✗（后端已拒绝 ✓，
 *   这里也把按钮禁掉 ✓，避免用户点了才被拒）。
 * - 所有操作**成功后用后端返回的新列表刷新** ✓ —— 不在前端自己拼状态 ✗，
 *   否则和磁盘上的真实情况会漂移 ✗。
 */
/** 按关键词 + 材料过滤 ✓（关键词同时匹配名称 / 材料 / 备注 ✓）*/
function filteredEntries(
  entries: ModelLibraryEntry[],
  text: string,
  material: string,
): ModelLibraryEntry[] {
  const keyword = text.trim().toLowerCase();
  return entries.filter((entry) => {
    if (material && (entry.params?.material ?? "") !== material) return false;
    if (!keyword) return true;
    const haystack = [
      entry.name,
      entry.id,
      entry.params?.material ?? "",
      entry.params?.note ?? "",
      entry.params?.calibratedAt ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(keyword);
  });
}

export function ModelLibraryDialog({
  open = true,
  inline = false,
  onClose,
  onChanged,
}: {
  open?: boolean;
  /** 内联模式：作为页面内容直接铺开 ✓（不画遮罩 ✗）*/
  inline?: boolean;
  onClose?: () => void;
  /** 模型库变化后通知外层（例如刷新模型状态 ✓）。 */
  onChanged?: () => void;
}) {
  const [entries, setEntries] = useState<ModelLibraryEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** 筛选：关键词（名称 / 材料 / 备注）+ 材料下拉 ✓ */
  const [filterText, setFilterText] = useState("");
  const [filterMaterial, setFilterMaterial] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  /**
   * 待导入的模型：选好文件后**先填参数** ✓，确认才真正入库 ✓。
   * 参数存 sidecar ✓，不进 `.tdcrmodel` 二进制 ✗。
   */
  const [pendingImport, setPendingImport] = useState<{
    /** null = 编辑已有模型的参数（不需要文件 ✓） */
    file: File | null;
    /** 编辑模式下的模型 id ✓ */
    editId?: string;
    name: string;
    material: string;
    outerDiameterMm: string;
    wallThicknessMm: string;
    driveWireRadiusMm: string;
    tipForceN: string;
    lengthMm: string;
    weightG: string;
    calibratedAt: string;
    note: string;
  } | null>(null);


  const refresh = useCallback(async () => {
    try {
      setEntries(await listModels());
    } catch (error) {
      setMessage({ tone: "error", text: `读取模型库失败：${String(error)}` });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setMessage(null);
    void refresh();
  }, [open, refresh]);

  if (!open) return null;

  const run = async (key: string, action: () => Promise<ModelLibraryEntry[]>, okText: string) => {
    setBusy(key);
    try {
      setEntries(await action());
      setMessage({ tone: "ok", text: okText });
      onChanged?.();
    } catch (error) {
      setMessage({ tone: "error", text: String(error) });
    } finally {
      setBusy(null);
    }
  };

  /** 选好文件 → 打开参数表单 ✓（不再直接入库 ✗）。 */
  const handleImport = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setPendingImport({
      file,
      name: file.name.replace(/\.tdcrmodel$/i, ""),
      material: "硅胶",
      outerDiameterMm: "",
      wallThicknessMm: "",
      driveWireRadiusMm: "",
      tipForceN: "",
      lengthMm: "",
      weightG: "",
      calibratedAt: new Date().toISOString().slice(0, 10),
      note: "",
    });
  };

  /** 表单确认 → 真正导入 ✓（先传包，再存参数 ✓）。 */
  const confirmImport = async () => {
    const pending = pendingImport;
    if (!pending) return;
    setBusy("import");
    try {
      if (pending.editId) {
        // 编辑模式：包不动 ✓，只写参数 ✓
        const num = (v: string) => (v.trim() === "" ? null : Number(v));
        await saveModelParams(pending.editId, {
          lengthMm: num(pending.lengthMm),
          outerDiameterMm: num(pending.outerDiameterMm),
          wallThicknessMm: num(pending.wallThicknessMm),
          driveWireRadiusMm: num(pending.driveWireRadiusMm),
          material: pending.material || null,
          calibratedAt: pending.calibratedAt || null,
          weightG: num(pending.weightG),
          note: pending.note || null,
        });
        setEntries(await listModels());
        setPendingImport(null);
        setMessage({ tone: "ok", text: "参数已保存" });
        onChanged?.();
        return;
      }
      if (!pending.file) return;
      const buffer = await pending.file.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      await importModelBase64(btoa(binary), pending.name || undefined);
      // 找到刚导入的那条（按名字匹配 ✓），再写参数 ✓
      const list = await listModels();
      const created = list.find((entry) => !entry.builtin && entry.name === pending.name);
      if (created) {
        const num = (v: string) => (v.trim() === "" ? null : Number(v));
        await saveModelParams(created.id, {
          outerDiameterMm: num(pending.outerDiameterMm),
          wallThicknessMm: num(pending.wallThicknessMm),
          driveWireRadiusMm: num(pending.driveWireRadiusMm),
          tipForceN: num(pending.tipForceN),
          lengthMm: num(pending.lengthMm),
          material: pending.material || null,
          calibratedAt: pending.calibratedAt || null,
          weightG: num(pending.weightG),
          note: pending.note || null,
        });
      }
      setEntries(await listModels());
      setPendingImport(null);
      setMessage({ tone: "ok", text: `已导入：${pending.name}` });
      onChanged?.();
    } catch (error) {
      setMessage({ tone: "error", text: `导入失败：${String(error)}` });
    } finally {
      setBusy(null);
    }
  };

  const handleExport = async (entry: ModelLibraryEntry) => {
    setBusy(`export:${entry.id}`);
    try {
      const base64 = await exportModelBase64(entry.id);
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${entry.name || entry.id}.tdcrmodel`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMessage({ tone: "error", text: `导出失败：${String(error)}` });
    } finally {
      setBusy(null);
    }
  };

  const body = (
    <div className={`model-library-shell${inline ? " is-inline" : ""}`}>
      <div className="model-library-dialog">
        <header className="model-library-head">
          <h2>模型库管理</h2>
          <label className="model-library-import">
            <input
              type="file"
              accept=".tdcrmodel"
              disabled={busy === "import"}
              onChange={(event) => {
                void handleImport(event.target.files);
                event.target.value = "";
              }}
            />
            <span>{busy === "import" ? "导入中…" : "导入模型包"}</span>
          </label>
          <button type="button" className="ghost-btn" onClick={onClose}>
            关闭
          </button>
        </header>

        {/* 筛选条 ✓ —— 按名称 / 材料 / 备注过滤 ✓ */}
        <div className="model-library-filter">
          <input
            type="search"
            placeholder="筛选：名称 / 材料 / 备注"
            value={filterText}
            onChange={(event) => setFilterText(event.target.value)}
          />
          <select value={filterMaterial} onChange={(event) => setFilterMaterial(event.target.value)}>
            <option value="">全部材料</option>
            {Array.from(
              new Set(
                (entries ?? [])
                  .map((e) => e.params?.material ?? "")
                  .filter(Boolean),
              ),
            ).map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>

        {message ? (
          <p className={`model-library-message is-${message.tone}`}>{message.text}</p>
        ) : null}

        {!entries ? (
          <p className="model-library-empty">读取中…</p>
        ) : entries.length === 0 ? (
          <p className="model-library-empty">模型库是空的</p>
        ) : (
          <ul className="model-library-list">
            {filteredEntries(entries, filterText, filterMaterial).map((entry) => (
              <li key={entry.id} className={`model-library-item${entry.selected ? " is-selected" : ""}`}>
                <div className="model-library-main">
                  {renaming?.id === entry.id ? (
                    <span className="model-library-rename">
                      <input
                        autoFocus
                        value={renaming.value}
                        onChange={(event) => setRenaming({ id: entry.id, value: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            void run(
                              `rename:${entry.id}`,
                              () => renameModel(entry.id, renaming.value),
                              "已重命名",
                            ).then(() => setRenaming(null));
                          }
                          if (event.key === "Escape") setRenaming(null);
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          void run(
                            `rename:${entry.id}`,
                            () => renameModel(entry.id, renaming.value),
                            "已重命名",
                          ).then(() => setRenaming(null));
                        }}
                      >
                        确定
                      </button>
                      <button type="button" onClick={() => setRenaming(null)}>
                        取消
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="model-library-name"
                      onClick={() => {
                        if (entry.selected || busy !== null) return;
                        void (async () => {
                          setBusy(`select:${entry.id}`);
                          try {
                            await selectModelPreset(entry.id);
                            await refresh();
                            setMessage({ tone: "ok", text: `已切换到：${entry.name}` });
                            onChanged?.();
                          } catch (error) {
                            setMessage({ tone: "error", text: `切换失败：${String(error)}` });
                          } finally {
                            setBusy(null);
                          }
                        })();
                      }}
                      title={entry.selected ? "正在使用" : "点击切换到这个模型"}
                      disabled={busy !== null}
                    >
                      {entry.name}
                      {entry.builtin ? <em>内置</em> : null}
                      {entry.selected ? <em className="is-current">当前</em> : null}
                      {busy === `select:${entry.id}` ? <em>切换中…</em> : null}
                    </button>
                  )}
                  <span className="model-library-meta">
                    {(entry.bundleBytes / 1024).toFixed(0)} KB · κ {entry.kappaLimitPerM.toFixed(2)} · {entry.summary}
                  </span>
                  {/* 臂体参数摘要 ✓（导入时填的，方便一眼对比不同模型 ✓）*/}
                  {entry.params ? (
                    <span className="model-library-params">
                      {[
                        entry.params.outerDiameterMm != null ? `Ø${entry.params.outerDiameterMm}` : null,
                        entry.params.wallThicknessMm != null ? `壁厚 ${entry.params.wallThicknessMm}` : null,
                        entry.params.driveWireRadiusMm != null ? `丝径 r${entry.params.driveWireRadiusMm}` : null,
                        entry.params.tipForceN != null ? `尖端力 ${entry.params.tipForceN}N` : null,
                        entry.params.material,
                        entry.params.weightG != null ? `${entry.params.weightG}g` : null,
                        entry.params.calibratedAt ? `标定 ${entry.params.calibratedAt}` : null,
                      ].filter(Boolean).join(" · ") || "未填写参数"}
                    </span>
                  ) : null}
                </div>
                <div className="model-library-actions">
                  {/* 操作（下拉 ✓）：编辑参数 / 重命名 / 导出 / 删除 */}
                  <details className="model-library-menu">
                    <summary>操作</summary>
                    <button
                      type="button"
                      onClick={() => {
                        const p = entry.params ?? {};
                        const str = (v: number | null | undefined) => (v == null ? "" : String(v));
                        setPendingImport({
                          file: null,
                          editId: entry.id,
                          name: entry.name,
                          material: p.material ?? "硅胶",
                          outerDiameterMm: str(p.outerDiameterMm),
                          wallThicknessMm: str(p.wallThicknessMm),
                          driveWireRadiusMm: str(p.driveWireRadiusMm),
                          tipForceN: str(p.tipForceN),
                          lengthMm: str(p.lengthMm),
                          weightG: str(p.weightG),
                          calibratedAt: p.calibratedAt ?? "",
                          note: p.note ?? "",
                        });
                      }}
                    >
                      编辑臂体参数
                    </button>
                    <button
                      type="button"
                      disabled={entry.builtin || busy !== null}
                      onClick={() => setRenaming({ id: entry.id, value: entry.name })}
                    >
                      重命名
                    </button>
                    <button type="button" disabled={busy !== null} onClick={() => void handleExport(entry)}>
                      导出
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={entry.builtin || entry.selected || busy !== null}
                      onClick={() => {
                        if (!window.confirm(`确定删除「${entry.name}」？此操作不可撤销。`)) return;
                        void run(`delete:${entry.id}`, () => deleteModel(entry.id), "已删除");
                      }}
                    >
                      删除
                    </button>
                  </details>
                </div>              </li>
            ))}
          </ul>
        )}
      </div>

    </div>
  );

  // 参数表单：**单独 portal** ✓ —— shell 有 backdrop-filter，
  // 它会成为 fixed 的包含块，嵌套在里面 fixed 就会失效 ✗（表现：点了没反应 ✗）
  const paramsDialog = pendingImport ? createPortal(
        <div className="model-params-backdrop" role="dialog" aria-modal="true" aria-label="模型参数">
          <form
            className="model-params-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void confirmImport();
            }}
          >
            <h2>{pendingImport.editId ? "编辑臂体参数" : "导入模型包 · 臂体参数"}</h2>
            <p className="model-params-hint">这些只用于**管理**（不参与标定计算）✓，都可留空。</p>

            <div className="model-params-grid">
              <label>
                <span>臂长 mm</span>
                <input type="number" step="0.1" value={pendingImport.lengthMm}
                  onChange={(e) => setPendingImport({ ...pendingImport, lengthMm: e.target.value })} />
              </label>
              <label>
                <span>外径 mm</span>
                <input type="number" step="0.1" value={pendingImport.outerDiameterMm}
                  onChange={(e) => setPendingImport({ ...pendingImport, outerDiameterMm: e.target.value })} />
              </label>
              <label>
                <span>壁厚 mm</span>
                <input type="number" step="0.1" value={pendingImport.wallThicknessMm}
                  onChange={(e) => setPendingImport({ ...pendingImport, wallThicknessMm: e.target.value })} />
              </label>
              <label>
                <span>驱动丝半径 mm</span>
                <input type="number" step="0.01" value={pendingImport.driveWireRadiusMm}
                  onChange={(e) => setPendingImport({ ...pendingImport, driveWireRadiusMm: e.target.value })} />
              </label>
              <label>
                <span>额定尖端力 N</span>
                <input type="number" step="0.1" value={pendingImport.tipForceN}
                  onChange={(e) => setPendingImport({ ...pendingImport, tipForceN: e.target.value })}
                  placeholder="例如 20" />
              </label>
              <label>
                <span>材料</span>
                {/* 可自由输入 ✓（原来只能选固定的 5 种 ✗），已有材料作为候选 ✓ */}
                <input
                  list="model-material-options"
                  value={pendingImport.material}
                  onChange={(e) => setPendingImport({ ...pendingImport, material: e.target.value })}
                  placeholder="硅胶 / TPU / 自定义…"
                />
              </label>
              <label>
                <span>重量 g</span>
                <input type="number" step="0.1" value={pendingImport.weightG}
                  onChange={(e) => setPendingImport({ ...pendingImport, weightG: e.target.value })} />
              </label>
              <label>
                <span>标定日期</span>
                <input type="date" value={pendingImport.calibratedAt}
                  onChange={(e) => setPendingImport({ ...pendingImport, calibratedAt: e.target.value })} />
              </label>
            </div>

            {/* 材料候选：固定几种 + 库里已用过的 ✓（用户自己填的会出现在这里 ✓）*/}
            <datalist id="model-material-options">
              {Array.from(
                new Set([
                  "硅胶",
                  "TPU",
                  "尼龙",
                  "树脂",
                  "聚氨酯",
                  "其它",
                  ...(entries ?? []).map((e) => e.params?.material ?? "").filter(Boolean),
                ]),
              ).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>

            <label className="model-params-note">
              <span>备注</span>
              <textarea rows={2} value={pendingImport.note}
                onChange={(e) => setPendingImport({ ...pendingImport, note: e.target.value })} />
            </label>

            <div className="model-params-actions">
              <button type="button" className="ghost-btn" onClick={() => setPendingImport(null)}>取消</button>
              <button type="submit" className="ghost-btn" disabled={busy === "import"}>
                {busy === "import" ? "处理中…" : pendingImport.editId ? "保存" : "导入"}
              </button>
            </div>
          </form>
        </div>
  , document.body) : null;

  // 内联模式：直接铺在页面里 ✓；弹窗模式：挂到 body ✓（避开卡片的 transform ✗）
  const shell = inline ? body : createPortal(body, document.body);
  return (
    <>
      {shell}
      {paramsDialog}
    </>
  );
}
