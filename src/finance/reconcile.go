package finance

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"slices"
	"strings"
	"time"

	"github.com/ogen-app/harbor/src/logging"
	fin "github.com/ogen-app/harbor/src/repository/finance"
	"github.com/ogen-app/harbor/src/repository/ogenvendorcost"
)

// VendorCostSource reads what Anthropic charged. *ogenvendorcost.Client
// satisfies it.
type VendorCostSource interface {
	AnthropicCost(ctx context.Context, from, to time.Time) (ogenvendorcost.Report, error)
}

const (
	// VendorAnthropic is the vendor whose charges come from its Admin API.
	VendorAnthropic = "anthropic"
	// SyncVendorCostsAnthropic is the sync-state key of the Anthropic fetch.
	SyncVendorCostsAnthropic = "vendor_costs:anthropic"
	// notConnectedError is the sync error stored while Ogen has no Admin key.
	notConnectedError = "not_connected"

	// DefaultDriftThreshold is the reconciliation threshold, percent, until an
	// operator picks another.
	DefaultDriftThreshold = 5
	// reconcileSettleDays is how long after a month ends it stays open: the
	// token pipeline re-reads its trailing days and the vendor finishes
	// filling its last day in.
	reconcileSettleDays = 2

	auditReconEntity   = "vendor_charge"
	auditSettingEntity = "finance_setting"
)

// DriftThresholds are the thresholds an operator can pick, percent.
var DriftThresholds = []int{1, 2, 5, 10}

// ── Fetch ───────────────────────────────────────────────────────────────────

// FetchVendorCharges reads Anthropic's charges for the previous and current
// months through Ogen, stores them with their daily breakdown, then
// reconciles every month. A manually entered month is never overwritten.
// Without an Admin key in Ogen the fetch is recorded as not connected and
// manual entries are still reconciled.
func (s *Service) FetchVendorCharges(ctx context.Context) error {
	fetchErr := s.fetchAnthropic(ctx)
	if err := s.ReconcileAll(ctx); err != nil {
		return errors.Join(fetchErr, err)
	}
	return fetchErr
}

func (s *Service) fetchAnthropic(ctx context.Context) error {
	if s.vendorCosts == nil {
		return nil
	}
	today := dateOnly(s.now())
	thisMonth := firstOfMonth(today)
	prevMonth := thisMonth.AddDate(0, -1, 0)
	rep, err := s.vendorCosts.AnthropicCost(ctx, prevMonth, today)
	if err != nil {
		_ = s.repo.SyncFailed(ctx, SyncVendorCostsAnthropic, err.Error())
		return fmt.Errorf("fetch anthropic charges: %w", err)
	}
	if !rep.Configured {
		return s.repo.SyncFailed(ctx, SyncVendorCostsAnthropic, notConnectedError)
	}

	charged := map[time.Time]int64{prevMonth: 0, thisMonth: 0}
	lines := make([]fin.ChargeLine, 0, len(rep.Costs))
	for _, c := range rep.Costs {
		day := parseDate(c.Date)
		if day == nil || day.Before(prevMonth) || day.After(today) {
			continue
		}
		charged[firstOfMonth(*day)] += c.USDMicros
		lines = append(lines, fin.ChargeLine{VendorID: VendorAnthropic, Day: *day, Model: c.Model, CostType: c.CostType, USDMicros: c.USDMicros})
	}
	fetchedAt := cmp.Or(rep.FetchedAt, s.now()).UTC()

	err = s.repo.InTx(ctx, func(ctx context.Context, tx *fin.Repository) error {
		if err := tx.ReplaceChargeLines(ctx, VendorAnthropic, prevMonth, today, lines); err != nil {
			return err
		}
		for _, month := range []time.Time{prevMonth, thisMonth} {
			if err := storeCharge(ctx, tx, VendorAnthropic, month, charged[month], fin.ChargeSourceAdminAPI, fetchedAt); err != nil {
				return err
			}
		}
		return tx.SyncSucceeded(ctx, SyncVendorCostsAnthropic, &today)
	})
	if err != nil {
		_ = s.repo.SyncFailed(ctx, SyncVendorCostsAnthropic, err.Error())
	}
	return err
}

