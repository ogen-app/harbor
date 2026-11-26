package finance

import (
	"testing"
	"time"

	fin "github.com/ogen-app/harbor/src/repository/finance"
	"github.com/ogen-app/harbor/src/repository/ogenbilling"
)

// A payment is booked against its provider, a Polar payment carries Ogen's ECB
// conversion as is, a Lemon Squeezy one derives its rate from the provider's
// own USD amount, and a payment not converted yet books nothing.
func TestPaymentEntries(t *testing.T) {
	at := time.Date(2026, 11, 25, 9, 0, 0, 0, time.UTC)
	polar := ogenbilling.Payment{
		ID: "p1", Provider: "polar", ProviderID: "ord_1", Kind: "order", Currency: "eur",
		Total: 5000, TotalUSD: new(int64(5400)), Tax: 1000, TaxUSD: new(int64(1080)), Fee: 250, FeeUSD: new(int64(270)),
		FxRate: "1.08", FxSource: "ecb", FxDate: "2026-11-24", OccurredAt: at,
	}
	entries := PaymentEntries(polar)
	if len(entries) != 3 {
		t.Fatalf("polar entries = %+v", entries)
	}
	for _, e := range entries {
		if e.VendorID != fin.VendorPolar || e.Currency != "EUR" {
			t.Errorf("entry %s: vendor %q currency %q", e.Direction, e.VendorID, e.Currency)
		}
		if e.FxRate == nil || *e.FxRate != 1.08 || e.FxSource == nil || *e.FxSource != "ecb" || e.FxDate == nil || e.FxDate.Format(time.DateOnly) != "2026-11-24" {
			t.Errorf("entry %s: fx = %v %v %v, want Ogen's ECB rate of its day", e.Direction, e.FxRate, e.FxSource, e.FxDate)
		}
	}
	if rev := entries[0]; rev.AmountUSDMicros != 54_000_000 || rev.AmountMicros != 50_000_000 {
		t.Errorf("revenue = %+v", rev)
	}

	waiting := polar
	waiting.TotalUSD, waiting.TaxUSD, waiting.FeeUSD = nil, nil, nil
	waiting.FxRate, waiting.FxSource, waiting.FxDate = "", "", ""
	if got := PaymentEntries(waiting); got != nil {
		t.Errorf("unconverted payment booked %+v, want nothing", got)
	}

	ls := ogenbilling.Payment{
		ID: "p2", Provider: "lemonsqueezy", ProviderID: "LS-1", Kind: "subscription_invoice", Currency: "EUR",
		Total: 5000, TotalUSD: new(int64(5500)), OccurredAt: at,
	}
	e := PaymentEntries(ls)
	if len(e) != 1 || e[0].VendorID != fin.VendorLemonSqueezy || e[0].FxSource != nil || e[0].FxRate == nil || *e[0].FxRate != 1.1 {
		t.Errorf("lemon squeezy entry = %+v (rate %v)", e, e[0].FxRate)
	}

	usd := ogenbilling.Payment{ID: "p3", Provider: "polar", Kind: "order", Currency: "USD", Total: 4900, TotalUSD: new(int64(4900)), FxRate: "1", FxSource: "identity", OccurredAt: at}
	if e := PaymentEntries(usd); len(e) != 1 || e[0].FxRate != nil || e[0].FxSource == nil || *e[0].FxSource != "identity" {
		t.Errorf("usd entry = %+v", e)
	}
}

