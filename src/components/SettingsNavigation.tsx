export interface SettingsNavigationProps {
  active: string;
  sections: Array<{ id: string; label: string }>;
  onSelect: (id: string) => void;
}

/** 设置分类导航，渲染在 SettingsLayout 的左侧栏里。 */
export function SettingsNavigation({ active, sections, onSelect }: SettingsNavigationProps) {
  return (
    <div className="settings-navigation-tabs" role="tablist" aria-label="设置分类">
      {sections.map((section) => (
        <button
          aria-selected={active === section.id}
          className={`settings-nav-item${active === section.id ? " is-active" : ""}`}
          key={section.id}
          onClick={() => onSelect(section.id)}
          role="tab"
          type="button"
        >
          {section.label}
        </button>
      ))}
    </div>
  );
}
