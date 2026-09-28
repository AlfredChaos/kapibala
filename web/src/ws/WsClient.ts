// WS 客户端单例（T-P5-02；DES/15 §3 伪码逐字、DES/08 §2.1/§2.2/§2.4、REQ B4）。
// 生命周期：connect() → new WebSocket → open 即发 {type:'auth', accessToken, sinceSeq:lastSeq}
//   → auth:true 回执后进入实时模式（此前收到的事件帧 = 补发，与同一条 applyFrame 路径去重）
//   → auth:false（token 过期）→ 走 §4 单飞刷新 → 成功后立即重连；刷新也 401 → 会话失效
//     （onSessionExpired 已在 client 层收口），本侧不再重连；
//   → close（非手动）→ 指数退避重连（500ms 起 ×2 封顶 5s），重连仍带 sinceSeq=lastSeq 补发；
//   → applyFrame：frame.seq <= lastSeq 丢弃（补发与实时交叠不重复，B4「不重复」）；
//     lastSeq 单调推进 + sessionStorage 持久化（刷新页面用旧 seq 补发换不漏，重复靠去重）。
// 纪律：
// - 不丢 lastSeq（卡片 d）：先持久化后分发——页面重载只可能重复，不可能漏；
// - handler 抛错绝不杀死连接（log 后继续——帧已持久化服务端，lastSeq 已推进）；
// - 本模块框架无感：router/React 都不碰，toast/refetch 由订阅者（useWsEvent/onBacklogExpired）接线。
import type {
  WsAuthRequest,
  WsEventFrame,
  WsServerFrame,
} from '@kapibala/contract';

/** 重连退避（DES/15 §3：500ms 起 ×2，上限 5s）——与 server SSE 侧同一组数字出处 */
export const WS_RECONNECT_START_MS = 500;
export const WS_RECONNECT_MAX_MS = 5000;
const STORAGE_KEY = 'kapibala.ws.lastSeq';

/**
 * 重连退避（DES/15 §6 测试表签名 `nextBackoff(attempt)`；§3：500ms 起 ×2 封顶 5s）。
 * attempt = 已连续重连次数（0 起）；auth 成功即清零。纯函数，零墙钟。
 */
export function nextBackoff(
  attempt: number,
  startMs: number = WS_RECONNECT_START_MS,
  maxMs: number = WS_RECONNECT_MAX_MS,
): number {
  return Math.min(startMs * 2 ** Math.max(0, attempt), maxMs);
}

export interface FrameApplyResult {
  /** 新 lastSeq（旧帧时为原值） */
  readonly lastSeq: number;
  /** true = 新帧应分发；false = seq <= lastSeq 的旧帧/补发交叠，丢弃 */
  readonly accepted: boolean;
}

/**
 * 帧处理纯函数（DES/15 §6 测试表 `applyFrame(lastSeq, frame)`；§3 逐字）：
 * seq <= lastSeq → accepted:false（丢弃）；否则 lastSeq = seq 推进、accepted:true。
 * 单调推进而非连续前缀——服务端 seq 全局单调、sinceSeq 独占补发（§2.2），无乱序窗口语义。
 */
export function applyFrame(lastSeq: number, frame: WsEventFrame): FrameApplyResult {
  if (!Number.isFinite(frame.seq) || frame.seq <= lastSeq) return { lastSeq, accepted: false };
  return { lastSeq: frame.seq, accepted: true };
}

/** 可注入的 WebSocket 形状（DOM WebSocket 结构子集；测试用 fake 驱动 onopen/onmessage/onclose） */
export interface WebSocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

/** 事件处理器：payload 类型随 type 收窄（contract 判别联合） */
export type WsEventType = WsEventFrame['type'];
export type WsPayloadOf<T extends WsEventType> = Extract<WsEventFrame, { type: T }>['payload'];
export type WsEventHandler<T extends WsEventType> = (frame: Extract<WsEventFrame, { type: T }>) => void;

/** access token 提供者（ApiClient 形状子集——refreshToken 见 api/client.ts） */
export interface WsTokenSource {
  getAccessToken(): string | null;
  /** §4 单飞续期：auth 失败 → 刷新后重连；401 时 client 层已发 onSessionExpired */
  refreshToken(): Promise<string>;
}

