package tenants

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/ogen-app/harbor/src/repository/analytics"
	"github.com/ogen-app/harbor/src/repository/ogen"
)

// ── fakes ─────────────────────────────────────────────────────────────────────

// fakeTenantRepo returns canned overview aggregates; the list/get/registrations/
// activity methods are unused by Collect.
type fakeTenantRepo struct {
	pulse    []ogen.TenantPulse
	pulseErr error
	daily    []ogen.DayCount
	tiers    map[string]ogen.Tier
	stuck    int
	names    map[string]string
}

func (f *fakeTenantRepo) Available() bool { return true }
func (f *fakeTenantRepo) ListMetrics(context.Context) ([]ogen.TenantMetrics, error) {
	return nil, nil
}
func (f *fakeTenantRepo) GetMetrics(context.Context, string) (*ogen.TenantMetrics, error) {
	return nil, nil
}
func (f *fakeTenantRepo) Registrations(context.Context, int) ([]ogen.Registration, error) {
	return nil, nil
}
func (f *fakeTenantRepo) DailyPublishesByPlatform(context.Context, int) ([]ogen.PublishingDayStat, error) {
	return nil, nil
}
func (f *fakeTenantRepo) Users(context.Context, string, int) ([]ogen.User, error) {
	return nil, nil
}
func (f *fakeTenantRepo) ZernioAccounts(context.Context, string) ([]ogen.ZernioAccount, error) {
	return nil, nil
}
func (f *fakeTenantRepo) Pulse(context.Context) ([]ogen.TenantPulse, error) {
	return f.pulse, f.pulseErr
}
func (f *fakeTenantRepo) DailyActiveTenants(context.Context, int) ([]ogen.DayCount, error) {
	return f.daily, nil
}
func (f *fakeTenantRepo) StuckRiverJobs(context.Context) (int, error) { return f.stuck, nil }
func (f *fakeTenantRepo) TenantNames(context.Context) (map[string]string, error) {
	return f.names, nil
}
func (f *fakeTenantRepo) ListTiers(context.Context) ([]ogen.Tier, error)   { return nil, nil }
func (f *fakeTenantRepo) ListGroups(context.Context) ([]ogen.Group, error) { return nil, nil }
func (f *fakeTenantRepo) TenantTiers(context.Context) (map[string]ogen.Tier, error) {
	return f.tiers, nil
}
func (f *fakeTenantRepo) TenantTierVersions(context.Context) (map[string]ogen.TenantVersion, error) {
	return nil, nil
}
func (f *fakeTenantRepo) TenantGroups(context.Context) (map[string][]ogen.Group, error) {
	return nil, nil
}

type fakeSpendRepo struct {
	available bool
	total     int64
	totalErr  error // when set (and available), PeriodTotalMicros fails
	rollup    []analytics.VendorCost
}

func (f *fakeSpendRepo) Available() bool { return f.available }
func (f *fakeSpendRepo) ByTenant(context.Context) (map[string]analytics.VendorSpend, error) {
	return nil, nil // unused by Collect
}
func (f *fakeSpendRepo) Rollup(context.Context) ([]analytics.VendorCost, error) {
	if !f.available {
		return nil, analytics.ErrUnavailable
	}
	return f.rollup, nil
}
func (f *fakeSpendRepo) PeriodTotalMicros(context.Context) (int64, error) {
	if !f.available {
		return 0, analytics.ErrUnavailable
	}
	if f.totalErr != nil {
		return 0, f.totalErr
	}
	return f.total, nil
}
func (f *fakeSpendRepo) DailyCostByModel(context.Context, int) ([]analytics.DailyModelCost, error) {
	if !f.available {
		return nil, analytics.ErrUnavailable
	}
	return nil, nil // unused by Collect
}
func (f *fakeSpendRepo) DailyCostByModelForTenant(context.Context, string, int) ([]analytics.DailyModelCost, error) {
	if !f.available {
		return nil, analytics.ErrUnavailable
	}
	return nil, nil // unused by Collect
}
func (f *fakeSpendRepo) DailyCostByModelTenant(context.Context, time.Time) ([]analytics.DailyModelTenantCost, error) {
	if !f.available {
		return nil, analytics.ErrUnavailable
	}
	return nil, nil // unused by Collect
}

// ── tests ─────────────────────────────────────────────────────────────────────

// now is a Thursday, so the current ISO week started on Monday 26 Oct.
var now = time.Date(2026, 10, 29, 19, 17, 0, 0, time.UTC)

func ago(d time.Duration) time.Time     { return now.Add(-d) }
func agoPtr(d time.Duration) *time.Time { return new(now.Add(-d)) }
func days(n int) time.Duration          { return time.Duration(n) * 24 * time.Hour }

