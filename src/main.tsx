import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// 层叠顺序即加载顺序：token 最先，App.css 的遗留规则在中间，页面模板最后覆盖。
import "./styles/tokens.css";
import "./styles/base.css";
import "./App.css";
import "./styles/shell.css";
import "./styles/layouts.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
