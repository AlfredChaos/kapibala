// WS hub（T-P2-10；DES/08 §2 全文、DES/02 §1.5、REQ §2.3 WS 行 / A4 / B4、QR §1 3s 行）。
// 形态：ws 库 WebSocketServer(noServer) 挂到 Fastify 共享的 app.server（DES/01：与 REST 同端口）
//   → 升级仅认 /ws 路径（其余 upgrade 请求销毁 socket，不打补丁到 Fastify 路由层）
//   → 首帧必须是 {type:'auth', accessToken, sinceSeq?}（REQ §2.3）：
//     token 查表（auth.service.verifyAccessToken，DES/09 §2）无效/过期 → auth:false + close；
//     成功 → auth:true 回执先行（未 auth 绝不推任何事件，§2.3）→ 设 lastSentSeq 水位
//     → sinceSeq 存在则从该水位补发 seq>sinceSeq 的全部现存行（独占语义，§2.2）。
// 投递纪律（宪法 §3-1 / A1 / I7）：hub 只读 ws_event 表——投递的全部是已提交行，
//   绝不存在「先事件后状态」窗口；seq 由 BIGSERIAL 分配（卡片 d：不用内存计数）。
// 通道（§2.2 单实例直推 + O4）：业务事务提交后由 notify.ts 的进程内通知唤醒一次同步；
//   另有 WS_EVENT_POLL_MS 兜底轮询——事务内写表但没有通知路径的行（死信事务等）
//   至多滞后一个节拍。多实例 LISTEN/NOTIFY 预留（ws_event 表已是投递真值）。
// 每连接：lastSentSeq 水位 + 串行发送队列（§2.4）——补发与实时交叠时统一按 seq 升序去重，
//   队列超 WS_SEND_QUEUE_LIMIT 断开该连接（客户端带 sinceSeq 重连恢复）。
// 心跳：WS_HEARTBEAT_MS ping/pong（§2.4），超时无 pong 判僵死 terminate。
// token 过期：连接期不续验不断开（解读 #21——断开由前端在 REST 401 后主动处理）。
import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import type { Pool } from 'pg';
import { WebSocket, WebSocketServer } from 'ws';
import {
  WS_EVENT_POLL_MS,
  WS_HEARTBEAT_MS,
  WS_SEND_QUEUE_LIMIT,
} from '../constants.js';
import { isRecord } from '../gateway/client.js';
import { verifyAccessToken } from '../modules/auth/service.js';
import { setWsEventNotifier } from './notify.js';

export interface WsHubLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface WsHub {
  /** 已认证连接数（观测/测试断言用） */
  readonly size: number;
  /** 关停：停止心跳与轮询、断开全部连接、关闭 WSS、摘除进程内通知钩子。幂等。 */
  close(): Promise<void>;
}

export interface WsHubOptions {
  readonly pool: Pool;
  readonly logger: WsHubLogger;
  /** 测试缝：心跳周期；缺省 WS_HEARTBEAT_MS（30s，§2.4） */
  readonly heartbeatMs?: number;
  /** 测试缝：ws_event 兜底轮询节拍；缺省 WS_EVENT_POLL_MS */
  readonly pollMs?: number;
  /** 测试缝：发送队列上限；缺省 WS_SEND_QUEUE_LIMIT（§2.4） */
  readonly queueLimit?: number;
}

interface WsEventRow {
  readonly seq: string; // pg int8 → string，发送前 Number()（宪法 §3-6 同源纪律）
  readonly type: string;
  readonly payload: unknown;
}

/** 队列元素：synthetic 帧（积压过期告警）不参与水位去重也不推进水位（不在表里，无 seq 真值） */
interface QueuedFrame {
  readonly seq: number;
  readonly type: string;
  readonly payload: unknown;
  readonly synthetic?: true;
}

interface Connection {
  readonly socket: WebSocket;
  /** 认证前不推任何事件（§2.3）；auth:true 回执后才翻 true */
  authed: boolean;
  /** 水位初值已落定（auth 回执后 lastSentSeq 才由 0 变成真值）。authed→ready 之间
   *  有两次 DB 查询窗口：兜底 poll/notify 此时同步会以 lastSentSeq=0 灌全表（真实 bug）。
   *  sync 一律先检本字段——authed 只管「能不能推」，ready 管「水位是不是真值」。 */
  ready: boolean;
  /** 心跳活性：每轮 ping 前置 false，pong 翻 true；下轮仍 false = 僵死 terminate */
  alive: boolean;
  /** 已推水位（表内 seq；独占语义：下次只取 > lastSentSeq） */
  lastSentSeq: number;
  /** 待发送队列（补发与实时共用，flush 时升序+水位去重——§4 风险的收口点） */
  queue: QueuedFrame[];
  /** 一次同步在飞；期间到的新数据置 dirty、落地后追加一轮 */
  syncing: boolean;
  dirty: boolean;
}

interface AuthFrame {
  readonly accessToken: string;
  readonly sinceSeq?: number;
}

