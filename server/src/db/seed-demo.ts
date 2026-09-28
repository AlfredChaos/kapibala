// demo 数据播种（用户要求 2026-09-28）：针对运行中的 dev 栈（server + mock-gateway + mock-agent），
// 经公共 API 写入一批示例数据：账号全部 connect → 建两个群（走完整 createJob：invite/join/promote/
// 等 member_joined）→ 预置两条示例序列。全部幂等：已存在的（按平台群号/序列名识别）跳过。
//
// 设计约束：
// - 群不能纯 DB seed——必须经 POST /api/groups 走真流程（网关要有对应群状态，否则 send/agent
//   全是假的；成员 member_joined 事件同理）。这就是它不能像账号那样做 INSERT ON CONFLICT 的原因。
// 用法：pnpm -F server db:seed-demo（可选 BASE=http://localhost:3000 覆盖）。
import { realpathSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const BASE = process.env['BASE'] ?? 'http://localhost:3000';

// ---------- 最小 HTTP 客户端（无第三方依赖） ----------

async function call<T = unknown>(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      // 只在有 body 时声明 JSON——POST 无 body 还挂 content-type 会被 Fastify 拒 400
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 非 JSON 响应：原样回原文 */
  }
  return { status: res.status, body: (parsed ?? text) as T };
}

