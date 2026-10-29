# -*- coding: utf-8 -*-
"""把 tdcr_control/tools 的全阶 Cosserat 表导出成 SoftUI 的 .tdcrmodel 模型包。

用法:
    python tools/build_model_bundle.py <tools目录> [输出路径]

默认 tools 目录: D:/Continuum robot/control/tdcr_control/tools
默认输出:      src-tauri/assets/default.tdcrmodel

档位由 `--gauges` 指定（默认 "20,40"）。段 id 会跟着变成 K20/P20/S20 + K40/P40/S40。

几何常数**不再硬编码**：从同目录的 `calib.json` 读 L1/L2/EI/r_o，换臂型只换数据、不改脚本。

包格式 (TDCRMOD1):
    0   magic  "TDCRMOD1"
    8   u32 version = 1
    12  u32 section_count = 6
    16  section_count * [ char[4] id | u32 length | u32 offset ]   (offset 自文件头算)
    ... 各段数据 (4 字节对齐)

段 id: K40/K60 = 曲率表, P40/P60 = 位姿表, S40/S60 = 形状表  (40/60 = 张力上限 N)
"""
import argparse, json, math, os, struct, sys

import numpy as np

SIGMA_P_MM = 5.0
MM_PER_MRAD = 0.5
W_F = SIGMA_P_MM / MM_PER_MRAD
SHAPE_NODES = 12
# 旧的硬编码（445.2mm 臂）已移除；现在从 calib.json 读，见 read_calib()。
DEFAULT_TOOLS = r"D:\Continuum robot\control\tdcr_control\tools"
DEFAULT_GAUGES = "20,40"


def so3_log(R):
    """SO(3) 对数映射 -> 旋转向量 (rad)."""
    R = np.asarray(R, float)
    c = float(np.clip((np.trace(R) - 1.0) / 2.0, -1.0, 1.0))
    th = math.acos(c)
    if th < 1e-9:
        return np.zeros(3)
    w = np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]])
    if abs(math.pi - th) < 1e-6:
        diag = np.sqrt(np.maximum(np.diag((R + np.eye(3)) / 2.0), 0.0))
        k = int(np.argmax(diag))
        if diag[k] > 1e-12:
            v = diag / diag[k]
            return th * v / np.linalg.norm(v)
        return np.zeros(3)
    return (th / (2.0 * math.sin(th))) * w


def find_in(tools_dir, name):
    """在 tools_dir 以及它的 tables/ 子目录下找文件。

    新导出的模型包把 npz 放在 `tables/` 里、calib 放在根上；旧目录是平铺的。
    两种都兼容，省得每次手动挪文件。
    """
    for path in (os.path.join(tools_dir, name), os.path.join(tools_dir, "tables", name)):
        if os.path.exists(path):
            return path
    return None


def read_calib(tools_dir):
    """从 calib.json 读几何标定。

    旧版本把臂长硬编码成 0.445177422、驱动丝半径 6mm —— 换臂型后这些就全错了，
    而"错的几何 + 对的表"是最难查的一种不一致：模型能加载、形状却是错的。
    """
    path = find_in(tools_dir, "calib.json")
    if not os.path.exists(path):
        raise SystemExit("缺少 calib.json：%s（换臂型必须提供几何标定）" % path)
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def build(tools_dir, gauge, L1, L_total):
    table_path = find_in(tools_dir, "vc_table_%s.npz" % gauge)
    if table_path is None:
        raise SystemExit("找不到 vc_table_%s.npz（查过 %s 和其中的 tables/）" % (gauge, tools_dir))
    z = np.load(table_path, allow_pickle=True)
    kS, kK, dL = z["kS"], z["kK"], z["dL_mm"]
    p_tip, R_tip = z["p_tip"], z["R_tip"]
    n = kS.shape[0]

    # K: 4 维特征 (段A/段B 的 kx,ky 均值) + 6 维 dL
    kappa = bytearray(b"KTB1" + struct.pack("<III", n, 4, 6))
    for i in range(n):
        s = kS[i]
        mA = s <= L1 + 1e-9
        feat = [kK[i][mA, 0].mean(), kK[i][mA, 1].mean(),
                kK[i][~mA, 0].mean(), kK[i][~mA, 1].mean()]
        kappa += struct.pack("<4f", *np.asarray(feat, np.float32))
        kappa += struct.pack("<6f", *np.asarray(dL[i], np.float32))

    # P: 6 维白化位姿 + 6 维 dL
    pose = bytearray(b"PTB1" + struct.pack("<III", n, 6, 6))
    for i in range(n):
        rv = so3_log(R_tip[i]) * 1000.0
        q = np.concatenate([SIGMA_P_MM * p_tip[i] * 1000.0, W_F * rv])
        pose += struct.pack("<6f", *q.astype(np.float32))
        pose += struct.pack("<6f", *np.asarray(dL[i], np.float32))

    # S: 12 节点 (kx,ky)
    shape = bytearray(b"PSB1" + struct.pack("<III", n, SHAPE_NODES, 2))
    for i in range(n):
        s = kS[i]
        row = []
        for k in range(SHAPE_NODES):
            j = int(np.argmin(np.abs(s - (k + 0.5) / SHAPE_NODES * L_total)))
            row += [kK[i, j, 0], kK[i, j, 1]]
        shape += struct.pack("<%df" % (SHAPE_NODES * 2), *np.asarray(row, np.float32))

    return bytes(kappa), bytes(pose), bytes(shape)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tools_dir", nargs="?", default=DEFAULT_TOOLS)
    ap.add_argument("output", nargs="?", default=os.path.join("src-tauri", "assets", "default.tdcrmodel"))
    ap.add_argument("--gauges", default=DEFAULT_GAUGES,
                    help='张力档位，逗号分隔（默认 "20,40"）')
    args = ap.parse_args()

    calib = read_calib(args.tools_dir)
    L1 = float(calib["L1"])
    L2 = float(calib["L2"])
    L_total = L1 + L2
    print("calib: L1=%.3f L2=%.3f (总长 %.4f m)  EI=%.4f  r_o=%.4f m"
          % (L1, L2, L_total, float(calib["EI"]), float(calib["r_o"])))

    gauges = [g.strip() for g in args.gauges.split(",") if g.strip()]
    sections = []
    for gauge in gauges:
        k, p, s = build(args.tools_dir, gauge, L1, L_total)
        sections += [("K" + gauge, k), ("P" + gauge, p), ("S" + gauge, s)]
        print("  %sN: kappa=%d pose=%d shape=%d bytes" % (gauge, len(k), len(p), len(s)))

    toc_size = 16 + len(sections) * 12
    offset, payload, toc = toc_size, bytearray(), bytearray()
    for sid, data in sections:
        toc += sid.encode("ascii").ljust(4, b" ") + struct.pack("<II", len(data), offset)
        pad = (-len(data)) % 4
        payload += data + b"\x00" * pad
        offset += len(data) + pad
    blob = b"TDCRMOD1" + struct.pack("<II", 1, len(sections)) + bytes(toc) + bytes(payload)

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "wb") as fh:
        fh.write(blob)
    print("写出 %s (%.1f KB)" % (args.output, len(blob) / 1024.0))


if __name__ == "__main__":
    sys.exit(main())
