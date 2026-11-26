-- CON-532: Polar replaces Lemon Squeezy as the merchant of record (CON-523).
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
