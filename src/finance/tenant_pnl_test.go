package finance

import (
	"errors"
	"testing"
	"time"

	fin "github.com/ogen-app/harbor/src/repository/finance"
	"github.com/ogen-app/harbor/src/repository/ogenbilling"
	"github.com/ogen-app/harbor/src/repository/ogenreceipts"
)

// seedTenants books AI usage and payments for three tenants plus untenanted
// rows, in both billing modes, all within this month to date. t1 pays, t2 pays
// with tax, t3 is a trial (usage, no payment).
func seedTenants(t *testing.T, h *harness) {
	t.Helper()
	ctx := t.Context()
	h.now = time.Now().UTC() // the materialiser windows on the database clock
	today := dateOnly(h.now)
	for _, e := range []struct {
		tenant, vendor, model string
		cost                  int64
	}{
		{"t1", "anthropic", "claude-sonnet-5", 18_400_000},
		{"t1", "google", "gemini-2.5-flash", 2_310_000},
		{"t2", "anthropic", "claude-sonnet-5", 5_000_000},
		{"t3", "anthropic", "claude-haiku-5-5", 700_000},
		{"", "anthropic", "claude-haiku-5-5", 300_000}, // untenanted: company level only
	} {
		if _, err := h.db.Exec(`INSERT INTO vendor_usage_events (occurred_at, tenant_id, vendor, model, cost_micros) VALUES (?, NULLIF(?, ''), ?, ?, ?)`,
			today, e.tenant, e.vendor, e.model, e.cost); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.svc.MaterialiseAIUsage(ctx); err != nil {
		t.Fatalf("materialise: %v", err)
	}

	at := today.Add(time.Hour)
	h.payments.payments = []ogenbilling.Payment{
		{ID: "p1", ProviderID: "LS-1", Kind: "subscription_invoice", Currency: "USD", Total: 4900, TotalUSD: 4900, Fee: 300, FeeUSD: 300, OccurredAt: at, TenantID: "t1"},
		{ID: "p2", ProviderID: "LS-2", Kind: "subscription_invoice", Currency: "USD", Total: 2400, TotalUSD: 2400, Tax: 400, TaxUSD: 400, OccurredAt: at, TenantID: "t2"},
		{ID: "p3", ProviderID: "LS-9", Kind: "refund", Currency: "USD", Total: 1000, TotalUSD: 1000, OccurredAt: at}, // untenanted
		{ID: "pt", ProviderID: "LS-T", Kind: "order", Currency: "USD", Total: 99900, TotalUSD: 99900, OccurredAt: at, TenantID: "t1", TestMode: true},
	}
	// Sync test mode first, then live: reports follow the mode synced last.
	h.payments.testMode = true
	if err := h.svc.SyncRevenue(ctx); err != nil {
		t.Fatal(err)
	}
	h.payments.testMode = false
	if err := h.svc.SyncRevenue(ctx); err != nil {
		t.Fatal(err)
	}
}

func rowByKey(rows []Row, key string) *Row {
	for i := range rows {
		if rows[i].Key == key {
			return &rows[i]
		}
	}
	return nil
}

func cellMicros(c Cell) int64 {
	if c.Value == nil {
		return 0
	}
	return int64(*c.Value)
}

// Summed over every tenant, the tenant figures equal the company figures for
// tenant-attributed entries; test-mode payments never count in live mode.
func TestTenantPnLAddsUpToCompany(t *testing.T) {
	h := newHarness(t)
	seedTenants(t, h)
	ctx := t.Context()
	this := monthStart(h.now.Year(), h.now.Month())
	from := this.AddDate(0, -1, 0)

	company, err := h.svc.Monthly(ctx, from, this)
	if err != nil {
		t.Fatal(err)
	}
	companyNet := cellMicros(rowByKey(company.Rows, "net_revenue").Total)
	companyAI := cellMicros(rowByKey(company.Rows, "expense:anthropic").Total) + cellMicros(rowByKey(company.Rows, "expense:google").Total)

	var net, ai int64
	for _, id := range []string{"t1", "t2", "t3"} {
		p, err := h.svc.TenantPnL(ctx, id, from, this)
		if err != nil {
			t.Fatal(err)
		}
		net += cellMicros(rowByKey(p.Rows, "net_revenue").Total)
		for _, r := range p.Rows {
			if r.Section == "direct" {
				ai += cellMicros(r.Total)
			}
		}
		for _, r := range p.Rows {
			for _, c := range append(r.Cells, r.Total) {
				if c.Drill != nil && c.Drill.Tenant != id {
					t.Fatalf("%s %s: drill not scoped to the tenant: %+v", id, r.Key, c.Drill)
				}
			}
		}
	}
	const untenantedRefund, untenantedAI = -10_000_000, 300_000
	if net != companyNet-untenantedRefund {
		t.Errorf("tenant net %d, company %d (minus untenanted refund %d)", net, companyNet, untenantedRefund)
	}
	if ai != companyAI-untenantedAI {
		t.Errorf("tenant AI %d, company %d (minus untenanted %d)", ai, companyAI, untenantedAI)
	}
	// Live only: t1 $49 − $3 fee, t2 $24 − $4 tax (the $999 test order is excluded).
	if net != 66_000_000 {
		t.Errorf("tenant net = %d, want 66000000", net)
	}
}

func TestTenantPnLFigures(t *testing.T) {
	h := newHarness(t)
	seedTenants(t, h)
	ctx := t.Context()
	this := monthStart(h.now.Year(), h.now.Month())

	p, err := h.svc.TenantPnL(ctx, "t1", this, this)
	if err != nil {
		t.Fatal(err)
	}
	// The default rules split shared vendors, but no bill is posted yet: every
	// shared month is pending and counts as 0.
	if !p.RevenueAvailable || !p.RevenueSeen || !p.SharedConfigured || p.Summary.SharedPending != 4 {
		t.Fatalf("flags: available %v, seen %v, shared %v, pending %d", p.RevenueAvailable, p.RevenueSeen, p.SharedConfigured, p.Summary.SharedPending)
	}
	// Contribution = 46.00 − 18.40 − 2.31 = 25.29; margin 54.98%.
	c := rowByKey(p.Rows, "contribution")
	if got := cellMicros(c.Cells[0]); got != 25_290_000 {
		t.Errorf("contribution = %d", got)
	}
	m := rowByKey(p.Rows, "margin")
	if m.Total.Value == nil || *m.Total.Value < 54.97 || *m.Total.Value > 54.99 {
		t.Errorf("margin = %v", m.Total.Value)
	}
	if rowByKey(p.Rows, "tax") != nil {
		t.Error("tax row shown without tax")
	}

	s := p.Summary
	if !s.HasRevenue || s.NetRevenue.Value == nil || *s.NetRevenue.Value != 46_000_000 {
		t.Errorf("summary net = %v", s.NetRevenue.Value)
	}
	if *s.DirectAI.Value != 20_710_000 || len(s.DirectAIBy) != 2 || s.DirectAIBy[0].VendorID != "anthropic" {
		t.Errorf("direct AI = %v by %+v", *s.DirectAI.Value, s.DirectAIBy)
	}
	// All tenants with revenue (t1, t2; not trial t3):
	// (46 − 20.71 + 20 − 5) / (46 + 20) = 61.05%.
	if a := s.AllTenantsMarginPct; a == nil || *a < 61.04 || *a > 61.06 {
		t.Errorf("all tenants margin = %v", a)
	}
}

// A trial tenant with no payment: revenue is "—", costs still show, the
// contribution is their negative and the margin is "—".
func TestTenantPnLTrialNoRevenue(t *testing.T) {
	h := newHarness(t)
	seedTenants(t, h)
	this := monthStart(h.now.Year(), h.now.Month())

	p, err := h.svc.TenantPnL(t.Context(), "t3", this, this)
	if err != nil {
		t.Fatal(err)
	}
	if p.RevenueSeen || p.Summary.HasRevenue {
		t.Fatal("trial tenant has revenue")
	}
	if v := rowByKey(p.Rows, "net_revenue").Total.Value; v != nil {
		t.Errorf("net revenue = %v, want —", *v)
	}
	if got := cellMicros(rowByKey(p.Rows, "direct:anthropic").Total); got != 700_000 {
		t.Errorf("direct AI = %d", got)
	}
	if got := cellMicros(rowByKey(p.Rows, "contribution").Total); got != -700_000 {
		t.Errorf("contribution = %d", got)
	}
	if rowByKey(p.Rows, "margin").Total.Value != nil || p.Summary.MarginPct.Value != nil {
		t.Error("margin shown with no net revenue")
	}
}

// Revenue that could not be read is never shown as zero.
func TestTenantPnLRevenueUnavailable(t *testing.T) {
	h := newHarness(t)
	h.payments.err = errors.New("billing down")
	_ = h.svc.SyncRevenue(t.Context())
	this := monthStart(2026, 10)

	p, err := h.svc.TenantPnL(t.Context(), "t1", this, this)
	if err != nil {
		t.Fatal(err)
	}
	if p.RevenueAvailable || p.RevenueError == "" {
		t.Fatalf("available = %v, error %q", p.RevenueAvailable, p.RevenueError)
	}
	for _, key := range []string{"net_revenue", "contribution", "margin"} {
		if !rowByKey(p.Rows, key).Total.Unavailable {
			t.Errorf("%s not marked unavailable", key)
		}
	}
	if p.Summary.NetRevenue.Value != nil || p.Summary.Contribution.Value != nil || p.Summary.AllTenantsMarginPct != nil {
		t.Error("summary shows revenue while it is unavailable")
	}
}

// seedShared posts this month's Railway bill ($86.18, split evenly across t1–t3)
// and a Zernio bill ($99) whose vendor is set to "Don't split", then runs the
// allocation job. Resend and Cloudflare have no bill this month.
func seedShared(t *testing.T, h *harness) {
	t.Helper()
	ctx := t.Context()
	this := monthStart(h.now.Year(), h.now.Month())
	issued := this.Format(time.DateOnly)
	h.drivers.set(this.Format("2006-01"), fin.DriverActiveTenants, map[string]int64{"t1": 1, "t2": 1, "t3": 1})
	if _, err := h.svc.SaveAllocationRules(ctx, "ops@ogen.app", map[string]string{"zernio": fin.RuleNone}, this, this); err != nil {
		t.Fatal(err)
	}
	h.receive(t, "re_rw", railwayIssued("RW-1", issued))
	zernio := railwayIssued("ZRN-1", issued)
	zernio.Headers.ForwardedFrom = "billing@zernio.com"
	zernio.Extraction.MerchantName = "Zernio"
	zernio.Extraction.LineItems = []ogenreceipts.LineItem{{Description: "Growth plan", AmountMicros: micros(99)}}
	zernio.Extraction.SubtotalMicros, zernio.Extraction.TotalMicros = micros(99), micros(99)
	h.receive(t, "re_z", zernio)
	if err := h.svc.AllocateShared(ctx); err != nil {
		t.Fatalf("allocate: %v", err)
	}
}

// Summed over every tenant, the allocated shares equal the posted shared bills
// minus the "Don't split" vendors; a vendor with no posted bill is pending; the
// contribution takes both costs off; the company P&L is unchanged.
func TestTenantPnLSharedCosts(t *testing.T) {
	h := newHarness(t)
	seedTenants(t, h)
	ctx := t.Context()
	this := monthStart(h.now.Year(), h.now.Month())
	before, err := h.svc.Monthly(ctx, this, this)
	if err != nil {
		t.Fatal(err)
	}
	seedShared(t, h)

	var shared int64
	for _, id := range []string{"t1", "t2", "t3"} {
		p, err := h.svc.TenantPnL(ctx, id, this, this)
		if err != nil {
			t.Fatal(err)
		}
		if !p.SharedConfigured {
			t.Fatalf("%s: shared costs not configured", id)
		}
		if rowByKey(p.Rows, "shared:zernio") != nil {
			t.Errorf("%s: a Don't split vendor has a row", id)
		}
		rw := rowByKey(p.Rows, "shared:railway")
		if rw == nil || rw.SourceLabel != "Even split" || rw.Cells[0].Awaiting {
			t.Fatalf("%s railway row = %+v", id, rw)
		}
		shared += cellMicros(rw.Total)
		for _, v := range []string{"resend", "cloudflare"} {
			r := rowByKey(p.Rows, "shared:"+v)
			if r == nil || !r.Cells[0].Awaiting || r.Cells[0].Value != nil {
				t.Errorf("%s %s: want a pending month, got %+v", id, v, r)
			}
		}
		if id == "t1" {
			// 46.00 − 20.71 AI − 28.726667 Railway.
			if got := cellMicros(rowByKey(p.Rows, "contribution").Total); got != 46_000_000-20_710_000-28_726_667 {
				t.Errorf("t1 contribution = %d", got)
			}
			s := p.Summary
			if s.SharedCosts.Value == nil || *s.SharedCosts.Value != 28_726_667 || s.SharedPending != 2 {
				t.Errorf("t1 summary shared = %v, pending %d", s.SharedCosts.Value, s.SharedPending)
			}
			if *s.Contribution.Value != 46_000_000-20_710_000-28_726_667 {
				t.Errorf("t1 summary contribution = %d", *s.Contribution.Value)
			}
		}
	}
	bills, err := h.svc.repo.SharedBills(ctx, this, this)
	if err != nil {
		t.Fatal(err)
	}
	var posted int64
	for _, b := range bills {
		if b.VendorID != "zernio" {
			posted += b.USDMicros
		}
	}
	if posted != 86_180_000 || shared != posted {
		t.Errorf("allocated %d, posted shared bills minus Don't split %d", shared, posted)
	}

	// The company P&L only gains the receipts themselves (and reading them),
	// never the shares.
	after, err := h.svc.Monthly(ctx, this, this)
	if err != nil {
		t.Fatal(err)
	}
	if b, a := cellMicros(rowByKey(before.Rows, "net_revenue").Total), cellMicros(rowByKey(after.Rows, "net_revenue").Total); a != b {
		t.Errorf("company net revenue changed: %d → %d", b, a)
	}
	if got := cellMicros(rowByKey(after.Rows, "total_expenses").Total) - cellMicros(rowByKey(before.Rows, "total_expenses").Total); got != 86_180_000+99_000_000+2*4_200 {
		t.Errorf("company expenses grew by %d, want the two receipts", got)
	}
}
