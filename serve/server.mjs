/*
 * SoftUI 静态站点服务（Node 内置模块，无第三方依赖）
 *
 * 用途：把 /opt/softui/dist 发布到 0.0.0.0:80，经 Cloudflare 隧道对外。
 * 特性：HTTP Basic 访问口令、SPA 回退、基础 MIME、gzip、分资源类型的缓存头。
 *
 * 口令文件：/opt/softui/serve/auth.txt，格式 `用户名:密码` 一行。
 *   改完**不用重启**——每次请求会检查文件 mtime，变了就重新加载。
 *   文件缺失时拒绝所有请求（fail-closed），避免误删口令后变成裸奔。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = process.env.SOFTUI_ROOT || path.resolve(fileURLToPath(import.meta.url), "../../dist");
const AUTH_FILE = process.env.SOFTUI_AUTH || path.join(path.dirname(fileURLToPath(import.meta.url)), "auth.txt");
const PORT = Number(process.env.SOFTUI_PORT || 80);
const HOST = process.env.SOFTUI_HOST || "0.0.0.0";
const REALM = "SoftUI";
// 浏览器 Basic 认证开关。默认关闭：只走 Rust 后端的登录页验证。
// 需要额外一层时，用 SOFTUI_BASIC=1 启动即可恢复。
const BASIC_AUTH = process.env.SOFTUI_BASIC === "1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/* ── 口令加载（按 mtime 热更新） ── */
let authCache = { user: null, pass: null, mtime: -1, missing: true };

function loadAuth() {
  let st;
  try {
    st = fs.statSync(AUTH_FILE);
  } catch {
    if (!authCache.missing) console.error(`[softui] 口令文件不存在，拒绝所有请求: ${AUTH_FILE}`);
    authCache = { user: null, pass: null, mtime: -1, missing: true };
    return authCache;
  }
  if (st.mtimeMs === authCache.mtime) return authCache;

  let raw = "";
  try {
    raw = fs.readFileSync(AUTH_FILE, "utf8");
  } catch (e) {
    console.error("[softui] 读取口令文件失败:", e.message);
  }
  const line = raw.split("\n").find((l) => l.trim() && !l.trim().startsWith("#")) || "";
  const i = line.indexOf(":");
  if (i < 0) {
    console.error("[softui] 口令文件格式应为 `用户名:密码`，当前无法解析，拒绝所有请求");
    authCache = { user: null, pass: null, mtime: st.mtimeMs, missing: true };
    return authCache;
  }
  authCache = { user: line.slice(0, i).trim(), pass: line.slice(i + 1).trim(), mtime: st.mtimeMs, missing: false };
  console.log(`[softui] 已加载口令：用户 ${authCache.user}`);
  return authCache;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function authorized(req) {
  const { user, pass, missing } = loadAuth();
  if (missing) return false;
  const head = req.headers.authorization || "";
  if (!/^Basic\s+/i.test(head)) return false;
  let decoded = "";
  try {
    decoded = Buffer.from(head.replace(/^Basic\s+/i, "").trim(), "base64").toString("utf8");
  } catch {
    return false;
  }
  const i = decoded.indexOf(":");
  if (i < 0) return false;
  const u = decoded.slice(0, i);
  const p = decoded.slice(i + 1);
  // 两个比较都要做，避免通过响应时间推断用户名是否存在
  return safeEqual(u, user) && safeEqual(p, pass);
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function deny(res) {
  send(
    res,
    401,
    {
      "www-authenticate": `Basic realm="${REALM}", charset="UTF-8"`,
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
    `<!doctype html><meta charset="utf-8"><title>401</title>
<div style="font:16px/1.6 system-ui;padding:48px;max-width:520px;margin:auto">
<h1 style="font-size:20px">需要登录</h1>
<p>SoftUI 网页预览需要访问口令。请在浏览器弹出的登录框里输入用户名和密码。</p>
<p style="color:#888;font-size:13px">若没有弹出，请关闭页面重开，或清除本站的认证缓存后重试。</p>
</div>`,
  );
}


/* ── /rpc 反向代理 ─────────────────────────────────────────────────
 * Rust 的 serve 模式跑在 127.0.0.1:8787，只暴露 POST /rpc。
 * 这里代理过去，好处有两点：
 *   1. 浏览器同源，不需要 CORS；静态资源和 API 共用一套 Basic 口令
 *   2. 后端没起时返回 503 + 明确 JSON，前端据此退回仿真模式
 * ───────────────────────────────────────────────────────────────── */
const RPC_HOST = process.env.SOFTUI_RPC_HOST || "127.0.0.1";
const RPC_PORT = Number(process.env.SOFTUI_RPC_PORT || 8787);

function proxyRpc(req, res) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const upstream = http.request(
      {
        host: RPC_HOST,
        port: RPC_PORT,
        path: "/rpc",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": body.length },
        timeout: 30000,
      },
      (up) => {
        const out = [];
        up.on("data", (c) => out.push(c));
        up.on("end", () => {
          const payload = Buffer.concat(out);
          res.writeHead(up.statusCode || 502, {
            "content-type": "application/json; charset=utf-8",
            "content-length": payload.length,
            "cache-control": "no-store",
            "x-softui-backend": "rust",
          });
          res.end(payload);
        });
      },
    );
    upstream.on("error", (error) => {
      res.writeHead(503, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-softui-backend": "down",
      });
      res.end(JSON.stringify({ ok: false, error: `Rust 后端不可达：${error.message}` }));
    });
    upstream.on("timeout", () => upstream.destroy(new Error("后端超时")));
    upstream.end(body);
  });
}

