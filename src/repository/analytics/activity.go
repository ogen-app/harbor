package analytics

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/uptrace/bun"
)

// ActivityEvent is one entry in a tenant's recent-activity feed, sourced from
// the centralised tenant_activity_events hypertable in the analytics DB (Ogen CON-125,
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

// ActivityEventDetail is the full tenant_activity_events row for the per-event details
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

// ActivityQuery selects a page of a tenant's events for the detail-page table.
// Beyond the tenant, every field is optional:
//   - Category filters to a single category (the legend/bar selection).
//   - Day filters to a single UTC calendar day "YYYY-MM-DD" (the bar selection).
//   - BeforeAt/BeforeID, when HasCursor is set, request the next page of older
//     events via a keyset on (occurred_at, id) — stable under concurrent inserts
//     where a plain OFFSET would skip or repeat rows.
type ActivityQuery struct {
	TenantID  string
	Category  string
	Day       string
	Limit     int
	BeforeAt  time.Time
	BeforeID  string
	HasCursor bool
}

// ActivityRepository reads a tenant's behavioural activity from the analytics
// tenant_activity_events hypertable. Best-effort like SpendRepository: a nil pool
// returns ErrUnavailable and query failures are logged at debug.
type ActivityRepository interface {
	// Available reports whether the analytics pool is configured.
	Available() bool
	// Events returns a page of a tenant's events (newest first) matching the
	// query's optional category/day filters and keyset cursor. Returns
	// ErrUnavailable if the pool is nil.
	Events(ctx context.Context, q ActivityQuery) ([]ActivityEvent, error)
	// RecentActivity returns a tenant's most recent activity events (newest
	// first), capped at limit — Events with no filters or cursor. Returns
	// ErrUnavailable if the pool is nil.
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
	return r.Events(ctx, ActivityQuery{TenantID: tenantID, Limit: limit})
}

func (r *activityRepository) Events(ctx context.Context, q ActivityQuery) ([]ActivityEvent, error) {
	if r.db == nil {
		return nil, ErrUnavailable
	}
	limit := q.Limit
	if limit < 1 {
		limit = 1
	}

	// Filters are assembled as positional-placeholder clauses so chunk exclusion
	// on the TimescaleDB hypertable stays intact (bare occurred_at comparisons,
	// no casts on the partitioning column).
	where := []string{"tenant_id = ?"}
	args := []any{q.TenantID}

	if q.Category != "" {
		where = append(where, "category = ?")
		args = append(args, q.Category)
	}
	// Single UTC calendar day, matching how ActivitySeries buckets events. A
	// malformed day is surfaced rather than silently dropped (which would widen
	// the result to every day).
	if q.Day != "" {
		day, err := time.ParseInLocation("2006-01-02", q.Day, time.UTC)
		if err != nil {
			return nil, err
		}
		end := day.AddDate(0, 0, 1)
		where = append(where, "occurred_at >= ? AND occurred_at < ?")
		args = append(args, day, end)
	}
	// Keyset cursor: strictly older than the last row of the previous page in the
	// (occurred_at DESC, id DESC) ordering. With a known id the tie-breaker walks
	// past siblings sharing the boundary timestamp; without one, `id < ''` would
	// drop every boundary row, so fall back to `<=` to keep them (favouring a
	// possible repeat over a silent skip).
	if q.HasCursor {
		if q.BeforeID != "" {
			where = append(where, "(occurred_at < ? OR (occurred_at = ? AND id < ?))")
			args = append(args, q.BeforeAt, q.BeforeAt, q.BeforeID)
		} else {
			where = append(where, "occurred_at <= ?")
			args = append(args, q.BeforeAt)
		}
	}

	// category and type are NOT NULL in the CON-125 schema; status and source are
	// nullable, so they are coalesced to empty strings.
	query := `
		SELECT
			id,
			occurred_at,
			category,
			type,
			COALESCE(status, '') AS status,
			COALESCE(source, '') AS source
		FROM tenant_activity_events
		WHERE ` + strings.Join(where, " AND ") + `
		ORDER BY occurred_at DESC, id DESC
		LIMIT ?`
	args = append(args, limit)

	var events []ActivityEvent
	if err := r.db.NewRaw(query, args...).Scan(ctx, &events); err != nil {
		logFail("activity.events", err)
		return nil, err
	}
	return events, nil
}

func (r *activityRepository) ActivityByID(ctx context.Context, tenantID, eventID string) (*ActivityEventDetail, error) {
	if r.db == nil {
		return nil, ErrUnavailable
	}
	// tags and payload are jsonb in the live schema; returned as-is so they pass
	// through to the API as a real array/object, with NULLs coalesced to [] / {}.
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
			COALESCE(tags, '[]'::jsonb)    AS tags,
			COALESCE(payload, '{}'::jsonb) AS payload,
			occurred_at
		FROM tenant_activity_events
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
		FROM tenant_activity_events
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
