package handlers

import (
	"encoding/json"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
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
