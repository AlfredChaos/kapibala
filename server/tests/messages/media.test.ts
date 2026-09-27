// 媒体落盘与清理（T-P8-01；REQ C1、DES/05 §7、DES/02 §5.1、QR §1 30 天、解读 #6）。
// 契约逐字断言：
//   a) message.mediaUrl 非空 → 下载到 media/<msgId> → 事务回填 local_file_path（幂等覆盖写）；
//   b) GET /media/:id 过期 404 → local_file_path 保持 NULL + ws_event inconsistency{kind:'media_expired'}；
//   c) 每日清理：created_at 超 retention（默认 30d）且所在群无 running run → 删文件 + 同事务置空
//      （「删除后不能留下指向已删文件的记录」）；群有 running run → 跳过该群全部待删文件；
//   d) 下载失败指数退避（不阻塞、不重试风暴、不算过期）。
// 装配：E2E 两例走 startScenarioEnv（真 PG + 双 mock + 真实 boot——调度器自己干活）；
//      退避/清理/幂等例直调扫描体（假 gateway / 临时目录——确定性时序，不等 1s tick）。
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { GatewayError } from '../../src/gateway/errors.js';
import {
  createMediaCleanupScan,
  createMediaDownloadScan,
} from '../../src/modules/messages/media.js';
import { withTestDb } from '../helpers/db.js';
import {
  armSwitch,
  sendMessage,
  setupGroup,
  startScenarioEnv,
  waitFor,
  type ScenarioEnv,
} from '../helpers/env.js';

const NO_LOG = {
  info: (_o: unknown, _m?: string) => {},
  warn: (_o: unknown, _m?: string) => {},
  error: (_o: unknown, _m?: string) => {},
};

function makeDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'media-test-'));
}


