// Package tenants computes the tenant overview shown on Harbor's dashboard. It
// is a pure aggregator: all database access goes through the origin-scoped
// repositories (ogen control-plane + analytics/Timescale). Every section is
// best-effort — a failing repository call is logged at debug and left zero.
package tenants

import (
	"cmp"
	"context"
	"log/slog"
	"slices"
	"time"

	"github.com/ogen-app/harbor/src/repository/analytics"
	"github.com/ogen-app/harbor/src/repository/ogen"
)

// Overview is the dashboard's Tenants panel (CON-436): who needs the operator,
// who just arrived, who went quiet, and two small trend series.
type Overview struct {
	CheckedAt   time.Time     `json:"checkedAt"`
	Headline    Headline      `json:"headline"`
	Engaged     Engaged       `json:"engaged"`
	Attention   []Attention   `json:"attention"`
	Newcomers   []Newcomer    `json:"newcomers"`
	Quiet       []QuietTenant `json:"quiet"`
	Signups     []WeekCount   `json:"signups"`
	DailyActive []DayActive   `json:"dailyActive"`
	Spend       Spend         `json:"spend"`
	Platform    Platform      `json:"platform"`
}

// Headline is the tenant total split by lifecycle status (CON-190): active,
// suspended, and (soft-)deleted. On an un-migrated Ogen every tenant reads as
// active.
type Headline struct {
	Total     int `json:"total"`
	Active    int `json:"active"`
	Suspended int `json:"suspended"`
	Deleted   int `json:"deleted"`
}

// Engaged counts active tenants that did something real (created or published
// a post, or created an asset) in the last 7 days, out of all active tenants.
type Engaged struct {
	Active7d int `json:"active7d"`
	Of       int `json:"of"`
}

// Attention kinds.
const (
	KindFailedPublish = "failed_publish"
	KindBrokenSocial  = "broken_social"
)

// Attention is one problem on one active tenant that an operator should look
// at. Since is nil when the source doesn't record when it started.
type Attention struct {
	TenantID string     `json:"tenantId"`
	Name     string     `json:"name"`
	Tier     string     `json:"tier"`
	Kind     string     `json:"kind"`
	Count    int        `json:"count"`
	Detail   string     `json:"detail"`
	Platform string     `json:"platform"`
	Since    *time.Time `json:"since"`
}

// Newcomer is a tenant created in the last 30 days with its onboarding steps.
type Newcomer struct {
	TenantID    string     `json:"tenantId"`
	Name        string     `json:"name"`
	Tier        string     `json:"tier"`
	CreatedAt   time.Time  `json:"createdAt"`
	HasSocial   bool       `json:"hasSocial"`
	FirstPostAt *time.Time `json:"firstPostAt"`
}

// QuietTenant is an active tenant older than a week with no activity in the
// last 7 days. QuietSince is its last activity, or its creation if it never
// did anything.
type QuietTenant struct {
	TenantID       string     `json:"tenantId"`
	Name           string     `json:"name"`
	Tier           string     `json:"tier"`
	LastActivityAt *time.Time `json:"lastActivityAt"`
	QuietSince     time.Time  `json:"quietSince"`
}

// WeekCount is signups in the ISO week (Monday, UTC) starting on WeekStart.
type WeekCount struct {
	WeekStart string `json:"weekStart"`
	Count     int    `json:"count"`
}

