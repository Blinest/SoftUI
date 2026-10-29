# -*- coding: utf-8 -*-
"""生成一个**新版格式**（KTB1/PTB1/KSB1/KKB1/META）的最小 `.tdcrmodel` 示例。

用途：看格式 / 做导入测试。数据直接取自仓库里真实的模型包
（`src-tauri/assets/tdcr_20261025.tdcrmodel`），只保留前 N 个样本，
所以它能被真实的 Rust 解析器接受，但**样本太少，不能用于实际控制**。

用法：
    python tools/example_model_bundle.py                       # 默认 5 个样本
    python tools/example_model_bundle.py --samples 20 -o /tmp/ex.tdcrmodel

容器格式（TDCRMOD1，全部小端）：
    0   char[8]  "TDCRMOD1"
    8   u32      version = 1
    12  u32      section_count
    16  section_count × [char[4] id | u32 length | u32 offset]   # offset 从文件头算
    ... 各段数据（每段按 4 字节对齐）

段内容（float32 小端、行主序，n = 样本数）：
    KTB1: u32 n                       + n × 12 × f32   (tau[6] N, dL_mm[6])
    PTB1: u32 n                       + n × 12 × f32   (p_tip[3] m, R_tip[9] 行主序)
    KSB1: u32 n + u32 nodes(=61)      + n × 61 × f32   (弧长 s，m)
    KKB1: u32 n + u32 nodes(=61)      + n × 183 × f32  (每个节点 kx, ky, |κ|)
    META: UTF-8 JSON（可选；tau_max 决定 UI 显示的张力档位）
"""
import argparse
import json
import os
import struct
import sys

MAGIC = b"TDCRMOD1"
VERSION = 1
# 每段固定宽度（f32 个数/样本）
ROW_WIDTH = {"KTB1": 12, "PTB1": 12, "KSB1": 61, "KKB1": 183}
# 有 "u32 n + u32 nodes" 头的段
NESTED = {"KSB1", "KKB1"}
DEFAULT_SOURCE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "src-tauri", "assets", "tdcr_20261025.tdcrmodel"
)


def read_index(blob):
    """读 TDCRMOD1 的段索引 → {id: bytes}。"""
    if blob[:8] != MAGIC:
        raise SystemExit("不是 TDCRMOD1：%r" % blob[:8])
    version, count = struct.unpack("<II", blob[8:16])
    if version != VERSION:
        raise SystemExit("版本不支持：%d" % version)
    out = {}
    for i in range(count):
        base = 16 + i * 12
        sid = blob[base:base + 4].decode("ascii").strip()
        length, offset = struct.unpack("<II", blob[base + 4:base + 12])
        out[sid] = blob[offset:offset + length]
    return out


def take_rows(section, width, keep, nested=False):
    """从段里取前 keep 个样本，重写计数头。"""
    head = 8 if nested else 4
    n_declared = struct.unpack("<I", section[0:4])[0]
    if n_declared < keep:
        raise SystemExit("源表只有 %d 个样本，不够 %d 个" % (n_declared, keep))
    if nested:
        nodes = struct.unpack("<I", section[4:8])[0]
        if nodes * 3 != width and nodes != width:
            raise SystemExit("节点数异常：%d" % nodes)
        header = struct.pack("<II", keep, nodes)
    else:
        header = struct.pack("<I", keep)
    row_bytes = width * 4
    body = section[head:head + keep * row_bytes]
    return header + body


def build(sections, keep):
    """把若干段装进 TDCRMOD1 容器。"""
    toc_size = 16 + len(sections) * 12
    offset = toc_size
    toc, payload = bytearray(), bytearray()
    for sid, data in sections:
        assert len(sid) == 4, sid
        toc += sid.encode("ascii") + struct.pack("<II", len(data), offset)
        pad = (-len(data)) % 4  # 让下一段 4 字节对齐
        payload += data + b"\x00" * pad
        offset += len(data) + pad
    return MAGIC + struct.pack("<II", VERSION, len(sections)) + bytes(toc) + bytes(payload)


def verify(path, keep):
    """按 Rust 解析器的规则回读一遍：结构、行数、宽度。"""
    blob = open(path, "rb").read()
    index = read_index(blob)
    assert set(index) == {"KTB1", "PTB1", "KSB1", "KKB1", "META"}, sorted(index)
    counts = {}
    for sid, data in index.items():
        if sid == "META":
            meta = json.loads(data.decode("utf-8"))
            assert meta["n"] == keep, (sid, meta["n"])
            continue
        n = struct.unpack("<I", data[0:4])[0]
        head = 8 if sid in NESTED else 4
        width = (len(data) - head) // 4 // n
        assert width == ROW_WIDTH[sid], (sid, width, ROW_WIDTH[sid])
        assert len(data) == head + n * width * 4, (sid, len(data))
        counts[sid] = n
    assert len(set(counts.values())) == 1, counts
    print("verify OK: %d 样本，文件 %d 字节" % (keep, len(blob)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=DEFAULT_SOURCE, help="真实模型包（只取其前 N 个样本）")
    ap.add_argument("--samples", type=int, default=5, help="保留多少个样本（默认 5）")
    ap.add_argument("-o", "--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                        "example_20n.tdcrmodel"))
    args = ap.parse_args()

    source = read_index(open(args.source, "rb").read())
    sections = []
    for sid in ("KTB1", "PTB1", "KSB1", "KKB1"):
        sections.append((sid, take_rows(source[sid], ROW_WIDTH[sid], args.samples,
                                        nested=sid in NESTED)))

    meta = json.loads(source["META"].decode("utf-8"))
    meta["n"] = args.samples
    meta["tag"] = "vc_table_real_20_example"
    meta["note"] = "format example: only %d samples, do NOT use for real control" % args.samples
    sections.append(("META", json.dumps(meta, ensure_ascii=False).encode("utf-8")))

    blob = build(sections, args.samples)
    with open(args.out, "wb") as handle:
        handle.write(blob)

    print("写出 %s（%d 字节）" % (args.out, len(blob)))
    print("段表：")
    count = struct.unpack("<I", blob[12:16])[0]
    for i in range(count):
        base = 16 + i * 12
        sid = blob[base:base + 4].decode().strip()
        length, offset = struct.unpack("<II", blob[base + 4:base + 12])
        print("  %-4s len=%6d offset=%6d" % (sid, length, offset))
    verify(args.out, args.samples)


if __name__ == "__main__":
    sys.exit(main())
