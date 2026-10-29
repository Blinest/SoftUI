import { useEffect, useMemo, useState } from "react";
import { Logs } from "lucide-react";

import Badge from "../components/Badge";
import { LogDetailDrawer } from "../components/LogDetailDrawer";
import { LogFilterBar, type VisibleLogLevel } from "../components/LogFilterBar";
import { TableLayout } from "../layouts/TableLayout";
import type { LogEntry, RuntimeSnapshot } from "../softuiTypes";
import { hasPermission } from "../state/permissions";
import { isoShort, toneForLevel } from "../utils";
import { readPolicyLog } from "../robot/policyEngine";
import { loadUiStore } from "../robot/uiStore";
import "../styles/logs.css";

/** 模块名 → 中文 ✓（后端 scope 是英文标识 ✓，界面上给中文 ✓）*/


const SCOPE_LABELS: Record<string, string> = {
  auth: "登录",
  login: "登录",
  control: "控制",
  connection: "连接",
  device: "设备",
  stream: "数据流",
  serial: "串口",
  audit: "审计",
  boot: "启动",
  policy: "策略",
  策略: "策略",
  test: "测试",
};

function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope;
}

export interface LogsPageProps {
  snapshot: RuntimeSnapshot;
  onExportDiagnostics: () => void;
}