// storeCharge records a fetched charge. A manual row stays as it is; a
// changed amount reopens a dismissed month, since it is a new charge to judge.
func storeCharge(ctx context.Context, tx *fin.Repository, vendorID string, month time.Time, amount int64, source string, at time.Time) error {
	c, err := tx.GetCharge(ctx, vendorID, month, true)
	if errors.Is(err, fin.ErrNotFound) {
		return tx.InsertCharge(ctx, &fin.VendorCharge{VendorID: vendorID, Month: month, ChargedMicros: amount, Source: source, Status: fin.ChargeOpen, FetchedAt: at})
	}
	if err != nil {
		return err
	}
	if c.Source == fin.ChargeSourceManual {
		return nil
	}
	if c.ChargedMicros != amount && c.Status == fin.ChargeDismissed {
		c.Status = fin.ChargeOpen
	}
	c.ChargedMicros = amount
	c.Source = source
	c.FetchedAt = at
	return tx.UpdateCharge(ctx, c)
}

// ── Reconcile ───────────────────────────────────────────────────────────────

// ReconcileAll reconciles every stored charge.
func (s *Service) ReconcileAll(ctx context.Context) error {
	charges, err := s.repo.ListCharges(ctx, time.Time{}, firstOfMonth(dateOnly(s.now())))
	if err != nil {
		return err
	}
	var errs []error
	for _, c := range charges {
		if _, err := s.Reconcile(ctx, c.VendorID, c.Month); err != nil {
			errs = append(errs, fmt.Errorf("reconcile %s %s: %w", c.VendorID, c.Month.Format(monthLayout), err))
		}
	}
	return errors.Join(errs...)
}

// MonthClosed reports whether a month can be reconciled on today: it ended
// more than reconcileSettleDays ago.
func MonthClosed(month, today time.Time) bool {
	return !today.Before(firstOfMonth(month).AddDate(0, 1, reconcileSettleDays))
}

// WithinThreshold reports whether charged differs from estimate by at most pct
// percent of the estimate. With no estimate only a zero charge is within.
func WithinThreshold(estimate, charged int64, pct int) bool {
	if estimate == 0 {
		return charged == 0
	}
	return abs(charged-estimate)*100 <= int64(pct)*abs(estimate)
}

func monthEnd(month time.Time) time.Time { return firstOfMonth(month).AddDate(0, 1, -1) }

// Reconcile decides one closed month of one vendor:
//   - within the threshold, a reconciliation entry of charged − estimate is
//     posted (auto_accepted) so the month's total equals the charge;
//   - over it, any automatic entry is voided and the month waits for Review;
//   - an accepted month keeps its entry in step with the estimate, so the
//     total stays the charge as late usage lands;
//   - a dismissed month is left alone.
//
// Status changes made here are audited as "system".
func (s *Service) Reconcile(ctx context.Context, vendorID string, month time.Time) (Effect, error) {
	month = firstOfMonth(month)
	today := dateOnly(s.now())
	pct, err := s.driftThreshold(ctx)
	if err != nil {
		return Effect{}, err
	}
	var eff Effect
	err = s.repo.InTx(ctx, func(ctx context.Context, tx *fin.Repository) error {
		c, err := tx.GetCharge(ctx, vendorID, month, true)
		if err != nil {
			return err
		}
		if !MonthClosed(month, today) || c.Status == fin.ChargeDismissed {
			return nil
		}
		estimate, err := s.estimate(ctx, tx, vendorID, month)
		if err != nil {
			return err
		}
		before := c.Status
		switch c.Status {
		case fin.ChargeAccepted:
			eff, err = postAdjustment(ctx, tx, c, estimate)
		default:
			if WithinThreshold(estimate, c.ChargedMicros, pct) {
				c.Status = fin.ChargeAutoAccepted
				eff, err = postAdjustment(ctx, tx, c, estimate)
			} else {
				c.Status = fin.ChargePendingReview
				eff, err = voidAdjustment(ctx, tx, c)
			}
		}
		if err != nil {
			return err
		}
		changedEstimate := c.EstimateMicrosAtCheck == nil || *c.EstimateMicrosAtCheck != estimate
		c.EstimateMicrosAtCheck = new(estimate)
		if c.Status == before && eff.Entries == 0 && !changedEstimate {
			return nil
		}
		if err := tx.UpdateCharge(ctx, c); err != nil {
			return err
		}
		if c.Status == before && eff.Entries == 0 {
			return nil
		}
		return tx.Audit(ctx, "system", "reconciliation.auto", auditReconEntity, chargeKey(vendorID, month),
			map[string]any{"status": before}, chargeAudit(c, estimate, pct), eff)
	})
	return eff, err
}

