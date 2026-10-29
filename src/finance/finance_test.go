package finance

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/uptrace/bun"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/ogen-app/harbor/src/repository/analytics"
	fin "github.com/ogen-app/harbor/src/repository/finance"
	"github.com/ogen-app/harbor/src/repository/ogenbilling"
	"github.com/ogen-app/harbor/src/repository/ogenreceipts"
)

func monthStart(y int, m time.Month) time.Time { return time.Date(y, m, 1, 0, 0, 0, 0, time.UTC) }

func ledgerSum(t *testing.T, db *bun.DB, where string, args ...any) (n int, sum int64) {
	t.Helper()
	var row struct {
		N int   `bun:"n"`
		S int64 `bun:"s"`
	}
	if err := db.NewRaw(`SELECT count(*) AS n, COALESCE(sum(amount_usd_micros), 0) AS s
		FROM finance_ledger_entries WHERE voided_at IS NULL AND `+where, args...).Scan(context.Background(), &row); err != nil {
		t.Fatalf("ledger sum: %v", err)
	}
	return row.N, row.S
}

// Every day of materialised AI usage equals the Daily token cost chart's day
// for AI vendors: same UTC bucketing, social rows excluded.
func TestMaterialiseMatchesDailyCost(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	h.now = time.Now().UTC() // DailyCostByModel windows on the database clock
	today := dateOnly(h.now)
	events := []struct {
		at     time.Time
		tenant string
		vendor string
		model  string
		cost   int64
	}{
		{today.Add(-48 * time.Hour), "t1", "anthropic", "claude-sonnet-5", 1_000_000},
		{today.Add(-48 * time.Hour), "t2", "anthropic", "claude-sonnet-5", 500_000},
		{today.Add(-48*time.Hour + time.Hour), "t1", "google", "gemini-2.5-flash", 250_000},
		{today.Add(-24 * time.Hour), "", "anthropic", "claude-haiku-5-5", 70_000}, // untenanted
		{today.Add(-24 * time.Hour), "t1", "zernio", "zernio-post", 9_000_000},    // social: not AI
		{today, "t3", "anthropic", "claude-sonnet-5", 330_000},                    // exactly midnight
		{today.Add(-time.Second), "t3", "anthropic", "claude-sonnet-5", 1},        // last second of yesterday
	}
	for _, e := range events {
		if _, err := h.db.Exec(`INSERT INTO vendor_usage_events (occurred_at, tenant_id, vendor, model, cost_micros) VALUES (?, NULLIF(?, ''), ?, ?, ?)`,
			e.at, e.tenant, e.vendor, e.model, e.cost); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.svc.MaterialiseAIUsage(ctx); err != nil {
		t.Fatalf("materialise: %v", err)
	}

	chart, err := h.spend.DailyCostByModel(ctx, 5)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]int64{}
	for _, r := range chart {
		if analytics.IsAIVendor(r.Model) {
			want[r.Date] += r.CostMicros
		}
	}
	if len(want) != 3 {
		t.Fatalf("chart days = %v, want 3", want)
	}
	for day, cost := range want {
		if _, got := ledgerSum(t, h.db, "source = 'token_pipeline' AND booked_date = ?", day); got != cost {
			t.Errorf("%s: ledger %d, chart %d", day, got, cost)
		}
	}
	if n, _ := ledgerSum(t, h.db, "model = 'zernio-post'"); n != 0 {
		t.Error("social usage was booked as AI expense")
	}

	// A second pass is idempotent; usage that vanishes in the trailing window
	// disappears from the ledger.
	if _, err := h.db.Exec(`DELETE FROM vendor_usage_events WHERE tenant_id = 't3'`); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.MaterialiseAIUsage(ctx); err != nil {
		t.Fatalf("second pass: %v", err)
	}
	total := int64(0)
	for _, c := range want {
		total += c
	}
	if _, got := ledgerSum(t, h.db, "source = 'token_pipeline'"); got != total-330_001 {
		t.Errorf("after delete: %d, want %d", got, total-330_001)
	}
}

