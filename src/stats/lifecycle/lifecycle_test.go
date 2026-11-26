package lifecycle

import (
	"testing"
	"time"

	"github.com/ogen-app/harbor/src/repository/analytics"
	"github.com/ogen-app/harbor/src/repository/ogen"
	"github.com/ogen-app/harbor/src/repository/ogeninvites"
)

var now = time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)

func ago(days float64) *time.Time { return new(now.Add(-time.Duration(days * float64(day)))) }

func signal(createdDaysAgo float64) ogen.LifecycleSignal {
	return ogen.LifecycleSignal{ID: "t1", Name: "Acme", Status: "active", CreatedAt: *ago(createdDaysAgo)}
}

func TestEvaluateProgressAndStuck(t *testing.T) {
	tests := []struct {
		name      string
		sig       func() ogen.LifecycleSignal
		ai        *analytics.UsageSpan
		progress  Progress
		inStage   int
		stuck     bool
		firstKind string
	}{
		{
			name:     "fresh signup is not stuck",
			sig:      func() ogen.LifecycleSignal { return signal(1) },
			progress: SignedUp, inStage: 1,
		},
		{
			name:     "signup past its limit is stuck",
			sig:      func() ogen.LifecycleSignal { return signal(3) },
			progress: SignedUp, inStage: 3, stuck: true,
		},
		{
			name: "connected enters the stage at the connection",
			sig: func() ogen.LifecycleSignal {
				s := signal(10)
				s.FirstSocialAt = ago(2)
				return s
			},
			progress: Connected, inStage: 2,
		},
		{
			name: "AI before connecting enters Generating at the later milestone",
			sig: func() ogen.LifecycleSignal {
				s := signal(10)
				s.FirstSocialAt = ago(1)
				return s
			},
			ai:       &analytics.UsageSpan{First: *ago(8), Last: *ago(1)},
			progress: Generating, inStage: 1,
		},
		{
			name: "a post without AI still reaches First post",
			sig: func() ogen.LifecycleSignal {
				s := signal(30)
				s.FirstSocialAt, s.FirstPostAt, s.LastActivityAt, s.PublishWeeks = ago(29), ago(25), ago(1), 1
				return s
			},
			progress: FirstPost, inStage: 25, stuck: true,
		},
		{
			name: "regular has no limit",
			sig: func() ogen.LifecycleSignal {
				s := signal(200)
				s.FirstSocialAt, s.FirstPostAt, s.RegularAt, s.LastActivityAt = ago(199), ago(190), ago(170), ago(1)
				return s
			},
			progress: Regular, inStage: 170,
		},
		{
			name: "failing posts lead the reasons",
			sig: func() ogen.LifecycleSignal {
				s := signal(5)
				s.FirstSocialAt, s.FailedPosts24h, s.LastFailurePlatform, s.BrokenSocial = ago(4), 3, "instagram", 1
				return s
			},
			progress: Connected, inStage: 4, stuck: true, firstKind: ReasonFailingPosts,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Evaluate(now, Input{Signal: tt.sig(), AI: tt.ai}, DefaultLimits, nil, false)
			if got.Progress != tt.progress || got.DaysInStage != tt.inStage || got.Stuck != tt.stuck {
				t.Fatalf("got %s %dd stuck=%v, want %s %dd stuck=%v", got.Progress, got.DaysInStage, got.Stuck, tt.progress, tt.inStage, tt.stuck)
			}
			want := tt.firstKind
			if want == "" {
				want = ReasonStage
			}
			if got.Reasons[0].Kind != want {
				t.Fatalf("first reason %q, want %q (%v)", got.Reasons[0].Kind, want, got.Reasons)
			}
		})
	}
}

func TestEvaluateHealth(t *testing.T) {
	tests := []struct {
		name   string
		status string
		last   *time.Time
		ai     *analytics.UsageSpan
		health Health
	}{
		{name: "recent post", last: ago(2), health: Active},
		{name: "a week idle", last: ago(8), health: Cooling},
		{name: "two weeks idle", last: ago(20), health: Quiet},
		{name: "AI usage counts as activity", last: ago(20), ai: &analytics.UsageSpan{First: *ago(30), Last: *ago(1)}, health: Active},
		{name: "never active falls back to signup", health: Quiet},
		{name: "suspended", status: "suspended", last: ago(1), health: Churned},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := signal(40)
			s.LastActivityAt = tt.last
			if tt.status != "" {
				s.Status = tt.status
			}
			got := Evaluate(now, Input{Signal: s, AI: tt.ai}, DefaultLimits, nil, false)
			if got.Health != tt.health {
				t.Fatalf("health %s, want %s", got.Health, tt.health)
			}
			if got.Health == Churned && got.Stuck {
				t.Fatal("a churned tenant is never stuck")
			}
		})
	}
}