// postAdjustment makes the month's reconciliation entry charged − estimate
// (voided when that is zero) and returns what changed in the books.
func postAdjustment(ctx context.Context, tx *fin.Repository, c *fin.VendorCharge, estimate int64) (Effect, error) {
	booked := monthEnd(c.Month)
	current, err := tx.ReconciliationEntry(ctx, c.VendorID, booked)
	if err != nil {
		return Effect{}, err
	}
	var had int64
	if current != nil {
		had = current.AmountUSDMicros
	}
	want := c.ChargedMicros - estimate
	if want == had && (current != nil || want == 0) {
		return Effect{Month: c.Month.Format(monthLayout)}.withSummary(), nil
	}
	if want == 0 {
		removed, err := tx.VoidReconciliationEntry(ctx, c.VendorID, booked)
		if err != nil {
			return Effect{}, err
		}
		return Effect{AmountMicros: -removed, Month: c.Month.Format(monthLayout), Entries: 1}.withSummary(), nil
	}
	desc := fmt.Sprintf("Reconciliation: %s charged %s, estimate %s", c.Month.Format("Jan 2006"), FormatMicros(c.ChargedMicros, "USD"), FormatMicros(estimate, "USD"))
	if err := tx.UpsertReconciliationEntry(ctx, c.VendorID, booked, want, desc); err != nil {
		return Effect{}, err
	}
	return Effect{AmountMicros: want - had, Month: c.Month.Format(monthLayout), Entries: 1}.withSummary(), nil
}

func voidAdjustment(ctx context.Context, tx *fin.Repository, c *fin.VendorCharge) (Effect, error) {
	removed, err := tx.VoidReconciliationEntry(ctx, c.VendorID, monthEnd(c.Month))
	if err != nil {
		return Effect{}, err
	}
	n := 0
	if removed != 0 {
		n = 1
	}
	return Effect{AmountMicros: -removed, Month: c.Month.Format(monthLayout), Entries: n}.withSummary(), nil
}

func (s *Service) estimate(ctx context.Context, tx *fin.Repository, vendorID string, month time.Time) (int64, error) {
	rows, err := tx.AIEstimates(ctx, month, month)
	if err != nil {
		return 0, err
	}
	for _, r := range rows {
		if r.VendorID == vendorID {
			return r.USDMicros, nil
		}
	}
	return 0, nil
}

// ── Operator actions ────────────────────────────────────────────────────────

func (s *Service) closedAIVendorMonth(ctx context.Context, vendorID string, month time.Time) (*fin.Vendor, error) {
	v, err := s.repo.GetVendor(ctx, vendorID)
	if err != nil {
		return nil, err
	}
	if !v.IsAIPipeline {
		return nil, &ErrInvalid{Msg: v.Name + " is not an AI-pipeline vendor"}
	}
	if !MonthClosed(month, dateOnly(s.now())) {
		return nil, &ErrConflict{Msg: month.Format("Jan 2006") + " is still open"}
	}
	return v, nil
}

