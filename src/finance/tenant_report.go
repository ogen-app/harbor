package finance

import (
	"cmp"
	"context"
	"fmt"
	"time"

	fin "github.com/ogen-app/harbor/src/repository/finance"
)

// ── Per-tenant P&L ──────────────────────────────────────────────────────────

// TenantFigures is one tenant's P&L over a period. Contribution = net revenue −
// direct AI cost − shared costs; MarginPct = contribution ÷ net revenue, nil
// when net revenue is 0 or less. NetRevenue is nil when the tenant has no
// payments in the period (a trial, or not paying yet).
type TenantFigures struct {
	NetRevenue   *int64   `json:"netRevenueMicros"`
	DirectAI     int64    `json:"directAiMicros"`
	Shared       int64    `json:"sharedMicros"`
	Contribution int64    `json:"contributionMicros"`
	MarginPct    *float64 `json:"marginPct"`
}

// tenantTotals is one tenant's folded counted entries.
type tenantTotals struct {
	revenue  totals // billing_v1 entries only, so net() is the tenant's net revenue
	payments bool
	directAI int64
}

func (t *tenantTotals) add(b fin.TenantBucket) {
	switch {
	case b.Source == fin.SourceBilling:
		t.revenue.add(fin.Bucket{Direction: b.Direction, USDMicros: b.USDMicros})
		t.payments = true
	case b.Source == fin.SourceTokenPipeline && b.Direction == fin.DirExpense:
		t.directAI += b.USDMicros
	}
}

// figures applies the tenant P&L formula. The single-tenant and all-tenants
// reads both go through it, so the Tenant P&L tab and the /tenants Margin
// column can't drift.
func (t tenantTotals) figures(shared int64) TenantFigures {
	f := TenantFigures{DirectAI: t.directAI, Shared: shared}
	net := int64(0)
	if t.payments {
		net = t.revenue.net()
		f.NetRevenue = new(net)
	}
	f.Contribution = net - t.directAI - shared
	f.MarginPct = marginPct(f.Contribution, net)
	return f
}

// foldTenants folds tenant buckets and each tenant's shared-cost allocation
// into figures, keyed by tenant id. A tenant with only an allocation still
// gets a row.
func foldTenants(buckets []fin.TenantBucket, shared map[string]int64) map[string]TenantFigures {
	acc := map[string]*tenantTotals{}
	at := func(id string) *tenantTotals {
		t, ok := acc[id]
		if !ok {
			t = &tenantTotals{}
			acc[id] = t
		}
		return t
	}
	for _, b := range buckets {
		at(b.TenantID).add(b)
	}
	for id := range shared {
		at(id)
	}
	out := make(map[string]TenantFigures, len(acc))
	for id, t := range acc {
		out[id] = t.figures(shared[id])
	}
	return out
}

// sharedByTenant is each tenant's allocated share of shared vendor bills in
// [from, to], and whether allocation exists at all. Until shared-cost
// allocation (CON-432) lands nothing is split: every tenant's share is 0 and
// included is false, so callers can say margins exclude shared costs.
func (s *Service) sharedByTenant(context.Context, time.Time, time.Time) (shares map[string]int64, included bool, err error) {
	return nil, false, nil
}

// TenantMargins is every tenant's P&L over one period, for the /tenants list.
type TenantMargins struct {
	Period           Period
	RevenueAvailable bool
	RevenueError     string
	// SharedIncluded is false while shared costs aren't allocated to tenants
	// yet; contribution and margin then cover revenue and direct AI cost only.
	SharedIncluded bool
	ByTenant       map[string]TenantFigures
}

// MonthToDate is the 1st of the current UTC month through today.
func (s *Service) MonthToDate() (from, to time.Time) {
	to = dateOnly(s.now().UTC())
	return time.Date(to.Year(), to.Month(), 1, 0, 0, 0, 0, time.UTC), to
}

// TenantMargins reads every tenant's figures for [from, to] (dates, inclusive)
// in one grouped ledger query plus one allocation read. Payments come from the
// same billing mode as /pnl. Unavailable revenue is never shown as zero:
// ByTenant is then empty.
func (s *Service) TenantMargins(ctx context.Context, from, to time.Time) (TenantMargins, error) {
	out := TenantMargins{
		Period:   Period{From: from.Format(time.DateOnly), To: to.Format(time.DateOnly), Label: dayRange(from, to)},
		ByTenant: map[string]TenantFigures{},
	}
	testMode, rev, err := s.revenueMode(ctx)
	if err != nil {
		return out, err
	}
	out.RevenueAvailable = rev.LastSuccessAt != nil
	if !out.RevenueAvailable {
		out.RevenueError = cmp.Or(rev.LastError, "Payments have not been synced yet")
		return out, nil
	}
	buckets, err := s.repo.TenantBuckets(ctx, from, to, testMode, "")
	if err != nil {
		return out, fmt.Errorf("tenant buckets: %w", err)
	}
	shared, included, err := s.sharedByTenant(ctx, from, to)
	if err != nil {
		return out, fmt.Errorf("shared costs: %w", err)
	}
	out.SharedIncluded = included
	out.ByTenant = foldTenants(buckets, shared)
	return out, nil
}

// TenantFiguresFor is one tenant's figures for [from, to], through the same
// fold as TenantMargins. ok is false while revenue is unavailable.
func (s *Service) TenantFiguresFor(ctx context.Context, tenantID string, from, to time.Time) (f TenantFigures, ok bool, err error) {
	testMode, rev, err := s.revenueMode(ctx)
	if err != nil || rev.LastSuccessAt == nil {
		return f, false, err
	}
	buckets, err := s.repo.TenantBuckets(ctx, from, to, testMode, tenantID)
	if err != nil {
		return f, false, fmt.Errorf("tenant buckets: %w", err)
	}
	shared, _, err := s.sharedByTenant(ctx, from, to)
	if err != nil {
		return f, false, fmt.Errorf("shared costs: %w", err)
	}
	return foldTenants(buckets, map[string]int64{tenantID: shared[tenantID]})[tenantID], true, nil
}
