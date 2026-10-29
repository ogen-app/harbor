package finance

import (
	"errors"
	"testing"
	"time"

	"github.com/ogen-app/harbor/src/repository/ogenbilling"
)

// The /tenants Margin column and the single-tenant read share one fold: for
// every tenant the batch figures equal TenantFiguresFor, and they follow the
// P&L formula over the month to date in the /pnl billing mode.
func TestTenantMargins(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	oct := func(d int) time.Time { return time.Date(2026, 10, d, 9, 0, 0, 0, time.UTC) }
	h.payments.payments = []ogenbilling.Payment{
		// t1: $24 with $4 tax and a $1.70 fee → net $18.30.
		{ID: "p1", ProviderID: "LS-1", Kind: "subscription_invoice", Currency: "USD", Total: 2400, TotalUSD: 2400, Tax: 400, TaxUSD: 400, Fee: 170, FeeUSD: 170, OccurredAt: oct(3), TenantID: "t1"},
		// t2: $10 with a $0.80 fee → net $9.20, but $12 of AI: a loss.
		{ID: "p2", ProviderID: "LS-2", Kind: "subscription_invoice", Currency: "USD", Total: 1000, TotalUSD: 1000, Fee: 80, FeeUSD: 80, OccurredAt: oct(4), TenantID: "t2"},
		// t5: paid and fully refunded → net $0, so no margin.
		{ID: "p5", ProviderID: "LS-5", Kind: "order", Currency: "USD", Total: 500, TotalUSD: 500, OccurredAt: oct(5), TenantID: "t5"},
		{ID: "p5r", ProviderID: "LS-5", Kind: "refund", Currency: "USD", Total: 500, TotalUSD: 500, OccurredAt: oct(6), TenantID: "t5"},
		// Test mode never mixes with live, and September is outside the month.
		{ID: "p4", ProviderID: "LS-T", Kind: "order", Currency: "USD", Total: 99900, TotalUSD: 99900, OccurredAt: oct(5), TenantID: "t1", TestMode: true},
		{ID: "p6", ProviderID: "LS-6", Kind: "order", Currency: "USD", Total: 7000, TotalUSD: 7000, OccurredAt: time.Date(2026, 9, 20, 9, 0, 0, 0, time.UTC), TenantID: "t1"},
	}
	if err := h.svc.SyncRevenue(ctx); err != nil {
		t.Fatal(err)
	}
	usage := []struct {
		at     time.Time
		tenant string
		model  string
		cost   int64
	}{
		{oct(3), "t1", "claude-sonnet-5", 5_000_000},
		{oct(10), "t1", "gemini-2.5-flash", 1_000_000},
		{time.Date(2026, 9, 30, 9, 0, 0, 0, time.UTC), "t1", "claude-sonnet-5", 40_000_000}, // last month
		{oct(8), "t2", "claude-sonnet-5", 12_000_000},
		{oct(9), "t3", "claude-sonnet-5", 2_000_000}, // trial: costs, no payments
	}
	for _, u := range usage {
		if _, err := h.db.Exec(`INSERT INTO vendor_usage_events (occurred_at, tenant_id, vendor, model, cost_micros) VALUES (?, ?, 'anthropic', ?, ?)`,
			u.at, u.tenant, u.model, u.cost); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.svc.MaterialiseAIUsage(ctx); err != nil {
		t.Fatal(err)
	}

	from, to := h.svc.MonthToDate()
	m, err := h.svc.TenantMargins(ctx, from, to)
	if err != nil {
		t.Fatal(err)
	}
	if !m.RevenueAvailable || m.Period.Label != "Oct 1–26" || m.SharedIncluded {
		t.Fatalf("meta = available %v, label %q, shared %v", m.RevenueAvailable, m.Period.Label, m.SharedIncluded)
	}

	want := map[string]struct {
		net         *int64
		ai, contrib int64
		margin      *float64
	}{
		"t1": {new(int64(18_300_000)), 6_000_000, 12_300_000, new(12.3 / 18.3 * 100)},
		"t2": {new(int64(9_200_000)), 12_000_000, -2_800_000, new(-2.8 / 9.2 * 100)},
		"t3": {nil, 2_000_000, -2_000_000, nil},
		"t5": {new(int64(0)), 0, 0, nil},
	}
	if len(m.ByTenant) != len(want) {
		t.Errorf("tenants = %v, want %d", m.ByTenant, len(want))
	}
	for id, w := range want {
		got := m.ByTenant[id]
		if !eqPtr(got.NetRevenue, w.net) || got.DirectAI != w.ai || got.Contribution != w.contrib || !nearPtr(got.MarginPct, w.margin) {
			t.Errorf("%s = net %v ai %d contrib %d margin %v; want net %v ai %d contrib %d margin %v",
				id, val(got.NetRevenue), got.DirectAI, got.Contribution, val(got.MarginPct), val(w.net), w.ai, w.contrib, val(w.margin))
		}
		one, ok, err := h.svc.TenantFiguresFor(ctx, id, from, to)
		if err != nil || !ok {
			t.Fatalf("%s: single read ok=%v err=%v", id, ok, err)
		}
		if !eqPtr(one.NetRevenue, got.NetRevenue) || one.DirectAI != got.DirectAI || one.Contribution != got.Contribution || !nearPtr(one.MarginPct, got.MarginPct) {
			t.Errorf("%s: single %+v != batch %+v", id, one, got)
		}
	}

	// Summed over tenants, revenue equals the company's net revenue (every
	// live payment here carries a tenant).
	sum, err := h.svc.Summary(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var total int64
	for _, f := range m.ByTenant {
		total += val(f.NetRevenue)
	}
	if sum.NetRevenue.Value == nil || *sum.NetRevenue.Value != total {
		t.Errorf("tenant revenue %d != company net %v", total, sum.NetRevenue.Value)
	}

	// Unavailable revenue is never shown as zero.
	h2 := newHarness(t)
	h2.payments.err = errors.New("billing down")
	_ = h2.svc.SyncRevenue(ctx)
	m2, err := h2.svc.TenantMargins(ctx, from, to)
	if err != nil {
		t.Fatal(err)
	}
	if m2.RevenueAvailable || m2.RevenueError == "" || len(m2.ByTenant) != 0 {
		t.Errorf("unavailable: %+v", m2)
	}
	if _, ok, _ := h2.svc.TenantFiguresFor(ctx, "t1", from, to); ok {
		t.Error("single read ok while revenue is unavailable")
	}
}

func val[T any](p *T) T {
	var zero T
	if p == nil {
		return zero
	}
	return *p
}

func eqPtr(a, b *int64) bool { return (a == nil) == (b == nil) && val(a) == val(b) }

func nearPtr(a, b *float64) bool {
	if (a == nil) != (b == nil) {
		return false
	}
	d := val(a) - val(b)
	return d < 1e-9 && d > -1e-9
}
