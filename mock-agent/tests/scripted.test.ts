// mock-agent 骨架 + scripted 默认剧本测试（T-P4-01 c 项，先红后绿）。
// 契约出处：REQ §2.2（tools 恰好 4 个 + input_schema.required 覆盖全部入参，否则 400
// TOOLS_INVALID；合法响应每轮恰好一个块、stop_reason 与块类型一致；audit {verdict,reason}；
// 工具名/入参逐字）；DES/12 §2（AGENT_MODE 双 provider、anthropic 无 key 拒起）、§2.1
// （无状态全量历史规约：响应只由 messages 决定，同 runId 相同 messages 重复请求 → 新响应）、
// §3（剧本按 (runId,调用序号) 推进、播完回落默认剧本 get_recent_messages→send_message→finish；
// `/_test/scenario` 装剧本是 arrange 唯一入口）；DES/06 §6（tools 常量在 server，本测试用
import { describe, expect, it } from 'vitest';
import { AGENT_TOOLS, type AgentMessage, type ToolDefinition } from '@kapibala/contract';
import { createAgentApp } from '../src/app.js';
import {
  expectEndTurn,
  expectToolUse,
  newApp,
  scenario,
  toolResultMsg,
  toolUseMsg,
  triggerContext,
  turn,
} from './helpers/agent.js';

describe('tools 校验（REQ §2.2：恰好 4 个固定工具 + required 覆盖全部入参，否则 400 TOOLS_INVALID）', () => {
  it('数量 ≠4：缺一个 / 多一个 → 400 TOOLS_INVALID', async () => {
    const app = newApp();
    expect((await turn(app, 'r-1', [triggerContext()], AGENT_TOOLS.slice(0, 3))).statusCode).toBe(400);
    const five = [...AGENT_TOOLS, { name: 'extra_tool', description: 'x', input_schema: {} }];
    const res = await turn(app, 'r-1', [triggerContext()], five);
    expect(res.statusCode).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'TOOLS_INVALID' });
  });

  it('工具名不符（4 个但名字错）→ 400 TOOLS_INVALID', async () => {
    const app = newApp();
    const renamed = AGENT_TOOLS.map((tool) =>
      tool.name === 'finish' ? { ...tool, name: 'stop' } : tool,
    );
    const res = await turn(app, 'r-1', [triggerContext()], renamed);
    expect(res.statusCode).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'TOOLS_INVALID' });
  });

  it('required 未覆盖全部入参 → 400 TOOLS_INVALID（ag-19 探针的反测面）', async () => {
    const app = newApp();
    const broken = AGENT_TOOLS.map((tool) =>
      tool.name === 'send_message'
        ? { ...tool, input_schema: { ...tool.input_schema, required: ['text'] } } // idempotency_key 未覆盖
        : tool,
    );
    const res = await turn(app, 'r-1', [triggerContext()], broken);
    expect(res.statusCode).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'TOOLS_INVALID' });
  });

  it('input_schema 缺失 / 非对象 → 400 TOOLS_INVALID', async () => {
    const app = newApp();
    const noSchema = AGENT_TOOLS.map((tool) => ({ name: tool.name, description: tool.description }));
    const res = await turn(app, 'r-1', [triggerContext()], noSchema as unknown as ToolDefinition[]);
    expect(res.statusCode).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'TOOLS_INVALID' });
  });

  it('缺 runId / messages 非数组 → 400', async () => {
    const app = newApp();
    expect(
      (await app.inject({ method: 'POST', url: '/agent/turn', payload: { tools: AGENT_TOOLS, messages: [] } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({ method: 'POST', url: '/agent/turn', payload: { runId: 'r-1', tools: AGENT_TOOLS } })
      ).statusCode,
    ).toBe(400);
  });
});

