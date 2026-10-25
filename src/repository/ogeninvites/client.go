// Package ogeninvites is Harbor's gRPC client for Ogen's internal
// TenantInviteAdminService — complimentary tester invites and the platform
// signup mode (CON-333; the Harbor screens are CON-334).
//
// A tester invite is email-bound and single-use: redeeming it creates a new
// complimentary workspace (never billed) on the invite's tier and groups. The
// signup mode governs self-registration only — tester invites work in both
// modes.
//
// Like ogenbilling (whose listener and shared bearer token this reuses), the
// client is best-effort: an unconfigured (empty addr/token) client is nil and
// every method returns ErrUnavailable, which the handler renders as a soft
// "unavailable" state. The bearer token is injected into outgoing gRPC metadata
// by a client interceptor and is never logged.
package ogeninvites

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/timestamppb"

	tenantinvitesv1 "github.com/ogen-app/harbor/gen/tenantinvites/v1"
)

// ErrUnavailable is returned by every method on a nil (unconfigured) client.
// Callers treat it as "invites unavailable", not a hard error — mirroring the
// other Ogen admin clients' nil-client contract.
var ErrUnavailable = errors.New("ogen tenant-invite-admin service not configured")

const defaultTimeout = 10 * time.Second

// Signup modes.
const (
	ModeOpen       = "open"
	ModeInviteOnly = "invite_only"
)

// Group is a tenant group the invited workspace joins (cohorts are groups).
type Group struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"` // '' when unset
}

// Invite is one tester invite. Status is derived by Ogen: pending | expired |
// redeemed | revoked. Optional instants are pointers: nil means unset.
type Invite struct {
	ID              string     `json:"id"`
	Email           string     `json:"email"`
	TierID          string     `json:"tierId"` // '' once the tier was deleted
	TierName        string     `json:"tierName"`
	TierPurchasable bool       `json:"tierPurchasable"`
	Groups          []Group    `json:"groups"`
	Message         string     `json:"message"`
	Note            string     `json:"note"`
	CreatedBy       string     `json:"createdBy"`
	Status          string     `json:"status"`
	ExpiresAt       *time.Time `json:"expiresAt"`
	SentCount       int32      `json:"sentCount"`
	LastSentAt      *time.Time `json:"lastSentAt"`
	// EmailStatus is the latest send's last delivery event (delivered, opened,
	// bounced, …) or, without one, the send outcome (sent, skipped_suppressed,
	// failed, …); '' until the email worker ran.
	EmailStatus                 string     `json:"emailStatus"`
	EmailLastEventAt            *time.Time `json:"emailLastEventAt"`
	RedeemedAt                  *time.Time `json:"redeemedAt"`
	RedeemedTenantID            string     `json:"redeemedTenantId"`
	RedeemedTenantName          string     `json:"redeemedTenantName"`
	RedeemedTenantComplimentary bool       `json:"redeemedTenantComplimentary"`
	RevokedAt                   *time.Time `json:"revokedAt"`
	CreatedAt                   *time.Time `json:"createdAt"`
}

// InviteInput is the create payload. ExpiresInHours 0 means Ogen's default
// (14 days); CreatedBy is the signed-in operator, set server-side.
type InviteInput struct {
	Email          string
	TierID         string
	GroupIDs       []string
	ExpiresInHours int32
	Message        string
	Note           string
	CreatedBy      string
}

// InvitePage is one page of invites, newest first. NextPageToken is "" on the
// last page.
type InvitePage struct {
	Invites       []Invite `json:"invites"`
	NextPageToken string   `json:"nextPageToken"`
}

// ListFilter narrows ListInvites. Status ” = every status.
type ListFilter struct {
	Status     string
	EmailQuery string
	PageSize   int32
	PageToken  string
}

// SignupSettings decides who may create a workspace. MaxOwnedWorkspaces (0 = no
// cap) only applies while Mode is invite_only.
type SignupSettings struct {
	Mode               string     `json:"mode"`
	MaxOwnedWorkspaces int32      `json:"maxOwnedWorkspaces"`
	UpdatedAt          *time.Time `json:"updatedAt"`
	UpdatedBy          string     `json:"updatedBy"`
}