func TestEvaluatePayingQuietAndMoves(t *testing.T) {
	s := signal(100)
	s.FirstSocialAt, s.FirstPostAt, s.RegularAt, s.LastActivityAt = ago(99), ago(90), ago(70), ago(41)

	got := Evaluate(now, Input{Signal: s, Billing: "active"}, DefaultLimits, &Previous{Progress: Regular, Health: Cooling}, true)
	if !got.Paying || got.Health != Quiet || !got.Moved {
		t.Fatalf("paying=%v health=%s moved=%v", got.Paying, got.Health, got.Moved)
	}
	if got.Reasons[0].Text != "Paying, no activity 41d" {
		t.Fatalf("first reason %q", got.Reasons[0].Text)
	}
	if got.Reasons[1].Text != "Went quiet" {
		t.Fatalf("second reason %q", got.Reasons[1].Text)
	}

	fresh := Evaluate(now, Input{Signal: signal(0.2)}, DefaultLimits, nil, true)
	if !fresh.Moved || fresh.Reasons[0].Text != "New signup" {
		t.Fatalf("new tenant moved=%v reasons=%v", fresh.Moved, fresh.Reasons)
	}
	first := Evaluate(now, Input{Signal: signal(0.2)}, DefaultLimits, nil, false)
	if first.Moved {
		t.Fatal("before the first snapshot nothing counts as moved")
	}
}

func TestFunnel(t *testing.T) {
	mk := func(created, social, post float64) Tenant {
		s := signal(created)
		if social > 0 {
			s.FirstSocialAt = ago(social)
		}
		if post > 0 {
			s.FirstPostAt, s.LastActivityAt = ago(post), ago(post)
		}
		return Evaluate(now, Input{Signal: s}, DefaultLimits, nil, false)
	}
	ts := []Tenant{mk(10, 0, 0), mk(10, 9, 0), mk(10, 8, 5), mk(10, 6, 2)}
	f := Funnel(ts)
	reached := []int{4, 3, 2, 2, 0}
	for i, step := range f {
		if step.Reached != reached[i] {
			t.Fatalf("%s reached %d, want %d", step.Stage, step.Reached, reached[i])
		}
	}
	if *f[1].Conversion != 0.75 {
		t.Fatalf("connected conversion %v", *f[1].Conversion)
	}
	// Signed up → Connected took 1, 2 and 4 days.
	if *f[1].MedianDays != 2 {
		t.Fatalf("median days to connect %v", *f[1].MedianDays)
	}
	// Nobody has an AI milestone, so First post has no measured time from it.
	if f[3].MedianDays != nil {
		t.Fatalf("first post median %v, want nil", *f[3].MedianDays)
	}
}

func TestCohortsTooEarly(t *testing.T) {
	s := signal(1)
	ts := []Tenant{Evaluate(now, Input{Signal: s}, DefaultLimits, nil, false)}
	cs := Cohorts(now, ts, DefaultLimits)
	last := cs[len(cs)-1]
	if last.Signups != 1 {
		t.Fatalf("this week's signups %d", last.Signups)
	}
	for i, r := range last.Reached {
		if r != nil {
			t.Fatalf("stage %d share %v, want too early", i, *r)
		}
	}
	old := signal(50)
	cs = Cohorts(now, []Tenant{Evaluate(now, Input{Signal: old}, DefaultLimits, nil, false)}, DefaultLimits)
	if r := cs[0].Reached[0]; r == nil || *r != 0 {
		t.Fatalf("an old cohort that never connected reads 0%%, got %v", r)
	}
}

