package finance

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/uptrace/bun"
)

// SourceReconciliation is a month's charged − estimate for an AI vendor,
// booked on the month's last day. Never carries a tenant.
const SourceReconciliation = "reconciliation"

// Vendor charge statuses and sources.
const (
	ChargeOpen          = "open"
	ChargePendingReview = "pending_review"
	ChargeAccepted      = "accepted"
	ChargeDismissed     = "dismissed"
	ChargeAutoAccepted  = "auto_accepted"

	ChargeSourceAdminAPI      = "admin_api"
	ChargeSourceBillingExport = "billing_export"
	ChargeSourceManual        = "manual"
)

// SettingDriftThreshold is the finance_settings key of the reconciliation
// threshold, a whole percent.
const SettingDriftThreshold = "drift_threshold_pct"

// CreditAccount is an AI vendor's prepaid-credit account. The opening balance
// and date are nil until an operator enters them.
type CreditAccount struct {
	bun.BaseModel `bun:"table:finance_credit_accounts,alias:ca"`

	VendorID             string     `bun:"vendor_id,pk"`
	OpeningBalanceMicros *int64     `bun:"opening_balance_micros"`
	OpeningDate          *time.Time `bun:"opening_date,type:date"`
	AlertDays            int        `bun:"alert_days,notnull"`
	UpdatedBy            string     `bun:"updated_by,notnull"`
	UpdatedAt            time.Time  `bun:"updated_at,notnull,default:current_timestamp"`
}

// VendorCharge is what a vendor charged for a month and where its
// reconciliation stands.
type VendorCharge struct {
	bun.BaseModel `bun:"table:finance_vendor_charges,alias:vc"`

	VendorID              string     `bun:"vendor_id,pk"`
	Month                 time.Time  `bun:"month,pk,type:date"`
	ChargedMicros         int64      `bun:"charged_micros,notnull"`
	EstimateMicrosAtCheck *int64     `bun:"estimate_micros_at_check"`
	Source                string     `bun:"source,notnull"`
	Status                string     `bun:"status,notnull"`
	ReviewedBy            *string    `bun:"reviewed_by"`
	ReviewedAt            *time.Time `bun:"reviewed_at"`
	Note                  string     `bun:"note,notnull"`
	FetchedAt             time.Time  `bun:"fetched_at,notnull,default:current_timestamp"`
	UpdatedAt             time.Time  `bun:"updated_at,notnull,default:current_timestamp"`
}

// ChargeLine is one day × model × cost type of a vendor's own report.
type ChargeLine struct {
	bun.BaseModel `bun:"table:finance_vendor_charge_lines,alias:cl"`

	VendorID  string    `bun:"vendor_id,pk"`
	Day       time.Time `bun:"day,pk,type:date"`
	Model     string    `bun:"model,pk"`
	CostType  string    `bun:"cost_type,pk"`
	USDMicros int64     `bun:"usd_micros,notnull"`
}

// ── Credit accounts ─────────────────────────────────────────────────────────

func (r *Repository) ListCreditAccounts(ctx context.Context) ([]CreditAccount, error) {
	var out []CreditAccount
	err := r.idb.NewSelect().Model(&out).Order("ca.vendor_id").Scan(ctx)
	return out, err
}

// GetCreditAccount returns ErrNotFound when the vendor has no account yet.
func (r *Repository) GetCreditAccount(ctx context.Context, vendorID string) (*CreditAccount, error) {
	a := new(CreditAccount)
	if err := r.idb.NewSelect().Model(a).Where("ca.vendor_id = ?", vendorID).Scan(ctx); err != nil {
		return nil, notFound(err)
	}
	return a, nil
}

func (r *Repository) UpsertCreditAccount(ctx context.Context, a *CreditAccount) error {
	_, err := r.idb.NewInsert().Model(a).
		On("CONFLICT (vendor_id) DO UPDATE").
		Set("opening_balance_micros = EXCLUDED.opening_balance_micros").
		Set("opening_date = EXCLUDED.opening_date").
		Set("alert_days = EXCLUDED.alert_days").
		Set("updated_by = EXCLUDED.updated_by").
		Set("updated_at = now()").
		Returning("*").
		Exec(ctx)
	return err
}

