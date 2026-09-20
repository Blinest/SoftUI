import { memo } from "react";

interface AppFooterProps {
  items: string[];
}

/** 底部运行摘要：只读，不承载操作。 */
export const AppFooter = memo(function AppFooter({ items }: AppFooterProps) {
  return (
    <footer className="app-footer" aria-label="运行摘要">
      {items.map((item, index) => (
        <span key={`${item}-${index}`}>{item}</span>
      ))}
    </footer>
  );
});