/* ── 桩脚本标签由服务端注入 ──────────────────────────────────────────
 * 为什么不在源码 index.html 里写死：`vite build` 会用源码里的 index.html
 * 覆盖 dist/，手写的标签会被抹掉（实际踩过两次，表现为"改了桩但页面还是旧的"）。
 * 放在服务端注入就与构建解耦，重新构建也不会丢。
 * 不带版本号：缓存由下面的 no-store 负责，不需要靠 URL 变化来绕过。
 * ─────────────────────────────────────────────────────────────────── */
const SHIM_FILE = path.join(ROOT, "tauri-shim.js");
const PROTOCOL_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "protocol.js");
// 协议模块必须先于桩：桩要用它把串口字节在本地解析成帧
const PROTOCOL_TAG = '<script src="/protocol.global.js"></script>';
let shimStamp = { mtime: -1, tag: PROTOCOL_TAG + '\n    <script src="/tauri-shim.js"></script>' };

/**
 * 桩脚本的引用标签，查询串是**桩文件内容的短哈希**。
 *
 * 去掉手写版本号后暴露的真问题：裸 URL `/tauri-shim.js` 在浏览器里可能还留着
 * 几年前那份缓存（旧版桩不监听新事件，表现就是"完全不触发同步"）。
 * 用内容哈希自动变化既不需要人管版本，又保证桩一改 URL 就变、缓存必然打不中。
 * 只在文件 mtime 变化时重算，不产生额外 IO。
 */
function shimTag() {
  let stat;
  try {
    stat = fs.statSync(SHIM_FILE);
  } catch {
    return shimStamp.tag;
  }
  if (stat.mtimeMs === shimStamp.mtime) return shimStamp.tag;
  const hash = crypto.createHash("sha1").update(fs.readFileSync(SHIM_FILE)).digest("hex").slice(0, 10);
  shimStamp = {
    mtime: stat.mtimeMs,
    tag: `${PROTOCOL_TAG}\n    <script src="/tauri-shim.js?h=${hash}"></script>`,
  };
  return shimStamp.tag;
}

function injectShimTag(html) {
  const tag = shimTag();
  // 已有标签就替换成当前哈希，避免构建产物里残留旧版本
  if (/<script src="\/tauri-shim\.js[^"]*"><\/script>/.test(html)) {
    return html.replace(/<script src="\/tauri-shim\.js[^"]*"><\/script>/, tag);
  }
  return html.replace('<script type="module"', tag + '\n    <script type="module"');
}

