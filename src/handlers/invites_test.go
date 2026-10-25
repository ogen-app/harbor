package handlers

import (
	"context"
	"encoding/json"
	"net"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	tenantinvitesv1 "github.com/ogen-app/harbor/gen/tenantinvites/v1"
	"github.com/ogen-app/harbor/src/repository/ogeninvites"
)

// fakeInvites is a minimal TenantInviteAdminService: it records the write
// requests and returns canned errors so the handler's error mapping runs over
// the wire.
type fakeInvites struct {
	tenantinvitesv1.UnimplementedTenantInviteAdminServiceServer
	lastCreate *tenantinvitesv1.CreateTenantInviteRequest
	lastUpdate *tenantinvitesv1.UpdateSignupSettingsRequest
	lastResend *tenantinvitesv1.ResendTenantInviteRequest
	createErr  error
	revokeErr  error
}

func (f *fakeInvites) CreateTenantInvite(_ context.Context, req *tenantinvitesv1.CreateTenantInviteRequest) (*tenantinvitesv1.CreateTenantInviteResponse, error) {
	f.lastCreate = req
	if f.createErr != nil {
		return nil, f.createErr
	}
	return &tenantinvitesv1.CreateTenantInviteResponse{Invite: &tenantinvitesv1.TenantInvite{Id: "i1", Email: req.GetEmail(), Status: "pending"}, Replaced: true}, nil
}

func (f *fakeInvites) ResendTenantInvite(_ context.Context, req *tenantinvitesv1.ResendTenantInviteRequest) (*tenantinvitesv1.ResendTenantInviteResponse, error) {
	f.lastResend = req
	return &tenantinvitesv1.ResendTenantInviteResponse{Invite: &tenantinvitesv1.TenantInvite{Id: req.GetId(), Status: "pending"}}, nil
}

func (f *fakeInvites) RevokeTenantInvite(_ context.Context, req *tenantinvitesv1.RevokeTenantInviteRequest) (*tenantinvitesv1.RevokeTenantInviteResponse, error) {
	if f.revokeErr != nil {
		return nil, f.revokeErr
	}
	return &tenantinvitesv1.RevokeTenantInviteResponse{Invite: &tenantinvitesv1.TenantInvite{Id: req.GetId(), Status: "revoked"}}, nil
}

func (f *fakeInvites) UpdateSignupSettings(_ context.Context, req *tenantinvitesv1.UpdateSignupSettingsRequest) (*tenantinvitesv1.UpdateSignupSettingsResponse, error) {
	f.lastUpdate = req
	return &tenantinvitesv1.UpdateSignupSettingsResponse{Settings: &tenantinvitesv1.SignupSettings{
		Mode: req.GetMode(), MaxOwnedWorkspacesPerAccount: req.GetMaxOwnedWorkspacesPerAccount(), UpdatedBy: req.GetUpdatedBy(),
	}}, nil
}

// fixedOperator stands in for the session-backed lookup.
func fixedOperator(*fiber.Ctx) (string, error) { return "op@getogen.com", nil }

func newInvitesApp(t *testing.T, fake *fakeInvites) *fiber.App {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	gs := grpc.NewServer()
	tenantinvitesv1.RegisterTenantInviteAdminServiceServer(gs, fake)
	go func() { _ = gs.Serve(lis) }()
	t.Cleanup(gs.Stop)

	client, err := ogeninvites.New(lis.Addr().String(), "tok")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	app := fiber.New()
	NewInvitesHandler(client, fixedOperator).Register(app, passAuth)
	return app
}

// The reads degrade softly on an unconfigured client (200 + available:false +
// never-null lists), so the pages and the sidebar mode pill render an
// "unavailable" state rather than an error; writes are hard 503s.
func TestInvites_Unavailable(t *testing.T) {
	app := fiber.New()
	NewInvitesHandler(nil, fixedOperator).Register(app, passAuth)

	for _, path := range []string{"/api/signup-settings", "/api/invites"} {
		code, body := doJSON(t, app, "GET", path, "")
		if code != fiber.StatusOK {
			t.Fatalf("%s: status = %d, want 200", path, code)
		}
		var got map[string]any
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatalf("%s: decode: %v", path, err)
		}
		if got["available"] != false {
			t.Errorf("%s: available = %v, want false", path, got["available"])
		}
	}
	if _, body := doJSON(t, app, "GET", "/api/invites", ""); !strings.Contains(string(body), `"invites":[]`) {
		t.Errorf("list body = %s, want invites:[]", body)
	}

	cases := []struct{ method, path, body string }{
		{"PUT", "/api/signup-settings", `{"mode":"open","maxOwnedWorkspaces":0}`},
		{"POST", "/api/invites", `{"email":"a@b.co","tierId":"pro"}`},
		{"POST", "/api/invites/i1/resend", ""},
		{"POST", "/api/invites/i1/revoke", ""},
	}
	for _, tc := range cases {
		if code, _ := doJSON(t, app, tc.method, tc.path, tc.body); code != fiber.StatusServiceUnavailable {
			t.Errorf("%s %s: status = %d, want 503", tc.method, tc.path, code)
		}
	}
}