async function login(): Promise<string> {
  const res = await call<{ accessToken: string }>('POST', '/api/auth/login', null, {
    username: 'admin',
    password: 'admin',
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
}

// ---------- 领域步骤 ----------

async function connectAccount(token: string, accountId: string): Promise<void> {
  const res = await call('POST', `/api/accounts/${accountId}/connect`, token);
  if (res.status !== 200) {
    throw new Error(`connect ${accountId}: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

interface JobView {
  status: 'running' | 'finished' | 'failed';
  errors: Array<{ step: string; code: string }>;
}

async function waitJob(token: string, jobId: string): Promise<JobView> {
  for (let i = 0; i < 90; i += 1) {
    const res = await call<JobView>('GET', `/api/jobs/${jobId}`, token);
    if (res.status === 200 && res.body.status !== 'running') return res.body;
    await delay(500);
  }
  throw new Error(`job ${jobId} did not settle within 45s`);
}

interface GroupRow {
  id: string;
  gatewayGroupId: string | null;
  status: string;
}

/** 幂等锚点：mock-gateway 的群号按创建序 gw-N 递增；用 gatewayGroupId 推断「群已存在」不可靠
 *  （顺序会漂移），改用「至少 N 个 active 群」作为幂等阈值——重跑只补到目标数量。 */
async function ensureGroups(token: string): Promise<{ created: number; total: number }> {
  // 目标演示态：两个 active 群（gw-1: acc-01 群主 + acc-02/03；gw-2: acc-02 群主 + acc-01）。
  // 幂等锚 = active 群数量（gateway 群号 gw-N 是网关侧递增，不映射回定义名）——
  // 已有 ≥2 个 active 群 → 跳过；<2 则补到 2。群成员组合固定（避免部分重复导致不可达态）。
  const TARGETS: ReadonlyArray<{ creatorAccountId: string; memberAccountIds: string[] }> = [
    { creatorAccountId: 'acc-01', memberAccountIds: ['acc-02', 'acc-03'] },
    { creatorAccountId: 'acc-02', memberAccountIds: ['acc-01'] },
  ];

  const list = await call<GroupRow[]>('GET', '/api/groups', token);
  if (list.status !== 200) throw new Error(`list groups: ${list.status}`);
  const activeCount = list.body.filter((g) => g.status === 'active').length;
  const need = Math.max(0, TARGETS.length - activeCount);
  if (need === 0) return { created: 0, total: activeCount };

  // 需要补建的群要先 connect 相关账号（connect 幂等：已 online 直接返回现状）
  const involved = new Set<string>();
  for (const t of TARGETS.slice(0, need)) {
    involved.add(t.creatorAccountId);
    for (const m of t.memberAccountIds) involved.add(m);
  }
  for (const id of involved) await connectAccount(token, id);

  let created = 0;
  for (const t of TARGETS.slice(0, need)) {
    const res = await call<{ jobId: string }>('POST', '/api/groups', token, t);
    if (res.status !== 202) {
      throw new Error(`create group: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const job = await waitJob(token, res.body.jobId);
    if (job.status !== 'finished') {
      throw new Error(`create group job ${res.body.jobId} failed: ${JSON.stringify(job.errors)}`);
    }
    created += 1;
  }
  return { created, total: activeCount + created };
}

interface SeqRow {
  id: string;
  name: string;
}

async function ensureSequences(token: string): Promise<{ created: number; total: number }> {
  // 序列幂等锚 = name（需求未约束唯一性，但演示语义上同名即同物——重跑不产生重复定义）。
  const DEFS: ReadonlyArray<{ name: string; steps: unknown[] }> = [
    {
      name: '开会提醒',
      steps: [
        { index: 1, accountRole: 'admin', text: '{event} 将于 {time} 开始，请提前准备', delaySeconds: 3 },
        { index: 2, accountRole: 'member', text: '提醒：{event} 的资料已上传到 {location}', delaySeconds: 3 },
      ],
    },
    {
      name: '值班交接',
      steps: [
        { index: 1, accountRole: 'admin', text: '{date} 值班开始：{owner}', delaySeconds: 5 },
        { index: 2, accountRole: 'admin', text: '提醒：{owner} 请在 {deadline} 前完成交接', delaySeconds: 5 },
        { index: 3, accountRole: 'member', text: '收到，{date} 值班确认', delaySeconds: 5 },
      ],
    },
  ];

  const list = await call<SeqRow[]>('GET', '/api/sequences', token);
  if (list.status !== 200) throw new Error(`list sequences: ${list.status}`);
  const existing = new Set(list.body.map((s) => s.name));

  let created = 0;
  for (const def of DEFS) {
    if (existing.has(def.name)) continue;
    const res = await call<{ id: string }>('POST', '/api/sequences', token, def);
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`define sequence "${def.name}": ${res.status} ${JSON.stringify(res.body)}`);
    }
    created += 1;
  }
  return { created, total: existing.size + created };
}

// ---------- 消息播种（dashboard 柱图素材） ----------

interface TimelineItemLite {
  readonly msgId: string | null;
  readonly text: string;
}

interface AccountRow {
  readonly id: string;
  readonly status: string;
  readonly platformUserId: string | null;
}

/** 给每个群灌几条消息（己方 POST /send + 外部 emit）——dashboard「近 30 分钟」柱图的数据源。
 *  幂等锚 = 时间线里已有 `msg-seed-*` 前缀的外部消息（msgId 唯一，重跑识别跳过）。 */
async function seedMessages(token: string): Promise<{ sent: number; emitted: number }> {
  const GATEWAY = process.env['GATEWAY_URL'] ?? 'http://localhost:4100';
  const list = await call<GroupRow[]>('GET', '/api/groups', token);
  if (list.status !== 200) throw new Error(`list groups: ${list.status}`);
  const groups = list.body.filter((g) => g.status === 'active' && g.gatewayGroupId !== null);

  const accRes = await call<AccountRow[]>('GET', '/api/accounts', token);
  if (accRes.status !== 200) throw new Error(`list accounts: ${accRes.status}`);
  const online = accRes.body.filter((a) => a.status === 'online' && a.platformUserId !== null);

  let sent = 0;
  let emitted = 0;
  for (const g of groups) {
    const timeline = await call<{ items: TimelineItemLite[] }>(
      'GET',
      `/api/groups/${g.id}/messages?limit=50`,
      token,
    );
    if (timeline.status !== 200) continue;
    const seenMsgIds = new Set(
      timeline.body.items.map((i) => i.msgId).filter((x): x is string => x !== null),
    );
    const seedTag = `msg-seed-${g.id}`;
    if ([...seenMsgIds].some((id) => id.startsWith(seedTag))) continue; // 已灌过

    const sender = online[0];
    if (sender === undefined) continue;

    // 己方消息 → 服务端 POST /send（真流程：queued → dispatcher → sent）
    for (const [i, text] of [
      '组内同步：下午三点的站会照常，麻烦在频道里提前抛风险',
      '收到，我把这个周的变更点整理成列表发上来',
    ].entries()) {
      const res = await call<{ clientMsgId: string }>(
        'POST',
        `/api/groups/${g.id}/send`,
        token,
        { accountId: sender.id, text: `${text}（demo-${i + 1}）` },
      );
      if (res.status === 202 || res.status === 200) sent += 1;
    }

    // 外部消息 → gateway /_test/emit（走 SSE 真通道回灌，server 会入库）
    for (const [i, text] of [
      '有用户反馈新版报表导出慢，麻烦看下',
      '确认下今晚的发布窗口是不是 22:00-23:00',
      '我这边流量打完了，群监控帮我盯到明早',
    ].entries()) {
      const res = await fetch(`${GATEWAY}/_test/emit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'message',
          data: {
            groupId: g.gatewayGroupId,
            msgId: `${seedTag}-in-${i}`,
            senderPlatformUserId: `pu-external-${i}`,
            text: `[外部] ${text}`,
            sentAt: new Date().toISOString(),
          },
        }),
      });
      if (res.ok) emitted += 1;
    }
  }
  return { sent, emitted };
}

// ---------- CLI ----------

async function main(): Promise<void> {
  // 起服探测：server 不在跑就不瞎试（脚本定位是「往活栈写演示数据」，不是脱机 seed）
  const health = await call<{ ok: boolean }>('GET', '/api/health', null).catch(() => null);
  if (health === null || health.status !== 200) {
    throw new Error(`server not reachable at ${BASE} — start with: pnpm dev`);
  }
  const token = await login();
  const groups = await ensureGroups(token);
  const seqs = await ensureSequences(token);
  const msgs = await seedMessages(token);
  console.log(
    `seed-demo done: groups +${groups.created} (active=${groups.total}), sequences +${seqs.created} (total=${seqs.total}), messages sent=${msgs.sent} emitted=${msgs.emitted}`,
  );
}

// 直接执行才跑（同 seed.ts/migrate.ts 的 isDirectRun 约定）
function isDirectRun(): boolean {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((err: unknown) => {
    console.error('seed-demo failed:', err);
    process.exit(1);
  });
}
