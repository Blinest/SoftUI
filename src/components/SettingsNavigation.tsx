import { SlidingIndicator, useSlidingIndicator } from "./SlidingIndicator";

export interface SettingsNavigationProps {
  active: string;
  sections: Array<{ id: string; label: string }>;
  onSelect: (id: string) => void;
}

/** 设置分类导航，渲染在 SettingsLayout 的左侧栏里。 */
export function SettingsNavigation({ active, sections, onSelect }: SettingsNavigationProps) {
  const { containerRef, setItemRef, rect } = useSlidingIndicator<string, HTMLDivElement>(active);

  return (
    <div
      className="settings-navigation-tabs"
      ref={containerRef}
      role="tablist"
      aria-label="设置分类"
    >
      {/* 滑块是纯装饰层：aria-hidden + pointer-events:none，不参与 Tab 焦点顺序 */}
      <SlidingIndicator rect={rect} />
      {sections.map((section) => (
        <button
          aria-selected={active === section.id}
          className={`settings-nav-item${active === section.id ? " is-active" : ""}`}
          key={section.id}
          onClick={() => onSelect(section.id)}
          ref={setItemRef(section.id)}
          role="tab"
          type="button"
        >
          {section.label}
        </button>
      ))}
    </div>
  );
}