// created_by / updated_by come from the session-backed operator lookup, never
// from the body; inputs are trimmed and a missing email/tier is refused early.
func TestInvites_CreateStampsOperator(t *testing.T) {
	fake := &fakeInvites{}
	app := newInvitesApp(t, fake)

	if code, _ := doJSON(t, app, "POST", "/api/invites", `{"email":" ","tierId":"pro"}`); code != fiber.StatusBadRequest {
		t.Errorf("blank email: status = %d, want 400", code)
	}
	if code, _ := doJSON(t, app, "POST", "/api/invites", `{"email":"a@b.co"}`); code != fiber.StatusBadRequest {
		t.Errorf("missing tier: status = %d, want 400", code)
	}
	if fake.lastCreate != nil {
		t.Fatalf("an invalid request reached Ogen")
	}

	code, body := doJSON(t, app, "POST", "/api/invites",
		`{"email":" jane@acme.com ","tierId":"beta","groupIds":["g1"],"expiresInHours":72,"message":" hi ","note":"n","createdBy":"spoofed"}`)
	if code != fiber.StatusOK {
		t.Fatalf("create: status = %d, body = %s", code, body)
	}
	r := fake.lastCreate
	if r.GetEmail() != "jane@acme.com" || r.GetTierId() != "beta" || r.GetExpiresInHours() != 72 || r.GetMessage() != "hi" || len(r.GetGroupIds()) != 1 {
		t.Errorf("create request = %+v", r)
	}
	if r.GetCreatedBy() != "op@getogen.com" {
		t.Errorf("created_by = %q, want the session operator", r.GetCreatedBy())
	}
	if !strings.Contains(string(body), `"replaced":true`) {
		t.Errorf("body = %s, want replaced:true", body)
	}
}

// Ogen's FailedPrecondition sub-reason ("account_exists: …") is split into a
// machine-readable code the UI keys its guidance on; other preconditions pass
// their message through as a plain 409.
func TestInvites_FailedPreconditionCodes(t *testing.T) {
	fake := &fakeInvites{
		createErr: status.Error(codes.FailedPrecondition, "account_exists: this email already has an Ogen account"),
		revokeErr: status.Error(codes.FailedPrecondition, "the invite is no longer pending"),
	}
	app := newInvitesApp(t, fake)

	code, body := doJSON(t, app, "POST", "/api/invites", `{"email":"a@b.co","tierId":"pro"}`)
	if code != fiber.StatusConflict {
		t.Fatalf("account exists: status = %d, want 409", code)
	}
	var got struct{ Error, Code string }
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Code != "account_exists" || got.Error != "this email already has an Ogen account" {
		t.Errorf("body = %+v, want code account_exists + trimmed message", got)
	}

	code, body = doJSON(t, app, "POST", "/api/invites/i1/revoke", "")
	if code != fiber.StatusConflict || !strings.Contains(string(body), "no longer pending") || strings.Contains(string(body), `"code"`) {
		t.Errorf("revoke non-pending: status = %d, body = %s; want plain 409", code, body)
	}

	fake.createErr = status.Error(codes.InvalidArgument, "unknown group g9")
	if code, body := doJSON(t, app, "POST", "/api/invites", `{"email":"a@b.co","tierId":"pro"}`); code != fiber.StatusBadRequest || !strings.Contains(string(body), "unknown group") {
		t.Errorf("invalid argument: status = %d, body = %s; want 400 with message", code, body)
	}
}

// Signup settings validate the mode and cap before reaching Ogen and stamp the
// operator; resend works with or without a body.
func TestInvites_SignupSettingsAndResend(t *testing.T) {
	fake := &fakeInvites{}
	app := newInvitesApp(t, fake)

	for _, body := range []string{`{"mode":"closed","maxOwnedWorkspaces":0}`, `{"mode":"open","maxOwnedWorkspaces":-1}`} {
		if code, _ := doJSON(t, app, "PUT", "/api/signup-settings", body); code != fiber.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", body, code)
		}
	}
	if fake.lastUpdate != nil {
		t.Fatalf("an invalid settings write reached Ogen")
	}
	code, body := doJSON(t, app, "PUT", "/api/signup-settings", `{"mode":"invite_only","maxOwnedWorkspaces":2}`)
	if code != fiber.StatusOK {
		t.Fatalf("update: status = %d, body = %s", code, body)
	}
	if u := fake.lastUpdate; u.GetMode() != "invite_only" || u.GetMaxOwnedWorkspacesPerAccount() != 2 || u.GetUpdatedBy() != "op@getogen.com" {
		t.Errorf("update request = %+v", u)
	}

	if code, _ := doJSON(t, app, "POST", "/api/invites/i1/resend", ""); code != fiber.StatusOK {
		t.Errorf("resend without body: status = %d, want 200", code)
	}
	if code, _ := doJSON(t, app, "POST", "/api/invites/i1/resend", `{"expiresInHours":168}`); code != fiber.StatusOK {
		t.Errorf("resend with expiry: status = %d, want 200", code)
	}
	if fake.lastResend.GetId() != "i1" || fake.lastResend.GetExpiresInHours() != 168 {
		t.Errorf("resend request = %+v", fake.lastResend)
	}
}
