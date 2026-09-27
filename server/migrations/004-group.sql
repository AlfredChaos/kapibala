-- 004-group.sql — 群域：群 / 成员投影（design/02 §4.1–§4.2）
-- 【解读】group 为保留字，按 snake_case 命名约定加双引号引用，列名不受影响。

-- §4.1 "group"：gateway_group_id NULL = 建群中
CREATE TABLE "group" (
    id                 uuid PRIMARY KEY,
    gateway_group_id   text,
    status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','unreachable','left')),
    creator_account_id text NOT NULL REFERENCES account(id),
    agent_enabled      boolean NOT NULL DEFAULT false,
    auto_kick_enabled  boolean NOT NULL DEFAULT false,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_group_status ON "group" (status);

-- §4.2 group_member：网关状态的投影，只存服务账号；外部成员不建行（容量决策）
-- 活跃成员查询：WHERE group_id=? AND left_at IS NULL
CREATE TABLE group_member (
    id               bigserial PRIMARY KEY,
    group_id         uuid NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
    account_id       text NOT NULL REFERENCES account(id),
    platform_user_id text NOT NULL,
    role             text NOT NULL CHECK (role IN ('creator','admin','member')),
    joined_at        timestamptz,
    left_at          timestamptz,
    last_event_id    bigint NOT NULL DEFAULT 0,
    CONSTRAINT uq_group_member_group_account UNIQUE (group_id, account_id),
    CONSTRAINT uq_group_member_group_puid UNIQUE (group_id, platform_user_id)
);