// DayActive is one UTC day: tenants with activity, and tenants that existed
// that day. Live is approximate — it counts tenants created by then and not
// deleted now, so a deleted tenant drops out of the whole history.
type DayActive struct {
	Date   string `json:"date"`
	Active int    `json:"active"`
	Live   int    `json:"live"`
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

// Platform is system health shown beside the tenant panel. River jobs have no
// tenant_id, so they aren't tenant exceptions.
type Platform struct {
	StuckJobs int `json:"stuckJobs"`
}

func logFail(section string, err error) {
	if err != nil {
		slog.Debug("tenantstats query failed", "component", "tenantstats", "section", section, "err", err)
	}
}

const (
	// topSpendTenants caps the ranked spend list at five entries.
	topSpendTenants = 5
	newcomerWindow  = 30 * 24 * time.Hour
	quietAfter      = 7 * 24 * time.Hour
	signupWeeks     = 13
	dailyWindowDays = 90

	statusActive  = "active"
	statusDeleted = "deleted"
)

// Collect gathers the overview from the two repositories. The tenant repository
// must be available (the caller guards on it) and its per-tenant pulse is
// required: without it every section would read as zero, so its error is
// returned. The other sections are best-effort; the spend repository may be
// unavailable, in which case spend is marked unavailable.
func Collect(ctx context.Context, tenants ogen.TenantRepository, spend analytics.SpendRepository) (Overview, error) {
	return collectAt(ctx, time.Now().UTC(), tenants, spend)
}

func collectAt(ctx context.Context, now time.Time, tenants ogen.TenantRepository, spend analytics.SpendRepository) (Overview, error) {
	o := Overview{CheckedAt: now}
	pulse, err := tenants.Pulse(ctx)
	if err != nil {
		return o, err
	}
	tiers, err := tenants.TenantTiers(ctx)
	logFail("tiers", err)
	tierOf := func(id string) string { return tiers[id].Name }

	for _, p := range pulse {
		o.Headline.Total++
		switch p.Status {
		case statusActive:
			o.Headline.Active++
		case statusDeleted:
			o.Headline.Deleted++
		default:
			o.Headline.Suspended++
		}
		if p.Status != statusDeleted && now.Sub(p.CreatedAt) <= newcomerWindow {
			o.Newcomers = append(o.Newcomers, Newcomer{
				TenantID: p.ID, Name: p.Name, Tier: tierOf(p.ID),
				CreatedAt: p.CreatedAt, HasSocial: p.HasSocial, FirstPostAt: p.FirstPostAt,
			})
		}
		if p.Status != statusActive {
			continue
		}
		// Engagement, quiet tenants and problems only concern active tenants: a
		// suspended tenant can't publish, so its failures are expected.
		o.Engaged.Of++
		recent := p.LastActivityAt != nil && now.Sub(*p.LastActivityAt) <= quietAfter
		if recent {
			o.Engaged.Active7d++
		} else if now.Sub(p.CreatedAt) > quietAfter {
			since := p.CreatedAt
			if p.LastActivityAt != nil {
				since = *p.LastActivityAt
			}
			o.Quiet = append(o.Quiet, QuietTenant{
				TenantID: p.ID, Name: p.Name, Tier: tierOf(p.ID),
				LastActivityAt: p.LastActivityAt, QuietSince: since,
			})
		}
		if p.FailedPosts24h > 0 {
			o.Attention = append(o.Attention, Attention{
				TenantID: p.ID, Name: p.Name, Tier: tierOf(p.ID), Kind: KindFailedPublish,
				Count: p.FailedPosts24h, Detail: p.LastFailure, Platform: p.LastFailurePlatform, Since: p.FailedSince,
			})
		}
		if p.BrokenSocial > 0 {
			o.Attention = append(o.Attention, Attention{
				TenantID: p.ID, Name: p.Name, Tier: tierOf(p.ID), Kind: KindBrokenSocial,
				Count: p.BrokenSocial, Platform: p.BrokenPlatforms, Since: p.BrokenSince,
			})
		}
	}

	// Failing publishes before broken connections, then the biggest problem.
	slices.SortStableFunc(o.Attention, func(a, b Attention) int {
		return cmp.Or(
			cmp.Compare(kindRank(a.Kind), kindRank(b.Kind)),
			cmp.Compare(b.Count, a.Count),
			cmp.Compare(a.Name, b.Name),
		)
	})
	slices.SortStableFunc(o.Newcomers, func(a, b Newcomer) int { return b.CreatedAt.Compare(a.CreatedAt) })
	slices.SortStableFunc(o.Quiet, func(a, b QuietTenant) int { return a.QuietSince.Compare(b.QuietSince) })

	o.Signups = weeklySignups(now, pulse)
	// A failed series stays nil: densified zeros would read as a quiet period.
	daily, err := tenants.DailyActiveTenants(ctx, dailyWindowDays)
	logFail("daily", err)
	if err == nil {
		o.DailyActive = dailyActive(now, pulse, daily)
	}

	stuck, err := tenants.StuckRiverJobs(ctx)
	logFail("river", err)
	o.Platform.StuckJobs = stuck

	collectSpend(ctx, tenants, spend, &o.Spend)
	return o, nil
}

func kindRank(kind string) int {
	if kind == KindFailedPublish {
		return 0
	}
	return 1
}

// weeklySignups buckets every tenant's creation (deleted ones included — they
// did sign up) into the last signupWeeks ISO weeks, oldest first, ending with
// the current, partial week.
func weeklySignups(now time.Time, pulse []ogen.TenantPulse) []WeekCount {
	today := truncDay(now)
	thisWeek := today.AddDate(0, 0, -((int(today.Weekday()) + 6) % 7))
	first := thisWeek.AddDate(0, 0, -7*(signupWeeks-1))
	out := make([]WeekCount, signupWeeks)
	for i := range out {
		out[i].WeekStart = first.AddDate(0, 0, 7*i).Format(time.DateOnly)
	}
	for _, p := range pulse {
		if d := truncDay(p.CreatedAt.UTC()); !d.Before(first) && !d.After(today) {
			out[int(d.Sub(first).Hours()/24)/7].Count++
		}
	}
	return out
}

// dailyActive densifies the active-tenant series over dailyWindowDays days,
// oldest first, and adds the live-tenant reference line.
func dailyActive(now time.Time, pulse []ogen.TenantPulse, days []ogen.DayCount) []DayActive {
	active := make(map[string]int, len(days))
	for _, d := range days {
		active[d.Date] = d.Count
	}
	first := truncDay(now).AddDate(0, 0, -(dailyWindowDays - 1))
	out := make([]DayActive, dailyWindowDays)
	for i := range out {
		day := first.AddDate(0, 0, i)
		date := day.Format(time.DateOnly)
		live := 0
		for _, p := range pulse {
			if p.Status != statusDeleted && truncDay(p.CreatedAt.UTC()).Compare(day) <= 0 {
				live++
			}
		}
		out[i] = DayActive{Date: date, Active: active[date], Live: live}
	}
	return out
}

func truncDay(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

func collectSpend(ctx context.Context, tenants ogen.TenantRepository, spend analytics.SpendRepository, out *Spend) {
	if !spend.Available() {
		return
	}
	now := time.Now().UTC()
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	out.PeriodStart = &start

	total, err := spend.PeriodTotalMicros(ctx)
	if err != nil {
		// Bail before marking the section available: a zero total combined with
		// otherwise-successful rollup data would misrepresent spend.
		logFail("spend.total", err)
		return
	}
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
	slices.SortStableFunc(top, func(a, b SpendTenant) int { return cmp.Compare(b.CostMicros, a.CostMicros) })
	if len(top) > topSpendTenants {
		top = top[:topSpendTenants]
	}

	// Map tenant ids → names from the Ogen DB (cross-database, so joined here).
	names, err := tenants.TenantNames(ctx)
	logFail("spend.names", err)
	for i := range top {
		top[i].Name = cmp.Or(names[top[i].TenantID], top[i].TenantID)
	}
	out.Top = top
}
