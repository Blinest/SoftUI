import type { SessionInfo } from "../softuiTypes";

/**
 * 判断会话是否属于某台设备。
 * 会话记录里 deviceId 与 deviceIds 都可能缺失，两种都要看。
 */
export function sessionBelongsToDevice(session: SessionInfo, deviceId: string): boolean {
  if (!deviceId) return false;
  if (session.deviceId && session.deviceId === deviceId) return true;
  return Array.isArray(session.deviceIds) && session.deviceIds.includes(deviceId);
}
