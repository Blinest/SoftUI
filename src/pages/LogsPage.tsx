import { useMemo, useState } from "react";
import { Logs } from "lucide-react";

import Badge from "../components/Badge";
import { LogDetailDrawer } from "../components/LogDetailDrawer";
import { LogFilterBar, type VisibleLogLevel } from "../components/LogFilterBar";
import { TableLayout } from "../layouts/TableLayout";
import type { LogEntry, RuntimeSnapshot } from "../softuiTypes";
import { isoShort, toneForLevel } from "../utils";
import "../styles/logs.css";

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
    () => Array.from(new Set(snapshot.logs.map((entry) => entry.scope))).sort(),
    [snapshot.logs],
  );

  const visibleLogs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return snapshot.logs.filter((entry) => {
      if (!levels.includes(entry.level)) return false;
      if (scope && entry.scope !== scope) return false;
      if (needle && !`${entry.message} ${entry.scope}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [levels, query, scope, snapshot.logs]);

  const selectedEntry: LogEntry | null =
    visibleLogs.find((entry) => entry.id === selectedId) ?? null;

  return (
    <TableLayout
      detailLabel="日志详情"
      toolbar={
        <LogFilterBar
          selectedLevels={levels}
          query={query}
          scope={scope}
          scopes={scopes}
          totalCount={snapshot.logs.length}
          visibleCount={visibleLogs.length}
          onLevelsChange={setLevels}
          onQueryChange={setQuery}
          onScopeChange={setScope}
          onExportDiagnostics={onExportDiagnostics}
        />
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
                <th scope="col">级别</th>
                <th scope="col">时间</th>
                <th scope="col">模块</th>
                <th scope="col">消息</th>
              </tr>
            </thead>
            <tbody>
              {visibleLogs.map((entry) => (
                <tr
                  className={entry.id === selectedId ? "is-selected" : undefined}
                  key={entry.id}
                  onClick={() => setSelectedId(entry.id)}
                >
                  <td><Badge tone={toneForLevel(entry.level)}>{entry.level.toUpperCase()}</Badge></td>
                  <td className="log-time-cell">{isoShort(entry.timestampMs)}</td>
                  <td className="log-scope-cell" title={entry.scope}>{entry.scope}</td>
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
