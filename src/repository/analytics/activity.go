package analytics

import (
	"context"
	"time"

	"github.com/uptrace/bun"
)

// ActivityEvent is one entry in a tenant's recent-activity feed, sourced from
// the centralised activity_events hypertable in the analytics DB (Ogen CON-125,
// which superseded the control-plane post_logs audit trail). Its JSON shape is
// served directly to the tenant detail page and the Tenants-table expanded row.
type ActivityEvent struct {
	At       time.Time `bun:"occurred_at" json:"at"`
	Category string    `bun:"category"    json:"category"`
	Type     string    `bun:"type"        json:"type"`
	Status   string    `bun:"status"      json:"status"`
	// Summary has no column in activity_events (the pre-CON-125 post_logs feed
	// carried one). Kept in the response for API compatibility — the UI falls
	// back to Type when it is empty; a later iteration can compose it from the
	// event's category/entity/payload.
	Summary string `bun:"-" json:"summary"`
}

// ActivityDay is a single UTC day's activity-event count for a tenant, used to
// build the detail page's activity chart.
type ActivityDay struct {
	Date  string `bun:"date"`
	Count int    `bun:"count"`
}

// ActivityRepository reads a tenant's behavioural activity from the analytics
// activity_events hypertable. Best-effort like SpendRepository: a nil pool
// returns ErrUnavailable and query failures are logged at debug.
type ActivityRepository interface {
	// Available reports whether the analytics pool is configured.
	Available() bool
	// RecentActivity returns a tenant's most recent activity events (newest
	// first), capped at limit. Returns ErrUnavailable if the pool is nil.
	RecentActivity(ctx context.Context, tenantID string, limit int) ([]ActivityEvent, error)
	// ActivitySeries returns per-day activity-event counts over the last
	// windowDays UTC calendar days (sparse — only days with events). Returns
	// ErrUnavailable if the pool is nil.
	ActivitySeries(ctx context.Context, tenantID string, windowDays int) ([]ActivityDay, error)
}

type activityRepository struct{ db *bun.DB }

func NewActivityRepository(db *bun.DB) ActivityRepository { return &activityRepository{db: db} }

func (r *activityRepository) Available() bool { return r.db != nil }

func (r *activityRepository) RecentActivity(ctx context.Context, tenantID string, limit int) ([]ActivityEvent, error) {
	if r.db == nil {
		return nil, ErrUnavailable
	}
	// category and type are NOT NULL in the CON-125 schema; only status is
	// nullable, so it is the only one coalesced.
	var events []ActivityEvent
	err := r.db.NewRaw(`
		SELECT
			occurred_at,
			category,
			type,
			COALESCE(status, '') AS status
		FROM activity_events
		WHERE tenant_id = ?
		ORDER BY occurred_at DESC
		LIMIT ?`, tenantID, limit).Scan(ctx, &events)
	if err != nil {
		logFail("activity.recent", err)
		return nil, err
	}
	return events, nil
}

func (r *activityRepository) ActivitySeries(ctx context.Context, tenantID string, windowDays int) ([]ActivityDay, error) {
	if r.db == nil {
		return nil, ErrUnavailable
	}
	// Bucket by UTC calendar day. The WHERE compares the bare occurred_at against
	// a UTC-midnight lower bound rather than casting the partitioning column, so
	// chunk exclusion on the TimescaleDB hypertable is preserved (mirrors
	// DailyCostByModel).
	var days []ActivityDay
	err := r.db.NewRaw(`
		SELECT to_char((occurred_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS date,
		       count(*) AS count
		FROM activity_events
		WHERE tenant_id = ?
		  AND occurred_at >= (date_trunc('day', now() AT TIME ZONE 'UTC')
		                      - (?::int - 1) * interval '1 day') AT TIME ZONE 'UTC'
		GROUP BY date
		ORDER BY date`, tenantID, windowDays).Scan(ctx, &days)
	if err != nil {
		logFail("activity.series", err)
		return nil, err
	}
	return days, nil
}
