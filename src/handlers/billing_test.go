package handlers

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	billingv1 "github.com/ogen-app/harbor/gen/billing/v1"
	"github.com/ogen-app/harbor/src/repository/ogenbilling"
)

// fakeBilling is a minimal BillingAdminService: it records the write requests
// and returns canned errors so the handler's error mapping runs over the wire.
type fakeBilling struct {
	billingv1.UnimplementedBillingAdminServiceServer
	lastRequired *billingv1.SetBillingRequiredRequest
	lastTrial    *billingv1.SetFreeTrialTierRequest
	lastComp     *billingv1.SetComplimentaryRequest
	lastProduct  *billingv1.SetProductMappingRequest
	lastCutover  *billingv1.InvalidateSubscriptionsRequest
	cutoverErr   error
}

func (f *fakeBilling) SetBillingRequired(_ context.Context, req *billingv1.SetBillingRequiredRequest) (*billingv1.SetBillingRequiredResponse, error) {
	f.lastRequired = req
	return &billingv1.SetBillingRequiredResponse{Billing: &billingv1.TenantBilling{TenantId: req.GetTenantId(), BillingRequired: req.GetRequired()}}, nil
}

func (f *fakeBilling) SetComplimentary(_ context.Context, req *billingv1.SetComplimentaryRequest) (*billingv1.SetComplimentaryResponse, error) {
	f.lastComp = req
	return &billingv1.SetComplimentaryResponse{Billing: &billingv1.TenantBilling{
		TenantId:        req.GetTenantId(),
		Complimentary:   req.GetComplimentary(),
		BillingRequired: !req.GetComplimentary(),
	}}, nil
}

func (f *fakeBilling) SetFreeTrialTier(_ context.Context, req *billingv1.SetFreeTrialTierRequest) (*billingv1.SetFreeTrialTierResponse, error) {
	f.lastTrial = req
	if req.GetTierId() == "no-trial" {
		return nil, status.Error(codes.FailedPrecondition, "a product of tier no-trial has no one-month trial")
	}
	return &billingv1.SetFreeTrialTierResponse{Offer: &billingv1.FreeTrialTier{TierId: req.GetTierId()}}, nil
}

func (f *fakeBilling) InvalidateSubscriptions(_ context.Context, req *billingv1.InvalidateSubscriptionsRequest) (*billingv1.InvalidateSubscriptionsResponse, error) {
	f.lastCutover = req
	if f.cutoverErr != nil {
		return nil, f.cutoverErr
	}
	return &billingv1.InvalidateSubscriptionsResponse{DryRun: req.GetDryRun(), Count: 1, TenantIds: []string{"t1"}}, nil
}

// The product-mapping RPCs (CON-404, renamed in CON-523): the live mode is
// unreadable (no live access token), and a product priced unlike the row is
// refused.
func (f *fakeBilling) ListProductMappings(_ context.Context, req *billingv1.ListProductMappingsRequest) (*billingv1.ListProductMappingsResponse, error) {
	return &billingv1.ListProductMappingsResponse{TestMode: req.GetTestMode(), Checked: req.GetTestMode(), Mappings: []*billingv1.ProductMapping{
		{TierVersionPriceId: "p1", TierName: "Max", TierVersion: 1, Interval: "year", Status: "unmapped", Message: "Not mapped"},
	}}, nil
}

func (f *fakeBilling) ListProviderProducts(_ context.Context, req *billingv1.ListProviderProductsRequest) (*billingv1.ListProviderProductsResponse, error) {
	if !req.GetTestMode() {
		return nil, status.Error(codes.FailedPrecondition, "cannot read Polar production: set polar_access_token_live in Harbor → Secrets to read production products")
	}
	return &billingv1.ListProviderProductsResponse{Products: []*billingv1.ProviderProduct{{Id: "prod_max_y"}}}, nil
}

func (f *fakeBilling) SuggestProductMappings(_ context.Context, _ *billingv1.SuggestProductMappingsRequest) (*billingv1.SuggestProductMappingsResponse, error) {
	return &billingv1.SuggestProductMappingsResponse{}, nil
}