// ── Settings ────────────────────────────────────────────────────────────────

// GetSetting decodes a setting into v and reports whether it exists.
func (r *Repository) GetSetting(ctx context.Context, key string, v any) (bool, error) {
	var raw string
	err := r.idb.NewRaw(`SELECT value::text FROM finance_settings WHERE key = ?`, key).Scan(ctx, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, json.Unmarshal([]byte(raw), v)
}

func (r *Repository) SetSetting(ctx context.Context, key string, v any, actor string) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = r.idb.NewRaw(`
		INSERT INTO finance_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, now())
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
		key, string(raw), actor).Exec(ctx)
	return err
}

// ── Vendor charges ──────────────────────────────────────────────────────────

// GetCharge loads one month's charge; forUpdate locks it for the transaction.
func (r *Repository) GetCharge(ctx context.Context, vendorID string, month time.Time, forUpdate bool) (*VendorCharge, error) {
	c := new(VendorCharge)
	q := r.idb.NewSelect().Model(c).Where("vc.vendor_id = ? AND vc.month = ?", vendorID, month)
	if forUpdate {
		q = q.For("UPDATE")
	}
	if err := q.Scan(ctx); err != nil {
		return nil, notFound(err)
	}
	return c, nil
}

// ListCharges returns the charges for months [from, to] (first days).
func (r *Repository) ListCharges(ctx context.Context, from, to time.Time) ([]VendorCharge, error) {
	var out []VendorCharge
	err := r.idb.NewSelect().Model(&out).
		Where("vc.month >= ? AND vc.month <= ?", from, to).
		Order("vc.month DESC", "vc.vendor_id").
		Scan(ctx)
	return out, err
}

// InsertCharge stores a new charge row.
func (r *Repository) InsertCharge(ctx context.Context, c *VendorCharge) error {
	_, err := r.idb.NewInsert().Model(c).Returning("*").Exec(ctx)
	return err
}

// UpdateCharge writes every column of c but the key.
func (r *Repository) UpdateCharge(ctx context.Context, c *VendorCharge) error {
	_, err := r.idb.NewUpdate().Model(c).
		ExcludeColumn("vendor_id", "month", "updated_at").
		Set("updated_at = now()").
		WherePK().
		Returning("*").
		Exec(ctx)
	return err
}

// ReplaceChargeLines swaps a vendor's report lines for days [from, to] with
// lines.
func (r *Repository) ReplaceChargeLines(ctx context.Context, vendorID string, from, to time.Time, lines []ChargeLine) error {
	if _, err := r.idb.NewDelete().Model((*ChargeLine)(nil)).
		Where("vendor_id = ? AND day BETWEEN ? AND ?", vendorID, from, to).
		Exec(ctx); err != nil {
		return err
	}
	for chunk := range chunks(lines, 1000) {
		if _, err := r.idb.NewInsert().Model(&chunk).Exec(ctx); err != nil {
			return err
		}
	}
	return nil
}

// ChargeLines lists a vendor's report lines for days [from, to].
func (r *Repository) ChargeLines(ctx context.Context, vendorID string, from, to time.Time) ([]ChargeLine, error) {
	var out []ChargeLine
	err := r.idb.NewSelect().Model(&out).
		Where("cl.vendor_id = ? AND cl.day BETWEEN ? AND ?", vendorID, from, to).
		Order("cl.day", "cl.model", "cl.cost_type").
		Scan(ctx)
	return out, err
}

// ── Ledger reads ────────────────────────────────────────────────────────────

// VendorMonth is one AI vendor's estimate for one month.
type VendorMonth struct {
	VendorID  string    `bun:"vendor_id"`
	Month     time.Time `bun:"month"`
	USDMicros int64     `bun:"usd_micros"`
}

// AIEstimates sums each AI-pipeline vendor's estimated expense per month for
// months [from, to]: every live expense entry but reconciliation ones, so the
// token pipeline plus the cost of reading receipts.
func (r *Repository) AIEstimates(ctx context.Context, from, to time.Time) ([]VendorMonth, error) {
	var out []VendorMonth
	err := r.idb.NewRaw(`
		SELECT l.vendor_id, date_trunc('month', l.booked_date)::date AS month, sum(l.amount_usd_micros) AS usd_micros
		FROM finance_ledger_entries AS l
		JOIN finance_vendors AS v ON v.id = l.vendor_id
		WHERE v.is_ai_pipeline
		  AND l.voided_at IS NULL
		  AND l.direction = ?
		  AND l.source <> ?
		  AND l.booked_date >= ? AND l.booked_date < ?
		GROUP BY 1, 2`,
		DirExpense, SourceReconciliation, from, to.AddDate(0, 1, 0)).Scan(ctx, &out)
	return out, err
}

// DayModelCost is one day × model of a vendor's estimate.
type DayModelCost struct {
	Day       time.Time `bun:"day"`
	Model     string    `bun:"model"`
	USDMicros int64     `bun:"usd_micros"`
}

// DailyEstimate is a vendor's estimated expense per day and model for days
// [from, to], reconciliation entries excluded.
func (r *Repository) DailyEstimate(ctx context.Context, vendorID string, from, to time.Time) ([]DayModelCost, error) {
	var out []DayModelCost
	err := r.idb.NewRaw(`
		SELECT l.booked_date AS day, COALESCE(l.model, '') AS model, sum(l.amount_usd_micros) AS usd_micros
		FROM finance_ledger_entries AS l
		WHERE l.vendor_id = ?
		  AND l.voided_at IS NULL
		  AND l.direction = ?
		  AND l.source <> ?
		  AND l.booked_date BETWEEN ? AND ?
		GROUP BY 1, 2
		ORDER BY 1, 2`,
		vendorID, DirExpense, SourceReconciliation, from, to).Scan(ctx, &out)
	return out, err
}

// DayFlow is one day of a vendor's credit movements: top-ups (prepayments),
// the estimated AI expense and any reconciliation adjustment.
type DayFlow struct {
	Day                  time.Time `bun:"day"`
	TopUpMicros          int64     `bun:"top_up_micros"`
	EstimateMicros       int64     `bun:"estimate_micros"`
	ReconciliationMicros int64     `bun:"reconciliation_micros"`
}

// CreditFlows lists a vendor's days with any movement in [from, to].
func (r *Repository) CreditFlows(ctx context.Context, vendorID string, from, to time.Time) ([]DayFlow, error) {
	var out []DayFlow
	err := r.idb.NewRaw(`
		SELECT l.booked_date AS day,
		       COALESCE(sum(l.amount_usd_micros) FILTER (WHERE l.direction = ?), 0) AS top_up_micros,
		       COALESCE(sum(l.amount_usd_micros) FILTER (WHERE l.direction = ? AND l.source <> ?), 0) AS estimate_micros,
		       COALESCE(sum(l.amount_usd_micros) FILTER (WHERE l.direction = ? AND l.source = ?), 0) AS reconciliation_micros
		FROM finance_ledger_entries AS l
		WHERE l.vendor_id = ?
		  AND l.voided_at IS NULL
		  AND l.direction IN (?, ?)
		  AND l.booked_date BETWEEN ? AND ?
		GROUP BY 1
		ORDER BY 1`,
		DirPrepayment, DirExpense, SourceReconciliation, DirExpense, SourceReconciliation,
		vendorID, DirPrepayment, DirExpense, from, to).Scan(ctx, &out)
	return out, err
}

// TopUp is one prepayment: a forwarded receipt's credit purchase.
type TopUp struct {
	Day       time.Time `bun:"day"`
	USDMicros int64     `bun:"usd_micros"`
	ReceiptID string    `bun:"receipt_id"`
}

// TopUps lists a vendor's prepayments booked in [from, to], one per receipt,
// oldest first.
func (r *Repository) TopUps(ctx context.Context, vendorID string, from, to time.Time) ([]TopUp, error) {
	var out []TopUp
	err := r.idb.NewRaw(`
		SELECT min(l.booked_date) AS day, sum(l.amount_usd_micros) AS usd_micros,
		       COALESCE(l.receipt_id::text, l.id::text) AS receipt_id
		FROM finance_ledger_entries AS l
		WHERE l.vendor_id = ?
		  AND l.voided_at IS NULL
		  AND l.direction = ?
		  AND l.booked_date BETWEEN ? AND ?
		GROUP BY 3
		ORDER BY 1, 3`,
		vendorID, DirPrepayment, from, to).Scan(ctx, &out)
	return out, err
}

// LastTopUp is the newest prepayment of a vendor (nil when none).
func (r *Repository) LastTopUp(ctx context.Context, vendorID string) (*TopUp, error) {
	var out []TopUp
	err := r.idb.NewRaw(`
		SELECT min(l.booked_date) AS day, sum(l.amount_usd_micros) AS usd_micros,
		       COALESCE(l.receipt_id::text, l.id::text) AS receipt_id
		FROM finance_ledger_entries AS l
		WHERE l.vendor_id = ? AND l.voided_at IS NULL AND l.direction = ?
		GROUP BY 3
		ORDER BY 1 DESC, 3 DESC
		LIMIT 1`,
		vendorID, DirPrepayment).Scan(ctx, &out)
	if err != nil || len(out) == 0 {
		return nil, err
	}
	return &out[0], nil
}

// ── Reconciliation entries ──────────────────────────────────────────────────

// UpsertReconciliationEntry writes a vendor's adjustment for the month that
// ends on bookedDate, reviving it if it was voided. It never carries a tenant.
func (r *Repository) UpsertReconciliationEntry(ctx context.Context, vendorID string, bookedDate time.Time, amountMicros int64, description string) error {
	monthStart := time.Date(bookedDate.Year(), bookedDate.Month(), 1, 0, 0, 0, 0, time.UTC)
	e := &LedgerEntry{
		Direction:          DirExpense,
		Source:             SourceReconciliation,
		SourceRef:          monthStart.Format("2006-01"),
		VendorID:           vendorID,
		Description:        description,
		AmountMicros:       amountMicros,
		Currency:           "USD",
		AmountUSDMicros:    amountMicros,
		ServicePeriodStart: &monthStart,
		ServicePeriodEnd:   &bookedDate,
		BookedDate:         bookedDate,
	}
	_, err := r.idb.NewInsert().Model(e).
		On("CONFLICT (source, vendor_id, booked_date) WHERE source = 'reconciliation' DO UPDATE").
		Set("amount_micros = EXCLUDED.amount_micros").
		Set("amount_usd_micros = EXCLUDED.amount_usd_micros").
		Set("description = EXCLUDED.description").
		Set("voided_at = NULL").
		Set("updated_at = now()").
		Exec(ctx)
	return err
}

// VoidReconciliationEntry voids a vendor's adjustment booked on bookedDate and
// returns the amount it removed (0 when there was none).
func (r *Repository) VoidReconciliationEntry(ctx context.Context, vendorID string, bookedDate time.Time) (int64, error) {
	var removed []int64
	err := r.idb.NewRaw(`
		UPDATE finance_ledger_entries SET voided_at = now(), updated_at = now()
		WHERE source = ? AND vendor_id = ? AND booked_date = ? AND voided_at IS NULL
		RETURNING amount_usd_micros`,
		SourceReconciliation, vendorID, bookedDate).Scan(ctx, &removed)
	if err != nil {
		return 0, err
	}
	var sum int64
	for _, v := range removed {
		sum += v
	}
	return sum, nil
}

// ReconciliationEntry returns the live adjustment for a vendor and booked day
// (nil when none).
func (r *Repository) ReconciliationEntry(ctx context.Context, vendorID string, bookedDate time.Time) (*LedgerEntry, error) {
	e := new(LedgerEntry)
	err := r.idb.NewSelect().Model(e).
		Where("l.source = ? AND l.vendor_id = ? AND l.booked_date = ? AND l.voided_at IS NULL", SourceReconciliation, vendorID, bookedDate).
		Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return e, err
}