/** 首帧契约（REQ §2.3）：bad JSON / 非 auth 类型 / 缺 token → undefined = 认证失败 */
function parseAuthFrame(data: unknown): AuthFrame | undefined {
  const text = typeof data === 'string' ? data : String(data);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed['type'] !== 'auth') return undefined;
  const accessToken = parsed['accessToken'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) return undefined;
  const sinceSeqRaw = parsed['sinceSeq'];
  const sinceSeq = typeof sinceSeqRaw === 'number' && Number.isFinite(sinceSeqRaw) && sinceSeqRaw >= 0
    ? sinceSeqRaw
    : undefined;
  return { accessToken, sinceSeq };
}

/**
 * 把 hub 挂到共享 HTTP server 的 /ws 升级路径（DES/01：与 REST 同端口）。
 * 调用时机：boot 在 app.listen 之前调用（server 对象在 Fastify 实例化即存在，
 * upgrade 监听注册后随 listen 生效）。
 */
export function attachWsHub(server: Server, options: WsHubOptions): WsHub {
  const { pool, logger } = options;
  const heartbeatMs = options.heartbeatMs ?? WS_HEARTBEAT_MS;
  const pollMs = options.pollMs ?? WS_EVENT_POLL_MS;
  const queueLimit = options.queueLimit ?? WS_SEND_QUEUE_LIMIT;
  const wss = new WebSocketServer({ noServer: true });
  const conns = new Set<Connection>();
  let closed = false;

  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== '/ws') {
      socket.destroy(); // 非 /ws 升级请求：本 hub 不管，直接拒（避免悬挂 socket）
      return;
    }
    wss.handleUpgrade(req, socket, head, (upgraded) => {
      wss.emit('connection', upgraded, req);
    });
  };
  server.on('upgrade', onUpgrade);
  // ---------- 每连接串行投递（§2.4 + §4 风险收口） ----------

  const flush = (conn: Connection): void => {
    if (conn.queue.length === 0) return;
    conn.queue.sort((a, b) => a.seq - b.seq); // 补发与实时交叠 → 升序是唯一合法次序
    const pending = conn.queue;
    conn.queue = [];
    for (const item of pending) {
      if (item.synthetic !== true && item.seq <= conn.lastSentSeq) continue; // 水位去重（B4 不重复）
      conn.socket.send(
        JSON.stringify({ seq: item.seq, type: item.type, payload: item.payload }),
      );
      if (item.synthetic !== true) conn.lastSentSeq = item.seq;
    }
  };

  const enqueue = (conn: Connection, frames: QueuedFrame[]): void => {
    conn.queue.push(...frames);
    if (conn.queue.length > queueLimit) {
      // §2.4 背压：慢连接断开——客户端带 sinceSeq 重连后从表补齐（投递真值不在内存队列）
      logger.warn({ queueLen: conn.queue.length, queueLimit }, 'ws send queue overflow; closing connection');
      conn.socket.close();
      return;
    }
    flush(conn);
  };

  /**
   * 同步一轮：把 ws_event 里 seq > 该连接水位的已提交行补进队列。
   * 补发（sinceSeq 起点）与实时增量共用同一条路径——唯一的分歧是水位初值。
   * 递归保护：在飞时新数据只记 dirty，落地后由尾部追加下一轮（无并发查询、无乱序）。
   */
  const sync = async (conn: Connection): Promise<void> => {
    if (!conn.ready) return; // authed 但水位未定——首轮由 auth 路径自己发，别以 0 灌全表
    if (conn.syncing) {
      conn.dirty = true;
      return;
    }
    conn.syncing = true;
    try {
      do {
        conn.dirty = false;
        const res = await pool.query<WsEventRow>(
          'SELECT seq, type, payload FROM ws_event WHERE seq > $1 ORDER BY seq',
          [conn.lastSentSeq],
        );
        if (conn.socket.readyState !== WebSocket.OPEN) return; // 同步途中断开：扔掉
        if (res.rows.length > 0) {
          enqueue(conn, res.rows.map((row) => ({
            seq: Number(row.seq),
            type: row.type,
            payload: row.payload,
          })));
        }
      } while (conn.dirty);
    } catch (err) {
      // 同步失败不静默、不断连：水位未动，下一次 notify/轮询重试（已提交行还在表里）
      logger.error({ err }, 'ws_event sync failed; connection retained, retried on next wake');
    } finally {
      conn.syncing = false;
    }
  };

  const syncAll = (): void => {
    for (const conn of conns) {
      if (!conn.authed) continue; // 未认证连接绝不推事件（§2.3）
      void sync(conn);
    }
  };

  // ---------- 连接生命周期 ----------

  wss.on('connection', (socket: WebSocket) => {
    const conn: Connection = {
      socket,
      authed: false,
      ready: false,
      alive: true,
      lastSentSeq: 0,
      queue: [],
      syncing: false,
      dirty: false,
    };
    conns.add(conn);
    socket.on('pong', () => {
      conn.alive = true;
    });
    socket.on('message', (data) => {
      void handleFrame(conn, data);
    });
    socket.on('close', () => conns.delete(conn));
    socket.on('error', (err: Error) => {
      logger.error({ err }, 'ws connection error');
      conns.delete(conn);
    });
  });

  const handleFrame = async (conn: Connection, data: unknown): Promise<void> => {
    if (conn.authed) return; // 协议只有一帧 auth；后续客户端消息无契约（忽略不静默？warn 成本>价值——auth 后无客户端消息契约，静默丢弃由 REQ 授权）
    const auth = parseAuthFrame(data);
    let sinceSeq: number | undefined;
    if (auth !== undefined) {
      try {
        const verified = await verifyAccessToken(pool, auth.accessToken);
        if (verified !== null) {
          conn.authed = true;
          sinceSeq = auth.sinceSeq;
        }
      } catch (err) {
        logger.error({ err }, 'access token verification failed at db layer');
      }
    }
    if (!conn.authed) {
      conn.socket.send(JSON.stringify({ type: 'auth', success: false }));
      conn.socket.close();
      return;
    }
    conn.socket.send(JSON.stringify({ type: 'auth', success: true }));

    // —— 水位初值 ——
    // sinceSeq 缺省 → 只推实时：水位 = 现存 max(seq)（无则 0）。注意此刻至 sync 之间
    // 提交的行 seq 仍 > 水位 → 由兜底轮询自然送达，无缺口（先持久化后推送天然成立）。
    if (sinceSeq === undefined) {
      const res = await pool.query<{ max: string | null }>('SELECT max(seq) AS max FROM ws_event');
      conn.lastSentSeq = Number(res.rows[0]?.max ?? 0);
    } else {
      // 单条聚合取 [min,max]：过期判定与水位钳制共用同一快照（两次查询之间行被清/被插会撕裂判定）
      const res = await pool.query<{ min: string | null; max: string | null }>(
        'SELECT min(seq) AS min, max(seq) AS max FROM ws_event',
      );
      const bounds = res.rows[0];
      const minSeq = bounds === undefined || bounds.min === null ? undefined : Number(bounds.min);
      const maxSeq = bounds === undefined || bounds.max === null ? undefined : Number(bounds.max);
      // 水位钳制：sinceSeq 越过现存 max（陈旧/伪造水位）→ 降到真实 max——否则回放集为空
      // 而水位停在未来 seq，其后所有提交永远不可达（自陷死锁）；钳制后最坏只是多收 ≤ 窗口行。
      conn.lastSentSeq = maxSeq === undefined ? sinceSeq : Math.min(sinceSeq, maxSeq);
      // 积压过期判定（§2.2 解读 #20）：sinceSeq 已被保留窗口清掉（0 < sinceSeq < 现存最小 seq）
      // → 先推一条 synthetic inconsistency，再从最小现存 seq 回放——前端应整体刷新。
      // 边界：sinceSeq=0 不是「行被清」——BIGSERIAL 从 1 起，0 是「全量回放」哨兵值，不告警；
      // 表空（min 无）无从判定缺失，不回放也不告警；sinceSeq ≥ minSeq 时其行仍在窗口内。
      if (minSeq !== undefined && sinceSeq > 0 && sinceSeq < minSeq) {
        enqueue(conn, [{
          seq: minSeq - 1, // 排序在全部回放行之前；synthetic 不参与水位（值只用于排序/交付）
          type: 'inconsistency',
          payload: {
            kind: 'ws_backlog_expired',
            ref: String(sinceSeq), // 设计写 ref:'sinceSeq'——带原值便于前端日志定位
            message:
              'ws_event backlog expired for the requested sinceSeq; replay starts from the oldest retained seq — perform a full refresh',
          },
          synthetic: true,
        }]);
      }
    }
    conn.ready = true; // 水位初值落定——此后兜底同步见到的是真值
    void sync(conn); // 首轮补齐（sinceSeq 起点或实时起点之后的新行）
  };

  // ---------- 心跳（§2.4）与兜底轮询 ----------

  const heartbeat = setInterval(() => {
    for (const conn of conns) {
      if (!conn.alive) {
        logger.warn('ws connection stale (no pong within heartbeat); terminating');
        conns.delete(conn);
        conn.socket.terminate();
        continue;
      }
      conn.alive = false;
      conn.socket.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  const poll = setInterval(syncAll, pollMs);
  poll.unref();

  // 进程内通知（§2.2 单实例直推）：业务事务提交 ws_event 后调用 → 立即唤醒一轮同步。
  const notifier = (): void => syncAll();
  setWsEventNotifier(notifier);

  logger.info({ heartbeatMs, pollMs }, 'ws hub attached at /ws');

  return {
    get size() {
      return conns.size;
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearInterval(poll);
      setWsEventNotifier(undefined);
      for (const conn of conns) conn.socket.terminate();
      conns.clear();
      server.off('upgrade', onUpgrade);
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}
