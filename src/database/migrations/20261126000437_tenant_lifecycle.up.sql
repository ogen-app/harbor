-- Tenant lifecycle snapshots. Once a day Harbor records every
-- tenant's lifecycle stage, so the Lifecycle tab can mark what moved since the
-- previous snapshot and draw each tenant's health over time. The stage itself
-- is computed from Ogen's database and the analytics pipeline; Ogen keeps no
-- history of it.
--
-- progress  the furthest milestone: signed_up, connected, generating,
--           first_post, regular
-- health    active, cooling, quiet, or churned (suspended or deleted)
-- reasons   the chip's reasons that day, highest priority first
CREATE TABLE IF NOT EXISTS tenant_stage_snapshots
(
    snapshot_date    DATE        NOT NULL,
    tenant_id        TEXT        NOT NULL,
    progress         TEXT        NOT NULL CHECK (progress IN ('signed_up', 'connected', 'generating', 'first_post', 'regular')),
    health           TEXT        NOT NULL CHECK (health IN ('active', 'cooling', 'quiet', 'churned')),
    entered_stage_at TIMESTAMPTZ NOT NULL,
    stuck            BOOLEAN     NOT NULL DEFAULT false,
    reasons          JSONB       NOT NULL DEFAULT '[]',
    recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (snapshot_date, tenant_id)
);

-- One tenant's history, for its Lifecycle card.
CREATE INDEX IF NOT EXISTS idx_tenant_stage_snapshots_tenant
    ON tenant_stage_snapshots (tenant_id, snapshot_date);