func TestCollectPulseSections(t *testing.T) {
	tenants := &fakeTenantRepo{
		pulse: []ogen.TenantPulse{
			// Old, active, publishing, but failing right now.
			{ID: "acme", Name: "Acme", Status: "active", CreatedAt: ago(days(200)), HasSocial: true,
				FirstPostAt: agoPtr(days(190)), LastActivityAt: agoPtr(time.Hour),
				FailedPosts24h: 4, FailedSince: agoPtr(2 * time.Hour), LastFailure: "token expired", LastFailurePlatform: "Instagram"},
			// Old, active, quiet for 9 days, with a broken connection.
			{ID: "north", Name: "Northwind", Status: "active", CreatedAt: ago(days(120)), HasSocial: true,
				LastActivityAt: agoPtr(days(9)), BrokenSocial: 1, BrokenPlatforms: "instagram"},
			// Old, active, never did anything: quiet since creation.
			{ID: "kettle", Name: "Kettle", Status: "active", CreatedAt: ago(days(60))},
			// New this week, no social yet: a newcomer, not quiet.
			{ID: "lumen", Name: "Lumen", Status: "active", CreatedAt: ago(days(2))},
			// Suspended with failures: counted, but never needs attention.
			{ID: "susp", Name: "Susp", Status: "suspended", CreatedAt: ago(days(20)), FailedPosts24h: 3},
			// Deleted: counted, but no newcomer and no quiet entry.
			{ID: "gone", Name: "Gone", Status: "deleted", CreatedAt: ago(days(3))},
		},
		tiers: map[string]ogen.Tier{"acme": {Name: "Pro"}},
		daily: []ogen.DayCount{{Date: "2026-10-29", Count: 2}},
		stuck: 4,
	}

	o, err := collectAt(t.Context(), now, tenants, &fakeSpendRepo{})
	if err != nil {
		t.Fatal(err)
	}

	if o.Headline != (Headline{Total: 6, Active: 4, Suspended: 1, Deleted: 1}) {
		t.Errorf("headline = %+v", o.Headline)
	}
	// Only Acme is active within 7 days, out of the 4 active tenants.
	if o.Engaged != (Engaged{Active7d: 1, Of: 4}) {
		t.Errorf("engaged = %+v, want 1 of 4", o.Engaged)
	}

	if len(o.Attention) != 2 {
		t.Fatalf("attention = %+v, want 2 items", o.Attention)
	}
	if a := o.Attention[0]; a.TenantID != "acme" || a.Kind != KindFailedPublish || a.Count != 4 ||
		a.Detail != "token expired" || a.Platform != "Instagram" || a.Tier != "Pro" || a.Since == nil {
		t.Errorf("attention[0] = %+v, want Acme failing publishes first", a)
	}
	if a := o.Attention[1]; a.TenantID != "north" || a.Kind != KindBrokenSocial || a.Platform != "instagram" {
		t.Errorf("attention[1] = %+v, want Northwind broken social", a)
	}

	// Newest first; the deleted tenant is excluded, the suspended one isn't.
	var newIDs []string
	for _, n := range o.Newcomers {
		newIDs = append(newIDs, n.TenantID)
	}
	if !slices.Equal(newIDs, []string{"lumen", "susp"}) {
		t.Errorf("newcomers = %v, want [lumen susp]", newIDs)
	}

	// Longest quiet first: Kettle (since creation, 60d) before Northwind (9d).
	if len(o.Quiet) != 2 || o.Quiet[0].TenantID != "kettle" || o.Quiet[1].TenantID != "north" {
		t.Fatalf("quiet = %+v, want [kettle north]", o.Quiet)
	}
	if o.Quiet[0].LastActivityAt != nil || !o.Quiet[0].QuietSince.Equal(ago(days(60))) {
		t.Errorf("kettle quiet = %+v, want quiet since creation", o.Quiet[0])
	}

	if o.Platform.StuckJobs != 4 {
		t.Errorf("stuck jobs = %d, want 4", o.Platform.StuckJobs)
	}
	if !o.CheckedAt.Equal(now) {
		t.Errorf("checkedAt = %v", o.CheckedAt)
	}
	if o.Spend.Available || o.Spend.PeriodStart != nil || o.Spend.Top != nil {
		t.Errorf("spend should be unavailable, got %+v", o.Spend)
	}
}

