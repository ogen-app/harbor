package analytics

import (
	"context"
	"time"

	"github.com/uptrace/bun"
)

// UsageSpan is when a tenant first and last used AI generation, for the
// Lifecycle tab's Generating milestone and its activity.
type UsageSpan struct {
	First time.Time
	Last  time.Time
}

// UsageSpanRepository reads per-tenant AI usage spans from vendor_usage_events.
type UsageSpanRepository struct{ db *bun.DB }

func NewUsageSpanRepository(db *bun.DB) *UsageSpanRepository { return &UsageSpanRepository{db: db} }

func (r *UsageSpanRepository) Available() bool { return r.db != nil }

// AISpans returns each tenant's first and last AI usage, keyed by tenant id.
// Non-AI vendors (social platform usage also lands in vendor_usage_events) are
// left out. Returns ErrUnavailable if the pool is nil.
func (r *UsageSpanRepository) AISpans(ctx context.Context) (map[string]UsageSpan, error) {
	if r.db == nil {
		return nil, ErrUnavailable
	}
	var rows []struct {
		TenantID string    `bun:"tenant_id"`
		Vendor   string    `bun:"vendor"`
		First    time.Time `bun:"first_at"`
		Last     time.Time `bun:"last_at"`
	}
	err := r.db.NewRaw(`
		SELECT tenant_id::text AS tenant_id, vendor,
		       min(occurred_at) AS first_at, max(occurred_at) AS last_at
		FROM vendor_usage_events
		WHERE tenant_id IS NOT NULL
		GROUP BY 1, 2`).Scan(ctx, &rows)
	if err != nil {
		logFail("usage.spans", err)
		return nil, err
	}
	out := map[string]UsageSpan{}
	for _, row := range rows {
		if !IsAIVendor(row.Vendor) {
			continue
		}
		s, ok := out[row.TenantID]
		if !ok || row.First.Before(s.First) {
			s.First = row.First
		}
		if row.Last.After(s.Last) {
			s.Last = row.Last
		}
		out[row.TenantID] = s
	}
	return out, nil
}
