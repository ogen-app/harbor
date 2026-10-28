package finance

import (
	"testing"
	"time"

	fin "github.com/ogen-app/harbor/src/repository/finance"
)

// Re-extract reads the stored email again: a new version replaces the edits
// and the receipt is re-posted with the fresh amounts.
func TestReextract(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	h.receive(t, "re_1", railwayReceipt("2213-4471"))
	parsed, _ := h.svc.repo.ReceiptsByStatus(ctx, fin.StatusParsed)
	id := parsed[0].ID

	fresh := railwayReceipt("2213-4471")
	fresh.Extraction.LineItems = fresh.Extraction.LineItems[:1]
	fresh.Extraction.LineItems[0].AmountMicros = micros(90)
	fresh.Extraction.SubtotalMicros, fresh.Extraction.TotalMicros = micros(90), micros(90)
	h.proc.raw = fresh

	rc, eff, err := h.svc.ReextractReceipt(ctx, "ops@ogen.app", id)
	if err != nil {
		t.Fatal(err)
	}
	if rc.Status != fin.StatusParsed || eff.AmountMicros != 90_000_000-86_180_000 || eff.Entries != 5 {
		t.Errorf("status %s effect %+v", rc.Status, eff)
	}
	if _, sum := ledgerSum(t, h.db, "source = 'receipt'"); sum != 90_000_000 {
		t.Errorf("ledger after re-extract = %d", sum)
	}
	if _, cost := ledgerSum(t, h.db, "source = 'receipt_extraction'"); cost != 8_400 {
		t.Errorf("both readings should be booked: %d", cost)
	}
	d, _ := h.svc.ReceiptDetail(ctx, id)
	if len(d.Extractions) != 2 || !d.Extractions[0].Current || d.Extractions[0].Version != 2 {
		t.Errorf("extractions = %+v", d.Extractions)
	}
}

// Ignore → Rejected, Restore within 30 days, and purge after.
func TestRejectRestorePurge(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	res := railwayReceipt("X-1")
	res.Extraction.TaxMicros = micros(5) // totals no longer add up
	h.receive(t, "re_1", res)
	att, _ := h.svc.Attention(ctx)
	id := att.Open[0].ID

	if _, _, err := h.svc.RejectReceipt(ctx, "ops@ogen.app", id, ""); err != nil {
		t.Fatal(err)
	}
	att, _ = h.svc.Attention(ctx)
	if len(att.Open) != 0 || len(att.Rejected) != 1 || att.Rejected[0].PurgeAt == nil {
		t.Fatalf("after reject: %+v", att)
	}
	rc, _, err := h.svc.RestoreReceipt(ctx, "ops@ogen.app", id)
	if err != nil {
		t.Fatal(err)
	}
	if rc.Status != fin.StatusNeedsAttention || rc.AttentionReason != CheckTotals {
		t.Errorf("restored: %s %s", rc.Status, rc.AttentionReason)
	}

	if _, _, err := h.svc.RejectReceipt(ctx, "ops@ogen.app", id, ""); err != nil {
		t.Fatal(err)
	}
	h.now = h.now.Add(31 * 24 * time.Hour)
	if _, _, err := h.svc.RestoreReceipt(ctx, "ops@ogen.app", id); !isConflict(err) {
		t.Errorf("restore after 30 days: %v", err)
	}
	if err := h.svc.PurgeRejected(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.repo.GetReceipt(ctx, id, false); !IsNotFound(err) {
		t.Errorf("purged receipt still there: %v", err)
	}
	var emails int
	_ = h.db.NewRaw(`SELECT count(*) FROM finance_inbound_emails`).Scan(ctx, &emails)
	if emails != 0 {
		t.Errorf("purged email still stored")
	}
	if _, cost := ledgerSum(t, h.db, "source = 'receipt_extraction'"); cost != 4_200 {
		t.Errorf("reading cost must survive the purge: %d", cost)
	}
}
