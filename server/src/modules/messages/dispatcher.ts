// 出站 dispatcher（T-P3-02；DES/05 §2.1–§2.3、DES/03 §5.2、DES/10 E7、REQ A2 错误对照表）。
// 形态：唤醒驱动（accept.onAccepted / ratelimit 到期 / dispatch-wakeup 扫描兜底）+ 每账号一个
//   在途 pump（pg_try_advisory_lock 会话级串行；§2.2「同一账号顺序保证、至多一条在途」）。
// 逐条纪律（§2.3 分流表逐字）：
//   取最早 queued AND first_attempt_at IS NULL（id 升序）→ 硬闸门 checkRateLimit（最外层，
//   宪法 §3-4）→ first_attempt_at=now() 落库先于调网关（E7/I1：崩溃窗口=结果未知）→
//   send → 八向分流：
//     202                  → accepted（守卫 delivery_status IN ('queued','unknown')，D1-2 配套）
//     429 RATE_LIMITED     → registerRateLimit + 消息保持 queued（first_attempt_at 复位 NULL：
//                            请求未达业务层=A2「确认未发出」，复位才保持可拾取；期内 0 次试探由
//                            闸门保证——泵随 registerRateLimit 返回后 break，到期经 wakeDispatcher 补发）
//     403 ACCOUNT_SUSPENDED / 401 SESSION_EXPIRED → enterTerminal（副作用内置）+ 该条 failed 同名码
//     403 GROUP_WRITE_FORBIDDEN → 群 unreachable 级联（DES/04 §5 单事务：status 条件更新 +
//                            running 序列→stopped + ws_event 两帧；账号不动）+ 该条 failed
//     403 SENDER_NOT_IN_GROUP / 409 ACCOUNT_OFFLINE → 该条 failed 同名码，账号/群不动
//     504 NETWORK_TIMEOUT / 本端 TIMEOUT / INVALID_RESPONSE → unknown(unknown_since=now,
//                            deadline=now+UNKNOWN_SETTLE_MS)——结果未知不可盲目重发
//     503 UNAVAILABLE / 裸网络异常 → 指数退避重试同一意图（first_attempt_at/resend_count 不变，
//                            解读 #17 + §8「请求未达业务层」；泵内退避循环，停摆期持锁让闸）
//   未分类码（INTERNAL 等传输类）→ unknown 收口：宁保守不盲发。
// ws_event 纪律：所有写回与帧同事务，COMMIT 后 notifyWsEventCommitted（§2.2「先持久化后推送」）。
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../../http/plugins/errors.js';
import {
  SEND_RETRY_BACKOFF_START_MS,
  SEND_RETRY_BACKOFF_MAX_MS,
  UNKNOWN_SETTLE_MS,
} from '../../constants.js';
import { tx } from '../../db/tx.js';
import type { GatewayClient } from '../../gateway/client.js';
import { GatewayError } from '../../gateway/errors.js';
import { checkRateLimit, registerRateLimit } from '../accounts/rate-limit.js';
import { enterTerminal } from '../accounts/terminal.js';
import { notifyWsEventCommitted } from '../../ws/notify.js';
import type { AccountTerminalStatus } from '@kapibala/contract';

/** 最小日志面（与 consumer/scheduler 同构；测试可 fake） */
export interface DispatcherLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface OutboundDispatcherOptions {
  readonly pool: Pool;
  readonly gateway: GatewayClient;
  readonly logger: DispatcherLogger;
  /** 测试注入缝：503 退避起点/上限；缺省 = constants 值（500ms/5s） */
  readonly retryBackoffStartMs?: number;
  readonly retryBackoffMaxMs?: number;
}

export interface OutboundDispatcher {
  /** 唤醒指定账号的 pump（幂等；并发重入靠「正在跑 + 需要重跑」标志对在进程内消化） */
  wake(accountId: string): void;
  /** 优雅关停：退避睡眠立即醒，在途网关调用等其自然返回后退出 */
  stop(): Promise<void>;
}