func TestMovement(t *testing.T) {
	a := Tenant{ID: "a", Name: "A", Progress: FirstPost, Health: Active}
	b := Tenant{ID: "b", Name: "B", Progress: Regular, Health: Quiet}
	c := Tenant{ID: "c", Name: "C", Progress: SignedUp, Health: Active}
	d := Tenant{ID: "d", Name: "D", Progress: Regular, Health: Active}
	prev := map[string]Previous{
		"a": {Progress: Generating, Health: Active},
		"b": {Progress: Regular, Health: Cooling},
		"d": {Progress: Regular, Health: Active},
	}
	moves := Movement([]Tenant{b, c, a, d}, prev, true)
	got := []string{}
	for _, m := range moves {
		got = append(got, m.TenantID+":"+m.Direction)
	}
	want := []string{"a:up", "c:new", "b:down"}
	if len(got) != len(want) {
		t.Fatalf("moves %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("moves %v, want %v", got, want)
		}
	}
	if len(Movement([]Tenant{a}, nil, false)) != 0 {
		t.Fatal("no previous snapshot means no movement")
	}

	// Progress made before churning still reads as a loss.
	gone := Tenant{ID: "e", Name: "E", Progress: FirstPost, Health: Churned}
	if m := Movement([]Tenant{gone}, map[string]Previous{"e": {Progress: Connected, Health: Active}}, true); m[0].Direction != "down" {
		t.Fatalf("churn direction %s, want down", m[0].Direction)
	}
}

func TestRecoveryToCoolingReadsAsRecovery(t *testing.T) {
	s := signal(60)
	s.LastActivityAt = ago(10)
	got := Evaluate(now, Input{Signal: s}, DefaultLimits, &Previous{Progress: SignedUp, Health: Quiet}, true)
	if got.Health != Cooling || got.Reasons[0].Text != "Active again after going quiet" {
		t.Fatalf("health %s, reasons %v", got.Health, got.Reasons)
	}
}

func TestCohortDeadlineUsesEarlierStages(t *testing.T) {
	// Signed up 15 days before the end of its week: past the 10 days a first
	// post is due by (2 + 3 + 5), so a cohort that never posted reads 0%.
	s := signal(22)
	ts := []Tenant{Evaluate(now, Input{Signal: s}, DefaultLimits, nil, false)}
	cs := Cohorts(now, ts, DefaultLimits)
	var c Cohort
	for _, x := range cs {
		if x.Signups > 0 {
			c = x
		}
	}
	if r := c.Reached[2]; r == nil || *r != 0 {
		t.Fatalf("first post share %v, want 0", r)
	}
	if c.Reached[3] != nil {
		t.Fatalf("regular share %v, want too early", *c.Reached[3])
	}
}

func TestSortBoard(t *testing.T) {
	ts := []Tenant{
		{Name: "b", DaysInStage: 10},
		{Name: "a", DaysInStage: 3, Stuck: true},
		{Name: "c", DaysInStage: 20},
		{Name: "d", DaysInStage: 9, Stuck: true},
	}
	SortBoard(ts)
	order := ""
	for _, x := range ts {
		order += x.Name
	}
	if order != "dacb" {
		t.Fatalf("order %s, want dacb", order)
	}
}

func TestInviteFunnelAndChips(t *testing.T) {
	invites := []ogeninvites.Invite{
		{ID: "1", Email: "a@x", Status: "redeemed", CreatedAt: ago(10), RedeemedAt: ago(8)},
		{ID: "2", Email: "b@x", Status: "redeemed", CreatedAt: ago(10), RedeemedAt: ago(6)},
		{ID: "3", Email: "c@x", Status: "pending", CreatedAt: ago(5), LastSentAt: ago(5), EmailStatus: "opened"},
		{ID: "4", Email: "d@x", Status: "pending", CreatedAt: ago(1), EmailStatus: "bounced"},
		{ID: "5", Email: "e@x", Status: "expired", CreatedAt: ago(20), ExpiresAt: ago(6)},
		{ID: "6", Email: "f@x", Status: "revoked", CreatedAt: ago(3)},
	}
	step, via := InviteFunnel(invites)
	if step.Stage != Invited || step.Reached != 5 || via != 2 {
		t.Fatalf("reached %d via %d", step.Reached, via)
	}
	if *step.Conversion != 0.4 || *step.MedianDays != 3 {
		t.Fatalf("conversion %v median %v", *step.Conversion, *step.MedianDays)
	}

	chips := OpenInvites(now, invites)
	got := ""
	for _, c := range chips {
		got += c.ID
	}
	// Stuck (sent more than 3 days ago) first, longest first; redeemed and
	// revoked invites aren't open.
	if got != "534" {
		t.Fatalf("chips %s, want 534", got)
	}
	want := map[string]string{"5": "Expired 6d ago", "3": "Opened, no signup", "4": "Invite email not delivered"}
	for _, c := range chips {
		if c.Reason.Text != want[c.ID] {
			t.Fatalf("invite %s reason %q, want %q", c.ID, c.Reason.Text, want[c.ID])
		}
	}
}
