// account_status SSE 事件处理器（T-P2-06；DES/03 §4 来源 2：事件 → enterTerminal）。
// 挂入 T-P2-03 的 dispatch 骨架（boot 时 register 到共享 DispatchRegistry，见 index.ts）。
// 事件事务内执行（ctx.client 即事务载体，DES/08 §1.2 步骤 b）：
// - payload.status ∈ 终态 → enterTerminal（首次：六动作同事务落库）；
// - payload 缺字段 / status 非终态（契约外形）→ warn + 返回（不中断消费、不进死信；
//   orphan.ts 已先筛掉未知 accountId，本层仍兜底 ACCOUNT_NOT_FOUND）；
// - already_same → 静默（A1 重放吸收）；already_other → warn 记日志不中断（§4 判定表逐字）。
import { AppError } from '../../http/plugins/errors.js';
import { TERMINAL_STATUSES } from '../../modules/accounts/transitions.js';
import { enterTerminal } from '../../modules/accounts/terminal.js';
import type { EventDispatchContext, EventHandler } from '../dispatch.js';
import { isRecord } from '../../gateway/client.js';

export interface AccountStatusHandlerLogger {
  warn(obj: unknown, msg?: string): void;
}

function warnLog(logger: AccountStatusHandlerLogger | undefined, obj: unknown, msg: string): void {
  (logger ?? { warn: () => {} }).warn(obj, msg);
}

export function createAccountStatusHandler(logger?: AccountStatusHandlerLogger): EventHandler {
  return async (ctx: EventDispatchContext) => {
    const payload = ctx.event.payload;
    if (!isRecord(payload)) {
      warnLog(logger ?? ctx.logger, { eventId: ctx.event.eventId }, 'account_status payload is not an object; skipped');
      return;
    }
    const accountId = payload['accountId'];
    const status = payload['status'];
    if (typeof accountId !== 'string' || typeof status !== 'string') {
      warnLog(logger ?? ctx.logger, { eventId: ctx.event.eventId, payload }, 'account_status payload missing accountId/status; skipped');
      return;
    }
    if (!(TERMINAL_STATUSES as readonly string[]).includes(status)) {
      warnLog(
        logger ?? ctx.logger,
        { eventId: ctx.event.eventId, accountId, status },
        `account_status with non-terminal status '${status}'; skipped (contract gap — gateway only pushes terminal)`,
      );
      return;
    }
    const target = status as 'suspended' | 'session_expired';
    try {
      const { outcome, from } = await enterTerminal(ctx.client, accountId, target);
      if (outcome === 'already_other') {
        // DES/03 §4：终态间无转移边 → 记日志不报错（事件路径不中断）
        warnLog(
          logger ?? ctx.logger,
          { eventId: ctx.event.eventId, accountId, from, to: target },
          'account already in a different terminal status; event ignored (already_other)',
        );
      }
      // already_same：静默幂等（A1）；entered：副作用已同事务落库
    } catch (err) {
      // orphan.ts 已按快照筛掉未知账号；仍兜底一次防止竞态（如账号行在本事件前被删）中断事件路径
      if (err instanceof AppError && err.code === 'ACCOUNT_NOT_FOUND') {
        warnLog(logger ?? ctx.logger, { eventId: ctx.event.eventId, accountId }, 'account_status for unknown account; skipped');
        return;
      }
      throw err;
    }
  };
}
