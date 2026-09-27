// 序列定义 + 占位符预检测试（T-P6-01 c 项，先红后绿）。
// 契约出处：DES/07 §1 入参校验逐字 + §2.1 扫描正则 + §2.2 合并语义 + §2.3 推演表
// （实现与测试的共同基准——4 步全分支逐行对照）+ REQ §3 B1 + 解读 #15/#25。
// ""双语义是最高频实现错误（DES/07 §8 风险 1）：vars ""=未提供，stepVars ""=不改——逐行钉死。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { getTestDb, type TestDbHandle } from '../helpers/db.js';
import { seed } from '../../src/db/seed.js';
import { buildApp, type App } from '../../src/http/app.js';
import { createVerifyAccessToken } from '../../src/http/routes/auth.js';
import { resolveSequenceSteps } from '../../src/modules/sequences/resolve.js';
import type { SequenceStepDef } from '../../src/modules/sequences/define.js';
import { AppError } from '../../src/http/plugins/errors.js';

describe('序列定义 + 占位符预检（DES/07 §1/§2 + B1）', () => {
  let db: TestDbHandle;
  let app: App;
  let auth: { authorization: string };

  beforeAll(async () => {
    db = await getTestDb();
    await seed(db.pool);
    app = await buildApp({
      pool: db.pool,
      logger: pino({ enabled: false }),
      verifyAccessToken: createVerifyAccessToken(db.pool),
    });
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'admin' } });
    auth = { authorization: `Bearer ${(res.json() as { accessToken: string }).accessToken}` };
  });
  afterAll(async () => { await app.close(); await db.close(); });
  beforeEach(async () => {
    await db.pool.query(`TRUNCATE "sequence" RESTART IDENTITY CASCADE`);
  });

  const validSteps: SequenceStepDef[] = [
    { index: 1, accountRole: 'admin', text: '预告{event}', delaySeconds: 0 },
    { index: 2, accountRole: 'member', text: '{event} 在 {location}', delaySeconds: 10 },
    { index: 3, accountRole: 'member', text: '地点 {location}', delaySeconds: 5 },
    { index: 4, accountRole: 'admin', text: '{time} 开始', delaySeconds: 0 },
  ];

  it('POST /api/sequences → 201 {id}，steps 原样存快照（不连续 index 合法）', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sequences', headers: auth,
      payload: { name: '发布预告', steps: [{ index: 1, accountRole: 'admin', text: 'a', delaySeconds: 0 }, { index: 10, accountRole: 'member', text: 'b', delaySeconds: 3 }] },
    });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: string }).id;
    const { rows } = await db.pool.query<{ steps: Array<{ index: number }> }>('SELECT steps FROM "sequence" WHERE id=$1', [id]);
    expect(rows[0]?.steps.map((s) => s.index)).toEqual([1, 10]); // 可不连续（§1 逐字）
  });

  it.each([
    ['name 空串', { name: '', steps: validSteps }],
    ['steps 空数组', { name: 'x', steps: [] }],
    ['index 重复', { name: 'x', steps: [validSteps[0], validSteps[0]] }],
    ['index 非正整数', { name: 'x', steps: [{ index: 0, accountRole: 'admin', text: 'a', delaySeconds: 0 }] }],
    ['accountRole 非法', { name: 'x', steps: [{ index: 1, accountRole: 'owner', text: 'a', delaySeconds: 0 }] }],
    ['text 空', { name: 'x', steps: [{ index: 1, accountRole: 'admin', text: '', delaySeconds: 0 }] }],
    ['text 2001 字', { name: 'x', steps: [{ index: 1, accountRole: 'admin', text: 'x'.repeat(2001), delaySeconds: 0 }] }],
    ['delaySeconds 负', { name: 'x', steps: [{ index: 1, accountRole: 'admin', text: 'a', delaySeconds: -1 }] }],
  ])('400 VALIDATION_ERROR：%s', async (_label, payload) => {
    const res = await app.inject({ method: 'POST', url: '/api/sequences', headers: auth, payload });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('定义阶段不做占位符校验：text 含 {time} 仍 201（预检归启动时）', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sequences', headers: auth,
      payload: { name: 'p', steps: [{ index: 1, accountRole: 'admin', text: '{never_provided}', delaySeconds: 0 }] },
    });
    expect(res.statusCode).toBe(201);
  });

  it('DES/07 §2.3 推演表逐行对照 + 步骤 4 {time} → UNRESOLVED_PLACEHOLDER(stepIndex=4,key=time)', async () => {
    const vars = { event: '发布会', location: '', time: '' }; // vars 的 "" = 未提供
    const stepVars: Record<string, Record<string, string>> = {
      '2': { location: '共享盘/Q2' },
      '3': { location: '', event: '' }, // stepVars 的 "" = 不改（继承）
    };
    let caught: AppError | undefined;
    try {
      resolveSequenceSteps({ steps: validSteps, vars, stepVars });
    } catch (e) {
      caught = e as AppError;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught?.code).toBe('UNRESOLVED_PLACEHOLDER');
    expect(caught?.statusCode).toBe(422);
    expect(caught?.extra).toMatchObject({ stepIndex: 4, key: 'time' });
  });

  it('推演表前三步 resolved_vars / var_sources 逐行钉死（varSources 标最初给出者）', async () => {
    // 给 {time} 一个值使预检通过，聚焦快照断言
    const steps = validSteps.slice(0, 3);
    const deduced = resolveSequenceSteps({
      steps,
      vars: { event: '发布会', location: '', time: '' },
      stepVars: { '2': { location: '共享盘/Q2' }, '3': { location: '', event: '' } },
    });
    // step1：vars 的 "" 键已删除；event 来源 default
    expect(deduced[0]).toMatchObject({
      index: 1, resolvedVars: { event: '发布会' }, varSources: { event: 'default' },
    });
    // step2：location 覆盖 → source step:2
    expect(deduced[1]).toMatchObject({
      index: 2, resolvedVars: { event: '发布会', location: '共享盘/Q2' },
      varSources: { event: 'default', location: 'step:2' },
    });
    // step3：两个 "" 都不改——cur 与 source 原样继承（B1 双语义逐字）
    expect(deduced[2]).toMatchObject({
      index: 3, resolvedVars: { event: '发布会', location: '共享盘/Q2' },
      varSources: { event: 'default', location: 'step:2' },
    });
  });

  it('不匹配字符集按字面量：{-}/{a b} 不是占位符（解读 #25）；全部可解析时不抛错', async () => {
    const deduced = resolveSequenceSteps({
      steps: [{ index: 1, accountRole: 'admin', text: 'x {-} {a b} {ok_key}', delaySeconds: 0 }],
      vars: { ok_key: 'v' },
      stepVars: {},
    });
    expect(deduced[0]?.resolvedVars).toEqual({ ok_key: 'v' });
  });

  it('S8 对照：index 升序首个失败步骤返回（step3 引用未提供 key → stepIndex=3）', async () => {
    let caught: AppError | undefined;
    try {
      resolveSequenceSteps({
        steps: [
          { index: 1, accountRole: 'admin', text: '{event}', delaySeconds: 0 },
          { index: 3, accountRole: 'member', text: '{missing}', delaySeconds: 0 },
          { index: 4, accountRole: 'member', text: '{also_missing}', delaySeconds: 0 },
        ],
        vars: { event: 'x' },
        stepVars: {},
      });
    } catch (e) {
      caught = e as AppError;
    }
    expect(caught?.extra).toMatchObject({ stepIndex: 3, key: 'missing' });
  });
});