// A Polar payment waiting for its rate is left out of the ledger and booked by
// the sync after Ogen converts it; Lemon Squeezy history and Polar payments get
// a gross row each, and the Ledger marks the ECB conversion.
func TestRevenueSyncPolar(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	at := func(d int) time.Time { return time.Date(2026, 10, d, 9, 0, 0, 0, time.UTC) }
	waiting := ogenbilling.Payment{ID: "pp1", Provider: "polar", ProviderID: "ord_1", Kind: "order", Currency: "EUR", Total: 5000, OccurredAt: at(10), TenantID: "t1"}
	h.payments.payments = []ogenbilling.Payment{
		{ID: "lp1", Provider: "lemonsqueezy", ProviderID: "LS-1", Kind: "subscription_invoice", Currency: "USD", Total: 2400, TotalUSD: new(int64(2400)), OccurredAt: at(3), TenantID: "t1"},
		waiting,
	}
	if err := h.svc.SyncRevenue(ctx); err != nil {
		t.Fatal(err)
	}
	if n, _ := ledgerSum(t, h.db, "source = 'billing_v1' AND vendor_id = 'polar'"); n != 0 {
		t.Fatalf("unconverted polar payment booked %d entries", n)
	}

	converted := waiting
	converted.TotalUSD = new(int64(5400))
	converted.FxRate, converted.FxSource, converted.FxDate = "1.08", "ecb", "2026-10-10"
	h.payments.payments[1] = converted
	h.now = h.now.Add(time.Hour)
	if err := h.svc.SyncRevenue(ctx); err != nil {
		t.Fatal(err)
	}
	if n, sum := ledgerSum(t, h.db, "source = 'billing_v1' AND vendor_id = 'polar' AND fx_source = 'ecb'"); n != 1 || sum != 54_000_000 {
		t.Fatalf("converted polar payment: %d entries, %d micros", n, sum)
	}
	if n, _ := ledgerSum(t, h.db, "source = 'billing_v1' AND vendor_id = 'lemonsqueezy' AND fx_source IS NULL"); n != 1 {
		t.Fatalf("lemon squeezy payment: %d entries", n)
	}
	// The second pass read back to the waiting payment, far behind its overlap
	// window (the sync's last success is now, the payment is weeks old).
	if got := h.payments.froms[1]; !got.Equal(waiting.OccurredAt) {
		t.Errorf("second sync read from %v, want the pending payment's %v", got, waiting.OccurredAt)
	}
	state, err := fin.New(h.db).GetSync(ctx, SyncRevenueKey(false))
	if err != nil {
		t.Fatal(err)
	}
	if state.PendingFrom != nil {
		t.Errorf("pending_from = %v after the conversion, want cleared", state.PendingFrom)
	}
	if err := h.svc.SyncRevenue(ctx); err != nil {
		t.Fatal(err)
	}
	if got := h.payments.froms[2]; !got.After(waiting.OccurredAt) {
		t.Errorf("third sync read from %v, want the plain overlap window once nothing waits", got)
	}

	m, err := h.svc.Monthly(ctx, monthStart(2026, 10), monthStart(2026, 10))
	if err != nil {
		t.Fatal(err)
	}
	polarRow, lsRow := rowByKey(m.Rows, "revenue_gross"), rowByKey(m.Rows, "revenue_gross_lemonsqueezy")
	if polarRow == nil || polarRow.Label != "Polar, gross" || cellMicros(polarRow.Cells[0]) != 54_000_000 {
		t.Errorf("polar gross row = %+v", polarRow)
	}
	if lsRow == nil || lsRow.Label != "Lemon Squeezy, gross" || cellMicros(lsRow.Cells[0]) != 24_000_000 {
		t.Errorf("lemon squeezy gross row = %+v", lsRow)
	}
	if net := rowByKey(m.Rows, "net_revenue"); net == nil || cellMicros(net.Cells[0]) != 78_000_000 {
		t.Errorf("net revenue = %+v", net)
	}

	page, err := h.svc.Ledger(ctx, LedgerFilter{From: monthStart(2026, 10), To: dateOnly(h.now), Sources: []string{fin.SourceBilling}}, "", 10, nil)
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, r := range page.Rows {
		if r.VendorID == fin.VendorPolar {
			found = true
			if r.FxSource != "ecb" || r.FxDate != "2026-10-10" || r.VendorName != "Polar" {
				t.Errorf("polar ledger row = %+v", r)
			}
		}
	}
	if !found {
		t.Errorf("no polar row in the ledger: %+v", page.Rows)
	}
}

// Without Lemon Squeezy payments in the range, revenue shows a single Polar row.
func TestRevenueSyncPolarOnly(t *testing.T) {
	h := newHarness(t)
	m, err := h.svc.Monthly(t.Context(), monthStart(2026, 10), monthStart(2026, 10))
	if err != nil {
		t.Fatal(err)
	}
	if rowByKey(m.Rows, "revenue_gross_lemonsqueezy") != nil || rowByKey(m.Rows, "revenue_gross") == nil {
		t.Errorf("gross rows = %+v", m.Rows)
	}
}

// A payment listed again with a corrected conversion replaces its rate, date
// and source, not only its amounts.
func TestUpsertPaymentEntriesFx(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	repo := fin.New(h.db)
	p := ogenbilling.Payment{
		ID: "pp1", Provider: "polar", ProviderID: "ord_1", Kind: "order", Currency: "EUR", Total: 5000,
		TotalUSD: new(int64(5400)), FxRate: "1.08", FxSource: "ecb", FxDate: "2026-10-10",
		OccurredAt: time.Date(2026, 10, 10, 9, 0, 0, 0, time.UTC),
	}
	if err := repo.UpsertPaymentEntries(ctx, PaymentEntries(p)); err != nil {
		t.Fatal(err)
	}
	p.TotalUSD, p.FxRate, p.FxDate = new(int64(5450)), "1.09", "2026-10-11"
	if err := repo.UpsertPaymentEntries(ctx, PaymentEntries(p)); err != nil {
		t.Fatal(err)
	}
	var row struct {
		Rate   float64 `bun:"rate"`
		Date   string  `bun:"day"`
		Source string  `bun:"src"`
		USD    int64   `bun:"usd"`
	}
	if err := h.db.NewRaw(`SELECT fx_rate::float8 AS rate, to_char(fx_date, 'YYYY-MM-DD') AS day, fx_source AS src, amount_usd_micros AS usd
		FROM finance_ledger_entries WHERE source_ref = 'pp1' AND direction = 'revenue'`).Scan(ctx, &row); err != nil {
		t.Fatal(err)
	}
	if row.Rate != 1.09 || row.Date != "2026-10-11" || row.Source != "ecb" || row.USD != 54_500_000 {
		t.Errorf("after the corrected conversion: %+v", row)
	}
}
