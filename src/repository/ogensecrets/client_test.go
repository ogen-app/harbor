package ogensecrets

import (
	"context"
	"net"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/timestamppb"

	secretsv1 "github.com/ogen-app/harbor/gen/secrets/v1"
)

// fakeServer is a stand-in for Ogen's SecretsService. It records the bearer
// token it received so the test can assert the client's auth interceptor fires,
// and returns canned metadata so the client's proto→struct mapping is exercised.
type fakeServer struct {
	secretsv1.UnimplementedSecretsServiceServer
	gotAuth   string
	lastSet   string
	lastDel   string
	returnSet bool
}

func (s *fakeServer) auth(ctx context.Context) {
	if md, ok := metadata.FromIncomingContext(ctx); ok {
		if v := md.Get("authorization"); len(v) > 0 {
			s.gotAuth = v[0]
		}
	}
}

func (s *fakeServer) List(ctx context.Context, _ *secretsv1.ListRequest) (*secretsv1.ListResponse, error) {
	s.auth(ctx)
	return &secretsv1.ListResponse{Secrets: []*secretsv1.SecretMetadata{
		{Name: "anthropic_api_key", Set: true, UpdatedAt: timestamppb.New(time.Unix(1000, 0)), Algorithm: "AES-256-GCM", KekVersion: 1, Decryptable: true},
		{Name: "zernio_api_key", Set: false},
	}}, nil
}

func (s *fakeServer) Set(ctx context.Context, req *secretsv1.SetRequest) (*secretsv1.SetResponse, error) {
	s.auth(ctx)
	s.lastSet = req.GetName()
	return &secretsv1.SetResponse{
		Secret:  &secretsv1.SecretMetadata{Name: req.GetName(), Set: true},
		Created: s.returnSet,
	}, nil
}

func (s *fakeServer) Delete(ctx context.Context, req *secretsv1.DeleteRequest) (*secretsv1.DeleteResponse, error) {
	s.auth(ctx)
	s.lastDel = req.GetName()
	return &secretsv1.DeleteResponse{}, nil
}

// startServer boots the fake on a real loopback listener and returns its addr.
func startServer(t *testing.T, srv secretsv1.SecretsServiceServer) string {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	gs := grpc.NewServer()
	secretsv1.RegisterSecretsServiceServer(gs, srv)
	go func() { _ = gs.Serve(lis) }()
	t.Cleanup(gs.Stop)
	return lis.Addr().String()
}

// TestClientRoundTrip drives Harbor's real client against a live server: it
// proves the dial, the bearer-token interceptor, and the proto→SecretMeta
// mapping all work over the wire — the exact path /api/secrets uses.
func TestClientRoundTrip(t *testing.T) {
	fake := &fakeServer{returnSet: true}
	addr := startServer(t, fake)

	client, err := New(addr, "tok-123")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if client == nil {
		t.Fatal("client is nil with addr+token set")
	}
	t.Cleanup(func() { _ = client.Close() })

	ctx := context.Background()

	metas, err := client.List(ctx)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(metas) != 2 {
		t.Fatalf("List returned %d, want 2", len(metas))
	}
	if metas[0].Name != "anthropic_api_key" || !metas[0].Set || !metas[0].Decryptable {
		t.Errorf("mapped metadata wrong: %+v", metas[0])
	}
	// The interceptor must have sent the bearer token.
	if fake.gotAuth != "Bearer tok-123" {
		t.Errorf("server saw authorization %q, want %q", fake.gotAuth, "Bearer tok-123")
	}

	if _, created, err := client.Set(ctx, "gemini_api_key", "v"); err != nil || !created {
		t.Errorf("Set: created=%v err=%v, want created=true nil", created, err)
	}
	if fake.lastSet != "gemini_api_key" {
		t.Errorf("server got Set name %q", fake.lastSet)
	}

	if err := client.Delete(ctx, "gemini_api_key"); err != nil {
		t.Errorf("Delete: %v", err)
	}
	if fake.lastDel != "gemini_api_key" {
		t.Errorf("server got Delete name %q", fake.lastDel)
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
		if _, err := c.List(context.Background()); err != ErrUnavailable {
			t.Errorf("nil client List err = %v, want ErrUnavailable", err)
		}
	}
}
