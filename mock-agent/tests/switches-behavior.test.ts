// ag-8..16/18 行为类开关测试（T-P4-03 c 项，先红后绿）。
// 契约出处：REQ §2.2 行为清单（拿到 send_message 结果后用同一 idempotency_key 再调；
// 一直调工具不结束；连续同参 get_recent_messages；limit:100000；响应约 8s 或更久甚至不返回；
// audit 500 / 200 坏 body / 慢 / 不返回）；DES/12 §7 行 8–16/18（audit 慢/挂为确定性时长如 6s；
// same_runid_redispatch = 恢复重发规约）；QR §1（~8s 行：慢于普通但仍可能落在后端 10–15s 超时内）。
// 时序说明：真实定时器。慢/挂用例不真等 8s/6s 全量——用 params.delayMs 钉小验证「会延迟」，
// 未钉档用「竞速沉降窗内仍 pending」验证「显著慢/不返回」（定时器 unref，不拖进程退出）。
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@kapibala/contract';
import {
  arm,
  clearScenario,
  expectToolUse,
  newApp,
  toolResultMsg,
  toolUseMsg,
  triggerContext,
  turn,
  type InjectLike,
} from './helpers/agent.js';
import type { AgentApp } from '../src/app.js';

async function audit(app: AgentApp): Promise<InjectLike> {
  return app.inject({ method: 'POST', url: '/agent/audit', payload: { text: 'x', groupId: 'g-1' } });
}

/** 竞速：ms 内未落定返回 'pending'（定时器/未决 promise 都不留活口——实现侧 unref） */
async function pendingOrResolved<T>(p: Promise<T>, ms: number): Promise<'pending' | T> {
  return Promise.race([p, sleep(ms).then(() => 'pending' as const)]);
}

describe('ag-8 send_timeout_key_retry：拿到 send_message 结果后用同一 idempotency_key 再调（REQ §2.2 行为 4 / S5）', () => {
  it('历史里有已完成的 send_message → 下一轮重新 send_message 且 idempotency_key 逐字复用', async () => {
    const app = newApp();
    await arm(app, 'send_timeout_key_retry');
    const messages: AgentMessage[] = [triggerContext()];

    // 剧本前两步照常（开关只在「已有 send 结果」时改注入）
    const tu1 = await expectToolUse(await turn(app, 'r-1', messages));
    expect(tu1.name).toBe('get_recent_messages');
    messages.push(toolUseMsg(tu1), toolResultMsg(tu1.id, { messages: [], truncated: false }));
    const tu2 = await expectToolUse(await turn(app, 'r-1', messages));
    expect(tu2.name).toBe('send_message');
    const firstKey = tu2.input['idempotency_key'];
    messages.push(toolUseMsg(tu2), toolResultMsg(tu2.id, { clientMsgId: 'c-1', deliveryStatus: 'sent' }));

    // 关键注入：第三轮不是 finish，而是同 key 重发
    const tu3 = await expectToolUse(await turn(app, 'r-1', messages));
    expect(tu3.name).toBe('send_message');
    expect(tu3.input['idempotency_key']).toBe(firstKey);
    expect(tu3.id).not.toBe(tu2.id); // 重试用新 tool_use.id（REQ §2.2：合法重试换新 id）
  });

  it('SEND_TIMEOUT 错误结果同样触发重发（REQ §2.2 点名场景）', async () => {
    const app = newApp();
    await arm(app, 'send_timeout_key_retry');
    const sentUse: AgentMessage = toolUseMsg({
      type: 'tool_use',
      id: 'tu_x',
      name: 'send_message',
      input: { text: 'hi', idempotency_key: 'k-timeout' },
    });
    const timeoutResult = toolResultMsg('tu_x', { code: 'SEND_TIMEOUT', message: 'unknown' });
    (timeoutResult.content[0] as { is_error?: boolean }).is_error = true;
    const tu = await expectToolUse(await turn(app, 'r-1', [triggerContext(), sentUse, timeoutResult]));
    expect(tu.name).toBe('send_message');
    expect(tu.input['idempotency_key']).toBe('k-timeout');
  });
});

describe('ag-9 endless_tools / ag-10 repeat_get_recent / ag-11 huge_limit（REQ §2.2 行为 5/6）', () => {
  it('ag-9：一直调工具不结束——四轮全是 tool_use 且无 finish/end_turn', async () => {
    const app = newApp();
    await arm(app, 'endless_tools');
    const messages: AgentMessage[] = [triggerContext()];
    const seen: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const tu = await expectToolUse(await turn(app, 'r-1', messages));
      seen.push(tu.name);
      // 喂一个成功结果驱动历史前进（send_message 每次新 key → 不同 clientMsgId）
      messages.push(
        toolUseMsg(tu),
        toolResultMsg(tu.id, tu.name === 'send_message' ? { clientMsgId: `c-${i}`, deliveryStatus: 'sent' } : { messages: [], truncated: false }),
      );
    }
    expect(seen).not.toContain('finish');
    expect(new Set(seen).size).toBeGreaterThan(1); // 「调工具」不是单调复读同一调用（ag-10 才是）
  });

  it('ag-10：连续同样入参调 get_recent_messages', async () => {
    const app = newApp();
    await arm(app, 'repeat_get_recent');
    const messages: AgentMessage[] = [triggerContext()];
    for (let i = 0; i < 3; i += 1) {
      const tu = await expectToolUse(await turn(app, 'r-1', messages));
      expect(tu.name).toBe('get_recent_messages');
      expect(tu.input).toEqual({ limit: 10 }); // 逐字同参
      messages.push(toolUseMsg(tu), toolResultMsg(tu.id, { messages: [], truncated: false }));
    }
  });

  it('ag-11：get_recent_messages { limit: 100000 }（REQ §2.2 逐字数字）', async () => {
    const app = newApp();
    await arm(app, 'huge_limit');
    const tu = await expectToolUse(await turn(app, 'r-1', [triggerContext()]));
    expect(tu.name).toBe('get_recent_messages');
    expect(tu.input['limit']).toBe(100000);
  });
});

