// Package analytics holds the bun-backed data-access layer for the external
// Ogen analytics/TimescaleDB pool (vendor_usage_events → AI spend). One of the three
// origin-differentiated repository packages, alongside harbor and ogen.
//
// Every read is best-effort: the pool may be nil (unconfigured) or unreachable.
// Methods return ErrUnavailable for a nil pool and log query failures at debug,
// so callers render a soft "unavailable" state rather than an error.
package analytics

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/uptrace/bun"
)

// ErrUnavailable is returned when a method is called on an unconfigured (nil)
// analytics pool. Callers treat it as "spend unavailable", not a hard error.
var ErrUnavailable = errors.New("analytics database not configured")

// VendorSpend is one tenant's AI cost for the current billing period, split by
// model-family vendor.
type VendorSpend struct {
	AnthropicMicros int64 `json:"anthropicMicros"`
	GoogleMicros    int64 `json:"googleMicros"`
	OtherMicros     int64 `json:"otherMicros"`
	TotalMicros     int64 `json:"totalMicros"`
}

// VendorCost is one raw (tenant, vendor) cost bucket for the current period,
// before vendor classification. Used by the overview to rank tenants.
type VendorCost struct {
	TenantID   string `bun:"tenant_id"`
	Vendor     string `bun:"vendor"`
	CostMicros int64  `bun:"cost_micros"`
}

// DailyModelCost is one (UTC calendar day, model) cost bucket for the daily
// token-cost chart. Date is an ISO "YYYY-MM-DD" string.
type DailyModelCost struct {
	Date       string `bun:"date"`
	Model      string `bun:"model"`
	CostMicros int64  `bun:"cost_micros"`
}

type SpendRepository interface {
	// Available reports whether the analytics pool is configured.
	Available() bool
	// ByTenant returns current-period spend for every tenant with usage, keyed
	// by tenant id and split by vendor. Returns ErrUnavailable if the pool is nil.
	ByTenant(ctx context.Context) (map[string]VendorSpend, error)
	// Rollup returns the raw per-tenant, per-vendor cost rows for the current
	// period (query order preserved). Returns ErrUnavailable if the pool is nil.
	Rollup(ctx context.Context) ([]VendorCost, error)
	// PeriodTotalMicros returns total spend since the start of the current month.
	PeriodTotalMicros(ctx context.Context) (int64, error)
	// DailyCostByModel returns per-day, per-model summed cost over the last
	// windowDays UTC calendar days, ordered by day then model. Returns
	// ErrUnavailable if the pool is nil.
	DailyCostByModel(ctx context.Context, windowDays int) ([]DailyModelCost, error)
	// DailyCostByModelForTenant is DailyCostByModel scoped to a single tenant,
	// powering the per-tenant daily token-cost chart on the detail page.
	DailyCostByModelForTenant(ctx context.Context, tenantID string, windowDays int) ([]DailyModelCost, error)
}

type spendRepository struct{ db *bun.DB }

func NewSpendRepository(db *bun.DB) SpendRepository { return &spendRepository{db: db} }

func (r *spendRepository) Available() bool { return r.db != nil }

func (r *spendRepository) Rollup(ctx context.Context) ([]VendorCost, error) {
	if r.db == nil {
		return nil, ErrUnavailable
	}
	var rows []VendorCost
	err := r.db.NewRaw(`
		SELECT tenant_id, vendor, sum(cost_micros) AS cost_micros
		FROM vendor_usage_events
		WHERE occurred_at >= date_trunc('month', now())
		GROUP BY tenant_id, vendor`).Scan(ctx, &rows)
	if err != nil {
		logFail("spend.rollup", err)
		return nil, err
	}
	return rows, nil
}

func (r *spendRepository) ByTenant(ctx context.Context) (map[string]VendorSpend, error) {
	rows, err := r.Rollup(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[string]VendorSpend, len(rows))
	for _, row := range rows {
		s := out[row.TenantID]
		addVendorCost(&s, row.Vendor, row.CostMicros)
		out[row.TenantID] = s
	}
	return out, nil
}

func (r *spendRepository) DailyCostByModel(ctx context.Context, windowDays int) ([]DailyModelCost, error) {
	return r.dailyCostByModel(ctx, "", windowDays)
}

