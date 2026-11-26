// Package lifecycle places every tenant on the Lifecycle tab. It has
// two axes: progress, the furthest onboarding milestone a tenant has reached,
// which never goes back; and health, recomputed from its last activity. On top
// of them it decides whether the tenant is stuck in its stage and why.
//
// The rules here are pure: Evaluate and the aggregates take their inputs and a
// clock, so they are table-tested without a database. Service wires them to the
// repositories and to the daily snapshots.
package lifecycle

import (
	"cmp"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/ogen-app/harbor/src/repository/analytics"
	"github.com/ogen-app/harbor/src/repository/ogen"
)

// Progress is a tenant's furthest milestone.
type Progress string

const (
	SignedUp   Progress = "signed_up"
	Connected  Progress = "connected"
	Generating Progress = "generating"
	FirstPost  Progress = "first_post"
	Regular    Progress = "regular"
)

// Stages lists the progress stages in order.
var Stages = []Progress{SignedUp, Connected, Generating, FirstPost, Regular}

// Rank is the stage's position in Stages, or -1 for an unknown stage.
func (p Progress) Rank() int { return slices.Index(Stages, p) }

func (p Progress) Label() string {
	switch p {
	case SignedUp:
		return "Signed up"
	case Connected:
		return "Connected"
	case Generating:
		return "Generating"
	case FirstPost:
		return "First post"
	case Regular:
		return "Regular"
	}
	return string(p)
}

// Health is how recently a live tenant did something, or churned for one that
// is suspended or deleted.
type Health string

const (
	Active  Health = "active"
	Cooling Health = "cooling"
	Quiet   Health = "quiet"
	Churned Health = "churned"
	// Unknown only appears in a tenant's health band, for days without a
	// snapshot.
	Unknown Health = "unknown"
)

const (
	day = 24 * time.Hour
	// coolingAfter and quietAfter bound health by time since the last activity.
	coolingAfter = 7 * day
	quietAfter   = 14 * day
	// regularWeeks is how many distinct ISO weeks with a published post make a
	// tenant Regular.
	regularWeeks = 3
)

// DefaultLimits is how long a tenant may stay in a stage before it counts as
// stuck. Regular has no limit: health is the signal there.
var DefaultLimits = map[Progress]time.Duration{
	SignedUp:   2 * day,
	Connected:  3 * day,
	Generating: 5 * day,
	FirstPost:  21 * day,
}

// Tone colours a reason on the chip.
type Tone string

const (
	ToneFailing Tone = "failing" // red
	ToneRisk    Tone = "risk"    // amber
	ToneMoved   Tone = "moved"   // blue
	ToneInfo    Tone = "info"    // grey
)

// Reason kinds, in the priority order a chip shows them.
const (
	ReasonFailingPosts   = "failing_posts"
	ReasonBrokenSocial   = "broken_social"
	ReasonPaymentPastDue = "payment_past_due"
	ReasonPayingQuiet    = "paying_quiet"
	ReasonDrafts         = "drafts"
	ReasonMoved          = "moved"
	ReasonStage          = "stage"
)

// Reason explains a tenant's state in one line.
type Reason struct {
	Kind string `json:"kind"`
	Tone Tone   `json:"tone"`
	Text string `json:"text"`
}

// Billing statuses that matter here, from Ogen's per-tenant summary.
const (
	billingActive  = "active"
	billingPastDue = "past_due"
)

// Input is everything Evaluate needs about one tenant.
type Input struct {
	Signal ogen.LifecycleSignal
	// AI is the tenant's AI usage span; nil when it never generated or the
	// analytics DB is unavailable.
	AI      *analytics.UsageSpan
	Tier    string
	Groups  []ogen.Group
	Billing string
	// Hold is the previous snapshot's state, set while the AI usage read is
	// failing. Without AI facts the tenant would fall back from Generating and
	// read as idle, so it keeps at least the stage and the health it had.
	Hold *Previous
}

// Milestones are the times a tenant reached each stage. A later stage reached
// without an earlier one (a post published without AI) leaves the earlier one
// nil.
type Milestones struct {
	SignedUp   time.Time  `json:"signedUp"`
	Connected  *time.Time `json:"connected"`
	Generating *time.Time `json:"generating"`
	FirstPost  *time.Time `json:"firstPost"`
	Regular    *time.Time `json:"regular"`
}

