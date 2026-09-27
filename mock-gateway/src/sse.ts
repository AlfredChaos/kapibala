// SSE 推送器（T-P1-02；REQ §2.1 事件流节；DES/14 §1/§3）。
// 语义：带 since → 回放账本（eventId > since，独占）再续推实时帧；不带 since → 从当前时刻开始。
// 帧 = `id: <eventId>` / `event: <type>` / `data: <JSON>`（data 内带 eventId 与 type，REQ §2.1）。
// 乱序 / 重复推送（开关 3/4）不在本任务：decorateFrame 是留好的 seam——
// 开关层插在「账本落定 → socket 写出」之间（DES/14 §3 推送器修饰投递模型）。
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { framesSince, subscribeLedger } from './ledger.js';
import type { GatewayState, LedgerFrame } from './state.js';

/** 投帧装饰 seam：默认恒等；dup_push_all / reorder_1s 等开关层（T-P1-05/T-P2-12）在此插入 */
export type FrameDecorator = (frame: LedgerFrame) => LedgerFrame;

export interface SseOptions {
  decorateFrame?: FrameDecorator;
}

/** SSE keepalive 注释行间隔（mock 内部传输选择，非契约数字；防代理空闲断连） */
const HEARTBEAT_MS = 30_000;

/** 帧线上格式（导出供纯函数测试与开关层复用） */
export function frameToWire(frame: LedgerFrame): string {
  return `id: ${frame.eventId}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

export function registerSseRoutes(app: FastifyInstance, state: GatewayState, options: SseOptions = {}): void {
  const decorate = options.decorateFrame ?? ((frame: LedgerFrame) => frame);

  app.get('/events', { config: { rawBody: false } }, async (request, reply) => {
    // since 非法值显式 400：静默当 0 处理会变成「全量回放」，与调用方意图相反
    const query = request.query as { since?: string };
    let since: number | undefined;
    if (query.since !== undefined) {
      if (!/^\d+$/.test(query.since)) {
        return await reply.code(400).send({ message: 'since must be a non-negative integer' });
      }
      since = Number(query.since);
    }

    return handleEventsStream(request, reply, state, since, decorate);
  });
}

async function handleEventsStream(
  request: FastifyRequest,
  reply: FastifyReply,
  state: GatewayState,
  since: number | undefined,
  decorate: FrameDecorator,
): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    // 关闭代理缓冲：SSE 帧必须即时送达（时序契约依赖到达时刻的相对顺序）
    'x-accel-buffering': 'no',
  });

  let closed = false;
  const pending: LedgerFrame[] = [];
  let live = false;
  // 水位：回放段已发到的 eventId（衔接去重）。无 since 时无回放，水位 0 = 实时帧全放行。
  let lastSentEventId = since ?? 0;
  const writeFrame = (frame: LedgerFrame): void => {
    if (closed) {
      return;
    }
    raw.write(frameToWire(decorate(frame)));
    lastSentEventId = frame.eventId;
  };

  // 1) 先挂订阅（回放期间新到的帧进 pending，不丢）
  const unsubscribe = subscribeLedger(state, (frame) => {
    if (!live) {
      pending.push(frame);
      return;
    }
    // 实时阶段：按水位去重——回放段已含的 eventId 不再重发（衔接处无重复）
    if (frame.eventId > lastSentEventId) {
      writeFrame(frame);
    }
  });

  const heartbeat = setInterval(() => {
    if (!closed) {
      raw.write(': keepalive\n\n');
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const cleanup = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  request.raw.on('close', cleanup);

  // 2) 回放（带 since 才有），随后放行 pending（水位过滤掉与回放重叠的帧）
  if (since !== undefined) {
    for (const frame of framesSince(state, since)) {
      writeFrame(frame);
    }
  }
  live = true;
  for (const frame of pending.splice(0)) {
    if (frame.eventId > lastSentEventId) {
      writeFrame(frame);
    }
  }
}
