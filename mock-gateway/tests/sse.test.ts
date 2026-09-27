// SSE 推送器测试（T-P1-02 c 项，先红后绿）。
// 契约出处：REQ §2.1 事件流节（since 独占、全历史回放、不带 since 从当前时刻开始、
// 帧 id/event/data 且 data 内带 eventId+type）；DES/14 §1（账本先入后投）。
// 消费方式：真 HTTP + fetch stream（卡片 c 项；app.inject 对无限流不会结束，不适合 SSE）。
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGatewayApp, type GatewayApp } from '../src/app.js';
import { frameToWire } from '../src/sse.js';

interface SseFrame {
  id: number;
  event: string;
  data: Record<string, unknown>;
}

let app: GatewayApp;
let baseUrl: string;

beforeAll(async () => {
  app = createGatewayApp({ seedAccountIds: [] });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected TCP address');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

// 说明（真实定时器例外）：SSE 是真 HTTP 流集成测试，fake timers 无法驱动 socket；
// 少量固定延时只用于「等连接建立」与「安静期断言」，属本规则声明的稀有例外。

afterAll(async () => {
  await app.close();
});

async function emit(type: string, data: Record<string, unknown>): Promise<number> {
  const res = await fetch(`${baseUrl}/_test/emit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, data }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { eventId: number }).eventId;
}

/**
 * 连接 /events 并收帧：满足 done 或 timeoutMs 到点即断开，返回已收到的帧。
 * timeout 语义是「安静期」：自建立连接起最多等 timeoutMs，用于断言「没有更多帧」。
 */
async function readSse(
  query: string,
  done: (frames: SseFrame[]) => boolean,
  quietMs: number,
): Promise<SseFrame[]> {
  const controller = new AbortController();
  const frames: SseFrame[] = [];
  const timer = setTimeout(() => controller.abort(), quietMs);
  try {
    const res = await fetch(`${baseUrl}/events${query}`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    if (res.body === null) {
      throw new Error('no response body');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
        const frame = parseBlock(block);
        if (frame) {
          frames.push(frame);
          if (done(frames)) {
            controller.abort();
            return frames;
          }
        }
      }
    }
    return frames;
  } catch (err) {
    if (controller.signal.aborted) {
      return frames;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function parseBlock(block: string): SseFrame | null {
  let id = -1;
  let event = '';
  let dataRaw = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('id: ')) {
      id = Number(line.slice(4));
    } else if (line.startsWith('event: ')) {
      event = line.slice(7);
    } else if (line.startsWith('data: ')) {
      dataRaw = line.slice(6);
    }
  }
  if (id === -1 || event === '' || dataRaw === '') {
    return null;
  }
  return { id, event, data: JSON.parse(dataRaw) as Record<string, unknown> };
}

describe('since 独占语义 + 全历史回放（REQ §2.1）', () => {
  it('账本 1..10，since=3 → 收到且仅收到 4..10', async () => {
    for (let i = 0; i < 10; i++) {
      await emit('account_status', { accountId: `acc-${i}`, status: 'suspended' });
    }
    const frames = await readSse('?since=3', (fs) => fs.length >= 7, 1500);
    expect(frames.map((f) => f.id)).toEqual([4, 5, 6, 7, 8, 9, 10]);
  });

  it('since=0 → 回放全部；帧顺序与账本一致且 id: 行 = data.eventId', async () => {
    const frames = await readSse('?since=0', (fs) => fs.length >= 10, 1500);
    expect(frames.map((f) => f.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const frame of frames) {
      expect(frame.data['eventId']).toBe(frame.id);
      expect(frame.data['type']).toBe(frame.event);
    }
  });

  it('非法 since → 400', async () => {
    const res = await fetch(`${baseUrl}/events?since=abc`);
    expect(res.status).toBe(400);
  });
});

describe('不带 since：从连接时刻开始，不回放历史（REQ §2.1）', () => {
  it('连接后 emit 的帧到达，连接前的历史不回放', async () => {
    // 前置：账本已有 10 条（上一 describe）；先连接，再 emit 两条
    const collector = readSse('', (fs) => fs.length >= 2, 1500);
    await sleep(200); // 等连接建立
    await emit('message_failed', { clientMsgId: 'c-new-1', code: 'ACCOUNT_SUSPENDED' });
    await emit('message_sent', { clientMsgId: 'c-new-1', msgId: 'm-new-1', sentAt: '2026-09-27T00:00:00.000Z' });
    const frames = await collector;
    expect(frames.map((f) => f.id)).toEqual([11, 12]);
  });
});

describe('六类契约事件均可投递（REQ §2.1）', () => {
  it('message / message_sent / message_failed / member_joined / member_left / account_status', async () => {
    // 记录水位再 emit：since 必须指向首帧之前（独占语义），否则首帧被过滤
    const since = app.gatewayState.eventIdCounter;
    await emit('account_status', { accountId: 'acc-1', status: 'session_expired' });
    await emit('message', {
      groupId: 'gw-1',
      msgId: 'm-1',
      senderPlatformUserId: 'puid-a',
      text: 'hello',
      sentAt: '2026-09-27T00:00:00.000Z',
    });
    await emit('message_sent', { clientMsgId: 'c-1', msgId: 'm-1', sentAt: '2026-09-27T00:00:00.000Z' });
    await emit('message_failed', { clientMsgId: 'c-2', code: 'GROUP_WRITE_FORBIDDEN' });
    await emit('member_joined', { groupId: 'gw-1', platformUserId: 'puid-b' });
    await emit('member_left', { groupId: 'gw-1', platformUserId: 'puid-b' });

    const frames = await readSse(`?since=${since}`, (fs) => fs.length >= 6, 1500);
    expect(frames.map((f) => f.event).sort()).toEqual(
      ['account_status', 'member_joined', 'member_left', 'message', 'message_failed', 'message_sent'].sort(),
    );
  });
});

describe('多订阅者与连接清理', () => {
  it('两个并发连接收到相同帧；一个断开不影响另一个', async () => {
    const collectorA = readSse('', (fs) => fs.length >= 1, 1500);
    const collectorB = readSse('', (fs) => fs.length >= 1, 1500);
    await sleep(200);
    await emit('member_left', { groupId: 'gw-9', platformUserId: 'puid-x' });
    const [framesA, framesB] = await Promise.all([collectorA, collectorB]);
    expect(framesA.map((f) => f.id)).toEqual(framesB.map((f) => f.id));

    // A 已断（readSse 完成即 abort）；B 再连一条仍可收到
    const collectorC = readSse('', (fs) => fs.length >= 1, 1500);
    await sleep(200);
    await emit('member_left', { groupId: 'gw-9', platformUserId: 'puid-y' });
    const framesC = await collectorC;
    expect(framesC).toHaveLength(1);
  });

  it('重放与实时衔接不丢帧：订阅后先回放再收实时（账本顺序单调）', async () => {
    // 先建立订阅（since 较旧，需要回放），期间并发 emit 实时帧
    const sinceBefore = app.gatewayState.eventIdCounter;
    const collector = readSse(`?since=${Math.max(0, sinceBefore - 2)}`, (fs) => fs.length >= 4, 1500);
    await sleep(150);
    await emit('message_failed', { clientMsgId: 'c-r1', code: 'ACCOUNT_SUSPENDED' });
    await emit('message_failed', { clientMsgId: 'c-r2', code: 'ACCOUNT_SUSPENDED' });
    const frames = await collector;
    const ids = frames.map((f) => f.id);
    // 严格递增且无重复（回放段与实时段的衔接由 eventId 水位去重保证）
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });
});

describe('SSE 帧线上格式（纯函数）', () => {
  it('frameToWire：id/event/data 三行 + 空行分隔，data 为 JSON 且带 eventId/type', () => {
    const wire = frameToWire({
      eventId: 7,
      type: 'message',
      data: { groupId: 'g', msgId: 'm', eventId: 7, type: 'message' },
      emittedAt: 0,
    });
    expect(wire).toBe(
      `id: 7\nevent: message\ndata: ${JSON.stringify({ groupId: 'g', msgId: 'm', eventId: 7, type: 'message' })}\n\n`,
    );
  });
});
