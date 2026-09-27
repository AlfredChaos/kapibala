-- 007-agent.sql — Agent 域：run / 步骤 / 幂等 key / 触发队列（design/02 §7.1–§7.4）

-- §7.1 agent_run：runId 即主键；墙钟预算与租约供崩溃恢复（A5-2 / O1）
CREATE TABLE agent_run (
    id                    uuid PRIMARY KEY,
    group_id              uuid NOT NULL REFERENCES "group"(id),
    status                text NOT NULL DEFAULT 'running' CHECK (status IN ('running','finished','failed','blocked','cancelled')),
    end_reason            text CHECK (end_reason IN ('final','budget_exhausted','wall_clock','protocol_errors','audit_blocked','cancelled')),
    summary               text,
    trigger_context       jsonb NOT NULL,
    step_count            int NOT NULL DEFAULT 0,
    protocol_error_streak int NOT NULL DEFAULT 0,
    wall_deadline_at      timestamptz,
    wall_consumed_ms      bigint NOT NULL DEFAULT 0,
    resume_at             timestamptz,
    claimed_by            text,
    lease_until           timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    ended_at              timestamptz
);

-- 每群单飞行（A5-1，多实例部署成立）
CREATE UNIQUE INDEX uq_agent_run_single_flight
    ON agent_run(group_id) WHERE status = 'running';

-- 孤儿 run 观测（lease_until 过期，调度器仅观测，O1 裁剪）
CREATE INDEX idx_agent_run_lease_until ON agent_run(lease_until) WHERE status = 'running';

-- §7.2 agent_run_step：步骤 + 会话历史（appended_blocks 是崩溃恢复重建 messages 的唯一来源）
CREATE TABLE agent_run_step (
    id               bigserial PRIMARY KEY,
    run_id           uuid NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
    seq              int NOT NULL,
    kind             text NOT NULL CHECK (kind IN ('tool_use','final','protocol_error')),
    tool_use_id      text,
    name             text,
    input            jsonb,
    result_summary   text,
    is_error         boolean NOT NULL DEFAULT false,
    error_code       text,
    audit_verdict    text CHECK (audit_verdict IN ('pass','fail','unresolved')),
    raw_response     text,
    appended_blocks  jsonb NOT NULL,
    status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','turn_dispatched','turn_received','tool_dispatched','done')),
    dispatch_payload jsonb,
    client_msg_id    text,
    kick_target      text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_agent_run_step_run_seq UNIQUE (run_id, seq)
);

-- DUPLICATE_TOOL_USE_ID 检测依据（§7.2；tool_use_id 可 NULL，部分唯一索引）
CREATE UNIQUE INDEX uq_agent_run_step_tool_use_id
    ON agent_run_step(run_id, tool_use_id) WHERE tool_use_id IS NOT NULL;

-- 恢复扫描：dispatched in-flight 步骤（DES/06 §7 断点状态机）
CREATE INDEX idx_agent_run_step_dispatch
    ON agent_run_step(status) WHERE status IN ('turn_dispatched','tool_dispatched');

-- §7.3 agent_idempotency_key：一个 run 内 key 唯一（A5-7）；消耗时机 = 过审创建消息同事务
CREATE TABLE agent_idempotency_key (
    run_id          uuid NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
    idempotency_key text NOT NULL,
    client_msg_id   text NOT NULL,
    consumed_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, idempotency_key)
);

-- §7.4 agent_trigger_queue：run 进行期间到达的非自己消息（A5-1 后半）
CREATE TABLE agent_trigger_queue (
    id         bigserial PRIMARY KEY,
    group_id   uuid NOT NULL REFERENCES "group"(id),
    message_id bigint NOT NULL REFERENCES message(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_agent_trigger_queue_group_message UNIQUE (group_id, message_id)
);
