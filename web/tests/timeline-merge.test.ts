// @vitest-environment happy-dom
// 时间线合并（T-P5-05；DES/15 §5/§6 表 mergeTimelineItem 行、DES/05 §5.2、REQ A4/§4）。
// 断言逐字：
//   L1 mergeTimelineItem：queued 行收 msgId 回填 → 沿用同一行（键迁移 msgId 但位置/条数不变，
//     不插新行）；deliveryStatus 只前进不倒退（sent→queued 拒绝、accepted→unknown 允许、
//     unknown→sent 允许、failed/cancelled 终态不倒退）；未命中键 → unknownKey（调用方重拉）；
//   L1 mergeTimelinePage：'bottom' 翻页追加不重排、'top' 首屏前置；跨页同键 → patch 不重复；
//   L2 组件：initial 渲染 + 徽标（own 行 deliveryStatus，failed 含 failCode）；WS message
//     原地更新（行序不变）；「加载更早」翻页期间 WS 到达 → 不重复不遗漏（游标边界正交）；
//     发送受理 → queued 占位行进顶部 → WS 回填 msgId 沿用同一行。
// 层位：L1 纯函数；L2 happy-dom 组件（client 为桩、WS 走 FakeSocket 单例）。
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Timeline, type OptimisticRow } from '../src/components/Timeline.js';
import type { ApiClient } from '../src/api/client.js';
import type { TimelineItem, TimelinePage } from '../src/lib/api-types.js';
import {
  canAdvanceDelivery,
  mergeTimelineItem,
  mergeTimelinePage,
  rowKeyOf,
  type TimelineItems,
} from '../src/timeline/merge.js';
import { getWsClient, initWsClient, resetWsClient } from '../src/ws/useWsEvent.js';
import type { WebSocketLike } from '../src/ws/WsClient.js';

declare const globalThis: { IS_REACT_ACT_ENVIRONMENT?: boolean };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---------- fixtures ----------

function row(partial: Partial<TimelineItem> & Pick<TimelineItem, 'text' | 'sentAt'>): TimelineItem {
  return {
    msgId: null,
    clientMsgId: null,
    senderPlatformUserId: 'ext-user',
    isOwn: false,
    deliveryStatus: null,
    failCode: null,
    ...partial,
  };
}

function ownQueued(clientMsgId: string, text: string): TimelineItem {
  return row({
    clientMsgId,
    senderPlatformUserId: 'pu-1',
    isOwn: true,
    text,
    sentAt: '2026-09-28T00:00:00Z',
    deliveryStatus: 'queued',
  });
}

function mapOf(...rows: TimelineItem[]): TimelineItems {
  const m: TimelineItems = new Map();
  for (const r of rows) {
    const k = rowKeyOf(r);
    if (k !== null) m.set(k, r);
  }
  return m;
}

// ---------- L1：mergeTimelineItem（DES/15 §6 表逐字行） ----------

