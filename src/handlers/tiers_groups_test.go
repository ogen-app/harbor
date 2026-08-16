package handlers

import (
	"encoding/json"
	"errors"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// A nil *ogentenants.Client models an unconfigured tenant-admin service; its
// methods are nil-safe and return ErrUnavailable, which the handler must
// translate into a soft state on reads and a 503 on writes — matching the
// Secrets surface.
func TestTiersGroups_ListSoftUnavailable(t *testing.T) {
	for _, path := range []string{"/api/tiers", "/api/groups"} {
		app := fiber.New()
		NewTiersGroupsHandler(nil).Register(app, passAuth)

		resp, err := app.Test(httptest.NewRequest("GET", path, nil))
		if err != nil {
			t.Fatalf("%s request: %v", path, err)
		}
		if resp.StatusCode != fiber.StatusOK {
			t.Fatalf("%s status = %d, want 200 (soft unavailable)", path, resp.StatusCode)
		}
		body, _ := io.ReadAll(resp.Body)
		var got struct {
			Available bool  `json:"available"`
			Entries   []any `json:"entries"`
		}
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatalf("%s decode: %v (body=%s)", path, err, body)
		}
		if got.Available {
			t.Errorf("%s available = true, want false when client is nil", path)
		}
		if got.Entries == nil {
			t.Errorf("%s entries = null, want [] so the UI can map over it", path)
		}
	}
}

func TestTiersGroups_WriteUnavailableIs503(t *testing.T) {
	cases := []struct {
		method, path string
	}{
		{"POST", "/api/tiers"},
		{"PUT", "/api/tiers/abc"},
		{"DELETE", "/api/tiers/abc"},
		{"POST", "/api/groups"},
		{"PUT", "/api/groups/abc"},
		{"DELETE", "/api/groups/abc"},
	}
	for _, tc := range cases {
		app := fiber.New()
		NewTiersGroupsHandler(nil).Register(app, passAuth)

		var body io.Reader
		if tc.method != "DELETE" {
			body = strings.NewReader(`{"name":"Pro","color":"#0078d4"}`)
		}
		req := httptest.NewRequest(tc.method, tc.path, body)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := app.Test(req)
		if err != nil {
			t.Fatalf("%s %s request: %v", tc.method, tc.path, err)
		}
		if resp.StatusCode != fiber.StatusServiceUnavailable {
			t.Errorf("%s %s status = %d, want 503", tc.method, tc.path, resp.StatusCode)
		}
	}
}

// The tenant-assignment writes live on TenantsHandler but share the ogentenants
// client; a nil client must likewise degrade to 503.
func TestTenantAssignment_WriteUnavailableIs503(t *testing.T) {
	cases := []struct {
		method, path string
	}{
		{"PUT", "/api/tenants/t1/tier"},
		{"PUT", "/api/tenants/t1/status"},
		{"POST", "/api/tenants/t1/groups/g1"},
		{"DELETE", "/api/tenants/t1/groups/g1"},
	}
	for _, tc := range cases {
		app := fiber.New()
		// Only the admin client is exercised by these routes; the repos are unused.
		NewTenantsHandler(nil, nil, nil, nil).Register(app, passAuth)

		var body io.Reader
		if tc.method == "PUT" {
			body = strings.NewReader(`{"tierId":"x"}`)
		}
		req := httptest.NewRequest(tc.method, tc.path, body)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := app.Test(req)
		if err != nil {
			t.Fatalf("%s %s request: %v", tc.method, tc.path, err)
		}
		if resp.StatusCode != fiber.StatusServiceUnavailable {
			t.Errorf("%s %s status = %d, want 503", tc.method, tc.path, resp.StatusCode)
		}
	}
}

// TestMapTierGroupError pins the gRPC-code → HTTP-status contract.
func TestMapTierGroupError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want int
	}{
		{"already exists", status.Error(codes.AlreadyExists, "dup"), fiber.StatusConflict},
		{"failed precondition", status.Error(codes.FailedPrecondition, "in use"), fiber.StatusConflict},
		{"not found", status.Error(codes.NotFound, "missing"), fiber.StatusNotFound},
		{"invalid argument", status.Error(codes.InvalidArgument, "bad"), fiber.StatusBadRequest},
		{"unauthenticated", status.Error(codes.Unauthenticated, "token"), fiber.StatusBadGateway},
		{"unavailable", status.Error(codes.Unavailable, "down"), fiber.StatusServiceUnavailable},
		{"deadline", status.Error(codes.DeadlineExceeded, "slow"), fiber.StatusServiceUnavailable},
		{"internal", status.Error(codes.Internal, "boom"), fiber.StatusInternalServerError},
	}
	for _, tc := range cases {
		var fe *fiber.Error
		if !errors.As(mapTierGroupError(tc.err, "tier"), &fe) {
			t.Fatalf("%s: mapTierGroupError did not return a *fiber.Error", tc.name)
		}
		if fe.Code != tc.want {
			t.Errorf("%s: code = %d, want %d", tc.name, fe.Code, tc.want)
		}
	}
}
