import { useMemo, useState } from "react";
import type { RecorderStatus, SessionInfo } from "../softuiTypes";
import { Activity, Database, Download, Play, PauseCircle, SkipForward, Trash2, Edit3, Search, X } from "lucide-react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  createColumnHelper,
  flexRender,
  type SortingState,
} from "@tanstack/react-table";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDurationSecs(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m${s}s` : `${s}s`;
}

interface SessionsPageProps {
  sessions: SessionInfo[];
  recorderStatus: RecorderStatus;
  onToggleRecording: () => void;
  onPauseRecording: () => void;
  onResumeRecording: () => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, name: string) => void;
  onExportCsv: (id: string) => void;
  onLoadPlayback: (id: string) => void;
}

export default function SessionsPage({
  sessions,
  recorderStatus,
  onToggleRecording,
  onPauseRecording,
  onResumeRecording,
  onDeleteSession,
  onRenameSession,
  onExportCsv,
  onLoadPlayback,
}: SessionsPageProps) {
  const [sessionName, setSessionName] = useState("");
  const [globalFilter, setGlobalFilter] = useState("");
  const [sorting, setSorting] = useState<SortingState>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const columnHelper = createColumnHelper<SessionInfo>();

  const columns = useMemo(
    () => [
      columnHelper.accessor("name", {
        header: "会话名称",
        cell: (info) => (
          <span style={{ fontWeight: 600 }}>{info.getValue()}</span>
        ),
      }),
      columnHelper.accessor("frameCount", {
        header: "帧数",
        cell: (info) => info.getValue().toLocaleString(),
      }),
      columnHelper.accessor("fileSize", {
        header: "大小",
        cell: (info) => formatBytes(info.getValue()),
      }),
      columnHelper.accessor("operator", {
        header: "操作员",
        cell: (info) => info.getValue() ?? "—",
      }),
      columnHelper.accessor("startTime", {
        header: "开始时间",
        cell: (info) => {
          const v = info.getValue();
          if (!v) return "—";
          try {
            return new Date(v).toLocaleString("zh-CN");
          } catch {
            return v;
          }
        },
      }),
      columnHelper.display({
        id: "actions",
        header: "操作",
        cell: (info) => {
          const s = info.row.original;
          const isRenaming = renamingId === s.id;
          return (
            <div className="session-actions">
              {isRenaming ? (
                <div className="session-rename-inline">
                  <input
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && renameValue.trim()) {
                        onRenameSession(s.id, renameValue.trim());
                        setRenamingId(null);
                      }
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                  />
                  <button
                    type="button"
                    className="ghost-btn-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (renameValue.trim()) {
                        onRenameSession(s.id, renameValue.trim());
                        setRenamingId(null);
                      }
                    }}
                    title="确认"
                  >
                    <X size={12} />
                  </button>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className="ghost-btn-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onLoadPlayback(s.id);
                    }}
                    title="加载回放"
                  >
                    <Play size={12} />
                  </button>
                  <button
                    type="button"
                    className="ghost-btn-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onExportCsv(s.id);
                    }}
                    title="导出 CSV"
                  >
                    <Download size={12} />
                  </button>
                  <button
                    type="button"
                    className="ghost-btn-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenamingId(s.id);
                      setRenameValue(s.name);
                    }}
                    title="重命名"
                  >
                    <Edit3 size={12} />
                  </button>
                  {confirmDeleteId === s.id ? (
                    <div className="session-confirm-delete">
                      <span>确认删除?</span>
                      <button
                        type="button"
                        className="ghost-btn-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteSession(s.id);
                          setConfirmDeleteId(null);
                        }}
                      >
                        是
                      </button>
                      <button
                        type="button"
                        className="ghost-btn-sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDeleteId(null);
                        }}
                      >
                        否
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="ghost-btn-sm danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDeleteId(s.id);
                      }}
                      title="删除"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </>
              )}
            </div>
          );
        },
      }),
    ],
    [renamingId, renameValue, confirmDeleteId, onDeleteSession, onRenameSession, onExportCsv, onLoadPlayback],
  );

  const table = useReactTable({
    data: sessions,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <div className="sessions-page-layout">
      {/* Left: Recording control panel */}
      <aside className="sessions-sidebar">
        <div className="panel">
          <div className="panel-head">
            <div>
              <div className="panel-kicker">recorder</div>
              <h2>录制控制</h2>
            </div>
            <Activity size={16} />
          </div>

          <div className="sessions-recorder-status">
            <div className="status-strip-item">
              <span className="status-strip-label">状态</span>
              <strong style={{ color: recorderStatus.active ? (recorderStatus.paused ? "#f4c86d" : "#73e39d") : "inherit" }}>
                {recorderStatus.active ? (recorderStatus.paused ? "已暂停" : "录制中") : "空闲"}
              </strong>
            </div>
            {recorderStatus.active ? (
              <>
                <div className="status-strip-item">
                  <span className="status-strip-label">帧数</span>
                  <strong>{recorderStatus.frameCount.toLocaleString()}</strong>
                </div>
                <div className="status-strip-item">
                  <span className="status-strip-label">已用时间</span>
                  <strong>{formatDurationSecs(recorderStatus.elapsedSecs)}</strong>
                </div>
              </>
            ) : null}
          </div>

          <div className="sessions-recorder-actions">
            {!recorderStatus.active ? (
              <>
                <div className="sessions-name-input">
                  <label>
                    <span>会话名称</span>
                    <input
                      type="text"
                      placeholder="可选，留空自动命名"
                      value={sessionName}
                      onChange={(e) => setSessionName(e.target.value)}
                    />
                  </label>
                </div>
                <button
                  type="button"
                  className="primary-btn full"
                  onClick={() => {
                    onToggleRecording();
                    setSessionName("");
                  }}
                >
                  <Activity size={16} />
                  <span>开始录制</span>
                </button>
              </>
            ) : (
              <div className="sessions-recorder-btn-group">
                {recorderStatus.paused ? (
                  <button type="button" className="primary-btn full" onClick={onResumeRecording}>
                    <Play size={16} />
                    <span>继续录制</span>
                  </button>
                ) : (
                  <button type="button" className="ghost-btn full" onClick={onPauseRecording}>
                    <PauseCircle size={16} />
                    <span>暂停</span>
                  </button>
                )}
                <button type="button" className="ghost-btn full" onClick={onToggleRecording}>
                  <SkipForward size={16} />
                  <span>停止录制</span>
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <div>
              <div className="panel-kicker">stats</div>
              <h2>录制统计</h2>
            </div>
            <Database size={16} />
          </div>
          <div className="sessions-recorder-status">
            <div className="status-strip-item">
              <span className="status-strip-label">总会话数</span>
              <strong>{sessions.length}</strong>
            </div>
            <div className="status-strip-item">
              <span className="status-strip-label">当前会话</span>
              <strong>{recorderStatus.sessionName || "—"}</strong>
            </div>
          </div>
        </div>
      </aside>

      {/* Right: Session history table */}
      <main className="sessions-main">
        <div className="panel wide">
          <div className="panel-head">
            <div>
              <div className="panel-kicker">sessions</div>
              <h2>历史会话</h2>
            </div>
            <div className="sessions-search">
              <Search size={14} />
              <input
                type="text"
                placeholder="搜索名称/操作员..."
                value={globalFilter}
                onChange={(e) => setGlobalFilter(e.target.value)}
              />
              {globalFilter ? (
                <button type="button" className="ghost-btn-sm" onClick={() => setGlobalFilter("")}>
                  <X size={12} />
                </button>
              ) : null}
            </div>
          </div>

          {sessions.length === 0 ? (
            <div className="sessions-empty">
              <p>暂无录制数据。开始录制后，会话将显示在此处。</p>
            </div>
          ) : (
            <div className="sessions-table-wrap">
              <table className="sessions-table">
                <thead>
                  {table.getHeaderGroups().map((headerGroup) => (
                    <tr key={headerGroup.id}>
                      {headerGroup.headers.map((header) => (
                        <th
                          key={header.id}
                          onClick={header.column.getToggleSortingHandler()}
                          style={{ cursor: "pointer", userSelect: "none" }}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {{ asc: " ▲", desc: " ▼" }[header.column.getIsSorted() as string] ?? ""}
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody>
                  {table.getRowModel().rows.map((row) => (
                    <tr key={row.id}>
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="sessions-footer">
            <span>
              显示 {table.getRowModel().rows.length} / {sessions.length} 个会话
            </span>
          </div>
        </div>
      </main>
    </div>
  );
}
