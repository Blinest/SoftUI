import type { ChartSection, DeviceSnapshot, SensorState } from "../softuiTypes";

/**
 * 在前端直接下载文本文件。
 *
 * 为什么不再走服务端导出：以前是让后端把 CSV **写到网关那台机器的磁盘上**。
 * 容器磁盘本来只剩 2 G，导出几次就攒一堆没人清理的文件；用户还得再想办法
 * 进服务器把文件拷出来。那两个服务端导出命令已经删除，导出全部在这里完成：
 * 用 Blob + <a download>，数据不落地，点一下就进浏览器下载目录。
 */
export function downloadText(
  filename: string,
  content: string,
  mime = "text/csv;charset=utf-8",
): void {
  // BOM：不加的话 Excel 打开中文列名会乱码
  const blob = new Blob(["\uFEFF", content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 立刻 revoke 在部分浏览器上会打断下载，延后释放
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** CSV 单元格转义：逗号、引号、换行都要处理，否则列会串位。 */
function cell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function row(values: unknown[]): string {
  return values.map(cell).join(",");
}

/** 时间戳 → 本地可读时间，方便直接在 Excel 里排序。 */
function stamp(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

/** 传感器是多轴读数，压成一列便于表格查看。 */
function sensorValue(sensor: SensorState | undefined): string {
  if (!sensor) return "";
  return sensor.filtered
    .map((value) => (Number.isFinite(value) ? value.toFixed(3) : ""))
    .join(" ");
}

/**
 * 会话帧 → CSV：一行一帧。
 * 电机/传感器的数量按实际帧里的最大值展开，缺的留空 —— 中途断过设备也不会错列。
 */
export function framesToCsv(frames: DeviceSnapshot[]): string {
  if (frames.length === 0) return "无数据\r\n";

  const motorCount = Math.max(0, ...frames.map((frame) => frame.motors.length));
  const sensorCount = Math.max(0, ...frames.map((frame) => frame.sensors.length));

  const header = [
    "时间",
    "序号",
    "设备",
    "系统使能",
    ...Array.from({ length: motorCount }, (_, i) => `电机${i + 1}位置(mm)`),
    ...Array.from({ length: motorCount }, (_, i) => `电机${i + 1}速度(mm/s)`),
    ...Array.from({ length: sensorCount }, (_, i) => `传感器${i + 1}`),
    "第1段弯曲角(deg)",
    "第2段弯曲角(deg)",
    "质量",
  ];

  const lines = frames.map((frame) =>
    row([
      stamp(frame.receivedAtMs),
      frame.sequence,
      frame.deviceId,
      frame.systemEnabled ? 1 : 0,
      ...Array.from({ length: motorCount }, (_, i) => frame.motors[i]?.positionMm ?? ""),
      ...Array.from({ length: motorCount }, (_, i) => frame.motors[i]?.velocityMmPerSec ?? ""),
      ...Array.from({ length: sensorCount }, (_, i) => sensorValue(frame.sensors[i])),
      frame.bend.section1.angleDeg,
      frame.bend.section2.angleDeg,
      frame.quality.status,
    ]),
  );

  return [row(header), ...lines].join("\r\n") + "\r\n";
}

/** 曲线数据 → CSV：第一列时间，其余每个通道一列。 */
export function chartsToCsv(charts: ChartSection): string {
  if (charts.timestamps.length === 0) return "无数据\r\n";

  const header = [
    "时间",
    ...charts.channels.map((channel) =>
      channel.unit ? `${channel.name}(${channel.unit})` : channel.name,
    ),
  ];

  const lines = charts.timestamps.map((ms, index) =>
    row([
      stamp(ms),
      ...charts.channels.map((channel) => {
        const value = channel.points[index];
        return value == null || !Number.isFinite(value) ? "" : value;
      }),
    ]),
  );

  return [row(header), ...lines].join("\r\n") + "\r\n";
}

/** 文件名用的时间戳，避免多次导出互相覆盖。 */
export function exportStamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/* ── 二进制内容 ───────────────────────────────────────────────────────
 * 模型包是二进制（431 KB）。后端用 base64 传过来（直接传字节数组会被
 * serde 编成几十万个数字，体积膨胀 3 倍），这里解回字节。
 * ──────────────────────────────────────────────────────────────────── */

/** base64 → 字节。手写而不引依赖：只需要这一个方向。 */
export function base64ToBytes(base64: string): Uint8Array {
  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let outIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const value = table.indexOf(ch);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, outIndex);
}

/* ── 导出目标：直接下载 / 存进指定文件夹 ──────────────────────────────
 * 「存到文件夹」用的是 File System Access API（Chrome/Edge 桌面版 + 安全
 * 上下文）。不支持时自动退回下载 —— 功能不能因为浏览器差异就不可用。
 * ──────────────────────────────────────────────────────────────────── */

interface DirectoryPickerWindow {
  showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
}

export function supportsFolderSave(): boolean {
  return typeof (window as unknown as DirectoryPickerWindow).showDirectoryPicker === "function";
}

/** 用户选中的导出文件夹。只在本页生命周期内记住，不落任何存储。 */
let exportDirectory: FileSystemDirectoryHandle | null = null;

export function currentExportFolder(): string {
  return exportDirectory?.name ?? "";
}

/** 让用户选一次文件夹；已选过就直接复用，不反复弹窗。 */
export async function pickExportFolder(): Promise<string> {
  const picker = (window as unknown as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) throw new Error("当前浏览器不支持选择文件夹，请改用「直接下载」");
  exportDirectory = await picker.call(window);
  return exportDirectory.name;
}

/** 统一出口：按目标把内容存下去。返回一句给人看的说明。 */
export async function saveExport(
  fileName: string,
  blob: Blob,
  target: "download" | "folder",
): Promise<string> {
  if (target === "folder" && exportDirectory) {
    // 用户可能已撤销授权，这里失败就如实抛出，由调用方提示改用下载
    const handle = await exportDirectory.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return `已保存到文件夹「${exportDirectory.name}」：${fileName}`;
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 立刻 revoke 在部分浏览器上会打断下载，延后释放
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return `已下载：${fileName}`;
}

