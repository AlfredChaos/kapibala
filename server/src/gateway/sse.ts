// SSE 消费原语（T-P2-01；REQ §2.1 事件流、DES/01 §6.5）。
// 只负责「一条连接上的帧解析」：fetch GET /events(?since=) → 增量解析 id/event/data 帧；
// 重连退避、游标推进、事件分发归 T-P2-03 的消费循环——client 不做业务决策。
// 解析容错（DES/14 §3 投送模型）：CRLF/裸 LF、注释行（:）、跨 chunk 半行重组、
// 坏 JSON data（交付 data=null + rawData 原文，不断流）。
import { codeFromStatus, GatewayError } from './errors.js';

export interface SseFrame {
  /** `id:` 行的 eventId；缺失为 null（心跳/无 id 帧） */
  eventId: number | null;
  /** `event:` 行的事件类型；缺失为 null */
  event: string | null;
  /** data 行 JSON.parse 结果；解析失败为 null（rawData 保留原文） */
  data: unknown;
  rawData: string;
}

export interface SubscribeEventsOptions {
  /** 外部取消（消费循环重连前必须先 abort 旧连接） */
  signal?: AbortSignal;
  onFrame: (frame: SseFrame) => void;
}

export type SubscribeResult = 'ended' | 'aborted';

/**
 * 消费一条 SSE 连接直到流结束 / 外部 abort。
 * - 正常收流结束 → resolve 'ended'（重连由调用方决定）；
 * - signal abort → resolve 'aborted'；
 * - 非 2xx 响应或网络失败 → reject GatewayError（调用方走退避重连）。
 */
export async function subscribeEvents(
  baseUrl: string,
  since: number | undefined,
  options: SubscribeEventsOptions,
): Promise<SubscribeResult> {
  const url = since === undefined ? '/events' : `/events?since=${since}`;
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}${url}`, {
      headers: { accept: 'text/event-stream' },
      signal: options.signal,
    });
  } catch (err) {
    if (options.signal?.aborted) return 'aborted';
    throw new GatewayError({
      endpoint: 'events',
      status: 0,
      code: 'INTERNAL',
      message: `gateway events stream failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (!response.ok) {
    throw new GatewayError({ endpoint: 'events', status: response.status, code: codeFromStatus(response.status) });
  }
  if (response.body === null) {
    throw new GatewayError({ endpoint: 'events', status: response.status, code: 'INVALID_RESPONSE', message: 'events stream has no body' });
  }

  const decoder = new TextDecoder();
  let buffer = '';
  const deliverFrame = (raw: string): void => {
    const frame = parseFrame(raw);
    if (frame !== null) options.onFrame(frame);
  };
  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(typeof chunk === 'string' ? Buffer.from(chunk) : chunk, { stream: true });
      // 帧边界 = 空行（兼容 \r\n\r\n 与 \n\n）
      let boundary = findFrameBoundary(buffer);
      while (boundary !== -1) {
        const rawFrame = buffer.slice(0, boundary.end);
        buffer = buffer.slice(boundary.next);
        deliverFrame(rawFrame);
        boundary = findFrameBoundary(buffer);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') deliverFrame(buffer); // 流结束但残留半帧：按最后一帧尽力交付
    return 'ended';
  } catch (err) {
    if (options.signal?.aborted) return 'aborted';
    throw new GatewayError({
      endpoint: 'events',
      status: 0,
      code: 'INTERNAL',
      message: `gateway events stream read failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

interface Boundary {
  end: number;
  next: number;
}

function findFrameBoundary(buffer: string): Boundary | -1 {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return -1;
  if (crlf === -1 || (lf !== -1 && lf < crlf)) return { end: lf, next: lf + 2 };
  return { end: crlf, next: crlf + 4 };
}

/** 单帧解析；全空/仅注释帧返回 null（不投递） */
function parseFrame(raw: string): SseFrame | null {
  let eventId: number | null = null;
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue; // 空行（边界残留）与注释行
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1); // 冒号后单个可选空格（SSE 规范）
    if (field === 'id') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && value.trim() !== '') eventId = parsed;
    } else if (field === 'event') {
      event = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
    // retry:/其他字段忽略（client 不做重连决策）
  }
  if (eventId === null && event === null && dataLines.length === 0) return null;
  const rawData = dataLines.join('\n');
  let data: unknown = null;
  if (rawData !== '') {
    try {
      data = JSON.parse(rawData) as unknown;
    } catch {
      data = null; // 坏 JSON：保留 rawData 交付，不中断流
    }
  }
  return { eventId, event, data, rawData };
}
