import type { ClientSessionView, Role } from "../softuiTypes";

/** 同一个 IP 下的一台设备（按设备标识归并）。 */
export interface DeviceGroup {
  /** 归并键：优先 clientId；取不到时退回「用户名@设备名」 */
  key: string;
  label: string;
  username: string;
  role: Role;
  userAgent: string;
  /** 该设备的访问次数（会话数） */
  count: number;
  /** 该设备最近一次活动 */
  lastSeenMs: number;
  /** 该设备下的会话，踢单台设备时要用 */
  sessions: ClientSessionView[];
}

/** 一个访问来源（同一 IP）的汇总。 */
export interface AccessGroup {
  /** 来源 IP；取不到时是占位文案 */
  ip: string;
  /** 该来源最近一次活动时间 */
  lastSeenMs: number;
  /** 该来源的总访问次数 */
  count: number;
  /** 归到这一组的会话，踢下线时要用 */
  sessions: ClientSessionView[];
  /** 二级明细：这个来源下出现过哪些设备（各带自己的访问次数） */
  devices: DeviceGroup[];
}

/** 取不到 IP 时用的占位文案，保证这些会话仍能归到同一组而不是各自成行。 */
export const UNKNOWN_IP_LABEL = "地址未知";

/**
 * 设备归并键：**设备名 + User-Agent**。
 *
 * 为什么不用 `clientId`：桩里的 clientId 存在 **sessionStorage**，是**每个标签页**
 * 一个 —— 同一台电脑开四次页面就是四个不同的 id。按它归并会把一台设备裂成四行
 * （实测线上数据就是 `桌面×4`），下拉里就看不到"这台设备来过几次"。
 *
 * 为什么保留 sessionStorage 那个 id 不改成 localStorage：它同时被 UI 同步通道
 * 用来"跳过自己写的那份"。同设备两个标签页必须**不同** id，否则彼此的改动会被
 * 对方当成自己的而丢掉。所以那是刻意的，不能动。
 *
 * 代价：两台同浏览器版本、同设备名、又在同一 IP 下的机器会被合并成一台。
 * 在这个部署规模下可以接受，而且比"一台裂成四台"更接近事实。
 */
function deviceKey(client: ClientSessionView): string {
  return `${client.label || "未命名设备"}|${client.userAgent || ""}`;
}

/**
 * 按访问来源 IP 汇总设备访问（两级）。
 *
 * 结构：`IP → 最新访问时间 + 总访问次数`，展开后是 `IP 下的每台设备 → 各自的访问次数 + 详情`。
 *
 * 为什么按 IP 而不是按会话逐条列：同一台设备每开一次页面就是一条会话，实际使用中
 * 同一个 IP 很容易堆出十几行 —— 值班时先要看的是"哪个来源、最近什么时候来的、
 * 一共来过几次"，设备级别的细节收进下拉里按需展开。
 *
 * 「访问次数」= 会话数（即登录次数）。刻意**不用**"请求次数"：前端 500ms 轮询一次，
 * 请求数会变成几十万这种没有判断价值的大数。
 */
export function groupByAccessIp(clients: ClientSessionView[]): AccessGroup[] {
  const groups = new Map<string, AccessGroup>();
  const devicesByKey = new Map<string, DeviceGroup>();

  for (const client of clients) {
    const rawIp = (client.ip ?? "").trim();
    const ip = rawIp.length > 0 ? rawIp : UNKNOWN_IP_LABEL;

    let group = groups.get(ip);
    if (!group) {
      group = { ip, lastSeenMs: client.lastSeenMs, count: 0, sessions: [], devices: [] };
      groups.set(ip, group);
    }
    group.count += 1;
    group.sessions.push(client);
    if (client.lastSeenMs > group.lastSeenMs) {
      group.lastSeenMs = client.lastSeenMs;
    }

    // 二级归并：同一个 IP 下按设备拆开。key 包含 IP，
    // 避免两台设备用同一个 clientId（复制过浏览器存储）时被错误合并。
    const key = `${ip}::${deviceKey(client)}`;
    let device = devicesByKey.get(key);
    if (!device) {
      device = {
        key,
        label: client.label || "未命名设备",
        username: client.username,
        role: client.role,
        userAgent: client.userAgent,
        count: 0,
        lastSeenMs: client.lastSeenMs,
        sessions: [],
      };
      devicesByKey.set(key, device);
      group.devices.push(device);
    }
    device.count += 1;
    device.sessions.push(client);
    if (client.lastSeenMs >= device.lastSeenMs) {
      // 用最近一次会话的信息代表这台设备的当前样貌（设备名/UA 可能变过）
      device.lastSeenMs = client.lastSeenMs;
      device.label = client.label || device.label;
      device.userAgent = client.userAgent;
      device.username = client.username;
      device.role = client.role;
    }
  }

  for (const group of groups.values()) {
    // 设备也按最近活动倒序：展开后第一眼看到的就是"刚才在用的那台"
    group.devices.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
  }

  // 最近来过的来源排前面
  return Array.from(groups.values()).sort((a, b) => b.lastSeenMs - a.lastSeenMs);
}
