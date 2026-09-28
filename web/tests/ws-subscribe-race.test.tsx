// @vitest-environment happy-dom
// useWsEvent 单例就绪竞态回归（审计实锤：React 被动 effect 子先于父——页面
// useWsEvent effect 跑时 AuthProvider 的 initWsClient effect 尚未执行，
// singleton === null → 订阅空转且永不重订，该页终身收不到 ws 帧。
// 线上症状：/accounts 行不更新（lastSeq 仍在推进）、/groups/:id 时间线首挂死）。
// 断言：
//   先挂订阅组件、后 initWsClient（真实装配次序）→ 帧必达（就绪即订阅）；
//   resetWsClient → initWsClient 换新单例 → 已挂组件改订新单例（测试缝不倒灌）；
//   useWsBacklogExpired（onBacklogExpired 的 React 接线）→ ws_backlog_expired 帧触发
//     兜底 handler（同一就绪竞态同样修复）。
// 层位：第 2 层组件测试——happy-dom + act + FakeSocket（同 ws-client.test.ts 工装）。
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { getWsClient, initWsClient, resetWsClient, useWsBacklogExpired, useWsEvent } from '../src/ws/useWsEvent.js';
import type { WebSocketLike } from '../src/ws/WsClient.js';
import type { WsEventFrame } from '@kapibala/contract';

declare const globalThis: { IS_REACT_ACT_ENVIRONMENT?: boolean };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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
  simulateOpen(): void {
    this.onopen?.({});
  }
  simulateMessage(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function lastSocket(): FakeSocket {
  const s = FakeSocket.instances[FakeSocket.instances.length - 1];
  if (s === undefined) throw new Error('no socket');
  return s;
}

function makeStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

function msgFrame(seq: number): WsEventFrame {
  return {
    seq,
    type: 'message',
    payload: { groupId: 'g1', msgId: `m${seq}`, isOwn: false },
  } as WsEventFrame;
}

afterEach(async () => {
  getWsClient()?.disconnect();
  resetWsClient();
  document.body.innerHTML = '';
});

describe('useWsEvent 单例就绪竞态', () => {
  it('先挂订阅组件、后 initWsClient（AuthProvider 被动 effect 次序）→ 帧必达', async () => {
    FakeSocket.instances = [];
    resetWsClient(); // 未装配期：singleton === null
    const seen: number[] = [];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    function Probe(): null {
      useWsEvent('message', (f) => seen.push(f.seq));
      return null;
    }

    // 页面先挂（singleton 仍 null——此处即竞态窗口，旧代码在此退化为永久空转）
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(Probe)));
    });

    // AuthProvider 的 effect 随后才装配单例并 connect（真实次序）
    await act(async () => {
      initWsClient({
        tokens: { getAccessToken: () => 't', refreshToken: () => Promise.resolve('t') },
        wsFactory: (url: string) => new FakeSocket(url),
        url: 'ws://test/ws',
        storage: makeStorage(),
      });
      getWsClient()?.connect();
    });
    const sock = lastSocket();
    await act(async () => {
      sock.simulateOpen();
      sock.simulateMessage({ type: 'auth', success: true });
      sock.simulateMessage(msgFrame(1));
    });
    expect(seen).toEqual([1]);

    await act(async () => root.unmount());
    container.remove();
  });

  it('resetWsClient → initWsClient 换新单例：已挂组件改订新单例', async () => {
    FakeSocket.instances = [];
    resetWsClient();
    const seen: string[] = [];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    const c1 = initWsClient({
      tokens: { getAccessToken: () => 't', refreshToken: () => Promise.resolve('t') },
      wsFactory: (url: string) => new FakeSocket(url),
      url: 'ws://test/ws',
      storage: makeStorage(),
    });

    function Probe(): null {
      useWsEvent('message', (f) => seen.push(`${f.seq}`));
      return null;
    }
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(Probe)));
    });
    c1.connect();
    const s0 = lastSocket();
    await act(async () => {
      s0.simulateOpen();
      s0.simulateMessage({ type: 'auth', success: true });
      s0.simulateMessage(msgFrame(1));
    });
    expect(seen).toEqual(['1']);

    // 测试缝：断旧、重置、装新单例——挂载中的订阅应无感迁移到新单例
    c1.disconnect();
    await act(async () => {
      resetWsClient();
      initWsClient({
        tokens: { getAccessToken: () => 't', refreshToken: () => Promise.resolve('t') },
        wsFactory: (url: string) => new FakeSocket(url),
        url: 'ws://test/ws',
        storage: makeStorage(),
      });
      getWsClient()?.connect();
    });
    const s1 = lastSocket();
    expect(s1).not.toBe(s0);
    await act(async () => {
      s1.simulateOpen();
      s1.simulateMessage({ type: 'auth', success: true });
      s1.simulateMessage(msgFrame(1)); // 新实例 lastSeq=0，seq=1 是新帧
    });
    expect(seen).toEqual(['1', '1']); // 新单例的帧确实送达已挂订阅

    await act(async () => root.unmount());
    container.remove();
  });
});

describe('useWsBacklogExpired（onBacklogExpired React 接线）', () => {
  it('先挂载、后装配单例 → ws_backlog_expired 帧触发兜底 handler', async () => {
    FakeSocket.instances = [];
    resetWsClient();
    const fired: string[] = [];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    function Probe(): null {
      useWsBacklogExpired(() => fired.push('refetch'));
      return null;
    }
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(Probe)));
    });
    await act(async () => {
      initWsClient({
        tokens: { getAccessToken: () => 't', refreshToken: () => Promise.resolve('t') },
        wsFactory: (url: string) => new FakeSocket(url),
        url: 'ws://test/ws',
        storage: makeStorage(),
      });
      getWsClient()?.connect();
    });
    const sock = lastSocket();
    await act(async () => {
      sock.simulateOpen();
      sock.simulateMessage({ type: 'auth', success: true });
      sock.simulateMessage({
        seq: 4,
        type: 'inconsistency',
        payload: { kind: 'ws_backlog_expired', ref: 'sinceSeq', message: 'backlog expired' },
      });
    });
    expect(fired).toEqual(['refetch']);

    await act(async () => root.unmount());
    container.remove();
  });
});
