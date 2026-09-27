// T-P2-01 c)：网关 client（唯一出口）——错误映射 / 超时取消 / 浅校验 / SSE 解析。
// 依据 DES/01 §4.4/§6.5/§8、REQ §2.1、DES/14 §7；卡片 b 逐字。
// 双夹具：
// - 进程内 mock-gateway（createGatewayApp）：happy path（connect/groups/send/by-client-id/members/leave/disconnect/SSE）；
//   时序敏感段经 /_test/scenario 钉值（DES/14 §7：arrange 唯一入口），用后即清。
// - 内联 Fastify 假端点 + 裸 node:http 服务器：错误状态（429/503/504/500）、形状不合法、超时、分块 SSE。
// 【适配】mock-gateway 无 exports 字段（T-P1-01 已收口），相对路径跨包引入会撞 server rootDir（TS6059）：
//   server 增加 workspace devDep，经包名子路径 `mock-gateway/src/app.js` 引入工厂（DES/14 §7 允许 workspace 内 import 装配）。
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createGatewayApp } from 'mock-gateway/src/app.js';
import { createGatewayClient } from '../src/gateway/client.js';
import { GatewayError, GatewayTimeoutError } from '../src/gateway/errors.js';
import { subscribeEvents } from '../src/gateway/sse.js';

/** 延迟 void 信号：lib=ES2023 无 Promise.withResolvers；executor 同步赋值，返回时 resolve 已是真函数 */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolveFn: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: () => resolveFn?.() };
}

