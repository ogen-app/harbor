package analytics

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/uptrace/bun"
)

// ActivityEvent is one entry in a tenant's recent-activity feed, sourced from
// the centralised activity_events hypertable in the analytics DB (Ogen CON-125,
// which superseded the control-plane post_logs audit trail). Its JSON shape is
// served directly to the tenant detail page and the Tenants-table expanded row.
type ActivityEvent struct {
	ID       string    `bun:"id"          json:"id"`
	At       time.Time `bun:"occurred_at" json:"at"`
	Category string    `bun:"category"    json:"category"`
	Type     string    `bun:"type"        json:"type"`
	Status   string    `bun:"status"      json:"status"`
	Source   string    `bun:"source"      json:"source"`
}

// ActivityEventDetail is the full activity_events row for the per-event details
// popover — every column except tenant_id. Tags and Payload pass through as raw
// JSON (a JSON array and object respectively).
type ActivityEventDetail struct {
	ID         string          `bun:"id"          json:"id"`
	UserID     string          `bun:"user_id"     json:"userId"`
	Category   string          `bun:"category"    json:"category"`
	Type       string          `bun:"type"        json:"type"`
	EntityType string          `bun:"entity_type" json:"entityType"`
	EntityID   string          `bun:"entity_id"   json:"entityId"`
	Status     string          `bun:"status"      json:"status"`
	Source     string          `bun:"source"      json:"source"`
	Tags       json.RawMessage `bun:"tags"        json:"tags"`
	Payload    json.RawMessage `bun:"payload"     json:"payload"`
	At         time.Time       `bun:"occurred_at" json:"at"`
}

// ActivityCategoryCount is one (UTC calendar day, category) event-count bucket,
// used to build the detail page's category-stacked activity chart.
type ActivityCategoryCount struct {
	Date     string `bun:"date"`
	Category string `bun:"category"`
	Count    int    `bun:"count"`
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
	// ActivityByID returns the full detail for one event scoped to the tenant,
	// or sql.ErrNoRows if unknown. Returns ErrUnavailable if the pool is nil.
	ActivityByID(ctx context.Context, tenantID, eventID string) (*ActivityEventDetail, error)
	// ActivitySeries returns per-day, per-category event counts over the last
	// windowDays UTC calendar days (sparse — only (day, category) pairs with
	// events). Returns ErrUnavailable if the pool is nil.
	ActivitySeries(ctx context.Context, tenantID string, windowDays int) ([]ActivityCategoryCount, error)
}

type activityRepository struct{ db *bun.DB }

func NewActivityRepository(db *bun.DB) ActivityRepository { return &activityRepository{db: db} }

func (r *activityRepository) Available() bool { return r.db != nil }

func (r *activityRepository) RecentActivity(ctx context.Context, tenantID string, limit int) ([]ActivityEvent, error) {
	if r.db == nil {
		return nil, ErrUnavailable
	}
	// category and type are NOT NULL in the CON-125 schema; status and source are
	// nullable, so they are coalesced to empty strings.
	var events []ActivityEvent
	err := r.db.NewRaw(`
		SELECT
			id,
			occurred_at,
			category,
			type,
			COALESCE(status, '') AS status,
			COALESCE(source, '') AS source
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

func (r *activityRepository) ActivityByID(ctx context.Context, tenantID, eventID string) (*ActivityEventDetail, error) {
	if r.db == nil {
		return nil, ErrUnavailable
	}
	// tags (text[]) and payload (jsonb) are returned as JSON so they pass through
	// to the API as a real array/object; NULLs are coalesced to [] and {}.
	d := new(ActivityEventDetail)
	err := r.db.NewRaw(`
		SELECT
			id,
			COALESCE(user_id, '')     AS user_id,
			category,
			type,
			COALESCE(entity_type, '') AS entity_type,
			COALESCE(entity_id, '')   AS entity_id,
			COALESCE(status, '')      AS status,
			COALESCE(source, '')      AS source,
			to_jsonb(COALESCE(tags, ARRAY[]::text[])) AS tags,
			COALESCE(payload, '{}'::jsonb)            AS payload,
			occurred_at
		FROM activity_events
		WHERE tenant_id = ? AND id = ?
		LIMIT 1`, tenantID, eventID).Scan(ctx, d)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			logFail("activity.byID", err)
		}
		return nil, err
	}
	return d, nil
}

func (r *activityRepository) ActivitySeries(ctx context.Context, tenantID string, windowDays int) ([]ActivityCategoryCount, error) {
	if r.db == nil {
		return nil, ErrUnavailable
	}
	// Bucket by UTC calendar day and category. The WHERE compares the bare
	// occurred_at against a UTC-midnight lower bound rather than casting the
	// partitioning column, so chunk exclusion on the TimescaleDB hypertable is
	// preserved (mirrors DailyCostByModel).
	var rows []ActivityCategoryCount
	err := r.db.NewRaw(`
		SELECT to_char((occurred_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS date,
		       category,
		       count(*) AS count
		FROM activity_events
		WHERE tenant_id = ?
		  AND occurred_at >= (date_trunc('day', now() AT TIME ZONE 'UTC')
		                      - (?::int - 1) * interval '1 day') AT TIME ZONE 'UTC'
		GROUP BY date, category
		ORDER BY date, category`, tenantID, windowDays).Scan(ctx, &rows)
	if err != nil {
		logFail("activity.series", err)
		return nil, err
	}
	return rows, nil
}
