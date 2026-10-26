package ogenbilling

import (
	"context"
	"errors"
	"net"
	"slices"
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
	if _, err := c.VariantMappings(t.Context(), true); !errors.Is(err, ErrUnavailable) {
		t.Errorf("VariantMappings err = %v", err)
	}
	if _, err := c.SetVariantMapping(t.Context(), "p1", true, "", "unmap"); !errors.Is(err, ErrUnavailable) {
		t.Errorf("SetVariantMapping err = %v", err)
	}
}

// variantServer answers the variant-mapping RPCs (CON-404) and records the
// modes and the write it was sent.
type variantServer struct {
	billingv1.UnimplementedBillingAdminServiceServer
	modes   []bool
	lastSet *billingv1.SetVariantMappingRequest
}

func (s *variantServer) ListProviderVariants(_ context.Context, req *billingv1.ListProviderVariantsRequest) (*billingv1.ListProviderVariantsResponse, error) {
	s.modes = append(s.modes, req.GetTestMode())
	return &billingv1.ListProviderVariantsResponse{Variants: []*billingv1.ProviderVariant{
		{Id: "123459", ProductName: "Max", Name: "Yearly", PriceMinor: 100000, Currency: "EUR", Interval: "year", TestMode: true},
		{Id: "123456", ProductName: "Pro", Name: "Monthly", PriceMinor: 5000, Currency: "EUR", Interval: "month", HasFreeTrial: true, TrialInterval: "month", TrialIntervalCount: 1, MappedPriceId: "p1"},
	}}, nil
}

func (s *variantServer) ListVariantMappings(_ context.Context, req *billingv1.ListVariantMappingsRequest) (*billingv1.ListVariantMappingsResponse, error) {
	s.modes = append(s.modes, req.GetTestMode())
	return &billingv1.ListVariantMappingsResponse{TestMode: req.GetTestMode(), Checked: true, Mappings: []*billingv1.VariantMapping{
		{
			TierVersionPriceId: "p1", TierName: "Pro", TierVersion: 2, Interval: "month", NetMinor: 5000, Currency: "EUR", FreeTrialTier: true,
			VariantId: "123456", Variant: &billingv1.ProviderVariant{Id: "123456"}, Status: "ok",
			UpdatedAt: timestamppb.New(time.Unix(7000, 0)), UpdatedBy: "harbor",
		},
		{TierVersionPriceId: "p2", TierName: "Max", TierVersion: 1, Interval: "year", NetMinor: 100000, Currency: "EUR", Status: "unmapped", Message: "Not mapped"},
	}}, nil
}

func (s *variantServer) SetVariantMapping(_ context.Context, req *billingv1.SetVariantMappingRequest) (*billingv1.SetVariantMappingResponse, error) {
	s.lastSet = req
	return &billingv1.SetVariantMappingResponse{Mapping: &billingv1.VariantMapping{TierVersionPriceId: req.GetTierVersionPriceId(), VariantId: req.GetVariantId(), Status: "ok"}}, nil
}

func (s *variantServer) SuggestVariantMappings(_ context.Context, req *billingv1.SuggestVariantMappingsRequest) (*billingv1.SuggestVariantMappingsResponse, error) {
	s.modes = append(s.modes, req.GetTestMode())
	return &billingv1.SuggestVariantMappingsResponse{Suggestions: []*billingv1.VariantSuggestion{
		{TierVersionPriceId: "p2", Variant: &billingv1.ProviderVariant{Id: "123459", Interval: "year"}},
	}}, nil
}

// TestVariantMappingRoundTrip covers the four variant-mapping RPCs: the mode is
// passed through, an unmapped row has no variant and no updated_at, and a write
// carries the price, mode, variant and reason.
func TestVariantMappingRoundTrip(t *testing.T) {
	fake := &variantServer{}
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	gs := grpc.NewServer()
	billingv1.RegisterBillingAdminServiceServer(gs, fake)
	go func() { _ = gs.Serve(lis) }()
	t.Cleanup(gs.Stop)
	c, err := New(lis.Addr().String(), "tok")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	ctx := t.Context()

	list, err := c.VariantMappings(ctx, false)
	if err != nil {
		t.Fatalf("VariantMappings: %v", err)
	}
	if list.TestMode || !list.Checked || len(list.Mappings) != 2 {
		t.Fatalf("list = %+v", list)
	}
	mapped, unmapped := list.Mappings[0], list.Mappings[1]
	if mapped.Variant == nil || mapped.Variant.ID != "123456" || mapped.UpdatedAt == nil || !mapped.FreeTrialTier || mapped.TierVersion != 2 {
		t.Errorf("mapped row = %+v", mapped)
	}
	if unmapped.Variant != nil || unmapped.UpdatedAt != nil || unmapped.Status != "unmapped" || unmapped.Message == "" {
		t.Errorf("unmapped row = %+v", unmapped)
	}

	variants, err := c.ProviderVariants(ctx, true)
	if err != nil {
		t.Fatalf("ProviderVariants: %v", err)
	}
	if len(variants) != 2 || variants[1].MappedPriceID != "p1" || variants[1].TrialIntervalCount != 1 || variants[0].PriceMinor != 100000 {
		t.Errorf("variants = %+v", variants)
	}

	sugg, err := c.SuggestVariantMappings(ctx, true)
	if err != nil {
		t.Fatalf("SuggestVariantMappings: %v", err)
	}
	if len(sugg) != 1 || sugg[0].TierVersionPriceID != "p2" || sugg[0].Variant.ID != "123459" {
		t.Errorf("suggestions = %+v", sugg)
	}
	if !slices.Equal(fake.modes, []bool{false, true, true}) {
		t.Errorf("modes sent = %v, want [false true true]", fake.modes)
	}

	m, err := c.SetVariantMapping(ctx, "p2", true, "123459", "created in the test store")
	if err != nil {
		t.Fatalf("SetVariantMapping: %v", err)
	}
	if got := fake.lastSet; got.GetTierVersionPriceId() != "p2" || !got.GetTestMode() || got.GetVariantId() != "123459" || got.GetReason() != "created in the test store" {
		t.Errorf("SetVariantMapping request = %+v", got)
	}
	if m.Status != "ok" || m.VariantID != "123459" {
		t.Errorf("mapping = %+v", m)
	}
}
