// S3 自己的消息回流（REQ §2.4 S3 行、analysis/09 §1、DES/14 §8、DES/05 §4.1/§4.3）。
// 逐字断言：「网关把服务账号发出的消息作为 message 事件推回来」→
//   与出站记录合并为一行（isOwn=true），agentEnabled=true 的群也不因此产生新的 agent run。
// mock 的落地即自动回流（landMessage 在 message_sent 后同账本追加 message——契约默认行为，
// 非开关，DES/14 §5 注），本用例只编排 send + 断言合并/不触发。
import { describe, expect, it } from 'vitest';
import {
  armSwitch,
  countRows,
  gatewayCounters,
  patchGroup,
  sendMessage,
  setupGroup,
  startScenarioEnv,
  timeline,
  waitFor,
  type ScenarioEnv,
} from '../helpers/env.js';

describe('S3 自己的消息回流（REQ §2.4 S3）', () => {
  it('回流 message 与出站行合并（isOwn=true、恰一行），不产生新 agent run', async () => {
    const env: ScenarioEnv = await startScenarioEnv();
    try {
      // arrange：建群 + agent_enabled=true（「也不因此触发 run」的判定前提是触发器开着）
      const group = await setupGroup(env, { creator: 'acc-01', members: ['acc-02'] });
      await patchGroup(env, group.dbGroupId, { agentEnabled: true });
      // 钉死两段延迟到 0：落地（message_sent + 回流 message）紧随 202
      await armSwitch(env, 'send_accept_slow', undefined, { delayMs: 0 });
      await armSwitch(env, 'message_sent_delay', undefined, { delayMs: 0 });

      // act：服务账号发消息 → 网关落地 → 同账本自动推回 message（senderPuid = 服务账号 puid）
      const clientMsgId = await sendMessage(env, group.dbGroupId, {
        accountId: 'acc-01',
        text: 's3 reflux',
      });
      await waitFor(async () => (await gatewayCounters(env)).landedMessages >= 1);
      await waitFor(async () => {
        const items = await timeline(env, group.dbGroupId);
        return items.some((i) => i.clientMsgId === clientMsgId && i.deliveryStatus === 'sent');
      });
      // 让回流帧也有足够时间被消费（与 message_sent 同账本相邻；水位对齐兜底）
      await waitFor(async () => {
        const frames = (await gatewayCounters(env)).framesEmitted;
        const stored = await countRows(env.pool, `SELECT count(*) AS n FROM gateway_event`, []);
        return stored >= frames && frames > 0;
      });

      // assert-1：合并为一行——clientMsgId 所在行 isOwn=true、sent、msgId 已回填；
      //   且按 msgId 也找不到第二条独立行（没有「外部消息行」）
      const items = await timeline(env, group.dbGroupId);
      const rows = items.filter((i) => i.clientMsgId === clientMsgId);
      expect(rows.length).toBe(1);
      expect(rows[0]?.isOwn).toBe(true);
      expect(rows[0]?.deliveryStatus).toBe('sent');
      expect(rows[0]?.msgId).not.toBeNull();
      const byMsgId = items.filter((i) => i.msgId === rows[0]?.msgId);
      expect(byMsgId.length).toBe(1);

      // assert-2：不产生新 agent run——群 agentEnabled=true 时回流仍是自己（A2 明文）
      expect(
        await countRows(env.pool, `SELECT count(*) AS n FROM agent_run WHERE group_id=$1`, [
          group.dbGroupId,
        ]),
      ).toBe(0);
      expect(
        await countRows(
          env.pool,
          `SELECT count(*) AS n FROM agent_trigger_queue WHERE group_id=$1`,
          [group.dbGroupId],
        ),
      ).toBe(0);
    } finally {
      await env.close();
    }
  }, 30_000);
});
