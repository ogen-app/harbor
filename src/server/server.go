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
	"github.com/ogen-app/harbor/src/repository"
)

// New builds the Fiber application. uiFS is the embedded Next.js static export
// (see src/ui); it is served for every route not claimed by an API handler, so
// Harbor runs as a single binary.
func New(_ context.Context, db *bun.DB, cfg *config.Config, uiFS fs.FS) (*fiber.App, error) {
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

	// ── Repositories & auth ───────────────────────────────────────────────
	userRepo := repository.NewUserRepository(db)
	sessionRepo := repository.NewSessionRepository(db)
	requireAuth := handlers.RequireAuth(sessionRepo, cfg.SessionCookieName)

	// A genuinely nil interface when credentials are absent (see GoogleVerifier)
	// so the login endpoint reports "not configured" rather than panicking.
	var verifier handlers.GoogleVerifier
	if v := auth.NewVerifier(cfg.GoogleClientID, cfg.GoogleClientSecret); v != nil {
		verifier = v
	}

	// ── API routes ────────────────────────────────────────────────────────
	handlers.NewHealthHandler(db).Register(app)
	handlers.NewAuthHandler(
		userRepo, sessionRepo, verifier,
		strings.Split(cfg.AuthAllowedEmails, ","),
		cfg.GoogleClientID, cfg.SessionCookieName,
	).Register(app, requireAuth)

	// ── Embedded UI ───────────────────────────────────────────────────────
	// Registered last: a catch-all that serves the static export for any route
	// an API handler did not claim (and 404s unknown /api/* as JSON).
	registerUI(app, uiFS)

	return app, nil
}
