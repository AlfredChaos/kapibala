-- 006-job.sql — 作业域：建群 / leave-all outbox（design/02 §6.1）
-- 每个外部调用前意图与上下文先写 phase/context；恢复器按 phase 断点续传。

CREATE TABLE job (
    id               uuid PRIMARY KEY,
    type             text NOT NULL CHECK (type IN ('create_group','leave_all')),
    status           text NOT NULL DEFAULT 'running' CHECK (status IN ('running','finished','failed')),
    group_id         uuid REFERENCES "group"(id),
    payload          jsonb NOT NULL,
    phase            text NOT NULL,
    context          jsonb NOT NULL DEFAULT '{}',
    errors           jsonb NOT NULL DEFAULT '[]',
    join_deadline_at timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    finished_at      timestamptz
);

-- 恢复扫描：running 作业
CREATE INDEX idx_job_status_running ON job(status) WHERE status = 'running';
-- waiting_joins 阶段 10s 超时锚点（A2：JOIN_TIMEOUT）
CREATE INDEX idx_job_join_deadline ON job(join_deadline_at) WHERE status = 'running';
