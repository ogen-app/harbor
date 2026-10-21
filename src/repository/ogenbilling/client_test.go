package ogenbilling

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/timestamppb"

	billingv1 "github.com/ogen-app/harbor/gen/billing/v1"
)

// fakeServer stands in for Ogen's BillingAdminService: it records the bearer
// token and request fields, and echoes canned data so the proto→DTO mapping is
// exercised over the wire.
type fakeServer struct {
	billingv1.UnimplementedBillingAdminServiceServer
	gotAuth     string
	lastPage    *billingv1.ListBillingAttentionRequest
	lastTenant  string
	lastCutover *billingv1.InvalidateTestSubscriptionsRequest
}

func (s *fakeServer) auth(ctx context.Context) {
	if md, ok := metadata.FromIncomingContext(ctx); ok {
		if v := md.Get("authorization"); len(v) > 0 {
			s.gotAuth = v[0]
		}
	}
}

func (s *fakeServer) GetBillingSettings(ctx context.Context, _ *billingv1.GetBillingSettingsRequest) (*billingv1.GetBillingSettingsResponse, error) {
	s.auth(ctx)
	return &billingv1.GetBillingSettingsResponse{Provider: "lemonsqueezy", TestMode: true, Configured: true, StoreId: "42", TrialTeardownLive: false}, nil
}

func (s *fakeServer) ListBillingAttention(ctx context.Context, req *billingv1.ListBillingAttentionRequest) (*billingv1.ListBillingAttentionResponse, error) {
	s.auth(ctx)
	s.lastPage = req
	return &billingv1.ListBillingAttentionResponse{
		Items: []*billingv1.AttentionItem{
			{
				TenantId:       "t1",
				TenantName:     "Acme",
				Reason:         "expired_never_paid",
				Subscription:   &billingv1.Subscription{Id: "s1", Status: "expired", TierId: "pro", EndsAt: timestamppb.New(time.Unix(5000, 0))},
				Since:          timestamppb.New(time.Unix(4000, 0)),
				TeardownStatus: "dry_run",
			},
			{
				Reason:       "unresolved_webhook",
				WebhookEvent: &billingv1.WebhookEvent{Id: "w1", EventName: "subscription_created", Outcome: "failed"},
			},
		},
		NextPageToken: "50",
	}, nil
}

func (s *fakeServer) GetTenantBilling(ctx context.Context, req *billingv1.GetTenantBillingRequest) (*billingv1.GetTenantBillingResponse, error) {
	s.auth(ctx)
	s.lastTenant = req.GetTenantId()
	return &billingv1.GetTenantBillingResponse{Billing: &billingv1.TenantBilling{
		TenantId:        req.GetTenantId(),
		BillingRequired: true,
		Gated:           false,
		Subscriptions: []*billingv1.Subscription{{
			Id:          "s1",
			Status:      "active",
			TestMode:    true,
			RenewsAt:    timestamppb.New(time.Unix(9000, 0)),
			FirstPaidAt: nil, // never paid
			Duplicate:   true,
		}},
		Owners: []*billingv1.OwnerTrial{{UserId: "u1", Email: "o@example.com", TrialEligible: true}},
	}}, nil
}

func (s *fakeServer) InvalidateTestSubscriptions(ctx context.Context, req *billingv1.InvalidateTestSubscriptionsRequest) (*billingv1.InvalidateTestSubscriptionsResponse, error) {
	s.auth(ctx)
	s.lastCutover = req
	return &billingv1.InvalidateTestSubscriptionsResponse{DryRun: req.GetDryRun()}, nil
}

func newClient(t *testing.T, fake *fakeServer) *Client {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	gs := grpc.NewServer()
	billingv1.RegisterBillingAdminServiceServer(gs, fake)
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
// optional timestamps (unset → nil) and the attention item's optional parts.
func TestClientRoundTrip(t *testing.T) {
	fake := &fakeServer{}
	c := newClient(t, fake)
	ctx := t.Context()

	s, err := c.Settings(ctx)
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if fake.gotAuth != "Bearer tok-123" {
		t.Errorf("auth = %q, want bearer token", fake.gotAuth)
	}
	if s.Provider != "lemonsqueezy" || !s.TestMode || !s.Configured || s.StoreID != "42" || s.TrialTeardownLive {
		t.Errorf("settings = %+v", s)
	}

	page, err := c.Attention(ctx, 25, "cursor")
	if err != nil {
		t.Fatalf("Attention: %v", err)
	}
	if fake.lastPage.GetPageSize() != 25 || fake.lastPage.GetPageToken() != "cursor" {
		t.Errorf("attention request = %+v", fake.lastPage)
	}
	if len(page.Items) != 2 || page.NextPageToken != "50" {
		t.Fatalf("attention page = %+v", page)
	}
	first := page.Items[0]
	if first.Subscription == nil || first.Subscription.TierID != "pro" || first.Subscription.EndsAt == nil || first.TeardownStatus != "dry_run" {
		t.Errorf("first item = %+v", first)
	}
	if first.Subscription.RenewsAt != nil {
		t.Errorf("unset renews_at should map to nil")
	}
	second := page.Items[1]
	if second.Subscription != nil || second.WebhookEvent == nil || second.WebhookEvent.Outcome != "failed" {
		t.Errorf("unresolved webhook item = %+v", second)
	}

	b, err := c.TenantBilling(ctx, "t1")
	if err != nil {
		t.Fatalf("TenantBilling: %v", err)
	}
	if fake.lastTenant != "t1" || !b.BillingRequired || len(b.Subscriptions) != 1 || len(b.Owners) != 1 {
		t.Fatalf("tenant billing = %+v", b)
	}
	if sub := b.Subscriptions[0]; sub.FirstPaidAt != nil || !sub.Duplicate || !sub.TestMode || sub.RenewsAt == nil {
		t.Errorf("subscription = %+v", sub)
	}
	if b.ScheduledChanges == nil || b.RecentWebhookEvents == nil {
		t.Errorf("empty lists must be non-nil so the UI can map over them")
	}

	res, err := c.InvalidateTestSubscriptions(ctx, true)
	if err != nil {
		t.Fatalf("InvalidateTestSubscriptions: %v", err)
	}
	if !fake.lastCutover.GetDryRun() || !res.DryRun || res.TenantIDs == nil {
		t.Errorf("cutover = %+v (req %+v)", res, fake.lastCutover)
	}
}

// A nil client (unconfigured) reports ErrUnavailable from every method.
func TestNilClientUnavailable(t *testing.T) {
	var c *Client
	if _, err := c.Settings(t.Context()); !errors.Is(err, ErrUnavailable) {
		t.Errorf("Settings err = %v", err)
	}
	if _, _, err := c.Resync(t.Context(), "t1"); !errors.Is(err, ErrUnavailable) {
		t.Errorf("Resync err = %v", err)
	}
	if _, err := c.SetFreeTrialTier(t.Context(), "", "off"); !errors.Is(err, ErrUnavailable) {
		t.Errorf("SetFreeTrialTier err = %v", err)
	}
}