export interface WsClientDeps {
  /** access token 读写与 §4 续期 */
  readonly tokens: WsTokenSource;
  /** 测试缝：默认真 WebSocket + location 推导 ws://（同源 /ws） */
  readonly wsFactory?: (url: string) => WebSocketLike;
  readonly url?: string;
  /** 测试缝：默认 sessionStorage（lastSeq 持久化） */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** 测试缝：退避参数（生产用契约常量） */
  readonly backoffStartMs?: number;
  readonly backoffMaxMs?: number;
  readonly logger?: { warn(msg: string, obj?: unknown): void };
}

export interface WsClient {
  /** 启动消费（幂等；会话建立后调用——AuthProvider 接线） */
  connect(): void;
  /** 停止：关 socket、不自动重连、取消退避定时器。幂等。 */
  disconnect(): void;
  /** useWsEvent 底座的订阅 API（type 精确收窄 payload） */
  subscribe<T extends WsEventType>(type: T, handler: WsEventHandler<T>): () => void;
  /** 全类型订阅（仪表盘实时 feed 用）：一次注册收全部事件帧；帧已过 lastSeq 去重 */
  subscribeAll(handler: (frame: WsEventFrame) => void): () => void;
  /** ws_backlog_expired 专用收口：页面级兜底 refetch 在此挂（DES/15 §3 末条、DES/08 §2.2） */
  onBacklogExpired(handler: () => void): () => void;
  /** 当前持久化水位（观测/断言用） */
  readonly lastSeq: number;
  readonly authed: boolean;
}

function isServerFrame(v: unknown): v is WsServerFrame {
  return typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';
}

function isEventFrame(f: WsServerFrame): f is WsEventFrame {
  return f.type !== 'auth' && typeof (f as WsEventFrame).seq === 'number';
}

function defaultWsUrl(): string {
  const proto = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = typeof location !== 'undefined' ? location.host : 'localhost:3000';
  return `${proto}//${host}/ws`;
}

const NOOP_LOGGER = { warn(): void {} };

