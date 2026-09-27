// kick_user 工具测试（T-P4-10 c 项，先红后绿）。
// 契约出处：DES/06 §8.4 门槛顺序 + §8.5 流程图 + X-1 码表封闭（AGENT_ERROR_CODES）+
// REQ A5-6/A2 OWNER_LEFT 行；gw-24/25（504→2s 收敛查成员）。
// 覆盖：POLICY_DENIED（门槛 1，不审计不执行）；OWNER_LEFT/NO_PERMISSION 同名透传；
// 504 → 2s 后成员列表收敛两分支；其他网关错 → SEND_FAILED 带原码；X-1 封闭性断言。
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { tx } from '../../src/db/tx.js';
import { execKickUser, kickPreAudit } from '../../src/modules/agent/tools/kick.js';
import { createAgentExecutor, type ToolOutcome } from '../../src/modules/agent/executor.js';
import { GatewayError } from '../../src/gateway/errors.js';
import type { GatewayClient } from '../../src/gateway/client.js';
import type { AgentClient, AgentAuditResponse, AgentRawResponse, AgentTurnRequest } from '../../src/agentclient/index.js';
import { AGENT_ERROR_CODES } from '@kapibala/contract';

const silent = { info() {}, warn() {}, error() {} };

class FakeGateway implements Pick<GatewayClient, 'kick' | 'members'> {
  kickImpl: () => Promise<{ kicked: boolean }> = async () => ({ kicked: true });
  membersImpl: () => Promise<Array<{ platformUserId: string }>> = async () => [];
  kickedWith: Array<{ byAccountId: string; targetPlatformUserId: string }> = [];
  async kick(_g: string, input: { byAccountId: string; targetPlatformUserId: string }) {
    this.kickedWith.push(input);
    return this.kickImpl();
  }
  async members(_g: string) { return this.membersImpl(); }
}

function gw(status: number, code: string): GatewayError {
  return new GatewayError({ endpoint: 'kick', status, code: code as never, body: { code } });
}

