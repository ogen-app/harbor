package lifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"slices"
	"time"

	"github.com/ogen-app/harbor/src/repository/analytics"
	"github.com/ogen-app/harbor/src/repository/harbor"
	"github.com/ogen-app/harbor/src/repository/ogen"
)

// ErrUnavailable is returned when the Ogen database isn't configured: without
// it there are no tenants to place.
var ErrUnavailable = errors.New("ogen database not configured")

// ErrAIUnavailable is returned by Snapshot when the AI usage read failed, so
// the day isn't recorded from partial facts.
var ErrAIUnavailable = errors.New("ai usage unavailable; snapshot skipped")

// SignalSource reads the per-tenant lifecycle signals (the Ogen DB).
type SignalSource interface {
	Available() bool
	Signals(ctx context.Context) ([]ogen.LifecycleSignal, error)
}

// AISource reads per-tenant AI usage spans (the analytics DB).
type AISource interface {
	Available() bool
	AISpans(ctx context.Context) (map[string]analytics.UsageSpan, error)
}

// Classification reads tier and group assignments (the Ogen DB).
type Classification interface {
	TenantTiers(ctx context.Context) (map[string]ogen.Tier, error)
	TenantGroups(ctx context.Context) (map[string][]ogen.Group, error)
}

// BillingSource reads Ogen's per-tenant billing summary over gRPC.
type BillingSource interface {
	BillingStatuses(ctx context.Context) (map[string]string, error)
}

// Store keeps the daily snapshots (Harbor's DB).
type Store interface {
	UpsertDay(ctx context.Context, rows []harbor.StageSnapshot) error
	LatestBefore(ctx context.Context, date time.Time) (time.Time, []harbor.StageSnapshot, bool, error)
	History(ctx context.Context, tenantID string) ([]harbor.StageSnapshot, error)
	ChurnedSince(ctx context.Context) (map[string]time.Time, error)
}

// Service places tenants on the Lifecycle tab and records the daily snapshots.
type Service struct {
	signals SignalSource
	ai      AISource
	classes Classification
	billing BillingSource
	// inviteSrc lists tester invites for the Invited column; nil leaves it out.
	inviteSrc InviteSource
	store     Store
	limits    map[Progress]time.Duration
	now       func() time.Time
}

// billingTimeout bounds the billing summary call; the board renders without it.
const billingTimeout = 3 * time.Second

// churnedWindow is how far back the Churned lane looks.
const churnedWindow = 90 * day

// NewService wires the sources. billing and invites may be nil (gRPC
// unconfigured): no tenant counts as paying, and the Invited column is empty.
func NewService(signals SignalSource, ai AISource, classes Classification, billing BillingSource, invites InviteSource, store Store) *Service {
	return &Service{
		signals: signals, ai: ai, classes: classes, billing: billing, inviteSrc: invites, store: store,
		limits: DefaultLimits, now: func() time.Time { return time.Now().UTC() },
	}
}

// Sources reports which optional sources the evaluation could read.
type Sources struct {
	AI      bool `json:"ai"`
	Billing bool `json:"billing"`
	Invites bool `json:"invites"`
	// PreviousSnapshot is the day the board compares against, "" before the
	// first snapshot.
	PreviousSnapshot string `json:"previousSnapshot"`
}

type evaluation struct {
	now     time.Time
	tenants []Tenant
	prev    map[string]Previous
	hasPrev bool
	sources Sources
	// aiFailed is set when analytics is configured but the AI read failed, as
	// opposed to analytics not being configured at all.
	aiFailed bool
}

func logFail(section string, err error) {
	if err != nil {
		slog.Debug("lifecycle source failed", "component", "lifecycle", "section", section, "err", err)
	}
}

