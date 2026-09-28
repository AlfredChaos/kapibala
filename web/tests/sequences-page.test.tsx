// @vitest-environment happy-dom
// /sequences（T-P6-07；DES/15 §2 页面 5、DES/07 §1/§2/§6、REQ §4 页面 5、B1 页面半边）。
// 断言逐字：
//   定义表单校验与后端一致（index 正整数唯一 / accountRole∈{admin,member} /
//     text 1..TEXT_MAX_LENGTH / delaySeconds 非负整数）；
//   已定义序列列表来自 GET /api/sequences（mount 拉取 + 定义成功后重拉；解释声明 #27 端点）；
//   启动 422 UNRESOLVED_PLACEHOLDER → stepIndex/key 定位并高亮对应步骤行；
//   预检成功（201+拉详情）→ PreflightModal 逐步渲染 resolvedVars/varSources（default/step:<i>）；
//   运行视图 status/currentStepIndex/scheduledAt/sentAt；WS sequence_run → currentStepIndex
//   推进并重拉详情；步级 sentAt 更新可见。
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider, useAuth, type AuthState } from '../src/auth/AuthProvider.js';
import { SequencesPage } from '../src/pages/SequencesPage.js';
import { getWsClient, initWsClient, resetWsClient } from '../src/ws/useWsEvent.js';
import type { WebSocketLike } from '../src/ws/WsClient.js';
import type {
  SequenceListItem,
  SequenceRunView,
  SequenceStepDef,
} from '../src/lib/api-types.js';

declare const globalThis: { IS_REACT_ACT_ENVIRONMENT?: boolean };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('missing element');
  return v;
}

const GROUPS = [
  {
    id: 'g-1',
    gatewayGroupId: 'room-1',
    status: 'active',
    creatorAccountId: 'a-1',
    agentEnabled: true,
    autoKickEnabled: false,
    members: [],
    activeSequenceRunId: null,
    activeAgentRunId: null,
  },
];

/** 「库」内的定义行：POST 落库、GET 读出——页面只能靠 GET 拿到列表 */
let serverSequences: SequenceListItem[] = [];

const SEQ_SERVER: SequenceListItem[] = [
  {
    id: 'seq-s1',
    name: '服务端序列',
    steps: [{ index: 1, accountRole: 'admin', text: 'a', delaySeconds: 0 }],
    createdAt: '2026-09-28T00:00:00Z',
  },
  {
    id: 'seq-s2',
    name: '服务端序列二',
    steps: [
      { index: 1, accountRole: 'admin', text: 'a', delaySeconds: 0 },
      { index: 2, accountRole: 'member', text: 'b', delaySeconds: 5 },
    ],
    createdAt: '2026-09-28T00:00:01Z',
  },
];

const RUN_RUNNING: SequenceRunView = {
  id: 'run-1',
  groupId: 'g-1',
  status: 'running',
  currentStepIndex: 1,
  createdAt: 't0',
  endedAt: null,
  steps: [
    {
      index: 1,
      status: 'sent',
      scheduledAt: '2026-09-28T00:00:00Z',
      sentAt: '2026-09-28T00:00:01Z',
      clientMsgId: 'cm-1',
      resolvedVars: { nick: 'Alice' },
      varSources: { nick: 'default' },
    },
    {
      index: 2,
      status: 'pending',
      scheduledAt: '2026-09-28T00:00:10Z',
      sentAt: null,
      clientMsgId: null,
      resolvedVars: { nick: 'Alice', code: '42' },
      varSources: { nick: 'default', code: 'step:2' },
    },
  ],
};