// Client is a thin, safe wrapper over the generated TenantInviteAdminServiceClient.
type Client struct {
	conn    *grpc.ClientConn
	rpc     tenantinvitesv1.TenantInviteAdminServiceClient
	timeout time.Duration
}

// New dials Ogen's internal gRPC surface. Enabled only when BOTH addr and token
// are set; either empty returns (nil, nil): a nil client that reports
// ErrUnavailable, so the pages degrade softly rather than failing boot.
// grpc.NewClient connects lazily, so this never blocks on Ogen being up.
func New(addr, token string) (*Client, error) {
	if addr == "" || token == "" {
		return nil, nil
	}
	conn, err := grpc.NewClient(
		addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithChainUnaryInterceptor(bearerTokenInterceptor(token)),
	)
	if err != nil {
		return nil, fmt.Errorf("ogeninvites: dial %q: %w", addr, err)
	}
	return &Client{conn: conn, rpc: tenantinvitesv1.NewTenantInviteAdminServiceClient(conn), timeout: defaultTimeout}, nil
}

// Close releases the underlying connection. Safe on a nil client.
func (c *Client) Close() error {
	if c == nil || c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

// CreateInvite stores an invite and emails its link. replaced reports that a
// pending invite for the same address was replaced (its link stopped working).
// FailedPrecondition carries an "account_exists:" or "tier_not_active:" prefix.
func (c *Client) CreateInvite(ctx context.Context, in InviteInput) (Invite, bool, error) {
	if c == nil {
		return Invite{}, false, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.CreateTenantInvite(ctx, &tenantinvitesv1.CreateTenantInviteRequest{
		Email:          in.Email,
		TierId:         in.TierID,
		GroupIds:       in.GroupIDs,
		ExpiresInHours: in.ExpiresInHours,
		Message:        in.Message,
		Note:           in.Note,
		CreatedBy:      in.CreatedBy,
	})
	if err != nil {
		return Invite{}, false, err
	}
	return inviteFromProto(resp.GetInvite()), resp.GetReplaced(), nil
}

// GetInvite returns one invite. NotFound for an unknown id.
func (c *Client) GetInvite(ctx context.Context, id string) (Invite, error) {
	if c == nil {
		return Invite{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.GetTenantInvite(ctx, &tenantinvitesv1.GetTenantInviteRequest{Id: id})
	if err != nil {
		return Invite{}, err
	}
	return inviteFromProto(resp.GetInvite()), nil
}

// ListInvites returns one keyset page of invites, newest first. PageSize is
// clamped server-side (0 = server default).
func (c *Client) ListInvites(ctx context.Context, f ListFilter) (InvitePage, error) {
	if c == nil {
		return InvitePage{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.ListTenantInvites(ctx, &tenantinvitesv1.ListTenantInvitesRequest{
		Status:     f.Status,
		EmailQuery: f.EmailQuery,
		PageSize:   f.PageSize,
		PageToken:  f.PageToken,
	})
	if err != nil {
		return InvitePage{}, err
	}
	out := make([]Invite, 0, len(resp.GetInvites()))
	for _, inv := range resp.GetInvites() {
		out = append(out, inviteFromProto(inv))
	}
	return InvitePage{Invites: out, NextPageToken: resp.GetNextPageToken()}, nil
}

// ResendInvite rotates a pending (or expired) invite's token, extends its
// expiry and emails the new link. expiresInHours 0 keeps the original lifetime.
// FailedPrecondition for a redeemed or revoked invite.
func (c *Client) ResendInvite(ctx context.Context, id string, expiresInHours int32) (Invite, error) {
	if c == nil {
		return Invite{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.ResendTenantInvite(ctx, &tenantinvitesv1.ResendTenantInviteRequest{Id: id, ExpiresInHours: expiresInHours})
	if err != nil {
		return Invite{}, err
	}
	return inviteFromProto(resp.GetInvite()), nil
}

// RevokeInvite kills a pending invite's link. FailedPrecondition for a redeemed
// or revoked invite.
func (c *Client) RevokeInvite(ctx context.Context, id string) (Invite, error) {
	if c == nil {
		return Invite{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.RevokeTenantInvite(ctx, &tenantinvitesv1.RevokeTenantInviteRequest{Id: id})
	if err != nil {
		return Invite{}, err
	}
	return inviteFromProto(resp.GetInvite()), nil
}

// SignupSettings returns the signup mode and the workspace cap.
func (c *Client) SignupSettings(ctx context.Context) (SignupSettings, error) {
	if c == nil {
		return SignupSettings{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.GetSignupSettings(ctx, &tenantinvitesv1.GetSignupSettingsRequest{})
	if err != nil {
		return SignupSettings{}, err
	}
	return settingsFromProto(resp.GetSettings()), nil
}

// UpdateSignupSettings writes the whole resource (mode + cap). updatedBy is the
// signed-in operator.
func (c *Client) UpdateSignupSettings(ctx context.Context, mode string, maxOwnedWorkspaces int32, updatedBy string) (SignupSettings, error) {
	if c == nil {
		return SignupSettings{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.UpdateSignupSettings(ctx, &tenantinvitesv1.UpdateSignupSettingsRequest{
		Mode:                         mode,
		MaxOwnedWorkspacesPerAccount: maxOwnedWorkspaces,
		UpdatedBy:                    updatedBy,
	})
	if err != nil {
		return SignupSettings{}, err
	}
	return settingsFromProto(resp.GetSettings()), nil
}

// ── proto → DTO ────────────────────────────────────────────────────────────────

func inviteFromProto(p *tenantinvitesv1.TenantInvite) Invite {
	groups := make([]Group, 0, len(p.GetGroups()))
	for _, g := range p.GetGroups() {
		groups = append(groups, Group{ID: g.GetId(), Name: g.GetName(), Color: g.GetColor()})
	}
	return Invite{
		ID:                          p.GetId(),
		Email:                       p.GetEmail(),
		TierID:                      p.GetTierId(),
		TierName:                    p.GetTierName(),
		TierPurchasable:             p.GetTierPurchasable(),
		Groups:                      groups,
		Message:                     p.GetMessage(),
		Note:                        p.GetNote(),
		CreatedBy:                   p.GetCreatedBy(),
		Status:                      p.GetStatus(),
		ExpiresAt:                   timePtr(p.GetExpiresAt()),
		SentCount:                   p.GetSentCount(),
		LastSentAt:                  timePtr(p.GetLastSentAt()),
		EmailStatus:                 p.GetEmailStatus(),
		EmailLastEventAt:            timePtr(p.GetEmailLastEventAt()),
		RedeemedAt:                  timePtr(p.GetRedeemedAt()),
		RedeemedTenantID:            p.GetRedeemedTenantId(),
		RedeemedTenantName:          p.GetRedeemedTenantName(),
		RedeemedTenantComplimentary: p.GetRedeemedTenantComplimentary(),
		RevokedAt:                   timePtr(p.GetRevokedAt()),
		CreatedAt:                   timePtr(p.GetCreatedAt()),
	}
}

func settingsFromProto(p *tenantinvitesv1.SignupSettings) SignupSettings {
	return SignupSettings{
		Mode:               p.GetMode(),
		MaxOwnedWorkspaces: p.GetMaxOwnedWorkspacesPerAccount(),
		UpdatedAt:          timePtr(p.GetUpdatedAt()),
		UpdatedBy:          p.GetUpdatedBy(),
	}
}

// timePtr converts an optional proto timestamp to *time.Time — nil (and the zero
// timestamp Ogen sends for an unset field) both map to nil, so the UI can tell
// "unset" from a real instant.
func timePtr(ts *timestamppb.Timestamp) *time.Time {
	if ts == nil || (ts.GetSeconds() == 0 && ts.GetNanos() == 0) {
		return nil
	}
	return new(ts.AsTime())
}

// bearerTokenInterceptor injects `authorization: Bearer <token>` into the
// outgoing metadata of every unary call. The token is never logged.
func bearerTokenInterceptor(token string) grpc.UnaryClientInterceptor {
	bearer := "Bearer " + token
	return func(ctx context.Context, method string, req, reply any, cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
		ctx = metadata.AppendToOutgoingContext(ctx, "authorization", bearer)
		return invoker(ctx, method, req, reply, cc, opts...)
	}
}
