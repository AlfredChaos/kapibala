// @vitest-environment happy-dom
// 群详情页骨架（T-P5-04；DES/15 §2 页面 3 + §6 表、DES/04 §5、REQ §4 页面 3）。
// 断言逐字：
//   成员列表含 role（creator/admin/member 同序渲染，§5 服务端排序不重排）；
//   blocked run → 顶部横幅 role="alert" + 行 data-blocked（页面 3 逐字「醒目提示」）；
//   发送表单：空文本/超 2000 字前端先拦（TEXT_MAX_LENGTH 与 server constants 同源校验）；
//   WS agent_run → 行就地 patch + 未知 runId 重拉；group_updated → 开关就地更新；
//   viewer：开关 disabled（只读）、发送表单不渲染；PATCH 写路径 admin 走通。
// 层位：第 2 层组件测试——happy-dom + act + fakeFetch + FakeSocket 驱动 WS。
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth, type AuthState } from '../src/auth/AuthProvider.js';
import { GroupDetailPage } from '../src/pages/GroupDetailPage.js';
import { TEXT_MAX_LENGTH as WEB_MAX, validateSendText } from '../src/lib/text-limits.js';
import { TEXT_MAX_LENGTH as SERVER_MAX } from '../../server/src/constants.js';
import { getWsClient, initWsClient, resetWsClient } from '../src/ws/useWsEvent.js';
import type { WebSocketLike } from '../src/ws/WsClient.js';

declare const globalThis: { IS_REACT_ACT_ENVIRONMENT?: boolean };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---------- 假 fetch / 假 socket ----------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const GROUP_FIXTURE = {
  id: 'g-1',
  gatewayGroupId: 'gw-1',
  status: 'ready',
  creatorAccountId: 'a-1',
  agentEnabled: true,
  autoKickEnabled: false,
  members: [
    { accountId: 'a-1', platformUserId: 'pu-creator', role: 'creator' },
    { accountId: 'a-2', platformUserId: 'pu-admin', role: 'admin' },
    { accountId: 'a-3', platformUserId: 'pu-member', role: 'member' },
  ],
  activeSequenceRunId: null,
  activeAgentRunId: null,
};

const RUNS_FIXTURE = [
  {
    id: 'run-1',
    groupId: 'g-1',
    status: 'blocked',
    endReason: 'audit_blocked',
    summary: null,
    createdAt: '2026-09-28T00:00:00Z',
    endedAt: '2026-09-28T00:01:00Z',
  },
  {
    id: 'run-0',
    groupId: 'g-1',
    status: 'finished',
    endReason: null,
    summary: 'done',
    createdAt: '2026-09-27T00:00:00Z',
    endedAt: '2026-09-27T00:01:00Z',
  },
];

