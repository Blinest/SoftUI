#!/usr/bin/env python3
"""生成卡片磨砂贴图（内嵌进 tokens.css 的 --glass-card-grain）。

设计：把「卡片底色 + 受光面 + 颗粒」**烤进同一张不透明贴图**
────────────────────────────────────────────────────────────
早先的做法是：底色用 color-mix 半透明 + 一张中灰噪点，靠 background-blend-mode: overlay
混合。实测那个方案极其脆弱 —— 噪点是**不透明的中灰**，一旦 overlay 没按预期生效，
它就会当成普通图层直接盖上去，**两个主题的卡片会同时变成中灰**（实测踩到过）。

现在改成一张自包含的贴图：颜色、受光面、颗粒都在像素里，CSS 侧只剩
`background-image: var(--glass-card-grain)`。
  · 不需要 background-blend-mode  → 没有"混合模式到底生效没有"这个问题
  · 不需要 color-mix 半透明底色   → 卡片颜色不再受页面底色影响（那正是"发灰"的来源）
  · 均值天然可控：贴图均值 == 想要的卡片颜色，颗粒以它为中心对称分布

代价：卡片不再"透"（不透明）。这个取舍是刻意的 —— 纯色背景下半透明本来就看不到东西，
只会把页面底色的灰带进卡片。要恢复半透明就把 TILE_ALPHA 调到 1 以下。

调参
────
  LIGHT_BASE / DARK_BASE : 卡片底色（**这就是"卡片是什么颜色"的唯一来源**）
  LIGHT_SIGMA / DARK_SIGMA: 颗粒振幅。0 = 完全没有纹理
  TILE_ALPHA             : 1.0 = 不透明。想恢复半透明就调小（会重新引入页面色偏）
"""
import base64
import io
import pathlib
import random
import re
import statistics

from PIL import Image

# ── 卡片底色 ──
# ⚠️ 需求："深色和浅色要与背景色差不多"。所以这里取**各自主题的页面底色 + 4**：
#   浅色页面 #edf2f6 (237,242,246)  → 卡片 (241,246,250)
#   深色页面 #171f25 (23,31,37)     → 卡片 (27,35,42)
# 只留 4/255 的抬升，让卡片"像浮在背景上一点点"，区分主要靠边框与投影。
# 改这两个值时必须同步核对 tokens.css 里的 --surface-page。
LIGHT_BASE = (241, 246, 250)
DARK_BASE = (27, 35, 42)

# ── 颗粒振幅（0~255 的灰度偏移）──
LIGHT_SIGMA = 2.6
DARK_SIGMA = 1.6

# ── 受光面**不烤进贴图** ──
# 贴图是 64/96px 平铺的。任何"随 y 变化"的东西一平铺就会变成**横向条纹** ——
# 深色贴图实测就是这样：受光面 5/255 压在底色 34.7 上相对变化 15%，肉眼就是一条条横纹。
# 受光面必须做成 CSS 的整块渐变（见 layouts.css 的 .tilt-card），它跨整个元素、不平铺。

LIGHT_TILE, LIGHT_LATTICE, LIGHT_SEED = 96, 8, 7
DARK_TILE, DARK_SEED = 64, 20261012
TILE_ALPHA = 1.0

TOKENS = pathlib.Path(__file__).resolve().parents[1] / "src/styles/tokens.css"


def periodic_value_noise(size: int, lattice: int, octaves: int = 3, seed: int = 1):
    """周期性 value noise：格点取模，四边可无缝平铺。返回 0~1，均值≈0.5。"""
    rng = random.Random(seed)
    out = [[0.0] * size for _ in range(size)]
    amp, total, lat = 1.0, 0.0, lattice
    for _ in range(octaves):
        grid = [[rng.random() for _ in range(lat)] for _ in range(lat)]
        step = size / lat
        for y in range(size):
            fy = y / step
            y0, y1 = int(fy) % lat, (int(fy) + 1) % lat
            ty = fy - int(fy)
            ty = ty * ty * (3 - 2 * ty)
            for x in range(size):
                fx = x / step
                x0, x1 = int(fx) % lat, (int(fx) + 1) % lat
                tx = fx - int(fx)
                tx = tx * tx * (3 - 2 * tx)
                out[y][x] += (
                    (grid[y0][x0] * (1 - tx) + grid[y0][x1] * tx) * (1 - ty)
                    + (grid[y1][x0] * (1 - tx) + grid[y1][x1] * tx) * ty
                ) * amp
        total += amp
        amp *= 0.5
        lat *= 2
    return [[v / total for v in row] for row in out]


