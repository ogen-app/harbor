// Package jobs runs Harbor's background work (CON-420, the first of it): each
// job ticks on its own interval and runs under a Postgres advisory lock, so
// with several replicas exactly one runs a given job at a time and the others
// skip that tick.
package jobs

import (
	"context"
	"hash/fnv"
	"log/slog"
	"sync"
	"time"

	"github.com/uptrace/bun"

	"github.com/ogen-app/harbor/src/logging"
)

// Job is one periodic task. Run should finish well inside Interval; a tick that
// finds the previous run still going (here or on another replica) is skipped.
type Job struct {
	Name     string
	Interval time.Duration
	Run      func(ctx context.Context) error
}

// Runner owns the job goroutines.
type Runner struct {
	db   *bun.DB
	jobs []Job
	wg   sync.WaitGroup
}

func NewRunner(db *bun.DB, jobs ...Job) *Runner { return &Runner{db: db, jobs: jobs} }

// Start launches every job: once right away, then on each tick, until ctx ends.
func (r *Runner) Start(ctx context.Context) {
	for _, j := range r.jobs {
		r.wg.Go(func() { r.loop(ctx, j) })
	}
}

// Wait blocks until every job goroutine has returned (after ctx ends).
func (r *Runner) Wait() { r.wg.Wait() }

func (r *Runner) loop(ctx context.Context, j Job) {
	t := time.NewTicker(j.Interval)
	defer t.Stop()
	for {
		r.RunOnce(ctx, j)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// RunOnce runs j if it can take the job's advisory lock, and reports whether it
// ran. The lock is session-level on one pooled connection, released after the
// run (or by Postgres if the connection dies).
func (r *Runner) RunOnce(ctx context.Context, j Job) bool {
	log := slog.With(logging.AttrComponent, "jobs", "job", j.Name)
	conn, err := r.db.Conn(ctx)
	if err != nil {
		log.WarnContext(ctx, "job: get connection failed", logging.AttrError, err)
		return false
	}
	defer conn.Close()

	key := lockKey(j.Name)
	var locked bool
	if err := conn.QueryRowContext(ctx, "SELECT pg_try_advisory_lock(?)", key).Scan(&locked); err != nil {
		log.WarnContext(ctx, "job: lock failed", logging.AttrError, err)
		return false
	}
	if !locked {
		log.DebugContext(ctx, "job: held elsewhere; skipping tick")
		return false
	}
	defer func() {
		// A fresh context: the run's may already be cancelled at shutdown.
		if _, err := conn.ExecContext(context.WithoutCancel(ctx), "SELECT pg_advisory_unlock(?)", key); err != nil {
			log.WarnContext(ctx, "job: unlock failed", logging.AttrError, err)
		}
	}()

	start := time.Now()
	if err := j.Run(ctx); err != nil {
		log.WarnContext(ctx, "job failed", "duration_ms", time.Since(start).Milliseconds(), logging.AttrError, err)
		return true
	}
	log.DebugContext(ctx, "job done", "duration_ms", time.Since(start).Milliseconds())
	return true
}

// lockKey maps a job name to a stable advisory-lock key. The "harbor.job."
// prefix keeps it clear of any other advisory locks on the database.
func lockKey(name string) int64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte("harbor.job." + name))
	return int64(h.Sum64())
}
