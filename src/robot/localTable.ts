import { invoke } from "@tauri-apps/api/core";

/**
 * **前端本地位移表** ✓ —— 把后端的 `PTB1`（尖端位置）+ `KTB1`（六路位移）
 * 一次性拉到浏览器 ✓，之后**本地做 K 邻域 IDW 反查** ✓。
 *
 * 为什么要这么做 ✗：曲率/位姿下发原来必须"后端查表 + 后端发送"✓，
 * 查表那一段是一条 RPC 往返 ✓ —— 经 Cloudflare 隧道 200ms 起步 ✓，排队时十几秒 ✗。
 * 表本身只有 1031 个样本 ✓（索引约 190KB ✓），拉到前端完全可行 ✓。
 *
 * 拉到之后：
 *   · 拖动 → 位姿下发 → 动作组，全部**纯本地计算 + 本机直发** ✓ → ms 级 ✓
 *   · 服务器只留档（`control_frame_log`）✓，不再参与实时链路 ✓
 *
 * ⚠ 与后端 `interpolate_by_tip_mm` **必须同口径** ✗：
 *   · 邻居数 K = 10
 *   · 权重 `1 / (d + 1)²`（+1mm 防除零 ✓）
 *   · 最近邻距离 > 120mm 判为超域 ✓
 *   任何一处不一致都会让"预览的形状"和"下发的位移"对不上 ✓。
 */

interface TableSample {
  tip: [number, number, number];
  dl: number[];
}

interface TableIndexPayload {
  n: number;
  samples: TableSample[];
}

let samples: TableSample[] | null = null;
let loading: Promise<TableSample[] | null> | null = null;

const K = 10;
const MAX_NEAREST_MM = 120;

function parse(payload: TableIndexPayload): TableSample[] {
  const list: TableSample[] = [];
  for (const item of payload.samples ?? []) {
    if (!item || !Array.isArray(item.tip) || !Array.isArray(item.dl)) continue;
    if (item.tip.length < 3 || item.dl.length < 6) continue;
    list.push({ tip: [item.tip[0], item.tip[1], item.tip[2]], dl: item.dl });
  }
  return list;
}

/**
 * **确保表已加载** ✓ —— 幂等 ✓，并发调用共用同一个 Promise ✓。
 * 返回 `true` 表示可用 ✓。
 */
export async function ensureLocalTable(): Promise<boolean> {
  if (samples && samples.length > 0) return true;
  if (!loading) {
    loading = invoke<TableIndexPayload>("vc_table_index")
      .then((payload) => {
        const list = parse(payload);
        samples = list.length > 0 ? list : null;
        if (!samples) console.warn("[local-table] 位移表为空");
        return samples;
      })
      .catch((error) => {
        console.warn("[local-table] 加载失败，回退后端查表", error);
        return null;
      })
      .finally(() => {
        loading = null;
      });
  }
  const result = await loading;
  return Boolean(result && result.length > 0);
}

/** 本地表是否已经可用（不会触发加载 ✓）*/
export function hasLocalTable(): boolean {
  return Boolean(samples && samples.length > 0);
}

/** 清空缓存（换模型包时必须调 ✓，否则还用旧表的位移 ✗）*/
export function clearLocalTable() {
  samples = null;
  loading = null;
}

export interface LocalLookup {
  displacementMm: number[];
  nearestMm: number;
}

/**
 * **本地反查** ✓ —— 与后端 `interpolate_by_tip_mm` 同口径 ✓。
 *
 * 输入：目标尖端位置（svc 系，mm）✓
 * 输出：6 路目标位移（mm）+ 最近邻距离 ✓；超域返回 null ✓（调用方应拒绝下发 ✓）。
 */
export function lookupLocal(positionMm: [number, number, number]): LocalLookup | null {
  const list = samples;
  if (!list || list.length === 0) return null;

  // ① 维护 K 个最近邻（按距离升序 ✓）
  const best: Array<{ index: number; distance: number }> = [];
  for (let index = 0; index < list.length; index += 1) {
    const tip = list[index].tip;
    const dx = tip[0] - positionMm[0];
    const dy = tip[1] - positionMm[1];
    const dz = tip[2] - positionMm[2];
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (best.length < K) {
      best.push({ index, distance });
      best.sort((a, b) => a.distance - b.distance);
    } else if (distance < best[best.length - 1].distance) {
      best.pop();
      best.push({ index, distance });
      best.sort((a, b) => a.distance - b.distance);
    }
  }
  if (best.length === 0) return null;

  const nearest = best[0].distance;
  if (nearest > MAX_NEAREST_MM) return null;

  // ② 权重 1/(d+1)²，归一化后加权平均 ✓
  let total = 0;
  const weights = best.map((item) => {
    const weight = 1 / ((item.distance + 1) * (item.distance + 1));
    total += weight;
    return weight;
  });

  const displacement = [0, 0, 0, 0, 0, 0];
  for (let slot = 0; slot < best.length; slot += 1) {
    const share = weights[slot] / total;
    const dl = list[best[slot].index].dl;
    for (let axis = 0; axis < 6; axis += 1) {
      displacement[axis] += (dl[axis] ?? 0) * share;
    }
  }

  return { displacementMm: displacement, nearestMm: nearest };
}
