// 媒体落盘与清理（T-P8-01；REQ C1、DES/05 §7、DES/02 §5.1、解读 #6、QR §1 30 天行）。
//
// 两个独立扫描体（注册行进 scheduler/media-scan.ts）：
//
// 一、下载（registry 1s tick 每轮调）：media_url 非空且 local_file_path 为 NULL 且未盖
//   「过期」戳的行 → gateway.downloadMedia(mediaUrl) → 写 media/<msgId> → 事务回填
//   local_file_path（条件 UPDATE WHERE local_file_path IS NULL——幂等，重复任务覆盖写无害）。
//   - 404 = 过期（REQ §2.1「过期后返回 404」）：local_file_path 保持 NULL + 推
//     ws_event inconsistency{kind:'media_expired'}；**只推一次**——「已盖戳」由 ws_event
//     行本身做真值（NOT EXISTS 谓词 + INSERT ... WHERE NOT EXISTS 双保险），该行随后
//     退出下载谓词不再重试；
//   - 其它失败（网络/超时/5xx）：指数退避（base 500ms ×2，30s 封顶）——退避态在内存
//     Map<msgId, notBefore>，只影响重试节奏不写库；下载绝不阻塞事件消费（本扫描本就在
//     消费循环之外，逐行 try/catch 单行失败不拖整批）。
//
// 二、清理（内部节流每日）：created_at 早于 retention（默认 MEDIA_RETENTION_DAYS=30，
//   config.mediaRetentionDays 可配）→ 但该群存在 running agent_run → 跳过该群全部
//   待删文件（解读 #6 保守粒度：「仍被运行中的 run 用到的文件不删」）。
//   事务语义（C1 逐字「删除后不能留下指向已删文件的记录」）：先 tx 内置空
//   local_file_path（条件 WHERE IS NOT NULL），COMMIT 后才 unlink——任何失败下
//   DB 都不可能指向已删文件；unlink ENOENT 容忍（幂等重跑）。
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { tx } from '../../db/tx.js';
import type { GatewayError } from '../../gateway/errors.js';

export const MEDIA_DOWNLOAD_SCAN_NAME = 'media-download';
export const MEDIA_CLEANUP_SCAN_NAME = 'media-cleanup';

/** 下载批上限：积压超限时下轮 tick 续扫（真值在 DB，批内失败不阻塞其余行） */
const DOWNLOAD_BATCH = 50;
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 30_000;
/** 清理扫描内部节流：契约粒度「每日」（DES/05 §7）；registry 1s 节拍不变 */
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface MediaLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** 最小网关面：只依赖 downloadMedia（downloadMedia(mediaUrl) 已自带超时与错误形状） */
export interface MediaGateway {
  downloadMedia(mediaUrl: string): Promise<Uint8Array>;
}

export interface MediaDownloadDeps {
  readonly pool: Pool;
  readonly gateway: MediaGateway;
  readonly logger: MediaLogger;
  /** 落盘根目录；缺省 <cwd>/media（dev/test 下都是包根——.gitignore 已收 media/） */
  readonly mediaDir?: string;
  /** 退避基数（测试可缩短）；缺省 500ms */
  readonly retryBaseMs?: number;
}

function isExpired404(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as GatewayError).status === 404
  );
}

/**
 * 文件名 = msgId（§7 逐字 `media/<msgId>`）。msgId 为网关字符串——剥掉路径分隔与
 * 父目录段防穿越（mock 取 m-N 形状不受影响；恶意字符落地为下划线替换）。
 */
function fileFor(mediaDir: string, msgId: string): string {
  const safe = msgId.replace(/[\\/]/g, '_').replace(/^\.+$/, '_');
  return path.join(mediaDir, safe);
}

