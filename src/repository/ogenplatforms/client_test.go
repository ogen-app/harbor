package ogenplatforms

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/timestamppb"

	platformsv1 "github.com/ogen-app/harbor/gen/platforms/v1"
)

// fakeServer stands in for Ogen's PlatformAdminService. It records the bearer
// token it received (so the test can assert the auth interceptor fires) and the
// key request fields it was called with, and echoes canned data so the client's
// proto↔struct mapping is exercised end-to-end in both directions.
type fakeServer struct {
	platformsv1.UnimplementedPlatformAdminServiceServer
	gotAuth            string
	gotIncludeDisabled bool
	lastCreate         *platformsv1.Platform
	lastUpdate         *platformsv1.Platform
	lastEnabledID      string
	lastEnabled        bool
	lastDeleteID       string
	lastDeleteForce    bool
	lastGlobal         *platformsv1.GlobalLimits
}

func (s *fakeServer) auth(ctx context.Context) {
	if md, ok := metadata.FromIncomingContext(ctx); ok {
		if v := md.Get("authorization"); len(v) > 0 {
			s.gotAuth = v[0]
		}
	}
}

func (s *fakeServer) ListPlatforms(ctx context.Context, req *platformsv1.ListPlatformsRequest) (*platformsv1.ListPlatformsResponse, error) {
	s.auth(ctx)
	s.gotIncludeDisabled = req.GetIncludeDisabled()
	return &platformsv1.ListPlatformsResponse{Platforms: []*platformsv1.Platform{
		{
			Id:                 "px",
			Name:               "X",
			ZernioId:           "twitter",
			Enabled:            true,
			ConnectSupported:   true,
			SortOrder:          1,
			PostTypes:          map[string]string{"post": "Post", "thread": "Thread"},
			SupportedPostTypes: []string{"post"},
			ImageConstraints:   &platformsv1.ImageConstraints{MaxFileSizeBytes: 5 << 20, AllowedFormats: []string{"jpeg", "png"}, MaxAttachmentsPerPost: 4},
			TextConstraints:    &platformsv1.TextConstraints{MaxContentChars: 280, PerPostType: map[string]int32{"thread": 280}},
			Usage:              &platformsv1.PlatformUsage{ConnectedAccounts: 3, ScheduledPosts: 7},
			UpdatedAt:          timestamppb.New(time.Unix(1000, 0)),
		},
		{Id: "ptt", Name: "TikTok", ZernioId: "tiktok", Enabled: false, SortOrder: 2},
	}}, nil
}

func (s *fakeServer) CreatePlatform(ctx context.Context, req *platformsv1.CreatePlatformRequest) (*platformsv1.CreatePlatformResponse, error) {
	s.auth(ctx)
	s.lastCreate = req.GetPlatform()
	p := req.GetPlatform()
	p.Id = "new-id"
	return &platformsv1.CreatePlatformResponse{Platform: p}, nil
}

func (s *fakeServer) UpdatePlatform(ctx context.Context, req *platformsv1.UpdatePlatformRequest) (*platformsv1.UpdatePlatformResponse, error) {
	s.auth(ctx)
	s.lastUpdate = req.GetPlatform()
	return &platformsv1.UpdatePlatformResponse{Platform: req.GetPlatform()}, nil
}

func (s *fakeServer) SetPlatformEnabled(ctx context.Context, req *platformsv1.SetPlatformEnabledRequest) (*platformsv1.SetPlatformEnabledResponse, error) {
	s.auth(ctx)
	s.lastEnabledID = req.GetId()
	s.lastEnabled = req.GetEnabled()
	return &platformsv1.SetPlatformEnabledResponse{Platform: &platformsv1.Platform{Id: req.GetId(), Enabled: req.GetEnabled()}}, nil
}

func (s *fakeServer) DeletePlatform(ctx context.Context, req *platformsv1.DeletePlatformRequest) (*platformsv1.DeletePlatformResponse, error) {
	s.auth(ctx)
	s.lastDeleteID = req.GetId()
	s.lastDeleteForce = req.GetForce()
	return &platformsv1.DeletePlatformResponse{}, nil
}

func (s *fakeServer) GetGlobalLimits(ctx context.Context, _ *platformsv1.GetGlobalLimitsRequest) (*platformsv1.GetGlobalLimitsResponse, error) {
	s.auth(ctx)
	return &platformsv1.GetGlobalLimitsResponse{Limits: &platformsv1.GlobalLimits{MaxImageUploadBytes: 10 << 20, MaxThreadSegments: 25}}, nil
}

func (s *fakeServer) UpdateGlobalLimits(ctx context.Context, req *platformsv1.UpdateGlobalLimitsRequest) (*platformsv1.UpdateGlobalLimitsResponse, error) {
	s.auth(ctx)
	s.lastGlobal = req.GetLimits()
	return &platformsv1.UpdateGlobalLimitsResponse{Limits: req.GetLimits()}, nil
}

// startServer boots the fake on a real loopback listener and returns its addr.
func startServer(t *testing.T, srv platformsv1.PlatformAdminServiceServer) string {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	gs := grpc.NewServer()
	platformsv1.RegisterPlatformAdminServiceServer(gs, srv)
	go func() { _ = gs.Serve(lis) }()
	t.Cleanup(gs.Stop)
	return lis.Addr().String()
}

