package handlers

import (
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
)

// A malformed receipt, email or attachment id is a 404 before any query runs.
func TestPnLUUIDParams(t *testing.T) {
	app := fiber.New()
	app.Get("/r/:id", uuidParams, func(c *fiber.Ctx) error { return c.SendStatus(fiber.StatusOK) })
	app.Get("/r/:id/a/:attId", uuidParams, func(c *fiber.Ctx) error { return c.SendStatus(fiber.StatusOK) })
	const ok = "8c4a6793-53a0-426e-8efb-5f0a07e91779"
	for path, want := range map[string]int{
		"/r/" + ok:              fiber.StatusOK,
		"/r/abc":                fiber.StatusNotFound,
		"/r/" + ok + "/a/" + ok: fiber.StatusOK,
		"/r/" + ok + "/a/x":     fiber.StatusNotFound,
	} {
		resp, err := app.Test(httptest.NewRequest("GET", path, nil))
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != want {
			t.Errorf("%s: status %d, want %d", path, resp.StatusCode, want)
		}
	}
}
