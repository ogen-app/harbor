-- Finance ledger for the Profit & loss page (CON-412 / CON-420). Harbor owns
-- every table here: vendor receipts forwarded to the inbox, the AI usage
-- materialised from Ogen's token-cost pipeline and the payments synced from
-- billing.v1 all land in one ledger, which every report reads.
--
-- Money is stored in micros (1 USD = 1,000,000), matching cost_micros in
-- Ogen's spend pool. The original currency is kept next to the USD amount.

-- ── Vendors ────────────────────────────────────────────────────────────────
-- match_rules: {"merchant": ["railway"], "senders": ["railway.app"]} — case-
-- insensitive substrings of the printed merchant name and sender domains.
-- is_ai_pipeline marks vendors whose expense comes from the token pipeline
-- (their receipts are prepaid credits, never expense).
CREATE TABLE IF NOT EXISTS finance_vendors
(
    id             TEXT        PRIMARY KEY,
    name           TEXT        NOT NULL,
    category       TEXT        NOT NULL CHECK (category IN ('ai', 'infra', 'email', 'domains', 'social', 'revenue', 'other')),
    match_rules    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    is_ai_pipeline BOOLEAN     NOT NULL DEFAULT false,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO finance_vendors (id, name, category, match_rules, is_ai_pipeline)
VALUES ('anthropic', 'Anthropic', 'ai', '{"merchant": ["anthropic"], "senders": ["anthropic.com"]}', true),
       ('google', 'Google', 'ai', '{"merchant": ["google"], "senders": ["google.com"]}', true),
       ('resend', 'Resend', 'email', '{"merchant": ["resend"], "senders": ["resend.com", "resend.dev"]}', false),
       ('railway', 'Railway', 'infra', '{"merchant": ["railway"], "senders": ["railway.app", "railway.com"]}', false),
       ('cloudflare', 'Cloudflare', 'domains', '{"merchant": ["cloudflare"], "senders": ["cloudflare.com"]}', false),
       ('zernio', 'Zernio', 'social', '{"merchant": ["zernio"], "senders": ["zernio.com"]}', false),
       ('lemonsqueezy', 'Lemon Squeezy', 'revenue', '{}', false)
ON CONFLICT (id) DO NOTHING;

-- ── Inbound emails ─────────────────────────────────────────────────────────
-- One row per Resend inbound email, created pending by the receipt.received
-- webhook (idempotent on resend_email_id) and filled by the receipt job.
CREATE TABLE IF NOT EXISTS finance_inbound_emails
(
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    resend_email_id TEXT        NOT NULL UNIQUE,
    status          TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fetched', 'failed', 'ignored')),
    attempts        INT         NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error      TEXT        NOT NULL DEFAULT '',
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    fetched_at      TIMESTAMPTZ,
    from_addr       TEXT        NOT NULL DEFAULT '',
    forwarded_from  TEXT        NOT NULL DEFAULT '',
    to_addrs        TEXT[]      NOT NULL DEFAULT '{}',
    subject         TEXT        NOT NULL DEFAULT '',
    message_id      TEXT        NOT NULL DEFAULT '',
    email_date      TIMESTAMPTZ,
    text_body       BYTEA,
    html_body       BYTEA,
    raw_mime        BYTEA,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_finance_inbound_emails_due
    ON finance_inbound_emails (next_attempt_at) WHERE status = 'pending';

-- Attachments over the cap keep their metadata with content NULL.
CREATE TABLE IF NOT EXISTS finance_email_attachments
(
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    email_id     UUID        NOT NULL REFERENCES finance_inbound_emails (id) ON DELETE CASCADE,
    filename     TEXT        NOT NULL DEFAULT '',
    content_type TEXT        NOT NULL DEFAULT '',
    size_bytes   BIGINT      NOT NULL,
    content      BYTEA CHECK (content IS NULL OR octet_length(content) <= 10485760),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_finance_email_attachments_email ON finance_email_attachments (email_id);

-- ── Receipts ───────────────────────────────────────────────────────────────
-- One per document. parsed and approved receipts are posted to the ledger;
-- needs_attention ones stay out of every total until approved.
CREATE TABLE IF NOT EXISTS finance_receipts
(
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    email_id              UUID        REFERENCES finance_inbound_emails (id) ON DELETE SET NULL,
    vendor_id             TEXT        REFERENCES finance_vendors (id),
    merchant_name         TEXT        NOT NULL DEFAULT '',
    invoice_number        TEXT        NOT NULL DEFAULT '',
    kind                  TEXT        NOT NULL DEFAULT 'unknown'
        CHECK (kind IN ('invoice', 'receipt', 'prepayment', 'refund', 'credit_note', 'unknown')),
    issue_date            DATE,
    service_period_start  DATE,
    service_period_end    DATE,
    currency              TEXT        NOT NULL DEFAULT '',
    subtotal_micros       BIGINT,
    tax_micros            BIGINT,
    total_micros          BIGINT,
    fx_rate               NUMERIC(20, 10) CHECK (fx_rate IS NULL OR fx_rate > 0),
    fx_date               DATE,
    line_items            JSONB       NOT NULL DEFAULT '[]'::jsonb,
    checks                JSONB       NOT NULL DEFAULT '[]'::jsonb,
    status                TEXT        NOT NULL
        CHECK (status IN ('parsed', 'needs_attention', 'approved', 'rejected', 'voided')),
    attention_reason      TEXT        NOT NULL DEFAULT '',
    rejected_reason       TEXT        NOT NULL DEFAULT '',
    edited                BOOLEAN     NOT NULL DEFAULT false,
    current_extraction_id UUID,
    rejected_at           TIMESTAMPTZ,
    voided_at             TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One live document per vendor + invoice number. Rejected (e.g. a duplicate
-- forward) and voided receipts step aside.
CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_receipts_vendor_invoice
    ON finance_receipts (vendor_id, invoice_number)
    WHERE vendor_id IS NOT NULL AND invoice_number <> '' AND status NOT IN ('rejected', 'voided');

CREATE INDEX IF NOT EXISTS idx_finance_receipts_status ON finance_receipts (status, created_at DESC);

-- Every extraction version of an email, kept for audit and re-extraction.
CREATE TABLE IF NOT EXISTS finance_receipt_extractions
(
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    email_id       UUID        NOT NULL REFERENCES finance_inbound_emails (id) ON DELETE CASCADE,
    receipt_id     UUID        REFERENCES finance_receipts (id) ON DELETE CASCADE,
    version        INT         NOT NULL,
    model_id       TEXT        NOT NULL DEFAULT '',
    prompt_version TEXT        NOT NULL DEFAULT '',
    input_tokens   BIGINT      NOT NULL DEFAULT 0,
    output_tokens  BIGINT      NOT NULL DEFAULT 0,
    cost_micros    BIGINT      NOT NULL DEFAULT 0,
    extraction     JSONB       NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (email_id, version)
);

-- ── Ledger ─────────────────────────────────────────────────────────────────
-- One row per line item, AI usage bucket (day × vendor × model × tenant) or
-- payment component. Amounts are signed: expenses positive, a credit note
-- negative; revenue positive, tax/fees/refunds negative (deducted).
CREATE TABLE IF NOT EXISTS finance_ledger_entries
(
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    direction            TEXT        NOT NULL
        CHECK (direction IN ('revenue', 'tax', 'fee', 'refund', 'expense', 'prepayment')),
    source               TEXT        NOT NULL
        CHECK (source IN ('receipt', 'token_pipeline', 'billing_v1', 'receipt_extraction')),
    source_ref           TEXT        NOT NULL DEFAULT '',
    vendor_id            TEXT        NOT NULL REFERENCES finance_vendors (id),
    receipt_id           UUID        REFERENCES finance_receipts (id) ON DELETE SET NULL,
    email_id             UUID        REFERENCES finance_inbound_emails (id) ON DELETE SET NULL,
    description          TEXT        NOT NULL DEFAULT '',
    amount_micros        BIGINT      NOT NULL,
    currency             TEXT        NOT NULL DEFAULT 'USD',
    amount_usd_micros    BIGINT      NOT NULL,
    fx_rate              NUMERIC(20, 10),
    fx_date              DATE,
    service_period_start DATE,
    service_period_end   DATE,
    booked_date          DATE        NOT NULL,
    tenant_id            TEXT,
    model                TEXT,
    test_mode            BOOLEAN     NOT NULL DEFAULT false,
    voided_at            TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The AI usage key: the materialiser upserts on it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_ledger_ai
    ON finance_ledger_entries (source, booked_date, vendor_id, COALESCE(model, ''), COALESCE(tenant_id, ''))
    WHERE source = 'token_pipeline';

-- A payment's components: the revenue sync upserts on Ogen's payment id.
CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_ledger_payment
    ON finance_ledger_entries (source_ref, direction)
    WHERE source = 'billing_v1';

CREATE INDEX IF NOT EXISTS idx_finance_ledger_booked ON finance_ledger_entries (booked_date DESC) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_finance_ledger_receipt ON finance_ledger_entries (receipt_id) WHERE receipt_id IS NOT NULL;

-- ── Audit + sync state ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS finance_audit_log
(
    id          BIGSERIAL   PRIMARY KEY,
    actor       TEXT        NOT NULL,
    action      TEXT        NOT NULL,
    entity_type TEXT        NOT NULL,
    entity_id   TEXT        NOT NULL,
    before      JSONB,
    after       JSONB,
    effect      JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_finance_audit_entity ON finance_audit_log (entity_type, entity_id, created_at DESC);

-- One row per background sync (ai_usage, revenue:live, revenue:test, …).
CREATE TABLE IF NOT EXISTS finance_sync_state
(
    key             TEXT        PRIMARY KEY,
    last_attempt_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_error      TEXT        NOT NULL DEFAULT '',
    through_date    DATE,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