func (s *Service) evaluate(ctx context.Context) (evaluation, error) {
	e := evaluation{now: s.now()}
	if !s.signals.Available() {
		return e, ErrUnavailable
	}
	signals, err := s.signals.Signals(ctx)
	if err != nil {
		return e, err
	}

	var spans map[string]analytics.UsageSpan
	if s.ai.Available() {
		spans, err = s.ai.AISpans(ctx)
		logFail("ai", err)
		e.sources.AI = err == nil
		e.aiFailed = err != nil
	}
	tiers, err := s.classes.TenantTiers(ctx)
	logFail("tiers", err)
	groups, err := s.classes.TenantGroups(ctx)
	logFail("groups", err)
	var billing map[string]string
	if s.billing != nil {
		bctx, cancel := context.WithTimeout(ctx, billingTimeout)
		billing, err = s.billing.BillingStatuses(bctx)
		cancel()
		logFail("billing", err)
		e.sources.Billing = err == nil
	}

	today := truncDay(e.now)
	day, rows, ok, err := s.store.LatestBefore(ctx, today)
	logFail("snapshot.previous", err)
	e.hasPrev = ok
	e.prev = make(map[string]Previous, len(rows))
	for _, r := range rows {
		e.prev[r.TenantID] = Previous{Progress: Progress(r.Progress), Health: Health(r.Health), EnteredStageAt: r.EnteredStageAt}
	}
	if ok {
		e.sources.PreviousSnapshot = day.Format(time.DateOnly)
	}
	churnedSince, err := s.store.ChurnedSince(ctx)
	logFail("snapshot.churned", err)

	e.tenants = make([]Tenant, 0, len(signals))
	for _, sig := range signals {
		in := Input{Signal: sig, Tier: tiers[sig.ID].Name, Groups: groups[sig.ID], Billing: billing[sig.ID]}
		if span, ok := spans[sig.ID]; ok {
			in.AI = &span
		}
		var prev *Previous
		if p, ok := e.prev[sig.ID]; ok {
			prev = &p
			if e.aiFailed {
				in.Hold = prev
			}
		}
		t := Evaluate(e.now, in, s.limits, prev, e.hasPrev)
		if t.Health == Churned && t.ChurnedAt == nil {
			if since, ok := churnedSince[t.ID]; ok {
				t.ChurnedAt = &since
			}
		}
		e.tenants = append(e.tenants, t)
	}
	return e, nil
}

// Board is the Lifecycle tab: the funnel strip (Invited, then the tenant
// stages), open invites and live tenants for the board, the Churned lane, the
// activation footer and the movement feed.
type Board struct {
	CheckedAt  time.Time        `json:"checkedAt"`
	Sources    Sources          `json:"sources"`
	Limits     map[Progress]int `json:"limits"`
	Funnel     []FunnelStep     `json:"funnel"`
	Invites    []InviteChip     `json:"invites"`
	Tenants    []Tenant         `json:"tenants"`
	Churned    []Tenant         `json:"churned"`
	Activation Activation       `json:"activation"`
	Movement   []Move           `json:"movement"`
}

func (s *Service) Board(ctx context.Context) (Board, error) {
	e, err := s.evaluate(ctx)
	if err != nil {
		return Board{}, err
	}
	b := Board{
		CheckedAt: e.now, Sources: e.sources, Limits: limitDays(s.limits),
		Activation: ActivationOf(e.now, e.tenants),
		Movement:   Movement(e.tenants, e.prev, e.hasPrev),
		Invites:    []InviteChip{}, Tenants: []Tenant{}, Churned: []Tenant{},
	}
	b.Limits[Invited] = int(inviteLimit / day)

	// The Invited step leads the funnel only when invites can be read; an
	// unreachable gRPC surface would otherwise read as nobody invited.
	funnel := Funnel(e.tenants)
	if s.inviteSrc != nil {
		invites, err := s.invites(ctx)
		logFail("invites", err)
		if err == nil {
			b.Sources.Invites = true
			step, via := InviteFunnel(invites)
			funnel[0].ViaInvite = &via
			funnel = append([]FunnelStep{step}, funnel...)
			b.Invites = OpenInvites(e.now, invites)
		}
	}
	b.Funnel = funnel
	for _, t := range e.tenants {
		switch {
		case t.Health != Churned:
			b.Tenants = append(b.Tenants, t)
		case t.ChurnedAt == nil || e.now.Sub(*t.ChurnedAt) <= churnedWindow:
			b.Churned = append(b.Churned, t)
		}
	}
	SortBoard(b.Tenants)
	slices.SortStableFunc(b.Churned, func(a, b Tenant) int { return compareTimeDesc(a.ChurnedAt, b.ChurnedAt) })
	return b, nil
}

// CohortReport is the cohort grid and the time-to-first-post chart.
type CohortReport struct {
	CheckedAt time.Time  `json:"checkedAt"`
	Stages    []Progress `json:"stages"`
	Cohorts   []Cohort   `json:"cohorts"`
}

