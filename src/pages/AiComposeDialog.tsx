import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Sparkles, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

import { getAuthUsername } from "../robot/uiStore";
import type { PolicyInterrupt, PolicyTimelineBlock } from "./PolicyRulesCard";

/**
 * **智能策略编排**对话框 ✓ —— 三件事都在这里做：
 *  ① 选模型 ✓
 *  ② 设 Key（**按账号隔离** ✓，存服务器 ✓）
 *  ③ 用自然语言生成策略 ✓，预览后「采用」✓
 *
 * 为什么放对话框 ✗：卡片内容已经很长 ✓，再塞表单会把它撑爆 ✗。
 * 用 `createPortal` 挂 body ✓（避开卡片容器的裁剪 ✗）。
 */

/** 常见可选模型 ✓（baseUrl 留空表示用默认 ✓）*/
const MODEL_OPTIONS = [
  { id: "deepseek-chat", label: "DeepSeek Chat（通用，快）", baseUrl: "" },
  { id: "deepseek-reasoner", label: "DeepSeek Reasoner（推理，慢但准）", baseUrl: "" },
  { id: "custom", label: "自定义（OpenAI 兼容接口）", baseUrl: "" },
];

interface AiDraft {
  name?: string;
  timeline?: PolicyTimelineBlock[];
  interrupts?: PolicyInterrupt[];
}