describe('gateway client (T-P2-01)', () => {
  let mockApp: FastifyInstance;
  let mockBaseUrl: string;
  let fakeApp: FastifyInstance;
  let fakeBaseUrl: string;

  beforeAll(async () => {
    mockApp = createGatewayApp({ logger: false });
    await mockApp.listen({ port: 0, host: '127.0.0.1' });
    mockBaseUrl = `http://127.0.0.1:${(mockApp.server.address() as AddressInfo).port}`;

    // 假网关：错误状态与形状不合法的响应（mock 的对应开关未落地）
    fakeApp = Fastify({ logger: false });
    fakeApp.post('/groups/:id/send', async (_req, reply) => {
      void reply.code(429).send({ code: 'RATE_LIMITED', retryAfterSeconds: 1.5 });
    });
    fakeApp.post('/groups/:id/kick', async (_req, reply) => {
      void reply.code(504).send({ code: 'NETWORK_TIMEOUT', message: 'result unknown' });
    });
    fakeApp.get('/groups/:id/messages/by-client-id/:clientMsgId', async (_req, reply) => {
      void reply.code(503).type('text/html').send('maintenance');
    });
    fakeApp.post('/groups/:id/leave', async (_req, reply) => {
      void reply.code(500).send({});
    });
    fakeApp.post('/accounts/:id/connect', async (_req, reply) => {
      void reply.code(200).send({ platformUserId: 12345 }); // 形状不合法：应为 string
    });
    fakeApp.get('/groups/:id/members', async (_req, reply) => {
      void reply.code(200).send([{ platformUserId: 'p-1' }, { wrong: true }]);
    });
    fakeApp.get('/media/ok', async (_req, reply) => {
      void reply.type('application/octet-stream').send(Buffer.from([137, 80, 78, 71]));
    });
    await fakeApp.listen({ port: 0, host: '127.0.0.1' });
    fakeBaseUrl = `http://127.0.0.1:${(fakeApp.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await Promise.all([mockApp.close(), fakeApp.close()]);
  });

  describe('against in-process mock-gateway (happy paths)', () => {
    it('connect returns deterministic platformUserId (shallow-validated)', async () => {
      const client = createGatewayClient({ baseUrl: mockBaseUrl });
      const first = await client.connect('acc-01');
      const second = await client.connect('acc-01');
      expect(typeof first.platformUserId).toBe('string');
      expect(first.platformUserId.length).toBeGreaterThan(0);
      expect(second.platformUserId).toBe(first.platformUserId);
    });

    it('group lifecycle: create → invite → join → promote round-trip typed', async () => {
      const client = createGatewayClient({ baseUrl: mockBaseUrl });
      await client.connect('acc-01'); // 建群账号须 online（五操作闸门）
      await client.connect('acc-02'); // join 账号同样须 online
      // arrange（DES/14 §7）：钉 readyAfterMs=0——默认档随机 0 或 2–5s，不钉值 join 会撞 409 INVITE_NOT_READY
      await mockApp.inject({
        method: 'POST',
        url: '/_test/scenario',
        payload: { switch: 'invite_not_ready', params: { readyAfterMs: 0 } },
      });
      try {
        const { groupId } = await client.createGroup({ creatorAccountId: 'acc-01' });
        expect(typeof groupId).toBe('string');
        const invite = await client.invite(groupId);
        expect(typeof invite.inviteLink).toBe('string');
        expect(invite.readyAfterMs).toBe(0); // 钉值生效即 arrange 生效

        // 等待 member_joined 再 promote（事件驱动，非定时猜延迟：join 的入群确认通常 100–1500ms）
        const joined = deferred();
        const controller = new AbortController();
        const subscribe = subscribeEvents(mockBaseUrl, undefined, {
          signal: controller.signal,
          onFrame: (frame) => {
            if (frame.event === 'member_joined') {
              controller.abort();
              joined.resolve();
            }
          },
        });
        const joinedResult = await client.join(groupId, { accountId: 'acc-02', inviteLink: invite.inviteLink });
        expect(joinedResult.accepted).toBe(true);
        await joined.promise;
        await expect(subscribe).resolves.toBe('aborted');

        await expect(
          client.promote(groupId, { byAccountId: 'acc-01', accountId: 'acc-02' }),
        ).resolves.toBeUndefined();
        const roster = await client.members(groupId);
        expect(roster).toHaveLength(2);
        expect(typeof roster[0]?.platformUserId).toBe('string');
      } finally {
        await mockApp.inject({
          method: 'POST',
          url: '/_test/scenario/clear',
          payload: { switch: 'invite_not_ready' },
        });
      }
    });

    it('send → SSE message_sent → by-client-id probe round-trip (pinned timing, DES/14 §3)', async () => {
      const client = createGatewayClient({ baseUrl: mockBaseUrl });
      await client.connect('acc-01');
      // arrange：202 受理钉 10ms、落地钉 600ms——给 by-client-id 留出确定性的 404 探测窗口
      await mockApp.inject({
        method: 'POST',
        url: '/_test/scenario',
        payload: { switch: 'send_accept_slow', params: { delayMs: 10 } },
      });
      await mockApp.inject({
        method: 'POST',
        url: '/_test/scenario',
        payload: { switch: 'message_sent_delay', params: { delayMs: 600 } },
      });
      try {
        const { groupId } = await client.createGroup({ creatorAccountId: 'acc-01' });
        const clientMsgId = 'c-probe-1';
        const sent = await client.send(groupId, { accountId: 'acc-01', clientMsgId, text: 'hello' });
        expect(sent.accepted).toBe(true);

        const landed = deferred();
        const controller = new AbortController();
        const subscribe = subscribeEvents(mockBaseUrl, undefined, {
          signal: controller.signal,
          onFrame: (frame) => {
            const data = frame.data as { clientMsgId?: unknown } | null;
            if (frame.event === 'message_sent' && data?.clientMsgId === clientMsgId) {
              controller.abort();
              landed.resolve();
            }
          },
        });

        // 未落地：404 → NOT_FOUND（「确认未发出」由调用方判定；client 只做分类，DES/05 §2.4）
        const probeErr = await client
          .getMessageByClientMsgId(groupId, clientMsgId)
          .catch((e: unknown) => e);
        expect(probeErr).toBeInstanceOf(GatewayError);
        expect((probeErr as GatewayError).status).toBe(404);
        expect((probeErr as GatewayError).code).toBe('NOT_FOUND');
        expect((probeErr as GatewayError).endpoint).toBe('byClientId');

        await landed.promise;
        await expect(subscribe).resolves.toBe('aborted');
        const found = await client.getMessageByClientMsgId(groupId, clientMsgId);
        expect(typeof found.msgId).toBe('string');
        expect(typeof found.sentAt).toBe('string');

        // 余下端点的传输层 + 浅校验：leave / disconnect 均 200 {}（无字段可取 → undefined）
        await expect(client.leave(groupId, { accountId: 'acc-01' })).resolves.toBeUndefined();
        await expect(client.disconnect('acc-01')).resolves.toBeUndefined();
      } finally {
        await mockApp.inject({ method: 'POST', url: '/_test/scenario/clear', payload: { switch: 'send_accept_slow' } });
        await mockApp.inject({ method: 'POST', url: '/_test/scenario/clear', payload: { switch: 'message_sent_delay' } });
      }
    });

    it('offline account on join → GatewayError{status:409, code:"ACCOUNT_OFFLINE"} verbatim', async () => {
      const client = createGatewayClient({ baseUrl: mockBaseUrl });
      const { groupId } = await client.createGroup({ creatorAccountId: 'acc-01' });
      const invite = await client.invite(groupId);
      const err = await client
        .join(groupId, { accountId: 'acc-03', inviteLink: invite.inviteLink })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GatewayError);
      const gwErr = err as GatewayError;
      expect(gwErr.status).toBe(409);
      expect(gwErr.code).toBe('ACCOUNT_OFFLINE');
      expect(gwErr.endpoint).toBe('join');
    });
  });

  describe('error mapping (DES/01 §6.5)', () => {
    it('429 → GatewayError{status:429, code:"RATE_LIMITED"} with retryAfterSeconds preserved un-rounded', async () => {
      const client = createGatewayClient({ baseUrl: fakeBaseUrl });
      const err = await client
        .send('g1', { accountId: 'a', clientMsgId: 'c1', text: 't' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GatewayError);
      const gwErr = err as GatewayError;
      expect(gwErr.status).toBe(429);
      expect(gwErr.code).toBe('RATE_LIMITED');
      expect(gwErr.body).toMatchObject({ retryAfterSeconds: 1.5 });
    });

    it('504 → code NETWORK_TIMEOUT (outcome unknown, not retryable)', async () => {
      const client = createGatewayClient({ baseUrl: fakeBaseUrl });
      const err = await client
        .kick('g1', { byAccountId: 'a', targetPlatformUserId: 'p' })
        .catch((e: unknown) => e);
      const gwErr = err as GatewayError;
      expect(gwErr).toBeInstanceOf(GatewayError);
      expect(gwErr.status).toBe(504);
      expect(gwErr.code).toBe('NETWORK_TIMEOUT');
      expect(gwErr.retryable).toBe(false);
    });

    it('503 → retryable UNAVAILABLE, distinct classification from 504 (DES/05 §8)', async () => {
      const client = createGatewayClient({ baseUrl: fakeBaseUrl });
      const err = await client.getMessageByClientMsgId('g1', 'c1').catch((e: unknown) => e);
      const gwErr = err as GatewayError;
      expect(gwErr).toBeInstanceOf(GatewayError);
      expect(gwErr.status).toBe(503);
      expect(gwErr.code).toBe('UNAVAILABLE');
      expect(gwErr.retryable).toBe(true); // 与 504 分流：整体不可用、可重试类
    });

    it('bare 500 without code → status-derived INTERNAL', async () => {
      const client = createGatewayClient({ baseUrl: fakeBaseUrl });
      const err = await client.leave('g1', { accountId: 'a' }).catch((e: unknown) => e);
      const gwErr = err as GatewayError;
      expect(gwErr.status).toBe(500);
      expect(gwErr.code).toBe('INTERNAL');
    });

    it('2xx with wrong shape → INVALID_RESPONSE marker, not silent cast', async () => {
      const client = createGatewayClient({ baseUrl: fakeBaseUrl });
      const connectErr = await client.connect('a').catch((e: unknown) => e);
      expect(connectErr).toBeInstanceOf(GatewayError);
      expect((connectErr as GatewayError).code).toBe('INVALID_RESPONSE');

      const membersErr = await client.members('g1').catch((e: unknown) => e);
      expect(membersErr).toBeInstanceOf(GatewayError);
      expect((membersErr as GatewayError).code).toBe('INVALID_RESPONSE');
    });
  });

  describe('media download (GET /media/:id)', () => {
    it('returns raw bytes for a full mediaUrl', async () => {
      const client = createGatewayClient({ baseUrl: fakeBaseUrl });
      const bytes = await client.downloadMedia(`${fakeBaseUrl}/media/ok`);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(Array.from(bytes)).toEqual([137, 80, 78, 71]);
    });

    it('404 (mock media 属 C1 未落地) → GatewayError{status:404, code:"NOT_FOUND", endpoint:"media"}', async () => {
      const client = createGatewayClient({ baseUrl: mockBaseUrl });
      const err = await client.downloadMedia(`${mockBaseUrl}/media/m-404`).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GatewayError);
      const gwErr = err as GatewayError;
      expect(gwErr.status).toBe(404);
      expect(gwErr.code).toBe('NOT_FOUND');
      expect(gwErr.endpoint).toBe('media');
    });
  });

  describe('timeout (DES/01 §4.4)', () => {
    let slowServer: Server;
    afterEach(() => {
      slowServer?.close();
    });

    it('deadline exceeded → GatewayTimeoutError with endpoint name; connection actually aborted', { timeout: 10_000 }, async () => {
      // 真实墙钟例外：超时行为本身是对平台时钟的集成验证（ts-no-test-timers 例外条款）
      const sawAbort = deferred();
      slowServer = createServer((req, res) => {
        req.on('close', () => sawAbort.resolve()); // AbortController 取消 → 服务端看到连接断开
        // 永不响应：吊死到超时
        void res;
      });
      const listening = deferred();
      slowServer.listen(0, '127.0.0.1', () => listening.resolve());
      await listening.promise;
      const port = (slowServer.address() as AddressInfo).port;
      const client = createGatewayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        timeouts: { default: 150 }, // 测试注入缝：默认值来自 constants（GATEWAY_TIMEOUT_DEFAULT_MS）
      });
      const startedAt = Date.now();
      const err = await client.createGroup({ creatorAccountId: 'a' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GatewayTimeoutError);
      const timeoutErr = err as GatewayTimeoutError;
      expect(timeoutErr.endpoint).toBe('createGroup');
      expect(timeoutErr.timeoutMs).toBe(150);
      expect(Date.now() - startedAt).toBeLessThan(5000);
      await expect(sawAbort.promise).resolves.toBeUndefined(); // AbortController 真取消，非静默挂死
    });
  });

  describe('SSE consumer (subscribeEvents)', () => {
    it('replays history with exclusive since semantics against mock ledger', async () => {
      // 账本由整个测试文件共享（eventId 计数器不回退，DES/14 §1）——断言以 emit 返回的实际 id 为准
      const emit = async (msgId: string): Promise<number> => {
        const res = await mockApp.inject({
          method: 'POST',
          url: '/_test/emit',
          payload: {
            type: 'message',
            data: { groupId: 'g1', msgId, senderPlatformUserId: 'p-1', text: 't', sentAt: '2026-09-27T00:00:00.000Z' },
          },
        });
        return (res.json() as { eventId: number }).eventId;
      };
      const firstId = await emit('m-1');
      const secondId = await emit('m-2');

      const frames: Array<{ eventId: number | null; event: string | null; data: unknown }> = [];
      const controller = new AbortController();
      const done = subscribeEvents(mockBaseUrl, firstId - 1, {
        signal: controller.signal,
        onFrame: (frame) => {
          frames.push(frame);
          if (frames.length >= 2) controller.abort();
        },
      });
      await expect(done).resolves.toBe('aborted');
      expect(frames.map((f) => f.eventId)).toEqual([firstId, secondId]);
      expect(frames.map((f) => f.event)).toEqual(['message', 'message']);
      expect((frames[0]?.data as { msgId: string }).msgId).toBe('m-1');

      // since 独占：since=firstId → 只收 eventId>firstId（此处恰为 m-2）
      const later: number[] = [];
      const controller2 = new AbortController();
      await expect(
        subscribeEvents(mockBaseUrl, firstId, {
          signal: controller2.signal,
          onFrame: (frame) => {
            later.push(frame.eventId ?? -1);
            controller2.abort();
          },
        }),
      ).resolves.toBe('aborted');
      expect(later).toEqual([secondId]);
    });

    it('parses frames split across chunks, tolerates CRLF, keeps raw data on invalid JSON', async () => {
      const rawServer = createServer((req, res) => {
        expect(req.url).toBe('/events?since=5'); // since 必须进 query（重连语义的前提）
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('id: 6\r\nevent: message\r\n'); // 半帧切断：字段完整但无空行边界
        // setImmediate：确定性事件循环边界（非固定墙钟睡眠）——两段分属不同 TCP 写
        setImmediate(() => {
          res.write('data: {"msgId":"m-6"}\r\n\r\n');
          res.write('id: 7\r\nevent: message\r\ndata: not-json\r\n\r\n'); // 坏 JSON：不中断流
          res.write(': keepalive comment\r\n\r\n'); // 注释行忽略
          res.end();
        });
      });
      const rawListening = deferred();
      rawServer.listen(0, '127.0.0.1', () => rawListening.resolve());
      await rawListening.promise;
      const port = (rawServer.address() as AddressInfo).port;
      const frames: Array<{ eventId: number | null; event: string | null; data: unknown; rawData: string }> = [];
      const result = await subscribeEvents(`http://127.0.0.1:${port}`, 5, {
        onFrame: (frame) => {
          frames.push(frame);
        },
      });
      expect(result).toBe('ended'); // 服务端正常收流 → 结束（重连由 T-P2-03 的消费循环负责）
      expect(frames).toHaveLength(2);
      expect(frames[0]).toMatchObject({ eventId: 6, event: 'message', data: { msgId: 'm-6' } });
      expect(frames[1]).toMatchObject({ eventId: 7, data: null });
      expect(frames[1]?.rawData).toBe('not-json');
      rawServer.close();
    });

    it('non-2xx on events endpoint → GatewayError (typed, not silent)', async () => {
      const err = await subscribeEvents(fakeBaseUrl, undefined, { onFrame: () => {} }).catch(
        (e: unknown) => e,
      );
      // 假网关没有 /events → 404 → 类型化 GatewayError
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).endpoint).toBe('events');
    });
  });
});