describe('mergeTimelineItem（L1 纯函数）', () => {
  it('queued 行收 msgId 回填 → 沿用同一行（键迁到 msgId、位置不动、不插新行）', () => {
    const items = mapOf(
      row({ msgId: 'm9', text: 'old', sentAt: '2026-09-28T00:00:09Z' }),
      ownQueued('cm-1', 'hello'),
      row({ msgId: 'm7', text: 'older', sentAt: '2026-09-28T00:00:07Z' }),
    );
    const r = mergeTimelineItem(items, {
      groupId: 'g-1',
      msgId: 'm-gw-1',
      isOwn: true,
      clientMsgId: 'cm-1',
      deliveryStatus: 'sent',
    });
    expect(r.changed).toBe(true);
    expect(r.unknownKey).toBe(false);
    expect(r.items.size).toBe(3); // 不插新行
    // 键迁移 cm-1 → m-gw-1，但行序不变（「原地更新键值」：m9, m-gw-1, m7）
    expect([...r.items.keys()]).toEqual(['m9', 'm-gw-1', 'm7']);
    const merged = r.items.get('m-gw-1');
    expect(merged?.msgId).toBe('m-gw-1');
    expect(merged?.clientMsgId).toBe('cm-1'); // 保留——后续事件仍可按 clientMsgId 定位
    expect(merged?.deliveryStatus).toBe('sent');
    expect(merged?.text).toBe('hello'); // 事件不携带的字段沿用旧值
  });

  it('deliveryStatus 只前进不倒退；unknown→sent 允许（§6 表逐字）', () => {
    const base = ownQueued('cm-1', 'x');
    const sentRow = { ...base, deliveryStatus: 'sent' };
    // sent → queued：倒退，拒绝
    const back = mergeTimelineItem(mapOf(sentRow), {
      groupId: 'g',
      msgId: null,
      isOwn: true,
      clientMsgId: 'cm-1',
      deliveryStatus: 'queued',
    });
    expect(back.items.get('cm-1')?.deliveryStatus).toBe('sent');
    // accepted → unknown：允许（受理后发网关结果未知——确定回退为存疑是前进）
    const unk = mergeTimelineItem(
      mapOf({ ...base, deliveryStatus: 'accepted' }),
      { groupId: 'g', msgId: null, isOwn: true, clientMsgId: 'cm-1', deliveryStatus: 'unknown' },
    );
    expect(unk.items.get('cm-1')?.deliveryStatus).toBe('unknown');
    // unknown → sent：存疑被消解，允许（§6「unknown→sent 更新」逐字）
    const sent = mergeTimelineItem(unk.items, {
      groupId: 'g',
      msgId: null,
      isOwn: true,
      clientMsgId: 'cm-1',
      deliveryStatus: 'sent',
    });
    expect(sent.items.get('cm-1')?.deliveryStatus).toBe('sent');
    // failed/cancelled 终态不倒退
    const term = mergeTimelineItem(
      mapOf({ ...base, deliveryStatus: 'failed', failCode: 'GROUP_WRITE_FORBIDDEN' }),
      { groupId: 'g', msgId: null, isOwn: true, clientMsgId: 'cm-1', deliveryStatus: 'sent' },
    );
    expect(term.items.get('cm-1')?.deliveryStatus).toBe('failed');
    // canAdvanceDelivery 表本身也钉死
    expect(canAdvanceDelivery('queued', 'accepted')).toBe(true);
    expect(canAdvanceDelivery('sent', 'unknown')).toBe(false);
    expect(canAdvanceDelivery(null, 'sent')).toBe(true);
  });

  it('未命中键 → unknownKey=true，items 不动（调用方重拉首屏窗口）', () => {
    const items = mapOf(row({ msgId: 'm1', text: 'x', sentAt: 't' }));
    const r = mergeTimelineItem(items, {
      groupId: 'g',
      msgId: 'm-new',
      isOwn: false,
    });
    expect(r.unknownKey).toBe(true);
    expect(r.changed).toBe(false);
    expect(r.items.size).toBe(1);
    expect(r.items.get('m1')).toBe(items.get('m1')); // 行引用不变
  });

  it('msgId 与 clientMsgId 双键都可定位同一行（回填后仍可按 clientMsgId patch）', () => {
    const items = mapOf({ ...ownQueued('cm-1', 'x'), msgId: 'm-1' });
    const r = mergeTimelineItem(items, {
      groupId: 'g',
      msgId: null,
      isOwn: true,
      clientMsgId: 'cm-1',
      deliveryStatus: 'accepted',
    });
    expect(r.unknownKey).toBe(false);
    expect(r.items.get('m-1')?.deliveryStatus).toBe('accepted'); // 键已是 m-1，按 cm-1 也命中
  });
});

