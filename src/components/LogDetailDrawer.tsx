import { X } from "lucide-react";

import type { LogEntry } from "../softuiTypes";
import { isoFull } from "../utils";

export interface LogDetailDrawerProps {
  entry: LogEntry | null;
  onClose: () => void;
}

/** 日志详情抽屉：长消息与原始帧在这里完整展示，不再被表格列宽截断。 */
export function LogDetailDrawer({ entry, onClose }: LogDetailDrawerProps) {
  if (!entry) return null;

  return (
    <div className="log-detail-drawer">
      <header className="log-detail-head">
        <div>
          <span className="panel-kicker">详情</span>
          <h3>日志 #{entry.id}</h3>
        </div>
        <button type="button" className="ghost-btn-sm" aria-label="关闭日志详情" onClick={onClose}>
          <X size={13} />
        </button>
      </header>

      <dl className="log-detail-list">
        <div><dt>级别</dt><dd>{entry.level.toUpperCase()}</dd></div>
        <div><dt>时间</dt><dd>{isoFull(entry.timestampMs)}</dd></div>
        <div><dt>模块</dt><dd>{entry.scope}</dd></div>
        <div><dt>设备</dt><dd>{entry.deviceId ?? "—"}</dd></div>
      </dl>

      <div className="log-detail-message-row">
        <dt>消息</dt>
        <dd className="log-detail-message">{entry.message}</dd>
      </div>

      {entry.frameHex ? (
        <div className="log-detail-message-row">
          <dt>原始帧</dt>
          <dd className="log-detail-frame">{entry.frameHex}</dd>
        </div>
      ) : null}
    </div>
  );
}
