-- 005-message.sql — 消息域（design/02 §5.1）：全系统约束最密集的表
-- 一行原则：出站受理即 INSERT；message_sent 按 client_msg_id 回填；回流按 (group_id, msg_id) 吸收。

CREATE TABLE message (
    id                      bigserial PRIMARY KEY,
    group_id                uuid NOT NULL REFERENCES "group"(id),
    msg_id                  text,
    client_msg_id           text,
    sender_platform_user_id text NOT NULL,
    is_own                  boolean NOT NULL DEFAULT false,
    source                  text NOT NULL DEFAULT 'inbound' CHECK (source IN ('inbound','operator','sequence','agent')),
    text                    text NOT NULL,
    sent_at                 timestamptz NOT NULL,
    delivery_status         text CHECK (delivery_status IN ('queued','accepted','sent','failed','unknown','cancelled')),
    fail_code               text,
    account_id              text REFERENCES account(id),
    first_attempt_at        timestamptz,
    last_attempt_at         timestamptz,
    resend_count            int NOT NULL DEFAULT 0 CHECK (resend_count IN (0,1)),
    unknown_since           timestamptz,
    unknown_deadline_at     timestamptz,
    media_url               text,
    local_file_path         text,
    sort_key                text NOT NULL GENERATED ALWAYS AS (COALESCE(msg_id, client_msg_id)) STORED,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

-- 入站去重：(groupId, msgId) 唯一（A2；msg_id 可 NULL，部分索引）
CREATE UNIQUE INDEX uq_message_group_msg
    ON message(group_id, msg_id) WHERE msg_id IS NOT NULL;

-- 出站唯一：一条出站记录至多对应一条网关消息（A2；网关不去重，唯一性全在我方）
CREATE UNIQUE INDEX uq_message_client_msg
    ON message(client_msg_id) WHERE client_msg_id IS NOT NULL;

-- 时间线分页：keyset 复合游标（sentAt 倒序 + 同毫秒多行的稳定次序）
CREATE INDEX idx_message_timeline
    ON message(group_id, sent_at DESC, sort_key DESC);
