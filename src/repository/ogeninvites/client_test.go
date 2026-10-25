package ogeninvites

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/timestamppb"

	tenantinvitesv1 "github.com/ogen-app/harbor/gen/tenantinvites/v1"
)

// fakeServer stands in for Ogen's TenantInviteAdminService: it records the
// bearer token and request fields, and echoes canned data so the proto→DTO
// mapping is exercised over the wire.
type fakeServer struct {
	tenantinvitesv1.UnimplementedTenantInviteAdminServiceServer
	gotAuth    string
	lastCreate *tenantinvitesv1.CreateTenantInviteRequest
	lastList   *tenantinvitesv1.ListTenantInvitesRequest
	lastResend *tenantinvitesv1.ResendTenantInviteRequest
	lastUpdate *tenantinvitesv1.UpdateSignupSettingsRequest
}

func (s *fakeServer) auth(ctx context.Context) {
	if md, ok := metadata.FromIncomingContext(ctx); ok {
		if v := md.Get("authorization"); len(v) > 0 {
			s.gotAuth = v[0]
		}
	}
}

func cannedInvite(id string) *tenantinvitesv1.TenantInvite {
	return &tenantinvitesv1.TenantInvite{
		Id:                          id,
		Email:                       "jane@acme.com",
		TierId:                      "beta",
		TierName:                    "Beta (unlimited)",
		TierPurchasable:             false,
		Groups:                      []*tenantinvitesv1.TenantInviteGroup{{Id: "g1", Name: "alpha", Color: "#D9C2F0"}},
		CreatedBy:                   "op@getogen.com",
		Status:                      "redeemed",
		ExpiresAt:                   timestamppb.New(time.Unix(9000, 0)),
		SentCount:                   2,
		EmailStatus:                 "opened",
		RedeemedTenantId:            "t1",
		RedeemedTenantName:          "Acme",
		RedeemedTenantComplimentary: true,
		CreatedAt:                   timestamppb.New(time.Unix(1000, 0)),
	}
}

func (s *fakeServer) CreateTenantInvite(ctx context.Context, req *tenantinvitesv1.CreateTenantInviteRequest) (*tenantinvitesv1.CreateTenantInviteResponse, error) {
	s.auth(ctx)
	s.lastCreate = req
	return &tenantinvitesv1.CreateTenantInviteResponse{Invite: cannedInvite("i1"), Replaced: true}, nil
}

func (s *fakeServer) ListTenantInvites(ctx context.Context, req *tenantinvitesv1.ListTenantInvitesRequest) (*tenantinvitesv1.ListTenantInvitesResponse, error) {
	s.auth(ctx)
	s.lastList = req
	return &tenantinvitesv1.ListTenantInvitesResponse{
		Invites:       []*tenantinvitesv1.TenantInvite{cannedInvite("i1"), {Id: "i2", Status: "pending"}},
		NextPageToken: "next",
	}, nil
}

func (s *fakeServer) ResendTenantInvite(ctx context.Context, req *tenantinvitesv1.ResendTenantInviteRequest) (*tenantinvitesv1.ResendTenantInviteResponse, error) {
	s.auth(ctx)
	s.lastResend = req
	return &tenantinvitesv1.ResendTenantInviteResponse{Invite: &tenantinvitesv1.TenantInvite{Id: req.GetId(), Status: "pending", SentCount: 3}}, nil
}

func (s *fakeServer) GetSignupSettings(ctx context.Context, _ *tenantinvitesv1.GetSignupSettingsRequest) (*tenantinvitesv1.GetSignupSettingsResponse, error) {
	s.auth(ctx)
	return &tenantinvitesv1.GetSignupSettingsResponse{Settings: &tenantinvitesv1.SignupSettings{Mode: ModeOpen, MaxOwnedWorkspacesPerAccount: 2}}, nil
}

func (s *fakeServer) UpdateSignupSettings(ctx context.Context, req *tenantinvitesv1.UpdateSignupSettingsRequest) (*tenantinvitesv1.UpdateSignupSettingsResponse, error) {
	s.auth(ctx)
	s.lastUpdate = req
	return &tenantinvitesv1.UpdateSignupSettingsResponse{Settings: &tenantinvitesv1.SignupSettings{
		Mode:                         req.GetMode(),
		MaxOwnedWorkspacesPerAccount: req.GetMaxOwnedWorkspacesPerAccount(),
		UpdatedBy:                    req.GetUpdatedBy(),
		UpdatedAt:                    timestamppb.New(time.Unix(7000, 0)),
	}}, nil
}

