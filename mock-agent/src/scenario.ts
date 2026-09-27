// `/_test` 控制平面（DES/12 §3「进程内 HTTP 管理端点」；形状与 mock-gateway 的 scenario 对齐：
// { switch, params?, target? }）。本任务只落 `playbook`（剧本装载）与 state/reset 观测面；
// §7 故障开关（ag-1..19）的语义归 T-P4-02/03，此处先把全部 19 名登记进白名单——
// 拼错开关名必须在 arrange 阶段就炸（与 mock-gateway KNOWN_SWITCHES 同一约定）。
import type { FastifyInstance } from 'fastify';

/**
 * 剧本步（T-P4-01 先落合法形状；`raw` 为 T-P4-02 坏响应注入预留的穿透通道）。
 * - `tool_use`：渲染为 { stop_reason:'tool_use', content:[tool_use 块] }，id 由引擎分配；
 * - `finish`：`tool_use` 步的语法糖（name=finish，input={summary}）；
 * - `end_turn`：渲染为 { stop_reason:'end_turn', content:[text 块] }；
 * - `raw`：原样吐响应体（可为非 JSON），带可选 statusCode——故障形态的总出口。
 */
export type PlaybookStep =
  | { kind: 'tool_use'; name: string; input?: Record<string, unknown> }
  | { kind: 'finish'; summary?: string }
  | { kind: 'end_turn'; text?: string }
  | { kind: 'raw'; body: string; statusCode?: number };

/** 开关配置：params/target 透传 + playbook 的 steps 放 params.steps（与本面 {switch,params,target} 一致） */
export interface AgentSwitchConfig {
  params?: Record<string, unknown>;
  target?: Record<string, unknown>;
}

/**
 * 进程内状态（无 DB、无外部依赖，DES/12 §2）：switches + playbooks + 剧本游标。
 * `Map<runId,cursor>` 重启清零是 mock 定位（任务卡 d / DES/12 §2.1 注）。
 */
export interface AgentState {
  /** 剧本：key 为 runId；通配剧本用 '*'（不定向 runId 的 arm） */
  playbooks: Map<string, PlaybookStep[]>;
  /** 每个 runId 的剧本调用序号（消费步数）；播完后回落默认剧本 */
  cursors: Map<string, number>;
  /** 已 arm 的 §7 故障开关（语义随 T-P4-02/03 接线） */
  switches: Map<string, AgentSwitchConfig>;
  /** tool_use.id 全局序号（`tu_<n>`；同 id 用两次是 §2.2 故障行为，正常路径必须唯一） */
  tuSeq: number;
}

export function createAgentState(): AgentState {
  return { playbooks: new Map(), cursors: new Map(), switches: new Map(), tuSeq: 0 };
}

export function resetAgentState(state: AgentState): void {
  state.playbooks.clear();
  state.cursors.clear();
  state.switches.clear();
  state.tuSeq = 0;
}

/** DES/12 §7 全部开关名（逐字登记；`audit_slow`/`audit_hang` 是同 #16 的两名拆开）+ `playbook`（剧本装载入口） */
const KNOWN_SWITCHES: readonly string[] = [
  'playbook',
  'bad_json_raw', // 1
  'bad_json_fenced', // 2
  'bad_json_wrapped', // 3
  'shape_invalid', // 4
  'unknown_tool', // 5
  'invalid_input', // 6
  'duplicate_tool_use_id', // 7
  'send_timeout_key_retry', // 8
  'endless_tools', // 9
  'repeat_get_recent', // 10
  'huge_limit', // 11
  'slow_turn', // 12
  'hang_turn', // 13
  'audit_500', // 14
  'audit_bad_body', // 15
  'audit_slow', // 16
  'audit_hang', // 16
  's6_sequence', // 17
  'same_runid_redispatch', // 18
  'tools_invalid_probe', // 19
];