async function addGroup(pool: Pool, gwGroupId: string): Promise<string> {
  // group.creator_account_id 有 FK——直插场景（不经 seed）需要先落账号行
  await pool.query(
    `INSERT INTO account (id, status, platform_user_id) VALUES ('acc-01', 'online', 'pu-acc-01')
     ON CONFLICT (id) DO NOTHING`,
  );
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO "group" (id, creator_account_id, status, gateway_group_id)
     VALUES (gen_random_uuid(), 'acc-01', 'active', $1) RETURNING id`,
    [gwGroupId],
  );
  return rows[0]?.id as string;
}

describe('媒体落盘（C1 / DES/05 §7）', () => {
  it('带 mediaUrl 的回流消息 → 调度器下载字节到 media/<msgId> 并回填 local_file_path', async () => {
    const env: ScenarioEnv = await startScenarioEnv();
    try {
      const group = await setupGroup(env, { creator: 'acc-01', members: ['acc-02'] });
      await armSwitch(env, 'send_accept_slow', undefined, { delayMs: 0 });
      await armSwitch(env, 'message_sent_delay', undefined, { delayMs: 0 });
      await armSwitch(env, 'media_message'); // gw-27：落地消息带绝对 mediaUrl

      const clientMsgId = await sendMessage(env, group.dbGroupId, {
        accountId: 'acc-01',
        text: 'with media',
      });
      // 等回流把 media_url 写进行（账本序：message_sent 先、message 后——同连接序消费）
      await waitFor(async () => {
        const { rows } = await env.pool.query<{ media_url: string | null }>(
          `SELECT media_url FROM message WHERE client_msg_id=$1`,
          [clientMsgId],
        );
        return rows[0]?.media_url != null;
      });
      // boot 内 1s-tick 的 media-download 扫描落盘 + 回填——真管线自己走完
      await waitFor(async () => {
        const { rows } = await env.pool.query<{ local_file_path: string | null }>(
          `SELECT local_file_path FROM message WHERE client_msg_id=$1`,
          [clientMsgId],
        );
        return rows[0]?.local_file_path != null;
      }, 12_000);

      const { rows } = await env.pool.query<{
        local_file_path: string | null;
        media_url: string | null;
        msg_id: string | null;
      }>(`SELECT local_file_path, media_url, msg_id FROM message WHERE client_msg_id=$1`, [
        clientMsgId,
      ]);
      const row = rows[0];
      expect(row?.local_file_path).not.toBeNull();
      const bytes = await readFile(row?.local_file_path as string);
      expect(bytes.toString('utf8')).toContain(`data-media-id="${row?.msg_id}"`); // 下到的是这一个
      expect(row?.media_url).toContain(`${env.gatewayUrl}/media/`); // 绝对 URL 契约
    } finally {
      await env.close();
    }
  }, 45_000);

  it('过期 404 → local_file_path 保持 NULL + inconsistency{kind:media_expired}（只推一次）', async () => {
    const env: ScenarioEnv = await startScenarioEnv();
    try {
      const group = await setupGroup(env, { creator: 'acc-01', members: ['acc-02'] });
      // gw-27 双开关：落地带 mediaUrl + 该媒体立即过期（GET /media/:id 恒 404）
      await armSwitch(env, 'media_message');
      await armSwitch(env, 'media_expire_404');
      await armSwitch(env, 'send_accept_slow', undefined, { delayMs: 0 });
      await armSwitch(env, 'message_sent_delay', undefined, { delayMs: 0 });

      const clientMsgId = await sendMessage(env, group.dbGroupId, {
        accountId: 'acc-01',
        text: 'expired media',
      });
      await waitFor(async () => {
        const { rows } = await env.pool.query<{ media_url: string | null }>(
          `SELECT media_url FROM message WHERE client_msg_id=$1`,
          [clientMsgId],
        );
        return rows[0]?.media_url != null;
      });

      // 判定面是 ws_event 行而非日志
      await waitFor(async () => {
        const { rows } = await env.pool.query<{ n: number }>(
          `SELECT count(*) AS n FROM ws_event
            WHERE type='inconsistency' AND payload->>'kind'='media_expired'`,
        );
        return Number(rows[0]?.n) >= 1;
      }, 12_000);

      const { rows } = await env.pool.query<{ local_file_path: string | null }>(
        `SELECT local_file_path FROM message WHERE client_msg_id=$1`,
        [clientMsgId],
      );
      expect(rows[0]?.local_file_path).toBeNull(); // 过期不置路径（§7 逐字）

      // 已盖「过期」戳的行退出下载扫描谓词：跨 ≥2 个 tick 后 inconsistency 仍恰一条
      await new Promise((r) => setTimeout(r, 2600));
      const { rows: cnt } = await env.pool.query<{ n: number }>(
        `SELECT count(*) AS n FROM ws_event
          WHERE type='inconsistency' AND payload->>'kind'='media_expired'`,
      );
      expect(Number(cnt[0]?.n)).toBe(1);
    } finally {
      await env.close();
    }
  }, 45_000);

  it('下载失败指数退避：不写路径、不推 inconsistency、退避期内不重试', async () => {
    await withTestDb(async (pool) => {
      const dir = await makeDir();
      const groupId = await addGroup(pool, 'gw-x');
      await pool.query(
        `INSERT INTO message (group_id, msg_id, sender_platform_user_id, is_own, source, text, sent_at, media_url)
         VALUES ($1, 'm-fail', 'pu-1', false, 'inbound', 'x', now(), 'http://gw/media/m-fail')`,
        [groupId],
      );

      let calls = 0;
      const scan = createMediaDownloadScan({
        pool,
        gateway: {
          async downloadMedia(): Promise<Uint8Array> {
            calls += 1;
            throw new Error('network down'); // 非 404（网络层）→ 退避，不算过期
          },
        },
        logger: NO_LOG,
        mediaDir: dir,
        retryBaseMs: 200, // 测试基数：200 → 400 → …
      });

      await scan(); // 第 1 次失败
      expect(calls).toBe(1);
      await scan(); // 退避期内不再调用
      await scan();
      expect(calls).toBe(1);

      await new Promise((r) => setTimeout(r, 260));
      await scan(); // 过首轮退避 → 第 2 次尝试（再失败则 400ms）
      expect(calls).toBe(2);
      await scan();
      expect(calls).toBe(2);

      const { rows } = await pool.query<{ local_file_path: string | null }>(
        `SELECT local_file_path FROM message WHERE msg_id='m-fail'`,
      );
      expect(rows[0]?.local_file_path).toBeNull();
      const { rows: ev } = await pool.query<{ n: number }>(
        `SELECT count(*) AS n FROM ws_event WHERE type='inconsistency'`,
      );
      expect(Number(ev[0]?.n)).toBe(0); // 网络失败 ≠ 过期
    });
  });

  it('404 与成功隔离：同批里过期行盖戳、正常行落盘互不影响', async () => {
    await withTestDb(async (pool) => {
      const dir = await makeDir();
      const groupId = await addGroup(pool, 'gw-x');
      for (const msgId of ['m-404', 'm-ok2']) {
        await pool.query(
          `INSERT INTO message (group_id, msg_id, sender_platform_user_id, is_own, source, text, sent_at, media_url)
           VALUES ($1, $2, 'pu-1', false, 'inbound', 'x', now(), 'http://gw/media/' || $2)`,
          [groupId, msgId],
        );
      }
      const scan = createMediaDownloadScan({
        pool,
        gateway: {
          downloadMedia: async (url: string) => {
            if (url.endsWith('m-404')) {
              // GatewayError{status:404}——client.downloadMedia 的真实失败形状
              throw new GatewayError({ endpoint: 'media', status: 404, code: 'NOT_FOUND' });
            }
            return new TextEncoder().encode('ok-bytes');
          },
        },
        logger: NO_LOG,
        mediaDir: dir,
      });

      await scan();
      const { rows } = await pool.query<{ msg_id: string; local_file_path: string | null }>(
        `SELECT msg_id, local_file_path FROM message WHERE msg_id IN ('m-404','m-ok2') ORDER BY msg_id`,
      );
      expect(rows[0]?.local_file_path).toBeNull(); // m-404 只盖戳
      expect(rows[1]?.local_file_path).toBe(path.join(dir, 'm-ok2')); // m-ok2 落盘
      const { rows: ev } = await pool.query<{ n: number }>(
        `SELECT count(*) AS n FROM ws_event WHERE type='inconsistency' AND payload->>'kind'='media_expired'`,
      );
      expect(Number(ev[0]?.n)).toBe(1); // 只为 404 行推一条
      expect((await readFile(path.join(dir, 'm-ok2'))).toString('utf8')).toBe('ok-bytes');
    });
  });

  it('下载幂等：已回填的行退出谓词（不再调用网关）', async () => {
    await withTestDb(async (pool) => {
      const dir = await makeDir();
      const groupId = await addGroup(pool, 'gw-x');
      await pool.query(
        `INSERT INTO message (group_id, msg_id, sender_platform_user_id, is_own, source, text, sent_at, media_url)
         VALUES ($1, 'm-ok', 'pu-1', false, 'inbound', 'x', now(), 'http://gw/media/m-ok')`,
        [groupId],
      );

      let calls = 0;
      const scan = createMediaDownloadScan({
        pool,
        gateway: {
          async downloadMedia(): Promise<Uint8Array> {
            calls += 1;
            return new TextEncoder().encode('payload-m-ok');
          },
        },
        logger: NO_LOG,
        mediaDir: dir,
      });

      await scan();
      expect(calls).toBe(1);
      const { rows } = await pool.query<{ local_file_path: string }>(
        `SELECT local_file_path FROM message WHERE msg_id='m-ok'`,
      );
      expect(rows[0]?.local_file_path).toBe(path.join(dir, 'm-ok'));

      await scan();
      await scan();
      expect(calls).toBe(1); // 谓词排除已回填行
    });
  });

  it('清理：超 retention 且群无 running run 才删（文件+同事务置空）；running 群整体跳过；幂等', async () => {
    await withTestDb(async (pool) => {
      const dir = await makeDir();
      const idA = await addGroup(pool, 'gw-a'); // 无 running run → 该删
      const idB = await addGroup(pool, 'gw-b'); // 有 running run → 整体跳过（解读 #6）
      const idC = await addGroup(pool, 'gw-c'); // 未到期 → 不动

      async function addMedia(groupId: string, msgId: string, ageDays: number): Promise<string> {
        const file = path.join(dir, msgId);
        await writeFile(file, `bytes-${msgId}`);
        await pool.query(
          `INSERT INTO message (group_id, msg_id, sender_platform_user_id, is_own, source, text, sent_at, media_url, local_file_path, created_at)
           VALUES ($1, $2, 'pu-1', false, 'inbound', 'x',
                   now() - ($3 || ' days')::interval, 'http://gw/media/' || $2, $4,
                   now() - ($3 || ' days')::interval)`,
          [groupId, msgId, `${ageDays}`, file],
        );
        return file;
      }
      const fileA = await addMedia(idA, 'm-old-a', 40);
      const fileB = await addMedia(idB, 'm-old-b', 40);
      const fileC = await addMedia(idC, 'm-new-c', 2);
      await pool.query(
        `INSERT INTO agent_run (id, group_id, status, trigger_context)
         VALUES (gen_random_uuid(), $1, 'running', '{}'::jsonb)`,
        [idB],
      );

      const cleanup = createMediaCleanupScan({
        pool,
        logger: NO_LOG,
        retentionDays: 30,
      });
      const removed = await cleanup();
      expect(removed).toBe(1); // 只有 A

      // A：文件已删 + 指针同事务置空（「删除后不能留下指向已删文件的记录」）
      await expect(stat(fileA)).rejects.toMatchObject({ code: 'ENOENT' });
      const { rows: a } = await pool.query<{ local_file_path: string | null }>(
        `SELECT local_file_path FROM message WHERE msg_id='m-old-a'`,
      );
      expect(a[0]?.local_file_path).toBeNull();

      // B：running run 保护——文件、指针原样
      await stat(fileB);
      const { rows: b } = await pool.query<{ local_file_path: string | null }>(
        `SELECT local_file_path FROM message WHERE msg_id='m-old-b'`,
      );
      expect(b[0]?.local_file_path).toBe(fileB);

      // C：未到期不动
      await stat(fileC);
      const { rows: c } = await pool.query<{ local_file_path: string | null }>(
        `SELECT local_file_path FROM message WHERE msg_id='m-new-c'`,
      );
      expect(c[0]?.local_file_path).toBe(fileC);

      expect(await cleanup()).toBe(0); // 幂等：第二轮零工作项
    });
  });
});
