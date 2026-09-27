// S2 事件重复（REQ §2.4 S2 行、analysis/09 §1、DES/14 §8）。
// 逐字断言：「网关把每个事件都推两次」→ 时间线无重复行；agent 不被重复触发。
// 两层去重：投递层 dup_push_all（账本一行、帧投两次）→ server 侧
//   a) gateway_event PK ON CONFLICT DO NOTHING 吸收重推帧（handler 最多跑一次）；
//   b) (groupId,msgId) 部分唯一索引吸收补投/重推的 message（S2 契约逐字）；
//   c) agent 触发幂等：重复事件不重复建 run（外加「每群至多一个 running run」单飞行兜底）。
// 断言真值：时间线行数 + agent_run/agent_trigger_queue 行数 + gateway_event 计数
//   == mock counters.framesEmitted（帧账本产出数；dup 投递不增产、eventId 不复用）。
import { describe, expect, it } from 'vitest';
import {
  armSwitch,
  countRows,
  emitEvent,
  gatewayCounters,
  sendMessage,
  setupGroup,
  patchGroup,
  startScenarioEnv,
  timeline,
  waitFor,
  type ScenarioEnv,
} from '../helpers/env.js';

describe('S2 事件重复（REQ §2.4 S2）', () => {
  it('每个事件双推 → 时间线无重复行、agent_run 恰一个、agent_trigger_queue 为空', async () => {
    const env: ScenarioEnv = await startScenarioEnv();
    try {
      // arrange：建群（agent_enabled=true，外部消息才可触发 run）→ 打开 dup_push_all
      const group = await setupGroup(env, { creator: 'acc-01', members: ['acc-02'] });
      await patchGroup(env, group.dbGroupId, { agentEnabled: true });
      await armSwitch(env, 'dup_push_all');
      await armSwitch(env, 'send_accept_slow', undefined, { delayMs: 0 });
      await armSwitch(env, 'message_sent_delay', undefined, { delayMs: 0 });

      // act-1：操作员 send（message_sent + 回流 message 各双推一次）
      const clientMsgId = await sendMessage(env, group.dbGroupId, {
        accountId: 'acc-01',
        text: 's2 own msg',
      });
      await waitFor(async () => (await gatewayCounters(env)).landedMessages >= 1);
      await waitFor(async () => {
        const items = await timeline(env, group.dbGroupId);
        return items.some((i) => i.clientMsgId === clientMsgId && i.deliveryStatus === 'sent');
      });

      // act-2：手动注入外部 message（dup_push_all 下同一 eventId 帧投两次）
      const externalMsgId = 'msg-ext-s2-1';
      const externalPuid = 'pu-external-s2';
      await emitEvent(env, 'message', {
        groupId: group.gwGroupId,
        msgId: externalMsgId,
        senderPlatformUserId: externalPuid,
        text: 's2 external hello',
        sentAt: new Date().toISOString(),
      });
      // 等双推两份都进账本消费（agent_run 出现即证明 handler 跑过；再等一拍让第二份吸收）
      await waitFor(
        async () =>
          (await countRows(env.pool, `SELECT count(*) AS n FROM agent_run WHERE group_id=$1`, [
            group.dbGroupId,
          ])) >= 1,
      );
      // 等 SSE 水位：framesEmitted 的每帧都应已入库（dup 投递不增 framesEmitted）
      await waitFor(async () => {
        const frames = (await gatewayCounters(env)).framesEmitted;
        const stored = await countRows(env.pool, `SELECT count(*) AS n FROM gateway_event`, []);
        return stored >= frames && frames > 0;
      });

      // assert-1：时间线无重复行——own 消息恰一行、外部消息恰一行
      const items = await timeline(env, group.dbGroupId);
      const ownRows = items.filter((i) => i.clientMsgId === clientMsgId);
      expect(ownRows.length).toBe(1);
      expect(ownRows[0]?.deliveryStatus).toBe('sent');
      const extRows = items.filter((i) => i.msgId === externalMsgId);
      expect(extRows.length).toBe(1);
      expect(extRows[0]?.isOwn).toBe(false);
      expect(extRows[0]?.text).toBe('s2 external hello');

      // assert-2：agent 不被重复触发——恰一个 run、积压队列为空（重复帧没再造第二个）
      expect(
        await countRows(env.pool, `SELECT count(*) AS n FROM agent_run WHERE group_id=$1`, [
          group.dbGroupId,
        ]),
      ).toBe(1);
      expect(
        await countRows(
          env.pool,
          `SELECT count(*) AS n FROM agent_trigger_queue WHERE group_id=$1`,
          [group.dbGroupId],
        ),
      ).toBe(0);

      // assert-3：gateway_event 每帧恰一行（帧数 == mock 账本产出数；投递层复制被吸收）
      const counters = await gatewayCounters(env);
      expect(
        await countRows(env.pool, `SELECT count(*) AS n FROM gateway_event`, []),
      ).toBe(counters.framesEmitted);
      expect(counters.landedMessages).toBe(1);
    } finally {
      await env.close();
    }
  }, 30_000);
});
