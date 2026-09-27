// @vitest-environment happy-dom
// WS 客户端（T-P5-02；DES/15 §3 伪码 + §6 测试表、DES/08 §2、REQ B4）。
// 断言逐字：
//   L1 applyFrame(lastSeq, frame)：seq <= lastSeq 旧帧丢弃、新帧 lastSeq 单调推进；
//   L1 nextBackoff(attempt)：500 起 ×2 序列 500/1000/2000/4000/5000 封顶 5s；
//   L2：open 即发 {type:'auth', accessToken, sinceSeq:lastSeq}；auth:true → authed；
//   L2：close → 退避重连，重连帧仍带 sinceSeq=lastSeq（补发恢复）；
//   L2：auth:false（token 过期）→ §4 refreshToken 单飞 → 成功后重连（不叠加退避）；
//   L2：补发与实时交叠不重复（同 seq 帧只分发一次，B4「不重复」）；
//   L2：lastSeq 持久化 sessionStorage（新实例沿用旧水位）+ disconnect 后不重连；
//   L2：inconsistency{kind:'ws_backlog_expired'} → onBacklogExpired 收口（全量 refetch 挂钩）。
// 缝位：wsFactory/storage/退避参数/token 源全注入——层 2 无真实 socket、无墙钟退避。
import { describe, expect, it, vi } from 'vitest';
import type { WsEventFrame } from '@kapibala/contract';
import {
  applyFrame,
  createWsClient,
  nextBackoff,
  WS_RECONNECT_MAX_MS,
  WS_RECONNECT_START_MS,
  type WebSocketLike,
  type WsClientDeps,
} from '../src/ws/WsClient.js';
import { initWsClient, getWsClient, useWsEvent } from '../src/ws/useWsEvent.js';
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

declare const globalThis: { IS_REACT_ACT_ENVIRONMENT?: boolean };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---------- 假 WebSocket ----------

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  constructor(public readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({ code: 1000 });
  }
  // 测试驱动面
  simulateOpen(): void {
    this.onopen?.({});
  }
  simulateMessage(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  simulateAuthOk(): void {
    this.simulateMessage({ type: 'auth', success: true });
  }
  simulateAuthFail(): void {
    this.simulateMessage({ type: 'auth', success: false });
  }
  simulateDrop(): void {
    this.onclose?.({ code: 1006 });
  }
}

function socketAt(i: number): FakeSocket {
  const s = FakeSocket.instances[i];
  if (s === undefined) throw new Error(`no socket instance ${i}`);
  return s;
}

function lastAuthFrame(sock: FakeSocket): { type: string; accessToken: string; sinceSeq?: number } {
  const raw = sock.sent[sock.sent.length - 1];
  return JSON.parse(raw ?? '{}') as { type: string; accessToken: string; sinceSeq?: number };
}

function msgFrame(seq: number): WsEventFrame {
  return {
    seq,
    type: 'message',
    payload: { groupId: 'g1', msgId: `m${seq}`, isOwn: false },
  } as WsEventFrame;
}

function makeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
  } as Storage;
}

function makeClient(overrides: Partial<WsClientDeps> = {}) {
  const token = { current: 't-1' };
  const refreshCalls: number[] = [];
  const deps: WsClientDeps = {
    tokens: {
      getAccessToken: () => token.current,
      refreshToken: () => {
        refreshCalls.push(1);
        token.current = 't-2';
        return Promise.resolve('t-2');
      },
    },
    wsFactory: (url: string) => new FakeSocket(url),
    url: 'ws://test/ws',
    storage: makeStorage(),
    backoffStartMs: 2, // 测试缝：毫秒级退避，真实契约数字由 nextBackoff L1 断言
    backoffMaxMs: 8,
    ...overrides,
  };
  return { client: createWsClient(deps), token, refreshCalls, deps };
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 15));
}

describe('L1 纯函数（DES/15 §6 表）', () => {
  it('applyFrame：seq <= lastSeq 旧帧丢弃、新帧单调推进', () => {
    const stale = applyFrame(10, msgFrame(9));
    expect(stale.accepted).toBe(false);
    expect(stale.lastSeq).toBe(10);

    const same = applyFrame(10, msgFrame(10));
    expect(same.accepted).toBe(false);
    expect(same.lastSeq).toBe(10);

    const fresh = applyFrame(10, msgFrame(11));
    expect(fresh.accepted).toBe(true);
    expect(fresh.lastSeq).toBe(11);

    // 跳号也推进（seq 是服务端 BIGSERIAL 水位，不是连续前缀语义）
    const jump = applyFrame(10, msgFrame(99));
    expect(jump.accepted).toBe(true);
    expect(jump.lastSeq).toBe(99);
  });

  it('nextBackoff：500 起 ×2，序列 500/1000/2000/4000/5000 封顶', () => {
    const seq = [0, 1, 2, 3, 4, 5, 10].map((a) => nextBackoff(a));
    expect(seq).toEqual([500, 1000, 2000, 4000, 5000, 5000, 5000]);
    expect(WS_RECONNECT_START_MS).toBe(500);
    expect(WS_RECONNECT_MAX_MS).toBe(5000);
  });
});

