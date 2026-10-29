DROP INDEX IF EXISTS uq_finance_ledger_reconciliation;
DELETE FROM finance_ledger_entries WHERE source = 'reconciliation';
ALTER TABLE finance_ledger_entries DROP CONSTRAINT IF EXISTS finance_ledger_entries_reconciliation_company;
ALTER TABLE finance_ledger_entries DROP CONSTRAINT IF EXISTS finance_ledger_entries_source_check;
ALTER TABLE finance_ledger_entries ADD CONSTRAINT finance_ledger_entries_source_check
    CHECK (source IN ('receipt', 'token_pipeline', 'billing_v1', 'receipt_extraction'));

DROP TABLE IF EXISTS finance_settings;
DROP TABLE IF EXISTS finance_vendor_charge_lines;
DROP TABLE IF EXISTS finance_vendor_charges;
DROP TABLE IF EXISTS finance_credit_accounts;