describe('scripted 默认剧本：get_recent_messages → send_message → finish（DES/12 §3；REQ §2.2 形状）', () => {
  it('三轮对话按剧本推进：每轮 200、恰好一个块、stop_reason 与块类型一致', async () => {
    const app = newApp();
    const messages: AgentMessage[] = [triggerContext('ping me')];

    // 第 1 轮：get_recent_messages {limit:number}
    const tu1 = await expectToolUse(await turn(app, 'r-1', messages));
    expect(tu1.name).toBe('get_recent_messages');
    expect(tu1.input['limit']).toEqual(expect.any(Number));
    messages.push(toolUseMsg(tu1), toolResultMsg(tu1.id, { messages: [], truncated: false }));

    // 第 2 轮：send_message {text, idempotency_key}
    const tu2 = await expectToolUse(await turn(app, 'r-1', messages));
    expect(tu2.name).toBe('send_message');
    expect(tu2.input['text']).toEqual(expect.any(String));
    expect(tu2.input['idempotency_key']).toEqual(expect.any(String));
    messages.push(
      toolUseMsg(tu2),
      toolResultMsg(tu2.id, { clientMsgId: 'c-1', deliveryStatus: 'sent' }),
    );

    // 第 3 轮：finish {summary}（run 应结束的协议形状）
    const tu3 = await expectToolUse(await turn(app, 'r-1', messages));
    expect(tu3.name).toBe('finish');
    expect(tu3.input['summary']).toEqual(expect.any(String));
  });

  it('runId 是会话键：不同 run 的默认剧本互不影响', async () => {
    const app = newApp();
    const a = await expectToolUse(await turn(app, 'r-A', [triggerContext()]));
    const b = await expectToolUse(await turn(app, 'r-B', [triggerContext()]));
    expect(a.name).toBe('get_recent_messages');
    expect(b.name).toBe('get_recent_messages');
    expect(a.id).not.toBe(b.id); // tool_use.id 全局唯一（DUPLICATE_TOOL_USE_ID 防御的前提）
  });
});

describe('无状态全量历史规约（DES/12 §2.1：响应只由 messages 决定）', () => {
  it('相同 messages 的重复请求（恢复重发）→ 返回新响应：新 tool_use.id、同样的下一步语义', async () => {
    const app = newApp();
    const messages = [triggerContext()];
    const first = await expectToolUse(await turn(app, 'r-9', messages));
    const second = await expectToolUse(await turn(app, 'r-9', messages));
    // 未装剧本：同一历史永远推出同一下一步（get_recent_messages），不因「请求重复」推进会话
    expect(second.name).toBe(first.name);
    expect(second.id).not.toBe(first.id);
  });

  it('已装剧本时同样成立：剧本播完后回落默认剧本，响应仍由 messages 决定', async () => {
    const app = newApp();
    await scenario(
      app,
      'playbook',
      { steps: [{ kind: 'tool_use', name: 'kick_user', input: { platform_user_id: 'p-9', reason: 'x' } }] },
      { runId: 'r-10' },
    );
    const messages = [triggerContext()];
    const step = await expectToolUse(await turn(app, 'r-10', messages));
    expect(step.name).toBe('kick_user'); // 剧本步
    const fallback = await expectToolUse(await turn(app, 'r-10', messages));
    expect(fallback.name).toBe('get_recent_messages'); // 播完回落：历史里还没有 tool_result → 重来第一步
  });
});

describe('/_test/scenario 装剧本（DES/12 §3：arrange 唯一入口；按 runId 定向 / 通配）', () => {
  it('定向 runId 剧本：该 run 第一轮即按剧本响应；别的 run 不受影响', async () => {
    const app = newApp();
    const res = await scenario(
      app,
      'playbook',
      { steps: [{ kind: 'end_turn', text: 'done early' }] },
      { runId: 'r-1' },
    );
    expect(res.statusCode).toBe(200);

    const block = await expectEndTurn(await turn(app, 'r-1', [triggerContext()]));
    expect(block.text).toBe('done early');
    // 未命中 runId 的会话走默认剧本
    const other = await expectToolUse(await turn(app, 'r-2', [triggerContext()]));
    expect(other.name).toBe('get_recent_messages');
  });

  it('通配剧本（无 runId）：作用于任意 run；finish 步渲染为 finish 工具调用', async () => {
    const app = newApp();
    await scenario(app, 'playbook', { steps: [{ kind: 'finish', summary: 'scripted done' }] });
    const block = await expectToolUse(await turn(app, 'r-any', [triggerContext()]));
    expect(block.name).toBe('finish');
    expect(block.input['summary']).toBe('scripted done');
  });

  it('未知开关名 / 非法步骤 → 400 且不生效', async () => {
    const app = newApp();
    expect((await scenario(app, 'not_a_switch')).statusCode).toBe(400);
    expect((await scenario(app, 'playbook', { steps: 'nope' })).statusCode).toBe(400);
    expect((await scenario(app, 'playbook', { steps: [{ kind: 'mystery' }] })).statusCode).toBe(400);
    // arrange 失败后默认剧本不受影响
    const block = await expectToolUse(await turn(app, 'r-3', [triggerContext()]));
    expect(block.name).toBe('get_recent_messages');
  });

  it('重复 arm = 覆盖（DES/14 §4 同义）：同一 runId 重装剧本，游标从头推进', async () => {
    const app = newApp();
    const target = { runId: 'r-4' };
    await scenario(app, 'playbook', { steps: [{ kind: 'end_turn', text: 'v1' }] }, target);
    await expectEndTurn(await turn(app, 'r-4', [triggerContext()]));
    await scenario(app, 'playbook', { steps: [{ kind: 'end_turn', text: 'v2' }] }, target);
    const block = await expectEndTurn(await turn(app, 'r-4', [triggerContext()]));
    expect(block.text).toBe('v2');
  });
});

