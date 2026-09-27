// 开关读取共享助手（T-P1-04 从 groups.ts 提升；DES/14 §4 scenario 语义）。
// 供群域 / 消息域 / 开关层（src/switches/*）共用：钉值、目标命中与契约区间随机源的唯一解释点。
import type { GatewayState, SwitchConfig } from './state.js';

/** 开关探查目标：按需携带（groupId / accountId / clientMsgId / mediaId），缺省键 = 不限定 */
export interface SwitchTarget {
  groupId?: string;
  accountId?: string;
  clientMsgId?: string;
  /** 媒体对象 id（gw-27 `media_expire_404` 按媒体收窄用） */
  mediaId?: string;
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
  // 配置侧声明的每个 target 键都必须在探查目标里取到同值；未声明的键不限定
  const probed: Record<string, string | undefined> = { ...target };
  for (const [key, value] of Object.entries(config.target)) {
    if (probed[key] !== value) {
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

/**
 * 契约区间内均匀取整（mock 内部随机源）。区间**端点数字是契约**（QR §1），
 * 逐开关定义在 src/switches/*.ts 的常量里并带出处——本函数只负责取值。
 */
export function randomBetween(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** 读开关 target 的字符串键（accountId / groupId / clientMsgId）；未给或空串 = 未指定 */
export function readTargetString(config: SwitchConfig, key: keyof SwitchTarget): string | undefined {
  const value = config.target?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
