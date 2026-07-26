package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	// The "pgx" database/sql driver is registered in database.go.

	"github.com/ogen-app/harbor/src/logging"
)

// EnsureDatabase creates the database named in dsn if it does not already
// exist, so a fresh Postgres server (one not pre-seeded with the database) can
// be pointed at Harbor and boot cleanly. It connects to the server's default
// "postgres" maintenance database using the same credentials, checks
// pg_database, and issues CREATE DATABASE only when the target is missing.
//
// The common case is a no-op: docker-compose's Postgres pre-creates the
// database via POSTGRES_DB, so the target already exists. The value is when
// Harbor is pointed at a bare server where nothing seeded the database yet.
//
// Callers should treat failure as non-fatal and let the subsequent connect +
// ping be the authoritative gate: a role without access to the maintenance
// database or without CREATEDB can still succeed if the target already exists.
func EnsureDatabase(ctx context.Context, dsn string) error {
	u, err := url.Parse(dsn)
	if err != nil {
		// url.Parse returns a *url.Error whose message embeds the raw dsn
		// (credentials and all); unwrap to the bare cause so the logged error
		// carries the reason without the secret.
		var urlErr *url.Error
		if errors.As(err, &urlErr) {
			err = urlErr.Err
		}
		return fmt.Errorf("parse dsn: %w", err)
	}

	dbName := strings.TrimPrefix(u.Path, "/")
	if dbName == "" {
		return errors.New("dsn has no database name")
	}

	// Point a copy of the DSN at the always-present "postgres" maintenance
	// database (preserving credentials and query params like sslmode) so we can
	// create the target from a connection that does not depend on it existing.
	maint := *u
	maint.Path = "/postgres"

	sqldb, err := sql.Open("pgx", maint.String())
	if err != nil {
		return fmt.Errorf("open maintenance connection: %w", err)
	}
	defer sqldb.Close()

	var exists bool
	if err := sqldb.QueryRowContext(ctx,
		"SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)", dbName,
	).Scan(&exists); err != nil {
		return fmt.Errorf("check database %q exists: %w", dbName, err)
	}
	if exists {
		return nil
	}

	// CREATE DATABASE cannot run inside a transaction and cannot parameterize
	// the database name, so quote it safely as an identifier.
	if _, err := sqldb.ExecContext(ctx, "CREATE DATABASE "+pgx.Identifier{dbName}.Sanitize()); err != nil {
		// A concurrently-booting instance may have created it between our check
		// and now; Postgres reports 42P04 (duplicate_database), success for us.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "42P04" {
			return nil
		}
		return fmt.Errorf("create database %q: %w", dbName, err)
	}

	slog.InfoContext(ctx, "created database", logging.AttrComponent, "db.ensure", "database", dbName)
	return nil
}
