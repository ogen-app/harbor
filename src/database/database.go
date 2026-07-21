// Package database opens Harbor's Postgres pool via bun and applies embedded SQL
// migrations at boot. Mirrors the ../ogen database convention.
package database

import (
	"database/sql"
	"fmt"

	// Registers the "pgx" database/sql driver. bun runs on the resulting
	// *sql.DB; db.DB exposes the same pool if it ever needs to be shared.
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/uptrace/bun"
	"github.com/uptrace/bun/dialect/pgdialect"
	"github.com/uptrace/bun/extra/bundebug"
)

// Default connection-pool sizing. cmd/server overrides these from config.
const (
	defaultMaxOpenConns = 25
	defaultMaxIdleConns = 5
)

// Open builds a bun Postgres pool via the pgx stdlib driver WITHOUT verifying
// connectivity — sql.Open is lazy, so the pool is usable even while the server
// is unreachable and it reconnects on first use. Use this for externally-owned
// databases whose availability should not block boot.
func Open(dsn string, debug bool) (*bun.DB, error) {
	sqldb, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, fmt.Errorf("open postgres: %w", err)
	}

	sqldb.SetMaxOpenConns(defaultMaxOpenConns)
	sqldb.SetMaxIdleConns(defaultMaxIdleConns)

	db := bun.NewDB(sqldb, pgdialect.New())

	if debug {
		db.AddQueryHook(bundebug.NewQueryHook(bundebug.WithVerbose(true)))
	}

	return db, nil
}

// New opens the pool (see Open) and pings it, so a connection failure surfaces
// at boot. Used for Harbor's own database.
func New(dsn string, debug bool) (*bun.DB, error) {
	db, err := Open(dsn, debug)
	if err != nil {
		return nil, err
	}
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return db, nil
}
