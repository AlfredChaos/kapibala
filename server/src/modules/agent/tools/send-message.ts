// send_message 工具全流程（T-P4-09；DES/06 §8.2 流程图逐字 + §8.4 选账号 + REQ A5-5/7 + E13）。
// 次序（§8.2 逐字）：幂等查表 →（命中：不发送不再审，按消息现状回 tool_result）→
//   审计门禁在 executor 上游已过（本文件被调即 verdict=pass）→ GATE1 群 active?
//   → 选账号（活跃群成员 ∧ online，account_id 字典序第一【解读】）→ T13 事务
//   （step tool_dispatched + client_msg_id + agent_idempotency_key 行 + message queued 行
//   同一事务——key 消耗时机逐字）→ 等 deliveryStatus accepted/sent 至多 5s → 各码收尾。
// 码表（§8.2/X-2 封闭）：accepted|sent→正常；failed(GROUP_UNREACHABLE)→同名；
//   failed(其他/账号终态)→SEND_FAILED（A5-5 等待中账号终态场景）；5s 仍 queued/unknown
//   →SEND_TIMEOUT（不取消不标失败——unknown 判定器继续收敛 §05 §2.4）。
import type { Pool, PoolClient } from 'pg';
import type { ToolOutcome } from '../executor.js';
import { consumeIdempotencyKey, lookupIdempotencyKey } from '../idempotency.js';
import { tx } from '../../../db/tx.js';

export const SEND_MESSAGE_DELIVERY_WAIT_MS = 5000; // §2.2「至多 5 秒」契约数字
const SEND_MESSAGE_POLL_MS = 50; // 等待轮询粒度【设计值】（5s 窗口内 100 次探测足够细）

interface MessageRow {
  readonly delivery_status: string | null;
  readonly fail_code: string | null;
}

async function readMessageStatus(client: PoolClient, clientMsgId: string): Promise<MessageRow | undefined> {
  const { rows } = await client.query<MessageRow>(
    'SELECT delivery_status, fail_code FROM message WHERE client_msg_id=$1',
    [clientMsgId],
  );
  return rows[0];
}

/** deliveryStatus → tool_result 文本与 is_error（命中路径与首次等待路径共用同一映射） */
function deliveryOutcome(clientMsgId: string, status: string | null, failCode: string | null): ToolOutcome {
  if (status === 'accepted' || status === 'sent') {
    return {
      type: 'result',
      content: JSON.stringify({ clientMsgId, deliveryStatus: status }),
      resultSummary: `${status} ${clientMsgId}`.slice(0, 200),
    };
  }
  if (status === 'failed') {
    const code = failCode === 'GROUP_UNREACHABLE' ? 'GROUP_UNREACHABLE' : 'SEND_FAILED'; // 同名码透传/终态归 SEND_FAILED（A5-5）
    return {
      type: 'result',
      content: JSON.stringify({ code, message: `message failed: ${failCode ?? 'unknown'}` }),
      isError: true,
      resultSummary: `${code}`.slice(0, 200),
    };
  }
  // queued/unknown/仍无行：等不出结论 → SEND_TIMEOUT（不取消不标失败，判定器收敛）
  return {
    type: 'result',
    content: JSON.stringify({ code: 'SEND_TIMEOUT', message: 'delivery not confirmed within 5s' }),
    isError: true,
    resultSummary: 'SEND_TIMEOUT',
  };
}

/**
 * 等待 deliveryStatus 落定（至多 waitMs）。注入缝：测试可给假等待器；
 * 生产 = 轮询 message 表（事件驱动优化归后续，轮询正确性先到位）。
 */
export type DeliveryWaiter = (
  pool: Pool,
  clientMsgId: string,
  waitMs: number,
) => Promise<MessageRow | undefined>;

export const defaultDeliveryWaiter: DeliveryWaiter = async (pool, clientMsgId, waitMs) => {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const { rows } = await pool.query<MessageRow>(
      'SELECT delivery_status, fail_code FROM message WHERE client_msg_id=$1',
      [clientMsgId],
    );
    const st = rows[0]?.delivery_status;
    if (st === 'accepted' || st === 'sent' || st === 'failed') return rows[0];
    if (Date.now() >= deadline) return rows[0];
    await new Promise((r) => setTimeout(r, SEND_MESSAGE_POLL_MS));
  }
};

