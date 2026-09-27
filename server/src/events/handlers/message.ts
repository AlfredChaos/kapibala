// message SSE 事件处理器（T-P2-08；DES/05 §3 管线挂入 T-P2-03 的 dispatch 骨架）。
// 事件事务内执行（ctx.client 即事务载体，DES/08 §1.2 b）：
// - payload 契约外形收窄（groupId/msgId/senderPlatformUserId/text/sentAt 必为 string，
//   mediaUrl 可选 string）——畸形 → warn + 跳过（账本行照留、游标照推；不进死信，
//   与 account-status.ts 的同类收口一致）；
// - 形状合法 → projectInboundMessage（去重/回流合并/agent 触发全在该收口内，幂等）。
// orphan.ts 已在分发前分流未映射群；本层不过问孤儿语义。
import { isRecord } from '../../gateway/client.js';
import type { GatewayMessageEvent } from '@kapibala/contract';
import { projectInboundMessage } from '../../modules/messages/inbound.js';
import type { EventDispatchContext, EventHandler } from '../dispatch.js';

function warn(ctx: EventDispatchContext, obj: unknown, msg: string): void {
  ctx.logger.warn(obj, msg);
}

export function createMessageHandler(): EventHandler {
  return async (ctx: EventDispatchContext) => {
    const payload = ctx.event.payload;
    if (!isRecord(payload)) {
      warn(ctx, { eventId: ctx.event.eventId }, 'message payload is not an object; skipped');
      return;
    }
    const p = payload as Record<string, unknown>;
    const valid =
      typeof p['groupId'] === 'string' &&
      typeof p['msgId'] === 'string' &&
      typeof p['senderPlatformUserId'] === 'string' &&
      typeof p['text'] === 'string' &&
      typeof p['sentAt'] === 'string' &&
      (p['mediaUrl'] === undefined || typeof p['mediaUrl'] === 'string');
    if (!valid) {
      warn(
        ctx,
        { eventId: ctx.event.eventId, payload },
        'message payload missing required fields (groupId/msgId/senderPlatformUserId/text/sentAt); skipped',
      );
      return;
    }
    const outcome = await projectInboundMessage(
      ctx.client,
      p as unknown as GatewayMessageEvent,
      ctx.logger,
    );
    if (outcome === 'skipped') {
      warn(ctx, { eventId: ctx.event.eventId }, 'inbound message skipped by projection guard');
    }
  };
}