/** 校验并归一化 steps；返回错误信息（null = 合法）。arrange 失败必须当场炸，不静默吞。 */
function validateSteps(raw: unknown): { steps?: PlaybookStep[]; error?: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'params.steps must be a non-empty array' };
  }
  const steps: PlaybookStep[] = [];
  for (const [index, item] of raw.entries()) {
    if (typeof item !== 'object' || item === null) {
      return { error: `steps[${index}] must be an object` };
    }
    const step = item as Record<string, unknown>;
    const kind = step['kind'];
    if (kind === 'tool_use') {
      if (typeof step['name'] !== 'string' || step['name'] === '') {
        return { error: `steps[${index}].name must be a non-empty string` };
      }
      const input = step['input'];
      if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) {
        return { error: `steps[${index}].input must be an object` };
      }
      steps.push({ kind, name: step['name'], input: input as Record<string, unknown> | undefined });
    } else if (kind === 'finish') {
      const summary = step['summary'];
      if (summary !== undefined && typeof summary !== 'string') {
        return { error: `steps[${index}].summary must be a string` };
      }
      steps.push({ kind, summary });
    } else if (kind === 'end_turn') {
      const text = step['text'];
      if (text !== undefined && typeof text !== 'string') {
        return { error: `steps[${index}].text must be a string` };
      }
      steps.push({ kind, text });
    } else if (kind === 'raw') {
      if (typeof step['body'] !== 'string') {
        return { error: `steps[${index}].body must be a string` };
      }
      const statusCode = step['statusCode'];
      if (statusCode !== undefined && (typeof statusCode !== 'number' || !Number.isInteger(statusCode))) {
        return { error: `steps[${index}].statusCode must be an integer` };
      }
      steps.push({ kind, body: step['body'], statusCode });
    } else {
      return { error: `steps[${index}].kind must be tool_use|finish|end_turn|raw, got: ${JSON.stringify(kind)}` };
    }
  }
  return { steps };
}

export function registerTestEndpoints(app: FastifyInstance, state: AgentState, mode: string): void {
  // POST /_test/scenario { switch, params?, target? } —— 装剧本 / arm 开关；重复调用 = 覆盖参数
  app.post('/_test/scenario', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const switchName = body['switch'];
    if (typeof switchName !== 'string' || !KNOWN_SWITCHES.includes(switchName)) {
      return reply
        .code(400)
        .send({ message: `unknown switch: ${JSON.stringify(switchName)} (see DES/12 section 7)` });
    }
    const target = (body['target'] ?? {}) as Record<string, unknown>;
    const params = (body['params'] ?? {}) as Record<string, unknown>;
    if (switchName === 'playbook') {
      const { steps, error } = validateSteps(params['steps']);
      if (error !== undefined || steps === undefined) {
        return reply.code(400).send({ message: `invalid playbook: ${error ?? 'no steps'}` });
      }
      const runId = typeof target['runId'] === 'string' && target['runId'] !== '' ? target['runId'] : '*';
      state.playbooks.set(runId, steps);
      // 覆盖语义（DES/14 §4 同义）：重装剧本把受影响游标归零——通配覆盖所有 run，定向只重置该 run
      if (runId === '*') {
        state.cursors.clear();
      } else {
        state.cursors.delete(runId);
      }
      return reply.send({ armed: 'playbook', runId });
    }
    // §7 故障开关：登记配置，语义由 providers/scripted.ts 随 T-P4-02/03 接线
    state.switches.set(switchName, { params, target });
    return reply.send({ armed: switchName });
  });

  // POST /_test/scenario/clear { switch? } —— 关指定/全部开关（playbook 用开关名 'playbook' 清除）
  app.post('/_test/scenario/clear', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const switchName = body['switch'];
    if (switchName === undefined) {
      state.switches.clear();
      state.playbooks.clear();
      state.cursors.clear();
      return reply.send({});
    }
    if (switchName === 'playbook') {
      const target = (body['target'] ?? {}) as Record<string, unknown>;
      const runId = typeof target['runId'] === 'string' && target['runId'] !== '' ? target['runId'] : '*';
      state.playbooks.delete(runId);
      return reply.send({});
    }
    state.switches.delete(String(switchName));
    return reply.send({});
  });

  // POST /_test/reset —— 清空剧本/游标/开关（重启清零的对内等价物）
  app.post('/_test/reset', async (_request, reply) => {
    resetAgentState(state);
    return reply.send({});
  });

  // GET /_test/state —— 观测面：provider 模式、各 runId 剧本长度、游标位置、已 arm 开关
  app.get('/_test/state', async (_request, reply) => {
    return reply.send({
      mode,
      playbooks: Object.fromEntries([...state.playbooks].map(([k, v]) => [k, v.length])),
      cursors: Object.fromEntries(state.cursors),
      switches: [...state.switches.keys()],
    });
  });
}
