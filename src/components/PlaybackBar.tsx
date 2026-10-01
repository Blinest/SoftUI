import { useEffect } from "react";
import { ChevronLeft, ChevronRight, Pause, Play, X } from "lucide-react";

import type { PlaybackStatus } from "../softuiTypes";

/**
 * 极简回放条：**只有「上一帧 / 下一帧 / 关闭」**。
 *
 * 之前那版带了警告条、操作提示、时间轴、倍速、会话信息，再加上一个「最近 10 分钟」
 * 窗口卡片 —— 回放本身只需要逐帧核对，这些全是干扰。要分析曲线/指令，用会话导出
 * 或其它页面，不占用回放条。
 *
 * 键盘 ← → 仍然可用（不可见，不占地方）；关闭 = `playback_stop`，会卸载引擎并
 * 解除 `playback_mode` 对下发命令的封锁。
 */
interface PlaybackBarProps {
  status: PlaybackStatus;
  /** 播放 / 暂停（自动实时推进 / 停住）。 */
  onPlayPause: () => void;
  onStepBackward: () => void;
  onStepForward: () => void;
  onClose: () => void;
}

export default function PlaybackBar({ status, onPlayPause, onStepBackward, onStepForward, onClose }: PlaybackBarProps) {
  // 键盘 ← → 步进。输入框聚焦时不抢键。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onStepBackward();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        onStepForward();
      } else if (event.key === " ") {
        event.preventDefault();
        onPlayPause();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onStepBackward, onStepForward, onPlayPause]);

  const atFirst = status.currentFrameIdx <= 0;
  const atLast = status.currentFrameIdx >= status.totalFrames - 1;

  return (
    <div className="playback-bar is-minimal">
      <span className="playback-minimal-session" title={status.sessionId}>
        {status.sessionId ? status.sessionId.slice(0, 20) : "回放"}
      </span>

      <button
        type="button"
        className="playback-btn primary"
        onClick={onPlayPause}
        title={status.playing ? "暂停（空格）" : "播放（空格）"}
      >
        {status.playing ? <Pause size={18} /> : <Play size={18} />}
        <span>{status.playing ? "暂停" : "播放"}</span>
      </button>

      <button
        type="button"
        className="playback-btn"
        onClick={onStepBackward}
        disabled={atFirst}
        title="上一帧（←）"
      >
        <ChevronLeft size={16} />
        <span>上一帧</span>
      </button>

      <span className="playback-minimal-frames">
        {status.currentFrameIdx + 1} / {status.totalFrames}
      </span>

      <button
        type="button"
        className="playback-btn"
        onClick={onStepForward}
        disabled={atLast}
        title="下一帧（→）"
      >
        <span>下一帧</span>
        <ChevronRight size={16} />
      </button>

      <button type="button" className="playback-btn" onClick={onClose} title="退出回放">
        <X size={16} />
      </button>
    </div>
  );
}
