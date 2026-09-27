// mock-gateway 测试共享 arrange/观测助手（T-P2-12 从 switches-basic.test.ts 提取）。
// 只含测试基建：进程内装配、`/_test` 控制平面调用、真实 TCP 的 SSE 收帧。
import { setTimeout as sleep } from 'node:timers/promises';
import { expect } from 'vitest';
import { createGatewayApp, type GatewayApp } from '../../src/app.js';
import type { LedgerFrame } from '../../src/state.js';

export type InjectResponse = { statusCode: number; json(): Promise<unknown> };

/** 线上帧（SSE wire）：id/event/data 解析值 + 原始帧块（断言「同一帧投两次」用逐字节比较） */
export interface WireFrame {
  id: number;
  event: string;
  data: Record<string, unknown>;
  wire: string;
}

/** `GET /_test/counters` 的 JSON 形状（DES/14 §4 五项） */
export interface CountersJson {
  sendCallsByAccount: Record<string, number>;
  sendCallsByClientMsgId: Record<string, number>;
  landedMessages: number;
  kickCalls: number;
  framesEmitted: number;
}

export function newApp(seedAccountIds: readonly string[] = ['acc-01', 'acc-02']): GatewayApp {
  return createGatewayApp({ seedAccountIds });
}

export async function jsonOf(res: InjectResponse): Promise<Record<string, unknown>> {
  expect(res.statusCode).toBeLessThan(300);
  return (await res.json()) as Record<string, unknown>;
}

export async function connect(app: GatewayApp, accountId: string): Promise<void> {
  expect((await app.inject({ method: 'POST', url: `/accounts/${accountId}/connect` })).statusCode).toBe(200);
}

export async function disconnect(app: GatewayApp, accountId: string): Promise<void> {
  expect((await app.inject({ method: 'POST', url: `/accounts/${accountId}/disconnect` })).statusCode).toBe(200);
}

/** 打开开关（DES/14 §4）；返回原始响应供 arrange 失败面断言 */
export async function postScenario(
  app: GatewayApp,
  switchName: string,
  params?: Record<string, unknown>,
  target?: Record<string, unknown>,
): Promise<InjectResponse> {
  return app.inject({
    method: 'POST',
    url: '/_test/scenario',
    payload: { switch: switchName, params, target },
  });
}

/** 打开开关并断言 arrange 成功（重复调用 = 覆盖参数） */
export async function scenario(
  app: GatewayApp,
  switchName: string,
  params?: Record<string, unknown>,
  target?: Record<string, unknown>,
): Promise<void> {
  expect((await postScenario(app, switchName, params, target)).statusCode).toBe(200);
}

export async function clearScenario(app: GatewayApp, switchName?: string): Promise<void> {
  const payload = switchName === undefined ? {} : { switch: switchName };
  expect((await app.inject({ method: 'POST', url: '/_test/scenario/clear', payload })).statusCode).toBe(200);
}

export async function countersOf(app: GatewayApp): Promise<CountersJson> {
  const res = await app.inject({ method: 'GET', url: '/_test/counters' });
  expect(res.statusCode).toBe(200);
  return (await res.json()) as CountersJson;
}

export async function createGroup(app: GatewayApp, creatorAccountId: string): Promise<string> {
  const body = await jsonOf(await app.inject({ method: 'POST', url: '/groups', payload: { creatorAccountId } }));
  return body['groupId'] as string;
}

export async function createInvite(app: GatewayApp, groupId: string): Promise<string> {
  const body = await jsonOf(await app.inject({ method: 'POST', url: `/groups/${groupId}/invite` }));
  return body['inviteLink'] as string;
}

export async function joinGroup(
  app: GatewayApp,
  groupId: string,
  accountId: string,
  inviteLink: string,
): Promise<InjectResponse> {
  return app.inject({
    method: 'POST',
    url: `/groups/${groupId}/join`,
    payload: { accountId, inviteLink },
  });
}

/** arrange：acc-01 建群 + acc-02 入群（member_joined 钉值后落定，+1 帧）→ groupId */
export async function makeGroupWithMember(app: GatewayApp, joinedDelayMs = 40): Promise<string> {
  await connect(app, 'acc-01');
  await connect(app, 'acc-02');
  const groupId = await createGroup(app, 'acc-01');
  await scenario(app, 'invite_not_ready', { readyAfterMs: 0 }, { groupId }); // 链接立即就绪（gw-20 钉 0）
  const inviteLink = await createInvite(app, groupId);
  await scenario(app, 'member_joined_delay', { delayMs: joinedDelayMs }, { groupId });
  expect((await joinGroup(app, groupId, 'acc-02', inviteLink)).statusCode).toBe(202);
  await sleep(joinedDelayMs + 80); // 等 member_joined 落定
  return groupId;
}

export async function send(
  app: GatewayApp,
  groupId: string,
  accountId: string,
  clientMsgId: string,
  text = 'x',
): Promise<InjectResponse> {
  return app.inject({
    method: 'POST',
    url: `/groups/${groupId}/send`,
    payload: { accountId, clientMsgId, text },
  });
}

