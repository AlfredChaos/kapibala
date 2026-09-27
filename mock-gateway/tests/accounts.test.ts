// 账号域契约测试（T-P1-01 c 项，先红后绿）。
// 契约出处：REQ §2.1 账号节；DES/14 §1（eventId 不回退关键坑）、§2（状态模型）、§4（/_test 平面）。
// 进程内装配：createGatewayApp().inject()（DES/14 §7「测试内直接 import 装配」）。
import { describe, expect, it } from 'vitest';
import { assertAccountOperationAllowed } from '../src/accounts.js';
import { createGatewayApp, type GatewayApp } from '../src/app.js';
import { createGatewayState, derivePlatformUserId } from '../src/state.js';

const SEEDS = ['acc-01', 'acc-02', 'acc-03', 'acc-04'] as const;

function newApp(): GatewayApp {
  return createGatewayApp({ seedAccountIds: SEEDS });
}

async function connect(app: GatewayApp, accountId: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: `/accounts/${accountId}/connect` });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { platformUserId: string };
  return body.platformUserId;
}

describe('connect：确定性 platformUserId（REQ §2.1）', () => {
  it('同一 accountId 两次 connect 返回同一个 platformUserId', async () => {
    const app = newApp();
    await expect(connect(app, 'acc-01')).resolves.toBe(await connect(app, 'acc-01'));
  });

  it('不同账号派生不同 puid；派生是 accountId 的纯函数', async () => {
    const app = newApp();
    const puid1 = await connect(app, 'acc-01');
    const puid2 = await connect(app, 'acc-02');
    expect(puid1).not.toBe(puid2);
    expect(puid1).toBe(derivePlatformUserId('acc-01'));
  });

  it('reset 后重连 puid 不变（确定性派生，不随状态清空而漂移）', async () => {
    const app = newApp();
    const before = await connect(app, 'acc-03');
    await app.inject({ method: 'POST', url: '/_test/reset' });
    const after = await connect(app, 'acc-03');
    expect(after).toBe(before);
  });
});

describe('disconnect 与五操作闸门（REQ §2.1：send/join/promote/kick/leave → 409 ACCOUNT_OFFLINE）', () => {
  it('connect → disconnect → 200；此后账号不可用（409 ACCOUNT_OFFLINE）', async () => {
    const app = newApp();
    await connect(app, 'acc-01');
    const res = await app.inject({ method: 'POST', url: '/accounts/acc-01/disconnect' });
    expect(res.statusCode).toBe(200);

    // 五操作共享同一闸门（switch 17：未 connect / 已 disconnect → 409）
    const state = app.gatewayState;
    expect(assertAccountOperationAllowed(state, 'acc-01')).toEqual({
      statusCode: 409,
      body: { code: 'ACCOUNT_OFFLINE', message: expect.any(String) },
    });
  });

  it('从未 connect 的账号同样 409（未 connect 视同离线）', () => {
    const state = createGatewayState(SEEDS);
    expect(assertAccountOperationAllowed(state, 'acc-04')).toEqual({
      statusCode: 409,
      body: { code: 'ACCOUNT_OFFLINE', message: expect.any(String) },
    });
  });

  it('online 账号放行（返回 null）', async () => {
    const app = newApp();
    await connect(app, 'acc-02');
    expect(assertAccountOperationAllowed(app.gatewayState, 'acc-02')).toBeNull();
  });
});