func (r *spendRepository) DailyCostByModelForTenant(ctx context.Context, tenantID string, windowDays int) ([]DailyModelCost, error) {
	return r.dailyCostByModel(ctx, tenantID, windowDays)
}

// dailyCostByModel is the shared implementation behind DailyCostByModel and its
// per-tenant variant: a blank tenantID sums across all tenants, otherwise the
// window is filtered to that one tenant.
func (r *spendRepository) dailyCostByModel(ctx context.Context, tenantID string, windowDays int) ([]DailyModelCost, error) {
	if r.db == nil {
		return nil, ErrUnavailable
	}
	// Bucket by UTC calendar day (matching the Ogen registrations/activity
	// series) so the dense fill on the handler side lines up. Blank models are
	// coalesced to "unknown" so every cost is accounted for in the chart.
	//
	// The WHERE compares the bare occurred_at against a UTC-midnight lower bound
	// (start of the earliest of exactly windowDays days ending today) rather than
	// casting the column to a date: vendor_usage_events is a TimescaleDB hypertable, and
	// a cast on the partitioning column defeats chunk exclusion and the
	// occurred_at index. >= is inclusive so rows exactly at midnight are kept.
	//
	// Placeholders bind positionally in source order: windowDays first (?::int),
	// then the optional tenant_id. The tenantFilter fragment is a constant, so
	// the Sprintf carries no user input into the SQL text.
	args := []any{windowDays}
	tenantFilter := ""
	if tenantID != "" {
		tenantFilter = "AND tenant_id = ?"
		args = append(args, tenantID)
	}
	query := fmt.Sprintf(`
		SELECT to_char((occurred_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS date,
		       COALESCE(NULLIF(model, ''), 'unknown') AS model,
		       sum(cost_micros) AS cost_micros
		FROM vendor_usage_events
		WHERE occurred_at >= (date_trunc('day', now() AT TIME ZONE 'UTC')
		                      - (?::int - 1) * interval '1 day') AT TIME ZONE 'UTC'
		       %s
		GROUP BY date, model
		ORDER BY date, model`, tenantFilter)

	var rows []DailyModelCost
	if err := r.db.NewRaw(query, args...).Scan(ctx, &rows); err != nil {
		logFail("spend.dailyCostByModel", err)
		return nil, err
	}
	return rows, nil
}

func (r *spendRepository) PeriodTotalMicros(ctx context.Context) (int64, error) {
	if r.db == nil {
		return 0, ErrUnavailable
	}
	var total int64
	err := r.db.NewRaw(`
		SELECT COALESCE(sum(cost_micros), 0) FROM vendor_usage_events
		WHERE occurred_at >= date_trunc('month', now())`).Scan(ctx, &total)
	if err != nil {
		logFail("spend.total", err)
		return 0, err
	}
	return total, nil
}

// AddVendorCost adds a raw (vendor, cost) bucket into a VendorSpend, classifying
// the vendor string into a model-family bucket. Exported so the overview can
// reuse the same classification when ranking tenants.
func AddVendorCost(s *VendorSpend, vendor string, costMicros int64) {
	addVendorCost(s, vendor, costMicros)
}

func addVendorCost(s *VendorSpend, vendor string, costMicros int64) {
	s.TotalMicros += costMicros
	switch classifyVendor(vendor) {
	case "anthropic":
		s.AnthropicMicros += costMicros
	case "google":
		s.GoogleMicros += costMicros
	default:
		s.OtherMicros += costMicros
	}
}

// classifyVendor maps a vendor_usage_events vendor string to a model-family bucket.
func classifyVendor(v string) string {
	v = strings.ToLower(strings.TrimSpace(v))
	switch {
	case strings.Contains(v, "anthropic") || strings.Contains(v, "claude"):
		return "anthropic"
	case strings.Contains(v, "gemini") || strings.Contains(v, "google") || strings.Contains(v, "vertex"):
		return "google"
	default:
		return "other"
	}
}

func logFail(section string, err error) {
	if err != nil {
		slog.Debug("analytics query failed", "component", "analytics", "section", section, "err", err)
	}
}
