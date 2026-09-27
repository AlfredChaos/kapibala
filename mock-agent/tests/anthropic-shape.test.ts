// anthropic provider 形状映射（T-P8-02；DES/12 §4、REQ C2、DES/01 §6.5）。
// 无 key 也可测：形状映射是纯函数 + provider 接受注入式 client（鸭子类型 AnthropicLike）——
// 真 SDK 只出现在装配边界（resolveProvider），测试全程零网络。
// 契约断言（§4 逐字）：
//   请求方向——tools/messages 近同构透传（§2.2 协议本就是 Anthropic tool-use 形状）；
//   响应方向——多 content 块取首个 tool_use/text、其余丢弃、恰一块且 stop_reason 一致；
//             SDK stop_reason ∉ {tool_use,end_turn} → end_turn + text 兜底块；
//   audit——judge prompt 只收 {verdict:'pass'|'fail', reason} JSON；解析失败/非约定值 → 500
//             （契约「拿不到明确结论」故障形态，后端 blocked 路径可真实测到）。
import { describe, expect, it } from 'vitest';
import type { TurnRequest } from '@kapibala/contract';
import { createAgentApp } from '../src/app.js';
import {
  createAnthropicProvider,
  mapTurnResponse,
  type AnthropicCreateParams,
  type AnthropicLike,
  type AnthropicMessageLike,
} from '../src/providers/anthropic.js';

const NO_LOG = { info() {}, warn() {}, error() {} };

/** 假 client：记录入参、回放预设响应——anthropic provider 的全部断言都走它（零网络） */
function fakeClient(reply: AnthropicMessageLike): AnthropicLike & { calls: AnthropicCreateParams[] } {
  const calls: AnthropicCreateParams[] = [];
  return {
    calls,
    messages: {
      async create(params: AnthropicCreateParams): Promise<AnthropicMessageLike> {
        calls.push(params);
        return reply;
      },
    },
  };
}

const TURN: TurnRequest = {
  runId: 'run-1',
  tools: [
    {
      name: 'finish',
      description: 'finish run',
      input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    },
  ],
  messages: [
    {
      role: 'user',
      content: [{ type: 'text', text: '{"groupId":"g-1","triggerMessages":[],"policy":{"autoKickEnabled":false},"ownPlatformUserIds":[]}' }],
    },
  ],
};

describe('anthropic provider 形状映射（DES/12 §4）', () => {
  it('请求方向：model/max_tokens/messages 透传、tools 同构映射（name/description/input_schema）', async () => {
    const client = fakeClient({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ok' }],
    });
    const provider = createAnthropicProvider({ client, model: 'claude-sonnet-4-5', logger: NO_LOG });
    await provider.turn(TURN);
    expect(client.calls.length).toBe(1);
    const params = client.calls[0];
    expect(params?.model).toBe('claude-sonnet-4-5');
    expect(typeof params?.max_tokens).toBe('number');
    // 消息近同构透传：role/content 块原样（§4：§2.2 形状本就同构）
    expect(params?.messages).toEqual(TURN.messages);
    expect(params?.tools).toEqual([
      {
        name: 'finish',
        description: 'finish run',
        input_schema: TURN.tools[0]?.input_schema,
      },
    ]);
  });

  it('响应多块取首个 tool_use：其余丢弃、恰一块、stop_reason 一致', () => {
    const mapped = mapTurnResponse({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'thinking aloud' }, // 前面的 text 也算有效块——首个有效块才是它
        { type: 'tool_use', id: 'tu_9', name: 'send_message', input: { text: 'x' } },
      ],
    });
    // 首个有效块是 text → end_turn + text（形状一致性优先：块类型与 stop_reason 必须对应）
    expect(mapped.stop_reason).toBe('end_turn');
    expect(mapped.content).toEqual([{ type: 'text', text: 'thinking aloud' }]);
    expect(mapped.content.length).toBe(1);
  });

  it('首个有效块是 tool_use → stop_reason=tool_use；后置 text 丢弃', () => {
    const mapped = mapTurnResponse({
      stop_reason: 'end_turn', // SDK 偶发不一致：块说了算
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'finish', input: { summary: 'done' } },
        { type: 'text', text: 'trailing prose' },
      ],
    });
    expect(mapped.stop_reason).toBe('tool_use');
    expect(mapped.content.length).toBe(1);
    expect(mapped.content[0]).toEqual({
      type: 'tool_use',
      id: 'tu_1',
      name: 'finish',
      input: { summary: 'done' },
    });
  });

  it('SDK stop_reason 未知值（max_tokens/stop_sequence/其它）→ end_turn + text 兜底块', () => {
    for (const stop of ['max_tokens', 'stop_sequence', 'pause_turn', 'weird_future_value']) {
      const mapped = mapTurnResponse({
        stop_reason: stop,
        content: [{ type: 'tool_use', id: 'tu_2', name: 'finish', input: {} }],
      });
      expect(mapped.stop_reason).toBe('end_turn');
      expect(mapped.content.length).toBe(1);
      expect(mapped.content[0]?.type).toBe('text'); // 兜底块恒为 text（tool_use 不兜底成 tool_use）
    }
  });

  it('无有效块（thinking/空 content）→ end_turn + 空 text 兜底', () => {
    for (const content of [
      [],
      [{ type: 'thinking', thinking: 'hmm' }],
      [{ type: 'server_tool_use' }],
    ]) {
      const mapped = mapTurnResponse({ stop_reason: 'end_turn', content });
      expect(mapped.stop_reason).toBe('end_turn');
      expect(mapped.content.length).toBe(1);
      expect(mapped.content[0]).toEqual({ type: 'text', text: '' });
    }
  });

  it('provider.turn 端到端：SDK 多块 → 契约恰一块 JSON 回复', async () => {
    const client = fakeClient({
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'tu_7', name: 'get_recent_messages', input: { limit: 5 } },
        { type: 'text', text: 'noise' },
      ],
    });
    const provider = createAnthropicProvider({ client, model: 'm', logger: NO_LOG });
    const reply = await provider.turn(TURN);
    expect(reply.kind).toBe('json');
    const value = reply.kind === 'json' ? (reply.value as { stop_reason: string; content: unknown[] }) : undefined;
    expect(value?.stop_reason).toBe('tool_use');
    expect(value?.content.length).toBe(1);
    expect((value?.content[0] as { name: string }).name).toBe('get_recent_messages');
  });
});

