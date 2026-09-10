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
// include_disabled flag it was called with, and returns a canned catalog so the
// client's proto→struct mapping is exercised end-to-end.
type fakeServer struct {
	platformsv1.UnimplementedPlatformAdminServiceServer
	gotAuth            string
	gotIncludeDisabled bool
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
			Usage:              &platformsv1.PlatformUsage{ConnectedAccounts: 3, ScheduledPosts: 7},
			UpdatedAt:          timestamppb.New(time.Unix(1000, 0)),
		},
		{Id: "ptt", Name: "TikTok", ZernioId: "tiktok", Enabled: false, SortOrder: 2},
	}}, nil
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

// TestClientListRoundTrip drives Harbor's real client against a live server: it
// proves the dial, the bearer-token interceptor, the include_disabled flag, and
// the proto→Platform mapping all work over the wire — the exact path
// /api/platforms uses.
func TestClientListRoundTrip(t *testing.T) {
	fake := &fakeServer{}
	addr := startServer(t, fake)

	client, err := New(addr, "tok-123")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if client == nil {
		t.Fatal("client is nil with addr+token set")
	}
	t.Cleanup(func() { _ = client.Close() })

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
	if len(x.PostTypes) != 2 || len(x.SupportedPostTypes) != 1 {
		t.Errorf("mapped post types wrong: post_types=%v supported=%v", x.PostTypes, x.SupportedPostTypes)
	}
	if platforms[1].Name != "TikTok" || platforms[1].Enabled {
		t.Errorf("disabled row mapped wrong: %+v", platforms[1])
	}
	// The interceptor must have sent the bearer token.
	if fake.gotAuth != "Bearer tok-123" {
		t.Errorf("server saw authorization %q, want %q", fake.gotAuth, "Bearer tok-123")
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
	}
}
