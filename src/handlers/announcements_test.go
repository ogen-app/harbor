package handlers

import (
	"encoding/json"
	"io"
	"net"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"

	"github.com/ogen-app/harbor/src/repository/ogenannouncements"
)

// A nil *ogenannouncements.Client models an unconfigured announcement-admin
// service; its methods are nil-safe and return ErrUnavailable, which the List
// handler must translate into a soft state (200 + available:false + []) so the
// page renders gracefully rather than erroring.
func TestAnnouncements_ListSoftUnavailable(t *testing.T) {
	app := fiber.New()
	NewAnnouncementsHandler(nil).Register(app, passAuth)

	resp, err := app.Test(httptest.NewRequest("GET", "/api/announcements", nil))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if resp.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d, want 200 (soft unavailable)", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	var got struct {
		Available bool  `json:"available"`
		Items     []any `json:"items"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode: %v (body=%s)", err, body)
	}
	if got.Available {
		t.Errorf("available = true, want false when client is nil")
	}
	if got.Items == nil {
		t.Errorf("items = null, want [] so the UI can map over it")
	}
}

// A configured-but-unreachable client (valid addr+token, Ogen down) must degrade
// softly on the list read too: the gRPC Unavailable maps to 200 + available:false
// rather than a 500. Exercises the real client's lazy dial + the handler's
// isAnnouncementsUnavailable classification, not just the nil-client path.
func TestAnnouncements_UnreachableIsSoftUnavailable(t *testing.T) {
	// Bind then immediately release a loopback port so nothing is listening on it
	// — a deterministic "Ogen is down" address.
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := lis.Addr().String()
	_ = lis.Close()

	client, err := ogenannouncements.New(addr, "tok")
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	app := fiber.New()
	NewAnnouncementsHandler(client).Register(app, passAuth)

	// Timeout must exceed the client's 10s RPC timeout in case the dial is slow;
	// a refused connection is normally fail-fast (sub-second).
	resp, err := app.Test(httptest.NewRequest("GET", "/api/announcements", nil), 15000)
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
		t.Errorf("available = true, want false when Ogen is unreachable")
	}
}

// A javascript:/data: (or otherwise non-http) CTA or image URL is rejected with
// a 400 before the request ever reaches Ogen — defense in depth against a
// stored-XSS URL that downstream views render into an href/src. The scheme check
// runs in parseAnnouncementBody, so a nil client still yields 400 (not 503).
func TestAnnouncements_RejectsUnsafeURLs(t *testing.T) {
	app := fiber.New()
	NewAnnouncementsHandler(nil).Register(app, passAuth)

	cases := []struct {
		name, method, path, body string
	}{
		{
			"create js cta",
			"POST",
			"/api/announcements",
			`{"title":"Hi","body":"There","ctaLabel":"Go","ctaUrl":"javascript:alert(1)"}`,
		},
		{
			"create data image",
			"POST",
			"/api/announcements",
			`{"title":"Hi","body":"There","imageUrl":"data:text/html,<script>"}`,
		},
		{
			"update js cta",
			"PUT",
			"/api/announcements/a1",
			`{"title":"Hi","ctaLabel":"Go","ctaUrl":"javascript:alert(1)"}`,
		},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		req.Header.Set("Content-Type", "application/json")
		resp, err := app.Test(req)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if resp.StatusCode != fiber.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400 (unsafe URL rejected)", tc.name, resp.StatusCode)
		}
	}
}

// Writes and the single-resource read against an unconfigured client are hard
// 503s (not soft states): the operator must know the action didn't land. Covers
// create/update/status/delete + the detail read, and the /:id vs /:id/status
// route ordering.
func TestAnnouncements_WritesUnavailableAre503(t *testing.T) {
	app := fiber.New()
	NewAnnouncementsHandler(nil).Register(app, passAuth)

	cases := []struct {
		method, path, body string
	}{
		{"GET", "/api/announcements/a1", ""},
		{"POST", "/api/announcements", `{"title":"Hi","body":"There"}`},
		{"PUT", "/api/announcements/a1", `{"title":"Hi"}`},
		{"PUT", "/api/announcements/a1/status", `{"status":"published"}`},
		{"DELETE", "/api/announcements/a1", ""},
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
