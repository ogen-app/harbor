// Package analytics holds the bun-backed data-access layer for the external
// Ogen analytics/TimescaleDB pool (usage_events → AI spend). One of the three
// origin-differentiated repository packages, alongside harbor and ogen.
//
// Every read is best-effort: the pool may be nil (unconfigured) or unreachable.
// Methods return ErrUnavailable for a nil pool and log query failures at debug,
// so callers render a soft "unavailable" state rather than an error.
package analytics

import (
	"context"
	"errors"
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
		FROM usage_events
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

func (r *spendRepository) PeriodTotalMicros(ctx context.Context) (int64, error) {
	if r.db == nil {
		return 0, ErrUnavailable
	}
	var total int64
	err := r.db.NewRaw(`
		SELECT COALESCE(sum(cost_micros), 0) FROM usage_events
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

// classifyVendor maps a usage_events vendor string to a model-family bucket.
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