describe('audit judge prompt（DES/12 §4 逐字）', () => {
  it('合法 JSON → 200 {verdict,reason} 原样透传', async () => {
    const client = fakeClient({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"verdict":"pass","reason":"clean"}' }],
    });
    const provider = createAnthropicProvider({ client, model: 'm', logger: NO_LOG });
    const reply = await provider.audit({ text: 'hello world', groupId: 'g-1' });
    expect(reply).toEqual({
      kind: 'json',
      value: { verdict: 'pass', reason: 'clean' },
    });
    // judge prompt 进 messages[0]：含被审文本 + 强约束「只输出 JSON」
    const sent = client.calls[0];
    const prompt = sent?.messages[0]?.content;
    const text = Array.isArray(prompt) && prompt[0]?.type === 'text' ? prompt[0].text : String(prompt);
    expect(text).toContain('hello world');
    expect(text).toContain('verdict');
    expect(sent?.tools === undefined || sent?.tools.length === 0).toBe(true); // audit 不挂工具
  });

  it('verdict 取 fail 也透传；缺 reason / verdict 非约定值 → 500 raw', async () => {
    const cases: Array<{ body: string; expectVerdict?: 'pass' | 'fail'; expect500: boolean }> = [
      { body: '{"verdict":"fail","reason":"spam"}', expectVerdict: 'fail', expect500: false },
      { body: 'not json at all', expect500: true },
      { body: '{"verdict":"maybe","reason":"x"}', expect500: true },
      { body: '{"verdict":"pass"}', expect500: true }, // 缺 reason
      { body: '[{"verdict":"pass","reason":"x"}]', expect500: true }, // 非对象
      { body: '', expect500: true },
    ];
    for (const c of cases) {
      const client = fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: c.body }] });
      const provider = createAnthropicProvider({ client, model: 'm', logger: NO_LOG });
      const reply = await provider.audit({ text: 't', groupId: 'g' });
      if (c.expect500) {
        expect(reply.kind).toBe('raw');
        if (reply.kind === 'raw') expect(reply.statusCode).toBe(500);
      } else {
        expect(reply.kind).toBe('json');
        if (reply.kind === 'json') {
          expect((reply.value as { verdict: string }).verdict).toBe(c.expectVerdict);
        }
      }
    }
  });

  it('SDK 抛出（网络/5xx）→ 500（同「无结论」契约形态，绝不抛出到 HTTP 层外）', async () => {
    const client: AnthropicLike = {
      messages: {
        async create(): Promise<AnthropicMessageLike> {
          throw new Error('sdk network failure');
        },
      },
    };
    const provider = createAnthropicProvider({ client, model: 'm', logger: NO_LOG });
    const reply = await provider.audit({ text: 't', groupId: 'g' });
    expect(reply.kind).toBe('raw');
    if (reply.kind === 'raw') expect(reply.statusCode).toBe(500);
    // turn 侧同样不外抛
    const turnReply = await provider.turn(TURN);
    expect(turnReply.kind).toBe('raw');
    if (turnReply.kind === 'raw') expect(turnReply.statusCode).toBe(500);
  });
});

describe('装配边界（resolveProvider）', () => {
  it('AGENT_MODE=anthropic 无 key → 仍拒起（错误信息含 ANTHROPIC_API_KEY）', () => {
    const oldKey = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      expect(() => createAgentApp({ mode: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (oldKey !== undefined) process.env['ANTHROPIC_API_KEY'] = oldKey;
    }
  });

  it('有 key → anthropic provider 装配成功（不发请求；返回真实 provider）', () => {
    const oldKey = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-dummy';
    try {
      const app = createAgentApp({ mode: 'anthropic' });
      expect(app).toBeDefined();
      return app.close();
    } finally {
      if (oldKey === undefined) {
        delete process.env['ANTHROPIC_API_KEY'];
      } else {
        process.env['ANTHROPIC_API_KEY'] = oldKey;
      }
    }
  });
});