describe('mergeTimelinePage（翻页融合）', () => {
  const older = [
    row({ msgId: 'm3', text: 'three', sentAt: '2026-09-28T00:00:03Z' }),
    row({ msgId: 'm2', text: 'two', sentAt: '2026-09-28T00:00:02Z' }),
  ];

  it("'bottom' 翻页：新键后置保序；已存在键原地 patch 不重复", () => {
    const items = mapOf(
      row({ msgId: 'm4', text: 'four', sentAt: '2026-09-28T00:00:04Z' }),
      row({ msgId: 'm3', text: 'three-stale', sentAt: '2026-09-28T00:00:03Z' }),
    );
    const merged = mergeTimelinePage(items, older, 'bottom');
    expect([...merged.keys()]).toEqual(['m4', 'm3', 'm2']);
    expect(merged.get('m3')?.text).toBe('three'); // patch 更新
    expect(merged.size).toBe(3); // 不产生重复行
  });

  it("'top' 首屏重拉：新键前置保序（首屏上方新消息插入顶部）", () => {
    const items = mapOf(row({ msgId: 'm3', text: 'three', sentAt: '2026-09-28T00:00:03Z' }));
    const page1 = [
      row({ msgId: 'm5', text: 'five', sentAt: '2026-09-28T00:00:05Z' }),
      row({ msgId: 'm4', text: 'four', sentAt: '2026-09-28T00:00:04Z' }),
      row({ msgId: 'm3', text: 'three', sentAt: '2026-09-28T00:00:03Z' }),
    ];
    const merged = mergeTimelinePage(items, page1, 'top');
    expect([...merged.keys()]).toEqual(['m5', 'm4', 'm3']); // 服务端序前置
  });

  it('跨页重复 + WS 交叠：翻页页含已被 WS patch 的行 → 仍一行且保留新字段', () => {
    // WS 先把 m4 的 sentAt 更新过（sentAt 上移行留在原位仅更新字段）
    const items = mapOf(
      row({ msgId: 'm4', text: 'four', sentAt: '2026-09-28T00:00:04Z', deliveryStatus: 'sent' }),
    );
    // 加载更早返回的页里仍含 m4（cursor 边界内 patch 不重排）
    const earlier = [
      { ...row({ msgId: 'm4', text: 'four', sentAt: '2026-09-28T00:00:04Z' }), deliveryStatus: 'accepted' },
      row({ msgId: 'm2', text: 'two', sentAt: '2026-09-28T00:00:02Z' }),
    ];
    const merged = mergeTimelinePage(items, earlier, 'bottom');
    expect([...merged.keys()]).toEqual(['m4', 'm2']);
    // 快照竞态：翻页页里的旧 deliveryStatus(accepted) 不回退 WS 已推进的 sent
    expect(merged.get('m4')?.deliveryStatus).toBe('sent');
  });
});

// ---------- L2 组件 ----------

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
  simulateAuthOk(): void {
    this.onmessage?.({ data: JSON.stringify({ type: 'auth', success: true }) });
  }
  simulateMessage(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

/** 桩 ApiClient：GET /messages 分页按请求记录；request 返回注入页 */
function stubClient(pages: Record<string, TimelinePage>): {
  client: ApiClient;
  requests: string[];
} {
  const requests: string[] = [];
  const client: ApiClient = {
    request: async <T,>(path: string): Promise<T> => {
      requests.push(path);
      // 'before=' 优先于 'messages'——带 before 的翻页 URL 同样含 'messages' 子串
      const ordered = Object.entries(pages).sort(([a], [b]) => (a === 'messages' ? 1 : b === 'messages' ? -1 : 0));
      for (const [key, page] of ordered) {
        if (path.includes(key)) return page as T;
      }
      return { items: [], nextCursor: null } as T;
    },
    refreshToken: () => Promise.resolve('t'),
    refreshInFlight: () => false,
  };
  return { client, requests };
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
  document.body.innerHTML = '';
});

function lastSocket(): FakeSocket {
  const s = FakeSocket.instances[FakeSocket.instances.length - 1];
  if (s === undefined) throw new Error('no socket');
  return s;
}

