// Package tenants computes the tenant overview shown on Harbor's dashboard. It
// is a pure aggregator: all database access goes through the origin-scoped
// repositories (ogen control-plane + analytics/Timescale). Every section is
// best-effort — a failing repository call is logged at debug and left zero.
package tenants

import (
	"context"
	"log/slog"
	"sort"
	"time"

	"github.com/ogen-app/harbor/src/repository/analytics"
	"github.com/ogen-app/harbor/src/repository/ogen"
)

type Overview struct {
	Headline   Headline   `json:"headline"`
	Movement   Movement   `json:"movement"`
	Activity   Activity   `json:"activity"`
	Spend      Spend      `json:"spend"`
	Quota      Quota      `json:"quota"`
	Exceptions Exceptions `json:"exceptions"`
}

// Headline is the tenant total split by lifecycle state. Ogen has no lifecycle
// column yet, so every tenant counts as active.
type Headline struct {
	Total     int `json:"total"`
	Active    int `json:"active"`
	Trialing  int `json:"trialing"`
	Suspended int `json:"suspended"`
	Churned   int `json:"churned"`
}

// Movement is absolute signups/churns over recent windows (honest on a small
// base). Churn isn't modelled yet, so it stays zero.
type Movement struct {
	New7d      int `json:"new7d"`
	New30d     int `json:"new30d"`
	Churned7d  int `json:"churned7d"`
	Churned30d int `json:"churned30d"`
}

// Activity counts tenants that did something real (published a post or created
// content) in the last 7 days — not merely logged in.
type Activity struct {
	Active7d int `json:"active7d"`
	Total    int `json:"total"`
}

type SpendTenant struct {
	TenantID        string `json:"tenantId"`
	Name            string `json:"name"`
	CostMicros      int64  `json:"costMicros"`
	AnthropicMicros int64  `json:"anthropicMicros"`
	GoogleMicros    int64  `json:"googleMicros"`
	OtherMicros     int64  `json:"otherMicros"`
}

// Spend is the current billing period's AI cost concentration, from the
// analytics rollups. Available is false when the analytics DB is absent.
type Spend struct {
	Available   bool          `json:"available"`
	PeriodStart *time.Time    `json:"periodStart"`
	TotalMicros int64         `json:"totalMicros"`
	Top         []SpendTenant `json:"top"`
}

// Quota is a placeholder until prepaid-allowance tracking lands.
type Quota struct {
	Placeholder bool `json:"placeholder"`
}

// Exceptions are counts that link (from the UI) to a filtered Tenants page.
// StuckRiverJobs is a job count (river_job has no tenant_id).
type Exceptions struct {
	FailedPublishes24h int `json:"failedPublishes24h"`
	BrokenSocial       int `json:"brokenSocial"`
	StuckRiverJobs     int `json:"stuckRiverJobs"`
}

func logFail(section string, err error) {
	if err != nil {
		slog.Debug("tenantstats query failed", "component", "tenantstats", "section", section, "err", err)
	}
}

// topSpendTenants caps the ranked spend list at five entries.
const topSpendTenants = 5

// Collect gathers the overview from the two repositories. The tenant repository
// must be available (the caller guards on it); the spend repository may be
// unavailable, in which case spend is marked unavailable.
func Collect(ctx context.Context, tenants ogen.TenantRepository, spend analytics.SpendRepository) Overview {
	var o Overview
	o.Quota.Placeholder = true

	// Headline total + movement (new signups) in one pass over tenants.
	headline, err := tenants.Headline(ctx)
	logFail("headline", err)
	o.Headline.Total = headline.Total
	o.Movement.New7d = headline.New7d
	o.Movement.New30d = headline.New30d
	o.Headline.Active = o.Headline.Total // no lifecycle column yet
	o.Activity.Total = o.Headline.Total

	// Activity pulse: tenants that published/created a post or created an asset
	// in the last 7 days.
	active7d, err := tenants.ActivePulse7d(ctx)
	logFail("activity", err)
	o.Activity.Active7d = active7d

	// Exceptions.
	failed, err := tenants.FailedPublishes24h(ctx)
	logFail("exc.publishes", err)
	o.Exceptions.FailedPublishes24h = failed
	broken, err := tenants.BrokenSocial(ctx)
	logFail("exc.social", err)
	o.Exceptions.BrokenSocial = broken
	stuck, err := tenants.StuckRiverJobs(ctx)
	logFail("exc.river", err)
	o.Exceptions.StuckRiverJobs = stuck

	collectSpend(ctx, tenants, spend, &o.Spend)
	return o
}

func collectSpend(ctx context.Context, tenants ogen.TenantRepository, spend analytics.SpendRepository, out *Spend) {
	if !spend.Available() {
		return
	}
	now := time.Now().UTC()
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	out.PeriodStart = &start

	total, err := spend.PeriodTotalMicros(ctx)
	logFail("spend.total", err)
	out.TotalMicros = total

	// Per-tenant, per-vendor spend for the period, aggregated in Go so each
	// tenant's bar can be split by model vendor (Anthropic / Google / other)
	// while tenants are still ranked by total.
	rows, err := spend.Rollup(ctx)
	if err != nil {
		logFail("spend.byvendor", err)
		return
	}
	out.Available = true

	byTenant := map[string]*analytics.VendorSpend{}
	var order []string
	for _, r := range rows {
		vs := byTenant[r.TenantID]
		if vs == nil {
			vs = &analytics.VendorSpend{}
			byTenant[r.TenantID] = vs
			order = append(order, r.TenantID)
		}
		analytics.AddVendorCost(vs, r.Vendor, r.CostMicros)
	}

	top := make([]SpendTenant, 0, len(order))
	for _, id := range order {
		vs := byTenant[id]
		top = append(top, SpendTenant{
			TenantID:        id,
			CostMicros:      vs.TotalMicros,
			AnthropicMicros: vs.AnthropicMicros,
			GoogleMicros:    vs.GoogleMicros,
			OtherMicros:     vs.OtherMicros,
		})
	}
	sort.SliceStable(top, func(i, j int) bool { return top[i].CostMicros > top[j].CostMicros })
	if len(top) > topSpendTenants {
		top = top[:topSpendTenants]
	}

	// Map tenant ids → names from the Ogen DB (cross-database, so joined here).
	names, err := tenants.TenantNames(ctx)
	logFail("spend.names", err)
	for i := range top {
		if n := names[top[i].TenantID]; n != "" {
			top[i].Name = n
		} else {
			top[i].Name = top[i].TenantID
		}
	}
	out.Top = top
}
