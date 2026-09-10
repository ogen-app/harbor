package handlers

import (
	"encoding/json"
	"io"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
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
