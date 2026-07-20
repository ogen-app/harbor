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

	"github.com/ogen-app/harbor/src/config"
	"github.com/ogen-app/harbor/src/database"
	"github.com/ogen-app/harbor/src/logging"
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

	uiFS, err := ui.Dist()
	if err != nil {
		fatal("load embedded ui", err)
	}

	app, err := server.New(context.Background(), db, cfg, uiFS)
	if err != nil {
		fatal("init server", err)
	}

	slog.Info("server listening", logging.AttrComponent, "boot", "addr", cfg.Addr)
	if err := app.Listen(cfg.Addr); err != nil {
		fatal("server exited", err)
	}
}

// fatal logs an unrecoverable boot error at ERROR level and exits non-zero.
// slog has no Fatal; this is its idiomatic replacement and, like log.Fatal, it
// intentionally skips deferred cleanup — acceptable for a boot failure.
func fatal(msg string, err error) {
	slog.Error(msg, logging.AttrComponent, "boot", logging.AttrError, err)
	os.Exit(1)
}
