package handlers

import (
	"encoding/json"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
)

// A nil *ogenplans.Client (and nil *ogentenants.Client) models an unconfigured
// plan-admin service; its methods are nil-safe and return ErrUnavailable. The
// matrix read must translate that into a soft state (200 + available:false with
// non-nil empty slices), matching the Platforms/Tiers surfaces.
func TestTierEntitlements_MatrixSoftUnavailable(t *testing.T) {
	app := fiber.New()
	NewTierEntitlementsHandler(nil, nil).Register(app, passAuth)

	resp, err := app.Test(httptest.NewRequest("GET", "/api/tier-entitlements", nil))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if resp.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d, want 200 (soft unavailable)", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	var got struct {
		Available bool              `json:"available"`
		Features  []json.RawMessage `json:"features"`
		Tiers     []json.RawMessage `json:"tiers"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode: %v (body=%s)", err, body)
	}
	if got.Available {
		t.Errorf("available = true, want false when clients are nil")
	}
	if got.Features == nil || got.Tiers == nil {
		t.Errorf("features/tiers = null, want [] so the UI can map over them")
	}
}

// Every mutating route (and the per-tenant read) is a hard dependency on the
// upstream: a nil client must surface as 503, not a soft state — matching the
// Tiers/Platforms write contract.
func TestTierEntitlements_WriteUnavailableIs503(t *testing.T) {
	cases := []struct {
		method, path, body string
	}{
		{"POST", "/api/tier-entitlements/tiers/trial/versions", `{"purchasable":true,"entitlements":{}}`},
		{"PUT", "/api/tier-entitlements/versions/abc", `{"purchasable":true,"entitlements":{}}`},
		{"POST", "/api/tier-entitlements/versions/abc/publish", `{"changeReason":"launch"}`},
		{"POST", "/api/tier-entitlements/versions/abc/retire", ``},
		{"GET", "/api/tier-entitlements/tenants/t1", ``},
		{"PUT", "/api/tier-entitlements/tenants/t1/version", `{"tierVersionId":"v1","reason":"upgrade"}`},
	}
	for _, tc := range cases {
		app := fiber.New()
		NewTierEntitlementsHandler(nil, nil).Register(app, passAuth)

		var body io.Reader
		if tc.body != "" {
			body = strings.NewReader(tc.body)
		}
		req := httptest.NewRequest(tc.method, tc.path, body)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := app.Test(req)
		if err != nil {
			t.Fatalf("%s %s: %v", tc.method, tc.path, err)
		}
		if resp.StatusCode != fiber.StatusServiceUnavailable {
			t.Errorf("%s %s status = %d, want 503", tc.method, tc.path, resp.StatusCode)
		}
	}
}
