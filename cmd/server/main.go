// Command server is Harbor's entrypoint: it loads config, installs structured
// logging, opens Postgres and runs migrations, then serves the API together
// with the embedded Next.js UI on a single port.
//
// @title           Harbor API
// @version         1.0
// @description     Operating center API for the Ogen application.
// @host            localhost:9002
// @BasePath        /
package main

import (
	"context"
	"log"
	"log/slog"
	"os"

	"github.com/uptrace/bun"

	"github.com/ogen-app/harbor/src/config"
	"github.com/ogen-app/harbor/src/database"
	"github.com/ogen-app/harbor/src/logging"
	"github.com/ogen-app/harbor/src/repository/ogensecrets"
	"github.com/ogen-app/harbor/src/server"
	"github.com/ogen-app/harbor/src/ui"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		// The logger needs cfg to build, so this one boot error necessarily
		// predates it — fail fast on the stdlib logger.
		log.Fatalf("load config: %v", err)
	}

	// Install the structured logger before anything else logs, so even early
	// boot errors are structured and any stray stdlib log.Print is bridged.
	logging.New(cfg)

	// Create Harbor's own database if a bare Postgres server has none yet
	// (docker-compose pre-seeds it via POSTGRES_DB, so this is usually a no-op).
	// Best effort: the New/Ping below is the authoritative gate, so a role that
	// can't reach the maintenance DB still boots when the target already exists.
	if err := database.EnsureDatabase(context.Background(), cfg.DSN); err != nil {
		slog.Warn("ensure database (continuing; will verify on connect)",
			logging.AttrComponent, "boot", logging.AttrError, err)
	}

	db, err := database.New(cfg.DSN, cfg.Debug)
	if err != nil {
		fatal("connect to database", err)
	}
	db.DB.SetMaxOpenConns(cfg.DBMaxOpenConns)
	db.DB.SetMaxIdleConns(cfg.DBMaxIdleConns)
	defer db.Close()

	if err := database.Migrate(context.Background(), db); err != nil {
		fatal("run migrations", err)
	}

	// External databases owned by ../ogen: the control-plane DB (read/write) and
	// the analytics TimescaleDB. Harbor connects but never migrates them. A
	// connect failure is non-fatal (fail-open) so Harbor still serves its own
	// UI/auth when Ogen is unreachable; the pool is nil until reachable.
	ogenDB := connectExternal("ogen", cfg.OgenDSN, cfg.Debug)
	if ogenDB != nil {
		defer ogenDB.Close()
	}
	analyticsDB := connectExternal("ogen-analytics", cfg.AnalyticsDSN, cfg.Debug)
	if analyticsDB != nil {
		defer analyticsDB.Close()
	}

	// gRPC client for Ogen's internal secrets surface. Enabled only when both
	// OGEN_GRPC_ADDR and OGEN_GRPC_TOKEN are set; otherwise the client is nil and
	// the Secrets tab renders "unavailable" (fail-open, never a boot error).
	// grpc.NewClient connects lazily, so this never blocks on Ogen being up.
	secretsClient, err := ogensecrets.New(cfg.OgenGRPCAddr, cfg.OgenGRPCToken)
	if err != nil {
		fatal("init ogen secrets client", err)
	}
	switch {
	case secretsClient != nil:
		defer secretsClient.Close()
		slog.Info("ogen secrets client configured", logging.AttrComponent, "boot", "addr", cfg.OgenGRPCAddr)
	case cfg.OgenGRPCAddr != "" && cfg.OgenGRPCToken == "":
		slog.Warn("ogen secrets client disabled: OGEN_GRPC_ADDR set but OGEN_GRPC_TOKEN empty",
			logging.AttrComponent, "boot")
	default:
		slog.Info("ogen secrets client disabled (OGEN_GRPC_ADDR/OGEN_GRPC_TOKEN unset)", logging.AttrComponent, "boot")
	}

	uiFS, err := ui.Dist()
	if err != nil {
		fatal("load embedded ui", err)
	}

	app, err := server.New(context.Background(), db, ogenDB, analyticsDB, secretsClient, cfg, uiFS)
	if err != nil {
		fatal("init server", err)
	}

	slog.Info("server listening", logging.AttrComponent, "boot", "addr", cfg.Addr)
	if err := app.Listen(cfg.Addr); err != nil {
		fatal("server exited", err)
	}
}

// connectExternal opens a read/write pool to an externally-owned Postgres
// (Ogen's control-plane or analytics DB). It never runs migrations. The pool is
// opened lazily so it persists and reconnects even if the database is down at
// boot — the status endpoint reports live reachability. An empty DSN returns
// nil; a probe failure is logged but non-fatal.
func connectExternal(name, dsn string, debug bool) *bun.DB {
	if dsn == "" {
		slog.Info("external database disabled (empty DSN)", logging.AttrComponent, "boot", "db", name)
		return nil
	}
	db, err := database.Open(dsn, debug)
	if err != nil {
		slog.Warn("external database open failed (continuing)",
			logging.AttrComponent, "boot", "db", name, logging.AttrError, err)
		return nil
	}
	// Probe once for a boot-time signal; the pool persists and reconnects on use.
	if err := db.PingContext(context.Background()); err != nil {
		slog.Warn("external database unreachable at boot (will retry on use)",
			logging.AttrComponent, "boot", "db", name, logging.AttrError, err)
	} else {
		slog.Info("connected to external database", logging.AttrComponent, "boot", "db", name)
	}
	return db
}

// fatal logs an unrecoverable boot error at ERROR level and exits non-zero.
// slog has no Fatal; this is its idiomatic replacement and, like log.Fatal, it
// intentionally skips deferred cleanup — acceptable for a boot failure.
func fatal(msg string, err error) {
	slog.Error(msg, logging.AttrComponent, "boot", logging.AttrError, err)
	os.Exit(1)
}
