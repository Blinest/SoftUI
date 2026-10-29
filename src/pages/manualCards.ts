import { AlertTriangle, CircleGauge, SlidersHorizontal } from "lucide-react";



import type { ManualCardId } from "../softuiTypes";

import type { WorkspaceCardMeta } from "../components/WorkspaceCard";



/**

 * 「控制」页的卡片注册表。

 *

 * 只登记**元数据**（标题 / 图标 / 可拖拽），卡片主体仍写在 WorkspacePage 里 ——

 * 主体与页面状态（草稿、快照、回调）耦合很紧，搬到独立文件只会来回传几十个 prop。

 */

export const manualCardRegistry: Record<ManualCardId, WorkspaceCardMeta> = {


  curvatureDrag: { title: "臂体控制", icon: CircleGauge },


  motorControl: { title: "电机控制", icon: SlidersHorizontal },

  /** 系统操作权限（含急停）—— 从「参数调整」搬来，安全卡片跟着操作走 ✓ */
  systemControl: { title: "系统操作权限", icon: AlertTriangle },

};



/** 该页每张卡片是否允许拖动排序 / 缩放。 */

export function manualCardDraggable(cardId: string): boolean {

  const meta = manualCardRegistry[cardId as ManualCardId];

  return meta ? (meta.draggable ?? true) : true;

}

