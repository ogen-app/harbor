ALTER TABLE finance_sync_state DROP COLUMN IF EXISTS pending_from;
ALTER TABLE finance_ledger_entries DROP COLUMN IF EXISTS fx_source;

-- The vendor is only removed while nothing is booked against it.
DELETE FROM finance_vendors v
WHERE v.id = 'polar'
  AND NOT EXISTS (SELECT 1 FROM finance_ledger_entries l WHERE l.vendor_id = v.id)
  AND NOT EXISTS (SELECT 1 FROM finance_receipts r WHERE r.vendor_id = v.id);