describe('kick_user 工具（DES/06 §8.4/§8.5 + X-1）', () => {
  let db: TestDbHandle;
  let groupId: string;
  let runId: string;

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
  });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.pool.query(
      `TRUNCATE group_member, "group", ws_event, account, agent_run_step, agent_run, message RESTART IDENTITY CASCADE`,
    );
    await seed(db.pool);
    await db.pool.query(`UPDATE account SET status='online', platform_user_id='puid-01' WHERE id='acc-01'`);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO "group" (id, creator_account_id, status, agent_enabled, auto_kick_enabled, gateway_group_id)
       VALUES (gen_random_uuid(), 'acc-01', 'active', true, true, 'gw-9') RETURNING id`);
    groupId = rows[0]?.id ?? '';
    await db.pool.query(
      `INSERT INTO group_member (group_id, account_id, platform_user_id, role) VALUES
       ($1,'acc-01','puid-01','admin'),($1,'acc-victim','puid-vic','member')`,
      [groupId]).catch(() =>
      db.pool.query(`INSERT INTO group_member (group_id, account_id, platform_user_id, role) VALUES ($1,'acc-01','puid-01','admin')`, [groupId]),
    );
    const { rows: r } = await db.pool.query<{ id: string }>(
      `INSERT INTO agent_run (id, group_id, status, trigger_context, wall_deadline_at)
       VALUES (gen_random_uuid(), $1, 'running', '{}'::jsonb, now()+interval '60 seconds') RETURNING id`,
      [groupId]);
    runId = r[0]?.id ?? '';
    await db.pool.query(
      `INSERT INTO agent_run_step (run_id, seq, kind, status, dispatch_payload, appended_blocks)
       VALUES ($1, 1, 'tool_use', 'turn_received', '{}'::jsonb, '[]'::jsonb)`, [runId]);
  });

  async function runKick(gateway: FakeGateway, over: { target?: string } = {}): Promise<{ outcome: ToolOutcome }> {
    const outcome = await tx(db.pool, (c) =>
      execKickUser(
        { client: c, runId, groupId, stepSeq: 1, input: { platform_user_id: over.target ?? 'puid-vic', reason: 'spam' } },
        { gateway: gateway as unknown as GatewayClient, pool: db.pool, convergeWait: async () => {} },
      ),
    );
    return { outcome };
  }

  it('门槛 1：auto_kick_enabled=false → POLICY_DENIED（不碰网关、不进协议错误）', async () => {
    await db.pool.query(`UPDATE "group" SET auto_kick_enabled=false WHERE id=$1`, [groupId]);
    const denied = await tx(db.pool, (c) => kickPreAudit(c, groupId));
    expect(denied).toBeDefined();
    if (denied?.type === 'result') {
      expect(denied.isError).toBe(true);
      expect(denied.content).toContain('POLICY_DENIED');
    }
    const { rows } = await db.pool.query('SELECT status FROM agent_run_step WHERE run_id=$1', [runId]);
    expect(rows[0]?.status).toBe('turn_received'); // 未进 tool_dispatched（未执行）
  });

  it('200 → {kicked:true}；step tool_dispatched + kick_target 落库（E5 恢复凭据）', async () => {
    const gateway = new FakeGateway();
    const { outcome } = await runKick(gateway);
    expect(outcome.type).toBe('result');
    if (outcome.type === 'result') expect(JSON.parse(outcome.content)).toEqual({ kicked: true });
    expect(gateway.kickedWith[0]).toMatchObject({ byAccountId: 'acc-01', targetPlatformUserId: 'puid-vic' });
    const { rows } = await db.pool.query(
      'SELECT status, kick_target, audit_verdict FROM agent_run_step WHERE run_id=$1', [runId]);
    expect(rows[0]).toMatchObject({ status: 'tool_dispatched', kick_target: 'puid-vic', audit_verdict: 'pass' });
  });

  it('409 OWNER_LEFT → 同名透传（A2 逐字，X-1 表内码）', async () => {
    const gateway = new FakeGateway();
    gateway.kickImpl = async () => { throw gw(409, 'OWNER_LEFT'); };
    const { outcome } = await runKick(gateway);
    if (outcome.type === 'result') expect(JSON.parse(outcome.content)['code']).toBe('OWNER_LEFT');
  });

  it('403 NO_PERMISSION → 同名透传（非群主未 promote 场景，A2）', async () => {
    const gateway = new FakeGateway();
    gateway.kickImpl = async () => { throw gw(403, 'NO_PERMISSION'); };
    const { outcome } = await runKick(gateway);
    if (outcome.type === 'result') expect(JSON.parse(outcome.content)['code']).toBe('NO_PERMISSION');
  });

  it('kick 504 + 2s 后目标已不在成员列表 → {kicked:true}（gw-24 收敛）', async () => {
    const gateway = new FakeGateway();
    gateway.kickImpl = async () => { throw gw(504, 'NETWORK_TIMEOUT'); };
    gateway.membersImpl = async () => [{ platformUserId: 'puid-01' }]; // 目标已不在
    const { outcome } = await runKick(gateway);
    if (outcome.type === 'result') expect(JSON.parse(outcome.content)).toEqual({ kicked: true });
  });

  it('kick 504 + 2s 后目标仍在 → SEND_FAILED + X-1 逐字 message', async () => {
    const gateway = new FakeGateway();
    gateway.kickImpl = async () => { throw gw(504, 'NETWORK_TIMEOUT'); };
    gateway.membersImpl = async () => [{ platformUserId: 'puid-vic' }]; // 仍在
    const { outcome } = await runKick(gateway);
    if (outcome.type === 'result') {
      const body = JSON.parse(outcome.content) as { code: string; message: string };
      expect(body.code).toBe('SEND_FAILED');
      expect(body.message).toBe('kick unresolved after gateway 504: target still member'); // X-1 逐字
    }
  });

  it('409 ACCOUNT_OFFLINE 等表外网关码 → SEND_FAILED + message 带原始码（X-1 收敛）', async () => {
    const gateway = new FakeGateway();
    gateway.kickImpl = async () => { throw gw(409, 'ACCOUNT_OFFLINE'); };
    const { outcome } = await runKick(gateway);
    if (outcome.type === 'result') {
      const body = JSON.parse(outcome.content) as { code: string; message: string };
      expect(body.code).toBe('SEND_FAILED');
      expect(body.message).toContain('ACCOUNT_OFFLINE');
    }
  });

  it('X-1 封闭性：产出的 code 全部在 13 码表内（跨分支抽查）', async () => {
    const scenarios: Array<{ impl: () => Promise<{ kicked: boolean }>; expectCode?: string }> = [
      { impl: async () => ({ kicked: true }) },
      { impl: async () => { throw gw(409, 'OWNER_LEFT'); }, expectCode: 'OWNER_LEFT' },
      { impl: async () => { throw gw(403, 'NO_PERMISSION'); }, expectCode: 'NO_PERMISSION' },
      { impl: async () => { throw gw(409, 'ACCOUNT_OFFLINE'); }, expectCode: 'SEND_FAILED' },
      { impl: async () => { throw gw(503, 'UNAVAILABLE'); }, expectCode: 'SEND_FAILED' },
    ];
    for (const sc of scenarios) {
      const gateway = new FakeGateway();
      gateway.kickImpl = sc.impl;
      const { outcome } = await runKick(gateway);
      if (outcome.type !== 'result') continue;
      const body = JSON.parse(outcome.content) as { code?: string };
      if (body.code !== undefined) {
        expect(AGENT_ERROR_CODES as readonly string[]).toContain(body.code); // 表外码即违约
      }
      if (sc.expectCode !== undefined) expect(body.code).toBe(sc.expectCode);
    }
  });

  it('executor 集成：auto_kick_enabled=false → POLICY_DENIED 且审计从未被调', async () => {
    await db.pool.query(`UPDATE "group" SET auto_kick_enabled=false WHERE id=$1`, [groupId]);
    await db.pool.query('DELETE FROM agent_run_step WHERE run_id=$1', [runId]); // executor 自建 seq=1，预置步会撞 uq(run_id,seq)
    const client: AgentClient = {
      async rawTurn(_req: AgentTurnRequest): Promise<AgentRawResponse> {
        return {
          status: 200,
          raw: JSON.stringify({
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'tu_k', name: 'kick_user', input: { platform_user_id: 'puid-vic', reason: 'x' } }],
          }),
        };
      },
      async callAudit(): Promise<AgentAuditResponse> { throw new Error('audit must not run under POLICY_DENIED gate'); },
    };
    createAgentExecutor({
      pool: db.pool, agentClient: client, logger: silent, instanceId: 't',
      gateway: new FakeGateway() as unknown as GatewayClient, kickConvergeWait: async () => {},
    }).startRun(runId);
    // run 不因拒绝而终结——等一个步终态即可（run 会继续到预算/下一步；此处验 step 形状）
    await vi.waitFor(async () => {
      const { rows } = await db.pool.query(
        'SELECT is_error, error_code FROM agent_run_step WHERE run_id=$1 AND seq=1', [runId]);
      expect(rows[0]).toMatchObject({ is_error: true, error_code: 'POLICY_DENIED' });
    }, { interval: 20, timeout: 5000 });
  });
});
