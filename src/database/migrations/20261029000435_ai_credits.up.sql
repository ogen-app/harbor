-- AI credits and reconciliation (CON-435). Anthropic and Google are paid with
-- prepaid credit: a top-up receipt is a prepayment, and the expense is the
-- token pipeline's estimate. These tables add the credit balance (opening
-- balance + top-ups − AI expense) and reconcile each closed month's estimate
-- with what the vendor actually charged.

-- ── Credit accounts ────────────────────────────────────────────────────────
-- One per AI-pipeline vendor. Credit existed before Harbor, so the balance
-- starts from an opening balance on an opening date, entered once; until then
-- the vendor has no balance. alert_days is the runway below which the tab
-- warns.
CREATE TABLE IF NOT EXISTS finance_credit_accounts
(
    vendor_id              TEXT        PRIMARY KEY REFERENCES finance_vendors (id) ON DELETE CASCADE,
    opening_balance_micros BIGINT,
    opening_date           DATE,
    alert_days             INT         NOT NULL DEFAULT 30 CHECK (alert_days BETWEEN 1 AND 365),
    updated_by             TEXT        NOT NULL DEFAULT 'system',
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((opening_balance_micros IS NULL) = (opening_date IS NULL))
);

-- ── Vendor charges ─────────────────────────────────────────────────────────
-- What the vendor charged for a month, from its own report (Anthropic's Admin
-- API cost report) or entered by hand. month is the first day of the UTC
-- month. status:
--   open            the month is not closed yet, or not reconciled yet
--   auto_accepted   within the drift threshold; a reconciliation entry posted
--   pending_review  over the threshold; waits for an operator
--   accepted        an operator accepted the charge; entry posted
--   dismissed       an operator kept the estimate (note says why)
-- estimate_micros_at_check is the estimate the status was decided against.
CREATE TABLE IF NOT EXISTS finance_vendor_charges
(
    vendor_id                TEXT        NOT NULL REFERENCES finance_vendors (id) ON DELETE CASCADE,
    month                    DATE        NOT NULL CHECK (extract(day FROM month) = 1),
    charged_micros           BIGINT      NOT NULL,
    estimate_micros_at_check BIGINT,
    source                   TEXT        NOT NULL CHECK (source IN ('admin_api', 'billing_export', 'manual')),
    status                   TEXT        NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'pending_review', 'accepted', 'dismissed', 'auto_accepted')),
    reviewed_by              TEXT,
    reviewed_at              TIMESTAMPTZ,
    note                     TEXT        NOT NULL DEFAULT '',
    fetched_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (vendor_id, month)
);

-- The vendor's own breakdown of a charge, per day, model and cost type, for
-- the Review drawer. Only vendor reports have lines; a manual charge has none.
CREATE TABLE IF NOT EXISTS finance_vendor_charge_lines
(
    vendor_id  TEXT   NOT NULL REFERENCES finance_vendors (id) ON DELETE CASCADE,
    day        DATE   NOT NULL,
    model      TEXT   NOT NULL DEFAULT '',
    cost_type  TEXT   NOT NULL DEFAULT '',
    usd_micros BIGINT NOT NULL,
    PRIMARY KEY (vendor_id, day, model, cost_type)
);

-- ── Settings ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS finance_settings
(
    key        TEXT        PRIMARY KEY,
    value      JSONB       NOT NULL,
    updated_by TEXT        NOT NULL DEFAULT 'system',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO finance_settings (key, value) VALUES ('drift_threshold_pct', '5')
ON CONFLICT (key) DO NOTHING;

-- ── Reconciliation entries ─────────────────────────────────────────────────
-- charged − estimate for a reconciled month, booked on the month's last day.
-- Company level only: a tenant's AI cost stays the measured estimate.
ALTER TABLE finance_ledger_entries DROP CONSTRAINT IF EXISTS finance_ledger_entries_source_check;
ALTER TABLE finance_ledger_entries ADD CONSTRAINT finance_ledger_entries_source_check
    CHECK (source IN ('receipt', 'token_pipeline', 'billing_v1', 'receipt_extraction', 'reconciliation'));
ALTER TABLE finance_ledger_entries ADD CONSTRAINT finance_ledger_entries_reconciliation_company
    CHECK (source <> 'reconciliation' OR tenant_id IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_ledger_reconciliation
    ON finance_ledger_entries (source, vendor_id, booked_date)
    WHERE source = 'reconciliation';
