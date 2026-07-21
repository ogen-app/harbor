// Package tenantstats computes the tenant overview shown on Harbor's dashboard.
// It reads the Ogen control-plane DB (tenants, posts, assets, social accounts,
// river jobs) and the analytics/TimescaleDB (usage_events) for AI spend. Every
// query is read-only and best-effort: a failing section is logged at debug and
// left zero.
package tenantstats

import (
	"context"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/uptrace/bun"
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

// Collect gathers the overview. ogenDB must be non-nil; analyticsDB may be nil
// (spend is then marked unavailable).
func Collect(ctx context.Context, ogenDB, analyticsDB *bun.DB) Overview {
	var o Overview
	o.Quota.Placeholder = true

	// Headline total + movement (new signups) in one pass over tenants.
	logFail("headline", ogenDB.NewRaw(`
		SELECT
			count(*),
			count(*) FILTER (WHERE created_at >= now() - interval '7 days'),
			count(*) FILTER (WHERE created_at >= now() - interval '30 days')
		FROM tenants`).Scan(ctx, &o.Headline.Total, &o.Movement.New7d, &o.Movement.New30d))
	o.Headline.Active = o.Headline.Total // no lifecycle column yet
	o.Activity.Total = o.Headline.Total

	// Activity pulse: tenants that published/created a post or created an asset
	// in the last 7 days.
	logFail("activity", ogenDB.NewRaw(`
		SELECT count(*) FROM (
			SELECT tenant_id FROM posts
			  WHERE published_at >= now() - interval '7 days'
			     OR created_at   >= now() - interval '7 days'
			UNION
			SELECT tenant_id FROM assets
			  WHERE created_at >= now() - interval '7 days'
		) active`).Scan(ctx, &o.Activity.Active7d))

	// Exceptions.
	logFail("exc.publishes", ogenDB.NewRaw(`
		SELECT count(DISTINCT tenant_id) FROM posts
		WHERE failure_reason IS NOT NULL AND failure_reason <> ''
		  AND updated_at >= now() - interval '24 hours'`).Scan(ctx, &o.Exceptions.FailedPublishes24h))
	logFail("exc.social", ogenDB.NewRaw(`
		SELECT count(DISTINCT tenant_id) FROM social_accounts
		WHERE is_active = false AND deleted_at IS NULL`).Scan(ctx, &o.Exceptions.BrokenSocial))
	logFail("exc.river", ogenDB.NewRaw(`
		SELECT count(*) FROM river_job
		WHERE (state = 'available' AND scheduled_at  < now() - interval '15 minutes')
		   OR (state = 'running'   AND attempted_at  < now() - interval '15 minutes')
		   OR (state = 'retryable' AND attempt >= max_attempts)`).Scan(ctx, &o.Exceptions.StuckRiverJobs))

	collectSpend(ctx, ogenDB, analyticsDB, &o.Spend)
	return o
}

func collectSpend(ctx context.Context, ogenDB, analyticsDB *bun.DB, out *Spend) {
	if analyticsDB == nil {
		return
	}
	now := time.Now().UTC()
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	out.PeriodStart = &start

	logFail("spend.total", analyticsDB.NewRaw(`
		SELECT COALESCE(sum(cost_micros), 0) FROM usage_events
		WHERE occurred_at >= date_trunc('month', now())`).Scan(ctx, &out.TotalMicros))

	// Per-tenant, per-vendor spend for the period, aggregated in Go so each
	// tenant's bar can be split by model vendor (Anthropic / Google / other)
	// while tenants are still ranked by total.
	var rows []struct {
		TenantID   string `bun:"tenant_id"`
		Vendor     string `bun:"vendor"`
		CostMicros int64  `bun:"cost_micros"`
	}
	err := analyticsDB.NewRaw(`
		SELECT tenant_id, vendor, sum(cost_micros) AS cost_micros
		FROM usage_events
		WHERE occurred_at >= date_trunc('month', now())
		GROUP BY tenant_id, vendor`).Scan(ctx, &rows)
	if err != nil {
		logFail("spend.byvendor", err)
		return
	}
	out.Available = true

	byTenant := map[string]*SpendTenant{}
	var order []string
	for _, r := range rows {
		t := byTenant[r.TenantID]
		if t == nil {
			t = &SpendTenant{TenantID: r.TenantID}
			byTenant[r.TenantID] = t
			order = append(order, r.TenantID)
		}
		t.CostMicros += r.CostMicros
		switch classifyVendor(r.Vendor) {
		case "anthropic":
			t.AnthropicMicros += r.CostMicros
		case "google":
			t.GoogleMicros += r.CostMicros
		default:
			t.OtherMicros += r.CostMicros
		}
	}

	top := make([]SpendTenant, 0, len(order))
	for _, id := range order {
		top = append(top, *byTenant[id])
	}
	sort.SliceStable(top, func(i, j int) bool { return top[i].CostMicros > top[j].CostMicros })
	if len(top) > 5 {
		top = top[:5]
	}

	// Map tenant ids → names from the Ogen DB (cross-database, so joined here).
	names := tenantNames(ctx, ogenDB)
	for i := range top {
		if n := names[top[i].TenantID]; n != "" {
			top[i].Name = n
		} else {
			top[i].Name = top[i].TenantID
		}
	}
	out.Top = top
}

// classifyVendor maps a usage_events vendor string to a model-family bucket.
func classifyVendor(v string) string {
	v = strings.ToLower(strings.TrimSpace(v))
	switch {
	case strings.Contains(v, "anthropic") || strings.Contains(v, "claude"):
		return "anthropic"
	case strings.Contains(v, "gemini") || strings.Contains(v, "google") || strings.Contains(v, "vertex"):
		return "google"
	default:
		return "other"
	}
}

func tenantNames(ctx context.Context, ogenDB *bun.DB) map[string]string {
	var rows []struct {
		ID   string `bun:"id"`
		Name string `bun:"name"`
	}
	logFail("spend.names", ogenDB.NewRaw(`SELECT id, name FROM tenants`).Scan(ctx, &rows))
	m := make(map[string]string, len(rows))
	for _, r := range rows {
		m[r.ID] = r.Name
	}
	return m
}
