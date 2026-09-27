-- 001-infra.sql — 基础设施域：迁移账本 / SSE 游标 / 事件账本 / 死信 / WS 事件日志
-- 依据 docs/design/02-data-model.md §1.1–§1.5

-- §1.1 schema_migrations：runner 事务内「执行 SQL + 插入版本」，已应用版本跳过
CREATE TABLE schema_migrations (
    version    int PRIMARY KEY,
    name       text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
);

-- §1.2 event_cursor：单行表，id CHECK (id = 1) 保证恒为 1
CREATE TABLE event_cursor (
    id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_event_id bigint NOT NULL DEFAULT 0,
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 【解读】spec 未写明单行由谁初始化；DES/08 §1.3 游标推进为 UPDATE、启动判定直接读
-- last_event_id，故迁移内落一行，使单行不变量自建表起成立。
INSERT INTO event_cursor (id) VALUES (1);

-- §1.3 gateway_event：入站幂等第一道闸（event_id PK，ON CONFLICT 吸收重复推送）
CREATE TABLE gateway_event (
    event_id    bigint PRIMARY KEY,
    type        text NOT NULL,
    payload     jsonb NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now()
);

-- §1.4 pending_event：死信（D1-1 三写同事务的落点；event_id 唯一 + FK 指向账本）
-- 【解读】spec 中 created_at/updated_at 仅标 timestamptz，按表头约定补 NOT NULL DEFAULT now()
CREATE TABLE pending_event (
    id            bigserial PRIMARY KEY,
    event_id      bigint NOT NULL UNIQUE REFERENCES gateway_event(event_id),
    type          text NOT NULL,
    payload       jsonb NOT NULL,
    error         text NOT NULL,
    status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
    attempts      int NOT NULL DEFAULT 0,
    next_retry_at timestamptz NOT NULL DEFAULT now(),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- §1.5 ws_event：seq 全局单调（bigserial PK），sinceSeq 补发真值
CREATE TABLE ws_event (
    seq        bigserial PRIMARY KEY,
    type       text NOT NULL,
    payload    jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ws_event_created_at ON ws_event (created_at);