describe('/agent/audit + /_test/state + /_test/reset', () => {
  it('audit 确定性 pass：200 {verdict:"pass", reason:string}', async () => {
    const app = newApp();
    const res = await app.inject({ method: 'POST', url: '/agent/audit', payload: { text: 'x', groupId: 'g-1' } });
    expect(res.statusCode).toBe(200);
    const body = (await res.json()) as { verdict: string; reason: string };
    expect(body.verdict).toBe('pass');
    expect(body.reason).toEqual(expect.any(String));
    // 再调一次仍 pass（确定性）
    const again = (await (
      await app.inject({ method: 'POST', url: '/agent/audit', payload: { text: 'y', groupId: 'g-1' } })
    ).json()) as { verdict: string };
    expect(again.verdict).toBe('pass');
  });

  it('audit 缺 text/groupId → 400', async () => {
    const app = newApp();
    expect((await app.inject({ method: 'POST', url: '/agent/audit', payload: { text: 'x' } })).statusCode).toBe(400);
  });

  it('GET /_test/state 反映 mode / 剧本 / 游标；reset 清零（Map 重启丢失是 mock 定位，DES/12 §2.1）', async () => {
    const app = newApp();
    await scenario(app, 'playbook', { steps: [{ kind: 'end_turn' }] }, { runId: 'r-5' });
    await expectEndTurn(await turn(app, 'r-5', [triggerContext()]));

    const state = (await (
      await app.inject({ method: 'GET', url: '/_test/state' })
    ).json()) as { mode: string; playbooks: Record<string, number>; cursors: Record<string, number> };
    expect(state.mode).toBe('scripted');
    expect(state.playbooks['r-5']).toBe(1);
    expect(state.cursors['r-5']).toBe(1);

    expect((await app.inject({ method: 'POST', url: '/_test/reset' })).statusCode).toBe(200);
    const after = (await (await app.inject({ method: 'GET', url: '/_test/state' })).json()) as {
      playbooks: Record<string, number>;
      cursors: Record<string, number>;
    };
    expect(after.playbooks).toEqual({});
    expect(after.cursors).toEqual({});
  });
});

describe('AGENT_MODE provider 选择（DES/12 §2/§6：anthropic=C2 槽位，无 key 拒起）', () => {
  const ORIGINAL_MODE = process.env['AGENT_MODE'];
  const ORIGINAL_KEY = process.env['ANTHROPIC_API_KEY'];
  function restoreEnv(): void {
    if (ORIGINAL_MODE === undefined) delete process.env['AGENT_MODE'];
    else process.env['AGENT_MODE'] = ORIGINAL_MODE;
    if (ORIGINAL_KEY === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = ORIGINAL_KEY;
  }

  it('AGENT_MODE=anthropic 且未配 ANTHROPIC_API_KEY → 装配期拒绝', () => {
    try {
      process.env['AGENT_MODE'] = 'anthropic';
      delete process.env['ANTHROPIC_API_KEY'];
      expect(() => createAgentApp()).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      restoreEnv();
    }
  });

  it('AGENT_MODE=anthropic 即使有 key → 也拒绝（provider 未实现，C2 归后续任务）', () => {
    try {
      process.env['AGENT_MODE'] = 'anthropic';
      process.env['ANTHROPIC_API_KEY'] = 'sk-test';
      expect(() => createAgentApp()).toThrow(/anthropic/);
    } finally {
      restoreEnv();
    }
  });

  it('未知 AGENT_MODE → 装配期拒绝', () => {
    try {
      process.env['AGENT_MODE'] = 'gemini';
      expect(() => createAgentApp()).toThrow(/AGENT_MODE/);
    } finally {
      restoreEnv();
    }
  });
});
