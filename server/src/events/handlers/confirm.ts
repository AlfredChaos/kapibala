// message_sent / message_failed SSE 事件处理器（T-P3-04；DES/05 §2.5 逐字、§4.3 唯一收口）。
// 挂入 dispatch 骨架（boot register）。事件事务内执行（ctx.client 即事务载体——账本/游标/领域写同事务）：
// - message_sent {clientMsgId,msgId,sentAt} → finalizeSent（唯一收口：常规回填/乱序合并/幂等
//   + 序列联动 + ws_event 全在该函数内，事件入口不再分叉——D1-3）；
// - message_failed {clientMsgId,code} → 按码分流（§2.5 逐字）：
//   GROUP_WRITE_FORBIDDEN → 群 unreachable 级联（§04 §5 单事务同组写：stopped 序列帧逐 run）
//     + 该条 failed；ACCOUNT_SUSPENDED → enterTerminal + 该条 failed；其余码（契约表外兜底）
//     → 仅该条 failed + 序列步 failed + warn（不静默吞）。
// payload 缺契约外形字段 → warn + 返回（不中断、不进死信——与 member handler 同约定）。
import { isRecord } from '../../gateway/client.js';
import { finalizeSent } from '../../modules/messages/finalize-sent.js';
import { applyGroupUnreachableCascade } from '../../modules/groups/state.js';
import { enterTerminal } from '../../modules/accounts/terminal.js';
import type { EventDispatchContext, EventHandler } from '../dispatch.js';
import type { AccountTerminalStatus } from '@kapibala/contract';

export interface ConfirmHandlerLogger {
  warn(obj: unknown, msg?: string): void;
}

function warnLog(ctx: EventDispatchContext, logger: ConfirmHandlerLogger | undefined, obj: unknown, msg: string): void {
  (logger ?? ctx.logger).warn(obj, msg);
}

/** message 状态行最小读数（分流需要 account_id / 当前 delivery_status / group_id） */
interface FailedMsgRow {
  id: string;
  group_id: string;
  account_id: string | null;
  delivery_status: string | null;
}

async function markMessageFailed(
  ctx: EventDispatchContext,
  row: FailedMsgRow,
  clientMsgId: string,
  code: string,
): Promise<void> {
  // 守卫集合 queued/accepted/unknown（与 dispatcher 同一前置态集合；sent/终态不重判）
  const { rowCount } = await ctx.client.query(
    `UPDATE message SET delivery_status='failed', fail_code=$2, updated_at=now()
     WHERE id=$1 AND delivery_status IN ('queued','accepted','unknown')`,
    [row.id, code],
  );
  // 序列步联动（§2.5 注：status='failed'；run 是否随败归 §07 §6——pending/accepted 守卫对称 finalizeSent）
  await ctx.client.query(
    `UPDATE sequence_run_step SET status='failed', failed_at=now(), updated_at=now()
     WHERE client_msg_id=$1 AND status IN ('pending','accepted')`,
    [clientMsgId],
  );
  if (rowCount === 1) {
    await ctx.client.query("INSERT INTO ws_event (type, payload) VALUES ('message', $1::jsonb)", [
      JSON.stringify({
        groupId: row.group_id,
        msgId: null, // failed 无网关 msgId（D3-3 未分配）
        isOwn: true,
        clientMsgId,
        deliveryStatus: 'failed',
      }),
    ]);
  }
}

export function createMessageSentHandler(logger?: ConfirmHandlerLogger): EventHandler {
  return async (ctx: EventDispatchContext) => {
    const payload = ctx.event.payload;
    if (!isRecord(payload)) {
      warnLog(ctx, logger, { eventId: ctx.event.eventId }, 'message_sent payload is not an object; skipped');
      return;
    }
    const clientMsgId = payload['clientMsgId'];
    const msgId = payload['msgId'];
    const sentAt = payload['sentAt'];
    if (
      typeof clientMsgId !== 'string' ||
      typeof msgId !== 'string' ||
      (typeof sentAt !== 'string' && !(sentAt instanceof Date))
    ) {
      warnLog(
        ctx,
        logger,
        { eventId: ctx.event.eventId, payload },
        'message_sent missing clientMsgId/msgId/sentAt; skipped',
      );
      return;
    }
    await finalizeSent(ctx.client, clientMsgId, msgId, sentAt);
  };
}

export function createMessageFailedHandler(logger?: ConfirmHandlerLogger): EventHandler {
  return async (ctx: EventDispatchContext) => {
    const payload = ctx.event.payload;
    if (!isRecord(payload)) {
      warnLog(ctx, logger, { eventId: ctx.event.eventId }, 'message_failed payload is not an object; skipped');
      return;
    }
    const clientMsgId = payload['clientMsgId'];
    const code = payload['code'];
    if (typeof clientMsgId !== 'string' || typeof code !== 'string') {
      warnLog(
        ctx,
        logger,
        { eventId: ctx.event.eventId, payload },
        'message_failed missing clientMsgId/code; skipped',
      );
      return;
    }
    const { rows } = await ctx.client.query<FailedMsgRow>(
      `SELECT id, group_id, account_id, delivery_status FROM message WHERE client_msg_id=$1`,
      [clientMsgId],
    );
    const msg = rows[0];
    if (msg === undefined) return; // 无占位行：无对象可判（账本行仍留，游标照推）

    switch (code) {
      case 'GROUP_WRITE_FORBIDDEN': {
        // A2 逐字：群 unreachable 级联 + 该条 failed（级联与 dispatcher 同一 canonical 点）
        const cascade = await applyGroupUnreachableCascade(ctx.client, msg.group_id);
        if (cascade.becameUnreachable) {
          for (const run of cascade.stoppedRuns) {
            await ctx.client.query(
              "INSERT INTO ws_event (type, payload) VALUES ('sequence_run', $1::jsonb)",
              [
                JSON.stringify({
                  runId: run.id,
                  groupId: msg.group_id,
                  status: 'stopped',
                  currentStepIndex: run.current_step_index,
                }),
              ],
            );
          }
        }
        await markMessageFailed(ctx, msg, clientMsgId, code);
        break;
      }
      case 'ACCOUNT_SUSPENDED': {
        // enterTerminal 统一入口（account_status 事件同函数；幂等分支吸收重复）
        if (msg.account_id !== null) {
          await enterTerminal(ctx.client, msg.account_id, 'suspended' as AccountTerminalStatus);
        }
        await markMessageFailed(ctx, msg, clientMsgId, code);
        break;
      }
      default: {
        // 契约表外码：该条照败 + 序列步联动；不猜额外副作用（warn 留审计线）
        warnLog(ctx, logger, { eventId: ctx.event.eventId, clientMsgId, code }, 'message_failed with unrecognized code; message marked failed only');
        await markMessageFailed(ctx, msg, clientMsgId, code);
        break;
      }
    }
  };
}
