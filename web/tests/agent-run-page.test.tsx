// @vitest-environment happy-dom
// Agent run 详情页（T-P6-06；DES/15 §2 页面 4、REQ §4 页面 4、B4-2）。
// 断言逐字：
//   steps 行：kind / name / input / resultSummary / isError / errorCode / auditVerdict /
//     rawResponse(<details> 折叠)；
//   协议错误步：errorCode 展示 + toolUseId/name/input=null 的呈现（「null」字面量渲染）；
//   blocked/failed → 顶部醒目 banner + endReason 徽标；
//   WS agent_run(runId 匹配) 终态 → 重拉详情拿全量 steps；running 帧只更新 status 不重拉；
//   run 行从 AgentRunList 链接到 /agent-runs/:id（页面 3 最近 run 列表入口）。
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth, type AuthState } from '../src/auth/AuthProvider.js';
import { AgentRunPage } from '../src/pages/AgentRunPage.js';
import { getWsClient, initWsClient, resetWsClient } from '../src/ws/useWsEvent.js';
import type { WebSocketLike } from '../src/ws/WsClient.js';
import type { AgentRunDetailView } from '../src/lib/api-types.js';

declare const globalThis: { IS_REACT_ACT_ENVIRONMENT?: boolean };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---------- fixtures / fakes ----------

const RUN_DETAIL: AgentRunDetailView = {
  id: 'run-1',
  groupId: 'g-1',
  status: 'blocked',
  endReason: 'audit_blocked',
  summary: null,
  createdAt: '2026-09-28T00:00:00Z',
  endedAt: '2026-09-28T00:01:00Z',
  steps: [
    {
      seq: 1,
      kind: 'tool_use',
      toolUseId: 'tu-1',
      name: 'send_message',
      input: { text: 'hi' },
      resultSummary: 'sent',
      isError: false,
      errorCode: null,
      auditVerdict: 'pass',
      rawResponse: '{"ok":true}',
    },
    {
      seq: 2,
      kind: 'protocol_error',
      toolUseId: null,
      name: null,
      input: null,
      resultSummary: null,
      isError: true,
      errorCode: 'BAD_JSON',
      auditVerdict: null,
      rawResponse: '<not-json garbage>',
    },
    {
      seq: 3,
      kind: 'final',
      toolUseId: null,
      name: null,
      input: null,
      resultSummary: 'audit blocked the run',
      isError: false,
      errorCode: null,
      auditVerdict: 'fail',
      rawResponse: null,
    },
  ],
};

