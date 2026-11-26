package lifecycle

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/ogen-app/harbor/src/repository/ogeninvites"
)

// Invited is the step before Signed up: a tester invite that hasn't
// been redeemed. Invites aren't tenants, so they never get a progress stage or
// a snapshot; the board lists the open ones in their own column.
const Invited Progress = "invited"

// inviteLimit is how long an invite may stay unredeemed before it counts as
// stuck.
const inviteLimit = 3 * day

// InviteSource lists tester invites (gRPC). *ogeninvites.Client satisfies it; a
// nil client returns ErrUnavailable.
type InviteSource interface {
	ListInvites(ctx context.Context, f ogeninvites.ListFilter) (ogeninvites.InvitePage, error)
}

// Invite statuses from Ogen.
const (
	invitePending  = "pending"
	inviteExpired  = "expired"
	inviteRedeemed = "redeemed"
	inviteRevoked  = "revoked"
)

// invitePages caps the paging through ListTenantInvites.
const (
	invitePageSize = 200
	invitePages    = 50
)

// InviteChip is one open invite on the board's Invited column.
type InviteChip struct {
	ID        string     `json:"id"`
	Email     string     `json:"email"`
	Tier      string     `json:"tier"`
	Status    string     `json:"status"`
	SentAt    time.Time  `json:"sentAt"`
	ExpiresAt *time.Time `json:"expiresAt"`
	// DaysInStage counts from the latest send, so a resend restarts the clock.
	DaysInStage int    `json:"daysInStage"`
	Stuck       bool   `json:"stuck"`
	Reason      Reason `json:"reason"`
}

func (s *Service) invites(ctx context.Context) ([]ogeninvites.Invite, error) {
	var all []ogeninvites.Invite
	token := ""
	for range invitePages {
		page, err := s.inviteSrc.ListInvites(ctx, ogeninvites.ListFilter{PageSize: invitePageSize, PageToken: token})
		if err != nil {
			return nil, err
		}
		all = append(all, page.Invites...)
		if token = page.NextPageToken; token == "" {
			return all, nil
		}
	}
	// Pages run newest first, so a capped read would drop the oldest invites
	// and understate the totals; report it as unavailable instead.
	return nil, errInvitesTruncated
}

var errInvitesTruncated = errors.New("more invites than the board reads")

// InviteFunnel is the Invited step: every invite that wasn't revoked, the share
// redeemed, and the median days from creation to redemption. The invited
// tenants among all signups are counted separately, since organic signups make
// Signed up / Invited meaningless.
func InviteFunnel(invites []ogeninvites.Invite) (step FunnelStep, viaInvite int) {
	step.Stage = Invited
	var took []float64
	for _, inv := range invites {
		if inv.Status == inviteRevoked {
			continue
		}
		step.Reached++
		if inv.Status != inviteRedeemed {
			continue
		}
		viaInvite++
		if inv.CreatedAt != nil && inv.RedeemedAt != nil {
			took = append(took, inv.RedeemedAt.Sub(*inv.CreatedAt).Hours()/24)
		}
	}
	if step.Reached > 0 {
		step.Conversion = new(float64(viaInvite) / float64(step.Reached))
	}
	step.MedianDays = median(took)
	return step, viaInvite
}

// OpenInvites turns the pending and expired invites into chips, stuck first.
func OpenInvites(now time.Time, invites []ogeninvites.Invite) []InviteChip {
	out := []InviteChip{}
	for _, inv := range invites {
		if inv.Status != invitePending && inv.Status != inviteExpired {
			continue
		}
		sent := cmp.Or(deref(inv.LastSentAt), deref(inv.CreatedAt))
		c := InviteChip{
			ID: inv.ID, Email: inv.Email, Tier: inv.TierName, Status: inv.Status,
			SentAt: sent, ExpiresAt: inv.ExpiresAt, DaysInStage: wholeDays(now.Sub(sent)),
		}
		c.Stuck = !sent.IsZero() && now.Sub(sent) > inviteLimit
		c.Reason = inviteReason(now, inv)
		out = append(out, c)
	}
	slices.SortStableFunc(out, func(a, b InviteChip) int {
		return cmp.Or(-cmpBool(a.Stuck, b.Stuck), cmp.Compare(b.DaysInStage, a.DaysInStage), cmp.Compare(a.Email, b.Email))
	})
	return out
}

func inviteReason(now time.Time, inv ogeninvites.Invite) Reason {
	email := strings.ToLower(inv.EmailStatus)
	switch {
	case strings.Contains(email, "bounce") || strings.Contains(email, "fail") || strings.Contains(email, "suppress"):
		return Reason{Kind: "invite_email", Tone: ToneFailing, Text: "Invite email not delivered"}
	case inv.Status == inviteExpired:
		if inv.ExpiresAt != nil {
			return Reason{Kind: "invite_expired", Tone: ToneRisk, Text: fmt.Sprintf("Expired %dd ago", wholeDays(now.Sub(*inv.ExpiresAt)))}
		}
		return Reason{Kind: "invite_expired", Tone: ToneRisk, Text: "Expired"}
	case strings.Contains(email, "click"):
		return Reason{Kind: "invite_email", Tone: ToneInfo, Text: "Clicked the link, no signup"}
	case strings.Contains(email, "open"):
		return Reason{Kind: "invite_email", Tone: ToneInfo, Text: "Opened, no signup"}
	case inv.ExpiresAt != nil && inv.ExpiresAt.Sub(now) < 2*day:
		return Reason{Kind: "invite_expiring", Tone: ToneRisk, Text: "Expires " + untilText(inv.ExpiresAt.Sub(now))}
	case email == "":
		return Reason{Kind: "invite_email", Tone: ToneInfo, Text: "Email not sent yet"}
	}
	return Reason{Kind: "invite_email", Tone: ToneInfo, Text: "Not opened yet"}
}

func untilText(d time.Duration) string {
	if d < day {
		return "today"
	}
	return "tomorrow"
}

func deref(t *time.Time) time.Time {
	if t == nil {
		return time.Time{}
	}
	return *t
}
