package handlers

import (
	"encoding/json"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
)

// passAuth is a no-op auth middleware so these tests exercise the handler logic
// without a session (auth itself is covered by auth_test.go).
func passAuth(c *fiber.Ctx) error { return c.Next() }

// A nil *ogensecrets.Client models an unconfigured secrets service; its methods
// are nil-safe and return ErrUnavailable, which the handler must translate into
// a soft state on reads and a 503 on writes.
func TestSecrets_ListSoftUnavailable(t *testing.T) {
	app := fiber.New()
	NewSecretsHandler(nil).Register(app, passAuth)

	resp, err := app.Test(httptest.NewRequest("GET", "/api/secrets", nil))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if resp.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d, want 200 (soft unavailable)", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	var got struct {
		Available bool  `json:"available"`
		Secrets   []any `json:"secrets"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode: %v (body=%s)", err, body)
	}
	if got.Available {
		t.Errorf("available = true, want false when client is nil")
	}
	if got.Secrets == nil {
		t.Errorf("secrets = null, want [] so the UI can map over it")
	}
}

func TestSecrets_PutUnavailableIs503(t *testing.T) {
	app := fiber.New()
	NewSecretsHandler(nil).Register(app, passAuth)

	req := httptest.NewRequest("PUT", "/api/secrets/anthropic_api_key", strings.NewReader(`{"value":"x"}`))
	req.Header.Set("Content-Type", "application/json")
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if resp.StatusCode != fiber.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", resp.StatusCode)
	}
}