func newClient(t *testing.T, fake *fakeServer) *Client {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	gs := grpc.NewServer()
	tenantinvitesv1.RegisterTenantInviteAdminServiceServer(gs, fake)
	go func() { _ = gs.Serve(lis) }()
	t.Cleanup(gs.Stop)

	client, err := New(lis.Addr().String(), "tok-123")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

// TestClientRoundTrip drives the real client against a live server: dial, the
// bearer-token interceptor, request fields, and the proto→DTO mapping including
// optional timestamps (unset → nil) and groups.
func TestClientRoundTrip(t *testing.T) {
	fake := &fakeServer{}
	c := newClient(t, fake)
	ctx := t.Context()

	inv, replaced, err := c.CreateInvite(ctx, InviteInput{
		Email: "jane@acme.com", TierID: "beta", GroupIDs: []string{"g1"}, ExpiresInHours: 168,
		Message: "welcome", Note: "met at conf", CreatedBy: "op@getogen.com",
	})
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	if fake.gotAuth != "Bearer tok-123" {
		t.Errorf("auth = %q, want bearer token", fake.gotAuth)
	}
	if r := fake.lastCreate; r.GetEmail() != "jane@acme.com" || r.GetTierId() != "beta" || len(r.GetGroupIds()) != 1 ||
		r.GetExpiresInHours() != 168 || r.GetMessage() != "welcome" || r.GetNote() != "met at conf" || r.GetCreatedBy() != "op@getogen.com" {
		t.Errorf("create request = %+v", r)
	}
	if !replaced || inv.ID != "i1" || inv.TierPurchasable || len(inv.Groups) != 1 || inv.Groups[0].Name != "alpha" {
		t.Errorf("invite = %+v replaced=%v", inv, replaced)
	}
	if inv.ExpiresAt == nil || inv.CreatedAt == nil || inv.RedeemedAt != nil || inv.LastSentAt != nil {
		t.Errorf("timestamps: expires=%v created=%v redeemed=%v lastSent=%v", inv.ExpiresAt, inv.CreatedAt, inv.RedeemedAt, inv.LastSentAt)
	}
	if !inv.RedeemedTenantComplimentary || inv.RedeemedTenantID != "t1" || inv.EmailStatus != "opened" || inv.SentCount != 2 {
		t.Errorf("redemption/email fields = %+v", inv)
	}

	page, err := c.ListInvites(ctx, ListFilter{Status: "pending", EmailQuery: "acme", PageSize: 25, PageToken: "cur"})
	if err != nil {
		t.Fatalf("ListInvites: %v", err)
	}
	if r := fake.lastList; r.GetStatus() != "pending" || r.GetEmailQuery() != "acme" || r.GetPageSize() != 25 || r.GetPageToken() != "cur" {
		t.Errorf("list request = %+v", r)
	}
	if len(page.Invites) != 2 || page.NextPageToken != "next" {
		t.Fatalf("page = %+v", page)
	}
	if page.Invites[1].Groups == nil {
		t.Errorf("empty groups must be non-nil so the UI can map over them")
	}

	re, err := c.ResendInvite(ctx, "i2", 72)
	if err != nil {
		t.Fatalf("ResendInvite: %v", err)
	}
	if fake.lastResend.GetId() != "i2" || fake.lastResend.GetExpiresInHours() != 72 || re.SentCount != 3 {
		t.Errorf("resend = %+v (req %+v)", re, fake.lastResend)
	}

	s, err := c.SignupSettings(ctx)
	if err != nil {
		t.Fatalf("SignupSettings: %v", err)
	}
	if s.Mode != ModeOpen || s.MaxOwnedWorkspaces != 2 || s.UpdatedAt != nil {
		t.Errorf("settings = %+v", s)
	}

	s, err = c.UpdateSignupSettings(ctx, ModeInviteOnly, 3, "op@getogen.com")
	if err != nil {
		t.Fatalf("UpdateSignupSettings: %v", err)
	}
	if r := fake.lastUpdate; r.GetMode() != ModeInviteOnly || r.GetMaxOwnedWorkspacesPerAccount() != 3 || r.GetUpdatedBy() != "op@getogen.com" {
		t.Errorf("update request = %+v", r)
	}
	if s.Mode != ModeInviteOnly || s.UpdatedBy != "op@getogen.com" || s.UpdatedAt == nil {
		t.Errorf("updated settings = %+v", s)
	}
}

// A nil client (unconfigured) reports ErrUnavailable from every method.
func TestNilClientUnavailable(t *testing.T) {
	var c *Client
	ctx := t.Context()
	if _, _, err := c.CreateInvite(ctx, InviteInput{}); !errors.Is(err, ErrUnavailable) {
		t.Errorf("CreateInvite err = %v", err)
	}
	if _, err := c.ListInvites(ctx, ListFilter{}); !errors.Is(err, ErrUnavailable) {
		t.Errorf("ListInvites err = %v", err)
	}
	if _, err := c.RevokeInvite(ctx, "i1"); !errors.Is(err, ErrUnavailable) {
		t.Errorf("RevokeInvite err = %v", err)
	}
	if _, err := c.SignupSettings(ctx); !errors.Is(err, ErrUnavailable) {
		t.Errorf("SignupSettings err = %v", err)
	}
	if err := c.Close(); err != nil {
		t.Errorf("Close on nil client = %v", err)
	}
}
