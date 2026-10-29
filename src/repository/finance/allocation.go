package finance

import (
	"context"
	"time"

	"github.com/uptrace/bun"
)

// Shared cost allocation (CON-432): the rules, driver snapshots and the
// per-tenant shares of each shared vendor's monthly bill. Months are the first
// day of a UTC month. Nothing here touches the ledger.

// Allocation rules: how a shared vendor's bill is split.
const (
	RuleEven        = "even"
	RuleAICost      = "ai_cost"
	RuleActiveUsers = "active_users"
	RulePosts       = "posts"
	RuleEmails      = "emails"
	RuleNone        = "none"
)

// Allocation drivers: the per-tenant monthly quantities a rule splits by.
const (
	DriverActiveTenants = "active_tenants"
	DriverAICost        = "ai_cost"
	DriverActiveUsers   = "active_users"
	DriverPosts         = "posts"
	DriverEmails        = "emails"
)

type AllocationRule struct {
	bun.BaseModel `bun:"table:finance_allocation_rules,alias:ar"`

	VendorID  string    `bun:"vendor_id,pk"`
	Rule      string    `bun:"rule,notnull"`
	UpdatedBy string    `bun:"updated_by,notnull"`
	UpdatedAt time.Time `bun:"updated_at,notnull,default:current_timestamp"`
}

// AllocationSplit is one (month, vendor) split: the rule it used, the bill it
// split and how.
type AllocationSplit struct {
	bun.BaseModel `bun:"table:finance_allocation_splits,alias:sp"`

	Month         time.Time `bun:"month,pk,type:date"`
	VendorID      string    `bun:"vendor_id,pk"`
	Rule          string    `bun:"rule,notnull"`
	Driver        *string   `bun:"driver"`
	BillUSDMicros int64     `bun:"bill_usd_micros,notnull"`
	DriverTotal   int64     `bun:"driver_total,notnull"`
	Fallback      bool      `bun:"fallback,notnull"`
	ComputedAt    time.Time `bun:"computed_at,notnull,default:current_timestamp"`
}

// Allocation is one tenant's share of a split.
type Allocation struct {
	bun.BaseModel `bun:"table:finance_allocations,alias:al"`

	Month           time.Time `bun:"month,pk,type:date"`
	VendorID        string    `bun:"vendor_id,pk"`
	TenantID        string    `bun:"tenant_id,pk"`
	AmountUSDMicros int64     `bun:"amount_usd_micros,notnull"`
	DriverQuantity  int64     `bun:"driver_quantity,notnull"`
}

// MonthVendor names one (month, vendor) pair.
type MonthVendor struct {
	Month    time.Time `bun:"month"`
	VendorID string    `bun:"vendor_id"`
}

