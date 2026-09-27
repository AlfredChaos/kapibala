// ag-1..7/17/19 协议类开关测试（T-P4-02 c 项，先红后绿）。
// 契约出处：REQ §2.2「Agent 服务可能出现的行为」逐字（非法 JSON / markdown 围栏 / 夹文字；
// 缺 stop_reason、块数 ≠1、stop_reason 与块类型不一致；调用不在 tools 里的工具；入参不合
// input_schema；同一 tool_use.id 用两次）；DES/12 §7 行 1–7/17/19；S6 三连剧本（ag-17）；
// ag-19 tools_invalid_probe 是反测后端 tools 常量的探针（DES/12 §7 行 19：400 TOOLS_INVALID）。
// 判定沿用 mock-gateway 约定：开关 target.runId 命中才注入，未命中走正常剧本/默认路径。
import { describe, expect, it } from 'vitest';
import { AGENT_TOOLS, type ToolDefinition } from '@kapibala/contract';
import {
  arm,
  clearScenario,
  expectToolUse,
  newApp,
  toolResultMsg,
  toolUseMsg,
  triggerContext,
  turn,
} from './helpers/agent.js';

/** 本地「按 §2.2 合法形状」判定（与后端三段式校验同构）：恰好一块 + stop_reason 与块类型一致 */
function isValidTurnBody(payload: string): boolean {
  try {
    const body = JSON.parse(payload) as { stop_reason?: string; content?: unknown[] };
    if (body.stop_reason !== 'tool_use' && body.stop_reason !== 'end_turn') {
      return false;
    }
    if (!Array.isArray(body.content) || body.content.length !== 1) {
      return false;
    }
    const block = body.content[0] as { type?: string } | undefined;
    return body.stop_reason === 'tool_use' ? block?.type === 'tool_use' : block?.type === 'text';
  } catch {
    return false;
  }
}