// AcceptCharge posts a month that waits for Review: the vendor's charge
// replaces the estimate. Audited.
func (s *Service) AcceptCharge(ctx context.Context, actor, vendorID string, month time.Time) (Effect, error) {
	month = firstOfMonth(month)
	if _, err := s.closedAIVendorMonth(ctx, vendorID, month); err != nil {
		return Effect{}, err
	}
	pct, err := s.driftThreshold(ctx)
	if err != nil {
		return Effect{}, err
	}
	var eff Effect
	err = s.repo.InTx(ctx, func(ctx context.Context, tx *fin.Repository) error {
		c, err := tx.GetCharge(ctx, vendorID, month, true)
		if err != nil {
			return err
		}
		if c.Status != fin.ChargePendingReview {
			return &ErrConflict{Msg: "only a month waiting for review can be accepted"}
		}
		estimate, err := s.estimate(ctx, tx, vendorID, month)
		if err != nil {
			return err
		}
		before := chargeAudit(c, deref(c.EstimateMicrosAtCheck), pct)
		if eff, err = postAdjustment(ctx, tx, c, estimate); err != nil {
			return err
		}
		c.Status = fin.ChargeAccepted
		c.EstimateMicrosAtCheck = new(estimate)
		c.ReviewedBy = new(actor)
		c.ReviewedAt = new(s.now().UTC())
		if err := tx.UpdateCharge(ctx, c); err != nil {
			return err
		}
		return tx.Audit(ctx, actor, "reconciliation.accept", auditReconEntity, chargeKey(vendorID, month), before, chargeAudit(c, estimate, pct), eff)
	})
	return eff, err
}

// DismissCharge keeps the estimate for a month and says why. Any posted
// reconciliation entry is voided. Audited.
func (s *Service) DismissCharge(ctx context.Context, actor, vendorID string, month time.Time, reason string) (Effect, error) {
	month = firstOfMonth(month)
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return Effect{}, &ErrInvalid{Msg: "say why the estimate is kept"}
	}
	if _, err := s.closedAIVendorMonth(ctx, vendorID, month); err != nil {
		return Effect{}, err
	}
	pct, err := s.driftThreshold(ctx)
	if err != nil {
		return Effect{}, err
	}
	var eff Effect
	err = s.repo.InTx(ctx, func(ctx context.Context, tx *fin.Repository) error {
		c, err := tx.GetCharge(ctx, vendorID, month, true)
		if err != nil {
			return err
		}
		if c.Status == fin.ChargeDismissed || c.Status == fin.ChargeOpen {
			return &ErrConflict{Msg: "this month has nothing to dismiss"}
		}
		before := chargeAudit(c, deref(c.EstimateMicrosAtCheck), pct)
		if eff, err = voidAdjustment(ctx, tx, c); err != nil {
			return err
		}
		c.Status = fin.ChargeDismissed
		c.Note = reason
		c.ReviewedBy = new(actor)
		c.ReviewedAt = new(s.now().UTC())
		if err := tx.UpdateCharge(ctx, c); err != nil {
			return err
		}
		return tx.Audit(ctx, actor, "reconciliation.dismiss", auditReconEntity, chargeKey(vendorID, month), before, chargeAudit(c, deref(c.EstimateMicrosAtCheck), pct), eff)
	})
	return eff, err
}

// ManualCharge is an operator-entered charge, e.g. from the Cloud Billing
// console.
type ManualCharge struct {
	ChargedMicros *int64 `json:"chargedMicros"`
	Note          string `json:"note"`
}

