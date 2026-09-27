// S1 受理与发出（REQ §2.4 S1 行、analysis/09 §1、DES/14 §8）。
// 逐字断言：「网关对 send 先回 202，过一会儿再推 message_sent」→
//   message_sent 之前 deliveryStatus='accepted'，之后 'sent'，恰一行。
// 两段延迟各自钉死（gw-1 202 立回 / gw-2 落地 1500ms）——观测窗口确定性，不靠运气。
// 装配：真 PG + in-process 双 mock + 真实 server（boot 全管线：SSE 消费 + dispatcher + adjudicator）。
import { describe, expect, it } from 'vitest';
import {
  armSwitch,
  countRows,
  gatewayCounters,
  sendMessage,
  setupGroup,
  startScenarioEnv,
  timeline,
  waitFor,
  type ScenarioEnv,
} from '../helpers/env.js';

describe('S1 受理与发出（REQ §2.4 S1）', () => {
  it('message_sent 之前 deliveryStatus=accepted、之后 sent、恰一行', async () => {
    const env: ScenarioEnv = await startScenarioEnv();
    try {
      // arrange：建群到 active；两段延迟钉死（202 立回 + 落地 1500ms）
      const group = await setupGroup(env, { creator: 'acc-01', members: ['acc-02'] });
      await armSwitch(env, 'send_accept_slow', undefined, { delayMs: 0 });
      await armSwitch(env, 'message_sent_delay', undefined, { delayMs: 1500 });

      // act：操作员 send → 202 受理（先持久化后返回）
      const clientMsgId = await sendMessage(env, group.dbGroupId, {
        accountId: 'acc-01',
        text: 's1 hello',
      });

      // assert-1：message_sent 之前的窗口里，时间线读面是 accepted（dispatcher 已把 202 落账）
      await waitFor(async () => {
        const items = await timeline(env, group.dbGroupId);
        return items.some((i) => i.clientMsgId === clientMsgId && i.deliveryStatus === 'accepted');
      });
      const before = (await timeline(env, group.dbGroupId)).filter(
        (i) => i.clientMsgId === clientMsgId,
      );
      expect(before.length).toBe(1);
      expect(before[0]?.deliveryStatus).toBe('accepted');
      expect(before[0]?.msgId).toBeNull(); // msgId 只能由 message_sent 回填（DES/05 §4.3）
      expect(before[0]?.isOwn).toBe(true);

      // assert-2：message_sent 到达后 → sent + msgId 回填；仍恰一行
      await waitFor(async () => (await gatewayCounters(env)).landedMessages >= 1);
      await waitFor(async () => {
        const items = await timeline(env, group.dbGroupId);
        return items.some(
          (i) => i.clientMsgId === clientMsgId && i.deliveryStatus === 'sent' && i.msgId !== null,
        );
      });
      const after = (await timeline(env, group.dbGroupId)).filter(
        (i) => i.clientMsgId === clientMsgId,
      );
      expect(after.length).toBe(1);
      expect(after[0]?.deliveryStatus).toBe('sent');
      expect(after[0]?.msgId).not.toBeNull();
      expect(after[0]?.failCode).toBeNull();

      // assert-3：网关侧真值——该账号恰好一次 send 调用、恰好一条落地
      const counters = await gatewayCounters(env);
      expect(counters.sendCallsByAccount['acc-01']).toBe(1);
      expect(counters.sendCallsByClientMsgId[clientMsgId]).toBe(1);
      expect(counters.landedMessages).toBe(1);

      // assert-4：库内也恰一行（REST 读面与落库一致）
      expect(
        await countRows(env.pool, `SELECT count(*) AS n FROM message WHERE client_msg_id=$1`, [
          clientMsgId,
        ]),
      ).toBe(1);
    } finally {
      await env.close();
    }
  }, 30_000);
});
