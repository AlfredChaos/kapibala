// SSE 推送器（T-P1-02；REQ §2.1 事件流节；DES/14 §1/§3）。
// 语义：带 since → 回放账本（eventId > since，独占）再续推实时帧；不带 since → 从当前时刻开始。
// 帧 = `id: <eventId>` / `event: <type>` / `data: <JSON>`（data 内带 eventId 与 type，REQ §2.1）。
// 投递修饰（DES/14 §3「推送器按开关修饰后投递」）走 createFrameExpander seam：开关层插在
// 「水位过滤之后、socket 写出之前」——gw-3 双推（T-P1-05）、gw-4 相邻乱序（T-P2-12）共用此口。
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { framesSince, subscribeLedger } from './ledger.js';
import type { GatewayState, LedgerFrame } from './state.js';

/**
 * 投帧展开 seam：一条账本帧 → 0..n 条待写帧。每连接一个实例（可自带缓冲状态）。
 * - 恒等 `[frame]`；gw-3 `dup_push_all` → `[frame, frame]`（同 eventId 投两次，账本仍一行）
 * - gw-4 `reorder_1s`（T-P2-12）→ 首帧缓冲返回 `[]`、次帧返回 `[新, 旧]`（相邻交换）
 * 展开点在水位过滤**之后**，故延迟/乱序产出的较小 eventId 不会被 `eventId > lastSentEventId` 丢掉；
 * 水位取「已写 eventId 的单调最大值」，先写大 id 再写小 id 也不会让水位回退而放行重复帧。
 */
export type FrameExpander = (frame: LedgerFrame) => LedgerFrame[];

export interface SseOptions {
  /** 每连接调用一次（各连接的缓冲与水位互不串扰）；缺省恒等展开 */
  createFrameExpander?: () => FrameExpander;
}

/** SSE keepalive 注释行间隔（mock 内部传输选择，非契约数字；防代理空闲断连） */
const HEARTBEAT_MS = 30_000;

/** 帧线上格式（导出供纯函数测试与开关层复用） */
export function frameToWire(frame: LedgerFrame): string {
  return `id: ${frame.eventId}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

export function registerSseRoutes(app: FastifyInstance, state: GatewayState, options: SseOptions = {}): void {
  const createExpander = options.createFrameExpander ?? ((): FrameExpander => (frame) => [frame]);

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

    return handleEventsStream(request, reply, state, since, createExpander);
  });
}

async function handleEventsStream(
  request: FastifyRequest,
  reply: FastifyReply,
  state: GatewayState,
  since: number | undefined,
  createExpander: () => FrameExpander,
): Promise<void> {
  reply.hijack();
  const expand = createExpander();
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
  const writeFrame = (frame: LedgerFrame): void => {
    if (closed) {
      return;
    }
    for (const delivered of expand(frame)) {
      raw.write(frameToWire(delivered));
      if (delivered.eventId > lastSentEventId) {
        lastSentEventId = delivered.eventId;
      }
    }
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
