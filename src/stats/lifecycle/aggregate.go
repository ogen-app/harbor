package lifecycle

import (
	"slices"
	"time"
)

// FunnelStep is one stage of the funnel strip: how many tenants have reached
// it (churned ones included: they did reach it), the share of the previous
// step that got here, and the median days it took from the previous stage.
type FunnelStep struct {
	Stage      Progress `json:"stage"`
	Reached    int      `json:"reached"`
	Conversion *float64 `json:"conversion"`
	MedianDays *float64 `json:"medianDays"`
}

// Funnel counts every tenant whose progress is at or past each stage. The
// median time to a stage only counts tenants with both milestone times, so a
// skipped milestone doesn't bend it.
func Funnel(ts []Tenant) []FunnelStep {
	out := make([]FunnelStep, len(Stages))
	for i, p := range Stages {
		out[i].Stage = p
		var took []float64
		for _, t := range ts {
			if t.Progress.Rank() < i {
				continue
			}
			out[i].Reached++
			if i == 0 {
				continue
			}
			from, to := enteredAt(t.Milestones, Stages[i-1]), enteredAt(t.Milestones, p)
			if from != nil && to != nil {
				took = append(took, to.Sub(*from).Hours()/24)
			}
		}
		if i > 0 && out[i-1].Reached > 0 {
			out[i].Conversion = new(float64(out[i].Reached) / float64(out[i-1].Reached))
		}
		out[i].MedianDays = median(took)
	}
	return out
}

// enteredAt is when stage p was entered given the milestones: its own time, or
// the latest earlier milestone when that came after it. Nil when p was never
// reached directly.
func enteredAt(m Milestones, p Progress) *time.Time {
	at := m.At(p)
	if at == nil {
		return nil
	}
	latest := *at
	for _, q := range Stages[:p.Rank()] {
		if t := m.At(q); t != nil && t.After(latest) {
			latest = *t
		}
	}
	return &latest
}

// Activation is the footer metric: of the tenants that signed up 7 to 30 days
// ago, how many published a first post within 7 days, and the median days to a
// first post over the tenants that signed up in the last 90 days.
type Activation struct {
	Eligible          int      `json:"eligible"`
	ActivatedIn7Days  int      `json:"activatedIn7Days"`
	MedianDaysToFirst *float64 `json:"medianDaysToFirst"`
}

func ActivationOf(now time.Time, ts []Tenant) Activation {
	var a Activation
	var took []float64
	for _, t := range ts {
		age := now.Sub(t.Milestones.SignedUp)
		first := t.Milestones.FirstPost
		if age >= 7*day && age <= 30*day {
			a.Eligible++
			if first != nil && first.Sub(t.Milestones.SignedUp) <= 7*day {
				a.ActivatedIn7Days++
			}
		}
		if age <= 90*day && first != nil {
			took = append(took, first.Sub(t.Milestones.SignedUp).Hours()/24)
		}
	}
	a.MedianDaysToFirst = median(took)
	return a
}

// Cohort is one ISO signup week (Monday, UTC): its signups, the share that
// reached each stage after Signed up, and the median days to a first post.
// A share is nil while it is too early to tell: nobody has reached the stage
// yet and the week is younger than the stage's cumulative stuck limits.
type Cohort struct {
	WeekStart         string     `json:"weekStart"`
	Signups           int        `json:"signups"`
	Reached           []*float64 `json:"reached"`
	MedianDaysToFirst *float64   `json:"medianDaysToFirst"`
}

// cohortWeeks is how many signup weeks the cohort grid shows.
const cohortWeeks = 8