// EnterManualCharge stores what a vendor charged for a month, entered by an
// operator, and reconciles it if the month is closed. A changed amount
// reopens the month's decision. Audited.
func (s *Service) EnterManualCharge(ctx context.Context, actor, vendorID string, month time.Time, in ManualCharge) (Effect, error) {
	month = firstOfMonth(month)
	v, err := s.repo.GetVendor(ctx, vendorID)
	if err != nil {
		return Effect{}, err
	}
	if !v.IsAIPipeline {
		return Effect{}, &ErrInvalid{Msg: v.Name + " is not an AI-pipeline vendor"}
	}
	if in.ChargedMicros == nil || *in.ChargedMicros < 0 {
		return Effect{}, &ErrInvalid{Msg: "the charged amount must be zero or more"}
	}
	if month.After(firstOfMonth(dateOnly(s.now()))) {
		return Effect{}, &ErrInvalid{Msg: "that month hasn't started"}
	}
	amount := *in.ChargedMicros
	var voided Effect
	err = s.repo.InTx(ctx, func(ctx context.Context, tx *fin.Repository) error {
		c, err := tx.GetCharge(ctx, vendorID, month, true)
		var before any
		switch {
		case errors.Is(err, fin.ErrNotFound):
			c = &fin.VendorCharge{VendorID: vendorID, Month: month, Status: fin.ChargeOpen}
		case err != nil:
			return err
		default:
			before = map[string]any{"chargedMicros": c.ChargedMicros, "source": c.Source, "status": c.Status}
		}
		isNew := before == nil
		if !isNew && c.ChargedMicros != amount {
			// A new amount is judged afresh: undo the old decision.
			if voided, err = voidAdjustment(ctx, tx, c); err != nil {
				return err
			}
			c.Status = fin.ChargeOpen
			c.ReviewedBy, c.ReviewedAt = nil, nil
		}
		c.ChargedMicros = amount
		c.Source = fin.ChargeSourceManual
		c.Note = strings.TrimSpace(in.Note)
		c.FetchedAt = s.now().UTC()
		if isNew {
			err = tx.InsertCharge(ctx, c)
		} else {
			err = tx.UpdateCharge(ctx, c)
		}
		if err != nil {
			return err
		}
		return tx.Audit(ctx, actor, "reconciliation.manual", auditReconEntity, chargeKey(vendorID, month), before,
			map[string]any{"chargedMicros": amount, "source": fin.ChargeSourceManual, "note": c.Note}, voided)
	})
	if err != nil {
		return Effect{}, err
	}
	eff, err := s.Reconcile(ctx, vendorID, month)
	if err != nil {
		return Effect{}, err
	}
	if voided.Entries > 0 {
		eff = combine(voided, eff)
	}
	return eff, nil
}

func chargeKey(vendorID string, month time.Time) string {
	return vendorID + ":" + month.Format(monthLayout)
}

func chargeAudit(c *fin.VendorCharge, estimate int64, pct int) map[string]any {
	return map[string]any{
		"status": c.Status, "chargedMicros": c.ChargedMicros, "estimateMicros": estimate,
		"source": c.Source, "thresholdPct": pct, "note": c.Note,
	}
}

// ── Settings ────────────────────────────────────────────────────────────────

func (s *Service) driftThreshold(ctx context.Context) (int, error) {
	var pct int
	ok, err := s.repo.GetSetting(ctx, fin.SettingDriftThreshold, &pct)
	if err != nil {
		return 0, err
	}
	if !ok || !slices.Contains(DriftThresholds, pct) {
		return DefaultDriftThreshold, nil
	}
	return pct, nil
}

// FinanceSettings are the global finance settings.
type FinanceSettings struct {
	DriftThresholdPct int `json:"driftThresholdPct"`
}

// SettingsEdit changes settings; a nil field keeps its value.
type SettingsEdit struct {
	DriftThresholdPct *int `json:"driftThresholdPct"`
}

func (s *Service) Settings(ctx context.Context) (FinanceSettings, error) {
	pct, err := s.driftThreshold(ctx)
	return FinanceSettings{DriftThresholdPct: pct}, err
}

// SetSettings saves the global settings, audited, then re-reconciles closed
// months against the new threshold.
func (s *Service) SetSettings(ctx context.Context, actor string, ed SettingsEdit) (FinanceSettings, error) {
	if ed.DriftThresholdPct != nil {
		pct := *ed.DriftThresholdPct
		if !slices.Contains(DriftThresholds, pct) {
			return FinanceSettings{}, &ErrInvalid{Msg: "the threshold is one of 1, 2, 5 or 10 percent"}
		}
		before, err := s.driftThreshold(ctx)
		if err != nil {
			return FinanceSettings{}, err
		}
		if before != pct {
			err := s.repo.InTx(ctx, func(ctx context.Context, tx *fin.Repository) error {
				if err := tx.SetSetting(ctx, fin.SettingDriftThreshold, pct, actor); err != nil {
					return err
				}
				return tx.Audit(ctx, actor, "settings.update", auditSettingEntity, fin.SettingDriftThreshold, before, pct, nil)
			})
			if err != nil {
				return FinanceSettings{}, err
			}
			if err := s.ReconcileAll(ctx); err != nil {
				slog.WarnContext(ctx, "reconcile after threshold change failed", logging.AttrComponent, "pnl", logging.AttrError, err)
			}
		}
	}
	return s.Settings(ctx)
}

// ── View ────────────────────────────────────────────────────────────────────

