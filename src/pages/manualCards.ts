import {

  CircleGauge, Save, SlidersHorizontal, Table2,

} from "lucide-react";



import type { ManualCardId } from "../softuiTypes";

import type { WorkspaceCardMeta } from "../components/WorkspaceCard";



/**

 * 「手动控制」页的卡片注册表。

 *

 * 只登记**元数据**（标题 / 图标 / 可拖拽），卡片主体仍写在 WorkspacePage 里 ——

 * 主体与页面状态（草稿、快照、回调）耦合很紧，搬到独立文件只会来回传几十个 prop。

 */

export const manualCardRegistry: Record<ManualCardId, WorkspaceCardMeta> = {

  modelPackage: { title: "模型包", icon: Save },

  curvatureDrag: { title: "末端位姿控制", icon: CircleGauge },


  motorControl: { title: "电机控制", icon: SlidersHorizontal },

  sensorMonitor: { title: "压力数据监控 / 校准", icon: Table2 },

};



/** 该页每张卡片是否允许拖动排序 / 缩放。 */

export function manualCardDraggable(cardId: string): boolean {

  const meta = manualCardRegistry[cardId as ManualCardId];

  return meta ? (meta.draggable ?? true) : true;

}