func (f *fakeBilling) SetProductMapping(_ context.Context, req *billingv1.SetProductMappingRequest) (*billingv1.SetProductMappingResponse, error) {
	f.lastProduct = req
	if req.GetProductId() == "prod_cheap" {
		return nil, status.Error(codes.FailedPrecondition, "Polar product prod_cheap sells €100.00 / month; this price is €120.00 / month.")
	}
	return &billingv1.SetProductMappingResponse{Mapping: &billingv1.ProductMapping{TierVersionPriceId: req.GetTierVersionPriceId(), ProductId: req.GetProductId(), Status: "ok"}}, nil
}

func newBillingApp(t *testing.T, fake *fakeBilling) *fiber.App {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	gs := grpc.NewServer()
	billingv1.RegisterBillingAdminServiceServer(gs, fake)
	go func() { _ = gs.Serve(lis) }()
	t.Cleanup(gs.Stop)

	client, err := ogenbilling.New(lis.Addr().String(), "tok")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	app := fiber.New()
	NewBillingHandler(client, "https://app.example.com/").Register(app, passAuth)
	return app
}

func doJSON(t *testing.T, app *fiber.App, method, path, body string) (int, []byte) {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, r)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := app.Test(req, 15000)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

// The reads degrade softly on an unconfigured client (200 + available:false +
// never-null lists), so the Billing page and the tenant panel render an
// "unavailable" state rather than an error.
func TestBilling_ReadsSoftUnavailable(t *testing.T) {
	app := fiber.New()
	NewBillingHandler(nil, "https://app.example.com/").Register(app, passAuth)

	for _, path := range []string{
		"/api/billing/settings",
		"/api/billing/attention",
		"/api/billing/free-trial-tier",
		"/api/tenants/t1/billing",
		"/api/billing/product-mappings?mode=test",
		"/api/billing/provider-products?mode=live",
		"/api/billing/product-suggestions?mode=test",
	} {
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

	// The share-link origin is reported even when billing is unavailable, with
	// the trailing slash trimmed so the UI can append /signup.
	_, body := doJSON(t, app, "GET", "/api/billing/settings", "")
	if !strings.Contains(string(body), `"appBaseUrl":"https://app.example.com"`) {
		t.Errorf("settings body = %s, want trimmed appBaseUrl", body)
	}
	_, body = doJSON(t, app, "GET", "/api/tenants/t1/billing", "")
	if !strings.Contains(string(body), `"subscriptions":[]`) {
		t.Errorf("tenant billing body = %s, want subscriptions:[]", body)
	}
}

// Writes on an unconfigured client are hard 503s: the operator must know the
// action didn't land.
func TestBilling_WritesUnavailableAre503(t *testing.T) {
	app := fiber.New()
	NewBillingHandler(nil, "").Register(app, passAuth)

	cases := []struct{ method, path, body string }{
		{"PUT", "/api/tenants/t1/billing/required", `{"required":false,"reason":"design partner"}`},
		{"PUT", "/api/tenants/t1/billing/complimentary", `{"complimentary":false,"reason":"beta ended"}`},
		{"POST", "/api/tenants/t1/billing/resync", ""},
		{"PUT", "/api/billing/free-trial-tier", `{"tierId":"pro","reason":"launch"}`},
		{"POST", "/api/billing/cutover", `{"dryRun":true,"scope":"provider_switch"}`},
		{"PUT", "/api/billing/product-mappings/p1", `{"mode":"test","productId":"prod_1","reason":"created"}`},
	}
	for _, tc := range cases {
		if code, _ := doJSON(t, app, tc.method, tc.path, tc.body); code != fiber.StatusServiceUnavailable {
			t.Errorf("%s %s: status = %d, want 503", tc.method, tc.path, code)
		}
	}
}

// A reason is required for the comp/exempt toggle and the free-month tier; a
// blank one is refused before the request reaches Ogen.
func TestBilling_ReasonRequired(t *testing.T) {
	fake := &fakeBilling{}
	app := newBillingApp(t, fake)

	if code, _ := doJSON(t, app, "PUT", "/api/tenants/t1/billing/required", `{"required":false,"reason":"  "}`); code != fiber.StatusBadRequest {
		t.Errorf("required without reason: status = %d, want 400", code)
	}
	if code, _ := doJSON(t, app, "PUT", "/api/billing/free-trial-tier", `{"tierId":""}`); code != fiber.StatusBadRequest {
		t.Errorf("free trial without reason: status = %d, want 400", code)
	}
	if fake.lastRequired != nil || fake.lastTrial != nil {
		t.Errorf("a request reached Ogen without a reason")
	}

	code, body := doJSON(t, app, "PUT", "/api/tenants/t1/billing/required", `{"required":false,"reason":" design partner "}`)
	if code != fiber.StatusOK {
		t.Fatalf("set required: status = %d, body = %s", code, body)
	}
	if got := fake.lastRequired; got.GetTenantId() != "t1" || got.GetRequired() || got.GetReason() != "design partner" {
		t.Errorf("SetBillingRequired got %+v, want t1/false/trimmed reason", got)
	}
}

// Ogen's FailedPrecondition message (a tier product without a trial) reaches
// the UI unchanged as a 409, so the screen can show it as is.
func TestBilling_FailedPreconditionPassesMessage(t *testing.T) {
	fake := &fakeBilling{}
	app := newBillingApp(t, fake)

	code, body := doJSON(t, app, "PUT", "/api/billing/free-trial-tier", `{"tierId":"no-trial","reason":"launch"}`)
	if code != fiber.StatusConflict || !strings.Contains(string(body), "no one-month trial") {
		t.Errorf("ineligible tier: status = %d, body = %s; want 409 with Ogen's message", code, body)
	}

	// An empty tier id turns the offer off and is passed through as such.
	if code, _ := doJSON(t, app, "PUT", "/api/billing/free-trial-tier", `{"tierId":"","reason":"campaign over"}`); code != fiber.StatusOK {
		t.Errorf("turn offer off: status = %d, want 200", code)
	}
	if fake.lastTrial.GetTierId() != "" {
		t.Errorf("tier id = %q, want empty (offer off)", fake.lastTrial.GetTierId())
	}
}

// Ending (or granting) complimentary access needs a reason, passes it trimmed,
// and returns the workspace's billing with the complimentary flag.
func TestBilling_SetComplimentary(t *testing.T) {
	fake := &fakeBilling{}
	app := newBillingApp(t, fake)

	if code, _ := doJSON(t, app, "PUT", "/api/tenants/t1/billing/complimentary", `{"complimentary":false,"reason":""}`); code != fiber.StatusBadRequest {
		t.Errorf("without reason: status = %d, want 400", code)
	}
	if fake.lastComp != nil {
		t.Fatalf("a request reached Ogen without a reason")
	}

	code, body := doJSON(t, app, "PUT", "/api/tenants/t1/billing/complimentary", `{"complimentary":true,"reason":" design partner "}`)
	if code != fiber.StatusOK {
		t.Fatalf("set complimentary: status = %d, body = %s", code, body)
	}
	if got := fake.lastComp; got.GetTenantId() != "t1" || !got.GetComplimentary() || got.GetReason() != "design partner" {
		t.Errorf("SetComplimentary got %+v, want t1/true/trimmed reason", got)
	}
	if !strings.Contains(string(body), `"complimentary":true`) {
		t.Errorf("body = %s, want complimentary:true", body)
	}
}

// The cutover needs an explicit scope, passes it through as the proto enum, and
// a mode cutover refused in sandbox reads as such.
func TestBilling_CutoverScope(t *testing.T) {
	fake := &fakeBilling{}
	app := newBillingApp(t, fake)

	for _, body := range []string{`{"dryRun":true}`, `{"dryRun":true,"scope":""}`, `{"dryRun":true,"scope":"all"}`} {
		if code, _ := doJSON(t, app, "POST", "/api/billing/cutover", body); code != fiber.StatusBadRequest {
			t.Errorf("cutover %s: status = %d, want 400", body, code)
		}
	}
	if fake.lastCutover != nil {
		t.Fatalf("a cutover reached Ogen without a valid scope")
	}

	code, body := doJSON(t, app, "POST", "/api/billing/cutover", `{"dryRun":true,"scope":"provider_switch"}`)
	if code != fiber.StatusOK || !strings.Contains(string(body), `"count":1`) {
		t.Fatalf("provider switch: status = %d, body = %s", code, body)
	}
	if got := fake.lastCutover; !got.GetDryRun() || got.GetScope() != billingv1.InvalidationScope_INVALIDATION_SCOPE_PROVIDER_SWITCH {
		t.Errorf("InvalidateSubscriptions got %+v, want dry run / provider switch", got)
	}

	fake.cutoverErr = status.Error(codes.FailedPrecondition, "billing runs in test mode")
	code, body = doJSON(t, app, "POST", "/api/billing/cutover", `{"dryRun":false,"scope":"mode_cutover"}`)
	if code != fiber.StatusConflict || !strings.Contains(string(body), "sandbox mode") {
		t.Errorf("mode cutover in sandbox: status = %d, body = %s; want 409 naming sandbox", code, body)
	}
	if got := fake.lastCutover.GetScope(); got != billingv1.InvalidationScope_INVALIDATION_SCOPE_MODE_CUTOVER {
		t.Errorf("scope = %v, want MODE_CUTOVER", got)
	}
}

// Product mapping (CON-404, renamed in CON-523): the mode is required and passed through, a reason
// is required, an unreadable mode renders Ogen's message as readable:false, and
// a refused mapping is a 409 with Ogen's message unchanged.
func TestBilling_ProductMapping(t *testing.T) {
	fake := &fakeBilling{}
	app := newBillingApp(t, fake)

	if code, _ := doJSON(t, app, "GET", "/api/billing/product-mappings", ""); code != fiber.StatusBadRequest {
		t.Errorf("no mode: status = %d, want 400", code)
	}
	code, body := doJSON(t, app, "GET", "/api/billing/product-mappings?mode=live", "")
	if code != fiber.StatusOK || !strings.Contains(string(body), `"testMode":false`) || !strings.Contains(string(body), `"checked":false`) || !strings.Contains(string(body), `"tierVersionPriceId":"p1"`) {
		t.Errorf("live mappings: status = %d, body = %s", code, body)
	}

	code, body = doJSON(t, app, "GET", "/api/billing/provider-products?mode=live", "")
	if code != fiber.StatusOK || !strings.Contains(string(body), `"readable":false`) || !strings.Contains(string(body), "polar_access_token_live") || !strings.Contains(string(body), `"products":[]`) {
		t.Errorf("unreadable live products: status = %d, body = %s", code, body)
	}
	code, body = doJSON(t, app, "GET", "/api/billing/provider-products?mode=test", "")
	if code != fiber.StatusOK || !strings.Contains(string(body), `"readable":true`) || !strings.Contains(string(body), `"id":"prod_max_y"`) {
		t.Errorf("test products: status = %d, body = %s", code, body)
	}
	code, body = doJSON(t, app, "GET", "/api/billing/product-suggestions?mode=test", "")
	if code != fiber.StatusOK || !strings.Contains(string(body), `"suggestions":[]`) {
		t.Errorf("suggestions: status = %d, body = %s", code, body)
	}

	if code, _ := doJSON(t, app, "PUT", "/api/billing/product-mappings/p1", `{"mode":"test","productId":"prod_max_y","reason":" "}`); code != fiber.StatusBadRequest {
		t.Errorf("without reason: status = %d, want 400", code)
	}
	if code, _ := doJSON(t, app, "PUT", "/api/billing/product-mappings/p1", `{"productId":"prod_max_y","reason":"x"}`); code != fiber.StatusBadRequest {
		t.Errorf("without mode: status = %d, want 400", code)
	}
	if fake.lastProduct != nil {
		t.Fatalf("a request reached Ogen without a reason or mode")
	}

	code, body = doJSON(t, app, "PUT", "/api/billing/product-mappings/p2", `{"mode":"test","productId":"prod_cheap","reason":"price change"}`)
	if code != fiber.StatusConflict || !strings.Contains(string(body), "sells €100.00 / month") {
		t.Errorf("refused mapping: status = %d, body = %s; want 409 with Ogen's message", code, body)
	}

	code, body = doJSON(t, app, "PUT", "/api/billing/product-mappings/p1", `{"mode":"live","productId":"","reason":" retired "}`)
	if code != fiber.StatusOK {
		t.Fatalf("unmap: status = %d, body = %s", code, body)
	}
	if got := fake.lastProduct; got.GetTierVersionPriceId() != "p1" || got.GetTestMode() || got.GetProductId() != "" || got.GetReason() != "retired" {
		t.Errorf("SetProductMapping got %+v, want p1/live/unmap/trimmed reason", got)
	}
}