func TestReceiptIngestPostsAndDedupes(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()

	h.receive(t, "re_1", railwayReceipt("2213-4471"))
	open, _ := h.svc.repo.ReceiptsByStatus(ctx, fin.StatusParsed)
	if len(open) != 1 {
		t.Fatalf("parsed receipts = %d, want 1", len(open))
	}
	rc := open[0]
	if rc.VendorID == nil || *rc.VendorID != "railway" {
		t.Fatalf("vendor = %v, want railway", rc.VendorID)
	}
	n, sum := ledgerSum(t, h.db, "source = 'receipt'")
	if n != 4 || sum != 86_180_000 {
		t.Fatalf("receipt entries = %d / %d, want 4 / 86180000", n, sum)
	}
	if _, cost := ledgerSum(t, h.db, "source = 'receipt_extraction'"); cost != 4_200 {
		t.Errorf("extraction cost = %d, want 4200", cost)
	}

	// The same Resend id again adds nothing; a re-forward (new id, same
	// invoice) is rejected as a duplicate and adds nothing either.
	if created, _ := h.svc.RecordReceiptEvent(ctx, "re_1"); created {
		t.Error("redelivered event created a second email")
	}
	h.receive(t, "re_2", railwayReceipt("2213-4471"))
	rejected, _ := h.svc.repo.ReceiptsByStatus(ctx, fin.StatusRejected)
	if len(rejected) != 1 || rejected[0].RejectedReason != "Duplicate of invoice 2213-4471" {
		t.Fatalf("rejected = %+v", rejected)
	}
	if n2, sum2 := ledgerSum(t, h.db, "source = 'receipt'"); n2 != n || sum2 != sum {
		t.Errorf("re-forward changed the ledger: %d/%d", n2, sum2)
	}

	// The summary and the monthly table count it once, in October (invoice date).
	m, err := h.svc.Monthly(ctx, monthStart(2026, 9), monthStart(2026, 10))
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range m.Rows {
		if r.Key == "expense:railway" {
			if r.Cells[0].Value != nil || r.Cells[1].Value == nil || *r.Cells[1].Value != 86_180_000 {
				t.Errorf("railway cells = %+v", r.Cells)
			}
			if r.Cells[1].Provenance.Receipts != 1 {
				t.Errorf("provenance = %+v", r.Cells[1].Provenance)
			}
		}
	}

	// Void takes it out of the books and says so.
	_, eff, err := h.svc.VoidReceipt(ctx, "ops@ogen.app", rc.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if eff.AmountMicros != -86_180_000 || eff.Month != "2026-10" || eff.Entries != 4 {
		t.Errorf("void effect = %+v", eff)
	}
	if n, _ := ledgerSum(t, h.db, "source = 'receipt'"); n != 0 {
		t.Errorf("entries after void = %d", n)
	}
	if _, _, err := h.svc.VoidReceipt(ctx, "ops@ogen.app", rc.ID, ""); !isConflict(err) {
		t.Errorf("second void: err = %v, want conflict", err)
	}
	d, err := h.svc.ReceiptDetail(ctx, rc.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(d.History) != 2 || d.History[0].Action != "void" || len(d.Attachments) != 1 || !d.Attachments[0].Stored {
		t.Errorf("detail history=%+v attachments=%+v", d.History, d.Attachments)
	}
}

func isConflict(err error) bool {
	_, ok := errors.AsType[*ErrConflict](err)
	return ok
}

// A receipt whose totals don't add up waits in Needs attention, counts
// nowhere, and posts once fixed and approved.
func TestNeedsAttentionEditApprove(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	res := railwayReceipt("ZRN-0042")
	res.Headers.ForwardedFrom = "billing@zernio.com"
	res.Extraction.MerchantName = "Zernio"
	res.Extraction.LineItems = res.Extraction.LineItems[:1]
	res.Extraction.LineItems[0] = ogenreceipts.LineItem{Description: "Growth plan, October", AmountMicros: micros(99)}
	res.Extraction.SubtotalMicros, res.Extraction.TaxMicros, res.Extraction.TotalMicros = micros(99), micros(0), micros(118.80)
	h.receive(t, "re_z", res)

	att, err := h.svc.Attention(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(att.Open) != 1 || att.Open[0].Reason != CheckTotals {
		t.Fatalf("attention = %+v", att.Open)
	}
	id := att.Open[0].ID
	if n, _ := ledgerSum(t, h.db, "source = 'receipt'"); n != 0 {
		t.Fatal("a receipt in Needs attention was posted")
	}
	sum, err := h.svc.Summary(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if sum.Provisional == nil || sum.Provisional.Count != 1 || sum.Provisional.AmountMicros != 118_800_000 {
		t.Errorf("provisional = %+v", sum.Provisional)
	}

	if _, _, err := h.svc.ApproveReceipt(ctx, "ops@ogen.app", id); err == nil {
		t.Fatal("approved a receipt whose checks fail")
	}
	_, _, err = h.svc.UpdateReceipt(ctx, "ops@ogen.app", id, ReceiptEdit{TaxMicros: micros(19.80)})
	if err != nil {
		t.Fatal(err)
	}
	rc, eff, err := h.svc.ApproveReceipt(ctx, "ops@ogen.app", id)
	if err != nil {
		t.Fatal(err)
	}
	if rc.Status != fin.StatusApproved || eff.AmountMicros != 118_800_000 || eff.Month != "2026-10" || eff.Entries != 2 {
		t.Errorf("approve: status %s effect %+v", rc.Status, eff)
	}
	if eff.Summary != "Adds $118.80 to Oct 2026 (2 entries)" {
		t.Errorf("summary = %q", eff.Summary)
	}
}

// A forward from someone who isn't a Harbor operator is rejected unposted; an
// email Resend no longer has fails into Needs attention.
func TestRejectsAndFailures(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	res := railwayReceipt("2213-9999")
	res.Headers.From = "stranger@example.com"
	h.receive(t, "re_x", res)
	rejected, _ := h.svc.repo.ReceiptsByStatus(ctx, fin.StatusRejected)
	if len(rejected) != 1 || rejected[0].RejectedReason != "Forwarder isn't a Harbor operator (stranger@example.com)" {
		t.Fatalf("rejected = %+v", rejected)
	}
	if n, _ := ledgerSum(t, h.db, "source = 'receipt'"); n != 0 {
		t.Fatal("a non-operator forward was posted")
	}

	if _, err := h.svc.RecordReceiptEvent(ctx, "re_gone"); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.ProcessDueEmails(ctx); err != nil {
		t.Fatal(err)
	}
	att, _ := h.svc.Attention(ctx)
	if len(att.Open) != 1 || att.Open[0].Kind != "email" || att.Open[0].Detail != "Resend no longer has this email" {
		t.Fatalf("open = %+v", att.Open)
	}
	if err := h.svc.RetryEmail(ctx, "ops@ogen.app", att.Open[0].ID); err != nil {
		t.Fatal(err)
	}

	// A transient error retries later instead of failing.
	h.proc.byID = nil
	e, _ := h.svc.repo.GetEmail(ctx, att.Open[0].ID)
	h.svc.recordFetchFailure(ctx, e, status.Error(codes.Unavailable, "down"))
	e, _ = h.svc.repo.GetEmail(ctx, e.ID)
	if e.Status != fin.EmailPending || e.Attempts != 1 || !e.NextAttemptAt.After(h.now) {
		t.Errorf("after transient failure: %+v", e)
	}
}

// Payments: gross revenue with tax and fee deducted, refunds negative in their
// month, idempotent, and test data never mixed with live.
func TestRevenueSync(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	at := func(d int) time.Time { return time.Date(2026, 10, d, 9, 0, 0, 0, time.UTC) }
	h.payments.payments = []ogenbilling.Payment{
		{ID: "p1", ProviderID: "LS-1", Kind: "subscription_invoice", Currency: "USD", Total: 2400, TotalUSD: 2400, Tax: 400, TaxUSD: 400, Fee: 170, FeeUSD: 170, FeeIsEstimated: true, OccurredAt: at(3), TenantID: "t1"},
		{ID: "p2", ProviderID: "LS-1", Kind: "refund", Currency: "USD", Total: 2400, TotalUSD: 2400, OccurredAt: at(20)},
		{ID: "p3", ProviderID: "LS-T", Kind: "order", Currency: "USD", Total: 99900, TotalUSD: 99900, OccurredAt: at(5), TestMode: true},
	}
	for range 2 {
		if err := h.svc.SyncRevenue(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if n, net := ledgerSum(t, h.db, "source = 'billing_v1'"); n != 4 || net != (2400-400-170-2400)*10_000 {
		t.Fatalf("payments = %d entries, net %d", n, net)
	}
	sum, err := h.svc.Summary(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if sum.NetRevenue.Value == nil || *sum.NetRevenue.Value != -5_700_000 {
		t.Errorf("net revenue = %v", sum.NetRevenue.Value)
	}

	// Revenue never reads as zero while it is unavailable.
	h2 := newHarness(t)
	h2.payments.err = errors.New("billing down")
	_ = h2.svc.SyncRevenue(ctx)
	s2, _ := h2.svc.Summary(ctx)
	m2, _ := h2.svc.Monthly(ctx, monthStart(2026, 10), monthStart(2026, 10))
	if s2.NetRevenue.Value != nil || m2.RevenueAvailable || !m2.Rows[0].Cells[0].Unavailable {
		t.Errorf("unavailable revenue: summary %v, monthly available=%v cell=%+v", s2.NetRevenue.Value, m2.RevenueAvailable, m2.Rows[0].Cells[0])
	}
	for _, key := range []string{"net_revenue", "profit", "margin"} {
		if r := rowByKey(m2.Rows, key); r == nil || !r.Total.Unavailable {
			t.Errorf("%s total not marked unavailable", key)
		}
	}
}

// The Ledger groups AI usage per vendor per day and a receipt's lines into one
// row each, pages by keyset, and its totals agree with the P&L.
func TestLedgerGroupingAndPaging(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	day := time.Date(2026, 10, 25, 3, 0, 0, 0, time.UTC)
	for i, tenant := range []string{"t1", "t2", "t3"} {
		for _, model := range []string{"claude-sonnet-5", "claude-haiku-5-5"} {
			if _, err := h.db.Exec(`INSERT INTO vendor_usage_events VALUES (?, ?, 'anthropic', ?, ?)`, day, tenant, model, int64(i+1)*100_000); err != nil {
				t.Fatal(err)
			}
		}
	}
	h.now = time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)
	if err := h.svc.MaterialiseAIUsage(ctx); err != nil {
		t.Fatal(err)
	}
	h.receive(t, "re_1", railwayReceipt("2213-4471"))

	f := LedgerFilter{From: monthStart(2026, 10), To: dateOnly(h.now)}
	p1, err := h.svc.Ledger(ctx, f, "", 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if p1.Totals.Rows != 3 || p1.NextCursor == "" || len(p1.Rows) != 1 {
		t.Fatalf("page 1: %+v", p1)
	}
	var rows []LedgerRow
	rows = append(rows, p1.Rows...)
	for cur := p1.NextCursor; cur != ""; {
		p, err := h.svc.Ledger(ctx, f, cur, 1, nil)
		if err != nil {
			t.Fatal(err)
		}
		rows = append(rows, p.Rows...)
		cur = p.NextCursor
	}
	kinds := map[string]LedgerRow{}
	for _, r := range rows {
		kinds[r.Kind] = r
	}
	ai := kinds["ai_group"]
	if len(rows) != 3 || ai.Description != "AI usage · 2 models · 3 tenants" || ai.AmountMicros != 1_200_000 {
		t.Fatalf("rows = %+v", rows)
	}
	if r := kinds["receipt"]; r.Description != "Invoice 2213-4471 · 4 lines" || !r.Expandable {
		t.Errorf("receipt row = %+v", r)
	}
	children, err := h.svc.LedgerChildren(ctx, f, ai.Key, map[string]string{"t3": "Acme"})
	if err != nil {
		t.Fatal(err)
	}
	if len(children) != 6 || children[0].TenantName != "Acme" {
		t.Errorf("children = %+v", children)
	}

	// Not Anthropic leaves the Railway receipt; reading it was Anthropic spend.
	f.NotVendors = []string{"anthropic"}
	if p, _ := h.svc.Ledger(ctx, f, "", 50, nil); p.Totals.Rows != 1 {
		t.Errorf("not anthropic: %d rows", p.Totals.Rows)
	}

	// One aggregation: the Ledger's expense total equals the P&L's.
	m, _ := h.svc.Monthly(ctx, monthStart(2026, 10), monthStart(2026, 10))
	var pnl float64
	for _, r := range m.Rows {
		if r.Key == "total_expenses" {
			pnl = *r.Cells[0].Value
		}
	}
	lf := LedgerFilter{From: monthStart(2026, 10), To: dateOnly(h.now), Types: []string{fin.DirExpense}}
	lp, _ := h.svc.Ledger(ctx, lf, "", 50, nil)
	if float64(lp.Totals.AmountMicros) != pnl {
		t.Errorf("ledger expenses %d ≠ P&L %v", lp.Totals.AmountMicros, pnl)
	}
}