// ReconRow is one vendor-month of the Estimated vs charged table.
//
// Status is open (month still open), not_connected (Anthropic without an
// Admin key), awaiting (no charge yet), auto_accepted, pending_review,
// accepted or dismissed. Charged and the difference are nil while the month
// is open or no charge has arrived; ChargedToDateMicros shows a running
// charge for an open month. DiffPct is relative to the estimate.
type ReconRow struct {
	VendorID            string   `json:"vendorId"`
	VendorName          string   `json:"vendorName"`
	Month               string   `json:"month"`
	EstimateMicros      int64    `json:"estimateMicros"`
	ChargedMicros       *int64   `json:"chargedMicros"`
	ChargedToDateMicros *int64   `json:"chargedToDateMicros"`
	DiffMicros          *int64   `json:"diffMicros"`
	DiffPct             *float64 `json:"diffPct"`
	OverThreshold       bool     `json:"overThreshold"`
	Source              string   `json:"source"`
	Status              string   `json:"status"`
	AdjustmentMicros    *int64   `json:"adjustmentMicros"`
	Note                string   `json:"note"`
	ReviewedBy          string   `json:"reviewedBy"`
	ReviewedAt          *string  `json:"reviewedAt"`
}

// VendorConnection says where a vendor's charges come from.
type VendorConnection struct {
	VendorID      string  `json:"vendorId"`
	Name          string  `json:"name"`
	Source        string  `json:"source"` // admin_api | manual
	Connected     bool    `json:"connected"`
	LastFetchedAt *string `json:"lastFetchedAt"`
	Error         string  `json:"error"`
	Hint          string  `json:"hint"`
}

// Reconciliation is the Estimated vs charged table.
type Reconciliation struct {
	ThresholdPct int                `json:"thresholdPct"`
	Thresholds   []int              `json:"thresholds"`
	Months       []string           `json:"months"`
	Rows         []ReconRow         `json:"rows"`
	Vendors      []VendorConnection `json:"vendors"`
}

// Reconciliation builds the table for months [from, to] (first days), newest
// first, one row per AI vendor per month.
func (s *Service) Reconciliation(ctx context.Context, from, to time.Time) (Reconciliation, error) {
	from, to = firstOfMonth(from), firstOfMonth(to)
	today := dateOnly(s.now())
	out := Reconciliation{Thresholds: DriftThresholds, Months: []string{}, Rows: []ReconRow{}, Vendors: []VendorConnection{}}
	pct, err := s.driftThreshold(ctx)
	if err != nil {
		return out, err
	}
	out.ThresholdPct = pct
	vendors, err := s.aiVendors(ctx)
	if err != nil {
		return out, err
	}
	conns, err := s.connections(ctx, vendors)
	if err != nil {
		return out, err
	}
	out.Vendors = conns
	connected := map[string]bool{}
	for _, c := range conns {
		connected[c.VendorID] = c.Connected
	}

	estimates, err := s.repo.AIEstimates(ctx, from, to)
	if err != nil {
		return out, err
	}
	est := map[string]int64{}
	for _, e := range estimates {
		est[chargeKey(e.VendorID, e.Month)] = e.USDMicros
	}
	charges, err := s.repo.ListCharges(ctx, from, to)
	if err != nil {
		return out, err
	}
	byKey := map[string]fin.VendorCharge{}
	for _, c := range charges {
		byKey[chargeKey(c.VendorID, c.Month)] = c
	}

	for m := to; !m.Before(from); m = m.AddDate(0, -1, 0) {
		out.Months = append(out.Months, m.Format(monthLayout))
		for _, v := range vendors {
			key := chargeKey(v.ID, m)
			row := ReconRow{VendorID: v.ID, VendorName: v.Name, Month: m.Format(monthLayout), EstimateMicros: est[key]}
			c, has := byKey[key]
			if has {
				row.Source = c.Source
				row.Note = c.Note
				if c.ReviewedBy != nil {
					row.ReviewedBy = *c.ReviewedBy
				}
				if c.ReviewedAt != nil {
					row.ReviewedAt = new(c.ReviewedAt.UTC().Format(time.RFC3339))
				}
			} else if v.ID == VendorAnthropic {
				row.Source = fin.ChargeSourceAdminAPI
			} else {
				row.Source = fin.ChargeSourceManual
			}
			switch {
			case !MonthClosed(m, today):
				row.Status = fin.ChargeOpen
				if has {
					row.ChargedToDateMicros = new(c.ChargedMicros)
				}
			case !has && v.ID == VendorAnthropic && !connected[v.ID]:
				row.Status = "not_connected"
			case !has:
				row.Status = "awaiting"
			default:
				row.Status = c.Status
				row.ChargedMicros = new(c.ChargedMicros)
				diff := c.ChargedMicros - row.EstimateMicros
				row.DiffMicros = new(diff)
				if row.EstimateMicros != 0 {
					row.DiffPct = new(math.Round(float64(diff)/float64(row.EstimateMicros)*1000) / 10)
				}
				row.OverThreshold = !WithinThreshold(row.EstimateMicros, c.ChargedMicros, pct)
				if c.Status == fin.ChargeOpen {
					// Closed but not decided yet (the job runs daily).
					row.Status = "awaiting_check"
				}
			}
			out.Rows = append(out.Rows, row)
		}
	}
	return out, s.attachAdjustments(ctx, out.Rows)
}