/** 待发送行（picked queued AND first_attempt_at IS NULL） */
interface QueuedMessage {
  readonly id: number;
  readonly client_msg_id: string;
  readonly group_id: string;
  readonly text: string;
}

/** markGroupUnreachable 事务结果（写回 + 帧生成共用） */
interface GroupCascade {
  readonly becameUnreachable: boolean;
  readonly stoppedRuns: ReadonlyArray<{ id: string; current_step_index: number }>;
}

/**
 * GROUP_WRITE_FORBIDDEN 级联（DES/04 §5 单事务逐字）：
 * group.status='unreachable'（WHERE status='active' 幂等）→ running 序列 → stopped +
 * ws_event(sequence_run)（每 run 一帧）→ agent run 协作式取消由执行器循环顶检查点查群态
 * 完成（schema 无取消标志列；§06 §10 检查点读库即可）→ 账号不触碰。
 * 返回 stoppedRuns 供调用方生成 sequence_run 帧。
 */
async function applyGroupUnreachableCascade(
  client: PoolClient,
  groupId: string,
): Promise<GroupCascade> {
  const g = await client.query(
    `UPDATE "group" SET status='unreachable', updated_at=now()
     WHERE id=$1 AND status='active'`,
    [groupId],
  );
  const stopped = await client.query<{ id: string; current_step_index: number }>(
    `UPDATE sequence_run SET status='stopped', ended_at=now(), updated_at=now()
     WHERE group_id=$1 AND status='running'
     RETURNING id, current_step_index`,
    [groupId],
  );
  return { becameUnreachable: g.rowCount !== 0, stoppedRuns: stopped.rows };
}

async function insertWsEvent(client: PoolClient, type: string, payload: unknown): Promise<void> {
  await client.query('INSERT INTO ws_event (type, payload) VALUES ($1, $2::jsonb)', [
    type,
    JSON.stringify(payload),
  ]);
}

/** own 消息状态帧（ws-events.ts WsMessageEvent；msgId null=D3-3 未分配） */
function messageFrame(msg: QueuedMessage, deliveryStatus: string): Record<string, unknown> {
  return {
    groupId: msg.group_id,
    msgId: null,
    isOwn: true,
    clientMsgId: msg.client_msg_id,
    deliveryStatus,
  };
}