const server = http.createServer((req, res) => {
  if (BASIC_AUTH && !authorized(req)) return deny(res);

  // API 走代理，其余走静态文件
  if (req.method === "POST" && req.url === "/rpc") return proxyRpc(req, res);
  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      JSON.stringify({ ok: true, data: { static: "up" } }));
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    return send(res, 400, { "content-type": "text/plain" }, "bad request");
  }

  /* 协议模块是 ESM（测试要 import），但浏览器脚本需要全局。
   * 这里按需转译而不是另存一份：只去掉行首的 `export `、包一层 IIFE 挂到 window，
   * 于是永远只有一个真源，不会出现两份文件各自漂移。 */
  if (urlPath === "/protocol.global.js") {
    let source;
    try {
      source = fs.readFileSync(PROTOCOL_FILE, "utf8");
    } catch {
      return send(res, 404, { "content-type": "text/plain" }, "protocol.js not found");
    }
    const body =
      "(function(){\n" +
      source.replace(/^export /gm, "") +
      "\nwindow.__SOFTUI_PROTOCOL__ = { LegacyV1Codec: LegacyV1Codec, parseStatusFrame: parseStatusFrame, encodeStatusFrame: encodeStatusFrame, checksum: checksum, ProtocolError: ProtocolError };\n})();\n";
    return send(
      res,
      200,
      { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" },
      body,
    );
  }

  const candidate = path.resolve(ROOT, "." + urlPath);
  if (candidate !== ROOT && !candidate.startsWith(ROOT + path.sep)) {
    return send(res, 403, { "content-type": "text/plain" }, "forbidden");
  }

  let filePath = candidate;
  try {
    if (fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, "index.html");
    fs.statSync(filePath);
  } catch {
    // 带扩展名的请求（.js/.css/.png…）找不到就老实 404。
    // 以前一律回退到 index.html，结果缺失的脚本会返回一段 HTML，
    // 浏览器把它当 JS 执行 —— 报错信息完全指不到真正的原因（实际踩到过）。
    if (path.extname(urlPath)) {
      return send(res, 404, { "content-type": "text/plain; charset=utf-8" }, `not found: ${urlPath}`);
    }
    // 只有无扩展名的前端路由才回退到首页
    filePath = path.join(ROOT, "index.html");
    try {
      fs.statSync(filePath);
    } catch {
      return send(res, 404, { "content-type": "text/plain" }, "not found");
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const isHashed = /-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(path.basename(filePath));
  // no-store 而不是 no-cache：桩脚本必须每次重新下载。
  // 手机上 no-cache 仍可能命中内存缓存（切标签页不重载时尤其明显），
  // 结果就是"改了代码但手机端没生效"——这是实际踩过的坑。
  const isShim = path.basename(filePath) === "tauri-shim.js";
  const cache = isShim ? "no-store, must-revalidate" : isHashed ? "public, max-age=31536000, immutable" : "no-cache";

  const acceptGzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  const gzPath = filePath + ".gz";
  if (acceptGzip && fs.existsSync(gzPath)) {
    return send(res, 200, {
      "content-type": type,
      "content-encoding": "gzip",
      "cache-control": cache,
      vary: "Accept-Encoding",
    }, fs.readFileSync(gzPath));
  }

  let body = fs.readFileSync(filePath);
  // 入口 HTML 出站前注入桩标签，与前端构建解耦
  if (path.basename(filePath) === "index.html") {
    body = Buffer.from(injectShimTag(body.toString("utf8")), "utf8");
  }
  const headers = { "content-type": type, "cache-control": cache, vary: "Accept-Encoding" };
  if (acceptGzip && body.length > 1024 && /^(text|application\/(json|javascript))/.test(type)) {
    body = zlib.gzipSync(body);
    headers["content-encoding"] = "gzip";
  }
  send(res, 200, headers, body);
});

loadAuth();
server.listen(PORT, HOST, () => {
  console.log(
    `[softui] serving ${ROOT} on http://${HOST}:${PORT} ` +
      `(basic auth: ${BASIC_AUTH ? "ON" : "OFF ← 只走后端登录"})`,
  );
});
