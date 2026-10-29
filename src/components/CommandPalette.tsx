import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CornerDownLeft, Search } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { visibleNavigationGroups, type NavigationItem } from "../app/navigation";
import type { Permission } from "../softuiTypes";
import "../styles/command-palette.css";

export interface CommandPaletteProps {
  permissions: Permission[];
}

interface PaletteEntry {
  item: NavigationItem;
  group: string;
  /** 命中层级：0 = 标题、1 = 副标题、2 = 分组名。越小越靠前，-1 = 未命中。 */
  rank: number;
  /** 原始顺序，用来在同层级命中里保持菜单的既有排序。 */
  order: number;
}

/** 大小写不敏感的子串匹配，命中返回下标。 */
function hitIndex(text: string, query: string): number {
  return text.toLowerCase().indexOf(query);
}

function buildEntries(permissions: Permission[], query: string): PaletteEntry[] {
  const all: PaletteEntry[] = [];
  let order = 0;
  for (const group of visibleNavigationGroups(permissions)) {
    for (const item of group.items) {
      all.push({ item, group: group.label, rank: 0, order });
      order += 1;
    }
  }

  const q = query.trim().toLowerCase();
  if (!q) return all;

  return all
    .map((entry) => ({
      ...entry,
      // 标题命中放到最前，其次是副标题，最后是分组名 ——
      // 这样「运行」「数据」这类分组词也能把整组捞出来，而不是查不到。
      rank:
        hitIndex(entry.item.title, q) >= 0
          ? 0
          : hitIndex(entry.item.subtitle, q) >= 0
            ? 1
            : hitIndex(entry.group, q) >= 0
              ? 2
              : -1,
    }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.order - b.order);
}

/** 把命中处包进 <mark> 高亮。未命中就原样返回（副标题/分组不命中是常态）。 */
function Highlighted({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  if (!q) return <>{text}</>;
  const at = text.toLowerCase().indexOf(q);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="command-palette-hit">{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}

/**
 * 命令面板：⌘K / Ctrl+K 唤起，搜菜单项并跳转。
 *
 * 几个刻意的取舍：
 *  - 条目直接来自 `visibleNavigationGroups(permissions)`，和侧边栏是**同一份数据**。
 *    单独维护一份命令表迟早会和菜单分叉，而且权限过滤也得再写一遍。
 *  - 键盘导航只有 ↑↓ / Enter / Esc 三个键，不做拼音首字母之类的模糊匹配：
 *    子串匹配的命中位置是确定的，高亮才能精确对应，不会出现"标了一堆散字"。
 *  - 打开时把 body 滚动锁住，否则在长页面上滚轮会穿透到下面的列表。
 */
export function CommandPalette({ permissions }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const entries = useMemo(() => buildEntries(permissions, query), [permissions, query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        // 不拦住的话 Chrome 会拿 Ctrl+K 去聚焦地址栏，面板根本打不开
        event.preventDefault();
        setOpen((previous) => !previous);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    // 每次打开都清空：留着上次的词，下次看到的是一屏过期结果
    setQuery("");
    setActive(0);
    // 焦点要等这一帧渲染完再给，否则 input 还没挂上
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // 面板打开期间锁滚动（只改 body，不动页面自身的滚动容器）
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // 焦点万一不在输入框上（例如点过列表、或浏览器把焦点带走了），Esc 也得能关。
    // 只在输入框的 onKeyDown 里监听是不够的。
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  // 过滤后结果变短时，选中项可能越界
  useEffect(() => {
    setActive((previous) => (previous < entries.length ? previous : 0));
  }, [entries.length]);

  useEffect(() => {
    // block: "nearest" —— 用 center 的话每次按键列表都会跳一下
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, entries]);

  const close = useCallback(() => setOpen(false), []);

  const go = useCallback(
    (entry: PaletteEntry | undefined) => {
      if (!entry) return;
      navigate(entry.item.path);
      setOpen(false);
    },
    [navigate],
  );

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (entries.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      // 取模而不是夹住：到顶再按↓回到第一条，比"卡住不动"好判断
      setActive((previous) => (previous + step + entries.length) % entries.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      go(entries[active]);
    }
  };

  if (!open) return null;

  return (
    <div className="command-palette-overlay" onMouseDown={close} role="presentation">
      <div
        aria-label="命令面板"
        aria-modal="true"
        className="command-palette"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="command-palette-search">
          <Search aria-hidden="true" size={16} />
          <input
            aria-activedescendant={entries[active] ? `command-item-${active}` : undefined}
            aria-controls="command-palette-list"
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="搜索功能…"
            ref={inputRef}
            role="combobox"
            spellCheck={false}
            value={query}
          />
          <kbd>esc</kbd>
        </div>
        <div className="command-palette-list" id="command-palette-list" ref={listRef} role="listbox">
          {entries.length === 0 ? (
            <div className="command-palette-empty">没有匹配的功能</div>
          ) : (
            entries.map((entry, index) => {
              const Icon = entry.item.icon;
              const current = index === active;
              return (
                <button
                  aria-selected={current}
                  className={`command-palette-item${current ? " is-active" : ""}`}
                  data-active={current ? "true" : undefined}
                  id={`command-item-${index}`}
                  key={entry.item.key}
                  onClick={() => go(entry)}
                  onMouseEnter={() => setActive(index)}
                  role="option"
                  type="button"
                >
                  <Icon aria-hidden="true" size={16} />
                  <span className="command-palette-text">
                    <strong>
                      <Highlighted text={entry.item.title} query={query} />
                    </strong>
                    <small>
                      <Highlighted text={`${entry.group} · ${entry.item.subtitle}`} query={query} />
                    </small>
                  </span>
                  {current ? <CornerDownLeft aria-hidden="true" size={14} /> : null}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
