// B4 断线补齐端到端（REQ §3 B4、QR §1「3s」、DES/08 §2.2、VITEST_PLAN §2 B4-1 端到端行）。
// 场景（真实 server + 真实 WS socket + 真 gateway 事件注入）：
//   WS 客户端 auth 连上 → 收到一条实时 message 帧（记下 lastSeq）→ 断线；
//   断线期间 gateway 又产生两条 message 事件（SSE→消费→ws_event 落库）；
//   重连 auth 带 sinceSeq=lastSeq → 两条补发帧到达（seq>S 独占）+ 全窗口内该 msgId
//   零重复（lastSentSeq 水位兜底实时/补发交叠）。
// 计时断言：从发出重连 auth 到收齐补发帧 ≤3s（QR §1「断线后 3 秒内补齐」）。
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  emitEvent,
  setupGroup,
  startScenarioEnv,
  waitFor,
  type ScenarioEnv,
} from '../helpers/env.js';

interface Frame {
  seq?: number;
  type: string;
  payload?: Record<string, unknown>;
  success?: boolean;
}

function wsUrlOf(serverUrl: string): string {
  return serverUrl.replace(/^http/, 'ws') + '/ws';
}

/** 连 WS + auth（可选 sinceSeq），返回收集器；每帧 JSON.parse 后推入 frames */
async function authedWs(
  env: ScenarioEnv,
  frames: Frame[],
  sinceSeq?: number,
): Promise<WebSocket> {
  const ws = new WebSocket(wsUrlOf(env.serverUrl));
  ws.on('message', (d: Buffer | string) => {
    frames.push(JSON.parse(String(d)) as Frame);
  });
  await once(ws, 'open');
  const auth: Record<string, unknown> = { type: 'auth', accessToken: env.token };
  if (sinceSeq !== undefined) auth['sinceSeq'] = sinceSeq;
  ws.send(JSON.stringify(auth));
  await waitFor(() => frames.some((f) => f.type === 'auth' && f.success === true), 3000);
  return ws;
}

async function emitInbound(env: ScenarioEnv, groupId: string, msgId: string): Promise<void> {
  await emitEvent(env, 'message', {
    groupId,
    msgId,
    senderPlatformUserId: 'puid-acc-02',
    text: `backfill ${msgId}`,
    sentAt: new Date().toISOString(),
  });
}

describe('B4 WS 断线补齐端到端（REQ §3 B4、QR §1 3s）', () => {
  it('断线期间的 message 事件在重连 sinceSeq 后 ≤3s 补齐且不重复', async () => {
    const env: ScenarioEnv = await startScenarioEnv();
    const frames1: Frame[] = [];
    let ws1: WebSocket | undefined;
    try {
      const group = await setupGroup(env, { creator: 'acc-01', members: ['acc-02'] });

      // ① 连接 + auth（无 sinceSeq → 从当前起）
      ws1 = await authedWs(env, frames1);

      // ② 实时收一条 message 帧，记下 lastSeq
      await emitInbound(env, group.gwGroupId, 'b4-live-1');
      await waitFor(
        () => frames1.some((f) => f.type === 'message' && f.payload?.['msgId'] === 'b4-live-1'),
        15000, // 并行跑全仓时 SSE 消费→ws_event 投递可能排队——放宽等事件但不放宽 ≤3s 补发断言
      );
      const live = frames1.find((f) => f.type === 'message' && f.payload?.['msgId'] === 'b4-live-1');
      const lastSeq = live?.seq;
      expect(typeof lastSeq).toBe('number');

      // ③ 断线；断线期间再产生两条 message 事件
      ws1.close();
      await once(ws1, 'close');
      await emitInbound(env, group.gwGroupId, 'b4-missed-1');
      await emitInbound(env, group.gwGroupId, 'b4-missed-2');
      // 等事件确已入库（SSE 消费 → ws_event 行）再重连——保证补发真值在表
      await waitFor(async () => {
        const { rows } = await env.pool.query<{ n: number }>(
          `SELECT count(*) AS n FROM ws_event WHERE type='message'
             AND payload->>'msgId' IN ('b4-missed-1','b4-missed-2')`,
        );
        return Number(rows[0]?.n ?? 0) === 2;
      }, 15000);

      // ④ 重连 auth 带 sinceSeq=lastSeq（客户端语义：web WsClient 同形——断线重连必带 sinceSeq）
      const frames2: Frame[] = [];
      const t0 = Date.now();
      const ws2 = await authedWs(env, frames2, lastSeq);
      try {
        // ⑤ 3 秒内两条补发帧到达（计时从 auth 发出前起算——含 auth 往返）
        await waitFor(
          () =>
            frames2.some((f) => f.type === 'message' && f.payload?.['msgId'] === 'b4-missed-1') &&
            frames2.some((f) => f.type === 'message' && f.payload?.['msgId'] === 'b4-missed-2'),
          3000,
        );
        expect(Date.now() - t0).toBeLessThan(3000); // QR §1「3s」逐字计时断言

        // ⑥ 独占语义：补发帧 seq 严格 > lastSeq
        for (const id of ['b4-missed-1', 'b4-missed-2']) {
          const f = frames2.find((x) => x.type === 'message' && x.payload?.['msgId'] === id);
          expect(f?.seq).toBeGreaterThan(lastSeq ?? 0);
        }

        // ⑦ 零重复：每个断线期 msgId 恰出现一次
        const missed = frames2.filter(
          (f) =>
            f.type === 'message' &&
            typeof f.payload?.['msgId'] === 'string' &&
            (f.payload['msgId'] as string).startsWith('b4-missed-'),
        );
        expect(missed).toHaveLength(2);

        // ⑧ 再宽限一拍，确认没有第二条重复帧姗姗来迟（水位去重真的兜住）
        await new Promise((r) => setTimeout(r, 700));
        const missed2 = frames2.filter(
          (f) =>
            f.type === 'message' &&
            typeof f.payload?.['msgId'] === 'string' &&
            (f.payload['msgId'] as string).startsWith('b4-missed-'),
        );
        expect(missed2).toHaveLength(2);
      } finally {
        ws2.close();
      }
    } finally {
      ws1?.close();
      await env.close();
    }
  }, 60000);
});
