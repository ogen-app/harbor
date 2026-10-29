package ogenvendorcost

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	vendorcostv1 "github.com/ogen-app/harbor/gen/vendorcost/v1"
)

type fakeServer struct {
	vendorcostv1.UnimplementedVendorCostServiceServer
	gotAuth string
	last    *vendorcostv1.GetAnthropicCostRequest
	err     error
}

func (s *fakeServer) GetAnthropicCost(ctx context.Context, req *vendorcostv1.GetAnthropicCostRequest) (*vendorcostv1.GetAnthropicCostResponse, error) {
	if md, ok := metadata.FromIncomingContext(ctx); ok && len(md.Get("authorization")) > 0 {
		s.gotAuth = md.Get("authorization")[0]
	}
	s.last = req
	if s.err != nil {
		return nil, s.err
	}
	return &vendorcostv1.GetAnthropicCostResponse{
		Configured: true,
		FetchedAt:  timestamppb.New(time.Date(2026, 10, 29, 6, 0, 0, 0, time.UTC)),
		Costs: []*vendorcostv1.DailyCost{
			{Date: "2026-10-01", Model: "", CostType: "web_search", CostUsdMicros: 1_000_000},
			{Date: "2026-10-01", Model: "claude-sonnet-5", CostType: "tokens", CostUsdMicros: 14_345_679},
		},
	}, nil
}

func dial(t *testing.T, fake *fakeServer) *Client {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	gs := grpc.NewServer()
	vendorcostv1.RegisterVendorCostServiceServer(gs, fake)
	go func() { _ = gs.Serve(lis) }()
	t.Cleanup(gs.Stop)
	c, err := New(lis.Addr().String(), "tok")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func TestAnthropicCostRoundTrip(t *testing.T) {
	fake := &fakeServer{}
	c := dial(t, fake)
	rep, err := c.AnthropicCost(t.Context(), time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC), time.Date(2026, 10, 29, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if fake.gotAuth != "Bearer tok" {
		t.Fatalf("auth = %q", fake.gotAuth)
	}
	if fake.last.GetFromDate() != "2026-09-01" || fake.last.GetToDate() != "2026-10-29" {
		t.Fatalf("range = %s..%s", fake.last.GetFromDate(), fake.last.GetToDate())
	}
	if !rep.Configured || len(rep.Costs) != 2 || rep.Costs[1].USDMicros != 14_345_679 || rep.Costs[0].CostType != "web_search" {
		t.Fatalf("report = %+v", rep)
	}
	if rep.FetchedAt.IsZero() {
		t.Fatal("fetchedAt not set")
	}
}

func TestAnthropicCostKeyRejected(t *testing.T) {
	c := dial(t, &fakeServer{err: status.Error(codes.FailedPrecondition, "use an Admin key")})
	_, err := c.AnthropicCost(t.Context(), time.Now(), time.Now())
	if !errors.Is(err, ErrKeyRejected) {
		t.Fatalf("err = %v, want ErrKeyRejected", err)
	}
}

func TestNilClientUnavailable(t *testing.T) {
	var c *Client
	if _, err := c.AnthropicCost(t.Context(), time.Now(), time.Now()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v", err)
	}
	if c2, err := New("", "tok"); c2 != nil || err != nil {
		t.Fatalf("New without addr = %v, %v", c2, err)
	}
}