// LockAllocations takes a transaction-scoped advisory lock so the allocation
// job and a rules save never write the same month at once. Call it inside
// InTx.
func (r *Repository) LockAllocations(ctx context.Context) error {
	_, err := r.idb.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtext('harbor.finance.allocations'))`)
	return err
}

// ── Rules ───────────────────────────────────────────────────────────────────

// SharedVendors lists the vendors whose bills can be split: not on the AI
// pipeline (measured per tenant already) and not a revenue vendor.
func (r *Repository) SharedVendors(ctx context.Context) ([]Vendor, error) {
	var out []Vendor
	err := r.idb.NewSelect().Model(&out).
		Where("NOT v.is_ai_pipeline").
		Where("v.category <> 'revenue'").
		Order("v.name").
		Scan(ctx)
	return out, err
}

// AllocationRules returns the stored rules keyed by vendor. A shared vendor
// without a row is not split.
func (r *Repository) AllocationRules(ctx context.Context) (map[string]AllocationRule, error) {
	var rows []AllocationRule
	if err := r.idb.NewSelect().Model(&rows).Scan(ctx); err != nil {
		return nil, err
	}
	out := make(map[string]AllocationRule, len(rows))
	for _, row := range rows {
		out[row.VendorID] = row
	}
	return out, nil
}

// SetAllocationRule stores a vendor's rule.
func (r *Repository) SetAllocationRule(ctx context.Context, vendorID, rule, actor string) error {
	_, err := r.idb.NewInsert().
		Model(&AllocationRule{VendorID: vendorID, Rule: rule, UpdatedBy: actor, UpdatedAt: time.Now().UTC()}).
		On("CONFLICT (vendor_id) DO UPDATE").
		Set("rule = EXCLUDED.rule, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at").
		Exec(ctx)
	return err
}

// ── Bills ───────────────────────────────────────────────────────────────────

// sharedBillsSQL sums each shared vendor's posted expense per month: live
// expense entries, booked in the month. Receipts still in Needs attention have
// no entries, so they count once approved. Extraction cost is company
// overhead and never split.
const sharedBillsSQL = `
	SELECT date_trunc('month', l.booked_date)::date AS month, l.vendor_id, sum(l.amount_usd_micros) AS usd_micros
	FROM finance_ledger_entries AS l
	JOIN finance_vendors AS v ON v.id = l.vendor_id
	WHERE l.voided_at IS NULL
	  AND l.direction = 'expense'
	  AND l.source <> 'receipt_extraction'
	  AND NOT v.is_ai_pipeline
	  AND v.category <> 'revenue'`

// SharedBill is one shared vendor's posted bill for a month.
type SharedBill struct {
	Month     time.Time `bun:"month"`
	VendorID  string    `bun:"vendor_id"`
	USDMicros int64     `bun:"usd_micros"`
}

// SharedBills returns the shared vendors' bills for months [from, to]
// (inclusive, first days of months).
func (r *Repository) SharedBills(ctx context.Context, from, to time.Time) ([]SharedBill, error) {
	var out []SharedBill
	err := r.idb.NewRaw(sharedBillsSQL+`
		  AND l.booked_date >= ? AND l.booked_date < ?
		GROUP BY 1, 2`, from, to.AddDate(0, 1, 0)).Scan(ctx, &out)
	return out, err
}

// DriftedSplits lists the (month, vendor) pairs whose posted bill no longer
// matches the bill last split: a new or voided receipt, an edited amount, a
// remapped vendor, a bill that was never split, or a split whose bill has
// gone.
func (r *Repository) DriftedSplits(ctx context.Context) ([]MonthVendor, error) {
	var out []MonthVendor
	err := r.idb.NewRaw(`
		WITH bills AS (`+sharedBillsSQL+` GROUP BY 1, 2)
		SELECT COALESCE(b.month, sp.month) AS month, COALESCE(b.vendor_id, sp.vendor_id) AS vendor_id
		FROM bills AS b
		FULL OUTER JOIN finance_allocation_splits AS sp ON sp.month = b.month AND sp.vendor_id = b.vendor_id
		WHERE b.month IS NULL OR sp.month IS NULL OR b.usd_micros <> sp.bill_usd_micros
		ORDER BY 1, 2`).Scan(ctx, &out)
	return out, err
}

// ── Drivers ─────────────────────────────────────────────────────────────────

// AICostByTenant sums each tenant's token-pipeline AI cost booked in the month.
func (r *Repository) AICostByTenant(ctx context.Context, month time.Time) (map[string]int64, error) {
	var rows []struct {
		TenantID  string `bun:"tenant_id"`
		USDMicros int64  `bun:"usd_micros"`
	}
	err := r.idb.NewRaw(`
		SELECT l.tenant_id, sum(l.amount_usd_micros) AS usd_micros
		FROM finance_ledger_entries AS l
		WHERE l.source = ? AND l.direction = ? AND l.voided_at IS NULL
		  AND l.tenant_id IS NOT NULL AND l.tenant_id <> ''
		  AND l.booked_date >= ? AND l.booked_date < ?
		GROUP BY l.tenant_id`,
		SourceTokenPipeline, DirExpense, month, month.AddDate(0, 1, 0)).Scan(ctx, &rows)
	if err != nil {
		return nil, err
	}
	out := make(map[string]int64, len(rows))
	for _, row := range rows {
		out[row.TenantID] = row.USDMicros
	}
	return out, nil
}

// DriverSnapshots returns when each of the month's drivers was captured.
func (r *Repository) DriverSnapshots(ctx context.Context, month time.Time) (map[string]time.Time, error) {
	var rows []struct {
		Driver     string    `bun:"driver"`
		CapturedAt time.Time `bun:"captured_at"`
	}
	err := r.idb.NewRaw(`SELECT driver, captured_at FROM finance_allocation_snapshots WHERE month = ?`, month).Scan(ctx, &rows)
	if err != nil {
		return nil, err
	}
	out := make(map[string]time.Time, len(rows))
	for _, row := range rows {
		out[row.Driver] = row.CapturedAt
	}
	return out, nil
}

// ReplaceDrivers stores a fresh snapshot of one driver for the month,
// replacing the previous one. Zero and negative quantities are dropped.
func (r *Repository) ReplaceDrivers(ctx context.Context, month time.Time, driver string, quantities map[string]int64) error {
	now := time.Now().UTC()
	if _, err := r.idb.NewRaw(`
		INSERT INTO finance_allocation_snapshots (month, driver, captured_at) VALUES (?, ?, ?)
		ON CONFLICT (month, driver) DO UPDATE SET captured_at = EXCLUDED.captured_at`,
		month, driver, now).Exec(ctx); err != nil {
		return err
	}
	if _, err := r.idb.NewRaw(`DELETE FROM finance_allocation_drivers WHERE month = ? AND driver = ?`, month, driver).Exec(ctx); err != nil {
		return err
	}
	type row struct {
		bun.BaseModel `bun:"table:finance_allocation_drivers"`
		Month         time.Time `bun:"month,type:date"`
		Driver        string    `bun:"driver"`
		TenantID      string    `bun:"tenant_id"`
		Quantity      int64     `bun:"quantity"`
		CapturedAt    time.Time `bun:"captured_at"`
	}
	rows := make([]row, 0, len(quantities))
	for tenant, q := range quantities {
		if q > 0 && tenant != "" {
			rows = append(rows, row{Month: month, Driver: driver, TenantID: tenant, Quantity: q, CapturedAt: now})
		}
	}
	for chunk := range chunks(rows, 500) {
		if _, err := r.idb.NewInsert().Model(&chunk).Exec(ctx); err != nil {
			return err
		}
	}
	return nil
}

// Drivers returns the month's captured quantities: driver → tenant → quantity.
// A captured driver with no activity maps to an empty (non-nil) map; a driver
// never captured is absent.
func (r *Repository) Drivers(ctx context.Context, month time.Time) (map[string]map[string]int64, error) {
	snaps, err := r.DriverSnapshots(ctx, month)
	if err != nil {
		return nil, err
	}
	out := make(map[string]map[string]int64, len(snaps))
	for d := range snaps {
		out[d] = map[string]int64{}
	}
	var rows []struct {
		Driver   string `bun:"driver"`
		TenantID string `bun:"tenant_id"`
		Quantity int64  `bun:"quantity"`
	}
	err = r.idb.NewRaw(`SELECT driver, tenant_id, quantity FROM finance_allocation_drivers WHERE month = ?`, month).Scan(ctx, &rows)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		if m, ok := out[row.Driver]; ok {
			m[row.TenantID] = row.Quantity
		}
	}
	return out, nil
}

// ── Allocations ─────────────────────────────────────────────────────────────

// SplitsForMonth returns the month's splits keyed by vendor.
func (r *Repository) SplitsForMonth(ctx context.Context, month time.Time) (map[string]AllocationSplit, error) {
	var rows []AllocationSplit
	if err := r.idb.NewSelect().Model(&rows).Where("sp.month = ?", month).Scan(ctx); err != nil {
		return nil, err
	}
	out := make(map[string]AllocationSplit, len(rows))
	for _, row := range rows {
		out[row.VendorID] = row
	}
	return out, nil
}

// ReplaceSplit replaces a (month, vendor) split and its shares.
func (r *Repository) ReplaceSplit(ctx context.Context, split AllocationSplit, shares []Allocation) error {
	if _, err := r.idb.NewDelete().Model((*AllocationSplit)(nil)).
		Where("month = ? AND vendor_id = ?", split.Month, split.VendorID).
		Exec(ctx); err != nil {
		return err
	}
	split.ComputedAt = time.Now().UTC()
	if _, err := r.idb.NewInsert().Model(&split).Exec(ctx); err != nil {
		return err
	}
	for chunk := range chunks(shares, 500) {
		if _, err := r.idb.NewInsert().Model(&chunk).Exec(ctx); err != nil {
			return err
		}
	}
	return nil
}

// DeleteSplit removes a (month, vendor) split and its shares.
func (r *Repository) DeleteSplit(ctx context.Context, month time.Time, vendorID string) error {
	_, err := r.idb.NewDelete().Model((*AllocationSplit)(nil)).
		Where("month = ? AND vendor_id = ?", month, vendorID).
		Exec(ctx)
	return err
}

// Allocations returns the shares for months [from, to] (first days of months),
// for one tenant when tenantID is set or for every tenant.
func (r *Repository) Allocations(ctx context.Context, from, to time.Time, tenantID string) ([]Allocation, error) {
	var out []Allocation
	q := r.idb.NewSelect().Model(&out).
		Where("al.month >= ? AND al.month <= ?", from, to).
		Order("al.month", "al.vendor_id", "al.tenant_id")
	if tenantID != "" {
		q = q.Where("al.tenant_id = ?", tenantID)
	}
	err := q.Scan(ctx)
	return out, err
}
