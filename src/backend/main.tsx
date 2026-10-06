import React from "react";
import ReactDOM from "react-dom/client";

import AdminApp from "./AdminApp";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/admin.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AdminApp />
  </React.StrictMode>,
);
