// member_joined / member_left SSE 事件处理器（T-P2-09；DES/04 §4 事件路径唯一写源）。
// 挂入 dispatch 骨架（boot 时 register，见 index.ts）。事件事务内执行（ctx.client 即事务载体）：
// - payload 缺 groupId/platformUserId（契约外形）→ warn + 返回（不中断、不进死信）；
// - 投影逻辑在 modules/groups/members.ts（单调防线/墓碑/R-A 终态判定全部在那里）。
// eventId 取信封字段（消费层已按账本行分配全局单调 id），payload.eventId 仅冗余校验。
import { isRecord } from '../../gateway/client.js';
import { projectMemberJoined, projectMemberLeft } from '../../modules/groups/members.js';
import type { EventDispatchContext, EventHandler } from '../dispatch.js';

export interface MemberHandlerLogger {
  warn(obj: unknown, msg?: string): void;
}

function warnLog(logger: MemberHandlerLogger | undefined, obj: unknown, msg: string): void {
  (logger ?? { warn: () => {} }).warn(obj, msg);
}

export function createMemberHandler(logger?: MemberHandlerLogger): EventHandler {
  return async (ctx: EventDispatchContext) => {
    const payload = ctx.event.payload;
    if (!isRecord(payload)) {
      warnLog(logger ?? ctx.logger, { eventId: ctx.event.eventId, type: ctx.event.type }, 'member event payload is not an object; skipped');
      return;
    }
    const groupId = payload['groupId'];
    const platformUserId = payload['platformUserId'];
    if (typeof groupId !== 'string' || typeof platformUserId !== 'string') {
      warnLog(
        logger ?? ctx.logger,
        { eventId: ctx.event.eventId, type: ctx.event.type, payload },
        'member event missing groupId/platformUserId; skipped',
      );
      return;
    }
    const input = { groupId, platformUserId, eventId: ctx.event.eventId };
    if (ctx.event.type === 'member_joined') {
      await projectMemberJoined(ctx.client, input);
    } else {
      // dispatch 骨架只放 GATEWAY_EVENT_TYPES 里的类型；到达这里即 member_left
      await projectMemberLeft(ctx.client, input);
    }
  };
}
