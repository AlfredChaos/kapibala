// SSE 推送器（T-P1-02；REQ §2.1 事件流节；DES/14 §1/§3）。
// 语义：带 since → 回放账本（eventId > since，独占）再续推实时帧；不带 since → 从当前时刻开始。
// 帧 = `id: <eventId>` / `event: <type>` / `data: <JSON>`（data 内带 eventId 与 type，REQ §2.1）。
// 投递修饰（DES/14 §3「推送器按开关修饰后投递」）走 createFrameDelivery seam：开关层插在
// 「水位过滤之后、socket 写出之前」——gw-3 双推（switches/basic.ts）、gw-4 相邻乱序（switches/timing.ts）。
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { framesSince, subscribeLedger } from './ledger.js';
import type { GatewayState, LedgerFrame } from './state.js';

/**
 * 投递 seam：一条账本帧 → 0..n 次 sink 写出，且允许**延后**写出。每连接一个实例
 * （各自的缓冲/定时器互不串扰）。sink 是链末端（写 socket + 推进水位）。
 * - gw-3 `dup_push_all`（switches/basic.ts）：同一帧 sink 两次（同 eventId，账本仍一行）
 * - gw-4 `reorder_1s`（switches/timing.ts）：扣住一帧与下一帧交换写出；尾帧到点冲刷（不丢帧）
 * 延后/交换写出的帧 eventId 可能更小，故 sink **不再做水位过滤**（水位只单调推进用于回放↔实时衔接去重），
 * 否则双推的第二份与乱序后的旧帧都会被 `eventId > lastSentEventId` 丢掉。
 */
export type FrameSink = (frame: LedgerFrame) => void;

export interface FrameDelivery {
  /** 收到一条账本帧：由开关层决定何时 / 是否 / 几次写 sink */
  push(frame: LedgerFrame): void;
  /** 连接关闭：清理定时器等资源（此后不得再写 sink） */
  close?(): void;
}

/** 每连接调用一次；多级开关（gw-4 定序 → gw-3 复制）在 app 工厂里串联 */
export type FrameDeliveryFactory = (sink: FrameSink) => FrameDelivery;

export interface SseOptions {
  /** 缺省 = 恒等直通（一帧一写，无修饰） */
  createFrameDelivery?: FrameDeliveryFactory;
}

/** SSE keepalive 注释行间隔（mock 内部传输选择，非契约数字；防代理空闲断连） */
const HEARTBEAT_MS = 30_000;

/** 帧线上格式（导出供纯函数测试与开关层复用） */
export function frameToWire(frame: LedgerFrame): string {
  return `id: ${frame.eventId}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

/** 恒等直通投递（未接开关层时的默认：一帧一写） */
function passthroughDelivery(sink: FrameSink): FrameDelivery {
  return { push: sink };
}

export function registerSseRoutes(app: FastifyInstance, state: GatewayState, options: SseOptions = {}): void {
  const createDelivery = options.createFrameDelivery ?? passthroughDelivery;

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

    return handleEventsStream(request, reply, state, since, createDelivery);
  });
}

async function handleEventsStream(
  request: FastifyRequest,
  reply: FastifyReply,
  state: GatewayState,
  since: number | undefined,
  createDelivery: FrameDeliveryFactory,
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
  // 水位：已写出的最大 eventId（回放段与实时段的衔接去重）。无 since 时无回放，水位 0 = 实时帧全放行。
  let lastSentEventId = since ?? 0;
  // 末端 sink：写出一帧并单调推进水位（乱序时先写大 id 也不回退，回放↔实时衔接处不重发）
  const delivery = createDelivery((frame: LedgerFrame): void => {
    if (closed) {
      return;
    }
    raw.write(frameToWire(frame));
    if (frame.eventId > lastSentEventId) {
      lastSentEventId = frame.eventId;
    }
  });

  // 1) 先挂订阅（回放期间新到的帧进 pending，不丢）
  const unsubscribe = subscribeLedger(state, (frame) => {
    if (!live) {
      pending.push(frame);
      return;
    }
    // 实时阶段：按水位去重——回放段已含的 eventId 不再重发（衔接处无重复）
    if (frame.eventId > lastSentEventId) {
      delivery.push(frame);
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
    delivery.close?.(); // 清掉开关层扣帧的定时器（sink 也因 closed 不再写）
  };
  request.raw.on('close', cleanup);

  // 2) 回放（带 since 才有），随后放行 pending（水位过滤掉与回放重叠的帧）
  if (since !== undefined) {
    for (const frame of framesSince(state, since)) {
      delivery.push(frame);
    }
  }
  live = true;
  for (const frame of pending.splice(0)) {
    if (frame.eventId > lastSentEventId) {
      delivery.push(frame);
    }
  }
}
