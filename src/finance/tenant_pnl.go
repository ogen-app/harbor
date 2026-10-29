package finance

import (
	"cmp"
	"context"
	"fmt"
	"maps"
	"slices"
	"time"

	fin "github.com/ogen-app/harbor/src/repository/finance"
)

// ── Tenant P&L (CON-433) ────────────────────────────────────────────────────
//
// One tenant's contribution: its net revenue minus the AI cost it was measured
// to use. Both come from the same counted ledger entries as the company P&L,
// filtered to the tenant, so summed over every tenant they equal the company
// figures for tenant-attributed entries. The summary goes through the same
// fold as the /tenants Margin column (TenantFiguresFor, TenantMargins), so the
// two never disagree. Shared vendor bills (Railway, Resend…) join once shared
// cost allocation (CON-432) fills sharedByTenant; until then the shared section
// is empty and SharedConfigured is false. Entries with no tenant, such as
// receipt reading, stay at company level.

// VendorAmount is one vendor's part of a figure.
type VendorAmount struct {
	VendorID     string `json:"vendorId"`
	Name         string `json:"name"`
	AmountMicros int64  `json:"amountMicros"`
}

type TenantSummary struct {
	Period       Period          `json:"period"`
	Compare      Period          `json:"compare"`
	NetRevenue   Figure[int64]   `json:"netRevenue"`
	DirectAI     Figure[int64]   `json:"directAi"`
	DirectAIBy   []VendorAmount  `json:"directAiBy"`
	SharedCosts  Figure[int64]   `json:"sharedCosts"`
	Contribution Figure[int64]   `json:"contribution"`
	MarginPct    Figure[float64] `json:"marginPct"`
	// AllTenantsMarginPct is the blended margin over every tenant with revenue
	// this month to date. It is not the company margin: overhead that is not
	// split to tenants is left out.
	AllTenantsMarginPct *float64 `json:"allTenantsMarginPct"`
	// HasRevenue is true when the tenant has a payment this month to date.
	HasRevenue bool      `json:"hasRevenue"`
	AsOf       time.Time `json:"asOf"`
}

type TenantPnL struct {
	TenantID         string   `json:"tenantId"`
	Months           []string `json:"months"`
	RevenueAvailable bool     `json:"revenueAvailable"`
	RevenueError     string   `json:"revenueError"`
	// TestMode is the billing mode the figures are in, as on /pnl.
	TestMode bool `json:"testMode"`
	// RevenueSeen is true when the tenant has any payment in the range. A trial
	// tenant that never paid shows its revenue as "—", not $0.
	RevenueSeen      bool          `json:"revenueSeen"`
	SharedConfigured bool          `json:"sharedConfigured"`
	Rows             []Row         `json:"rows"`
	Summary          TenantSummary `json:"summary"`
}

// isDirectAI is the AI usage measured for a tenant: token-pipeline expense.
func isDirectAI(b fin.Bucket) bool {
	return b.Direction == fin.DirExpense && b.Source == fin.SourceTokenPipeline
}

// TenantPnL builds one tenant's P&L table for whole UTC months [from, to] and
// its month-to-date summary.
func (s *Service) TenantPnL(ctx context.Context, tenantID string, fromMonth, toMonth time.Time) (TenantPnL, error) {
	today := dateOnly(s.now())
	months := monthsIn(fromMonth, toMonth)
	out := TenantPnL{TenantID: tenantID, Months: monthKeys(months), Rows: []Row{}}

	testMode, rev, err := s.revenueMode(ctx)
	if err != nil {
		return out, err
	}
	out.TestMode = testMode
	out.RevenueAvailable = rev.LastSuccessAt != nil
	if !out.RevenueAvailable {
		out.RevenueError = cmp.Or(rev.LastError, "Payments have not been synced yet")
	}
	vendors, err := s.repo.ListVendors(ctx)
	if err != nil {
		return out, err
	}
	if out.Summary, err = s.tenantSummary(ctx, tenantID, testMode, out.RevenueAvailable, vendors); err != nil {
		return out, err
	}
	if len(months) == 0 {
		return out, nil
	}

	g := newGrid(months, nil, today, tenantID)
	if g.buckets, err = s.repo.BucketsForTenant(ctx, tenantID, months[0], g.end(), testMode, fin.GrainMonth); err != nil {
		return out, err
	}
	if _, out.SharedConfigured, err = s.sharedByTenant(ctx, months[0], g.end()); err != nil {
		return out, fmt.Errorf("shared costs: %w", err)
	}
	out.RevenueSeen = slices.ContainsFunc(g.buckets, func(b fin.Bucket) bool { return b.Source == fin.SourceBilling })

	revenueRows, net := g.revenue()

	// Direct costs: every AI-pipeline vendor, then any other vendor the token
	// pipeline booked for this tenant.
	direct := map[string]bool{}
	for _, v := range vendors {
		if v.IsAIPipeline {
			direct[v.ID] = true
		}
	}
	for _, b := range g.buckets {
		if isDirectAI(b) {
			direct[b.VendorID] = true
		}
	}
	vendorByID := map[string]fin.Vendor{}
	for _, v := range vendors {
		vendorByID[v.ID] = v
	}
	ids := slices.Collect(maps.Keys(direct))
	slices.SortFunc(ids, func(a, b string) int {
		return cmp.Compare(cmp.Or(vendorByID[a].Name, a), cmp.Or(vendorByID[b].Name, b))
	})
	var directRows []Row
	for _, id := range ids {
		directRows = append(directRows, g.row("direct:"+id, "direct", cmp.Or(vendorByID[id].Name, id), "AI usage", id,
			Drill{Vendor: id, Direction: []string{fin.DirExpense}, Source: []string{fin.SourceTokenPipeline}},
			func(b fin.Bucket) bool { return isDirectAI(b) && b.VendorID == id }))
	}
	costs := g.sum("total_costs", "direct", "Total costs", "total", directRows...)

	contribution := Row{Key: "contribution", Section: "profit", Label: "Contribution", SourceLabel: "Revenue minus costs", Kind: "total"}
	margin := Row{Key: "margin", Section: "profit", Label: "Margin", SourceLabel: "Total is blended", Kind: "margin"}
	g.result(&contribution, &margin, net, costs)
	if !out.RevenueSeen {
		// No payment at all: "—" rather than a row of $0.00. Costs still show,
		// and the contribution is their negative.
		for i := range revenueRows {
			for j := range revenueRows[i].Cells {
				revenueRows[i].Cells[j].Value = nil
			}
			revenueRows[i].Total.Value = nil
		}
	}
	if !out.RevenueAvailable {
		markUnavailable(append(rowPtrs(revenueRows), &contribution, &margin)...)
	}

	out.Rows = slices.Concat(revenueRows, directRows, []Row{contribution, margin})
	return out, nil
}

