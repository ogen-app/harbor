package tenants

import (
	"context"
	"errors"
	"testing"

	"github.com/ogen-app/harbor/src/repository/analytics"
	"github.com/ogen-app/harbor/src/repository/ogen"
)

// ── fakes ─────────────────────────────────────────────────────────────────────

// fakeTenantRepo returns canned overview aggregates; the list/get/registrations/
// activity methods are unused by Collect.
type fakeTenantRepo struct {
	headline              ogen.OverviewHeadline
	active7d              int
	failed, broken, stuck int
	names                 map[string]string
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
func (f *fakeTenantRepo) Activity(context.Context, string, int) ([]ogen.ActivityEvent, error) {
	return nil, nil
}
func (f *fakeTenantRepo) Users(context.Context, string, int) ([]ogen.User, error) {
	return nil, nil
}
func (f *fakeTenantRepo) ActivitySeries(context.Context, string, int) ([]ogen.ActivityDay, error) {
	return nil, nil
}
func (f *fakeTenantRepo) ZernioAccounts(context.Context, string) ([]ogen.ZernioAccount, error) {
	return nil, nil
}
func (f *fakeTenantRepo) Headline(context.Context) (ogen.OverviewHeadline, error) {
	return f.headline, nil
}
func (f *fakeTenantRepo) ActivePulse7d(context.Context) (int, error)      { return f.active7d, nil }
func (f *fakeTenantRepo) FailedPublishes24h(context.Context) (int, error) { return f.failed, nil }
func (f *fakeTenantRepo) BrokenSocial(context.Context) (int, error)       { return f.broken, nil }
func (f *fakeTenantRepo) StuckRiverJobs(context.Context) (int, error)     { return f.stuck, nil }
func (f *fakeTenantRepo) TenantNames(context.Context) (map[string]string, error) {
	return f.names, nil
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

// ── tests ─────────────────────────────────────────────────────────────────────

func TestCollectHeadlineAndExceptions(t *testing.T) {
	tenants := &fakeTenantRepo{
		headline: ogen.OverviewHeadline{Total: 12, New7d: 3, New30d: 7},
		active7d: 5,
		failed:   2, broken: 1, stuck: 4,
	}
	spend := &fakeSpendRepo{available: false}

	o := Collect(context.Background(), tenants, spend)

	if o.Headline.Total != 12 || o.Headline.Active != 12 {
		t.Errorf("headline = %+v, want total/active 12", o.Headline)
	}
	if o.Movement.New7d != 3 || o.Movement.New30d != 7 {
		t.Errorf("movement = %+v, want new7d 3 / new30d 7", o.Movement)
	}
	if o.Activity.Active7d != 5 || o.Activity.Total != 12 {
		t.Errorf("activity = %+v, want active7d 5 / total 12", o.Activity)
	}
	if o.Exceptions != (Exceptions{FailedPublishes24h: 2, BrokenSocial: 1, StuckRiverJobs: 4}) {
		t.Errorf("exceptions = %+v", o.Exceptions)
	}
	if !o.Quota.Placeholder {
		t.Error("quota placeholder should be true")
	}
	// Spend unavailable: not marked available, no period, no ranking.
	if o.Spend.Available || o.Spend.PeriodStart != nil || o.Spend.Top != nil {
		t.Errorf("spend should be unavailable, got %+v", o.Spend)
	}
}

func TestCollectSpendRankingAndVendorSplit(t *testing.T) {
	tenants := &fakeTenantRepo{
		headline: ogen.OverviewHeadline{Total: 3},
		names:    map[string]string{"a": "Alpha", "b": "Beta"}, // "c" intentionally unnamed
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

	o := Collect(context.Background(), tenants, spend)

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
	tenants := &fakeTenantRepo{headline: ogen.OverviewHeadline{Total: 1}}
	// Period total fails even though the rollup would succeed — the spend
	// section must stay unavailable rather than combine a zero total with data.
	spend := &fakeSpendRepo{
		available: true,
		totalErr:  errors.New("timeout"),
		rollup: []analytics.VendorCost{
			{TenantID: "a", Vendor: "anthropic", CostMicros: 100},
		},
	}

	o := Collect(context.Background(), tenants, spend)

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
