-- 003-account.sql — 账号域（design/02 §3.1）
-- CAS 靠 UPDATE ... WHERE status=$expectedFrom（rowcount 判定），不设 version 列（O3）。

CREATE TABLE account (
    id                 text PRIMARY KEY,
    status             text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','online','rate_limited','disconnected','suspended','session_expired')),
    platform_user_id   text,
    rate_limited_until timestamptz,
    terminal_at        timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);

-- 到期扫描（D2-5）：仅扫 rate_limited 态
CREATE INDEX idx_account_rate_limited_until ON account (rate_limited_until) WHERE status = 'rate_limited';
