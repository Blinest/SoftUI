import { Search, X, Download } from "lucide-react";

import type { LogLevel } from "../softuiTypes";
import { PERMISSION_REASON } from "../state/permissions";

/** 用户可见的日志级别。内部 warn/error/info/debug 直接对应。 */
export type VisibleLogLevel = LogLevel;

export const LOG_LEVELS: Array<{ key: VisibleLogLevel; label: string }> = [
  { key: "warn", label: "警告" },
  { key: "error", label: "错误" },
  { key: "info", label: "信息" },
  { key: "debug", label: "调试" },
];

export interface LogFilterBarProps {
  selectedLevels: VisibleLogLevel[];
  query: string;
  scope: string;
  scopes: Array<{ value: string; label: string }>;
  totalCount: number;
  visibleCount: number;
  /** 已勾选的条数 ✓（左侧数字 ✓）*/
  selectedCount?: number;
  onLevelsChange: (levels: VisibleLogLevel[]) => void;
  onQueryChange: (value: string) => void;
  onScopeChange: (value: string) => void;
  onExportDiagnostics: () => void;
  /** 导出诊断包需要 viewDiagnostics（维护员及以上）。 */
  canExportDiagnostics: boolean;
}

/** 日志页筛选条：级别多选 + 模块 + 文本检索 + 诊断导出。 */
export function LogFilterBar({
  selectedLevels,
  query,
  scope,
  scopes,
  totalCount,
  visibleCount,
  selectedCount = 0,
  onLevelsChange,
  onQueryChange,
  onScopeChange,
  onExportDiagnostics,
  canExportDiagnostics,
}: LogFilterBarProps) {
  const toggleLevel = (level: VisibleLogLevel) => {
    onLevelsChange(
      selectedLevels.includes(level)
        ? selectedLevels.filter((item) => item !== level)
        : [...selectedLevels, level],
    );
  };

  return (
    <div className="logs-toolbar">
      <div className="logs-level-filters" role="group" aria-label="日志级别筛选">
        {LOG_LEVELS.map((level) => (
          <label className={`log-level-check log-level-check-${level.key}`} key={level.key}>
            <input
              type="checkbox"
              checked={selectedLevels.includes(level.key)}
              onChange={() => toggleLevel(level.key)}
            />
            <span>{level.label}</span>
          </label>
        ))}
      </div>

      <label className="logs-scope-filter">
        <span className="sr-only">模块</span>
        <select value={scope} onChange={(event) => onScopeChange(event.target.value)}>
          <option value="">全部模块</option>
          {scopes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>

      <div className="logs-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          placeholder="搜索消息或模块…"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        {query ? (
          <button type="button" className="ghost-btn-sm" aria-label="清空搜索" onClick={() => onQueryChange("")}>
            <X size={12} />
          </button>
        ) : null}
      </div>

      <button
        type="button"
        className="ghost-btn-sm"
        disabled={!canExportDiagnostics}
        title={canExportDiagnostics ? undefined : PERMISSION_REASON.viewDiagnostics}
        onClick={onExportDiagnostics}
      >
        <Download size={14} />
        <span>导出诊断</span>
      </button>

      <div className="logs-count">
        {/* **左侧就是已勾选数量** ✓（选中时高亮 ✓，没选中时淡一点 ✓）*/}
        <span className={selectedCount > 0 ? "is-selected" : undefined}>
          已选 <b>{selectedCount}</b> 条
        </span>
        <span className="logs-count-dim">显示 {visibleCount} / {totalCount} 条</span>
      </div>
    </div>
  );
}
