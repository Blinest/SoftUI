/**
 * **指令直发（本机模式）** ✓
 *
 * 背景 ✗：写入链路原来是「前端 → 后端排队 → 浏览器拉取 → 写串口」✓，
 * 源站是 HTTP/1.1 ✓，Cloudflare 隧道并发有限 ✓ → 一条指令能排队十几秒 ✗（实测 ✓）。
 * 而**串口读取早就是本机直连**了 ✓（浏览器读字节 + 本地解析 ✓），只有写入绕了远路 ✗。
 *
 * 现在：
 *   · 本端持有串口（电脑插着设备）→ **直接编码 + 写串口** ✓，ms 级 ✓
 *   · 本端没有串口（手机 / 另一台电脑）→ 返回 false ✓，调用方回退走后端排队 ✓
 *
 * ⚠ **只用于幂等指令** ✗：
 *   · 系统控制（使能 / 失能 / 急停）—— 重复发无害 ✓
 *   · 多电机同步位移（归零 / 绝对目标）—— 绝对量，重复发无害 ✓
 *   相对位移类（`0x10` 单电机定位，`dist` 是相对距离）**不能双发** ✗，
 *   直发后若再走一次后端就会走两倍距离 ✓ —— 那类要等后端提供"只记录不发送"的接口 ✓。
 */

interface SoftuiWsBridge {
  isLocal?: () => boolean;
  /** 返回本次写出的帧 hex ✓；空字符串表示没写（本端无串口 ✓）*/
  directSystemControl?: (action: string) => string;
  directHome?: (motorCount?: number, startAddress?: number) => string;
  directMotorCommand?: (motorId: number, positionMm: number, velocityMmPerSec: number) => string;
  directMultiMotor?: (positionsMm: number[], startAddress?: number) => string;
}

function bridge(): SoftuiWsBridge | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { __SOFTUI_WS__?: SoftuiWsBridge }).__SOFTUI_WS__ ?? null;
}

/** **本端是否持有可用串口** ✓ —— 决定直发还是转发 ✓ */
export function hasLocalPort(): boolean {
  try {
    return Boolean(bridge()?.isLocal?.());
  } catch {
    return false;
  }
}

/**
 * 系统控制：使能 / 失能 / 急停 ✓。
 * 返回 `true` = 已直接写入本机串口 ✓；`false` = 本端没有串口，调用方应走后端 ✓。
 */
export function directSystemControl(action: "enable" | "disable" | "emergencyStop"): string | null {
  try {
    const hex = bridge()?.directSystemControl?.(action);
    return hex ? hex : null;
  } catch (error) {
    console.warn("[direct-dispatch] 系统控制直发失败，回退后端", error);
    return null;
  }
}

/**
 * 一键归零：多电机同步位移帧，六路目标位移全 0 ✓（绝对量 ✓，重复发无害 ✓）。
 * 返回 `true` = 已直发 ✓；`false` = 应走后端 ✓。
 */
export function directHome(motorCount = 6, startAddress = 1): string | null {
  try {
    const hex = bridge()?.directHome?.(motorCount, startAddress);
    return hex ? hex : null;
  } catch (error) {
    console.warn("[direct-dispatch] 归零直发失败，回退后端", error);
    return null;
  }
}

/**
 * 单电机定位 ✓ —— ⚠ **相对位移** ✓，直发后**不要再走后端** ✗（否则走两倍距离 ✓）。
 * 目前仅在确认后端不会重发时使用 ✓。
 */
export function directMotorCommand(
  motorId: number,
  positionMm: number,
  velocityMmPerSec: number,
): string | null {
  try {
    const hex = bridge()?.directMotorCommand?.(motorId, positionMm, velocityMmPerSec);
    return hex ? hex : null;
  } catch (error) {
    console.warn("[direct-dispatch] 单电机直发失败，回退后端", error);
    return null;
  }
}

/**
 * **多电机同步位移直发** ✓ —— 六路绝对目标位移（mm，带符号）✓。
 *
 * 用途：动作组播放的每一拍、曲率/位姿下发 ✓。
 * 绝对量 ⇒ 幂等 ✓ ⇒ 可以安全地"直发 + 后端只记录"✓。
 */
export function directMultiMotor(positionsMm: number[], startAddress = 1): string | null {
  try {
    const hex = bridge()?.directMultiMotor?.(positionsMm, startAddress);
    return hex ? hex : null;
  } catch (error) {
    console.warn("[direct-dispatch] 多电机直发失败，回退后端", error);
    return null;
  }
}