def equalize(noise, size: int):
    """直方图均衡 → 0~1 均匀分布。这样颗粒是对称的，均值不会漂。"""
    flat = sorted(v for row in noise for v in row)
    n = len(flat)
    return [[sum(1 for x in flat if x <= v) / n for v in row] for row in noise]


def build_tile(size: int, base, sigma: float, noise) -> Image.Image:
    """底色 + 颗粒。

    **不含任何随坐标变化的东西** —— 贴图要平铺，任何空间渐变都会重复成条纹。
    """
    img = Image.new("RGBA", (size, size))
    px = []
    for y in range(size):
        for x in range(size):
            # 颗粒以 0 为中心对称：equalize 后的 u∈[0,1] 减 0.5 即 [-0.5, 0.5]
            delta = (noise[y][x] - 0.5) * 2 * sigma
            r = min(255, max(0, int(round(base[0] + delta))))
            g = min(255, max(0, int(round(base[1] + delta))))
            b = min(255, max(0, int(round(base[2] + delta))))
            px.append((r, g, b, int(round(255 * TILE_ALPHA))))
    img.putdata(px)
    return img


def to_uri(img: Image.Image) -> tuple[str, int]:
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    raw = buf.getvalue()
    return "url(\"data:image/png;base64," + base64.b64encode(raw).decode() + "\")", len(raw)


def report(label: str, img: Image.Image, base):
    px = list(img.getdata())
    lum = [(p[0] + p[1] + p[2]) / 3 for p in px]
    # 受光面会让均值略高于底色，这是刻意的；这里把两者都报出来便于对照
    base_lum = sum(base) / 3
    print(
        f"  {label:20} 底色 {base_lum:6.1f} | 贴图均值 {statistics.mean(lum):6.1f} "
        f"| 颗粒 σ={statistics.pstdev(lum):4.2f}/255 | 范围 {min(lum):.0f}~{max(lum):.0f}"
    )


def main():
    light_noise = equalize(periodic_value_noise(LIGHT_TILE, LIGHT_LATTICE, 3, LIGHT_SEED), LIGHT_TILE)
    rng = random.Random(DARK_SEED)
    dark_noise = [[rng.random() for _ in range(DARK_TILE)] for _ in range(DARK_TILE)]

    light_img = build_tile(LIGHT_TILE, LIGHT_BASE, LIGHT_SIGMA, light_noise)
    dark_img = build_tile(DARK_TILE, DARK_BASE, DARK_SIGMA, dark_noise)

    print("贴图实测（无需任何混合模式，卡片就是这张图）：")
    report("浅色卡片", light_img, LIGHT_BASE)
    report("深色卡片", dark_img, DARK_BASE)

    light_uri, lb = to_uri(light_img)
    dark_uri, db = to_uri(dark_img)
    print(f"\n内嵌体积：浅色 {lb}B / 深色 {db}B")

    text = TOKENS.read_text()
    # ⚠️ 必须一次遍历按序替换前两处。分两次 re.sub(count=1) 会踩坑：第一次替换后
    # 那一条仍然匹配同一个模式，第二次又会命中它 —— 浅色贴图会被深色覆盖。
    pending = iter((light_uri, dark_uri))
    text, replaced = re.subn(
        r'--glass-card-grain: url\("data:image/png;base64,[^"]+"\);',
        lambda _m: "--glass-card-grain: " + next(pending) + ";",
        text,
        count=2,
    )
    TOKENS.write_text(text)
    lengths = [
        len(m)
        for m in re.findall(r'--glass-card-grain: url\("data:image/png;base64,([^"]+)"\);', text)
    ]
    print(f"已写回 {TOKENS}（替换 {replaced} 处，长度 {lengths}）")
    if replaced != 2 or len(set(lengths)) != 2:
        raise SystemExit("✗ 两份贴图相同或数量不对 —— 写回又命中同一条了")


if __name__ == "__main__":
    main()