interface PickRow {
  readonly account_id: string;
}

/** §8.4：活跃群成员 ∧ account.status='online'，account_id 字典序第一 */
async function pickSendAccount(client: PoolClient, groupId: string): Promise<string | undefined> {
  const { rows } = await client.query<PickRow>(
    `SELECT gm.account_id FROM group_member gm
     JOIN account a ON a.id = gm.account_id
     WHERE gm.group_id=$1 AND gm.left_at IS NULL AND a.status='online'
     ORDER BY gm.account_id ASC LIMIT 1`,
    [groupId],
  );
  return rows[0]?.account_id;
}

/**
 * 幂等预检（§8.2 KEY 分支逐字：「审计前先查幂等」——命中即短路：不发送、不再审计）。
 * executor 在审计门禁前调用；命中返回 tool_result 素材（queued/unknown 会再经等待窗落定）。
 */
export async function sendMessagePreAudit(
  ctx: { client: PoolClient; runId: string; groupId: string; input: unknown },
  deps: SendMessageDeps & { pool: Pool },
): Promise<ToolOutcome | undefined> {
  const input = (typeof ctx.input === 'object' && ctx.input !== null ? ctx.input : {}) as Record<string, unknown>;
  const key = input['idempotency_key'];
  if (typeof key !== 'string') return undefined;
  const hit = await lookupIdempotencyKey(ctx.client, ctx.runId, key);
  if (hit === undefined) return undefined;
  const row = await readMessageStatus(ctx.client, hit.clientMsgId);
  const settled =
    row !== undefined && (row.delivery_status === 'queued' || row.delivery_status === 'unknown')
      ? await (deps.waiter ?? defaultDeliveryWaiter)(deps.pool, hit.clientMsgId, deps.waitMs ?? SEND_MESSAGE_DELIVERY_WAIT_MS)
      : row;
  return deliveryOutcome(hit.clientMsgId, settled?.delivery_status ?? row?.delivery_status ?? null, settled?.fail_code ?? row?.fail_code ?? null);
}

export interface SendMessageDeps {
  readonly waiter?: DeliveryWaiter;
  readonly waitMs?: number;
}

/**
 * send_message 主流程。前置：tool_use 合法形 + 审计 pass（executor 已保证）。
 * ctx.client 是普通池连接（autocommit，executor 不包事务）；T13 三件套（step 凭据 + 幂等
 * key + queued 消息）在本函数内部自起 tx() 提交后才进入 5s 投递等待。
 */