// At returns when the tenant reached stage p, or nil.
func (m Milestones) At(p Progress) *time.Time {
	switch p {
	case SignedUp:
		return &m.SignedUp
	case Connected:
		return m.Connected
	case Generating:
		return m.Generating
	case FirstPost:
		return m.FirstPost
	case Regular:
		return m.Regular
	}
	return nil
}

// Tenant is one tenant on the board.
type Tenant struct {
	ID         string       `json:"id"`
	Name       string       `json:"name"`
	Tier       string       `json:"tier"`
	Groups     []ogen.Group `json:"groups"`
	Status     string       `json:"status"`
	Paying     bool         `json:"paying"`
	Progress   Progress     `json:"progress"`
	Health     Health       `json:"health"`
	Milestones Milestones   `json:"milestones"`
	// EnteredStageAt is when the tenant entered its current stage. Reaching a
	// milestone out of order (AI before connecting) enters the stage when the
	// last of the milestones up to it was reached.
	EnteredStageAt time.Time  `json:"enteredStageAt"`
	DaysInStage    int        `json:"daysInStage"`
	LastActivityAt *time.Time `json:"lastActivityAt"`
	// IdleDays is the whole days since the last activity, or since signup for a
	// tenant that never did anything.
	IdleDays     int  `json:"idleDays"`
	Stuck        bool `json:"stuck"`
	PublishWeeks int  `json:"publishWeeks"`
	// Reasons are ordered by priority; the chip shows the first.
	Reasons []Reason `json:"reasons"`
	// Moved is set when the tenant changed stage or health since the previous
	// snapshot, or signed up after it.
	Moved bool `json:"moved"`
	// ChurnedAt is when a churned tenant left: its deletion time, else the first
	// snapshot that saw it churned. Nil when unknown.
	ChurnedAt *time.Time `json:"churnedAt"`
}

// Previous is a tenant's state in the previous snapshot.
type Previous struct {
	Progress       Progress
	Health         Health
	EnteredStageAt time.Time
}

// Evaluate places one tenant. prev is its state in the previous snapshot, nil
// when there is none (a new tenant, or no snapshot yet). hasPrevSnapshot tells
// the two apart: only a tenant missing from an existing snapshot is new.
func Evaluate(now time.Time, in Input, limits map[Progress]time.Duration, prev *Previous, hasPrevSnapshot bool) Tenant {
	s := in.Signal
	t := Tenant{
		ID: s.ID, Name: s.Name, Tier: in.Tier, Groups: in.Groups, Status: s.Status,
		Paying: in.Billing == billingActive, PublishWeeks: s.PublishWeeks,
		Milestones: Milestones{SignedUp: s.CreatedAt, Connected: s.FirstSocialAt, FirstPost: s.FirstPostAt, Regular: s.RegularAt},
	}
	if t.Groups == nil {
		t.Groups = []ogen.Group{}
	}
	if in.AI != nil {
		t.Milestones.Generating = &in.AI.First
	}

	t.Progress, t.EnteredStageAt = SignedUp, s.CreatedAt
	for _, p := range Stages[1:] {
		if at := t.Milestones.At(p); at != nil {
			t.Progress = p
		}
	}
	for _, p := range Stages[:t.Progress.Rank()+1] {
		if at := t.Milestones.At(p); at != nil && at.After(t.EnteredStageAt) {
			t.EnteredStageAt = *at
		}
	}
	if h := in.Hold; h != nil && h.Progress.Rank() > t.Progress.Rank() {
		t.Progress, t.EnteredStageAt = h.Progress, h.EnteredStageAt
	}
	t.DaysInStage = wholeDays(now.Sub(t.EnteredStageAt))

	t.LastActivityAt = s.LastActivityAt
	if in.AI != nil && (t.LastActivityAt == nil || in.AI.Last.After(*t.LastActivityAt)) {
		t.LastActivityAt = &in.AI.Last
	}
	idleSince := s.CreatedAt
	if t.LastActivityAt != nil {
		idleSince = *t.LastActivityAt
	}
	idle := now.Sub(idleSince)
	t.IdleDays = wholeDays(idle)

	switch {
	case s.Status != "" && s.Status != "active":
		t.Health = Churned
		t.ChurnedAt = s.DeletedAt
	case idle >= quietAfter:
		t.Health = Quiet
	case idle >= coolingAfter:
		t.Health = Cooling
	default:
		t.Health = Active
	}
	if h := in.Hold; h != nil && t.Health != Churned && h.Health != Churned && healthRank(h.Health) < healthRank(t.Health) {
		t.Health = h.Health
	}

	if limit, ok := limits[t.Progress]; ok && t.Health != Churned && now.Sub(t.EnteredStageAt) > limit {
		t.Stuck = true
	}

	switch {
	case prev != nil:
		t.Moved = prev.Progress != t.Progress || prev.Health != t.Health
	case hasPrevSnapshot:
		t.Moved = true
	}
	t.Reasons = reasons(t, s, in.Billing, prev)
	return t
}