/** GET by-client-id（REQ §2.1：200 {msgId,sentAt} 最早一条 / 404 / 503 整体不可用） */
export async function byClientId(app: GatewayApp, groupId: string, clientMsgId: string): Promise<InjectResponse> {
  return app.inject({ method: 'GET', url: `/groups/${groupId}/messages/by-client-id/${clientMsgId}` });
}

export async function membersOf(app: GatewayApp, groupId: string): Promise<string[]> {
  const res = await app.inject({ method: 'GET', url: `/groups/${groupId}/members` });
  expect(res.statusCode).toBe(200);
  return ((await res.json()) as Array<{ platformUserId: string }>).map((member) => member.platformUserId);
}

export function puidOf(app: GatewayApp, accountId: string): string {
  return app.gatewayState.accounts.get(accountId)?.platformUserId ?? '';
}

export function framesOf(app: GatewayApp, type: LedgerFrame['type']): LedgerFrame[] {
  return app.gatewayState.ledger.filter((frame) => frame.type === type);
}

/** 取该类型第 index 帧；缺失即用例失败（收窄 undefined，不用非受控断言——宪法 §3-7） */
export function frameAt(app: GatewayApp, type: LedgerFrame['type'], index = 0): LedgerFrame {
  const frame = framesOf(app, type)[index];
  if (frame === undefined) {
    throw new Error(`expected ledger frame #${index} of type ${type}`);
  }
  return frame;
}

/** 取该类型最后一帧；缺失即用例失败 */
export function lastFrame(app: GatewayApp, type: LedgerFrame['type']): LedgerFrame {
  const frame = framesOf(app, type).at(-1);
  if (frame === undefined) {
    throw new Error(`expected at least one ledger frame of type ${type}`);
  }
  return frame;
}

/** 断言恰一帧并取出（同上：收窄 undefined） */
export function singleFrame(frames: readonly LedgerFrame[], label: string): LedgerFrame {
  expect(frames, label).toHaveLength(1);
  const frame = frames[0];
  if (frame === undefined) {
    throw new Error(`expected exactly one frame: ${label}`);
  }
  return frame;
}

/** 解析一个 SSE 帧块（`id:` / `event:` / `data:` 三行）；keepalive 注释行返回 null */
export function parseWireFrame(block: string): WireFrame | null {
  const lines = block.split('\n');
  const idLine = lines.find((line) => line.startsWith('id: '));
  if (idLine === undefined) {
    return null;
  }
  const id = Number(idLine.slice('id: '.length));
  if (!Number.isFinite(id)) {
    return null;
  }
  const dataLine = lines.find((line) => line.startsWith('data: '));
  return {
    id,
    event: lines.find((line) => line.startsWith('event: '))?.slice('event: '.length) ?? '',
    data: (dataLine === undefined ? {} : JSON.parse(dataLine.slice('data: '.length))) as Record<string, unknown>,
    wire: block,
  };
}

/**
 * 在随机端口起真实 HTTP 服务并执行 fn（裸 fetch 场景：媒体下载、SSE 流、gw-10 的端点面）；
 * 负责 listen 与 close。注意：close 之后 app 不能再 inject（Fastify 已关闭）。
 */
export async function withListening<T>(app: GatewayApp, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected TCP address');
  }
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await app.close();
  }
}

/**
 * 经真实 TCP + fetch 收 SSE 帧（收满 count 即断开；listen/close 由 withListening 负责）。
 * onOpen 在连接建立后执行——实时帧必须在订阅之后产生（不带 since 时不回放历史，REQ §2.1）。
 */
export async function collectFrames(
  app: GatewayApp,
  path: string,
  count: number,
  onOpen?: () => Promise<void>,
): Promise<WireFrame[]> {
  return withListening(app, async (baseUrl): Promise<WireFrame[]> => {
    const controller = new AbortController();
    const frames: WireFrame[] = [];
    let collector: Promise<void> | undefined;
    try {
      collector = (async (): Promise<void> => {
        const res = await fetch(`${baseUrl}${path}`, { signal: controller.signal });
        const reader = res.body?.getReader();
        if (reader === undefined) {
          throw new Error('SSE response has no body');
        }
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          let at = buffer.indexOf('\n\n');
          while (at !== -1) {
            const frame = parseWireFrame(buffer.slice(0, at));
            buffer = buffer.slice(at + 2);
            at = buffer.indexOf('\n\n');
            if (frame !== null) {
              frames.push(frame);
              if (frames.length >= count) {
                controller.abort();
                return;
              }
            }
          }
        }
      })();
      await sleep(150); // 等连接建立
      await onOpen?.();
      await collector;
    } finally {
      controller.abort();
      await collector?.catch(() => undefined); // arrange 抛错时不留悬空 rejection
    }
    return frames;
  });
}
