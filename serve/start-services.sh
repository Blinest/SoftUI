#!/usr/bin/env bash
# SoftUI 三个常驻进程的启动脚本：Rust 网关 / Node 网关 / Cloudflare 隧道
#
# ⚠️ 请在**你自己的终端**里运行本脚本，不要在 AI agent 的会话里跑。
#
# 为什么：容器没有 systemd，而且**由 agent 会话派生的进程会被它的生命周期清理掉**
# （2026-10-06 实测两次停服：约 2 小时、约 3 小时后三个进程同时消失，容器未重启、
# 无 OOM、日志无关闭记录，故障时全容器只剩 PID 1）。`setsid` 只能延长存活时间，
# 不能根治 —— 已实测这些进程的会话归属确实独立（`sid == pid`、`ppid == 1`），
# 仍然会被清掉。所以服务必须由人自己的终端拉起。
#
# 用法：
#   bash serve/start-services.sh          # 停止已有实例并重新启动
#   SOFTUI_ROOT=/opt/softui bash serve/start-services.sh
#
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${SOFTUI_ROOT:-$(dirname "$SCRIPT_DIR")}"
LOG_DIR="${SOFTUI_LOG_DIR:-/var/log}"
GATEWAY_ADDR="${SOFTUI_ADDR:-127.0.0.1:8787}"
STATE_FILE="${SOFTUI_STATE:-$ROOT/data/softui-state.json}"
CF_BIN="${SOFTUI_CLOUDFLARED:-/usr/bin/cloudflared}"

echo "== SoftUI 启动脚本 =="
echo "   项目根目录: $ROOT"
echo "   日志目录:   $LOG_DIR"
echo

# ── 1. 停掉已有实例（幂等：脚本可以反复运行）────────────────────────────
echo "[1/3] 停止已有实例"
stop_pattern() {
  local pattern="$1" pid cmd killed=0
  for p in /proc/[0-9]*; do
    pid="${p#/proc/}"
    [ "$pid" = "$$" ] && continue
    cmd="$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)" || continue
    [ -z "$cmd" ] && continue
    case "$cmd" in
      *"$pattern"*)
        if kill "$pid" 2>/dev/null; then
          echo "      已停止 pid=$pid  ($pattern)"
          killed=1
        fi
        ;;
    esac
  done
  [ "$killed" = "0" ] && echo "      （无运行中的实例：$pattern）"
  return 0
}
stop_pattern "release/softui-desktop"
stop_pattern "serve/server.mjs"
stop_pattern "cloudflared tunnel run softui"
sleep 2

# ── 2. 启动 ─────────────────────────────────────────────────────────────
echo
echo "[2/3] 启动三个进程"
if [ ! -x "$ROOT/src-tauri/target/release/softui-desktop" ]; then
  echo "      ✗ 找不到 $ROOT/src-tauri/target/release/softui-desktop"
  echo "        请先在 src-tauri 下执行：cargo build --release --no-default-features"
  exit 1
fi
mkdir -p "$LOG_DIR"

( cd "$ROOT/src-tauri" && setsid env SOFTUI_ADDR="$GATEWAY_ADDR" SOFTUI_STATE="$STATE_FILE" \
    ./target/release/softui-desktop >> "$LOG_DIR/softui-gateway.log" 2>&1 < /dev/null & )
( cd "$ROOT" && setsid node serve/server.mjs >> "$LOG_DIR/softui-node.log" 2>&1 < /dev/null & )
( setsid "$CF_BIN" tunnel run softui >> "$LOG_DIR/cloudflared-softui.log" 2>&1 < /dev/null & )
sleep 8

# ── 3. 自检 ─────────────────────────────────────────────────────────────
echo
echo "[3/3] 自检"
health="$(curl -s --max-time 5 "http://$GATEWAY_ADDR/health" 2>/dev/null || true)"
case "$health" in
  *'"ok":true'*) echo "      ✓ Rust 网关   $health" ;;
  *)             echo "      ✗ Rust 网关   无响应（看 $LOG_DIR/softui-gateway.log）" ;;
esac

code="$(curl -s -o /dev/null --max-time 5 -w '%{http_code}' http://127.0.0.1:80/ 2>/dev/null || true)"
if [ "$code" = "200" ]; then
  echo "      ✓ Node 网关   :80 = 200"
else
  echo "      ✗ Node 网关   :80 = ${code:-无响应}（看 $LOG_DIR/softui-node.log）"
fi

conns="$(grep -c 'Registered tunnel connection' "$LOG_DIR/cloudflared-softui.log" 2>/dev/null || echo 0)"
echo "      · 隧道累计注册连接数: $conns（>0 说明隧道跑起来过）"

echo
echo "进程一览（应各占一行，ppid=1）："
for p in /proc/[0-9]*; do
  pid="${p#/proc/}"
  cmd="$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)" || continue
  case "$cmd" in
    *release/softui-desktop*|*serve/server.mjs*|*cloudflared\ tunnel*) \
      echo "      pid=$pid ppid=$(awk '{print $4}' "$p/stat" 2>/dev/null)  ${cmd% }" ;;
  esac
done

echo
echo "外部访问自检（经 Cloudflare，可能要多等几秒）："
for host in softui.blinest.icu softui-backend.blinest.icu; do
  title="$(curl -s --max-time 20 -H 'user-agent: Mozilla/5.0' "https://$host" 2>/dev/null \
           | grep -oE '<title>[^<]*</title>' || true)"
  echo "      $host  ${title:-✗ 未取到页面}"
done
echo
echo "完成。若上面有 ✗，先看 $LOG_DIR/ 下对应的日志。"