export async function execSendMessage(
  ctx: { client: PoolClient; runId: string; groupId: string; stepSeq: number; input: unknown },
  deps: SendMessageDeps & { pool: Pool },
): Promise<ToolOutcome> {
  const input = (typeof ctx.input === 'object' && ctx.input !== null ? ctx.input : {}) as Record<string, unknown>;
  const text = input['text'];
  const key = input['idempotency_key'];
  if (typeof text !== 'string' || typeof key !== 'string') {
    return {
      type: 'result',
      content: JSON.stringify({ code: 'INVALID_INPUT', message: 'text/idempotency_key required' }),
      isError: true,
      resultSummary: 'INVALID_INPUT',
    };
  }

  // ① 幂等查表：命中 → 不发送、不再审计（本函数内无审计调用）、按消息现状回结果
  const hit = await lookupIdempotencyKey(ctx.client, ctx.runId, key);
  if (hit !== undefined) {
    const row = await readMessageStatus(ctx.client, hit.clientMsgId);
    // queued/unknown → 按首次调用相同的等待逻辑再等至多 5s（§8.2 HIT 分支逐字）
    const settled =
      row !== undefined && (row.delivery_status === 'queued' || row.delivery_status === 'unknown')
        ? await (deps.waiter ?? defaultDeliveryWaiter)(deps.pool, hit.clientMsgId, deps.waitMs ?? SEND_MESSAGE_DELIVERY_WAIT_MS)
        : row;
    return deliveryOutcome(hit.clientMsgId, settled?.delivery_status ?? row?.delivery_status ?? null, settled?.fail_code ?? row?.fail_code ?? null);
  }

  // ② GATE1：群必须 active（unreachable → GROUP_UNREACHABLE，key 不消耗——解读 #18）
  const { rows: g } = await ctx.client.query<{ status: string }>(
    `SELECT status FROM "group" WHERE id=$1`, [ctx.groupId]);
  if (g[0]?.status !== 'active') {
    return {
      type: 'result',
      content: JSON.stringify({ code: 'GROUP_UNREACHABLE', message: 'group is unreachable' }),
      isError: true,
      resultSummary: 'GROUP_UNREACHABLE',
    };
  }

  // ③ 选账号（§8.4 逐字）
  const accountId = await pickSendAccount(ctx.client, ctx.groupId);
  if (accountId === undefined) {
    return {
      type: 'result',
      content: JSON.stringify({ code: 'NO_AVAILABLE_ACCOUNT', message: 'no online group member account' }),
      isError: true,
      resultSummary: 'NO_AVAILABLE_ACCOUNT',
    };
  }

  // ④ T13 事务（自起 tx()，不再借调用方事务）：step tool_dispatched + client_msg_id +
  //    幂等 key 行 + message(queued, source='agent') 同生共死（E13）。
  //    **必须先提交再等待**：行不提交，waiter 轮询与出站 dispatcher 都看不见它——
  //    原实现把这三写留在调用方 tx 里再轮询，必然耗满 5s 假 SEND_TIMEOUT（send-message-delivery.test.ts 回归）。
  const clientMsgId = `cm-${ctx.runId}-${ctx.stepSeq}-${key}`.slice(0, 200);
  await tx(deps.pool, async (client) => {
    await client.query(
      `UPDATE agent_run_step SET status='tool_dispatched', audit_verdict='pass',
              client_msg_id=$3, updated_at=now()
       WHERE run_id=$1 AND seq=$2`,
      [ctx.runId, ctx.stepSeq, clientMsgId],
    );
    await consumeIdempotencyKey(client, { runId: ctx.runId, key, clientMsgId });
    await client.query(
      `INSERT INTO message (group_id, msg_id, client_msg_id, sender_platform_user_id, is_own, source,
                            text, sent_at, delivery_status, account_id)
       SELECT $1, NULL, $2, a.platform_user_id, true, 'agent', $3, now(), 'queued', a.id
       FROM account a WHERE a.id=$4`,
      [ctx.groupId, clientMsgId, text, accountId],
    );
  });

  // ⑤ 等 accepted/sent 至多 5s（§2.2）；期间账号终态→消息被终态取消流程标 failed→SEND_FAILED
  const settled = await (deps.waiter ?? defaultDeliveryWaiter)(
    deps.pool, clientMsgId, deps.waitMs ?? SEND_MESSAGE_DELIVERY_WAIT_MS,
  );
  return deliveryOutcome(clientMsgId, settled?.delivery_status ?? 'queued', settled?.fail_code ?? null);
}

/**
 * T-P4-11 恢复用（§9.2 send_message 行逐字）：崩溃于 tool_dispatched 时按 client_msg_id
 * 反查 message 现状生成 tool_result——queued（等待）、sent（成功）、unknown（随判定器等收敛）。
 * **绝不二次创建消息**：唯一凭据是 step.client_msg_id + message 行（幂等 key 行已在）。
 */
export async function recoverSendOutcome(
  clientMsgId: string,
  deps: { pool: Pool; waiter?: DeliveryWaiter },
): Promise<ToolOutcome> {
  const { rows } = await deps.pool.query<{ delivery_status: string; fail_code: string | null }>(
    `SELECT delivery_status, fail_code FROM message WHERE client_msg_id=$1`,
    [clientMsgId],
  );
  let status = rows[0]?.delivery_status ?? 'unknown';
  let failCode = rows[0]?.fail_code ?? null;
  if (status !== 'sent' && status !== 'failed') {
    const settled = await (deps.waiter ?? defaultDeliveryWaiter)(deps.pool, clientMsgId, SEND_MESSAGE_DELIVERY_WAIT_MS);
    if (settled !== undefined) {
      status = settled.delivery_status ?? 'unknown';
      failCode = settled.fail_code;
    }
  }
  return deliveryOutcome(clientMsgId, status, failCode);
}
