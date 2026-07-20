-- Authentication: Google-OAuth-backed users and opaque session tokens.
-- Single-tenant for now (no tenant_id, unlike ../ogen); add tenancy later if
-- Harbor needs it. A user row is upserted on each login keyed by google_sub;
-- a session row's id IS the random cookie token.
CREATE TABLE IF NOT EXISTS users
(
    id         TEXT        PRIMARY KEY,
    google_sub TEXT        NOT NULL UNIQUE,
    email      TEXT        NOT NULL UNIQUE,
    name       TEXT        NOT NULL DEFAULT '',
    picture    TEXT        NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions
(
    id         TEXT        PRIMARY KEY,
    user_id    TEXT        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);
