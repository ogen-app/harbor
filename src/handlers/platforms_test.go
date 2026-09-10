package handlers

import (
	"encoding/json"
	"io"
	"net"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"

	"github.com/ogen-app/harbor/src/repository/ogenplatforms"
)

// A nil *ogenplatforms.Client models an unconfigured platform-admin service; its
// methods are nil-safe and return ErrUnavailable, which the List handler must
// translate into a soft state (200 + available:false + []) so the page renders
// gracefully rather than erroring.
func TestPlatforms_ListSoftUnavailable(t *testing.T) {
	app := fiber.New()
	NewPlatformsHandler(nil).Register(app, passAuth)

	resp, err := app.Test(httptest.NewRequest("GET", "/api/platforms", nil))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if resp.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d, want 200 (soft unavailable)", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	var got struct {
		Available bool  `json:"available"`
		Platforms []any `json:"platforms"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode: %v (body=%s)", err, body)
	}
	if got.Available {
		t.Errorf("available = true, want false when client is nil")
	}
	if got.Platforms == nil {
		t.Errorf("platforms = null, want [] so the UI can map over it")
	}
}

// GET /global-limits must degrade softly too (200 + available:false) when the
// client is unconfigured, so the panel renders gracefully.
func TestPlatforms_GlobalLimitsSoftUnavailable(t *testing.T) {
	app := fiber.New()
	NewPlatformsHandler(nil).Register(app, passAuth)

	resp, err := app.Test(httptest.NewRequest("GET", "/api/platforms/global-limits", nil))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if resp.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d, want 200 (soft unavailable)", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	var got struct {
		Available bool `json:"available"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode: %v (body=%s)", err, body)
	}
	if got.Available {
		t.Errorf("available = true, want false when client is nil")
	}
}

// A configured-but-unreachable client (valid addr+token, Ogen down) must also
// degrade softly: the reads map the gRPC Unavailable to 200 + available:false
// rather than a 500. This exercises the real client's lazy dial + the handler's
// isPlatformsUnavailable classification, not just the nil-client path.
func TestPlatforms_UnreachableIsSoftUnavailable(t *testing.T) {
	// Bind then immediately release a loopback port so nothing is listening on
	// it — a deterministic "Ogen is down" address.
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := lis.Addr().String()
	_ = lis.Close()

	client, err := ogenplatforms.New(addr, "tok")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	app := fiber.New()
	NewPlatformsHandler(client).Register(app, passAuth)

	for _, path := range []string{"/api/platforms", "/api/platforms/global-limits"} {
		// Timeout must exceed the client's 10s RPC timeout in case the dial is
		// slow; a refused connection is normally fail-fast (sub-second).
		resp, err := app.Test(httptest.NewRequest("GET", path, nil), 15000)
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if resp.StatusCode != fiber.StatusOK {
			t.Fatalf("%s: status = %d, want 200 (soft unavailable)", path, resp.StatusCode)
		}
		body, _ := io.ReadAll(resp.Body)
		var got struct {
			Available bool `json:"available"`
		}
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatalf("%s decode: %v (body=%s)", path, err, body)
		}
		if got.Available {
			t.Errorf("%s: available = true, want false when Ogen is unreachable", path)
		}
	}
}

// Writes against an unconfigured client are hard 503s (not soft states): the
// operator must know the change didn't land. Covers the create/enable/delete/
// global-limits write paths + the /:id vs /global-limits route ordering.
func TestPlatforms_WritesUnavailableAre503(t *testing.T) {
	app := fiber.New()
	NewPlatformsHandler(nil).Register(app, passAuth)

	cases := []struct {
		method, path, body string
	}{
		{"POST", "/api/platforms", `{"name":"X","zernioId":"x"}`},
		{"PUT", "/api/platforms/px", `{"name":"X"}`},
		{"PUT", "/api/platforms/px/enabled", `{"enabled":true}`},
		{"DELETE", "/api/platforms/px", ""},
		{"PUT", "/api/platforms/global-limits", `{"maxThreadSegments":25}`},
	}
	for _, tc := range cases {
		var bodyReader io.Reader
		if tc.body != "" {
			bodyReader = strings.NewReader(tc.body)
		}
		req := httptest.NewRequest(tc.method, tc.path, bodyReader)
		if tc.body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := app.Test(req)
		if err != nil {
			t.Fatalf("%s %s: %v", tc.method, tc.path, err)
		}
		if resp.StatusCode != fiber.StatusServiceUnavailable {
			t.Errorf("%s %s: status = %d, want 503", tc.method, tc.path, resp.StatusCode)
		}
	}
}
