// 开关读取共享助手（T-P1-04 从 groups.ts 提升；DES/14 §4 scenario 语义）。
// 供群域 / 消息域 / 后续任务共用：钉值与目标命中的唯一解释点。
import type { GatewayState, SwitchConfig } from './state.js';

/** 开关探查目标：按需携带（groupId / accountId / clientMsgId），缺省键 = 不限定 */
export interface SwitchTarget {
  groupId?: string;
  accountId?: string;
  clientMsgId?: string;
}

/**
 * 开关是否命中：无 target = 全局；有 target 时，配置侧声明的每个 target 键都必须命中
 * （配置只写 groupId 时，带 accountId/clientMsgId 的探查也算命中——「按群钉死」覆盖面更大）。
 * 返回命中的配置（含 params），供钉值读取。
 */
export function activeSwitch(
  state: GatewayState,
  switchName: string,
  target?: SwitchTarget,
): SwitchConfig | undefined {
  const config = state.switches.get(switchName);
  if (config === undefined) {
    return undefined;
  }
  if (target === undefined || config.target === undefined) {
    return config;
  }
  for (const [key, value] of Object.entries(config.target)) {
    const probed =
      key === 'groupId'
        ? target.groupId
        : key === 'accountId'
          ? target.accountId
          : key === 'clientMsgId'
            ? target.clientMsgId
            : undefined;
    if (probed !== value) {
      return undefined;
    }
  }
  return config;
}

/** 读开关的数值参数（钉值）；非有限数字视为未钉 */
export function readNumberParam(config: SwitchConfig | undefined, key: string): number | undefined {
  const value = config?.params?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 读开关的布尔参数；缺省用 fallback */
export function readBooleanParam(config: SwitchConfig | undefined, key: string, fallback: boolean): boolean {
  const value = config?.params?.[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** 读开关的字符串参数 */
export function readStringParam(config: SwitchConfig | undefined, key: string): string | undefined {
  const value = config?.params?.[key];
  return typeof value === 'string' ? value : undefined;
}