func newClient(t *testing.T, fake *fakeServer) *Client {
	t.Helper()
	addr := startServer(t, fake)
	client, err := New(addr, "tok-123")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if client == nil {
		t.Fatal("client is nil with addr+token set")
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

// TestClientListRoundTrip drives Harbor's real client against a live server: it
// proves the dial, the bearer-token interceptor, the include_disabled flag, and
// the proto→Platform mapping (incl. constraint sub-messages) all work over the
// wire — the exact path /api/platforms uses.
func TestClientListRoundTrip(t *testing.T) {
	fake := &fakeServer{}
	client := newClient(t, fake)

	platforms, err := client.List(t.Context(), true)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(platforms) != 2 {
		t.Fatalf("List returned %d, want 2", len(platforms))
	}
	if !fake.gotIncludeDisabled {
		t.Errorf("server saw include_disabled=false, want true")
	}
	x := platforms[0]
	if x.Name != "X" || x.ZernioID != "twitter" || !x.Enabled || !x.ConnectSupported {
		t.Errorf("mapped platform wrong: %+v", x)
	}
	if x.Usage.ConnectedAccounts != 3 || x.Usage.ScheduledPosts != 7 {
		t.Errorf("mapped usage wrong: %+v", x.Usage)
	}
	if x.ImageConstraints == nil || x.ImageConstraints.MaxFileSizeBytes != 5<<20 || len(x.ImageConstraints.AllowedFormats) != 2 {
		t.Errorf("mapped image constraints wrong: %+v", x.ImageConstraints)
	}
	if x.TextConstraints == nil || x.TextConstraints.MaxContentChars != 280 || x.TextConstraints.PerPostType["thread"] != 280 {
		t.Errorf("mapped text constraints wrong: %+v", x.TextConstraints)
	}
	if platforms[1].Name != "TikTok" || platforms[1].Enabled {
		t.Errorf("disabled row mapped wrong: %+v", platforms[1])
	}
	if fake.gotAuth != "Bearer tok-123" {
		t.Errorf("server saw authorization %q, want %q", fake.gotAuth, "Bearer tok-123")
	}
}

// TestClientWrites proves the DTO→proto direction for every write: the full
// resource (incl. constraints) reaches the server on create/update, and the
// enable/delete/global-limits requests carry their fields.
func TestClientWrites(t *testing.T) {
	fake := &fakeServer{}
	client := newClient(t, fake)
	ctx := t.Context()

	in := Platform{
		Name:             "Bluesky",
		ZernioID:         "bluesky",
		Enabled:          false,
		SortOrder:        9,
		PostTypes:        map[string]string{"post": "Post"},
		ImageConstraints: &ImageConstraints{MaxFileSizeBytes: 2 << 20, AllowedFormats: []string{"png"}, MaxAttachmentsPerPost: 4},
		TextConstraints:  &TextConstraints{MaxContentChars: 300},
	}
	created, err := client.Create(ctx, in)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if created.ID != "new-id" {
		t.Errorf("created id = %q, want server-minted new-id", created.ID)
	}
	if fake.lastCreate.GetZernioId() != "bluesky" || fake.lastCreate.GetImageConstraints().GetMaxFileSizeBytes() != 2<<20 {
		t.Errorf("create didn't carry the whole resource: %+v", fake.lastCreate)
	}

	if _, err := client.Update(ctx, Platform{ID: "px", Name: "X", SortOrder: 3}); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if fake.lastUpdate.GetId() != "px" || fake.lastUpdate.GetSortOrder() != 3 {
		t.Errorf("update req wrong: %+v", fake.lastUpdate)
	}

	if _, err := client.SetEnabled(ctx, "px", true); err != nil {
		t.Fatalf("SetEnabled: %v", err)
	}
	if fake.lastEnabledID != "px" || !fake.lastEnabled {
		t.Errorf("SetEnabled req wrong: id=%q enabled=%v", fake.lastEnabledID, fake.lastEnabled)
	}

	if err := client.Delete(ctx, "px", true); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if fake.lastDeleteID != "px" || !fake.lastDeleteForce {
		t.Errorf("Delete req wrong: id=%q force=%v", fake.lastDeleteID, fake.lastDeleteForce)
	}

	got, err := client.GetGlobalLimits(ctx)
	if err != nil {
		t.Fatalf("GetGlobalLimits: %v", err)
	}
	if got.MaxImageUploadBytes != 10<<20 || got.MaxThreadSegments != 25 {
		t.Errorf("global limits mapped wrong: %+v", got)
	}
	if _, err := client.UpdateGlobalLimits(ctx, GlobalLimits{MaxThreadSegments: 30}); err != nil {
		t.Fatalf("UpdateGlobalLimits: %v", err)
	}
	if fake.lastGlobal.GetMaxThreadSegments() != 30 {
		t.Errorf("UpdateGlobalLimits req wrong: %+v", fake.lastGlobal)
	}
}

// TestNewDisabled verifies the fail-open contract: a missing addr or token
// yields a nil client whose methods report ErrUnavailable (never a panic).
func TestNewDisabled(t *testing.T) {
	for _, tc := range []struct{ addr, token string }{
		{"", ""},
		{"", "tok"},
		{"localhost:9091", ""},
	} {
		c, err := New(tc.addr, tc.token)
		if err != nil {
			t.Fatalf("New(%q,%q): unexpected error %v", tc.addr, tc.token, err)
		}
		if c != nil {
			t.Errorf("New(%q,%q) = non-nil, want nil (disabled)", tc.addr, tc.token)
		}
		if _, err := c.List(t.Context(), true); !errors.Is(err, ErrUnavailable) {
			t.Errorf("nil client List err = %v, want ErrUnavailable", err)
		}
		if _, err := c.Create(t.Context(), Platform{}); !errors.Is(err, ErrUnavailable) {
			t.Errorf("nil client Create err = %v, want ErrUnavailable", err)
		}
		if err := c.Delete(t.Context(), "x", false); !errors.Is(err, ErrUnavailable) {
			t.Errorf("nil client Delete err = %v, want ErrUnavailable", err)
		}
	}
}