export function AiComposeDialog({
  open,
  onClose,
  context,
  onAdopt,
}: {
  open: boolean;
  onClose: () => void;
  /** 可用的模型 / 动作清单 ✓（给 AI 做约束 ✓，给校验做依据 ✓）*/
  context: {
    models: Array<{ id: string; name: string }>;
    actions: Array<{ id: string; name: string; durationSec: number | null }>;
  };
  /** 采用生成的方案 ✓ */
  onAdopt: (draft: AiDraft) => void;
}) {
  const [model, setModel] = useState(MODEL_OPTIONS[0].id);
  const [apiKey, setApiKey] = useState("");
  /** Key 输入框是否展开 ✓（已配置时默认收起 ✗，点「更换」才展开 ✓）*/
  const [editingKey, setEditingKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [status, setStatus] = useState<{ hasOwnKey: boolean; hasGlobalKey: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<AiDraft | null>(null);
  /** **对话历史** ✓ —— 让你能"改一句再生成" ✓，而不是每次从零写 ✗ */
  const [messages, setMessages] = useState<Array<{ role: "user" | "ai"; text: string }>>([]);

  /** 打开时刷新"我这个账号有没有 Key"✓ */
  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const result = await invoke<{
          hasOwnKey: boolean;
          hasGlobalKey: boolean;
          model?: string | null;
        }>("ai_key_status", { username: getAuthUsername() });
        setStatus(result);
        if (result.model) setModel(result.model);   // 回填 ✓
        setEditingKey(!result.hasOwnKey);            // 没配才展开 ✓
      } catch {
        setStatus(null);
      }
    })();
  }, [open]);

  if (!open) return null;

  const saveKey = async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    try {
      // **只存自己的** ✓ —— 不再调 `save_ai_config` ✗（那会覆盖全局 ✗）
      await invoke("set_ai_key", {
        username: getAuthUsername(),
        apiKey: apiKey.trim(),
        model,
        baseUrl: model === "custom" ? baseUrl.trim() || null : null,
      });
      setApiKey("");
      setEditingKey(false);   // 保存后**自动收起** ✓
      setNotice("已保存 ✓ 只有你的账号用这个 Key");
      const result = await invoke<{ hasOwnKey: boolean; hasGlobalKey: boolean }>("ai_key_status", {
        username: getAuthUsername(),
      });
      setStatus(result);
    } catch (err) {
      setNotice(`保存失败：${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const compose = async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    setError(null);
    setDraft(null);
    try {
      // **带上对话历史** ✓ —— "再短一点""把中断阈值改成 3N"这类修改才有上下文 ✓
      const history = messages
        .map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.text}`)
        .join("\n");
      const fullPrompt = history
        ? `之前的对话：\n${history}\n\n本次要求：${prompt}`
        : prompt;
      setMessages((prev) => [...prev, { role: "user", text: prompt }]);

      const raw = await invoke<AiDraft>("ai_compose_policy", {
        prompt: fullPrompt,
        username: getAuthUsername(),
        context: {
          models: context.models,
          actions: context.actions,
          currentScheme: draft ?? null,
        },
      });

      // **逐条校验** ✓ —— AI 会编造 id ✗，必须拦住 ✓
      const problems: string[] = [];
      const timeline = Array.isArray(raw.timeline) ? raw.timeline : [];
      const interrupts = Array.isArray(raw.interrupts) ? raw.interrupts : [];
      for (const block of timeline) {
        if (block.kind === "action" && !context.actions.some((a) => a.id === block.actionId)) {
          problems.push(`动作不存在：${block.actionId ?? "(空)"}`);
        }
        if (block.kind === "switch-model" && !context.models.some((m) => m.id === block.modelId)) {
          problems.push(`模型不存在：${block.modelId ?? "(空)"}`);
        }
        if (!(block.durationSec > 0 && block.durationSec <= 3600)) {
          problems.push(`时长不合理：${block.durationSec}`);
        }
      }
      for (const intr of interrupts) {
        const pool = intr.targetKind === "model" ? context.models : context.actions;
        if (!pool.some((item) => item.id === intr.targetId)) {
          problems.push(`中断目标不存在：${intr.targetId ?? "(空)"}`);
        }
      }
      if (problems.length > 0) {
        setError(problems.slice(0, 4).join("；"));
        return;
      }

      setMessages((prev) => [
        ...prev,
        {
          role: "ai",
          text: `${raw.timeline?.length ?? 0} 段时间线 · ${raw.interrupts?.length ?? 0} 条中断`,
        },
      ]);
      setDraft({
        name: raw.name,
        timeline: timeline.map((block, index) => ({ ...block, id: `block-${Date.now()}-${index}` })),
        interrupts: interrupts.map((intr, index) => ({
          ...intr,
          id: `intr-${Date.now()}-${index}`,
          enabled: intr.enabled ?? true,
          trigger: intr.trigger ?? "tension-spike",
          resume: intr.resume ?? true,
          note: intr.note ?? "",
        })),
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const labelOf = (id: string | undefined, kind: "model" | "action") =>
    (kind === "model" ? context.models : context.actions).find((item) => item.id === id)?.name ??
    (id || "(空)");

  return createPortal(
    <div className="ai-dialog-backdrop" role="dialog" aria-modal="true" aria-label="智能策略编排">
      <div className="ai-dialog">
        <header className="ai-dialog-head">
          <h2>
            <Sparkles size={16} /> 智能策略编排
          </h2>
          <button type="button" className="ai-dialog-close" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </header>

        {/* ── ① 模型与 Key ✓ ─────────────────────────────── */}
        <section className="ai-section">
          <div className="ai-section-title">
            <span>模型与密钥</span>
            <em>
              {status
                ? status.hasOwnKey
                  ? "我的账号已配置 ✓"
                  : status.hasGlobalKey
                    ? "未配置，将使用全局 Key ✓"
                    : "未配置 ✗"
                : ""}
            </em>
          </div>
          <div className="ai-grid">
            <label>
              <span>模型</span>
              <select value={model} onChange={(event) => setModel(event.target.value)}>
                {MODEL_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {model === "custom" ? (
              <label>
                <span>接口地址</span>
                <input
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="https://…/chat/completions"
                />
              </label>
            ) : null}
            {/* 已配置且不在编辑 → **不显示输入框** ✓（只留一行提示 ✓）*/}
            {status?.hasOwnKey && !editingKey ? null : (
              <label className="is-wide">
                <span>我的 API Key</span>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="sk-…（只保存到服务器，不回显 ✗）"
                />
              </label>
            )}
          </div>
          <div className="ai-row">
            {status?.hasOwnKey && !editingKey ? (
              <>
                <span className="ai-key-ok">API Key 已配置 ✓</span>
                <button type="button" className="ghost-btn" onClick={() => setEditingKey(true)}>
                  更换 Key
                </button>
              </>
            ) : (
              <button
                type="button"
                className="ghost-btn"
                disabled={saving || !apiKey.trim()}
                onClick={() => void saveKey()}
              >
                {saving ? "保存中…" : "保存 Key"}
              </button>
            )}
            {notice ? <span className="ai-notice">{notice}</span> : null}
          </div>
        </section>

        {/* ── ② 自然语言编排 ✓ ─────────────────────────────── */}
        <section className="ai-section">
          <div className="ai-section-title">
            <span>用一句话描述策略</span>
            <em>例如：前 10 秒切到旧臂，再播抓取动作 16 秒；张力超 5N 就切回新臂</em>
          </div>
          {messages.length > 0 ? (
            <ul className="ai-chat">
              {messages.map((message, index) => (
                <li key={index} className={message.role === "user" ? "is-user" : "is-ai"}>
                  <span className="ai-chat-role">{message.role === "user" ? "你" : "AI"}</span>
                  <span className="ai-chat-text">{message.text}</span>
                </li>
              ))}
            </ul>
          ) : null}

          <textarea
            className="ai-prompt"
            rows={3}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="描述你要的时间线和中断…"
          />
          <div className="ai-row">
            <button
              type="button"
              className="ghost-btn"
              disabled={busy || !prompt.trim()}
              onClick={() => void compose()}
            >
              {busy ? "生成中…" : "生成方案"}
            </button>
            {messages.length > 0 ? (
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  setMessages([]);
                  setDraft(null);
                  setPrompt("");
                }}
              >
                清空对话
              </button>
            ) : null}
            {error ? <span className="ai-error">⚠ {error}</span> : null}
          </div>
        </section>

        {/* ── ③ 预览 ✓ ─────────────────────────────────── */}
        {draft ? (
          <section className="ai-section ai-preview">
            <div className="ai-section-title">
              <span>建议方案</span>
              <em>
                {draft.timeline?.length ?? 0} 段 · {draft.interrupts?.length ?? 0} 条中断
              </em>
            </div>
            <ol className="ai-preview-list">
              {(draft.timeline ?? []).map((block, index) => (
                <li key={`${block.id}-${index}`}>
                  <span className="ai-preview-index">{index + 1}</span>
                  <b>
                    {block.kind === "action" ? "执行" : block.kind === "switch-model" ? "切到" : "等待"}
                  </b>
                  <span>
                    {block.kind === "action"
                      ? labelOf(block.actionId, "action")
                      : block.kind === "switch-model"
                        ? labelOf(block.modelId, "model")
                        : "—"}
                  </span>
                  <em>{block.durationSec}s</em>
                </li>
              ))}
            </ol>
            {(draft.interrupts ?? []).length > 0 ? (
              <ul className="ai-preview-list is-interrupt">
                {(draft.interrupts ?? []).map((intr, index) => (
                  <li key={`${intr.id}-${index}`}>
                    <span className="ai-preview-index">⚡</span>
                    <b>
                      张力 &gt; {intr.thresholdN}N / {intr.windowMs}ms
                    </b>
                    <span>→ {labelOf(intr.targetId, intr.targetKind)}</span>
                    <em>{intr.resume ? "恢复时间线" : "不回时间线"}</em>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="ai-row is-end">
              <button type="button" className="ghost-btn" onClick={() => setDraft(null)}>
                放弃
              </button>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => {
                  onAdopt(draft);
                  setDraft(null);
                  setPrompt("");
                  onClose();
                }}
              >
                采用
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