describe('终态账号：任何请求恒同码，含 connect（REQ §2.1 / 开关 11、12）', () => {
  it('account_suspended_403 → connect 得 403 ACCOUNT_SUSPENDED，闸门同码', async () => {
    const app = newApp();
    await app.inject({
      method: 'POST',
      url: '/_test/scenario',
      payload: { switch: 'account_suspended_403', target: { accountId: 'acc-01' } },
    });
    const res = await app.inject({ method: 'POST', url: '/accounts/acc-01/connect' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
    expect(assertAccountOperationAllowed(app.gatewayState, 'acc-01')).toMatchObject({
      statusCode: 403,
      body: { code: 'ACCOUNT_SUSPENDED' },
    });
  });

  it('session_expired_401 → connect 得 401 SESSION_EXPIRED', async () => {
    const app = newApp();
    await app.inject({
      method: 'POST',
      url: '/_test/scenario',
      payload: { switch: 'session_expired_401', target: { accountId: 'acc-02' } },
    });
    const res = await app.inject({ method: 'POST', url: '/accounts/acc-02/connect' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'SESSION_EXPIRED' });
  });

  it('scenario/clear 后恢复可 connect（终态由开关 arrange，可撤销）', async () => {
    const app = newApp();
    await app.inject({
      method: 'POST',
      url: '/_test/scenario',
      payload: { switch: 'account_suspended_403', target: { accountId: 'acc-01' } },
    });
    await app.inject({
      method: 'POST',
      url: '/_test/scenario/clear',
      payload: { switch: 'account_suspended_403' },
    });
    const res = await app.inject({ method: 'POST', url: '/accounts/acc-01/connect' });
    expect(res.statusCode).toBe(200);
  });
});

describe('/_test/reset：清业务状态与账本，eventId 计数器不回退（DES/14 §1 关键坑）', () => {
  it('emit 后 reset，再 emit 的 eventId 继续递增而非复用', async () => {
    const app = newApp();
    const first = await app.inject({
      method: 'POST',
      url: '/_test/emit',
      payload: { type: 'account_status', data: { accountId: 'acc-01', status: 'suspended' } },
    });
    expect((first.json() as { eventId: number }).eventId).toBe(1);

    await app.inject({ method: 'POST', url: '/_test/reset' });
    const second = await app.inject({
      method: 'POST',
      url: '/_test/emit',
      payload: { type: 'account_status', data: { accountId: 'acc-01', status: 'suspended' } },
    });
    expect((second.json() as { eventId: number }).eventId).toBe(2);
  });

  it('{ startEventId } 只抬高、不回退：低于当前值被忽略', async () => {
    const app = newApp();
    // 抬到 500
    await app.inject({ method: 'POST', url: '/_test/reset', payload: { startEventId: 500 } });
    const raised = await app.inject({
      method: 'POST',
      url: '/_test/emit',
      payload: { type: 'message_failed', data: { clientMsgId: 'c1', code: 'ACCOUNT_SUSPENDED' } },
    });
    expect((raised.json() as { eventId: number }).eventId).toBe(501);

    // 试图回退到 1 → 无效
    await app.inject({ method: 'POST', url: '/_test/reset', payload: { startEventId: 1 } });
    const next = await app.inject({
      method: 'POST',
      url: '/_test/emit',
      payload: { type: 'message_failed', data: { clientMsgId: 'c2', code: 'ACCOUNT_SUSPENDED' } },
    });
    expect((next.json() as { eventId: number }).eventId).toBe(502);
  });

  it('reset 恢复种子账号初始 offline 状态', async () => {
    const app = newApp();
    await connect(app, 'acc-04');
    await app.inject({ method: 'POST', url: '/_test/reset' });
    expect(assertAccountOperationAllowed(app.gatewayState, 'acc-04')).toMatchObject({
      statusCode: 409,
    });
  });
});

describe('/_test/counters：验收断言的真值来源（DES/14 §4）', () => {
  it('初始形状：五个计数全零', async () => {
    const app = newApp();
    const res = await app.inject({ method: 'GET', url: '/_test/counters' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      sendCallsByAccount: {},
      sendCallsByClientMsgId: {},
      landedMessages: 0,
      kickCalls: 0,
      framesEmitted: 0,
    });
  });

  it('framesEmitted 随 emit 递增；reset 清零（计数器重置）', async () => {
    const app = newApp();
    await app.inject({
      method: 'POST',
      url: '/_test/emit',
      payload: { type: 'account_status', data: { accountId: 'acc-01', status: 'suspended' } },
    });
    await app.inject({
      method: 'POST',
      url: '/_test/emit',
      payload: { type: 'account_status', data: { accountId: 'acc-02', status: 'session_expired' } },
    });
    const before = (await app.inject({ method: 'GET', url: '/_test/counters' })).json() as {
      framesEmitted: number;
    };
    expect(before.framesEmitted).toBe(2);

    await app.inject({ method: 'POST', url: '/_test/reset' });
    const after = (await app.inject({ method: 'GET', url: '/_test/counters' })).json() as {
      framesEmitted: number;
    };
    expect(after.framesEmitted).toBe(0);
  });
});

describe('/_test 平面入参校验', () => {
  it('未知 switch → 400；合法 switch → 200', async () => {
    const app = newApp();
    const bad = await app.inject({
      method: 'POST',
      url: '/_test/scenario',
      payload: { switch: 'not_a_real_switch' },
    });
    expect(bad.statusCode).toBe(400);

    const good = await app.inject({
      method: 'POST',
      url: '/_test/scenario',
      payload: { switch: 'rate_limit', target: { accountId: 'acc-01' }, params: { retryAfterSeconds: 30 } },
    });
    expect(good.statusCode).toBe(200);
  });

  it('emit 的 type 必须是契约六类之一，未知 → 400', async () => {
    const app = newApp();
    const res = await app.inject({
      method: 'POST',
      url: '/_test/emit',
      payload: { type: 'whatever', data: {} },
    });
    expect(res.statusCode).toBe(400);
  });

  it('emit 回帧：data 合入 eventId 与 type（SSE 帧契约：data 同时带两字段）', async () => {
    const app = newApp();
    const res = await app.inject({
      method: 'POST',
      url: '/_test/emit',
      payload: { type: 'member_left', data: { groupId: 'gw-1', platformUserId: 'puid-x' } },
    });
    expect(res.statusCode).toBe(200);
    // 回整帧（含 mock 内部 emittedAt）；契约关键字段用 toMatchObject 断言
    expect(res.json()).toMatchObject({
      eventId: 1,
      type: 'member_left',
      data: { groupId: 'gw-1', platformUserId: 'puid-x', eventId: 1, type: 'member_left' },
    });
    expect(typeof (res.json() as { emittedAt: number }).emittedAt).toBe('number');
  });
});

describe('T-P1-01 review：空 body 防护与未知 target 拒绝', () => {
  it('scenario / emit 空 body → 400（校验错误），不是 500 TypeError', async () => {
    const app = newApp();
    const scenario = await app.inject({ method: 'POST', url: '/_test/scenario' });
    expect(scenario.statusCode).toBe(400);
    expect((scenario.json() as { message: string }).message).toContain('unknown switch');

    const emit = await app.inject({ method: 'POST', url: '/_test/emit' });
    expect(emit.statusCode).toBe(400);
    expect((emit.json() as { message: string }).message).toContain('six contract event types');
  });

  it('scenario/clear 空 body = 清除全部开关（200，设计语义而非 400）', async () => {
    const app = newApp();
    await app.inject({
      method: 'POST',
      url: '/_test/scenario',
      payload: { switch: 'account_suspended_403', target: { accountId: 'acc-01' } },
    });
    const res = await app.inject({ method: 'POST', url: '/_test/scenario/clear' });
    expect(res.statusCode).toBe(200);
    // 开关已清：终态随之撤销（connect 恢复可用）
    const connect = await app.inject({ method: 'POST', url: '/accounts/acc-01/connect' });
    expect(connect.statusCode).toBe(200);
  });

  it('账号域开关指向不存在的账号 → 400 且开关不登记（arrange 期失败，不静默无效）', async () => {
    const app = newApp();
    const res = await app.inject({
      method: 'POST',
      url: '/_test/scenario',
      payload: { switch: 'account_suspended_403', target: { accountId: 'acc-99' } },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { message: string }).message).toContain('unknown target account: acc-99');
    // 半生效防护：拒绝后开关未登记（clear 该开关是无害 no-op，但 switches 表应为空）
    expect(app.gatewayState.switches.size).toBe(0);
    expect(app.gatewayState.accounts.has('acc-99')).toBe(false); // 不自动建号
  });
});