function installFetch(role: 'admin' | 'viewer'): {
  calls: Array<{ path: string; init: RequestInit }>;
} {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    calls.push({ path, init: init ?? {} });
    if (path === '/api/auth/login') {
      return jsonResponse(200, {
        accessToken: `t-${role}`,
        expiresAt: 'x',
        user: { id: 'u-1', username: role, role },
      });
    }
    if (path === '/api/groups/g-1' && (init?.method ?? 'GET') === 'GET') {
      return jsonResponse(200, GROUP_FIXTURE);
    }
    if (path === '/api/groups/g-1' && init?.method === 'PATCH') {
      if (role === 'viewer') {
        return jsonResponse(403, { error: { code: 'FORBIDDEN', message: 'viewer cannot write' } });
      }
      return jsonResponse(200, { ...GROUP_FIXTURE });
    }
    if (path === '/api/groups/g-1/agent-runs') return jsonResponse(200, RUNS_FIXTURE);
    if (path === '/api/groups/g-1/send' && init?.method === 'POST') {
      if (role === 'viewer') {
        return jsonResponse(403, { error: { code: 'FORBIDDEN', message: 'viewer cannot write' } });
      }
      return jsonResponse(202, { clientMsgId: 'cm-1' });
    }
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

function seedWs(): void {
  resetWsClient();
  initWsClient({
    tokens: { getAccessToken: () => 't', refreshToken: () => Promise.resolve('t') },
    wsFactory: (url: string) => new FakeSocket(url),
    url: 'ws://test/ws',
    storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
  });
}

beforeEach(() => {
  FakeSocket.instances = [];
  seedWs();
});
afterEach(() => {
  getWsClient()?.disconnect();
  resetWsClient();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

// ---------- 受控输入助手（React 18 内部 tracker：原生 setter + 事件） ----------
function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// ---------- 常量同源 + L1 ----------

describe('TEXT_MAX_LENGTH 同源（server constants === web 镜像）', () => {
  it('web 镜像与服务端常量一致', () => {
    expect(WEB_MAX).toBe(SERVER_MAX);
    expect(WEB_MAX).toBe(2000);
  });

  it('validateSendText：空/空白 → 拦截；超长 → 拦截；合法 → null', () => {
    expect(validateSendText('')).toBe('消息不能为空');
    expect(validateSendText('   ')).toBe('消息不能为空');
    expect(validateSendText('x'.repeat(2000))).toBeNull();
    expect(validateSendText('x'.repeat(2001))).toContain('2001/2000');
  });
});

// ---------- L2 页面 ----------

describe('群详情页', () => {
  let container: HTMLDivElement;
  let root: Root;
  let auth: { current: AuthState | null } = { current: null };

  async function mount(role: 'admin' | 'viewer'): Promise<void> {
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
              { initialEntries: ['/groups/g-1'] },
              createElement(
                Routes,
                null,
                createElement(Route, { path: '/groups/:id', element: createElement(GroupDetailPage) }),
              ),
            ),
          ),
        ),
      );
    });
    await act(async () => {
      await auth.current?.login(role, role);
    });
  }

  afterEach(async () => {
    if (root !== undefined) await act(async () => root.unmount());
    container?.remove();
    auth = { current: null };
  });

  it('成员含 role；开关渲染；blocked run → 顶部横幅 + 行标红', async () => {
    installFetch('admin');
    await mount('admin');
    // 成员三行含 role
    expect(container.querySelector('[data-testid="member-role-a-1"]')?.textContent).toBe('creator');
    expect(container.querySelector('[data-testid="member-role-a-2"]')?.textContent).toBe('admin');
    expect(container.querySelector('[data-testid="member-role-a-3"]')?.textContent).toBe('member');
    // 开关：admin 可写
    const agentToggle = container.querySelector<HTMLInputElement>('[data-testid="toggle-agentEnabled"]');
    const kickToggle = container.querySelector<HTMLInputElement>('[data-testid="toggle-autoKickEnabled"]');
    expect(agentToggle?.disabled).toBe(false);
    expect(agentToggle?.checked).toBe(true);
    expect(kickToggle?.checked).toBe(false);
    // blocked 横幅（页面 3 逐字：醒目提示）
    expect(container.querySelector('[data-testid="blocked-banner"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="blocked-banner"]')?.textContent).toContain('blocked');
    // run 行标红
    expect(container.querySelector('[data-testid="agent-run-run-1"]')?.getAttribute('data-blocked')).toBe('true');
    expect(container.querySelector('[data-testid="agent-run-run-0"]')?.getAttribute('data-blocked')).toBeNull();
  });

  it('发送表单：空文本/超长 → 提交禁用 + 前端先拦；合法 → POST /send 受理', async () => {
    const { calls } = installFetch('admin');
    await mount('admin');
    const textarea = container.querySelector<HTMLTextAreaElement>('#send-text');
    const submit = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === '发送',
    ) as HTMLButtonElement | undefined;
    expect(textarea).not.toBeNull();
    expect(submit).toBeDefined();

    // 空文本 → 提交禁用（前端先拦，不发请求）
    expect(submit?.disabled).toBe(true);
    // 超长 → 校验文案 + 禁用
    await act(async () => {
      if (textarea) setInputValue(textarea, 'x'.repeat(2001));
    });
    expect(submit?.disabled).toBe(true);
    expect(container.querySelector('[data-testid="send-validation"]')?.textContent).toContain(
      '2001/2000',
    );
    // 合法 → 解禁 → 提交走 POST /api/groups/g-1/send
    await act(async () => {
      if (textarea) setInputValue(textarea, 'hello group');
    });
    expect(submit?.disabled).toBe(false);
    const form = container.querySelector('form[data-testid="send-form"]');
    const beforeSends = calls.filter((c) => c.path === '/api/groups/g-1/send').length;
    await act(async () => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    const sendCalls = calls.filter((c) => c.path === '/api/groups/g-1/send');
    expect(sendCalls.length).toBe(beforeSends + 1);
    const body = JSON.parse(String(sendCalls[sendCalls.length - 1]?.init.body)) as {
      accountId: string;
      text: string;
    };
    expect(body.accountId).toBe('a-1'); // 默认选第一个成员（creator）
    expect(body.text).toBe('hello group');
    // 受理回执展示 clientMsgId
    expect(container.querySelector('[data-testid="send-accepted"]')?.textContent).toContain('cm-1');
  });

  it('WS：group_updated → 开关就地更新；agent_run → 已知行 patch + 未知 run 重拉', async () => {
    const { calls } = installFetch('admin');
    await mount('admin');
    const sock = lastSocket();
    await act(async () => {
      sock.simulateOpen();
      sock.simulateMessage({ type: 'auth', success: true });
    });
    // group_updated：关 agentEnabled、开 autoKick
    await act(async () => {
      sock.simulateMessage({
        seq: 1,
        type: 'group_updated',
        payload: { groupId: 'g-1', status: 'ready', agentEnabled: false, autoKickEnabled: true },
      });
    });
    const agentToggle = container.querySelector<HTMLInputElement>('[data-testid="toggle-agentEnabled"]');
    const kickToggle = container.querySelector<HTMLInputElement>('[data-testid="toggle-autoKickEnabled"]');
    expect(agentToggle?.checked).toBe(false);
    expect(kickToggle?.checked).toBe(true);

    // agent_run：已知 run-1 → blocked→finished 就地 patch（data-blocked 摘除、横幅消失）
    await act(async () => {
      sock.simulateMessage({
        seq: 2,
        type: 'agent_run',
        payload: { runId: 'run-1', groupId: 'g-1', status: 'finished', endReason: null },
      });
    });
    expect(container.querySelector('[data-testid="agent-run-run-1"]')?.getAttribute('data-blocked')).toBeNull();
    expect(container.querySelector('[data-testid="blocked-banner"]')).toBeNull();

    // 未知 runId（新建 run）→ 重拉 agent-runs 列表
    const beforeRunsCalls = calls.filter((c) => c.path === '/api/groups/g-1/agent-runs').length;
    await act(async () => {
      sock.simulateMessage({
        seq: 3,
        type: 'agent_run',
        payload: { runId: 'run-new', groupId: 'g-1', status: 'running', endReason: null },
      });
    });
    expect(calls.filter((c) => c.path === '/api/groups/g-1/agent-runs').length).toBe(
      beforeRunsCalls + 1,
    );
  });

  it('viewer：开关只读 disabled、发送表单不渲染；PATCH 直调 → 403', async () => {
    installFetch('viewer');
    await mount('viewer');
    const agentToggle = container.querySelector<HTMLInputElement>('[data-testid="toggle-agentEnabled"]');
    const kickToggle = container.querySelector<HTMLInputElement>('[data-testid="toggle-autoKickEnabled"]');
    expect(agentToggle?.disabled).toBe(true); // viewer 只读（开关可看不许动）
    expect(kickToggle?.disabled).toBe(true);
    expect(container.querySelector('[data-testid="send-form"]')).toBeNull();

    // 直接 PATCH → 403（服务端权威兜底）
    let caught: unknown;
    await act(async () => {
      try {
        await auth.current?.client.request('/api/groups/g-1', {
          method: 'PATCH',
          body: JSON.stringify({ agentEnabled: false }),
        });
      } catch (err) {
        caught = err;
      }
    });
    expect(caught).toBeInstanceOf(Object);
    expect((caught as { status?: number }).status).toBe(403);
  });
});