export function createMediaDownloadScan(deps: MediaDownloadDeps): () => Promise<number> {
  const mediaDir = deps.mediaDir ?? path.resolve('media');
  const retryBase = deps.retryBaseMs ?? RETRY_BASE_MS;
  // 进程内退避表：msgId → {下次可试时刻, 已连失次数}。只约束节奏——崩溃清零 = 立即重试（保守方向）。
  const backoff = new Map<string, { notBefore: number; fails: number }>();
  let dirReady = false;

  return async () => {
    // 待下载集：media_url 非空 + 未落盘 + 未盖过期戳（ws_event 是真值，进程内存不可靠）
    const { rows } = await deps.pool.query<{
      id: number;
      msg_id: string;
      media_url: string;
    }>(
      `SELECT m.id, m.msg_id, m.media_url FROM message m
        WHERE m.media_url IS NOT NULL AND m.local_file_path IS NULL AND m.msg_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ws_event w
             WHERE w.type='inconsistency' AND w.payload->>'kind'='media_expired'
               AND w.payload->>'ref' = 'msg:' || m.msg_id
          )
        ORDER BY m.id LIMIT ${DOWNLOAD_BATCH}`,
    );
    if (rows.length === 0) return 0;
    if (!dirReady) {
      await mkdir(mediaDir, { recursive: true });
      dirReady = true;
    }

    let done = 0;
    const now = Date.now();
    for (const row of rows) {
      const b = backoff.get(row.msg_id);
      if (b !== undefined && now < b.notBefore) continue; // 退避中（节奏层，不写库）
      try {
        const bytes = await deps.gateway.downloadMedia(row.media_url);
        const file = fileFor(mediaDir, row.msg_id);
        await writeFile(file, bytes); // 幂等：同 msgId 覆盖写无害（§7）
        // 事务回填（§7）；条件 UPDATE——并发下后到者 rowCount=0 即被已有真值吸收
        await tx(deps.pool, async (client) => {
          await client.query(
            `UPDATE message SET local_file_path=$1, updated_at=now()
              WHERE id=$2 AND local_file_path IS NULL`,
            [file, row.id],
          );
        });
        backoff.delete(row.msg_id);
        done += 1;
      } catch (err) {
        if (isExpired404(err)) {
          // 过期：路径保持 NULL + inconsistency（WHERE NOT EXISTS = 同事务防重推；
          // 真值在 ws_event 行——插入撞上已有戳也只是少一行，不会多推）
          await deps.pool.query(
            `INSERT INTO ws_event (type, payload)
              SELECT 'inconsistency', $1::jsonb
              WHERE NOT EXISTS (
                SELECT 1 FROM ws_event
                 WHERE type='inconsistency' AND payload->>'kind'='media_expired'
                   AND payload->>'ref' = $2
              )`,
            [
              JSON.stringify({
                kind: 'media_expired',
                ref: `msg:${row.msg_id}`,
                message: `media expired (gateway 404): ${row.media_url}`,
              }),
              `msg:${row.msg_id}`,
            ],
          );
          backoff.delete(row.msg_id); // 已盖戳的行从此退出谓词——退避表清掉防泄漏
          deps.logger.warn({ msgId: row.msg_id, mediaUrl: row.media_url }, 'media expired (404); marked media_expired');
        } else {
          const fails = (b?.fails ?? 0) + 1;
          const delay = Math.min(retryBase * 2 ** (fails - 1), RETRY_MAX_MS);
          backoff.set(row.msg_id, { notBefore: Date.now() + delay, fails });
          deps.logger.warn(
            { msgId: row.msg_id, mediaUrl: row.media_url, retryInMs: delay, err },
            'media download failed; backing off',
          );
        }
      }
    }
    return done;
  };
}

export interface MediaCleanupDeps {
  readonly pool: Pool;
  readonly logger: MediaLogger;
  /** 保留天数；缺省 30（MEDIA_RETENTION_DAYS_DEFAULT，QR §1）。测试可压小。 */
  readonly retentionDays?: number;
  /** 内部节流窗口（缺省 24h 契约粒度）；测试传 0 = 每次调用都跑 */
  readonly intervalMs?: number;
}

export function createMediaCleanupScan(deps: MediaCleanupDeps): () => Promise<number> {
  const retentionDays = deps.retentionDays ?? 30;
  const intervalMs = deps.intervalMs ?? CLEANUP_INTERVAL_MS;
  let lastRun = 0;

  return async () => {
    const now = Date.now();
    if (now - lastRun < intervalMs) return 0;
    lastRun = now;

    // 待删集：超保留期 + 有落盘指针 + 所在群无 running run（解读 #6 群级保守粒度）
    const { rows } = await deps.pool.query<{ id: number; local_file_path: string }>(
      `SELECT m.id, m.local_file_path FROM message m
        WHERE m.local_file_path IS NOT NULL
          AND m.created_at < now() - make_interval(days => $1)
          AND NOT EXISTS (
            SELECT 1 FROM agent_run r
             WHERE r.group_id = m.group_id AND r.status = 'running'
          )
        ORDER BY m.id LIMIT 200`,
      [retentionDays],
    );

    let removed = 0;
    for (const row of rows) {
      // C1 逐字：「删除后不能留下指向已删文件的记录」——
      // 先 tx 置空指针（COMMIT 即刻对外一致），后 unlink 文件。
      // 倒序会在「删完未置空」的崩溃窗里留下悬空指针；本顺序最坏结果是孤儿文件（无害）。
      const nulled = await tx(deps.pool, async (client) => {
        const res = await client.query(
          `UPDATE message SET local_file_path=NULL, updated_at=now()
            WHERE id=$1 AND local_file_path=$2`,
          [row.id, row.local_file_path],
        );
        return res.rowCount ?? 0;
      });
      if (nulled === 0) continue; // 并发已被清（幂等吸收）
      try {
        await unlink(row.local_file_path);
      } catch (err) {
        // ENOENT = 文件已不在（上轮半删/外部清理）→ 幂等；其它错误记 warn，文件成孤儿
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          deps.logger.warn({ file: row.local_file_path, err }, 'media file unlink failed; pointer already cleared');
        }
      }
      removed += 1;
    }
    if (removed > 0) deps.logger.info({ removed }, 'media cleanup done');
    return removed;
  };
}
