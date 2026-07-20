package server

import (
	"database/sql"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/gofiber/fiber/v2"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/uptrace/bun"
	"github.com/uptrace/bun/dialect/pgdialect"

	"github.com/ogen-app/harbor/src/config"
)

// newTestApp builds the app with an in-memory UI tree and a lazily-opened DB
// (never connected — the UI/404 routes under test don't touch it).
func newTestApp(t *testing.T) (*fiber.App, *sql.DB) {
	t.Helper()
	uiFS := fstest.MapFS{
		"index.html":          {Data: []byte("<html>INDEX</html>")},
		"audits.html":         {Data: []byte("<html>AUDITS</html>")},
		"_next/static/app.js": {Data: []byte("console.log('app')")},
	}
	sqldb, err := sql.Open("pgx", "postgres://unused")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	db := bun.NewDB(sqldb, pgdialect.New())

	app, err := New(t.Context(), db, &config.Config{}, uiFS)
	if err != nil {
		t.Fatalf("server.New: %v", err)
	}
	return app, sqldb
}

func TestServeUI(t *testing.T) {
	app, db := newTestApp(t)
	defer db.Close()

	cases := []struct {
		name       string
		path       string
		wantStatus int
		wantBody   string // substring
		wantCache  bool
	}{
		{"root serves index", "/", 200, "INDEX", false},
		{"clean route resolves .html", "/audits", 200, "AUDITS", false},
		{"asset served with immutable cache", "/_next/static/app.js", 200, "console.log", true},
		{"unknown route falls back to index (SPA)", "/does/not/exist", 200, "INDEX", false},
		{"unknown api is JSON 404, not the SPA shell", "/api/nope", 404, "error", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", tc.path, nil)
			resp, err := app.Test(req)
			if err != nil {
				t.Fatalf("Test: %v", err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != tc.wantStatus {
				t.Errorf("status = %d, want %d", resp.StatusCode, tc.wantStatus)
			}
			body, _ := io.ReadAll(resp.Body)
			if !strings.Contains(string(body), tc.wantBody) {
				t.Errorf("body %q does not contain %q", body, tc.wantBody)
			}
			cache := resp.Header.Get("Cache-Control")
			if tc.wantCache && !strings.Contains(cache, "immutable") {
				t.Errorf("expected immutable Cache-Control, got %q", cache)
			}
		})
	}
}