func (s *Service) Cohorts(ctx context.Context) (CohortReport, error) {
	e, err := s.evaluate(ctx)
	if err != nil {
		return CohortReport{}, err
	}
	return CohortReport{CheckedAt: e.now, Stages: Stages[1:], Cohorts: Cohorts(e.now, e.tenants, s.limits)}, nil
}

// HealthSpan is a run of consecutive snapshot days with the same health.
type HealthSpan struct {
	From   string `json:"from"`
	To     string `json:"to"`
	Health Health `json:"health"`
}

// TenantLifecycle is one tenant's Lifecycle card.
type TenantLifecycle struct {
	CheckedAt time.Time        `json:"checkedAt"`
	Tenant    Tenant           `json:"tenant"`
	Limits    map[Progress]int `json:"limits"`
	// HealthBand covers the snapshot days, oldest first; empty before the
	// first snapshot.
	HealthBand []HealthSpan `json:"healthBand"`
}

// ErrNotFound is returned for an unknown tenant.
var ErrNotFound = errors.New("tenant not found")

func (s *Service) Tenant(ctx context.Context, id string) (TenantLifecycle, error) {
	e, err := s.evaluate(ctx)
	if err != nil {
		return TenantLifecycle{}, err
	}
	i := slices.IndexFunc(e.tenants, func(t Tenant) bool { return t.ID == id })
	if i < 0 {
		return TenantLifecycle{}, ErrNotFound
	}
	out := TenantLifecycle{CheckedAt: e.now, Tenant: e.tenants[i], Limits: limitDays(s.limits), HealthBand: []HealthSpan{}}
	history, err := s.store.History(ctx, id)
	logFail("snapshot.history", err)
	out.HealthBand = healthBand(history)
	return out, nil
}

// healthBand folds the snapshot days into spans. Days without a snapshot (the
// job was off) become an unknown span rather than stretching their
// neighbours.
func healthBand(rows []harbor.StageSnapshot) []HealthSpan {
	out := []HealthSpan{}
	var last time.Time
	for _, r := range rows {
		day, h := truncDay(r.SnapshotDate), Health(r.Health)
		if n := len(out); n > 0 {
			if gap := day.Sub(last); gap > 24*time.Hour {
				out = append(out, HealthSpan{From: dateOf(last.AddDate(0, 0, 1)), To: dateOf(day.AddDate(0, 0, -1)), Health: Unknown})
			} else if out[n-1].Health == h {
				out[n-1].To, last = dateOf(day), day
				continue
			}
		}
		out = append(out, HealthSpan{From: dateOf(day), To: dateOf(day), Health: h})
		last = day
	}
	return out
}

func dateOf(t time.Time) string { return t.Format(time.DateOnly) }

// Snapshot records today's stage for every tenant. Rerunning it the same day
// overwrites that day's rows, so the job can tick more often than daily.
func (s *Service) Snapshot(ctx context.Context) error {
	if !s.signals.Available() {
		return nil
	}
	e, err := s.evaluate(ctx)
	if err != nil {
		return err
	}
	// A run without the AI facts would store held or understated stages as the
	// day's record; skip it and let the next tick write the day.
	if e.aiFailed {
		return ErrAIUnavailable
	}
	today := truncDay(e.now)
	rows := make([]harbor.StageSnapshot, 0, len(e.tenants))
	for _, t := range e.tenants {
		reasons, err := json.Marshal(t.Reasons)
		if err != nil {
			return err
		}
		rows = append(rows, harbor.StageSnapshot{
			SnapshotDate: today, TenantID: t.ID, Progress: string(t.Progress), Health: string(t.Health),
			EnteredStageAt: t.EnteredStageAt, Stuck: t.Stuck, Reasons: reasons,
		})
	}
	return s.store.UpsertDay(ctx, rows)
}

func limitDays(limits map[Progress]time.Duration) map[Progress]int {
	out := make(map[Progress]int, len(limits))
	for p, d := range limits {
		out[p] = int(d / day)
	}
	return out
}

// compareTimeDesc orders newest first, unknown times last.
func compareTimeDesc(a, b *time.Time) int {
	switch {
	case a == nil && b == nil:
		return 0
	case a == nil:
		return 1
	case b == nil:
		return -1
	}
	return b.Compare(*a)
}
