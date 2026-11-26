-- Polar replaces Lemon Squeezy as the merchant of record.
-- New payments are booked against the polar vendor; lemonsqueezy ledger rows
-- stay as history and are not rewritten.
INSERT INTO finance_vendors (id, name, category, match_rules, is_ai_pipeline)
VALUES ('polar', 'Polar', 'revenue', '{}', false)
ON CONFLICT (id) DO NOTHING;

-- fx_source says where a payment's USD conversion came from: identity (USD),
-- ecb (Ogen at the ECB reference rate of fx_date) or polar. NULL for every
-- other entry, and for Lemon Squeezy payments, whose rate is derived from the
-- provider's own USD amount.
ALTER TABLE finance_ledger_entries
    ADD COLUMN IF NOT EXISTS fx_source TEXT
        CHECK (fx_source IS NULL OR fx_source IN ('identity', 'ecb', 'polar'));

-- pending_from is the oldest payment a revenue sync left out because Ogen had
-- not converted it to USD yet. The next sync reads back to it as well as its
-- usual overlap, so a late conversion is never missed; NULL when none waits.
ALTER TABLE finance_sync_state ADD COLUMN IF NOT EXISTS pending_from TIMESTAMPTZ;
