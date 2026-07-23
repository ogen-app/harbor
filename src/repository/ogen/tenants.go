// Package ogen holds the bun-backed data-access layer for the external Ogen
// control-plane pool (tenants, users, social accounts, assets, posts, river
// jobs). One of the three origin-differentiated repository packages, alongside
// harbor and analytics.
//
// Every read is best-effort: the pool may be nil (unconfigured) or unreachable.
// Methods return ErrUnavailable for a nil pool; the caller renders a soft
// "unavailable" state rather than an error.
package ogen

import (
	"context"
	"errors"
	"time"

	"github.com/uptrace/bun"
)

// ErrUnavailable is returned when a method is called on an unconfigured (nil)
// Ogen pool. Callers treat it as "tenants unavailable", not a hard error.
var ErrUnavailable = errors.New("ogen database not configured")

// TenantMetrics is one tenant's identity plus its Ogen-side metric columns
// (user count, connected Zernio/social profiles, R2 storage bytes). AI spend is
// merged separately from the analytics pool.
type TenantMetrics struct {
	ID             string    `bun:"id"`
	Name           string    `bun:"name"`
	Slug           string    `bun:"slug"`
	CreatedAt      time.Time `bun:"created_at"`
	Users          int       `bun:"users"`
	ZernioProfiles int       `bun:"zernio_profiles"`
	R2Bytes        int64     `bun:"r2_bytes"`
}

// Registration is a single tenant creation (UTC day + name), used to build the
// registrations chart's dense series.
type Registration struct {
	Date string `bun:"date"`
	Name string `bun:"name"`
}

// ActivityEvent is one entry in a tenant's recent-activity feed, sourced from
// the Ogen post_logs audit trail. Its JSON shape is served directly.
type ActivityEvent struct {
	At      time.Time `bun:"event_timestamp" json:"at"`
	Type    string    `bun:"event_type"      json:"type"`
	Status  string    `bun:"to_status"       json:"status"`
	Summary string    `bun:"summary"         json:"summary"`
}

// User is one member of a tenant, from the Ogen users table. Its JSON shape is
// served directly to the tenant detail page.
type User struct {
	ID        string    `bun:"id"         json:"id"`
	Name      string    `bun:"name"       json:"name"`
	Email     string    `bun:"email"      json:"email"`
	CreatedAt time.Time `bun:"created_at" json:"createdAt"`
}

// ActivityDay is a single UTC day's activity-event count for a tenant, used to
// build the detail page's 60-day activity chart.
type ActivityDay struct {
	Date  string `bun:"date"`
	Count int    `bun:"count"`
}

// OverviewHeadline is the tenant total plus new-signup counts over recent
// windows, gathered in a single pass over the tenants table.
type OverviewHeadline struct {
	Total  int
	New7d  int
	New30d int
}

type TenantRepository interface {
	// Available reports whether the Ogen pool is configured.
	Available() bool

	// ListMetrics returns identity + metrics for every tenant, oldest first.
	ListMetrics(ctx context.Context) ([]TenantMetrics, error)
	// GetMetrics returns one tenant, or sql.ErrNoRows if the id is unknown.
	GetMetrics(ctx context.Context, id string) (*TenantMetrics, error)
	// Registrations returns tenant creations within the last windowDays days.
	Registrations(ctx context.Context, windowDays int) ([]Registration, error)
	// Activity returns a tenant's most recent post_logs events (newest first).
	Activity(ctx context.Context, tenantID string, limit int) ([]ActivityEvent, error)
	// Users returns a tenant's members (newest first), capped at limit.
	Users(ctx context.Context, tenantID string, limit int) ([]User, error)
	// ActivitySeries returns per-day activity-event counts within the last
	// windowDays days (sparse — only days with events).
	ActivitySeries(ctx context.Context, tenantID string, windowDays int) ([]ActivityDay, error)

	// ── overview aggregates ──────────────────────────────────────────────
	Headline(ctx context.Context) (OverviewHeadline, error)
	ActivePulse7d(ctx context.Context) (int, error)
	FailedPublishes24h(ctx context.Context) (int, error)
	BrokenSocial(ctx context.Context) (int, error)
	StuckRiverJobs(ctx context.Context) (int, error)
	// TenantNames maps every tenant id to its display name.
	TenantNames(ctx context.Context) (map[string]string, error)
}

type tenantRepository struct{ db *bun.DB }

func NewTenantRepository(db *bun.DB) TenantRepository { return &tenantRepository{db: db} }

func (r *tenantRepository) Available() bool { return r.db != nil }

// metricsSelect is the shared identity + per-tenant metric projection. Correlated
// subqueries keep it a single round trip and avoid fan-out from LEFT JOINs
// multiplying rows. Callers append their own WHERE/ORDER BY.
const metricsSelect = `
	SELECT
		t.id, t.name, t.slug, t.created_at,
		(SELECT count(*) FROM users u
			WHERE u.tenant_id = t.id) AS users,
		(SELECT count(*) FROM social_accounts sa
			WHERE sa.tenant_id = t.id AND sa.is_active = true AND sa.deleted_at IS NULL) AS zernio_profiles,
		(SELECT COALESCE(sum(af.size_bytes), 0) FROM asset_files af
			WHERE af.tenant_id = t.id) AS r2_bytes
	FROM tenants t`

func (r *tenantRepository) ListMetrics(ctx context.Context) ([]TenantMetrics, error) {
	if r.db == nil {
		return nil, ErrUnavailable
	}
	var rows []TenantMetrics
	if err := r.db.NewRaw(metricsSelect+` ORDER BY t.created_at`).Scan(ctx, &rows); err != nil {
		return nil, err
	}
	return rows, nil
}

