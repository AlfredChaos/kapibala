-- 002-auth.sql — 认证域：用户 / 会话 / access-refresh token（design/02 §2.1–§2.3）
-- 【解读】created_at 类列 spec 仅标 timestamptz，按约定补 NOT NULL DEFAULT now()；
--         ended_at / used_at 等事件时刻列保持可空（无值 null）。

-- §2.1 app_user：seed 预置 admin / viewer
CREATE TABLE app_user (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username      text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    role          text NOT NULL CHECK (role IN ('admin','viewer'))
);

-- §2.2 auth_session：轮换链之根（current_generation 代际）
CREATE TABLE auth_session (
    id                 uuid PRIMARY KEY,
    user_id            uuid NOT NULL REFERENCES app_user(id),
    status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','logged_out')),
    current_generation int NOT NULL DEFAULT 0,
    created_at         timestamptz NOT NULL DEFAULT now(),
    ended_at           timestamptz
);

-- §2.3 auth_token：token_hash = SHA-256(原文)，原文不落库；轮换链语义见 DES/09 §3
CREATE TABLE auth_token (
    id         uuid PRIMARY KEY,
    session_id uuid NOT NULL REFERENCES auth_session(id),
    kind       text NOT NULL CHECK (kind IN ('access','refresh')),
    token_hash text NOT NULL UNIQUE,
    generation int NOT NULL,
    status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','used','expired','revoked')),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    used_at    timestamptz
);

CREATE INDEX idx_auth_token_session_id ON auth_token (session_id);