/** 日志页：顶部筛选条 + 全高日志表 + 右侧详情抽屉。 */
export function LogsPage({ snapshot, onExportDiagnostics }: LogsPageProps) {
  const [levels, setLevels] = useState<VisibleLogLevel[]>(["warn", "error", "info", "debug"]);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const scopes = useMemo(
    () =>
      Array.from(new Set([...snapshot.logs.map((entry) => entry.scope), "策略"]))
        .map((scope) => ({ value: scope, label: scopeLabel(scope) }))
        .sort((a, b) => a.label.localeCompare(b.label, "zh-CN")),
    [snapshot.logs],
  );

  /**
   * **策略执行日志并进主表** ✓
   *   成功 → `info`（绿 ✓）
   *   失败 → `warn`（黄 ✓）
   */
  /** 后端同步过来的策略日志 ✓（localStorage 只是本地副本 ✗）*/
  const [policyRaw, setPolicyRaw] = useState(() => readPolicyLog());
  /** 日期输入 ✓ */
  const [purgeDate, setPurgeDate] = useState("");
  /** **已生效的日期筛选** ✓（点「筛选」才生效 ✓）*/
  const [dateFilter, setDateFilter] = useState("");
  /** 勾选的日志 id ✓（"清除选中的所有内容"用 ✓）*/
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  /**
   * **只有管理员能删日志** ✓
   *
   * ⚠ 这里必须看 `snapshot.authSession.role` ✓ ——
   * `getAuthRole()` 读的是模块变量 ✓，它只在工作台页被 `setAuthContext` 写入 ✗，
   * 日志页读到的永远是默认的 `operator` ✗（本次 bug ✓）。
   */
  const canDeleteLogs = snapshot.authSession.authenticated && snapshot.authSession.role === "admin";
  /** **显示已删除的** ✓（仅管理员 ✓）*/
  /** 视图：`logs` = 正常 ✓，`trash` = 回收站 ✓ */
  const [view, setView] = useState<"logs" | "trash">("logs");
  /** 刚删掉的 id ✓ —— 立刻生效 ✓，不用整页刷新 ✗（刷新会"闪一下"✓ 且体验差 ✗）*/
  const [justDeleted, setJustDeleted] = useState<Set<string>>(new Set());
  /** 已彻底删除的 ✓（本地隐藏 ✓，后端也抹掉了 ✓）*/
  const [purgedIds, setPurgedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    void (async () => {
      const remote = await loadUiStore<unknown[]>("policy-log");
      if (Array.isArray(remote) && remote.length > 0) {
        setPolicyRaw(remote as typeof policyRaw);
        try {
          window.localStorage.setItem("softui:policyLog", JSON.stringify(remote));
        } catch {
          /* 忽略 ✓ */
        }
      }
    })();
  }, []);

  const policyEntries: LogEntry[] = useMemo(
    () =>
      policyRaw.map((entry, index) => ({
        // 负数 id ✓ —— 避开真实日志的正数 id ✓
        id: -1 - index,
        level: entry.ok ? "info" : "warn",
        scope: "策略",
        message: `${entry.schemeName} · ${entry.target} · ${
          entry.ok ? entry.reason : `失败：${entry.error ?? "未知"}`
        }`,
        timestampMs: new Date(entry.at).getTime(),
      })),
    [policyRaw],
  );

  /** **当前视图的全部条目** ✓（不含级别/模块/日期/关键词筛选 ✓）*/
  const viewEntries = useMemo(() => {
    const isDeleted = (entry: LogEntry & { deleted?: boolean }) =>
      Boolean(entry.deleted) || justDeleted.has(String(entry.id));

    const devices = (snapshot.logs as unknown as Array<LogEntry & { deleted?: boolean }>)
      .filter((entry) => !purgedIds.has(String(entry.id)))
      .filter((entry) => (view === "trash" ? isDeleted(entry) : !isDeleted(entry)));

    // **回收站只放设备日志** ✓ —— 策略日志删掉就是删掉 ✗
    const all = view === "trash" ? devices : [...policyEntries, ...devices];
    return all.sort((a, b) => b.timestampMs - a.timestampMs);
  }, [snapshot.logs, policyEntries, justDeleted, purgedIds, view]);

  const visibleLogs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // **合并** ✓ —— 策略日志 + 设备日志 ✓，按时间倒序 ✓
    /**
     * **两个视图严格互斥** ✓：
     *   日志视图 → 只要**没删**的 ✓
     *   回收站   → 只要**已删**的 ✓（服务器标记 ✓ 或 本地刚删 ✓）
     */
    return viewEntries.filter((entry) => {
      if (dateFilter && new Date(entry.timestampMs).toISOString().slice(0, 10) !== dateFilter) return false;
      if (!levels.includes(entry.level)) return false;
      if (scope && entry.scope !== scope) return false;
      if (needle && !`${entry.message} ${entry.scope}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [levels, query, scope, dateFilter, viewEntries]);


  const selectedEntry: LogEntry | null =
    visibleLogs.find((entry) => entry.id === selectedId) ?? null;

  return (
    <TableLayout
      detailLabel="日志详情"
      toolbar={
        <>
          <div className="logs-view-switch">
        <button
          type="button"
          className={view === "logs" ? "is-active" : ""}
          onClick={() => setView("logs")}
        >
          日志
        </button>
        <button
          type="button"
          className={view === "trash" ? "is-active" : ""}
          onClick={() => setView("trash")}
        >
          回收站
        </button>
      </div>

      <div className="logs-purge">
        <span>日志筛选</span>
        <input
          type="date"
          value={purgeDate}
          onChange={(event) => setPurgeDate(event.target.value)}
          title="按日期筛选"
        />
        <button
          type="button"
          className="ghost-btn"
          onClick={() => setDateFilter(purgeDate)}
          title="只看这一天的日志"
        >
          筛选
        </button>
        {dateFilter ? (
          <button type="button" className="ghost-btn" onClick={() => setDateFilter("")} title="取消日期筛选">
            取消筛选
          </button>
        ) : null}
        {canDeleteLogs ? (
          view === "trash" ? (
            <>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  if (selectedIds.size === 0) {
                    window.alert("先勾选要恢复的日志");
                    return;
                  }
                  const ids = Array.from(selectedIds)
                    .map((id) => Number(id))
                    .filter((id) => Number.isFinite(id) && id > 0);
                  // 本地立刻恢复 ✓
                  const local = new Set(justDeleted);
                  for (const id of selectedIds) local.delete(id);
                  setJustDeleted(local);
                  if (ids.length > 0) {
                    void import("@tauri-apps/api/core").then(({ invoke }) =>
                      invoke("restore_logs", { ids }),
                    );
                  }
                  setSelectedIds(new Set());
                }}
              >
                恢复选中
              </button>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  if (selectedIds.size === 0) {
                    window.alert("先勾选要彻底删除的日志");
                    return;
                  }
                  if (!window.confirm(`彻底删除选中的 ${selectedIds.size} 条？无法恢复。`)) return;
                  const ids = Array.from(selectedIds)
                    .map((id) => Number(id))
                    .filter((id) => Number.isFinite(id) && id > 0);
                  // 本地立刻隐藏 ✓
                  setPurgedIds((prev) => {
                    const next = new Set(prev);
                    for (const id of selectedIds) next.add(id);
                    return next;
                  });
                  if (ids.length > 0) {
                    void import("@tauri-apps/api/core").then(({ invoke }) =>
                      invoke("purge_logs", { ids }),
                    );
                  }
                  setSelectedIds(new Set());
                }}
              >
                彻底删除选中
              </button>
            </>
          ) : (
            <button
              type="button"
              className="ghost-btn"
              onClick={() => {
                if (selectedIds.size === 0) {
                  window.alert("先勾选要清除的日志");
                  return;
                }
                if (!window.confirm(`清除选中的 ${selectedIds.size} 条日志？`)) return;
                // 策略日志 → 真删 ✓
                const keepPolicy = policyRaw.filter((_, index) => !selectedIds.has(String(-1 - index)));
                setPolicyRaw(keepPolicy);
                try {
                  window.localStorage.setItem("softui:policyLog", JSON.stringify(keepPolicy));
                } catch {
                  /* 忽略 ✓ */
                }
                void import("../robot/uiStore").then(({ saveUiStore }) =>
                  saveUiStore("policy-log", keepPolicy),
                );
                // 设备日志 → 软删 ✓（进回收站 ✓）
                const numeric = Array.from(selectedIds)
                  .map((id) => Number(id))
                  .filter((id) => Number.isFinite(id) && id > 0);
                if (numeric.length > 0) {
                  const local = new Set(justDeleted);
                  for (const id of numeric) local.add(String(id));
                  setJustDeleted(local);
                  void import("@tauri-apps/api/core").then(({ invoke }) =>
                    invoke("delete_logs", { ids: numeric }).catch(() => {
                      const revert = new Set(justDeleted);
                      for (const id of numeric) revert.delete(String(id));
                      setJustDeleted(revert);
                    }),
                  );
                }
                setSelectedIds(new Set());
              }}
            >
              清除选中的所有内容
            </button>
          )
        ) : (
          <em className="logs-filter-active">删除日志需要管理员权限</em>
        )}
        {dateFilter ? <em className="logs-filter-active">筛选中：{dateFilter}</em> : null}
      </div>

      <LogFilterBar
          selectedLevels={levels}
          query={query}
          scope={scope}
          scopes={scopes}
          totalCount={viewEntries.length}
          visibleCount={visibleLogs.length}
          selectedCount={selectedIds.size}
          onLevelsChange={setLevels}
          onQueryChange={setQuery}
          onScopeChange={setScope}
          onExportDiagnostics={onExportDiagnostics}
          canExportDiagnostics={hasPermission(snapshot, "viewDiagnostics")}
        />
        </>
      }
      detail={selectedEntry ? <LogDetailDrawer entry={selectedEntry} onClose={() => setSelectedId(null)} /> : undefined}
    >
      {visibleLogs.length === 0 ? (
        <div className="logs-empty">
          <Logs aria-hidden="true" size={22} />
          <strong>没有符合条件的日志</strong>
          <span>试试放宽级别筛选，或清空搜索关键词。</span>
        </div>
      ) : (
        <div className="logs-table-region">
          <table className="logs-table">
            <thead>
              <tr>
                <th scope="col" className="log-check-cell">
                  <input
                    type="checkbox"
                    disabled={!canDeleteLogs}
                    checked={visibleLogs.length > 0 && visibleLogs.every((e) => selectedIds.has(String(e.id)))}
                    onChange={(event) => {
                      setSelectedIds(
                        event.target.checked ? new Set(visibleLogs.map((e) => String(e.id))) : new Set(),
                      );
                    }}
                    aria-label="全选"
                  />
                </th>
                <th scope="col">级别</th>
                <th scope="col">时间</th>
                <th scope="col">模块</th>
                <th scope="col">消息</th>
              </tr>
            </thead>
            <tbody>
              {visibleLogs.map((entry) => (
                <tr
                  className={[
                    entry.id === selectedId ? "is-selected" : "",
                    justDeleted.has(String(entry.id)) || (entry as unknown as { deleted?: boolean }).deleted ? "is-deleted" : "",
                  ].filter(Boolean).join(" ") || undefined}
                  key={entry.id}
                  onClick={() => setSelectedId(entry.id)}
                >
                  <td className="log-check-cell">
                    <input
                      type="checkbox"
                      disabled={!canDeleteLogs}
                      checked={selectedIds.has(String(entry.id))}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => {
                        const next = new Set(selectedIds);
                        if (event.target.checked) next.add(String(entry.id));
                        else next.delete(String(entry.id));
                        setSelectedIds(next);
                      }}
                      aria-label="选中这条日志"
                    />
                  </td>
                  <td><Badge tone={toneForLevel(entry.level)}>{entry.level.toUpperCase()}</Badge></td>
                  <td className="log-time-cell">{isoShort(entry.timestampMs)}</td>
                  <td className="log-scope-cell" title={entry.scope}>{scopeLabel(entry.scope)}</td>
                  <td className="log-message-cell">
                    <button type="button" onClick={() => setSelectedId(entry.id)} title={entry.message}>
                      {entry.message}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </TableLayout>
  );
}
