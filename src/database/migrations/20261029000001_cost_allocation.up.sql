-- Shared cost allocation (CON-432). Railway, Resend, Cloudflare, Zernio and any
-- operator-added vendor send one bill for everyone; these tables split each
-- month's posted bill across tenants by a per-vendor rule, so the tenant P&L
-- and margin can carry a share of shared costs.
--
-- Allocations live apart from the ledger: the ledger stays the record of real
-- money and the company P&L never reads these tables.

-- ── Rules ──────────────────────────────────────────────────────────────────
-- One rule per shared vendor. A vendor without a row is not split (company
-- overhead), so a vendor added later needs no row until an operator picks a
-- rule.
CREATE TABLE IF NOT EXISTS finance_allocation_rules
(
    vendor_id  TEXT        PRIMARY KEY REFERENCES finance_vendors (id) ON DELETE CASCADE,
    rule       TEXT        NOT NULL
        CHECK (rule IN ('even', 'ai_cost', 'active_users', 'posts', 'emails', 'none')),
    updated_by TEXT        NOT NULL DEFAULT 'system',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO finance_allocation_rules (vendor_id, rule)
SELECT id,
       CASE id
           WHEN 'railway' THEN 'even'
           WHEN 'cloudflare' THEN 'even'
           WHEN 'resend' THEN 'emails'
           WHEN 'zernio' THEN 'posts'
           ELSE 'none'
       END
FROM finance_vendors
WHERE NOT is_ai_pipeline
  AND category <> 'revenue'
ON CONFLICT (vendor_id) DO NOTHING;

-- ── Driver snapshots ───────────────────────────────────────────────────────
-- A month's driver quantities per tenant, saved so a past month stays
-- explainable after Ogen's data changes. finance_allocation_snapshots marks a
-- (month, driver) as captured, which tells "no activity" (captured, no rows)
-- apart from "never read". month is the first day of the UTC month.
CREATE TABLE IF NOT EXISTS finance_allocation_snapshots
(
    month       DATE        NOT NULL,
    driver      TEXT        NOT NULL
        CHECK (driver IN ('active_tenants', 'ai_cost', 'active_users', 'posts', 'emails')),
    captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (month, driver)
);

CREATE TABLE IF NOT EXISTS finance_allocation_drivers
(
    month       DATE        NOT NULL,
    driver      TEXT        NOT NULL,
    tenant_id   TEXT        NOT NULL,
    quantity    BIGINT      NOT NULL CHECK (quantity > 0),
    captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (month, driver, tenant_id),
    FOREIGN KEY (month, driver) REFERENCES finance_allocation_snapshots (month, driver) ON DELETE CASCADE
);

-- ── Allocations ────────────────────────────────────────────────────────────
-- One split per (month, vendor): the rule it used and the bill it split. A
-- vendor that isn't split still gets a row (rule 'none', no shares), so the
-- month remembers its rule. bill_usd_micros is compared with the ledger to find
-- months whose bill changed since (an approved or voided receipt).
CREATE TABLE IF NOT EXISTS finance_allocation_splits
(
    month           DATE        NOT NULL,
    vendor_id       TEXT        NOT NULL REFERENCES finance_vendors (id) ON DELETE CASCADE,
    rule            TEXT        NOT NULL
        CHECK (rule IN ('even', 'ai_cost', 'active_users', 'posts', 'emails', 'none')),
    -- The driver actually used: the rule's own, or active_tenants after a
    -- fallback. NULL when nothing was split.
    driver          TEXT,
    bill_usd_micros BIGINT      NOT NULL,
    driver_total    BIGINT      NOT NULL DEFAULT 0,
    -- The rule's driver totalled zero, so the bill was split evenly instead (or,
    -- with no active tenants either, not at all).
    fallback        BOOLEAN     NOT NULL DEFAULT false,
    computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (month, vendor_id)
);

-- Each tenant's share. The shares of a split add up exactly to its bill
-- (largest-remainder rounding in micros).
CREATE TABLE IF NOT EXISTS finance_allocations
(
    month             DATE   NOT NULL,
    vendor_id         TEXT   NOT NULL,
    tenant_id         TEXT   NOT NULL,
    amount_usd_micros BIGINT NOT NULL,
    driver_quantity   BIGINT NOT NULL,
    PRIMARY KEY (month, vendor_id, tenant_id),
    FOREIGN KEY (month, vendor_id) REFERENCES finance_allocation_splits (month, vendor_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_finance_allocations_tenant ON finance_allocations (tenant_id, month);
