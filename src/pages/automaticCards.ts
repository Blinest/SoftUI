import {
  Activity, AlertTriangle, SlidersHorizontal,
} from "lucide-react";

import type { AutomaticCardId } from "../softuiTypes";
import type { WorkspaceCardMeta } from "../components/WorkspaceCard";

/**
 * 「自动控制」页的卡片注册表。
 *
 * 只登记**元数据**（标题 / 图标 / 可拖拽），卡片主体仍写在 WorkspacePage 里 ——
 * 主体与页面状态（草稿、快照、回调）耦合很紧，搬到独立文件只会来回传几十个 prop。
 */
export const automaticCardRegistry: Record<AutomaticCardId, WorkspaceCardMeta> = {
  systemControl: { title: "系统操作权限", icon: AlertTriangle },
  pidControl: { title: "PID 参数", icon: SlidersHorizontal },
  cycleLife: { title: "循环寿命检测", icon: Activity },
};

/** 该页每张卡片是否允许拖动排序 / 缩放。 */
export function automaticCardDraggable(cardId: string): boolean {
  const meta = automaticCardRegistry[cardId as AutomaticCardId];
  return meta ? (meta.draggable ?? true) : true;
}
