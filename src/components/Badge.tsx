import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "ok" | "warn" | "error" | "info";

/** 紧凑状态徽标。旧样式表里定义为 .badge.<tone>。 */
export default function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: BadgeTone }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
