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
	lastCutover *billingv1.InvalidateSubscriptionsRequest
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
	return &billingv1.GetBillingSettingsResponse{Provider: "polar", TestMode: true, Configured: true, OrganizationId: "org_42", ApiVersion: "2026-10", TrialTeardownLive: false}, nil
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
			Id:                 "s1",
			Status:             "active",
			ProviderStatus:     "active",
			ProviderProductId:  "prod_pro",
			PendingProductId:   "prod_lite",
			PendingEffectiveAt: timestamppb.New(time.Unix(9000, 0)),
			CancelAtPeriodEnd:  true,
			TestMode:           true,
			RenewsAt:           timestamppb.New(time.Unix(9000, 0)),
			FirstPaidAt:        nil, // never paid
			Duplicate:          true,
		}},
		Owners: []*billingv1.OwnerTrial{{UserId: "u1", Email: "o@example.com", TrialEligible: true}},
	}}, nil
}

func (s *fakeServer) InvalidateSubscriptions(ctx context.Context, req *billingv1.InvalidateSubscriptionsRequest) (*billingv1.InvalidateSubscriptionsResponse, error) {
	s.auth(ctx)
	s.lastCutover = req
	return &billingv1.InvalidateSubscriptionsResponse{DryRun: req.GetDryRun()}, nil
}