func reasons(t Tenant, s ogen.LifecycleSignal, billing string, prev *Previous) []Reason {
	var out []Reason
	if t.Health == Churned {
		return []Reason{{Kind: ReasonStage, Tone: ToneInfo, Text: churnText(s.Status, t.Progress)}}
	}
	if s.FailedPosts24h > 0 {
		out = append(out, Reason{ReasonFailingPosts, ToneFailing, countText(s.FailedPosts24h, "post") + " failing" + onPlatform(s.LastFailurePlatform)})
	}
	if s.BrokenSocial > 0 {
		out = append(out, Reason{ReasonBrokenSocial, ToneRisk, platformText(s.BrokenPlatforms) + " disconnected"})
	}
	if billing == billingPastDue {
		out = append(out, Reason{ReasonPaymentPastDue, ToneRisk, "Payment past due"})
	}
	if t.Paying && t.Health == Quiet {
		out = append(out, Reason{ReasonPayingQuiet, ToneRisk, fmt.Sprintf("Paying, no activity %dd", t.IdleDays)})
	}
	if s.Drafts > 0 && t.Progress.Rank() < FirstPost.Rank() {
		out = append(out, Reason{ReasonDrafts, ToneInfo, countText(s.Drafts, "draft") + ", none published"})
	}
	if t.Moved {
		out = append(out, Reason{ReasonMoved, ToneMoved, movedText(t, prev)})
	}
	return append(out, Reason{ReasonStage, ToneInfo, stageText(t)})
}

func movedText(t Tenant, prev *Previous) string {
	// The previous snapshot is usually yesterday's, but not always (the job may
	// have been off), so the copy names no day.
	switch {
	case prev == nil:
		return "New signup"
	case prev.Progress != t.Progress:
		return "Moved from " + prev.Progress.Label()
	case t.Health == Quiet:
		return "Went quiet"
	case t.Health == Cooling && prev.Health == Quiet:
		return "Active again after going quiet"
	case t.Health == Cooling:
		return "Started cooling"
	default:
		return "Active again"
	}
}

func stageText(t Tenant) string {
	switch t.Progress {
	case SignedUp:
		return "No social connected"
	case Connected:
		return "No AI generation yet"
	case Generating:
		return "No published post yet"
	case FirstPost:
		return fmt.Sprintf("Posted in %d of %d weeks", min(t.PublishWeeks, regularWeeks-1), regularWeeks)
	}
	switch {
	case t.IdleDays == 0:
		return "Active today"
	case t.LastActivityAt == nil:
		return "No activity yet"
	}
	return fmt.Sprintf("Last active %dd ago", t.IdleDays)
}

func churnText(status string, p Progress) string {
	verb := "Suspended"
	if status == "deleted" {
		verb = "Deleted"
	}
	return verb + " · reached " + p.Label()
}

func countText(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return fmt.Sprintf("%d %ss", n, noun)
}

func onPlatform(p string) string {
	if p == "" {
		return ""
	}
	return " on " + platformText(p)
}

// platformText capitalises each platform of a ", "-joined list.
func platformText(list string) string {
	if list == "" {
		return "A social account"
	}
	parts := strings.Split(list, ", ")
	for i, p := range parts {
		if p != "" {
			parts[i] = strings.ToUpper(p[:1]) + p[1:]
		}
	}
	return strings.Join(parts, ", ")
}

func wholeDays(d time.Duration) int { return max(0, int(d/day)) }

// SortBoard orders tenants as a board column lists them: stuck first, then the
// longest in stage, then by name.
func SortBoard(ts []Tenant) {
	slices.SortStableFunc(ts, func(a, b Tenant) int {
		return cmp.Or(
			-cmpBool(a.Stuck, b.Stuck),
			cmp.Compare(b.DaysInStage, a.DaysInStage),
			cmp.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)),
		)
	})
}

func cmpBool(a, b bool) int {
	switch {
	case a == b:
		return 0
	case a:
		return 1
	}
	return -1
}
