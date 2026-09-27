// agent 触发入口（T-P2-08 最小收口；DES/05 §4.4 + DES/06 §2 单飞行、REQ §2.2 触发上下文）。
// 判定逐字：group.status='active' AND agent_enabled=true →
//   INSERT agent_run(status='running', trigger_context=…) ON CONFLICT (group_id) WHERE status='running' DO NOTHING
//   → 冲突（已有 running run）则 INSERT agent_trigger_queue(group_id, message_id) ON CONFLICT DO NOTHING。
// 单飞行靠 uq_agent_run_single_flight 部分唯一索引（A5-1，多实例成立）——进程内零判定。
// trigger_context 契约形状（REQ §2.2）：{ groupId, triggerMessages:[{msgId,senderPlatformUserId,text,sentAt}]
// 按 sentAt 升序, policy:{autoKickEnabled}, ownPlatformUserIds:[全部服务账号 puid] }。
// 本文件只覆盖「入口触发」；run 结束事务的积压补建 / 调度器 SWEEP / executor 编排归 T-P4-04 接管。
import type { PoolClient } from 'pg';
import { startAgentRun } from './trigger.js';

export interface TriggerMessageInput {
  /** message.id（agent_trigger_queue 的外键） */
  readonly id: string;
  readonly msgId: string;
  readonly senderPlatformUserId: string;
  readonly text: string;
  /** ISO 8601 UTC（REQ §2.1）；triggerMessages 元素原样透传 */
  readonly sentAt: string;
}

export interface TriggerGroupContext {
  readonly id: string;
  readonly status: string;
  readonly agentEnabled: boolean;
  readonly autoKickEnabled: boolean;
}

export type TriggerOutcome = 'run_created' | 'queued' | 'skipped';

/**
 * 事件事务内调用（client 即事务载体）。守卫不过 → 'skipped'（消息行仍在，只是不触发）。
 * run 创建成功 → 'run_created' + ws_event(agent_run, running)（DES/08 §2.3：run 创建与每次状态变化）；
 * 单飞行冲突 → 'queued' + agent_trigger_queue 行（ON CONFLICT 吸收重复 message_id）。
 */
export async function tryTriggerAgentRun(
  client: PoolClient,
  args: { group: TriggerGroupContext; message: TriggerMessageInput },
): Promise<TriggerOutcome> {
  const { group, message } = args;
  if (group.status !== 'active' || !group.agentEnabled) {
    return 'skipped';
  }
  // ownPlatformUserIds = 全部已 connect 过的服务账号 puid（NULL 行不进入集合）
  const puids = await client.query<{ platform_user_id: string }>(
    'SELECT platform_user_id FROM account WHERE platform_user_id IS NOT NULL',
  );
  const triggerContext = {
    groupId: group.id,
    triggerMessages: [
      {
        msgId: message.msgId,
        senderPlatformUserId: message.senderPlatformUserId,
        text: message.text,
        sentAt: message.sentAt,
      },
    ], // 单元素天然升序（REQ：triggerMessages 按 sentAt 升序）
    policy: { autoKickEnabled: group.autoKickEnabled },
    ownPlatformUserIds: puids.rows.map((r) => r.platform_user_id),
  };
  const run = await client.query<{ id: string }>(
    `INSERT INTO agent_run (id, group_id, status, trigger_context)
     VALUES (gen_random_uuid(), $1, 'running', $2::jsonb)
     ON CONFLICT (group_id) WHERE status = 'running' DO NOTHING
     RETURNING id`,
    [group.id, JSON.stringify(triggerContext)],
  );
  const runId = run.rows[0]?.id;
  if (runId === undefined) {
    // 单飞行冲突：run 进行期间到达的消息进积压队列（A5-1 后半；run 结束事务/兜底扫描消费）
    await client.query(
      `INSERT INTO agent_trigger_queue (group_id, message_id) VALUES ($1, $2)
       ON CONFLICT (group_id, message_id) DO NOTHING`,
      [group.id, message.id],
    );
    return 'queued';
  }
  await client.query(
    "INSERT INTO ws_event (type, payload) VALUES ('agent_run', $1::jsonb)",
    [JSON.stringify({ runId, groupId: group.id, status: 'running', endReason: null })],
  );
  startAgentRun(runId); // executor 拾取占位缝（T-P4-05 接管 §2.1）
  return 'run_created';
}