// Cohorts buckets tenants into the last cohortWeeks signup weeks, oldest first,
// ending with the current week. Shares cover the stages after Signed up.
func Cohorts(now time.Time, ts []Tenant, limits map[Progress]time.Duration) []Cohort {
	today := truncDay(now)
	thisWeek := today.AddDate(0, 0, -((int(today.Weekday()) + 6) % 7))
	first := thisWeek.AddDate(0, 0, -7*(cohortWeeks-1))
	later := Stages[1:]

	// Cumulative stuck limits: the age by which a cohort should have reached a
	// stage. Regular needs its weeks on top of the First post limit.
	due := make([]time.Duration, len(later))
	var sum time.Duration
	for i, p := range later {
		sum += limits[p]
		due[i] = sum
		if p == Regular {
			due[i] = max(sum, (regularWeeks-1)*7*day)
		}
	}

	out := make([]Cohort, cohortWeeks)
	members := make([][]Tenant, cohortWeeks)
	for _, t := range ts {
		d := truncDay(t.Milestones.SignedUp.UTC())
		if d.Before(first) || d.After(today) {
			continue
		}
		i := int(d.Sub(first).Hours()/24) / 7
		members[i] = append(members[i], t)
	}
	for i := range out {
		start := first.AddDate(0, 0, 7*i)
		c := Cohort{WeekStart: start.Format(time.DateOnly), Signups: len(members[i]), Reached: make([]*float64, len(later))}
		age := now.Sub(start.AddDate(0, 0, 7))
		var took []float64
		for _, t := range members[i] {
			if f := t.Milestones.FirstPost; f != nil {
				took = append(took, f.Sub(t.Milestones.SignedUp).Hours()/24)
			}
		}
		c.MedianDaysToFirst = median(took)
		if c.Signups > 0 {
			for j, p := range later {
				n := 0
				for _, t := range members[i] {
					if t.Progress.Rank() >= p.Rank() {
						n++
					}
				}
				if n == 0 && age < due[j] {
					continue
				}
				c.Reached[j] = new(float64(n) / float64(c.Signups))
			}
		}
		out[i] = c
	}
	return out
}

// Move is one change since the previous snapshot, for the movement feed.
type Move struct {
	TenantID     string   `json:"tenantId"`
	Name         string   `json:"name"`
	FromProgress Progress `json:"fromProgress"`
	ToProgress   Progress `json:"toProgress"`
	FromHealth   Health   `json:"fromHealth"`
	ToHealth     Health   `json:"toHealth"`
	// Direction is up (a new stage or recovered health), down (worse health or
	// churned) or new (signed up since the snapshot).
	Direction string `json:"direction"`
}

// Movement lists the tenants that changed since the previous snapshot, ups
// first, then new signups, then the ones that got worse.
func Movement(ts []Tenant, prev map[string]Previous, hasPrevSnapshot bool) []Move {
	if !hasPrevSnapshot {
		return []Move{}
	}
	out := []Move{}
	for _, t := range ts {
		p, ok := prev[t.ID]
		if !ok {
			out = append(out, Move{TenantID: t.ID, Name: t.Name, ToProgress: t.Progress, ToHealth: t.Health, Direction: "new"})
			continue
		}
		if p.Progress == t.Progress && p.Health == t.Health {
			continue
		}
		dir := "down"
		if t.Progress.Rank() > p.Progress.Rank() || healthRank(t.Health) < healthRank(p.Health) {
			dir = "up"
		}
		out = append(out, Move{TenantID: t.ID, Name: t.Name, FromProgress: p.Progress, ToProgress: t.Progress, FromHealth: p.Health, ToHealth: t.Health, Direction: dir})
	}
	order := map[string]int{"up": 0, "new": 1, "down": 2}
	slices.SortStableFunc(out, func(a, b Move) int { return order[a.Direction] - order[b.Direction] })
	return out
}

func healthRank(h Health) int { return slices.Index([]Health{Active, Cooling, Quiet, Churned}, h) }

func median(xs []float64) *float64 {
	if len(xs) == 0 {
		return nil
	}
	s := slices.Sorted(slices.Values(xs))
	n := len(s)
	if n%2 == 1 {
		return new(s[n/2])
	}
	return new((s[n/2-1] + s[n/2]) / 2)
}

func truncDay(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}
