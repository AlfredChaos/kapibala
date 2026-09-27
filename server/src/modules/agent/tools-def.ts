// /agent/turn 的 tools 常量（T-P4-05；REQ §2.2 工具表逐字 + DES/06 §6）。
// 硬编码 4 个；input_schema 的 required 必须覆盖全部入参（否则 Agent 服务 400 TOOLS_INVALID——
// 我方保证永不触发，ag-19 反测钉死）。
import type { AgentTurnToolDef } from '../../agentclient/index.js';

export const AGENT_TOOLS: readonly AgentTurnToolDef[] = [
  {
    name: 'get_recent_messages',
    description: '获取该群最近的消息（含触发消息与 run 期间新到的消息），按时间升序',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '返回条数，超过 50 按 50 处理' },
      },
      required: ['limit'],
    },
  },
  {
    name: 'send_message',
    description: '向群发送一条消息（幂等键去重；执行前过审计）',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '待发文本' },
        idempotency_key: { type: 'string', description: '幂等键（同 run 内唯一）' },
      },
      required: ['text', 'idempotency_key'],
    },
  },
  {
    name: 'kick_user',
    description: '将指定成员移出群（执行前过审计）',
    input_schema: {
      type: 'object',
      properties: {
        platform_user_id: { type: 'string', description: '目标成员的网关平台用户 id' },
        reason: { type: 'string', description: '移出原因' },
      },
      required: ['platform_user_id', 'reason'],
    },
  },
  {
    name: 'finish',
    description: '结束本 run（summary 存为 run 摘要，不再调 /agent/turn）',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'run 摘要' },
      },
      required: ['summary'],
    },
  },
] as const;

export const AGENT_TOOL_NAMES = new Set(AGENT_TOOLS.map((t) => t.name));