export function startOutboundDispatcher(options: OutboundDispatcherOptions): OutboundDispatcher {
  const { pool, gateway, logger } = options;
  const backoffStart = options.retryBackoffStartMs ?? SEND_RETRY_BACKOFF_START_MS;
  const backoffMax = options.retryBackoffMaxMs ?? SEND_RETRY_BACKOFF_MAX_MS;

  let stopped = false;
  /** accountId → 在途 pump Promise（泄水排空） */
  const pumps = new Map<string, Promise<void>>();
  /** pump 进行中再次 wake → 补一轮（避免「wake 撞在排空前」丢调度） */
  const needsRerun = new Set<string>();
  /** 退避睡眠的唤醒回调（stop 时集体叫醒 → 睡眠循环检查 stopped 退出） */
  const sleepers = new Set<() => void>();

  /** 退避睡眠（可被 stop 提前打断）；返回 true = 睡满，false = 被打断 */
  const sleep = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (stopped) {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        sleepers.delete(wake);
        resolve(true);
      }, ms);
      const wake = (): void => {
        clearTimeout(timer);
        sleepers.delete(wake);
        resolve(false);
      };
      sleepers.add(wake);
    });

  /** 最早 queued AND first_attempt_at IS NULL（id 升序，§2.3 逐字） */
  async function nextQueued(accountId: string): Promise<QueuedMessage | undefined> {
    const { rows } = await pool.query<QueuedMessage & { id: string }>(
      `SELECT id, client_msg_id, group_id, text FROM message
       WHERE account_id=$1 AND delivery_status='queued' AND first_attempt_at IS NULL
       ORDER BY id ASC LIMIT 1`,
      [accountId],
    );
    const row = rows[0];
    return row === undefined ? undefined : { ...row, id: Number(row.id) };
  }

  /** E7/I1：first_attempt_at 先于网关调用落库（条件更新——行可能被并发写回收敛，0 行即跳过） */
  async function claimAttempt(msg: QueuedMessage): Promise<boolean> {
    const { rowCount } = await pool.query(
      `UPDATE message SET first_attempt_at=now(), last_attempt_at=now(), updated_at=now()
       WHERE id=$1 AND delivery_status='queued' AND first_attempt_at IS NULL`,
      [msg.id],
    );
    return rowCount === 1;
  }

  /** 202：accepted（守卫 IN ('queued','unknown')，D1-2：crash-in-flight 已转 unknown 的补偿写回） */
  async function markAccepted(msg: QueuedMessage): Promise<void> {
    await tx(pool, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE message SET delivery_status='accepted', updated_at=now()
         WHERE id=$1 AND delivery_status IN ('queued','unknown')`,
        [msg.id],
      );
      if (rowCount === 0) {
        logger.warn({ messageId: msg.id }, 'send accepted but row already terminal; skip writeback');
        return;
      }
      await insertWsEvent(client, 'message', messageFrame(msg, 'accepted'));
    });
    notifyWsEventCommitted();
  }

  /** 同名码 failed（SENDER_NOT_IN_GROUP / ACCOUNT_OFFLINE / 终态码写回共用） */
  async function markFailed(client: PoolClient, msg: QueuedMessage, code: string): Promise<void> {
    const { rowCount } = await client.query(
      `UPDATE message SET delivery_status='failed', fail_code=$2, updated_at=now()
       WHERE id=$1 AND delivery_status IN ('queued','unknown')`,
      [msg.id, code],
    );
    if (rowCount === 1) {
      await insertWsEvent(client, 'message', messageFrame(msg, 'failed'));
    }
  }

  /** 504/TIMEOUT/INVALID_RESPONSE/INTERNAL：结果未知 → unknown 判定路径（E7；不盲目重发） */
  async function markUnknown(msg: QueuedMessage): Promise<void> {
    await tx(pool, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE message SET delivery_status='unknown',
                            unknown_since=now(),
                            unknown_deadline_at=now() + $2 * interval '1 millisecond',
                            updated_at=now()
         WHERE id=$1 AND delivery_status='queued'`,
        [msg.id, UNKNOWN_SETTLE_MS],
      );
      if (rowCount === 1) {
        await insertWsEvent(client, 'message', messageFrame(msg, 'unknown'));
      }
    });
    notifyWsEventCommitted();
  }

  /** 429：登记限流（副作用含 ws_event）+ 消息回退为「从未尝试」排队（first_attempt_at 复位） */
  async function handleRateLimited(accountId: string, msg: QueuedMessage, retryAfterSeconds: number): Promise<void> {
    await tx(pool, async (client) => {
      // 复位先于登记提交：任一失败都不留下「尝试过但未发」的假阳性（A2：429 = 确认未发出）
      await client.query(
        `UPDATE message SET first_attempt_at=NULL, updated_at=now()
         WHERE id=$1 AND delivery_status='queued'`,
        [msg.id],
      );
    });
    await registerRateLimit({ pool, logger }, accountId, retryAfterSeconds);
  }

  /** 终态码（ACCOUNT_SUSPENDED/SESSION_EXPIRED）：enterTerminal 副作用 + 该条 failed 同名码 */
  async function handleTerminal(
    msg: QueuedMessage,
    code: 'ACCOUNT_SUSPENDED' | 'SESSION_EXPIRED',
    accountId: string,
  ): Promise<void> {
    await tx(pool, async (client) => {
      const target: AccountTerminalStatus = code === 'SESSION_EXPIRED' ? 'session_expired' : 'suspended';
      await enterTerminal(client, accountId, target);
      await markFailed(client, msg, code);
    });
    notifyWsEventCommitted();
  }

  /** GROUP_WRITE_FORBIDDEN：级联 + 该条 failed + 帧，全部单事务（DES/04 §5） */
  async function handleGroupForbidden(msg: QueuedMessage): Promise<void> {
    await tx(pool, async (client) => {
      const cascade = await applyGroupUnreachableCascade(client, msg.group_id);
      if (cascade.becameUnreachable) {
        for (const run of cascade.stoppedRuns) {
          await insertWsEvent(client, 'sequence_run', {
            runId: run.id,
            groupId: msg.group_id,
            status: 'stopped',
            currentStepIndex: run.current_step_index,
          });
        }
      }
      await markFailed(client, msg, 'GROUP_WRITE_FORBIDDEN');
    });
    notifyWsEventCommitted();
  }

  /** 单条响应分流；返回 'stop' = 本账号本轮停泵（429） */
  async function handleResult(
    accountId: string,
    msg: QueuedMessage,
    outcome: { kind: 'accepted' } | { kind: 'error'; error: unknown },
  ): Promise<'continue' | 'stop'> {
    if (outcome.kind === 'accepted') {
      await markAccepted(msg);
      return 'continue';
    }
    const err = outcome.error;
    if (err instanceof GatewayError) {
      switch (err.code) {
        case 'RATE_LIMITED': {
          const body = err.body as { retryAfterSeconds?: unknown } | null;
          const retry = typeof body?.retryAfterSeconds === 'number' ? body.retryAfterSeconds : 60;
          await handleRateLimited(accountId, msg, retry);
          return 'stop';
        }
        case 'ACCOUNT_SUSPENDED':
        case 'SESSION_EXPIRED':
          await handleTerminal(msg, err.code, accountId);
          return 'continue';
        case 'GROUP_WRITE_FORBIDDEN':
          await handleGroupForbidden(msg);
          return 'continue';
        case 'SENDER_NOT_IN_GROUP':
        case 'ACCOUNT_OFFLINE':
          await tx(pool, (client) => markFailed(client, msg, err.code));
          notifyWsEventCommitted();
          return 'continue';
        case 'UNAVAILABLE':
          // pump 在调本函数前已拦截 503 走退避环；到达此处只能是改动漂移——
          // 按「结果未知」兜底收口而非静默吞（宁保守不盲发）。
          await markUnknown(msg);
          return 'continue';
        default:
          // TIMEOUT / NETWORK_TIMEOUT / INVALID_RESPONSE / INTERNAL / NOT_FOUND / 其余业务码：
          // 业务码兜底按「结果未知」收口（宁保守不盲发；UNAVAILABLE 是唯一重试类）
          await markUnknown(msg);
          return 'continue';
      }
    }
    // 裸网络异常（ECONNREFUSED 等非 GatewayError）：同样由 pump 退避环先行拦截；
    // 到达此处理同 UNAVAILABLE——按未知收口。
    await markUnknown(msg);
    return 'continue';
  }

  /**
   * 单账号泵：advisory lock 串行（会话级；多实例部署唯一性靠 DB，宪法 §3-5）。
   * 拿锁即占客户端直到排空——锁释放与事务无关（pg_advisory_unlock 显式配对）。
   */
  async function pump(accountId: string): Promise<void> {
    const client = await pool.connect();
    try {
      const locked = await client.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS ok',
        ['outbound-dispatcher', accountId],
      );
      if (locked.rows[0]?.ok !== true) {
        // 另一实例正持有：它排空后由 wake 补投/兜底扫描兜底，本泵直接退（不阻塞锁队列）
        return;
      }
      try {
        for (;;) {
          if (stopped) return;
          const msg = await nextQueued(accountId);
          if (msg === undefined) return;
          // 硬闸门最外层（§5.2：每次 send 前读提交真值；到期未转移的行放行——闸门不越权改状态）
          try {
            const gate = await checkRateLimit(pool, accountId);
            if (gate.blocked) return;
          } catch (err) {
            if (err instanceof AppError && err.code === 'ACCOUNT_NOT_FOUND') {
              logger.warn({ accountId }, 'outbound dispatcher: account vanished; skip queue');
              return;
            }
            throw err;
          }
          // E7/I1：先于 send 落 first_attempt_at（崩溃 → 恢复扫描转 unknown，不盲发）
          if (!(await claimAttempt(msg))) continue;
          const group = await pool.query<{ gateway_group_id: string | null }>(
            'SELECT gateway_group_id FROM "group" WHERE id=$1',
            [msg.group_id],
          );
          const gwGroupId = group.rows[0]?.gateway_group_id;
          if (gwGroupId === undefined || gwGroupId === null) {
            // creating 态群（job 未完成）无网关 id：意图已落库但外部不存在——不烧 first_attempt_at，
            // 复位排队等待建群完成（与 429 同性质：确认未发出）。恢复由 dispatcher 自身循环拾取。
            logger.warn({ messageId: msg.id, groupId: msg.group_id }, 'group has no gateway id; requeue');
            await pool.query(
              `UPDATE message SET first_attempt_at=NULL, updated_at=now() WHERE id=$1`,
              [msg.id],
            );
            return;
          }
          // 503 退避环：同一意图重试（§8 区分：非业务层错误，resend_count/first_attempt_at 不动）
          let backoff = backoffStart;
          for (;;) {
            if (stopped) return;
            let outcome: { kind: 'accepted' } | { kind: 'error'; error: unknown };
            try {
              const res = await gateway.send(gwGroupId, {
                accountId,
                clientMsgId: msg.client_msg_id,
                text: msg.text,
              });
              outcome = res.accepted ? { kind: 'accepted' } : { kind: 'error', error: new GatewayError({ endpoint: 'send', status: 200, code: 'INVALID_RESPONSE', message: 'send returned accepted=false' }) };
            } catch (err) {
              outcome = { kind: 'error', error: err };
            }
            if (outcome.kind === 'accepted') {
              await markAccepted(msg);
              break; // 本消息落定 → 取下一条
            }
            const err = outcome.error;
            if (err instanceof GatewayError && err.code === 'UNAVAILABLE') {
              if (!(await sleep(backoff))) return;
              backoff = Math.min(backoff * 2, backoffMax);
              continue;
            }
            if (!(err instanceof GatewayError)) {
              if (!(await sleep(backoff))) return;
              backoff = Math.min(backoff * 2, backoffMax);
              continue;
            }
            const action = await handleResult(accountId, msg, outcome);
            if (action === 'stop') return;
            break; // 'continue' → 本消息已写回，取下一条
          }
        }
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', [
          'outbound-dispatcher',
          accountId,
        ]).catch((err: unknown) => {
          logger.error({ err, accountId }, 'advisory unlock failed (client reset clears)');
        });
      }
    } finally {
      client.release();
    }
  }

  const pumpLoop = (accountId: string): Promise<void> =>
    (async () => {
      try {
        do {
          needsRerun.delete(accountId);
          await pump(accountId);
        } while (needsRerun.has(accountId) && !stopped);
      } catch (err) {
        logger.error({ err, accountId }, 'outbound pump crashed; wake again to retry');
      } finally {
        pumps.delete(accountId);
        // 排空期间到达的 wake → pumpLoop 已退出但需求未清：补一轮（调度兜底 1s 内也会扫到）
        if (needsRerun.has(accountId) && !stopped) {
          pumps.set(accountId, pumpLoop(accountId));
        }
      }
    })();

  return {
    wake(accountId: string): void {
      if (stopped) return;
      if (pumps.has(accountId)) {
        needsRerun.add(accountId);
        return;
      }
      pumps.set(accountId, pumpLoop(accountId));
    },
    async stop(): Promise<void> {
      stopped = true;
      for (const wake of sleepers) wake();
      await Promise.allSettled([...pumps.values()]);
    },
  };
}