export function createWsClient(deps: WsClientDeps): WsClient {
  const storage = deps.storage ?? sessionStorage;
  const url = deps.url ?? defaultWsUrl();
  const wsFactory = deps.wsFactory ?? ((u: string) => new WebSocket(u) as WebSocketLike);
  const logger = deps.logger ?? NOOP_LOGGER;
  const backoffStart = deps.backoffStartMs ?? WS_RECONNECT_START_MS;
  const backoffMax = deps.backoffMaxMs ?? WS_RECONNECT_MAX_MS;

  let lastSeq = Number(storage.getItem(STORAGE_KEY) ?? '0') || 0;
  let socket: WebSocketLike | null = null;
  let authed = false;
  let stopped = false; // disconnect() 后置 true——close 不再重连
  let connected = false; // connect() 幂等闸
  let attempt = 0; // 连续重连次数（auth 成功清零）
  let timer: ReturnType<typeof setTimeout> | null = null;
  let authRetrying = false; // auth:false → §4 刷新进行中：onclose 不叠加退避
  // 存储形态是抹掉收窄的原始回调；收窄语义只在 subscribe 边界收敛一次（守卫包装）
  const subscribers = new Map<WsEventType, Set<(frame: WsEventFrame) => void>>();
  const backlogHandlers = new Set<() => void>();

  function persistSeq(seq: number): void {
    storage.setItem(STORAGE_KEY, String(seq));
  }

  function dispatch(frame: WsEventFrame): void {
    const set = subscribers.get(frame.type);
    if (set !== undefined) {
      for (const handler of set) {
        try {
          handler(frame);
        } catch (err) {
          // handler 崩溃不杀死连接、不回退 lastSeq——帧是服务端已提交真值（§2.2）
          logger.warn('ws handler threw', { err, type: frame.type, seq: frame.seq });
        }
      }
    }
    // ws_backlog_expired → 页面级兜底 refetch（DES/15 §3：订阅者之外的独立收口）
    if (frame.type === 'inconsistency' && frame.payload.kind === 'ws_backlog_expired') {
      for (const h of backlogHandlers) {
        try {
          h();
        } catch (err) {
          logger.warn('backlog-expired handler threw', { err });
        }
      }
    }
  }

  function scheduleReconnect(): void {
    if (stopped || timer !== null) return;
    const delay = nextBackoff(attempt, backoffStart, backoffMax);
    attempt += 1;
    timer = setTimeout(() => {
      timer = null;
      open();
    }, delay);
  }

  /** auth:false → §4 刷新后重连（成功立即重连零退避；刷新也 401 → 会话失效，不再重连） */
  function handleAuthFailure(bad: WebSocketLike): void {
    authRetrying = true;
    try {
      bad.close();
    } catch {
      /* fake/真 socket close 幂等 */
    }
    void deps.tokens
      .refreshToken()
      .then(() => {
        authRetrying = false;
        if (!stopped) open(); // 刷新成功：立即重连（attempt 保留——不滥用退避序列清零）
      })
      .catch((err: unknown) => {
        authRetrying = false;
        // refresh 401 → client 层已 onSessionExpired（会话清空，守卫跳 /login）；
        // 其他失败（5xx/网络）→ 会话未失效，按退避再试
        if (!stopped && !(typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 401)) {
          scheduleReconnect();
        }
      });
  }

  function open(): void {
    if (stopped) return;
    authed = false;
    const ws = wsFactory(url);
    socket = ws;

    ws.onopen = () => {
      const token = deps.tokens.getAccessToken();
      const frame: WsAuthRequest =
        token === null
          ? { type: 'auth', accessToken: '' }
          : { type: 'auth', accessToken: token, sinceSeq: lastSeq };
      // §3 伪码逐字：带 sinceSeq:lastSeq——旧 seq 补发换不漏，重复靠 seq 去重
      ws.send(JSON.stringify(frame));
    };
    ws.onmessage = (ev) => {
      // 已被替换/断开的 socket 残余帧不消费（close 后不再投，与真 socket 语义一致）
      if (socket !== ws) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(ev.data));
      } catch {
        return; // 坏帧丢弃（服务端契约帧恒 JSON）
      }
      if (!isServerFrame(parsed)) return;
      if (parsed.type === 'auth') {
        if (parsed.success) {
          authed = true; // 进入实时模式（DES/15 §3）
          attempt = 0;
        } else {
          handleAuthFailure(ws);
        }
        return;
      }
      if (!isEventFrame(parsed)) return;
      const r = applyFrame(lastSeq, parsed);
      if (!r.accepted) return; // seq <= lastSeq：旧帧/补发交叠，丢弃
      lastSeq = r.lastSeq;
      persistSeq(lastSeq); // 先持久化后分发：刷新页面最坏重放不丢（卡片 d）
      dispatch(parsed);
    };
    ws.onclose = () => {
      socket = null;
      authed = false;
      if (stopped || authRetrying) return; // auth 失败走 §4 路径，不叠加退避
      scheduleReconnect();
    };
    ws.onerror = () => {
      // 错误后必随 onclose——退避在那里统一收口
    };
  }

  return {
    get lastSeq() {
      return lastSeq;
    },
    get authed() {
      return authed;
    },
    connect() {
      if (connected) return; // 幂等；disconnect() 后可再 connect（stopped 由这里复位）
      connected = true;
      stopped = false;
      open();
    },
    disconnect() {
      stopped = true;
      connected = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      const s = socket;
      socket = null;
      try {
        s?.close();
      } catch {
        /* 幂等 */
      }
    },
    subscribeAll(handler) {
      // 复用 subscribe 注册面：全类型各挂一条轻量转发（dispatch 仍按 type 分派）
      const types: readonly WsEventType[] = [
        'account_status_changed',
        'account_terminal',
        'inconsistency',
        'message',
        'agent_run',
        'sequence_run',
        'group_updated',
        'job',
      ];
      const unsubs = types.map((t) => this.subscribe(t, handler));
      return () => {
        for (const u of unsubs) u();
      };
    },
    subscribe(type, handler) {
      let set = subscribers.get(type);
      if (set === undefined) {
        set = new Set<(frame: WsEventFrame) => void>();
        subscribers.set(type, set);
      }
      // 收窄只发生在这里：存储回调收到帧即断言为本 type（Map 键已保证）
      const wrapped = (frame: WsEventFrame): void =>
        (handler as (f: Extract<WsEventFrame, { type: typeof type }>) => void)(
          frame as Extract<WsEventFrame, { type: typeof type }>,
        );
      set.add(wrapped);
      return () => {
        set.delete(wrapped);
        if (set.size === 0) subscribers.delete(type);
      };
    },
    onBacklogExpired(handler) {
      backlogHandlers.add(handler);
      return () => {
        backlogHandlers.delete(handler);
      };
    },
  };
}
