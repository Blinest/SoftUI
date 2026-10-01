# -*- coding: utf-8 -*-
"""把 tdcr_control/tools 的全阶 Cosserat 表导出成 SoftUI 的 .tdcrmodel 模型包。

用法:
    python tools/build_model_bundle.py <tools目录> [输出路径]

默认 tools 目录: D:/Continuum robot/control/tdcr_control/tools
默认输出:      src-tauri/assets/default.tdcrmodel

包格式 (TDCRMOD1):
    0   magic  "TDCRMOD1"
    8   u32 version = 1
    12  u32 section_count = 6
    16  section_count * [ char[4] id | u32 length | u32 offset ]   (offset 自文件头算)
    ... 各段数据 (4 字节对齐)

段 id: K40/K60 = 曲率表, P40/P60 = 位姿表, S40/S60 = 形状表  (40/60 = 张力上限 N)
"""
import argparse, math, os, struct, sys

import numpy as np

SIGMA_P_MM = 5.0
MM_PER_MRAD = 0.5
W_F = SIGMA_P_MM / MM_PER_MRAD
SHAPE_NODES = 12
L_TOTAL_M = 0.445177422          # 与 tendon_coupling.py 的 L1=L2=0.2225887 一致
DEFAULT_TOOLS = r"D:\Continuum robot\control\tdcr_control\tools"


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


def seg_lengths():
    a = math.radians(12.0)
    r = 0.020
    lax_a = 2 * (math.pi * r / (6 * math.cos(a))) * math.sin(a)
    lax_b = 2 * (math.pi * r / (3 * math.cos(a))) * math.sin(a)
    return 50 * lax_a, 25 * lax_b


def build(tools_dir, gauge, L1):
    z = np.load(os.path.join(tools_dir, "vc_table_%s.npz" % gauge), allow_pickle=True)
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
            j = int(np.argmin(np.abs(s - (k + 0.5) / SHAPE_NODES * L_TOTAL_M)))
            row += [kK[i, j, 0], kK[i, j, 1]]
        shape += struct.pack("<%df" % (SHAPE_NODES * 2), *np.asarray(row, np.float32))

    return bytes(kappa), bytes(pose), bytes(shape)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tools_dir", nargs="?", default=DEFAULT_TOOLS)
    ap.add_argument("output", nargs="?", default=os.path.join("src-tauri", "assets", "default.tdcrmodel"))
    args = ap.parse_args()

    L1, L2 = seg_lengths()
    print("段长 L1=%.6f L2=%.6f m" % (L1, L2))

    sections = []
    for gauge in ("40", "60"):
        k, p, s = build(args.tools_dir, gauge, L1)
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