// ListPayments answers one converted USD payment and one EUR payment still
// waiting for its ECB rate (every *_usd unset).
func (s *fakeServer) ListPayments(ctx context.Context, _ *billingv1.ListPaymentsRequest) (*billingv1.ListPaymentsResponse, error) {
	s.auth(ctx)
	return &billingv1.ListPaymentsResponse{Payments: []*billingv1.Payment{
		{
			Id: "pay1", Provider: "polar", Kind: "order", Currency: "EUR", Total: 5000, ProviderProductId: "prod_pro",
			SubtotalUsd: new(int64(5400)), TotalUsd: new(int64(5400)), FeeUsd: new(int64(0)),
			FxRate: "1.08", FxSource: "ecb", FxDate: "2026-11-25",
		},
		{Id: "pay2", Provider: "polar", Kind: "order", Currency: "EUR", Total: 5000},
	}}, nil
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
	if s.Provider != "polar" || !s.TestMode || !s.Configured || s.OrganizationID != "org_42" || s.APIVersion != "2026-10" || s.TrialTeardownLive {
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
	if sub := b.Subscriptions[0]; sub.ProviderProductID != "prod_pro" || sub.ProviderStatus != "active" || sub.PendingProductID != "prod_lite" ||
		sub.PendingEffectiveAt == nil || !sub.CancelAtPeriodEnd {
		t.Errorf("subscription pending change = %+v", sub)
	}
	if b.ScheduledChanges == nil || b.RecentWebhookEvents == nil {
		t.Errorf("empty lists must be non-nil so the UI can map over them")
	}

	res, err := c.InvalidateSubscriptions(ctx, true, ScopeProviderSwitch)
	if err != nil {
		t.Fatalf("InvalidateSubscriptions: %v", err)
	}
	if !fake.lastCutover.GetDryRun() || !res.DryRun || res.TenantIDs == nil ||
		fake.lastCutover.GetScope() != billingv1.InvalidationScope_INVALIDATION_SCOPE_PROVIDER_SWITCH {
		t.Errorf("cutover = %+v (req %+v)", res, fake.lastCutover)
	}
	if _, err := c.InvalidateSubscriptions(ctx, true, ScopeModeCutover); err != nil {
		t.Fatalf("InvalidateSubscriptions: %v", err)
	}
	if got := fake.lastCutover.GetScope(); got != billingv1.InvalidationScope_INVALIDATION_SCOPE_MODE_CUTOVER {
		t.Errorf("mode cutover scope = %v", got)
	}
	if _, err := c.InvalidateSubscriptions(ctx, true, "everything"); err != nil {
		t.Fatalf("InvalidateSubscriptions: %v", err)
	}
	if got := fake.lastCutover.GetScope(); got != billingv1.InvalidationScope_INVALIDATION_SCOPE_UNSPECIFIED {
		t.Errorf("unknown scope = %v, want UNSPECIFIED (Ogen refuses it)", got)
	}
}

// Unset *_usd amounts stay nil, so the ledger can tell "not converted yet" from
// a real 0; the FX fields pass through.
func TestListPaymentsOptionalUSD(t *testing.T) {
	c := newClient(t, &fakeServer{})
	page, err := c.ListPayments(t.Context(), time.Time{}, time.Time{}, true, 0, "")
	if err != nil {
		t.Fatalf("ListPayments: %v", err)
	}
	if len(page.Payments) != 2 {
		t.Fatalf("payments = %+v", page.Payments)
	}
	conv, waiting := page.Payments[0], page.Payments[1]
	if conv.TotalUSD == nil || *conv.TotalUSD != 5400 || conv.FeeUSD == nil || *conv.FeeUSD != 0 || conv.TaxUSD != nil {
		t.Errorf("converted payment USD = %+v", conv)
	}
	if conv.FxRate != "1.08" || conv.FxSource != "ecb" || conv.FxDate != "2026-11-25" || conv.ProviderProductID != "prod_pro" {
		t.Errorf("converted payment FX = %+v", conv)
	}
	if waiting.TotalUSD != nil || waiting.SubtotalUSD != nil || waiting.FeeUSD != nil || waiting.FxSource != "" {
		t.Errorf("waiting payment = %+v, want every USD amount nil", waiting)
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
	if _, err := c.ProductMappings(t.Context(), true); !errors.Is(err, ErrUnavailable) {
		t.Errorf("ProductMappings err = %v", err)
	}
	if _, err := c.SetProductMapping(t.Context(), "p1", true, "", "unmap"); !errors.Is(err, ErrUnavailable) {
		t.Errorf("SetProductMapping err = %v", err)
	}
	if _, err := c.InvalidateSubscriptions(t.Context(), true, ScopeProviderSwitch); !errors.Is(err, ErrUnavailable) {
		t.Errorf("InvalidateSubscriptions err = %v", err)
	}
}

// productServer answers the product-mapping RPCs (CON-404, renamed in CON-523)
// and records the modes and the write it was sent.
type productServer struct {
	billingv1.UnimplementedBillingAdminServiceServer
	modes   []bool
	lastSet *billingv1.SetProductMappingRequest
}

func (s *productServer) ListProviderProducts(_ context.Context, req *billingv1.ListProviderProductsRequest) (*billingv1.ListProviderProductsResponse, error) {
	s.modes = append(s.modes, req.GetTestMode())
	return &billingv1.ListProviderProductsResponse{Products: []*billingv1.ProviderProduct{
		{Id: "prod_max_y", Name: "Max yearly", Interval: "year", IntervalCount: 1, Archived: true, TestMode: true,
			Prices: []*billingv1.ProductPrice{{Currency: "EUR", AmountMinor: 100000}}},
		{Id: "prod_pro_m", Name: "Pro monthly", Interval: "month", IntervalCount: 1, HasFreeTrial: true, TrialInterval: "month", TrialIntervalCount: 1,
			Prices:         []*billingv1.ProductPrice{{Currency: "EUR", AmountMinor: 5000}, {Currency: "USD", AmountMinor: 5500}},
			MappedPriceIds: []string{"p1", "p3"}},
	}}, nil
}

func (s *productServer) ListProductMappings(_ context.Context, req *billingv1.ListProductMappingsRequest) (*billingv1.ListProductMappingsResponse, error) {
	s.modes = append(s.modes, req.GetTestMode())
	return &billingv1.ListProductMappingsResponse{TestMode: req.GetTestMode(), Checked: true, Mappings: []*billingv1.ProductMapping{
		{
			TierVersionPriceId: "p1", TierName: "Pro", TierVersion: 2, Interval: "month", NetMinor: 5000, Currency: "EUR", FreeTrialTier: true,
			ProductId: "prod_pro_m", Product: &billingv1.ProviderProduct{Id: "prod_pro_m"}, Status: "ok",
			UpdatedAt: timestamppb.New(time.Unix(7000, 0)), UpdatedBy: "harbor",
		},
		{TierVersionPriceId: "p2", TierName: "Max", TierVersion: 1, Interval: "year", NetMinor: 100000, Currency: "EUR", Status: "unmapped", Message: "Not mapped"},
	}}, nil
}

func (s *productServer) SetProductMapping(_ context.Context, req *billingv1.SetProductMappingRequest) (*billingv1.SetProductMappingResponse, error) {
	s.lastSet = req
	return &billingv1.SetProductMappingResponse{Mapping: &billingv1.ProductMapping{TierVersionPriceId: req.GetTierVersionPriceId(), ProductId: req.GetProductId(), Status: "ok"}}, nil
}

func (s *productServer) SuggestProductMappings(_ context.Context, req *billingv1.SuggestProductMappingsRequest) (*billingv1.SuggestProductMappingsResponse, error) {
	s.modes = append(s.modes, req.GetTestMode())
	return &billingv1.SuggestProductMappingsResponse{Suggestions: []*billingv1.ProductSuggestion{
		{TierVersionPriceId: "p2", Product: &billingv1.ProviderProduct{Id: "prod_max_y", Interval: "year"}},
	}}, nil
}

// TestProductMappingRoundTrip covers the four product-mapping RPCs: the mode is
// passed through, an unmapped row has no product and no updated_at, a product's
// prices and mapped rows come through per currency, and a write carries the
// price, mode, product and reason.
func TestProductMappingRoundTrip(t *testing.T) {
	fake := &productServer{}
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

	list, err := c.ProductMappings(ctx, false)
	if err != nil {
		t.Fatalf("ProductMappings: %v", err)
	}
	if list.TestMode || !list.Checked || len(list.Mappings) != 2 {
		t.Fatalf("list = %+v", list)
	}
	mapped, unmapped := list.Mappings[0], list.Mappings[1]
	if mapped.Product == nil || mapped.Product.ID != "prod_pro_m" || mapped.UpdatedAt == nil || !mapped.FreeTrialTier || mapped.TierVersion != 2 {
		t.Errorf("mapped row = %+v", mapped)
	}
	if unmapped.Product != nil || unmapped.UpdatedAt != nil || unmapped.Status != "unmapped" || unmapped.Message == "" {
		t.Errorf("unmapped row = %+v", unmapped)
	}

	products, err := c.ProviderProducts(ctx, true)
	if err != nil {
		t.Fatalf("ProviderProducts: %v", err)
	}
	if len(products) != 2 {
		t.Fatalf("products = %+v", products)
	}
	archived, pro := products[0], products[1]
	if !archived.Archived || archived.MappedPriceIDs == nil || len(archived.Prices) != 1 || archived.Prices[0].AmountMinor != 100000 {
		t.Errorf("archived product = %+v", archived)
	}
	wantPrices := []ProductPrice{{Currency: "EUR", AmountMinor: 5000}, {Currency: "USD", AmountMinor: 5500}}
	if !slices.Equal(pro.Prices, wantPrices) || !slices.Equal(pro.MappedPriceIDs, []string{"p1", "p3"}) || pro.TrialIntervalCount != 1 || pro.IntervalCount != 1 {
		t.Errorf("pro product = %+v", pro)
	}

	sugg, err := c.SuggestProductMappings(ctx, true)
	if err != nil {
		t.Fatalf("SuggestProductMappings: %v", err)
	}
	if len(sugg) != 1 || sugg[0].TierVersionPriceID != "p2" || sugg[0].Product.ID != "prod_max_y" {
		t.Errorf("suggestions = %+v", sugg)
	}
	if !slices.Equal(fake.modes, []bool{false, true, true}) {
		t.Errorf("modes sent = %v, want [false true true]", fake.modes)
	}

	m, err := c.SetProductMapping(ctx, "p2", true, "prod_max_y", "created in the sandbox")
	if err != nil {
		t.Fatalf("SetProductMapping: %v", err)
	}
	if got := fake.lastSet; got.GetTierVersionPriceId() != "p2" || !got.GetTestMode() || got.GetProductId() != "prod_max_y" || got.GetReason() != "created in the sandbox" {
		t.Errorf("SetProductMapping request = %+v", got)
	}
	if m.Status != "ok" || m.ProductID != "prod_max_y" {
		t.Errorf("mapping = %+v", m)
	}
}
