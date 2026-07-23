// Package server wires the Fiber app: middleware, API handlers, and the
// embedded UI. Mirrors the ../ogen server convention.
package server

import (
	"context"
	"io/fs"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/gofiber/fiber/v2/middleware/requestid"
	"github.com/uptrace/bun"

	"github.com/ogen-app/harbor/src/auth"
	"github.com/ogen-app/harbor/src/config"
	"github.com/ogen-app/harbor/src/handlers"
	"github.com/ogen-app/harbor/src/logging"
	"github.com/ogen-app/harbor/src/repository/analytics"
	"github.com/ogen-app/harbor/src/repository/harbor"
	"github.com/ogen-app/harbor/src/repository/ogen"
)

// New builds the Fiber application. uiFS is the embedded Next.js static export
// (see src/ui); it is served for every route not claimed by an API handler, so
// Harbor runs as a single binary. ogenDB and analyticsDB are pools to Ogen's
// (external) control-plane and analytics databases — either may be nil when
// Ogen is unreachable; they are held for forthcoming Ogen-backed handlers.
func New(_ context.Context, db, ogenDB, analyticsDB *bun.DB, cfg *config.Config, uiFS fs.FS) (*fiber.App, error) {
	app := fiber.New(fiber.Config{
		ErrorHandler: defaultErrorHandler,
	})

	app.Use(recover.New())
	// Per-request correlation id: honours an inbound X-Request-ID, otherwise
	// generates one, echoes it on the response, and stores it under
	// logging.RequestIDKey so the slog ContextHandler attaches it to every line
	// logged with c.Context().
	app.Use(requestid.New(requestid.Config{ContextKey: logging.RequestIDKey}))
	app.Use(accessLog())

	// CORS only when the UI is hosted on a separate origin (see config). The
	// default single-binary / next-dev-proxy setups are same-origin.
	if cfg.CORSAllowedOrigins != "" {
		app.Use(cors.New(cors.Config{
			AllowOrigins:     cfg.CORSAllowedOrigins,
			AllowCredentials: true,
			AllowMethods:     "GET,POST,PUT,PATCH,DELETE,OPTIONS",
			AllowHeaders:     "Content-Type",
		}))
	}

	// ── Repositories (split by origin database) ───────────────────────────
	// Harbor's own pool.
	userRepo := harbor.NewUserRepository(db)
	sessionRepo := harbor.NewSessionRepository(db)
	healthRepo := harbor.NewHealthRepository(db)
	// External Ogen control-plane + analytics pools (may be nil until reachable;
	// the repositories report that as an unavailable state).
	tenantRepo := ogen.NewTenantRepository(ogenDB)
	spendRepo := analytics.NewSpendRepository(analyticsDB)

	requireAuth := handlers.RequireAuth(sessionRepo, cfg.SessionCookieName)

	// A genuinely nil interface when credentials are absent (see GoogleVerifier)
	// so the login endpoint reports "not configured" rather than panicking.
	var verifier handlers.GoogleVerifier
	if v := auth.NewVerifier(cfg.GoogleClientID, cfg.GoogleClientSecret); v != nil {
		verifier = v
	}

	// ── API routes ────────────────────────────────────────────────────────
	handlers.NewHealthHandler(healthRepo).Register(app)
	handlers.NewAuthHandler(
		userRepo, sessionRepo, verifier,
		strings.Split(cfg.AuthAllowedEmails, ","),
		cfg.GoogleClientID, cfg.SessionCookieName,
	).Register(app, requireAuth)
	handlers.NewStatusHandler(ogenDB, analyticsDB).Register(app, requireAuth)
	handlers.NewTenantsHandler(tenantRepo, spendRepo).Register(app, requireAuth)

	// ── Embedded UI ───────────────────────────────────────────────────────
	// Registered last: a catch-all that serves the static export for any route
	// an API handler did not claim (and 404s unknown /api/* as JSON).
	registerUI(app, uiFS)

	return app, nil
}