describe('ag-12 slow_turn / ag-13 hang_turn（REQ §2.2 行为 7；QR §1 ~8s 行）', () => {
  it('ag-12 钉 delayMs：响应延迟 ≥ 钉值且内容照常合法', async () => {
    const app = newApp();
    await arm(app, 'slow_turn', { delayMs: 150 });
    const started = Date.now();
    const tu = await expectToolUse(await turn(app, 'r-1', [triggerContext()]));
    expect(Date.now() - started).toBeGreaterThanOrEqual(140); // 留调度抖动余量
    expect(tu.name).toBe('get_recent_messages'); // 慢但不坏：延迟后走正常路径
  });

  it('ag-12 未钉参数：1.5s 内仍 pending（默认 ~8s，落在后端 10–15s 窗口内的一侧证据）', async () => {
    const app = newApp();
    await arm(app, 'slow_turn');
    const res = await pendingOrResolved(turn(app, 'r-1', [triggerContext()]), 1500);
    expect(res).toBe('pending');
  });

  it('ag-13：一直不返回；定向 runId 时别的 run 正常', async () => {
    const app = newApp();
    await arm(app, 'hang_turn', undefined, { runId: 'r-hit' });
    const res = await pendingOrResolved(turn(app, 'r-hit', [triggerContext()]), 400);
    expect(res).toBe('pending');
    // 未命中 target 的请求不受拖累
    const tu = await expectToolUse(await turn(app, 'r-other', [triggerContext()]));
    expect(tu.name).toBe('get_recent_messages');
  });
});

describe('ag-14/15/16 audit 故障面（REQ §2.2 行为 8：500 / 坏 body / 慢 / 不返回）', () => {
  it('ag-14 audit_500：audit → 500', async () => {
    const app = newApp();
    await arm(app, 'audit_500');
    const res = await audit(app);
    expect(res.statusCode).toBe(500);
    // turn 不受 audit 开关影响
    const tu = await expectToolUse(await turn(app, 'r-1', [triggerContext()]));
    expect(tu.name).toBe('get_recent_messages');
  });

  it('ag-15 audit_bad_body 三形态：非 JSON（默认）/ 缺 verdict / verdict 为别的值', async () => {
    const app = newApp();
    await arm(app, 'audit_bad_body');
    const nonJson = await audit(app);
    expect(nonJson.statusCode).toBe(200);
    expect(() => JSON.parse(nonJson.payload)).toThrow();

    await arm(app, 'audit_bad_body', { variant: 'no_verdict' });
    const noVerdict = (await (await audit(app)).json()) as Record<string, unknown>;
    expect(noVerdict['verdict']).toBeUndefined();

    await arm(app, 'audit_bad_body', { variant: 'wrong_verdict' });
    const wrong = (await (await audit(app)).json()) as { verdict: string };
    expect(['pass', 'fail']).not.toContain(wrong.verdict);
  });

  it('ag-16 audit_slow 钉值延迟 + audit_hang 不返回（确定性时长，DES/12 §7 注）', async () => {
    const app = newApp();
    await arm(app, 'audit_slow', { delayMs: 150 });
    const started = Date.now();
    const res = await audit(app);
    expect(res.statusCode).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect((await res.json()) as { verdict: string }).toMatchObject({ verdict: 'pass' });

    await arm(app, 'audit_hang');
    expect(await pendingOrResolved(audit(app), 400)).toBe('pending');
    // clear 恢复确定性 pass
    await clearScenario(app, 'audit_hang');
    await clearScenario(app, 'audit_slow');
    const ok = await audit(app);
    expect(ok.statusCode).toBe(200);
  });
});

describe('ag-18 same_runid_redispatch：同 runId 相同 messages 重复请求 → 新响应（恢复重发规约）', () => {
  it('开关开时重复请求仍返回全新合法响应（新 tool_use.id，语义不因重发错位）', async () => {
    const app = newApp();
    await arm(app, 'same_runid_redispatch');
    const messages = [triggerContext()];
    const first = await expectToolUse(await turn(app, 'r-1', messages));
    const second = await expectToolUse(await turn(app, 'r-1', messages));
    expect(second.id).not.toBe(first.id);
    expect(second.name).toBe(first.name); // 同一历史推出同一下一步
  });
});
