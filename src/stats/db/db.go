// Package db collects diagnostic Postgres statistics for a database pool. Every
// query is read-only and best-effort: a failed section (permissions, a missing
// extension/table, an unsupported version) is logged at debug and left zero so
// it never fails the whole snapshot.
package db

import (
	"context"
	"log/slog"
	"time"

	"github.com/uptrace/bun"
)

// 2^31 — the transaction-id space before wraparound.
const xidWraparound = 2147483648.0

type Stats struct {
	Connections Connections  `json:"connections"`
	Cache       Cache        `json:"cache"`
	TxID        TxID         `json:"txid"`
	WAL         WAL          `json:"wal"`
	Tables      []TableSize  `json:"tables"`
	Vacuum      []VacuumStat `json:"vacuum"`
	River       *River       `json:"river,omitempty"`
}

// Connections is pg_stat_activity counts for the current database vs the server
// max_connections ceiling.
type Connections struct {
	Active            int `json:"active"`
	Idle              int `json:"idle"`
	IdleInTransaction int `json:"idleInTransaction"`
	Other             int `json:"other"`
	Total             int `json:"total"`
	Max               int `json:"max"`
}

// Cache is the shared-buffer hit ratio from pg_stat_database.
type Cache struct {
	BlksHit  int64   `json:"blksHit"`
	BlksRead int64   `json:"blksRead"`
	HitRatio float64 `json:"hitRatio"` // 0..1
}

// TxID is datfrozenxid age vs the wraparound horizon.
type TxID struct {
	Age           int64   `json:"age"`
	WraparoundPct float64 `json:"wraparoundPct"` // 0..1
}

// WAL is basic write-ahead-log / replication state.
type WAL struct {
	InRecovery bool   `json:"inRecovery"`
	LSN        string `json:"lsn"`
	Replicas   int    `json:"replicas"`
}

// TableSize is one of the largest relations, split into heap / index / TOAST.
type TableSize struct {
	Name       string `bun:"name"        json:"name"`
	TotalBytes int64  `bun:"total_bytes" json:"totalBytes"`
	TableBytes int64  `bun:"table_bytes" json:"tableBytes"`
	IndexBytes int64  `bun:"index_bytes" json:"indexBytes"`
	ToastBytes int64  `bun:"toast_bytes" json:"toastBytes"`
}

// VacuumStat is dead/live tuple counts + last autovacuum for a table.
type VacuumStat struct {
	Name           string     `bun:"name"            json:"name"`
	LiveTup        int64      `bun:"live_tup"        json:"liveTup"`
	DeadTup        int64      `bun:"dead_tup"        json:"deadTup"`
	LastAutovacuum *time.Time `bun:"last_autovacuum" json:"lastAutovacuum"`
}

// River is the river_job queue depth (Ogen database only).
type River struct {
	Available              int    `json:"available"`
	Running                int    `json:"running"`
	Retryable              int    `json:"retryable"`
	Scheduled              int    `json:"scheduled"`
	Completed              int    `json:"completed"`
	Discarded              int    `json:"discarded"`
	Cancelled              int    `json:"cancelled"`
	OldestAvailableSeconds *int64 `json:"oldestAvailableSeconds"`
}

// Probe is a live snapshot of a database pool: connectivity, on-disk size, and
// the diagnostic stats. It keeps all pg introspection queries out of the HTTP
// handlers. A nil pool or any error is reported (never fatal) so the UI can
// render a disconnected state.
type Probe struct {
	Connected bool
	SizeBytes int64
	Stats     *Stats
	Err       string
}

// ProbePool pings the pool and, when reachable, reads the database's on-disk
// size and diagnostic stats. includeRiver adds the river_job queue depth (only
// meaningful for the Ogen database).
func ProbePool(ctx context.Context, db *bun.DB, includeRiver bool) Probe {
	if db == nil {
		return Probe{Err: "not configured"}
	}
	if err := db.PingContext(ctx); err != nil {
		return Probe{Err: err.Error()}
	}
	p := Probe{Connected: true}

	var size int64
	if err := db.NewRaw("SELECT pg_database_size(current_database())").Scan(ctx, &size); err != nil {
		p.Err = "size unavailable: " + err.Error()
		return p
	}
	p.SizeBytes = size
	p.Stats = Collect(ctx, db, includeRiver)
	return p
}

// Collect gathers all sections. includeRiver adds the river_job queue depth
// (only meaningful for the Ogen database).
func Collect(ctx context.Context, db *bun.DB, includeRiver bool) *Stats {
	s := &Stats{}
	collectConnections(ctx, db, &s.Connections)
	collectCache(ctx, db, &s.Cache)
	collectTxID(ctx, db, &s.TxID)
	collectWAL(ctx, db, &s.WAL)
	s.Tables = collectTables(ctx, db)
	s.Vacuum = collectVacuum(ctx, db)
	if includeRiver {
		s.River = collectRiver(ctx, db)
	}
	return s
}

func logFail(section string, err error) {
	if err != nil {
		slog.Debug("dbstats query failed", "component", "dbstats", "section", section, "err", err)
	}
}