func (s *Service) attachAdjustments(ctx context.Context, rows []ReconRow) error {
	for i := range rows {
		r := &rows[i]
		if r.Status != fin.ChargeAutoAccepted && r.Status != fin.ChargeAccepted {
			continue
		}
		m, err := time.Parse(monthLayout, r.Month)
		if err != nil {
			continue
		}
		e, err := s.repo.ReconciliationEntry(ctx, r.VendorID, monthEnd(m))
		if err != nil {
			return err
		}
		if e != nil {
			r.AdjustmentMicros = new(e.AmountUSDMicros)
		}
	}
	return nil
}

func (s *Service) connections(ctx context.Context, vendors []fin.Vendor) ([]VendorConnection, error) {
	out := make([]VendorConnection, 0, len(vendors))
	for _, v := range vendors {
		c := VendorConnection{VendorID: v.ID, Name: v.Name, Source: fin.ChargeSourceManual}
		if v.ID != VendorAnthropic {
			c.Hint = "Enter each month's charge from the vendor's billing console."
			out = append(out, c)
			continue
		}
		c.Source = fin.ChargeSourceAdminAPI
		st, err := s.repo.GetSync(ctx, SyncVendorCostsAnthropic)
		if err != nil {
			return nil, err
		}
		if st.LastSuccessAt != nil {
			c.LastFetchedAt = new(st.LastSuccessAt.UTC().Format(time.RFC3339))
		}
		switch {
		case s.vendorCosts == nil:
			c.Hint = "Ogen's gRPC address and token aren't set in Harbor, so charges can only be entered by hand."
		case st.LastError == notConnectedError:
			c.Hint = "Not connected: set anthropic_admin_api_key (an Admin key, sk-ant-admin…) in Secrets. Until then, enter charges by hand."
		case st.LastError != "":
			c.Connected = st.LastSuccessAt != nil
			c.Error = st.LastError
		case st.LastSuccessAt != nil:
			c.Connected = true
		default:
			c.Hint = "Charges are fetched daily; the first fetch hasn't run yet."
		}
		out = append(out, c)
	}
	return out, nil
}

// ReconDay is one day of the Review drawer.
type ReconDay struct {
	Date           string `json:"date"`
	EstimateMicros int64  `json:"estimateMicros"`
	ChargedMicros  *int64 `json:"chargedMicros"`
}

// ReconModel is one model's month in the Review drawer. Charged is nil when
// the vendor's report has no breakdown (a manual charge).
type ReconModel struct {
	Model          string `json:"model"`
	EstimateMicros int64  `json:"estimateMicros"`
	ChargedMicros  *int64 `json:"chargedMicros"`
}

// ReconAudit is one audited action on a vendor-month.
type ReconAudit struct {
	At     string `json:"at"`
	Actor  string `json:"actor"`
	Action string `json:"action"`
	Note   string `json:"note"`
}

