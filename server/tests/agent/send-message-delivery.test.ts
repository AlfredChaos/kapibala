// send_message 真实投递链路回归测试（verify/functional-2 人工验证发现）。
// 生产事故级 bug：executor 用 tx() 包住 toolExec（executor.ts），execSendMessage 的 T13
// 三件套在同一未提交事务内写入，而 defaultDeliveryWaiter 经 pool 轮询 message 表——
// 未提交行对轮询不可见，dispatcher 也看不到，5s 必然 SEND_TIMEOUT（消息最终仍发出，
// 但 tool_result 被谎报为超时）。用真实 defaultDeliveryWaiter + 真实出站 dispatcher +
// 进程内 mock-gateway 复现：断言 tool_result 在 5s 窗口内拿到 accepted。
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createGatewayApp } from 'mock-gateway/src/app.js';
import { derivePlatformUserId } from 'mock-gateway/src/state.js';
import { createGatewayClient } from '../../src/gateway/client.js';
import { startOutboundDispatcher } from '../../src/modules/messages/dispatcher.js';
import { createAgentExecutor } from '../../src/modules/agent/executor.js';
import { seed } from '../../src/db/seed.js';
import { withTestDb } from '../helpers/db.js';
import type { AgentClient, AgentAuditRequest, AgentAuditResponse, AgentRawResponse, AgentTurnRequest } from '../../src/agentclient/index.js';

const silent = { info() {}, warn() {}, error() {} };

/** 固定剧本：turn1 = send_message，其后 end_turn 收口 */
class SendOnceClient implements AgentClient {
  turnCalls: AgentTurnRequest[] = [];
  auditCalls: AgentAuditRequest[] = [];

  async rawTurn(req: AgentTurnRequest): Promise<AgentRawResponse> {
    this.turnCalls.push(req);
    if (this.turnCalls.length === 1) {
      return {
        status: 200,
        raw: JSON.stringify({
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'send_message',
              input: { text: 'real delivery', idempotency_key: 'k-real' },
            },
          ],
        }),
      };
    }
    return {
      status: 200,
      raw: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] }),
    };
  }

  async callAudit(_req: AgentAuditRequest): Promise<AgentAuditResponse> {
    return { verdict: 'pass' };
  }
}

describe('send_message 真实投递链路（真实 waiter + 真实 dispatcher）', () => {
  it('T13 先提交 → dispatcher 可见 → 5s 内拿到 accepted，而不是 SEND_TIMEOUT', async () => {
    await withTestDb(async (pool) => {
      await seed(pool);

      // 真实 mock-gateway（进程内）+ 真实 GatewayClient
      const mockApp = createGatewayApp({ logger: false });
      await mockApp.listen({ port: 0, host: '127.0.0.1' });
      const gwBase = `http://127.0.0.1:${(mockApp.server.address() as AddressInfo).port}`;
      const gateway = createGatewayClient({ baseUrl: gwBase });
      const dispatcher = startOutboundDispatcher({
        pool,
        gateway,
        logger: silent,
        retryBackoffStartMs: 5,
        retryBackoffMaxMs: 20,
      });

      try {
        // 网关侧：acc-01 connect + 建群（creator 自动入群）
        await gateway.connect('acc-01');
        const { groupId: gwGroupId } = await gateway.createGroup({ creatorAccountId: 'acc-01' });

        // server 侧：acc-01 online + 群 active + 成员行（puid 与网关派生一致）
        await pool.query(
          `UPDATE account SET status='online', platform_user_id=$1 WHERE id='acc-01'`,
          [derivePlatformUserId('acc-01')],
        );
        const groupId = randomUUID();
        await pool.query(
          `INSERT INTO "group" (id, gateway_group_id, status, creator_account_id, agent_enabled)
           VALUES ($1, $2, 'active', 'acc-01', true)`,
          [groupId, gwGroupId],
        );
        await pool.query(
          `INSERT INTO group_member (group_id, account_id, platform_user_id, role)
           VALUES ($1, 'acc-01', $2, 'admin')`,
          [groupId, derivePlatformUserId('acc-01')],
        );
        const { rows: r } = await pool.query<{ id: string }>(
          `INSERT INTO agent_run (id, group_id, status, trigger_context, wall_deadline_at)
           VALUES (gen_random_uuid(), $1, 'running', '{}'::jsonb, now()+interval '60 seconds')
           RETURNING id`,
          [groupId],
        );
        const runId = r[0]?.id ?? '';

        // executor 不注入 deliveryWaiter → 走生产 defaultDeliveryWaiter（pool 轮询）
        const client = new SendOnceClient();
        createAgentExecutor({
          pool,
          agentClient: client,
          logger: silent,
          instanceId: 't',
          gateway,
        }).startRun(runId);

        // 真实投递链路要求真实时钟与真实 dispatcher；dispatcher.wake 直唤等价于调度器
        // dispatch-wakeup 兜底扫描。vi.waitFor 为真条件轮询（非裸 sleep）；轮询体里顺带
        // 补 wake，模拟「意图在 DB、调度器拾取」的生产节奏——若 T13 未提交，泵看不见行，
        // 5s 窗口耗尽 → SEND_TIMEOUT（本测试即复现该 bug）。
        await vi.waitFor(async () => {
          dispatcher.wake('acc-01');
          const { rows } = await pool.query<{ status: string }>(
            'SELECT status FROM agent_run WHERE id=$1',
            [runId],
          );
          expect(rows[0]?.status).not.toBe('running');
        }, { interval: 50, timeout: 12000 });

        // 核心断言：tool_result 回 deliveryStatus（accepted/sent），绝不能是 SEND_TIMEOUT
        // 顺带校验整条链只有一步 send_message（不复式重放）
        const { rows: steps } = await pool.query<{
          appended_blocks: Array<{ role: string; content: Array<{ type: string; content?: string }> }>;
          error_code: string | null;
        }>(
          `SELECT appended_blocks, error_code FROM agent_run_step
           WHERE run_id=$1 AND name='send_message'`,
          [runId],
        );
        expect(steps.length).toBe(1);
        expect(steps[0]?.error_code).toBeNull();
        const toolResult = steps[0]?.appended_blocks[1]?.content[0]?.content ?? '{}';
        const parsed = JSON.parse(toolResult) as Record<string, unknown>;
        expect(['accepted', 'sent']).toContain(parsed['deliveryStatus']);

        // 消息最终落定 sent（message_sent 回流后）
        const { rows: msgs } = await pool.query<{ delivery_status: string }>(
          'SELECT delivery_status FROM message WHERE source=$1',
          ['agent'],
        );
        expect(msgs.length).toBe(1);
      } finally {
        await dispatcher.stop();
        await mockApp.close();
      }
    });
  }, 30_000);
});
