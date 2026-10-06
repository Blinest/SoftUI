import type { Permission, RuntimeSnapshot } from "../softuiTypes";

/**
 * 当前会话是否具备某项权限。
 *
 * ⚠ 前端门控只解决「看得见 / 点得动」，**不是安全边界** —— 后端每个命令都会
 * 再校验一遍（`guard_permission`）。做门控的唯一目的是：别让操作员看到一个
 * 点下去必然报 "permission denied" 的按钮。
 */
export function hasPermission(snapshot: RuntimeSnapshot, permission: Permission): boolean {
  const session = snapshot.authSession;
  return session.authenticated && session.permissions.includes(permission);
}

/**
 * 缺权限时的说明文案。
 *
 * 要写清"需要什么角色"，而不是干巴巴的"权限不足" —— 现场看到这句话才知道
 * 该找谁开权限，否则只能回头问开发。
 */
export const PERMISSION_REASON: Record<Permission, string> = {
  viewDashboard: "需要查看仪表盘权限",
  connectDevice: "需要连接设备权限",
  sendMotionCommand: "需要下发运动指令权限（且设备需先使能）",
  runCalibration: "校准会改写传感器基线，需要维护员（maintainer）及以上权限",
  runCycleLife: "循环寿命测试会持续往复磨损臂体，需要维护员（maintainer）及以上权限",
  manageSessions: "需要会话管理权限",
  viewDiagnostics: "导出诊断包需要维护员（maintainer）及以上权限",
  manageSettings: "修改系统设置需要维护员（maintainer）及以上权限",
  manageUsers: "管理账号与设备访问仅限管理员（admin）",
};

/** 角色 → 一句话职责。让"这个角色到底能干什么"在界面上可查，而不是靠猜。 */
export const ROLE_DUTY: Record<string, string> = {
  operator: "只读与操作：查看仪表盘、连接设备、下发运动指令",
  maintainer: "现场维护：录制与回放、会话导出、校准、参数整定、循环寿命、诊断",
  admin: "系统管理：账号、设备访问、注册审批",
};

/** 角色的独占职责清单（用于界面上把权限边界讲清楚）。 */
export const ROLE_EXCLUSIVE: Record<string, string[]> = {
  operator: ["查看仪表盘与曲线", "连接设备并下发运动指令"],
  maintainer: [
    "录制 / 回放 / 导出会话数据",
    "传感器校准、参数整定、循环寿命测试",
    "导出诊断包、修改系统设置",
  ],
  admin: ["管理账号与设备访问", "审批自助注册、设置设备上限"],
};

/**
 * 关键能力清单，顺序即"门槛从低到高"。
 * 界面上据此显示「可用 / 需 maintainer / 仅 admin」，让"这个角色能干什么"
 * 变成界面上可查的事实，而不是要问开发。
 */
export const CAPABILITY_MATRIX: Array<{
  permission: Permission;
  label: string;
  since: "operator" | "maintainer" | "admin";
}> = [
  { permission: "connectDevice", label: "连接设备并下发指令", since: "operator" },
  { permission: "manageSessions", label: "录制 / 回放 / 导出会话", since: "maintainer" },
  { permission: "runCalibration", label: "传感器校准", since: "maintainer" },
  { permission: "runCycleLife", label: "循环寿命测试", since: "maintainer" },
  { permission: "viewDiagnostics", label: "诊断包导出", since: "maintainer" },
  { permission: "manageSettings", label: "系统设置与参数整定", since: "maintainer" },
  { permission: "manageUsers", label: "账号与设备访问管理", since: "admin" },
];
