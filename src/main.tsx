import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

/**
 * 顶层错误边界 ✓ —— 任何渲染异常都**显示出来** ✓，而不是整页黑屏 ✗。
 *
 * 之前黑屏时什么信息都没有 ✗，只能靠猜 ✓；有它就能看到错误和组件栈 ✓。
 */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[softui] 渲染异常", error, info.componentStack);

    /**
     * **懒加载 chunk 404** → 自动重载一次 ✓
     *
     * 场景：部署后旧的 `index.html` 还在浏览器缓存里 ✓，
     * 它引用的 `xxx-旧hash.js` 已经被新构建删掉了 ✗ → 404 ✓。
     * 用户直接刷新就能好 ✓，但很多人不会刷新 ✗ → 表现成"页面坏了"✗。
     *
     * 用 sessionStorage 限流 ✓（10 秒内只重载一次 ✗，避免死循环 ✓）。
     */
    const message = String(error?.message ?? "");
    if (/dynamically imported module|Loading chunk|Importing a module script failed/i.test(message)) {
      const key = "softui:chunkReloadAt";
      let last = 0;
      try {
        last = Number(window.sessionStorage.getItem(key) ?? 0);
      } catch {
        last = 0;
      }
      if (Date.now() - last > 10_000) {
        try {
          window.sessionStorage.setItem(key, String(Date.now()));
        } catch {
          /* 忽略 ✓ */
        }
        window.location.reload();
      }
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{
          padding: "32px",
          fontFamily: "Inter, system-ui, sans-serif",
          color: "#e7eef7",
          background: "#0d1117",
          minHeight: "100vh",
          whiteSpace: "pre-wrap",
          lineHeight: 1.6,
        }}
      >
        <h1 style={{ fontSize: 18, margin: "0 0 12px" }}>页面渲染出错</h1>
        <p style={{ color: "#ff8f8f", margin: "0 0 12px" }}>{this.state.error.message}</p>
        <pre style={{ fontSize: 11, opacity: 0.7, overflow: "auto" }}>
          {this.state.error.stack}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            marginTop: 16,
            padding: "6px 14px",
            borderRadius: 8,
            border: "1px solid #30363d",
            background: "#161b22",
            color: "#e7eef7",
            cursor: "pointer",
          }}
        >
          重新加载
        </button>
      </div>
    );
  }
}
// 层叠顺序即加载顺序：token 最先，App.css 的遗留规则在中间，页面模板最后覆盖。
import "./styles/tokens.css";
import "./styles/base.css";
import "./App.css";
import "./styles/shell.css";
import "./styles/layouts.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
);
