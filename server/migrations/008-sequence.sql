-- 008-sequence.sql — 序列域：定义 / run / 步骤（design/02 §8.1–§8.3）

-- §8.1 sequence：B1 定义原样保存（定义时校验，DB 不再约束 steps 结构）
CREATE TABLE sequence (
    id         uuid PRIMARY KEY,
    name       text NOT NULL,
    steps      jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- §8.2 sequence_run：启动参数快照 vars/step_vars；stopped = 群 unreachable
CREATE TABLE sequence_run (
    id                 uuid PRIMARY KEY,
    group_id           uuid NOT NULL REFERENCES "group"(id),
    sequence_id        uuid NOT NULL REFERENCES sequence(id),
    status             text NOT NULL DEFAULT 'running' CHECK (status IN ('running','finished','failed','stopped')),
    vars               jsonb NOT NULL DEFAULT '{}',
    step_vars          jsonb NOT NULL DEFAULT '{}',
    current_step_index int NOT NULL DEFAULT 0,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    ended_at           timestamptz
);

-- 每群单飞行（B1；并发启动恰好一个 201 一个 409 = S7）
CREATE UNIQUE INDEX uq_sequence_run_single_flight
    ON sequence_run(group_id) WHERE status = 'running';

-- §8.3 sequence_run_step：步骤快照 + 预检产物（resolved_vars/var_sources）
-- 【解读】index 为 PG 关键字，加双引号引用；sent_at 对 skipped 步 = 跳过时刻（B1 排期锚点）。
CREATE TABLE sequence_run_step (
    id            bigserial PRIMARY KEY,
    run_id        uuid NOT NULL REFERENCES sequence_run(id) ON DELETE CASCADE,
    "index"       int NOT NULL,
    status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','sent','skipped','failed')),
    account_id    text REFERENCES account(id),
    account_role  text NOT NULL,
    text_template text NOT NULL,
    delay_seconds int NOT NULL,
    scheduled_at  timestamptz,
    sent_at       timestamptz,
    skipped_at    timestamptz,
    failed_at     timestamptz,
    client_msg_id text,
    resolved_vars jsonb NOT NULL,
    var_sources   jsonb NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_sequence_run_step_run_index UNIQUE (run_id, "index")
);

-- 到期扫描：已排期的 pending 步骤
CREATE INDEX idx_sequence_run_step_due
    ON sequence_run_step(run_id, scheduled_at)
    WHERE status = 'pending' AND scheduled_at IS NOT NULL;
