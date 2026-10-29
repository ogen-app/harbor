-- CON-433: the Tenant P&L tab reads one tenant's counted ledger entries by
-- booked date.
CREATE INDEX IF NOT EXISTS idx_finance_ledger_tenant
    ON finance_ledger_entries (tenant_id, booked_date)
    WHERE voided_at IS NULL AND tenant_id IS NOT NULL;