func TestCollectSeries(t *testing.T) {
	tenants := &fakeTenantRepo{
		pulse: []ogen.TenantPulse{
			{ID: "a", Status: "active", CreatedAt: ago(days(200))},
			{ID: "b", Status: "active", CreatedAt: time.Date(2026, 10, 26, 8, 0, 0, 0, time.UTC)},  // Monday this week
			{ID: "c", Status: "deleted", CreatedAt: time.Date(2026, 10, 25, 8, 0, 0, 0, time.UTC)}, // Sunday last week
		},
		daily: []ogen.DayCount{{Date: "2026-10-28", Count: 2}},
	}

	o, err := collectAt(t.Context(), now, tenants, &fakeSpendRepo{})
	if err != nil {
		t.Fatal(err)
	}

	if len(o.Signups) != signupWeeks {
		t.Fatalf("signups len = %d, want %d", len(o.Signups), signupWeeks)
	}
	last, prev := o.Signups[signupWeeks-1], o.Signups[signupWeeks-2]
	if last != (WeekCount{WeekStart: "2026-10-26", Count: 1}) || prev != (WeekCount{WeekStart: "2026-10-19", Count: 1}) {
		t.Errorf("last two weeks = %+v %+v", prev, last)
	}
	if o.Signups[0].WeekStart != "2026-08-03" {
		t.Errorf("first week = %s, want 2026-08-03", o.Signups[0].WeekStart)
	}

	if len(o.DailyActive) != dailyWindowDays {
		t.Fatalf("daily len = %d, want %d", len(o.DailyActive), dailyWindowDays)
	}
	today, yesterday := o.DailyActive[dailyWindowDays-1], o.DailyActive[dailyWindowDays-2]
	// The deleted tenant never counts as live; b is live from its creation day.
	if today != (DayActive{Date: "2026-10-29", Active: 0, Live: 2}) {
		t.Errorf("today = %+v", today)
	}
	if yesterday != (DayActive{Date: "2026-10-28", Active: 2, Live: 2}) {
		t.Errorf("yesterday = %+v", yesterday)
	}
	if o.DailyActive[0].Live != 1 {
		t.Errorf("first day live = %d, want 1", o.DailyActive[0].Live)
	}
}

func TestCollectPulseFailure(t *testing.T) {
	tenants := &fakeTenantRepo{pulseErr: errors.New("timeout")}
	if _, err := Collect(t.Context(), tenants, &fakeSpendRepo{}); err == nil {
		t.Error("want the pulse error, got nil")
	}
}

func TestCollectSpendRankingAndVendorSplit(t *testing.T) {
	tenants := &fakeTenantRepo{
		names: map[string]string{"a": "Alpha", "b": "Beta"}, // "c" intentionally unnamed
	}
	spend := &fakeSpendRepo{
		available: true,
		total:     470,
		rollup: []analytics.VendorCost{
			{TenantID: "a", Vendor: "anthropic", CostMicros: 100},
			{TenantID: "a", Vendor: "google-gemini", CostMicros: 50},
			{TenantID: "b", Vendor: "claude-3", CostMicros: 300},
			{TenantID: "c", Vendor: "openai", CostMicros: 20},
		},
	}

	o, err := Collect(t.Context(), tenants, spend)
	if err != nil {
		t.Fatal(err)
	}

	if !o.Spend.Available {
		t.Fatal("spend should be available")
	}
	if o.Spend.TotalMicros != 470 {
		t.Errorf("total = %d, want 470", o.Spend.TotalMicros)
	}
	if o.Spend.PeriodStart == nil {
		t.Error("period start should be set")
	}
	if len(o.Spend.Top) != 3 {
		t.Fatalf("top len = %d, want 3", len(o.Spend.Top))
	}

	// Ranked by total spend descending: b(300) > a(150) > c(20).
	b := o.Spend.Top[0]
	if b.TenantID != "b" || b.CostMicros != 300 || b.AnthropicMicros != 300 || b.Name != "Beta" {
		t.Errorf("top[0] = %+v, want Beta 300 anthropic", b)
	}
	a := o.Spend.Top[1]
	if a.TenantID != "a" || a.CostMicros != 150 || a.AnthropicMicros != 100 || a.GoogleMicros != 50 || a.Name != "Alpha" {
		t.Errorf("top[1] = %+v, want Alpha 100 anthropic / 50 google", a)
	}
	// Unnamed tenant falls back to its id, and openai classifies as "other".
	c := o.Spend.Top[2]
	if c.TenantID != "c" || c.OtherMicros != 20 || c.Name != "c" {
		t.Errorf("top[2] = %+v, want id-fallback name and other=20", c)
	}
}

func TestCollectSpendTotalFailureIsUnavailable(t *testing.T) {
	tenants := &fakeTenantRepo{}
	// Period total fails even though the rollup would succeed — the spend
	// section must stay unavailable rather than combine a zero total with data.
	spend := &fakeSpendRepo{
		available: true,
		totalErr:  errors.New("timeout"),
		rollup: []analytics.VendorCost{
			{TenantID: "a", Vendor: "anthropic", CostMicros: 100},
		},
	}

	o, err := Collect(t.Context(), tenants, spend)
	if err != nil {
		t.Fatal(err)
	}

	if o.Spend.Available {
		t.Error("spend should be unavailable when the period total fails")
	}
	if o.Spend.TotalMicros != 0 {
		t.Errorf("total = %d, want 0", o.Spend.TotalMicros)
	}
	if o.Spend.Top != nil {
		t.Errorf("Top should be empty, got %+v", o.Spend.Top)
	}
}
