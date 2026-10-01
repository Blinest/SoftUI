import type { ComponentType, ReactNode } from "react";

/**
 * 工作区卡片的**统一外壳**（卡片"抽象基类"）。
 *
 * 手动/自动/回放等页面里的面板原本是这段结构复制十几遍：
 *
 * ```tsx
 * <section className="workspace-panel">
 *   <header><div><span>DeviceTab</span><h2>标题</h2></div></header>
 *   ...
 * </section>
 * ```
 *
 * 复制多了必然走样（kicker 有 `DeviceTab` / `workspace` / `frontend loop` 三种，
 * 有的 header 右侧挂 Badge 或开关，有的卡片要 `workspace-panel-wide` 跨列）。
 * 这里把差异收敛成 props，新增卡片只需描述"标题 + 右侧动作 + 内容"。
 *
 * 两种用法：
 *
 * ```tsx
 * // ① 直接写（内容就地展开）
 * <WorkspaceCard title="电机控制" actions={<Badge tone="ok">已使能</Badge>}>
 *   ...
 * </WorkspaceCard>
 *
 * // ② 声明式注册（对齐 pages/dashboardCards.tsx 的 dashboardCardRegistry 写法）
 * export const workspaceCardRegistry = {
 *   model: defineWorkspaceCard({ title: "模型包", wide: true, render: () => <ModelCardBody /> }),
 * } satisfies Record<string, WorkspaceCardDefinition>;
 * ```
 */
export interface WorkspaceCardProps {
  /** 卡片标题（`<h2>`）。 */
  title: string;
  /** 标题上方的小字分类标签，默认 `DeviceTab`。 */
  kicker?: string;
  /** header 右侧内容：徽标、开关、按钮组。 */
  actions?: ReactNode;
  /** 在两列网格里跨满整行（对应 `workspace-panel-wide`）。 */
  wide?: boolean;
  /**
   * 是否允许用户**拖动排序 / 缩放**（放进 `CardGrid` 时生效），默认 `true`。
   *
   * `false` = 锁定在默认位置：`CardGrid` 不会给这张卡片开拖拽会话，
   * 用户只能改其它卡片的位置。适合「必须钉住」的卡片（例如安全相关的急停）。
   */
  draggable?: boolean;
  /** 追加的类名，例如 `manual-volume-panel`、`workspace-panel-wide` 之外的自定义布局。 */
  className?: string;
  /** 供 `aria-labelledby` 等外部引用。 */
  id?: string;
  children: ReactNode;
}

/** 默认分类标签——绝大多数工作区卡片都是这个。 */
export const DEFAULT_CARD_KICKER = "DeviceTab";

/** 卡片外壳。 */
export function WorkspaceCard({
  title,
  kicker = DEFAULT_CARD_KICKER,
  actions,
  wide = false,
  draggable = true,
  className,
  id,
  children,
}: WorkspaceCardProps) {
  const classes = ["workspace-panel", wide ? "workspace-panel-wide" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");

  return (
    <section className={classes} id={id} data-draggable={draggable ? "true" : "false"}>
      <header>
        <div>
          <span>{kicker}</span>
          <h2>{title}</h2>
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

/**
 * 卡片的**声明式定义**——与 `DashboardCardDefinition` 同构，便于把一组卡片注册成
 * 表后批量渲染（例：按布局顺序排列、按权限过滤）。
 */
export interface WorkspaceCardDefinition<Context = void> {
  title: string;
  kicker?: string;
  wide?: boolean;
  className?: string;
  /**
   * 是否允许拖动排序 / 缩放（默认 `true`）。
   *
   * 注意：这只声明**意愿**；真正生效还要求渲染它的 `CardGrid` 传了
   * `onLayoutChange`（不传即整页只读）。`false` 时该卡片被钉在默认位置。
   */
  draggable?: boolean;
  /** 渲染卡片**内容**（外壳由 `WorkspaceCardFor` 负责）。 */
  render: (context: Context) => ReactNode;
}

/**
 * 定义一张卡片。只做类型收窄，运行时等同于原对象——
 * 目的是让 `satisfies Record<string, WorkspaceCardDefinition<C>>` 能推断出来。
 */
export function defineWorkspaceCard<Context = void>(
  definition: WorkspaceCardDefinition<Context>,
): WorkspaceCardDefinition<Context> {
  return definition;
}

/** 用定义 + 上下文渲染一张完整卡片。 */
export function WorkspaceCardFor<Context>({
  definition,
  context,
  actions,
  id,
}: {
  definition: WorkspaceCardDefinition<Context>;
  context: Context;
  actions?: ReactNode;
  id?: string;
}) {
  void definition.draggable;
  return (
    <WorkspaceCard
      title={definition.title}
      kicker={definition.kicker}
      wide={definition.wide}
      className={definition.className}
      actions={actions}
      id={id}
    >
      {definition.render(context)}
    </WorkspaceCard>
  );
}

/**
 * 卡片**元数据**（不含 `render`）。
 *
 * `CardGrid` 的 `headerForCard` / `draggableForCard` 只需要标题、图标和可拖拽开关，
 * 不需要知道内容怎么渲染 —— 卡片主体仍由调用方通过 `childrenForCard` 提供。
 * 这样「卡片外壳」与「卡片内容」可以分开演进：外壳统一在这里，内容留在各自页面。
 */
export interface WorkspaceCardMeta {
  title: string;
  /** lucide 图标组件。
   */
  icon: ComponentType<{ size?: number | string; "aria-hidden"?: boolean | "true" | "false" }>;
  /** 标题上方的小字分类标签。
   */
  kicker?: string;
  /** 是否允许拖动排序 / 缩放，默认 `true`。
   */
  draggable?: boolean;
}