const RUN_DETAIL_FINISHED: AgentRunDetailView = {
  ...RUN_DETAIL,
  status: 'finished',
  endReason: 'final',
  summary: 'all done',
  steps: [
    ...RUN_DETAIL.steps,
    {
      seq: 4,
      kind: 'tool_use',
      toolUseId: 'tu-4',
      name: 'finish',
      input: { summary: 'all done' },
      resultSummary: 'ok',
      isError: false,
      errorCode: null,
      auditVerdict: 'pass',
      rawResponse: null,
    },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetch(detail: AgentRunDetailView): {
  calls: Array<{ path: string; init: RequestInit }>;
} {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    calls.push({ path, init: init ?? {} });
    if (path === '/api/auth/login') {
      return jsonResponse(200, {
        accessToken: 't-admin',
        expiresAt: 'x',
        user: { id: 'u-1', username: 'admin', role: 'admin' },
      });
    }
    if (path === '/api/agent-runs/run-1') return jsonResponse(200, detail);
    return jsonResponse(404, {});
  }) as typeof fetch;
  vi.stubGlobal('fetch', fn);
  return { calls };
}

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  constructor(public readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(): void {}
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

beforeEach(() => {
  FakeSocket.instances = [];
  resetWsClient();
  initWsClient({
    tokens: { getAccessToken: () => 't', refreshToken: () => Promise.resolve('t') },
    wsFactory: (url: string) => new FakeSocket(url),
    url: 'ws://test/ws',
    storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
  });
});
afterEach(() => {
  getWsClient()?.disconnect();
  resetWsClient();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

// ---------- L2 页面 ----------

describe('agent run 详情页', () => {
  let container: HTMLDivElement;
  let root: Root;
  let auth: { current: AuthState | null } = { current: null };

  async function mount(detail: AgentRunDetailView = RUN_DETAIL): Promise<void> {
    installFetch(detail);
    container = document.createElement('div');
    document.body.appendChild(container);
    function Grab(): null {
      auth.current = useAuth();
      return null;
    }
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(
            AuthProvider,
            null,
            createElement(Grab),
            createElement(
              MemoryRouter,
              { initialEntries: ['/agent-runs/run-1'] },
              createElement(
                Routes,
                null,
                createElement(Route, {
                  path: '/agent-runs/:id',
                  element: createElement(AgentRunPage),
                }),
              ),
            ),
          ),
        ),
      );
    });
    await act(async () => {
      await auth.current?.login('admin', 'admin');
    });
    getWsClient()?.connect();
  }

  afterEach(async () => {
    if (root !== undefined) await act(async () => root.unmount());
    container?.remove();
    auth = { current: null };
  });

  it('steps 全字段渲染：kind/name/input/resultSummary/auditVerdict/rawResponse 折叠', async () => {
    await mount();
    // tool_use 行
    expect(container.querySelector('[data-testid="step-kind-1"]')?.textContent).toBe('tool_use');
    expect(container.querySelector('[data-testid="step-1"]')?.textContent).toContain('send_message');
    expect(container.querySelector('[data-testid="step-1"]')?.textContent).toContain('{"text":"hi"}');
    expect(container.querySelector('[data-testid="step-1"]')?.textContent).toContain('sent');
    expect(container.querySelector('[data-testid="step-audit-1"]')?.textContent).toBe('audit:pass');
    // rawResponse 折叠存在且内容可展开
    const det = container.querySelector('[data-testid="step-raw-1"]');
    expect(det?.tagName.toLowerCase()).toBe('details');
    expect(det?.textContent).toContain('{"ok":true}');
    // final 行
    expect(container.querySelector('[data-testid="step-kind-3"]')?.textContent).toBe('final');
    expect(container.querySelector('[data-testid="step-3"]')?.textContent).toContain(
      'audit blocked the run',
    );
    expect(container.querySelector('[data-testid="step-audit-3"]')?.textContent).toBe('audit:fail');
  });

  it('协议错误步：errorCode 展示 + null 字段呈现 + rawResponse 可看', async () => {
    await mount();
    const step2 = container.querySelector('[data-testid="step-2"]');
    expect(step2?.getAttribute('data-kind')).toBe('protocol_error');
    expect(step2?.getAttribute('data-error')).toBe('true');
    // errorCode 醒目展示（页面 4 逐字）
    expect(container.querySelector('[data-testid="step-errorcode-2"]')?.textContent).toBe('BAD_JSON');
    // toolUseId/name/input = null 的呈现（null 字面量渲染，页面 4 逐字「为 null 的呈现」）
    expect(step2?.textContent).toContain('toolUseId=null');
    expect(step2?.textContent).toContain('input=—');
    expect(step2?.querySelector('[data-testid^="step-audit-"]')).toBeNull(); // auditVerdict null 不渲染
    // 原始响应体折叠可查看
    const raw = container.querySelector('[data-testid="step-raw-2"]');
    expect(raw?.tagName.toLowerCase()).toBe('details');
    expect(raw?.textContent).toContain('<not-json garbage>');
  });

  it('blocked run → 顶部醒目 banner + endReason 徽标', async () => {
    await mount();
    const banner = container.querySelector('[data-testid="run-prominent"]');
    expect(banner?.getAttribute('role')).toBe('alert');
    expect(banner?.textContent).toContain('blocked');
    expect(banner?.textContent).toContain('audit_blocked');
    expect(container.querySelector('[data-testid="run-endreason"]')?.textContent).toBe(
      'audit_blocked',
    );
    expect(container.querySelector('[data-testid="run-status"]')?.textContent).toBe('blocked');
  });

  it('WS agent_run 终态 → 重拉详情拿全量 steps；running 帧不重拉', async () => {
    // fetch 桩：login + run 详情按调用序号返回（首拉 running，终态重拉拿 finished 全量）
    // 响应体由可变变量控制（StrictMode 双 effect 会多拉一次——不能用调用序号切响应）
    let currentDetail: AgentRunDetailView = {
      ...RUN_DETAIL,
      status: 'running',
      endReason: null,
      steps: RUN_DETAIL.steps.slice(0, 2),
    };
    let detailCalls = 0;
    const fn = (async (input: RequestInfo | URL) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
      if (path === '/api/auth/login') {
        return jsonResponse(200, {
          accessToken: 't',
          expiresAt: 'x',
          user: { id: 'u', username: 'admin', role: 'admin' },
        });
      }
      if (path === '/api/agent-runs/run-1') {
        detailCalls += 1;
        return jsonResponse(200, currentDetail);
      }
      return jsonResponse(404, {});
    }) as typeof fetch;
    vi.stubGlobal('fetch', fn);

    container = document.createElement('div');
    document.body.appendChild(container);
    function Grab(): null {
      auth.current = useAuth();
      return null;
    }
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(
            AuthProvider,
            null,
            createElement(Grab),
            createElement(
              MemoryRouter,
              { initialEntries: ['/agent-runs/run-1'] },
              createElement(
                Routes,
                null,
                createElement(Route, {
                  path: '/agent-runs/:id',
                  element: createElement(AgentRunPage),
                }),
              ),
            ),
          ),
        ),
      );
    });
    await act(async () => {
      await auth.current?.login('admin', 'admin');
    });
    getWsClient()?.connect();
    // 首拉 running（2 步）——StrictMode 双 effect 可能多拉一次，断言用差值
    const baseCalls = detailCalls;
    expect(container.querySelector('[data-testid="run-status"]')?.textContent).toBe('running');
    const sock = lastSocket();
    await act(async () => {
      sock.simulateOpen();
      sock.simulateMessage({ type: 'auth', success: true });
    });
    // 终态重拉会拿到 finished 全量 steps
    currentDetail = RUN_DETAIL_FINISHED;
    // running 帧：只更新 status，不重拉
    await act(async () => {
      sock.simulateMessage({
        seq: 10,
        type: 'agent_run',
        payload: { runId: 'run-1', groupId: 'g-1', status: 'running', endReason: null },
      });
    });
    expect(detailCalls).toBe(baseCalls);
    // 终态帧：重拉详情 → finished + 第 4 步出现
    await act(async () => {
      sock.simulateMessage({
        seq: 11,
        type: 'agent_run',
        payload: { runId: 'run-1', groupId: 'g-1', status: 'finished', endReason: 'final' },
      });
    });
    expect(detailCalls).toBe(baseCalls + 1);
    expect(container.querySelector('[data-testid="run-status"]')?.textContent).toBe('finished');
    expect(container.querySelector('[data-testid="step-kind-4"]')?.textContent).toBe('tool_use');
    // 其他 run 的终态帧不触发本页重拉
    await act(async () => {
      sock.simulateMessage({
        seq: 12,
        type: 'agent_run',
        payload: { runId: 'run-other', groupId: 'g-1', status: 'finished', endReason: 'final' },
      });
    });
    expect(detailCalls).toBe(baseCalls + 1);
  });

  it('AgentRunList 行链接到 /agent-runs/:id（页面 3 入口）', async () => {
    // 直接验证组件层：AgentRunList 行含 Link → href
    const { AgentRunList } = await import('../src/components/AgentRunList.js');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          MemoryRouter,
          null,
          createElement(AgentRunList, {
            runs: [
              {
                id: 'run-1',
                groupId: 'g-1',
                status: 'blocked',
                endReason: 'audit_blocked',
                summary: null,
                createdAt: 't',
                endedAt: null,
              },
            ],
          }),
        ),
      );
    });
    const link = container.querySelector('a[href="/agent-runs/run-1"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe('run-1');
  });
});