// tenantSummary compares this month to date with the same days of last month,
// like the company Summary.
func (s *Service) tenantSummary(ctx context.Context, tenantID string, testMode, revenueAvailable bool, vendors []fin.Vendor) (TenantSummary, error) {
	now := s.now().UTC()
	start, today := s.MonthToDate()
	prevStart := start.AddDate(0, -1, 0)
	prevEnd := earliest(prevStart.AddDate(0, 0, today.Day()-1), start.AddDate(0, 0, -1))

	out := TenantSummary{
		Period:     Period{From: start.Format(time.DateOnly), To: today.Format(time.DateOnly), Label: fmt.Sprintf("%s to date (%s)", start.Format("January"), dayRange(start, today))},
		Compare:    Period{From: prevStart.Format(time.DateOnly), To: prevEnd.Format(time.DateOnly), Label: dayRange(prevStart, prevEnd)},
		DirectAIBy: []VendorAmount{},
		AsOf:       now,
	}

	// Direct AI cost by vendor. It shows even while revenue is unavailable.
	directAI := func(from, to time.Time) (int64, map[string]int64, error) {
		buckets, err := s.repo.BucketsForTenant(ctx, tenantID, from, to, testMode, fin.GrainNone)
		by := map[string]int64{}
		var total int64
		for _, b := range buckets {
			if isDirectAI(b) {
				by[b.VendorID] += b.USDMicros
				total += b.USDMicros
			}
		}
		return total, by, err
	}
	curAI, aiBy, err := directAI(start, today)
	if err != nil {
		return out, err
	}
	prevAI, _, err := directAI(prevStart, prevEnd)
	if err != nil {
		return out, err
	}
	out.DirectAI = Figure[int64]{Value: &curAI, Previous: &prevAI}
	for _, v := range vendors {
		if amt, ok := aiBy[v.ID]; ok || v.IsAIPipeline {
			out.DirectAIBy = append(out.DirectAIBy, VendorAmount{VendorID: v.ID, Name: v.Name, AmountMicros: amt})
		}
	}
	slices.SortFunc(out.DirectAIBy, func(a, b VendorAmount) int {
		return cmp.Or(cmp.Compare(b.AmountMicros, a.AmountMicros), cmp.Compare(a.Name, b.Name))
	})

	// Unavailable revenue is never shown as zero.
	if !revenueAvailable {
		return out, nil
	}
	cur, _, err := s.TenantFiguresFor(ctx, tenantID, start, today)
	if err != nil {
		return out, err
	}
	prev, _, err := s.TenantFiguresFor(ctx, tenantID, prevStart, prevEnd)
	if err != nil {
		return out, err
	}
	out.HasRevenue = cur.NetRevenue != nil
	out.NetRevenue = Figure[int64]{Value: new(deref(cur.NetRevenue)), Previous: new(deref(prev.NetRevenue))}
	out.Contribution = Figure[int64]{Value: new(cur.Contribution), Previous: new(prev.Contribution)}
	out.MarginPct = Figure[float64]{Value: cur.MarginPct, Previous: prev.MarginPct}

	all, err := s.TenantMargins(ctx, start, today)
	if err != nil {
		return out, err
	}
	if all.SharedIncluded {
		out.SharedCosts = Figure[int64]{Value: new(cur.Shared), Previous: new(prev.Shared)}
	}
	var net, contrib int64
	for _, f := range all.ByTenant {
		if f.NetRevenue != nil {
			net += *f.NetRevenue
			contrib += f.Contribution
		}
	}
	out.AllTenantsMarginPct = marginPct(contrib, net)
	return out, nil
}