// ReconDetail is the Review drawer.
type ReconDetail struct {
	Row          ReconRow     `json:"row"`
	ThresholdPct int          `json:"thresholdPct"`
	HasBreakdown bool         `json:"hasBreakdown"`
	Days         []ReconDay   `json:"days"`
	Models       []ReconModel `json:"models"`
	Audit        []ReconAudit `json:"audit"`
}

// ReconciliationDetail is one vendor-month for the Review drawer: the daily
// estimate next to the daily charge, and both by model when the vendor's
// report breaks them down.
func (s *Service) ReconciliationDetail(ctx context.Context, vendorID string, month time.Time) (ReconDetail, error) {
	month = firstOfMonth(month)
	if _, err := s.repo.GetVendor(ctx, vendorID); err != nil {
		return ReconDetail{}, err
	}
	table, err := s.Reconciliation(ctx, month, month)
	if err != nil {
		return ReconDetail{}, err
	}
	i := slices.IndexFunc(table.Rows, func(r ReconRow) bool { return r.VendorID == vendorID })
	if i < 0 {
		return ReconDetail{}, fin.ErrNotFound
	}
	out := ReconDetail{Row: table.Rows[i], ThresholdPct: table.ThresholdPct, Days: []ReconDay{}, Models: []ReconModel{}, Audit: []ReconAudit{}}

	end := monthEnd(month)
	if today := dateOnly(s.now()); end.After(today) {
		end = today
	}
	estimates, err := s.repo.DailyEstimate(ctx, vendorID, month, end)
	if err != nil {
		return out, err
	}
	lines, err := s.repo.ChargeLines(ctx, vendorID, month, end)
	if err != nil {
		return out, err
	}
	out.HasBreakdown = len(lines) > 0

	estDay := map[string]int64{}
	chgDay := map[string]int64{}
	models := map[string]*ReconModel{}
	model := func(name string) *ReconModel {
		k := normaliseModel(name)
		if models[k] == nil {
			models[k] = &ReconModel{Model: k}
		}
		return models[k]
	}
	for _, e := range estimates {
		estDay[e.Day.Format(time.DateOnly)] += e.USDMicros
		model(e.Model).EstimateMicros += e.USDMicros
	}
	for _, l := range lines {
		chgDay[l.Day.Format(time.DateOnly)] += l.USDMicros
		m := model(cmp.Or(l.Model, l.CostType))
		m.ChargedMicros = new(deref(m.ChargedMicros) + l.USDMicros)
	}
	for d := month; !d.After(end); d = d.AddDate(0, 0, 1) {
		k := d.Format(time.DateOnly)
		day := ReconDay{Date: k, EstimateMicros: estDay[k]}
		if out.HasBreakdown {
			day.ChargedMicros = new(chgDay[k])
		}
		out.Days = append(out.Days, day)
	}
	for _, m := range models {
		if out.HasBreakdown && m.ChargedMicros == nil {
			m.ChargedMicros = new(int64(0))
		}
		out.Models = append(out.Models, *m)
	}
	slices.SortFunc(out.Models, func(a, b ReconModel) int {
		return cmp.Or(cmp.Compare(max(deref(b.ChargedMicros), b.EstimateMicros), max(deref(a.ChargedMicros), a.EstimateMicros)), cmp.Compare(a.Model, b.Model))
	})

	audit, err := s.repo.AuditFor(ctx, auditReconEntity, chargeKey(vendorID, month))
	if err != nil {
		return out, err
	}
	for _, a := range audit {
		out.Audit = append(out.Audit, ReconAudit{At: a.CreatedAt.UTC().Format(time.RFC3339), Actor: a.Actor, Action: a.Action, Note: auditNote(a.After)})
	}
	return out, nil
}

// normaliseModel maps a model id to the vendor's spelling: no provider prefix
// ("anthropic/claude-sonnet-5" → "claude-sonnet-5"), lower case.
func normaliseModel(m string) string {
	if i := strings.LastIndex(m, "/"); i >= 0 {
		m = m[i+1:]
	}
	return strings.ToLower(strings.TrimSpace(m))
}

func auditNote(after []byte) string {
	var m map[string]any
	if len(after) == 0 || json.Unmarshal(after, &m) != nil {
		return ""
	}
	if n, ok := m["note"].(string); ok {
		return n
	}
	return ""
}