func (r *tenantRepository) GetMetrics(ctx context.Context, id string) (*TenantMetrics, error) {
	if r.db == nil {
		return nil, ErrUnavailable
	}
	m := new(TenantMetrics)
	if err := r.db.NewRaw(metricsSelect+` WHERE t.id = ?`, id).Scan(ctx, m); err != nil {
		return nil, err
	}
	return m, nil
}

func (r *tenantRepository) Registrations(ctx context.Context, windowDays int) ([]Registration, error) {
	if r.db == nil {
		return nil, ErrUnavailable
	}
	var rows []Registration
	err := r.db.NewRaw(`
		SELECT to_char((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS date, name
		FROM tenants
		WHERE (created_at AT TIME ZONE 'UTC')::date >= (now() AT TIME ZONE 'UTC')::date - ?
		ORDER BY created_at`, windowDays-1).Scan(ctx, &rows)
	if err != nil {
		return nil, err
	}
	return rows, nil
}

func (r *tenantRepository) Activity(ctx context.Context, tenantID string, limit int) ([]ActivityEvent, error) {
	if r.db == nil {
		return nil, ErrUnavailable
	}
	var events []ActivityEvent
	err := r.db.NewRaw(`
		SELECT
			event_timestamp,
			event_type,
			COALESCE(to_status, '') AS to_status,
			COALESCE(summary, '')   AS summary
		FROM post_logs
		WHERE tenant_id = ?
		ORDER BY event_timestamp DESC
		LIMIT ?`, tenantID, limit).Scan(ctx, &events)
	if err != nil {
		return nil, err
	}
	return events, nil
}

func (r *tenantRepository) Users(ctx context.Context, tenantID string, limit int) ([]User, error) {
	if r.db == nil {
		return nil, ErrUnavailable
	}
	var users []User
	err := r.db.NewRaw(`
		SELECT id, COALESCE(name, '') AS name, COALESCE(email, '') AS email, created_at
		FROM users
		WHERE tenant_id = ?
		ORDER BY created_at DESC
		LIMIT ?`, tenantID, limit).Scan(ctx, &users)
	if err != nil {
		return nil, err
	}
	return users, nil
}

func (r *tenantRepository) ActivitySeries(ctx context.Context, tenantID string, windowDays int) ([]ActivityDay, error) {
	if r.db == nil {
		return nil, ErrUnavailable
	}
	var days []ActivityDay
	err := r.db.NewRaw(`
		SELECT to_char((event_timestamp AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS date, count(*) AS count
		FROM post_logs
		WHERE tenant_id = ?
		  AND (event_timestamp AT TIME ZONE 'UTC')::date >= (now() AT TIME ZONE 'UTC')::date - ?
		GROUP BY date
		ORDER BY date`, tenantID, windowDays-1).Scan(ctx, &days)
	if err != nil {
		return nil, err
	}
	return days, nil
}

func (r *tenantRepository) Headline(ctx context.Context) (OverviewHeadline, error) {
	var h OverviewHeadline
	if r.db == nil {
		return h, ErrUnavailable
	}
	err := r.db.NewRaw(`
		SELECT
			count(*),
			count(*) FILTER (WHERE created_at >= now() - interval '7 days'),
			count(*) FILTER (WHERE created_at >= now() - interval '30 days')
		FROM tenants`).Scan(ctx, &h.Total, &h.New7d, &h.New30d)
	return h, err
}

func (r *tenantRepository) ActivePulse7d(ctx context.Context) (int, error) {
	if r.db == nil {
		return 0, ErrUnavailable
	}
	var n int
	err := r.db.NewRaw(`
		SELECT count(*) FROM (
			SELECT tenant_id FROM posts
			  WHERE published_at >= now() - interval '7 days'
			     OR created_at   >= now() - interval '7 days'
			UNION
			SELECT tenant_id FROM assets
			  WHERE created_at >= now() - interval '7 days'
		) active`).Scan(ctx, &n)
	return n, err
}

func (r *tenantRepository) FailedPublishes24h(ctx context.Context) (int, error) {
	if r.db == nil {
		return 0, ErrUnavailable
	}
	var n int
	err := r.db.NewRaw(`
		SELECT count(DISTINCT tenant_id) FROM posts
		WHERE failure_reason IS NOT NULL AND failure_reason <> ''
		  AND updated_at >= now() - interval '24 hours'`).Scan(ctx, &n)
	return n, err
}

func (r *tenantRepository) BrokenSocial(ctx context.Context) (int, error) {
	if r.db == nil {
		return 0, ErrUnavailable
	}
	var n int
	err := r.db.NewRaw(`
		SELECT count(DISTINCT tenant_id) FROM social_accounts
		WHERE is_active = false AND deleted_at IS NULL`).Scan(ctx, &n)
	return n, err
}

func (r *tenantRepository) StuckRiverJobs(ctx context.Context) (int, error) {
	if r.db == nil {
		return 0, ErrUnavailable
	}
	var n int
	err := r.db.NewRaw(`
		SELECT count(*) FROM river_job
		WHERE (state = 'available' AND scheduled_at  < now() - interval '15 minutes')
		   OR (state = 'running'   AND attempted_at  < now() - interval '15 minutes')
		   OR (state = 'retryable' AND attempt >= max_attempts)`).Scan(ctx, &n)
	return n, err
}

func (r *tenantRepository) TenantNames(ctx context.Context) (map[string]string, error) {
	if r.db == nil {
		return nil, ErrUnavailable
	}
	var rows []struct {
		ID   string `bun:"id"`
		Name string `bun:"name"`
	}
	if err := r.db.NewRaw(`SELECT id, name FROM tenants`).Scan(ctx, &rows); err != nil {
		return nil, err
	}
	m := make(map[string]string, len(rows))
	for _, row := range rows {
		m[row.ID] = row.Name
	}
	return m, nil
}
