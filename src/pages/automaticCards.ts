import {

  Activity, GitBranch, Route, Save, SlidersHorizontal, Table2,

} from "lucide-react";



import type { AutomaticCardId } from "../softuiTypes";

import type { WorkspaceCardMeta } from "../components/WorkspaceCard";



/**

 * 「参数调整」页的卡片注册表。

 *

 * 只登记**元数据**（标题 / 图标 / 可拖拽），卡片主体仍写在 WorkspacePage 里 ——

 * 主体与页面状态（草稿、快照、回调）耦合很紧，搬到独立文件只会来回传几十个 prop。

 */

export const automaticCardRegistry: Record<AutomaticCardId, WorkspaceCardMeta> = {

  modelPackage: { title: "模型库", icon: Save },

  sensorMonitor: { title: "压力传感器参数", icon: Table2 },

  pidControl: { title: "PID 参数", icon: SlidersHorizontal },

  cycleLife: { title: "循环寿命检测", icon: Activity },

  policyRules: { title: "智能策略编排", icon: GitBranch },

  motionLibrary: { title: "动作库", icon: Route },

};



/** 该页每张卡片是否允许拖动排序 / 缩放。 */

export function automaticCardDraggable(cardId: string): boolean {

  const meta = automaticCardRegistry[cardId as AutomaticCardId];

  return meta ? (meta.draggable ?? true) : true;

}

