package lifecycle

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/ogen-app/harbor/src/repository/analytics"
	"github.com/ogen-app/harbor/src/repository/harbor"
	"github.com/ogen-app/harbor/src/repository/ogen"
)

type fakeSignals []ogen.LifecycleSignal

func (fakeSignals) Available() bool { return true }
func (f fakeSignals) Signals(context.Context) ([]ogen.LifecycleSignal, error) {
	return f, nil
}

type fakeAI struct {
	spans map[string]analytics.UsageSpan
	err   error
	off   bool // no analytics pool configured
}

func (f fakeAI) Available() bool { return !f.off }
func (f fakeAI) AISpans(context.Context) (map[string]analytics.UsageSpan, error) {
	return f.spans, f.err
}

type fakeClasses struct{}

func (fakeClasses) TenantTiers(context.Context) (map[string]ogen.Tier, error) { return nil, nil }
func (fakeClasses) TenantGroups(context.Context) (map[string][]ogen.Group, error) {
	return nil, nil
}

type fakeStore struct {
	prev    []harbor.StageSnapshot
	today   []harbor.StageSnapshot
	written []harbor.StageSnapshot
}

func (f *fakeStore) Day(context.Context, time.Time) ([]harbor.StageSnapshot, error) {
	return f.today, nil
}

func (f *fakeStore) UpsertDay(_ context.Context, rows []harbor.StageSnapshot) error {
	f.written = rows
	return nil
}
func (f *fakeStore) LatestBefore(context.Context, time.Time) (time.Time, []harbor.StageSnapshot, bool, error) {
	return now.AddDate(0, 0, -1), f.prev, len(f.prev) > 0, nil
}
func (f *fakeStore) History(context.Context, string) ([]harbor.StageSnapshot, error) {
	return nil, nil
}
func (f *fakeStore) ChurnedSince(context.Context) (map[string]time.Time, error) { return nil, nil }

func TestAIOutageHoldsStageAndSkipsSnapshot(t *testing.T) {
	s := signal(20)
	s.FirstSocialAt = ago(19)
	entered := *ago(10)
	store := &fakeStore{prev: []harbor.StageSnapshot{
		{TenantID: "t1", Progress: string(Generating), Health: string(Active), EnteredStageAt: entered},
	}}
	svc := NewService(fakeSignals{s}, fakeAI{err: errors.New("down")}, fakeClasses{}, nil, nil, store)
	svc.now = func() time.Time { return now }

	b, err := svc.Board(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	got := b.Tenants[0]
	if got.Progress != Generating || !got.EnteredStageAt.Equal(entered) || got.Health != Active || got.Moved {
		t.Fatalf("during the outage got %s since %v, %s, moved=%v", got.Progress, got.EnteredStageAt, got.Health, got.Moved)
	}
	if len(b.Movement) != 0 {
		t.Fatalf("an outage shouldn't read as movement: %v", b.Movement)
	}
	if err := svc.Snapshot(t.Context()); !errors.Is(err, ErrAIUnavailable) || store.written != nil {
		t.Fatalf("snapshot err=%v written=%d, want it skipped", err, len(store.written))
	}

	// Once AI reads again, the day is recorded from real facts.
	svc.ai = fakeAI{spans: map[string]analytics.UsageSpan{"t1": {First: entered, Last: *ago(1)}}}
	if err := svc.Snapshot(t.Context()); err != nil || len(store.written) != 1 || store.written[0].Progress != string(Generating) {
		t.Fatalf("snapshot after recovery err=%v rows=%v", err, store.written)
	}
}

func TestProgressNeverFallsBelowTheLatestSnapshot(t *testing.T) {
	s := signal(20)
	s.FirstSocialAt, s.LastActivityAt = ago(19), ago(1)
	entered := *ago(4)
	tests := []struct {
		name  string
		ai    fakeAI
		store *fakeStore
	}{
		{
			// Yesterday read Connected, but today's run already saw Generating.
			name: "today's row outranks the previous snapshot",
			ai:   fakeAI{err: errors.New("down")},
			store: &fakeStore{
				prev:  []harbor.StageSnapshot{{TenantID: "t1", Progress: string(Connected), Health: string(Active), EnteredStageAt: *ago(19)}},
				today: []harbor.StageSnapshot{{TenantID: "t1", Progress: string(Generating), Health: string(Active), EnteredStageAt: entered}},
			},
		},
		{
			name:  "no analytics pool at all",
			ai:    fakeAI{off: true},
			store: &fakeStore{prev: []harbor.StageSnapshot{{TenantID: "t1", Progress: string(Generating), Health: string(Active), EnteredStageAt: entered}}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := NewService(fakeSignals{s}, tt.ai, fakeClasses{}, nil, nil, tt.store)
			svc.now = func() time.Time { return now }
			b, err := svc.Board(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			if got := b.Tenants[0]; got.Progress != Generating || !got.EnteredStageAt.Equal(entered) {
				t.Fatalf("got %s since %v, want generating since %v", got.Progress, got.EnteredStageAt, entered)
			}
		})
	}

	// Without a pool there are never AI facts to wait for, so the day is still
	// recorded, at the floored stage.
	store := tests[1].store
	svc := NewService(fakeSignals{s}, fakeAI{off: true}, fakeClasses{}, nil, nil, store)
	svc.now = func() time.Time { return now }
	if err := svc.Snapshot(t.Context()); err != nil || len(store.written) != 1 || store.written[0].Progress != string(Generating) {
		t.Fatalf("snapshot without analytics err=%v rows=%v", err, store.written)
	}
}

func TestHealthBandMarksMissingDays(t *testing.T) {
	d := func(s string) time.Time { v, _ := time.Parse(time.DateOnly, s); return v }
	band := healthBand([]harbor.StageSnapshot{
		{SnapshotDate: d("2026-11-20"), Health: "active"},
		{SnapshotDate: d("2026-11-21"), Health: "active"},
		{SnapshotDate: d("2026-11-24"), Health: "active"},
		{SnapshotDate: d("2026-11-25"), Health: "cooling"},
	})
	want := []HealthSpan{
		{From: "2026-11-20", To: "2026-11-21", Health: Active},
		{From: "2026-11-22", To: "2026-11-23", Health: Unknown},
		{From: "2026-11-24", To: "2026-11-24", Health: Active},
		{From: "2026-11-25", To: "2026-11-25", Health: Cooling},
	}
	if len(band) != len(want) {
		t.Fatalf("band %v, want %v", band, want)
	}
	for i := range want {
		if band[i] != want[i] {
			t.Fatalf("band %v, want %v", band, want)
		}
	}
}