describe('Timeline 组件（L2）', () => {
  let container: HTMLDivElement;
  let root: Root;

  async function mount(pages: Record<string, TimelinePage>, optimistic?: OptimisticRow): Promise<void> {
    const { client } = stubClient(pages);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(Timeline, { groupId: 'g-1', client, optimistic: optimistic ?? null }),
        ),
      );
    });
    getWsClient()?.connect(); // 本测试无 AuthProvider——手工连单例（AuthProvider 在真应用里做这步）
  }

  afterEach(async () => {
    if (root !== undefined) await act(async () => root.unmount());
    container?.remove();
  });

  it('首屏渲染行 + own 徽标；「加载更早」追加更早页不重复', async () => {
    const page1: TimelinePage = {
      items: [
        {
          ...ownQueued('cm-1', 'my msg'),
          deliveryStatus: 'sent',
          msgId: 'm4',
          sentAt: '2026-09-28T00:00:04Z',
        },
        row({ msgId: 'm3', text: 'inbound', sentAt: '2026-09-28T00:00:03Z' }),
      ],
      nextCursor: 'cursor-1',
    };
    const page2: TimelinePage = {
      items: [
        { ...row({ msgId: 'm3', text: 'inbound-updated', sentAt: '2026-09-28T00:00:03Z' }) },
        row({ msgId: 'm2', text: 'older', sentAt: '2026-09-28T00:00:02Z' }),
      ],
      nextCursor: null,
    };
    await mount({ messages: page1, 'before=cursor-1': page2 });
    // 首屏两行：own 徽标 sent、inbound 无徽标
    expect(container.querySelector('[data-testid="tl-m4"]')?.textContent).toContain('my msg');
    expect(container.querySelector('[data-testid="tl-badge-m4"]')?.textContent).toBe('[sent]');
    expect(container.querySelector('[data-testid="tl-m3"]')?.textContent).toContain('inbound');
    // 加载更早按钮（nextCursor 存在）
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === '加载更早');
    expect(btn).toBeDefined();
    await act(async () => {
      btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // 追加 m2 于尾部；m3 页内重复 → patch 不重复（行序 [m4, m3, m2]）
    const keys = [...container.querySelectorAll('li[data-testid^="tl-"]')].map((li) =>
      li.getAttribute('data-testid'),
    );
    expect(keys.filter((k) => k === 'tl-m3').length).toBe(1);
    expect(container.querySelector('[data-testid="tl-m2"]')?.textContent).toContain('older');
    expect(container.querySelector('[data-testid="tl-m3"]')?.textContent).toContain('inbound-updated');
    // 翻页用尽 → 按钮消失
    expect([...container.querySelectorAll('button')].find((b) => b.textContent === '加载更早')).toBeUndefined();
  });

  it('WS message：own 行 deliveryStatus 原地推进（行序不变、徽标更新）', async () => {
    const page1: TimelinePage = {
      items: [ownQueued('cm-1', 'hello'), row({ msgId: 'm3', text: 'in', sentAt: 'x' })],
      nextCursor: null,
    };
    await mount({ messages: page1 });
    const sock = lastSocket();
    await act(async () => {
      sock.simulateOpen();
      sock.simulateAuthOk();
    });
    // WS：queued → msgId 回填 + sent
    await act(async () => {
      sock.simulateMessage({
        seq: 1,
        type: 'message',
        payload: { groupId: 'g-1', msgId: 'm-gw-1', isOwn: true, clientMsgId: 'cm-1', deliveryStatus: 'sent' },
      });
    });
    const lis = [...container.querySelectorAll('li[data-testid^="tl-"]')];
    expect(lis.map((li) => li.getAttribute('data-testid'))).toEqual(['tl-m-gw-1', 'tl-m3']);
    // 徽标推进且行文本不变
    expect(container.querySelector('[data-testid="tl-badge-m-gw-1"]')?.textContent).toBe('[sent]');
    expect(container.querySelector('[data-testid="tl-m-gw-1"]')?.textContent).toContain('hello');
    // 倒退帧被丢（sent → queued 不倒退）
    await act(async () => {
      sock.simulateMessage({
        seq: 2,
        type: 'message',
        payload: { groupId: 'g-1', msgId: 'm-gw-1', isOwn: true, clientMsgId: 'cm-1', deliveryStatus: 'queued' },
      });
    });
    expect(container.querySelector('[data-testid="tl-badge-m-gw-1"]')?.textContent).toBe('[sent]');
  });

  it('WS 未知键 → 重拉首屏窗口（顶部插入完整行）；failed 徽标含 failCode', async () => {
    const { client, requests } = stubClient({
      messages: {
        items: [
          row({ msgId: 'm9', text: 'newest-inbound', sentAt: '2026-09-28T00:00:09Z' }),
          {
            ...ownQueued('cm-1', 'mine'),
            deliveryStatus: 'failed',
            failCode: 'GROUP_WRITE_FORBIDDEN',
            msgId: null,
          },
        ],
        nextCursor: null,
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(Timeline, { groupId: 'g-1', client, optimistic: null }),
        ),
      );
    });
    getWsClient()?.connect();
    // failed 徽标含 failCode（页面 3 逐字）
    expect(container.querySelector('[data-testid="tl-badge-cm-1"]')?.textContent).toBe(
      '[failed(GROUP_WRITE_FORBIDDEN)]',
    );
    // WS 未知键（新 inbound m-new 不在持有行里）→ 重拉首屏窗口
    const sock = lastSocket();
    await act(async () => {
      sock.simulateOpen();
      sock.simulateAuthOk();
    });
    const before = requests.length;
    await act(async () => {
      sock.simulateMessage({
        seq: 1,
        type: 'message',
        payload: { groupId: 'g-1', msgId: 'm-new-not-held', isOwn: false },
      });
    });
    expect(requests.length).toBe(before + 1); // 重拉发生
    expect(container.querySelector('[data-testid="tl-m9"]')?.textContent).toContain('newest-inbound');
  });

  it('发送受理 → optimistic queued 占位行进顶部；WS 回填沿用同一行', async () => {
    const page1: TimelinePage = { items: [row({ msgId: 'm3', text: 'in', sentAt: 'x' })], nextCursor: null };
    await mount({ messages: page1 });
    // 受理：queued 占位行进顶部
    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(Timeline, {
            groupId: 'g-1',
            client: stubClient({ messages: page1 }).client,
            optimistic: {
              clientMsgId: 'cm-new',
              senderPlatformUserId: 'pu-1',
              text: 'fresh send',
              nonce: 1,
            },
          }),
        ),
      );
    });
    expect(container.querySelector('[data-testid="tl-badge-cm-new"]')?.textContent).toBe('[queued]');
    const keys = [...container.querySelectorAll('li[data-testid^="tl-"]')].map((li) =>
      li.getAttribute('data-testid'),
    );
    expect(keys[0]).toBe('tl-cm-new'); // 顶部插入
    // WS 回填 msgId → 同一行键迁移（位置不变、不重复）
    const sock = lastSocket();
    await act(async () => {
      sock.simulateOpen();
      sock.simulateAuthOk();
      sock.simulateMessage({
        seq: 1,
        type: 'message',
        payload: {
          groupId: 'g-1',
          msgId: 'm-gw-9',
          isOwn: true,
          clientMsgId: 'cm-new',
          deliveryStatus: 'sent',
        },
      });
    });
    const keys2 = [...container.querySelectorAll('li[data-testid^="tl-"]')].map((li) =>
      li.getAttribute('data-testid'),
    );
    expect(keys2).toEqual(['tl-m-gw-9', 'tl-m3']); // 同一行键迁移，位置与条数不变
    expect(container.querySelector('[data-testid="tl-badge-m-gw-9"]')?.textContent).toBe('[sent]');
    expect(container.querySelector('[data-testid="tl-m-gw-9"]')?.textContent).toContain('fresh send');
  });
});