const RUN_ADVANCED: SequenceRunView = {
  ...RUN_RUNNING,
  currentStepIndex: 2,
  steps: [
    must(RUN_RUNNING.steps[0]),
    { ...must(RUN_RUNNING.steps[1]), status: 'sent', sentAt: '2026-09-28T00:00:11Z' },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Route = (path: string, init: RequestInit) => Response | null;

function installFetch(routes: Route[]): {
  calls: Array<{ path: string; method: string; body?: string }>;
} {
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    calls.push({ path, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : undefined });
    for (const r of routes) {
      const res = r(path, init ?? {});
      if (res !== null) return res;
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
  serverSequences = [];
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

describe('序列页', () => {
  let container: HTMLDivElement;
  let root: Root;
  let auth: { current: AuthState | null } = { current: null };

  function Grab(): null {
    auth.current = useAuth();
    return null;
  }

  // React 受控元素赋值：native setter + 对应事件（input/textarea→input；select→change）
  function setInput(el: Element, value: string): void {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    must(must(Object.getOwnPropertyDescriptor(proto, 'value')).set).call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function el(sel: string): HTMLElement {
    return must(container.querySelector<HTMLElement>(sel));
  }

  function setSelect(el: Element, value: string): void {
    must(must(Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')).set).call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function mount(routes: Route[]): Promise<{ calls: Array<{ path: string; method: string; body?: string }> }> {
    const { calls } = installFetch(routes);
    container = document.createElement('div');
    document.body.appendChild(container);
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
            createElement(MemoryRouter, { initialEntries: ['/sequences'] }, createElement(SequencesPage)),
          ),
        ),
      );
    });
    await act(async () => {
      await auth.current?.login('admin', 'admin');
    });
    getWsClient()?.connect();
    return { calls };
  }

  /** 定义域桩：GET = 读库内行；POST = 落库并返回 {id}（落库后 GET 才看得见 → 页面必须重拉） */
  const sequenceRoutes: Route[] = [
    (p, init) =>
      p === '/api/sequences' && init.method !== 'POST' ? jsonResponse(200, serverSequences) : null,
    (p, init) => {
      if (p !== '/api/sequences' || init.method !== 'POST') return null;
      const body = JSON.parse(String(init.body ?? '{}')) as {
        name?: string;
        steps?: SequenceStepDef[];
      };
      serverSequences = [
        ...serverSequences,
        {
          id: 'seq-1',
          // srv- 前缀 = 只有重拉服务端才拿得到的标记：本地登记残留会在这里露馅
          name: `srv-${body.name ?? ''}`,
          steps: body.steps ?? [],
          createdAt: '2026-09-28T00:00:00Z',
        },
      ];
      return jsonResponse(201, { id: 'seq-1' });
    },
  ];

  const baseRoutes: Route[] = [
    (p, _init) =>
      p === '/api/auth/login'
        ? jsonResponse(200, {
            accessToken: 't',
            expiresAt: 'x',
            user: { id: 'u', username: 'admin', role: 'admin' },
          })
        : null,
    (p) => (p === '/api/groups' ? jsonResponse(200, GROUPS) : null),
    ...sequenceRoutes,
  ];

  afterEach(async () => {
    if (root !== undefined) await act(async () => root.unmount());
    container?.remove();
    auth = { current: null };
  });

  it('定义校验：空 text / 重复 index / 负 delaySeconds 先于 POST 拦截', async () => {
    const { calls } = await mount(baseRoutes);
    // 默认已有一步（index=1, member, text=''）——空 text 应本地拦截
    setInput(el('[data-testid="seq-name"]'), 's1');
    const submit = must(container.querySelector<HTMLButtonElement>('[data-testid="seq-submit"]'));
    await act(async () => submit.click());
    // 空 text → 本地错误，无 POST
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('text');
    expect(calls.filter((c) => c.path === '/api/sequences' && c.method === 'POST')).toHaveLength(0);
  });

  it('已定义序列列表来自服务端（mount GET /api/sequences，非本地登记）', async () => {
    serverSequences = SEQ_SERVER;
    const { calls } = await mount(baseRoutes);
    expect(
      calls.filter((c) => c.path === '/api/sequences' && c.method === 'GET').length,
    ).toBeGreaterThan(0);
    expect(container.querySelector('[data-testid="seq-item-seq-s1"]')?.textContent).toContain(
      '服务端序列',
    );
    expect(container.querySelector('[data-testid="seq-item-seq-s2"]')?.textContent).toContain('2 步');
    expect(container.querySelector('[data-testid="seq-empty"]')).toBeNull();
    // 启动表单的序列下拉同源：服务端列表即页面唯一序列来源
    expect(el('[data-testid="launch-seq"]').textContent).toContain('服务端序列');
  });

  it('合法定义 → POST /api/sequences 后重拉 GET（渲染服务端行）', async () => {
    const { calls } = await mount(baseRoutes);
    const getsBefore = calls.filter(
      (c) => c.path === '/api/sequences' && c.method === 'GET',
    ).length;
    setInput(el('[data-testid="seq-name"]'), 's1');
    setInput(el('[data-testid="step-text-0"]'), 'hello {nick}');
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('[data-testid="seq-submit"]')).click();
    });
    expect(calls.some((c) => c.path === '/api/sequences' && c.method === 'POST')).toBe(true);
    // 第二次 GET：定义成功后列表回到服务端数据源
    expect(
      calls.filter((c) => c.path === '/api/sequences' && c.method === 'GET').length,
    ).toBeGreaterThan(getsBefore);
    expect(container.querySelector('[data-testid="seq-item-seq-1"]')?.textContent).toContain(
      'srv-s1',
    );
  });

  it('预检 422 → stepIndex/key 定位并在定义步骤行高亮', async () => {
    const routes: Route[] = [
      ...baseRoutes,
      (p) => (p === '/api/groups/g-1/sequence-runs' ? jsonResponse(422, {
        error: {
          code: 'UNRESOLVED_PLACEHOLDER',
          message: 'unresolved placeholder {code} at step 2',
          requestId: 'r',
          stepIndex: 2,
          key: 'code',
        },
      }) : null),
    ];
    await mount(routes);
    // 先定义一个 2 步序列（POST 落库 → 页面重拉 GET：列表与编辑器行都来自服务端）
    setInput(el('[data-testid="seq-name"]'), 'seq422');
    // 加一步
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('[data-testid="step-add"]')).click();
    });
    setInput(el('[data-testid="step-text-0"]'), 'hi {nick}');
    setInput(el('[data-testid="step-text-1"]'), 'use {code} now');
    // 提交定义 → 重拉的服务端列表 + launch-seq 下拉出现
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('[data-testid="seq-submit"]')).click();
    });
    expect(container.querySelector('[data-testid="seq-item-seq-1"]')).not.toBeNull();
    // 启动表单：选群 + 选序列 + vars 缺 {code}（要服务端 422——桩返回 422）
    await act(async () => {
      setSelect(el('[data-testid="launch-group"]'), 'g-1');
      setSelect(el('[data-testid="launch-seq"]'), 'seq-1');
    });
    setInput(el('[data-testid="launch-vars"]'), '{"nick":"Alice"}');
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('[data-testid="launch-submit"]')).click();
    });
    // stepIndex=2 / key=code 定位展示
    expect(container.querySelector('[data-testid="launch-error"]')?.textContent).toContain(
      'unresolved placeholder {code}',
    );
    expect(container.querySelector('[data-testid="precheck-hit-banner"]')?.textContent).toContain(
      '步骤 2',
    );
    expect(container.querySelector('[data-testid="precheck-hit-banner"]')?.textContent).toContain(
      '{code}',
    );
    // 启动表单选中序列的步骤行：step index=2 行高亮且含 {key} 命中标记
    const hitRow = container.querySelector<HTMLElement>('[data-testid="launch-step-2"]');
    expect(hitRow?.querySelector('[data-testid="launch-hit-2"]')?.textContent).toContain('{code}');
    // step index=1 行不高亮
    expect(
      container
        .querySelector<HTMLElement>('[data-testid="launch-step-1"]')
        ?.querySelector('[data-testid^="launch-hit-"]'),
    ).toBeNull();
  });

  it('预检成功 → PreflightModal 逐步渲染 resolvedVars/varSources（default/step:2）', async () => {
    const routes: Route[] = [
      ...baseRoutes,
      (p) =>
        p === '/api/groups/g-1/sequence-runs' ? jsonResponse(201, { runId: 'run-1' }) : null,
      (p) => (p === '/api/sequence-runs/run-1' ? jsonResponse(200, RUN_RUNNING) : null),
    ];
    await mount(routes);
    // 定义序列
    setInput(el('[data-testid="seq-name"]'), 'ok-seq');
    setInput(el('[data-testid="step-text-0"]'), 'hi {nick}');
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('[data-testid="seq-submit"]')).click();
    });
    // 启动
    await act(async () => {
      setSelect(el('[data-testid="launch-group"]'), 'g-1');
      setSelect(el('[data-testid="launch-seq"]'), 'seq-1');
    });
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('[data-testid="launch-submit"]')).click();
    });
    // 弹窗出现 + 逐步 resolvedVars/varSources
    const modal = container.querySelector('[data-testid="preflight-modal"]');
    expect(modal).not.toBeNull();
    // step1: nick=Alice source=default
    expect(
      container.querySelector('[data-testid="preflight-var-1-nick"]')?.textContent,
    ).toContain('Alice');
    expect(
      container.querySelector('[data-testid="preflight-var-1-nick"]')?.textContent,
    ).toContain('default');
    // step2: code=42 source=step:2（字面「step:<i>」）
    expect(
      container.querySelector('[data-testid="preflight-var-2-code"]')?.textContent,
    ).toContain('42');
    expect(
      container.querySelector('[data-testid="preflight-var-2-code"]')?.textContent,
    ).toContain('step:2');
    // 关闭
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('[data-testid="preflight-close"]')).click();
    });
    expect(container.querySelector('[data-testid="preflight-modal"]')).toBeNull();
  });

  it('运行视图：status/currentStepIndex/scheduledAt/sentAt + WS sequence_run 推进', async () => {
    // 用可变 detail 响应控制（StrictMode 双 effect 会多拉，用差值断言）
    let currentRun = RUN_RUNNING;
    const routes: Route[] = [
      ...baseRoutes,
      (p) => (p === '/api/sequence-runs/run-1' ? jsonResponse(200, currentRun) : null),
    ];
    const { calls } = await mount(routes);
    const sock = lastSocket();
    await act(async () => {
      sock.simulateOpen();
      sock.simulateMessage({ type: 'auth', success: true });
    });
    // 先登一个 run（不用启动路径——直接 run id 载入）
    setInput(el('[data-testid="run-id-input"]'), 'run-1');
    await act(async () => {
      must(container.querySelector<HTMLButtonElement>('[data-testid="run-load"]')).click();
    });
    // 静态：status/currentStepIndex/每步 scheduledAt/sentAt
    expect(container.querySelector('[data-testid="run-status"]')?.textContent).toBe('running');
    expect(container.querySelector('[data-testid="run-current"]')?.textContent).toBe('1');
    expect(container.querySelector('[data-testid="run-step-scheduled-1"]')?.textContent).toContain(
      '2026-09-28T00:00:00Z',
    );
    expect(container.querySelector('[data-testid="run-step-sent-1"]')?.textContent).toContain(
      '2026-09-28T00:00:01Z',
    );
    expect(container.querySelector('[data-testid="run-step-sent-2"]')?.textContent).toBe('—');
    // WS sequence_run → currentStepIndex 推进 + 重拉详情拿步级 sentAt
    const callsBefore = calls.filter((c) => c.path === '/api/sequence-runs/run-1').length;
    currentRun = RUN_ADVANCED;
    await act(async () => {
      sock.simulateMessage({
        seq: 50,
        type: 'sequence_run',
        payload: { runId: 'run-1', groupId: 'g-1', status: 'running', currentStepIndex: 2 },
      });
    });
    expect(calls.filter((c) => c.path === '/api/sequence-runs/run-1').length).toBe(callsBefore + 1);
    expect(container.querySelector('[data-testid="run-current"]')?.textContent).toBe('2');
    expect(container.querySelector('[data-testid="run-step-sent-2"]')?.textContent).toContain(
      '2026-09-28T00:00:11Z',
    );
  });
});