describe('ag-1..3 坏 JSON 三形态（REQ §2.2 行为 1：都记 BAD_JSON）', () => {
  it('ag-1 bad_json_raw：200 但响应体不是合法 JSON', async () => {
    const app = newApp();
    await arm(app, 'bad_json_raw');
    const res = await turn(app, 'r-1', [triggerContext()]);
    expect(res.statusCode).toBe(200);
    expect(() => JSON.parse(res.payload)).toThrow();
  });

  it('ag-2 bad_json_fenced：合法 JSON 外套 markdown 围栏 → JSON.parse 失败', async () => {
    const app = newApp();
    await arm(app, 'bad_json_fenced');
    const res = await turn(app, 'r-1', [triggerContext()]);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('```');
    expect(() => JSON.parse(res.payload)).toThrow();
    // 剥掉围栏后内部必须是合法响应形状（围栏里的 JSON 本身合法）
    const inner = res.payload.replace(/```(?:json)?/g, '').trim();
    expect(isValidTurnBody(inner)).toBe(true);
  });

  it('ag-3 bad_json_wrapped：合法 JSON 前后夹文字 → JSON.parse 失败', async () => {
    const app = newApp();
    await arm(app, 'bad_json_wrapped');
    const res = await turn(app, 'r-1', [triggerContext()]);
    expect(res.statusCode).toBe(200);
    expect(() => JSON.parse(res.payload)).toThrow();
    expect(res.payload).not.toMatch(/^\s*[{\[]/); // 开头不是 JSON
    expect(res.payload).not.toMatch(/[}\]]\s*$/); // 结尾不是 JSON
    const extracted = res.payload.slice(res.payload.indexOf('{'), res.payload.lastIndexOf('}') + 1);
    expect(isValidTurnBody(extracted)).toBe(true); // 夹住的 JSON 本身合法
  });

  it('clear 后恢复合法响应（开关不污染后续用例的默认路径）', async () => {
    const app = newApp();
    await arm(app, 'bad_json_raw');
    await turn(app, 'r-1', [triggerContext()]);
    await clearScenario(app, 'bad_json_raw');
    const res = await turn(app, 'r-1', [triggerContext()]);
    expect(res.statusCode).toBe(200);
    expect(isValidTurnBody(res.payload)).toBe(true);
  });
});

describe('ag-4 shape_invalid：JSON 合法但形状不符（REQ §2.2 BAD_JSON 第三层，三子形态）', () => {
  it('缺 stop_reason（默认子形态）', async () => {
    const app = newApp();
    await arm(app, 'shape_invalid');
    const res = await turn(app, 'r-1', [triggerContext()]);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as Record<string, unknown>; // JSON 本身合法
    expect(body['stop_reason']).toBeUndefined();
    expect(isValidTurnBody(res.payload)).toBe(false);
  });

  it('params.variant=two_blocks：块数 ≠1', async () => {
    const app = newApp();
    await arm(app, 'shape_invalid', { variant: 'two_blocks' });
    const res = await turn(app, 'r-1', [triggerContext()]);
    const body = JSON.parse(res.payload) as { content: unknown[] };
    expect(body.content).toHaveLength(2);
    expect(isValidTurnBody(res.payload)).toBe(false);
  });

  it('params.variant=mismatch：stop_reason 与块类型不一致', async () => {
    const app = newApp();
    await arm(app, 'shape_invalid', { variant: 'mismatch' });
    const res = await turn(app, 'r-1', [triggerContext()]);
    const body = JSON.parse(res.payload) as { stop_reason: string; content: Array<{ type: string }> };
    expect(body.stop_reason).toBe('end_turn');
    expect(body.content[0]?.type).toBe('tool_use'); // 块是 tool_use 但 stop_reason 说 end_turn
    expect(isValidTurnBody(res.payload)).toBe(false);
  });
});

describe('ag-5 unknown_tool / ag-6 invalid_input（REQ §2.2 行为 2：路径 A 两码）', () => {
  it('ag-5：形状合法但调用不在 tools 里的工具', async () => {
    const app = newApp();
    await arm(app, 'unknown_tool');
    const block = await expectToolUse(await turn(app, 'r-1', [triggerContext()]));
    expect(AGENT_TOOLS.map((t) => t.name)).not.toContain(block.name);
  });

  it('ag-6：形状合法但入参违反 input_schema（limit 给字符串；入参可钉）', async () => {
    const app = newApp();
    await arm(app, 'invalid_input');
    const block = await expectToolUse(await turn(app, 'r-1', [triggerContext()]));
    expect(block.name).toBe('get_recent_messages');
    expect(block.input['limit']).toBe('not-a-number'); // limit 应为 number

    await arm(app, 'invalid_input', { name: 'send_message', input: { text: 42 } });
    const pinned = await expectToolUse(await turn(app, 'r-2', [triggerContext()]));
    expect(pinned.name).toBe('send_message');
    expect(pinned.input['text']).toBe(42); // text 应为 string
    expect(pinned.input['idempotency_key']).toBeUndefined(); // required 缺键也是 INVALID_INPUT
  });
});

describe('ag-7 duplicate_tool_use_id：同一 tool_use.id 用两次（REQ §2.2 行为 3）', () => {
  it('连续两轮返回同一个 tool_use.id（钉值可配，缺省固定串）', async () => {
    const app = newApp();
    await arm(app, 'duplicate_tool_use_id');
    const messages = [triggerContext()];
    const first = await expectToolUse(await turn(app, 'r-1', messages));
    messages.push(toolUseMsg(first), toolResultMsg(first.id, { messages: [], truncated: false }));
    const second = await expectToolUse(await turn(app, 'r-1', messages));
    expect(second.id).toBe(first.id); // 非法路径：重试本应换新 id（REQ §2.2）
  });
});

describe('ag-17 s6_sequence：三连剧本 坏 JSON → 未知工具 → 正常结束（S6，DES/12 §7 行 17）', () => {
  it('按 (runId,调用序号) 推进三连，最后一步是合法 finish', async () => {
    const app = newApp();
    await arm(app, 's6_sequence');
    const messages = [triggerContext()];

    const r1 = await turn(app, 'r-1', messages);
    expect(r1.statusCode).toBe(200);
    expect(() => JSON.parse(r1.payload)).toThrow(); // 步 1：坏 JSON

    // 协议错误步会以 tool_result 形式回到历史（server 侧 BAD_JSON 记步）；mock 只按剧本推进
    const r2 = await expectToolUse(await turn(app, 'r-1', messages));
    expect(AGENT_TOOLS.map((t) => t.name)).not.toContain(r2.name); // 步 2：未知工具

    const r3 = await expectToolUse(await turn(app, 'r-1', messages));
    expect(r3.name).toBe('finish'); // 步 3：正常结束
    expect(typeof r3.input['summary']).toBe('string');
  });

  it('定向 runId 时别的 run 走默认剧本', async () => {
    const app = newApp();
    await arm(app, 's6_sequence', undefined, { runId: 'r-hit' });
    const hit = await turn(app, 'r-hit', [triggerContext()]);
    expect(() => JSON.parse(hit.payload)).toThrow();
    const miss = await expectToolUse(await turn(app, 'r-other', [triggerContext()]));
    expect(miss.name).toBe('get_recent_messages');
  });
});

describe('ag-19 tools_invalid_probe：反测后端 tools 常量（DES/12 §7 行 19）', () => {
  it('不合规 tools → 400 TOOLS_INVALID；arm 探针不改变校验语义（契约层本来就拒）', async () => {
    const app = newApp();
    const broken = AGENT_TOOLS.slice(0, 3) as ToolDefinition[];
    // 未 arm 探针也 400：校验是契约层常态行为（server 常量保证永不触发）
    expect((await turn(app, 'r-1', [triggerContext()], broken)).statusCode).toBe(400);
    await arm(app, 'tools_invalid_probe');
    const res = await turn(app, 'r-1', [triggerContext()], broken);
    expect(res.statusCode).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'TOOLS_INVALID' });
    // 合规 tools 不受影响
    expect((await turn(app, 'r-1', [triggerContext()])).statusCode).toBe(200);
  });
});

describe('开关语义通用面（与 mock-gateway 同一约定）', () => {
  it('target.runId 收窄：只对命中 run 注入', async () => {
    const app = newApp();
    await arm(app, 'bad_json_raw', undefined, { runId: 'r-hit' });
    const hit = await turn(app, 'r-hit', [triggerContext()]);
    expect(() => JSON.parse(hit.payload)).toThrow();
    const miss = await expectToolUse(await turn(app, 'r-other', [triggerContext()]));
    expect(miss.name).toBe('get_recent_messages');
  });

  it('开关优先于剧本：arm 坏 JSON 后，已装剧本的 run 也吃到坏响应', async () => {
    const app = newApp();
    await arm(app, 'playbook', { steps: [{ kind: 'end_turn', text: 'v' }] }, { runId: 'r-1' });
    await arm(app, 'bad_json_raw');
    const res = await turn(app, 'r-1', [triggerContext()]);
    expect(() => JSON.parse(res.payload)).toThrow();
  });
});