describe('L2 连接生命周期（fake socket，零墙钟退避=2ms）', () => {
  it('open 即发 auth 帧（accessToken + sinceSeq:lastSeq），auth:true → authed', async () => {
    FakeSocket.instances = [];
    const { client } = makeClient();
    client.connect();
    socketAt(0).simulateOpen();
    expect(lastAuthFrame(socketAt(0))).toEqual({ type: 'auth', accessToken: 't-1', sinceSeq: 0 });
    socketAt(0).simulateAuthOk();
    expect(client.authed).toBe(true);
    client.disconnect();
  });

  it('close → 退避重连；重连 auth 帧带 sinceSeq=lastSeq（断线恢复补发）', async () => {
    FakeSocket.instances = [];
    const { client } = makeClient();
    client.connect();
    const s0 = socketAt(0);
    s0.simulateOpen();
    s0.simulateAuthOk();
    s0.simulateMessage(msgFrame(5)); // 实时消费到 seq=5
    expect(client.lastSeq).toBe(5);

    s0.simulateDrop();
    expect(client.authed).toBe(false);
    await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(2));
    const s1 = socketAt(1);
    s1.simulateOpen();
    expect(lastAuthFrame(s1)).toEqual({ type: 'auth', accessToken: 't-1', sinceSeq: 5 });
    client.disconnect();
  });

  it('auth:false（token 过期）→ §4 refresh 一次 → 成功后重连带新 token', async () => {
    FakeSocket.instances = [];
    const { client, refreshCalls } = makeClient();
    client.connect();
    const s0 = socketAt(0);
    s0.simulateOpen();
    s0.simulateAuthFail(); // token 过期
    await vi.waitFor(() => expect(refreshCalls.length).toBe(1));
    await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(2));
    const s1 = socketAt(1);
    s1.simulateOpen();
    // 刷新后重连：auth 帧用轮换后的 token
    expect(lastAuthFrame(s1).accessToken).toBe('t-2');
    client.disconnect();
  });

  it('补发与实时交叠不重复：同 seq 帧只分发一次（B4「不重复」）', async () => {
    FakeSocket.instances = [];
    const { client } = makeClient();
    const seen: number[] = [];
    client.subscribe('message', (f) => {
      seen.push(f.seq);
    });
    client.connect();
    const s0 = socketAt(0);
    s0.simulateOpen();
    s0.simulateAuthOk();
    // 模拟补发窗口：sinceSeq 之前的服务端事件被服务端补发 + 实时新帧交叠同 seq
    for (const f of [msgFrame(1), msgFrame(2), msgFrame(2), msgFrame(1), msgFrame(3)]) {
      s0.simulateMessage(f);
    }
    expect(seen).toEqual([1, 2, 3]); // 重复 seq 全部丢弃
    expect(client.lastSeq).toBe(3);
    client.disconnect();
  });

  it('lastSeq 持久化 storage：新实例（页面刷新语义）沿用旧水位发 sinceSeq', async () => {
    const storage = makeStorage();
    FakeSocket.instances = [];
    const c1 = makeClient({ storage });
    c1.client.connect();
    const s0 = socketAt(0);
    s0.simulateOpen();
    s0.simulateAuthOk();
    s0.simulateMessage(msgFrame(7));
    c1.client.disconnect();

    FakeSocket.instances = [];
    const c2 = makeClient({ storage }); // 同一 storage = 刷新后新实例
    c2.client.connect();
    const s1 = socketAt(0);
    s1.simulateOpen();
    expect(lastAuthFrame(s1).sinceSeq).toBe(7); // 刷新不漏：旧 seq 补发
    c2.client.disconnect();
  });

  it('disconnect 后 close 不重连、不消费', async () => {
    FakeSocket.instances = [];
    const { client } = makeClient();
    client.connect();
    const s0 = socketAt(0);
    s0.simulateOpen();
    s0.simulateAuthOk();
    client.disconnect();
    await flush();
    expect(FakeSocket.instances.length).toBe(1); // 无重连
    s0.simulateMessage(msgFrame(1)); // 已断开后残余帧不推进水位
    expect(client.lastSeq).toBe(0);
  });

  it('ws_backlog_expired → onBacklogExpired 收口（页面级兜底 refetch 挂钩）', async () => {
    FakeSocket.instances = [];
    const { client } = makeClient();
    const fired: string[] = [];
    client.onBacklogExpired(() => fired.push('x'));
    client.connect();
    const s0 = socketAt(0);
    s0.simulateOpen();
    s0.simulateAuthOk();
    s0.simulateMessage({
      seq: 4,
      type: 'inconsistency',
      payload: { kind: 'ws_backlog_expired', ref: 'sinceSeq', message: 'backlog expired' },
    });
    expect(fired.length).toBe(1);
    client.disconnect();
  });
});

describe('useWsEvent 订阅钩子', () => {
  it('挂载订阅、卸载退订；handler 引用更新不重订', async () => {
    FakeSocket.instances = [];
    const storage = makeStorage();
    const client = initWsClient({
      tokens: { getAccessToken: () => 't', refreshToken: () => Promise.resolve('t') },
      wsFactory: (url: string) => new FakeSocket(url),
      url: 'ws://test/ws',
      storage,
    });
    expect(getWsClient()).toBe(client);
    client.connect();
    const s0 = socketAt(0);
    s0.simulateOpen();
    s0.simulateAuthOk();

    const seen: number[] = [];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    function Probe(): null {
      useWsEvent('message', (f) => seen.push(f.seq));
      return null;
    }
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(Probe)));
    });
    s0.simulateMessage(msgFrame(1));
    expect(seen).toEqual([1]);

    // handler 换引用（re-render）不产生重订——同帧不重复进
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(Probe)));
    });
    s0.simulateMessage(msgFrame(2));
    expect(seen).toEqual([1, 2]);

    await act(async () => {
      root.unmount();
    });
    s0.simulateMessage(msgFrame(3));
    expect(seen).toEqual([1, 2]); // 卸载后不再收
    container.remove();
    client.disconnect();
  });
});