func collectConnections(ctx context.Context, db *bun.DB, out *Connections) {
	var rows []struct {
		State string `bun:"state"`
		Count int    `bun:"count"`
	}
	err := db.NewRaw(`
		SELECT COALESCE(state, 'other') AS state, count(*) AS count
		FROM pg_stat_activity
		WHERE datname = current_database()
		GROUP BY state`).Scan(ctx, &rows)
	logFail("connections", err)
	for _, r := range rows {
		out.Total += r.Count
		switch r.State {
		case "active":
			out.Active += r.Count
		case "idle":
			out.Idle += r.Count
		case "idle in transaction", "idle in transaction (aborted)":
			out.IdleInTransaction += r.Count
		default:
			out.Other += r.Count
		}
	}
	logFail("max_connections",
		db.NewRaw(`SELECT setting::int FROM pg_settings WHERE name = 'max_connections'`).Scan(ctx, &out.Max))
}

func collectCache(ctx context.Context, db *bun.DB, out *Cache) {
	err := db.NewRaw(`
		SELECT blks_hit, blks_read
		FROM pg_stat_database WHERE datname = current_database()`).
		Scan(ctx, &out.BlksHit, &out.BlksRead)
	logFail("cache", err)
	if total := out.BlksHit + out.BlksRead; total > 0 {
		out.HitRatio = float64(out.BlksHit) / float64(total)
	}
}

func collectTxID(ctx context.Context, db *bun.DB, out *TxID) {
	err := db.NewRaw(`SELECT age(datfrozenxid) FROM pg_database WHERE datname = current_database()`).
		Scan(ctx, &out.Age)
	logFail("txid", err)
	out.WraparoundPct = float64(out.Age) / xidWraparound
}

func collectWAL(ctx context.Context, db *bun.DB, out *WAL) {
	if err := db.NewRaw(`SELECT pg_is_in_recovery()`).Scan(ctx, &out.InRecovery); err != nil {
		logFail("wal.recovery", err)
		return
	}
	if out.InRecovery {
		logFail("wal.lsn",
			db.NewRaw(`SELECT COALESCE(pg_last_wal_replay_lsn()::text, '')`).Scan(ctx, &out.LSN))
		return
	}
	logFail("wal.lsn",
		db.NewRaw(`SELECT COALESCE(pg_current_wal_lsn()::text, '')`).Scan(ctx, &out.LSN))
	logFail("wal.replicas",
		db.NewRaw(`SELECT count(*) FROM pg_stat_replication`).Scan(ctx, &out.Replicas))
}

func collectTables(ctx context.Context, db *bun.DB) []TableSize {
	var out []TableSize
	err := db.NewRaw(`
		SELECT
			n.nspname || '.' || c.relname AS name,
			pg_total_relation_size(c.oid)  AS total_bytes,
			pg_relation_size(c.oid)        AS table_bytes,
			pg_indexes_size(c.oid)         AS index_bytes,
			CASE WHEN c.reltoastrelid <> 0
				THEN pg_total_relation_size(c.reltoastrelid) ELSE 0 END AS toast_bytes
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE c.relkind IN ('r', 'p')
		  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
		ORDER BY pg_total_relation_size(c.oid) DESC
		LIMIT 10`).Scan(ctx, &out)
	logFail("tables", err)
	return out
}

func collectVacuum(ctx context.Context, db *bun.DB) []VacuumStat {
	var out []VacuumStat
	err := db.NewRaw(`
		SELECT
			schemaname || '.' || relname AS name,
			n_live_tup AS live_tup,
			n_dead_tup AS dead_tup,
			last_autovacuum
		FROM pg_stat_user_tables
		ORDER BY n_dead_tup DESC, n_live_tup DESC
		LIMIT 10`).Scan(ctx, &out)
	logFail("vacuum", err)
	return out
}

func collectRiver(ctx context.Context, db *bun.DB) *River {
	var exists bool
	if err := db.NewRaw(`SELECT to_regclass('public.river_job') IS NOT NULL`).Scan(ctx, &exists); err != nil || !exists {
		logFail("river.exists", err)
		return nil
	}
	r := &River{}
	err := db.NewRaw(`
		SELECT
			count(*) FILTER (WHERE state = 'available'),
			count(*) FILTER (WHERE state = 'running'),
			count(*) FILTER (WHERE state = 'retryable'),
			count(*) FILTER (WHERE state = 'scheduled'),
			count(*) FILTER (WHERE state = 'completed'),
			count(*) FILTER (WHERE state = 'discarded'),
			count(*) FILTER (WHERE state = 'cancelled'),
			EXTRACT(EPOCH FROM (now() - min(scheduled_at) FILTER (WHERE state = 'available')))::bigint
		FROM river_job`).
		Scan(ctx, &r.Available, &r.Running, &r.Retryable, &r.Scheduled, &r.Completed, &r.Discarded, &r.Cancelled, &r.OldestAvailableSeconds)
	if err != nil {
		logFail("river", err)
		return nil
	}
	return r
}
