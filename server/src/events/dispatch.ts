// 事件分发骨架（T-P2-03 创建；DES/08 §1.2 步骤 b）。
// lane-A 共享文件（DAG 规则 7，渐进编辑链 T-P2-03 → T-P2-06/08/09 → T-P3-04…）：
// 领域处理器后续任务经 register() 逐类型替换本文件的骨架 stub——接线点形状在此定死，
// 本文件不承载任何领域逻辑（消息落地 §05、成员 §04、账号终态 §03 各自归卡）。
// 分发发生在事件处理事务【内】（ctx.client 即事务载体）：handler 必须幂等——
// at-least-once 重复推送 / 重连补拉都会重放（REQ §2.1、DES/08 §1.2）。
import { GATEWAY_EVENT_TYPES, type GatewayEventType } from '@kapibala/contract';
import type { PoolClient } from 'pg';

/** 最小日志面（pino Logger 结构兼容；与 scheduler/recovery 同模式，测试可用普通对象 fake） */
export interface DispatchLogger {
  warn(obj: unknown, msg?: string): void;
}

/** 账本视图：gateway_event 行同源（eventId/type/payload） */
export interface GatewayEventEnvelope {
  readonly eventId: number;
  /** 帧的 event 类型；契约外类型原样保留（账本照记，分发按 unknown 跳过） */
  readonly type: string;
  /** 帧 data 的 JSON 解析结果；坏 JSON 时为 rawData 原文（内容不丢，A2） */
  readonly payload: unknown;
}

export interface EventDispatchContext {
  /** 事件处理事务的载体——handler 的 DB 写必须走它（游标/账本/领域写同事务，§1.2） */
  readonly client: PoolClient;
  readonly event: GatewayEventEnvelope;
  readonly logger: DispatchLogger;
}

export type EventHandler = (ctx: EventDispatchContext) => Promise<void>;

export interface DispatchRegistry {
  /** 未知类型返回 undefined（分发处 log + skip，消费不中断） */
  get(type: string): EventHandler | undefined;
  /** 领域任务（T-P2-06/08/09…）逐类型替换 stub；重复注册 = 替换（渐进接线语义） */
  register(type: GatewayEventType, handler: EventHandler): void;
}

export function createDispatchRegistry(): DispatchRegistry {
  const handlers = new Map<string, EventHandler>();
  for (const type of GATEWAY_EVENT_TYPES) {
    // 骨架 stub：领域处理器按类型在后续任务落地并经 register() 替换——
    // message → T-P2-08（DES/05 §3）；message_sent / message_failed → T-P3-04（finalizeSent §4.3）；
    // member_joined / member_left → T-P2-09（DES/04 §4）；account_status → T-P2-06（DES/03 §4）。
    handlers.set(type, async () => {});
  }
  return {
    get: (type) => handlers.get(type),
    register: (type, handler) => {
      handlers.set(type, handler);
    },
  };
}

/**
 * 事务内分发。未知 type → log + skip（账本行照留、游标照推——否则 gap 永久卡死前缀；
 * 事件内容已在 gateway_event.payload，后续任务补 handler 时可审计回放）。
 */
export async function dispatchEvent(
  registry: DispatchRegistry,
  ctx: EventDispatchContext,
): Promise<'handled' | 'unknown'> {
  const handler = registry.get(ctx.event.type);
  if (handler === undefined) {
    ctx.logger.warn(
      { eventId: ctx.event.eventId, type: ctx.event.type },
      'unknown gateway event type; skipped (ledger row kept, cursor advances)',
    );
    return 'unknown';
  }
  await handler(ctx);
  return 'handled';
}
