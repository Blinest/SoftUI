import { useCallback, useEffect, useRef, useState } from "react";
import type { PlaybackStatus } from "../softuiTypes";
import {
  Play,
  PauseCircle,
  Square,
  SkipBack,
  SkipForward,
  AlertTriangle,
} from "lucide-react";

interface PlaybackBarProps {
  status: PlaybackStatus;
  onPlayPause: () => void;
  onStop: () => void;
  onSeek: (ms: number) => void;
  onStepForward: () => void;
  onStepBackward: () => void;
  onSetSpeed: (speed: number) => void;
}

const SPEEDS = [0.25, 0.5, 1, 2, 4];

function formatTime(ms: number): string {
  const totalSec = ms / 1000;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, "0")}:${sec.toFixed(1).padStart(4, "0")}`;
}

export default function PlaybackBar({
  status,
  onPlayPause,
  onStop,
  onSeek,
  onSetSpeed,
}: PlaybackBarProps) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleTimelineClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!timelineRef.current || status.durationMs === 0) return;
      const rect = timelineRef.current.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      const ms = pct * status.durationMs;
      onSeek(Math.round(ms));
    },
    [status.durationMs, onSeek],
  );

  // Drag-to-seek
  const handleMouseDown = useCallback(() => setDragging(true), []);
  useEffect(() => {
    if (!dragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      if (!timelineRef.current || status.durationMs === 0) return;
      const rect = timelineRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const ms = pct * status.durationMs;
      onSeek(Math.round(ms));
    };
    const handleMouseUp = () => setDragging(false);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging, status.durationMs, onSeek]);

  return (
    <div className={`playback-bar ${status.active ? "active" : ""}`}>
      {/* Warning banner */}
      <div className="playback-banner">
        <AlertTriangle size={14} />
        <span>
          回放模式 — 显示的是历史数据，不会向真实设备发送控制命令
        </span>
      </div>

      {/* Transport controls */}
      <div className="playback-controls">
        <div className="playback-btn-group">
          <button
            type="button"
            className="playback-btn"
            onClick={() => onSeek(0)}
            title="跳转到开头"
          >
            <SkipBack size={16} />
          </button>
          <button
            type="button"
            className={`playback-btn primary ${status.playing ? "is-playing" : ""}`}
            onClick={onPlayPause}
            title={status.playing ? "暂停" : "播放"}
          >
            {status.playing ? <PauseCircle size={18} /> : <Play size={18} />}
          </button>
          <button
            type="button"
            className="playback-btn"
            onClick={onStop}
            title="停止"
          >
            <Square size={16} />
          </button>
          <button
            type="button"
            className="playback-btn"
            onClick={() => {
              const step = status.durationMs / status.totalFrames;
              onSeek(Math.min(status.cursorMs + Math.round(step * 10), status.durationMs));
            }}
            title="快进"
          >
            <SkipForward size={16} />
          </button>
        </div>

        {/* Timeline */}
        <div className="playback-timeline-wrap">
          <div
            className="playback-timeline"
            ref={timelineRef}
            onClick={handleTimelineClick}
            onMouseDown={handleMouseDown}
          >
            <div
              className="playback-timeline-fill"
              style={{ width: `${Math.min(status.cursorPct * 100, 100)}%` }}
            />
            <div
              className="playback-timeline-thumb"
              style={{
                left: `${Math.min(status.cursorPct * 100, 100)}%`,
              }}
            />
          </div>
          <div className="playback-time-display">
            <span>{formatTime(status.cursorMs)}</span>
            <span>/</span>
            <span className="playback-time-total">{formatTime(status.durationMs)}</span>
          </div>
        </div>

        {/* Speed selector */}
        <div className="playback-speed-group">
          <span className="playback-speed-label">速度:</span>
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              className={`playback-speed-btn ${Math.abs(status.speed - s) < 0.01 ? "active" : ""}`}
              onClick={() => onSetSpeed(s)}
            >
              {s}x
            </button>
          ))}
        </div>

        {/* Session info */}
        <div className="playback-session-info">
          <span className="playback-session-id">
            会话: {status.sessionId.slice(0, 24)}
          </span>
          <span className="playback-frame-info">
            帧 {status.currentFrameIdx + 1}/{status.totalFrames}
          </span>
        </div>
      </div>
    </div>
  );
}
