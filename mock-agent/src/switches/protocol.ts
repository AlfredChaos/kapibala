// 协议类故障开关（T-P4-02）：ag-1..7 的坏响应注入 + ag-17 三连剧本素材 + ag-19 探针登记面。
// 契约出处：REQ §2.2「Agent 服务可能出现的行为」逐字；DES/12 §7 行 1–7/17/19。
// 注入面统一在 scripted.turn 里（providers/scripted.ts）：命中开关 → 直接回故障响应，
// 优先于剧本（持续型注入是「每次调 turn 必炸」，剧本步是「按调用序号各管一步」）。
// 命中判定 = 开关存在且 target.runId 未限定或等于本次 runId（与 mock-gateway 的 target 收窄同一约定）。
import type { AgentState, AgentSwitchConfig, PlaybookStep } from '../scenario.js';
import type { ProviderReply } from '../providers/scripted.js';

/** 开关是否命中本次 turn：target.runId 缺省 = 全局；声明了 runId 则必须同值 */
export function matchingSwitch(
  state: AgentState,
  switchName: string,
  runId: string,
): AgentSwitchConfig | undefined {
  const config = state.switches.get(switchName);
  if (config === undefined) {
    return undefined;
  }
  const target = config.target?.['runId'];
  if (target !== undefined && target !== runId) {
    return undefined;
  }
  return config;
}

function readString(config: AgentSwitchConfig | undefined, key: string): string | undefined {
  const value = config?.params?.[key];
  return typeof value === 'string' ? value : undefined;
}

// ---------- ag-1..3：坏 JSON 三形态（REQ §2.2 行为 1，三者都记 BAD_JSON） ----------
// 三形态共用一个「合法内芯」：ag-2/3 要求剥掉外壳后 JSON 本身合法（围栏/夹字定义）。

const INNER_OK_BODY =
  '{"stop_reason":"end_turn","content":[{"type":"text","text":"ok (inner payload)"}]}';

const BAD_JSON_RAW_BODY = '{"stop_reason":"end_turn","content":[{"type":"text","text":"oops"'; // 截断的非法 JSON

const BAD_JSON_FENCED_BODY = '```json\n' + INNER_OK_BODY + '\n```';

const BAD_JSON_WRAPPED_BODY = 'Here is the response you asked for:\n' + INNER_OK_BODY + '\nHope that helps!';

// ---------- ag-4 shape_invalid：JSON 合法但形状不符（三子形态，params.variant 选） ----------
// variant: no_stop_reason（缺省）| two_blocks（块数 ≠1）| mismatch（stop_reason 与块类型不一致）

const SHAPE_NO_STOP_REASON = '{"content":[{"type":"text","text":"missing stop_reason"}]}';

const SHAPE_TWO_BLOCKS =
  '{"stop_reason":"end_turn","content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}';

const SHAPE_MISMATCH =
  '{"stop_reason":"end_turn","content":[{"type":"tool_use","id":"tu_x","name":"send_message","input":{"text":"hi","idempotency_key":"k"}}]}';

// ---------- ag-7：重复 tool_use.id（固定串；重试本该换新 id，同 id 用两次是非法路径） ----------

const DEFAULT_DUP_TOOL_USE_ID = 'tu_dup_fixed';

// ---------- ag-17 s6_sequence：三连剧本素材（arm 时装进 playbooks；DES/12 §7 行 17） ----------
// 坏 JSON → 未知工具 → 正常结束（finish）。

export const S6_SEQUENCE_STEPS: readonly PlaybookStep[] = [
  { kind: 'raw', body: BAD_JSON_RAW_BODY },
  { kind: 'tool_use', name: 'teleport_member', input: { platform_user_id: 'p-9' } },
  { kind: 'finish', summary: 'S6: recovered after two protocol errors' },
];

/**
 * 命中则返回本 turn 的故障响应（含 NULL 之外的 ProviderReply），未命中返回 undefined。
 * 检查顺序 = §7 行序：坏 JSON 三形态 → 形状 → 未知工具/非法入参/重复 id。
 * tools_invalid_probe（ag-19）不在这里：它反测的是契约层 tools 校验本身，
 * 校验在 HTTP 层无条件执行（app.ts），开关只作登记（探针存在 = 后端测试意图）。
 */
export function applyProtocolFault(state: AgentState, runId: string): ProviderReply | undefined {
  if (matchingSwitch(state, 'bad_json_raw', runId) !== undefined) {
    return { kind: 'raw', body: BAD_JSON_RAW_BODY };
  }
  if (matchingSwitch(state, 'bad_json_fenced', runId) !== undefined) {
    return { kind: 'raw', body: BAD_JSON_FENCED_BODY };
  }
  if (matchingSwitch(state, 'bad_json_wrapped', runId) !== undefined) {
    return { kind: 'raw', body: BAD_JSON_WRAPPED_BODY };
  }
  const shapeConfig = matchingSwitch(state, 'shape_invalid', runId);
  if (shapeConfig !== undefined) {
    const variant = readString(shapeConfig, 'variant') ?? 'no_stop_reason';
    const body =
      variant === 'two_blocks'
        ? SHAPE_TWO_BLOCKS
        : variant === 'mismatch'
          ? SHAPE_MISMATCH
          : SHAPE_NO_STOP_REASON;
    return { kind: 'raw', body };
  }
  const unknownTool = matchingSwitch(state, 'unknown_tool', runId);
  if (unknownTool !== undefined) {
    const name = readString(unknownTool, 'name') ?? 'nonexistent_tool';
    return toolUse(state, name, {});
  }
  const invalidInput = matchingSwitch(state, 'invalid_input', runId);
  if (invalidInput !== undefined) {
    const name = readString(invalidInput, 'name') ?? 'get_recent_messages';
    const input =
      invalidInput.params?.['input'] !== undefined
        ? (invalidInput.params['input'] as Record<string, unknown>)
        : { limit: 'not-a-number' }; // limit 应为 number → INVALID_INPUT
    return toolUse(state, name, input);
  }
  const dup = matchingSwitch(state, 'duplicate_tool_use_id', runId);
  if (dup !== undefined) {
    const id = readString(dup, 'id') ?? DEFAULT_DUP_TOOL_USE_ID;
    // 不走 nextToolUseId：恒同 id 正是注入点（合法重试用新 id，REQ §2.2）
    const block = { type: 'tool_use' as const, id, name: 'get_recent_messages', input: { limit: 10 } };
    return { kind: 'json', value: { stop_reason: 'tool_use', content: [block] } };
  }
  return undefined;
}

function toolUse(state: AgentState, name: string, input: Record<string, unknown>): ProviderReply {
  state.tuSeq += 1;
  const block = { type: 'tool_use' as const, id: `tu_${state.tuSeq}`, name, input };
  return { kind: 'json', value: { stop_reason: 'tool_use', content: [block] } };
}
