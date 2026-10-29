package finance

import (
	"context"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	fin "github.com/ogen-app/harbor/src/repository/finance"
	"github.com/ogen-app/harbor/src/repository/ogenvendorcost"
)

func day(s string) time.Time {
	t, err := time.Parse(time.DateOnly, s)
	if err != nil {
		panic(err)
	}
	return t
}

// usd is dollars in micros.
func usd(dollars float64) int64 { return int64(math.Round(dollars * 1_000_000)) }

// aiUsage books one token-pipeline bucket, as the materialiser would.
func aiUsage(t *testing.T, h *harness, vendor, date, model, tenant string, micros int64) {
	t.Helper()
	d := day(date)
	e := fin.LedgerEntry{
		Direction: fin.DirExpense, Source: fin.SourceTokenPipeline, SourceRef: date, VendorID: vendor,
		Description: model, AmountMicros: micros, Currency: "USD", AmountUSDMicros: micros,
		ServicePeriodStart: &d, ServicePeriodEnd: &d, BookedDate: d, Model: new(model),
	}
	if tenant != "" {
		e.TenantID = new(tenant)
	}
	if err := h.svc.repo.UpsertAIEntries(t.Context(), []fin.LedgerEntry{e}); err != nil {
		t.Fatal(err)
	}
}

// dailyUsage books micros a day for every day from..to, split over two tenants.
func dailyUsage(t *testing.T, h *harness, vendor, model string, from, to string, micros int64) {
	t.Helper()
	for d := day(from); !d.After(day(to)); d = d.AddDate(0, 0, 1) {
		aiUsage(t, h, vendor, d.Format(time.DateOnly), model, "t-a", micros/2)
		aiUsage(t, h, vendor, d.Format(time.DateOnly), model, "t-b", micros-micros/2)
	}
}

// topUp books a prepayment, as a posted credit receipt would.
func topUp(t *testing.T, h *harness, vendor, date string, micros int64) {
	t.Helper()
	err := h.svc.repo.InsertEntries(t.Context(), []fin.LedgerEntry{{
		Direction: fin.DirPrepayment, Source: fin.SourceReceipt, VendorID: vendor, Description: "Credit purchase",
		AmountMicros: micros, Currency: "USD", AmountUSDMicros: micros, BookedDate: day(date),
	}})
	if err != nil {
		t.Fatal(err)
	}
}

func setOpening(t *testing.T, h *harness, vendor, date string, micros int64, alert int) {
	t.Helper()
	if _, err := h.svc.SetCreditAccount(t.Context(), "ops@ogen.app", vendor, CreditAccountEdit{
		OpeningBalanceMicros: new(micros), OpeningDate: new(date), AlertDays: new(alert),
	}); err != nil {
		t.Fatal(err)
	}
}

func vendorOf(t *testing.T, c Credits, id string) CreditVendor {
	t.Helper()
	for _, v := range c.Vendors {
		if v.VendorID == id {
			return v
		}
	}
	t.Fatalf("vendor %s missing", id)
	return CreditVendor{}
}

func TestRunway(t *testing.T) {
	for _, tc := range []struct {
		balance, rate int64
		want          int
	}{
		{usd(1020.40), usd(34), 30}, // the mockup: about Nov 25 from Oct 26
		{usd(128.60), usd(5.04), 25},
		{usd(33.99), usd(34), 0},
		{0, usd(34), 0},
		{-usd(10), usd(34), 0},
	} {
		if got := Runway(tc.balance, tc.rate); got != tc.want {
			t.Errorf("Runway(%d, %d) = %d, want %d", tc.balance, tc.rate, got, tc.want)
		}
	}
}

func TestWithinThreshold(t *testing.T) {
	for _, tc := range []struct {
		estimate, charged int64
		pct               int
		want              bool
	}{
		{usd(1021.80), usd(1048.20), 5, true},  // +2.6%
		{usd(162.90), usd(149.10), 5, false},   // −8.5%
		{usd(162.90), usd(149.10), 10, true},   // −8.5% under 10%
		{usd(100), usd(105), 5, true},          // exactly 5%
		{usd(100), usd(105.01), 5, false},      // just over
		{0, 0, 5, true},
		{0, usd(1), 5, false},
	} {
		if got := WithinThreshold(tc.estimate, tc.charged, tc.pct); got != tc.want {
			t.Errorf("WithinThreshold(%d, %d, %d) = %v, want %v", tc.estimate, tc.charged, tc.pct, got, tc.want)
		}
	}
}

func TestMonthClosed(t *testing.T) {
	sep := day("2026-09-01")
	for _, tc := range []struct {
		today string
		want  bool
	}{
		{"2026-09-30", false},
		{"2026-10-01", false},
		{"2026-10-02", false},
		{"2026-10-03", true},
	} {
		if got := MonthClosed(sep, day(tc.today)); got != tc.want {
			t.Errorf("MonthClosed(Sep, %s) = %v, want %v", tc.today, got, tc.want)
		}
	}
}

// Hand-computed sample, today Oct 26:
//
//	Anthropic: opening $500 on Oct 1, top-up $1,000 on Oct 20, $34 a day
//	  Oct 1–25 (25 days, $850). Balance 500 + 1000 − 850 = $650. Rate over
//	  Oct 19–25 = $34. Runway 650 / 34 = 19 days → Nov 14, under 30.
//	Google: opening $200 on Oct 1, $5.04 a day Oct 1–25 ($126). Balance $74.
//	  Runway 74 / 5.04 = 14 days → Nov 9, under 30.
//
// Both are flagged, Google first (it runs out sooner).
func TestCreditsBalanceRunwayAndBanner(t *testing.T) {
	h := newHarness(t)
	dailyUsage(t, h, "anthropic", "claude-sonnet-5", "2026-10-01", "2026-10-25", usd(34))
	dailyUsage(t, h, "google", "gemini-3.8-flash", "2026-10-01", "2026-10-25", usd(5.04))
	// Usage before the opening date doesn't count against the balance.
	dailyUsage(t, h, "anthropic", "claude-sonnet-5", "2026-09-20", "2026-09-30", usd(50))
	topUp(t, h, "anthropic", "2026-10-20", usd(1000))
	setOpening(t, h, "anthropic", "2026-10-01", usd(500), 30)
	setOpening(t, h, "google", "2026-10-01", usd(200), 30)

	c, err := h.svc.Credits(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	a := vendorOf(t, c, "anthropic")
	if *a.BalanceMicros != usd(650) || *a.DailyRateMicros != usd(34) || *a.RunwayDays != 19 || *a.RunOutDate != "2026-11-14" || !a.BelowAlert {
		t.Fatalf("anthropic = balance %d rate %d runway %d out %s below %v", *a.BalanceMicros, *a.DailyRateMicros, *a.RunwayDays, *a.RunOutDate, a.BelowAlert)
	}
	if a.LastTopUp == nil || a.LastTopUp.Date != "2026-10-20" || a.LastTopUp.AmountMicros != usd(1000) {
		t.Fatalf("last top-up = %+v", a.LastTopUp)
	}
	g := vendorOf(t, c, "google")
	if *g.BalanceMicros != usd(74) || *g.RunwayDays != 14 || *g.RunOutDate != "2026-11-09" || !g.BelowAlert {
		t.Fatalf("google = balance %d runway %d out %s", *g.BalanceMicros, *g.RunwayDays, *g.RunOutDate)
	}

	if len(c.Alerts) != 2 || c.Alerts[0].VendorID != "google" || c.Alerts[1].VendorID != "anthropic" {
		t.Fatalf("alerts = %+v", c.Alerts)
	}
	want := "Google credits run out in about 14 days (Nov 9), under your 30-day alert. Top up and forward the receipt to the inbox."
	if c.Alerts[0].Message != want {
		t.Fatalf("message = %q", c.Alerts[0].Message)
	}

	// The series: nil before the opening date, the step on the top-up day,
	// and today's balance at the end.
	var sa SeriesVendor
	for _, v := range c.Series.Vendors {
		if v.VendorID == "anthropic" {
			sa = v
		}
	}
	idx := func(d string) int {
		for i, x := range c.Series.Days {
			if x == d {
				return i
			}
		}
		t.Fatalf("day %s not in series", d)
		return -1
	}
	if sa.Balances[idx("2026-09-30")] != nil {
		t.Fatal("balance before the opening date")
	}
	// Oct 19: 500 − 19 × 34 = −146; Oct 20: −146 + 1000 − 34 = 820.
	if *sa.Balances[idx("2026-10-19")] != usd(500-19*34) || *sa.Balances[idx("2026-10-20")] != usd(500-20*34+1000) {
		t.Fatalf("Oct 19/20 = %d / %d", *sa.Balances[idx("2026-10-19")], *sa.Balances[idx("2026-10-20")])
	}
	if *sa.Balances[len(sa.Balances)-1] != usd(650) {
		t.Fatalf("today = %d", *sa.Balances[len(sa.Balances)-1])
	}
	if len(sa.TopUps) != 1 || sa.Projection == nil || sa.Projection.RunOutDate != "2026-11-14" {
		t.Fatalf("top-ups %+v projection %+v", sa.TopUps, sa.Projection)
	}

	// A longer runway than the alert is not flagged.
	setOpening(t, h, "anthropic", "2026-10-01", usd(2000), 30)
	c, _ = h.svc.Credits(t.Context())
	if a := vendorOf(t, c, "anthropic"); a.BelowAlert || *a.RunwayDays != 63 {
		t.Fatalf("anthropic after a bigger opening = runway %d below %v", *a.RunwayDays, a.BelowAlert)
	}
	if len(c.Alerts) != 1 {
		t.Fatalf("alerts = %+v", c.Alerts)
	}
}

func TestCreditsWithoutOpeningOrUsage(t *testing.T) {
	h := newHarness(t)
	c, err := h.svc.Credits(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	a := vendorOf(t, c, "anthropic")
	if a.Configured || a.BalanceMicros != nil || a.AlertDays != DefaultAlertDays {
		t.Fatalf("unconfigured = %+v", a)
	}
	// Configured but no usage in the last 7 days: no rate, no runway, no alert.
	setOpening(t, h, "anthropic", "2026-10-01", usd(100), 30)
	c, _ = h.svc.Credits(t.Context())
	if a := vendorOf(t, c, "anthropic"); a.RunwayDays != nil || a.DailyRateMicros != nil || a.BelowAlert {
		t.Fatalf("idle vendor = %+v", a)
	}
}

func TestSetCreditAccountValidatesAndAudits(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	var inv *ErrInvalid
	if _, err := h.svc.SetCreditAccount(ctx, "ops@ogen.app", "railway", CreditAccountEdit{AlertDays: new(10)}); !errors.As(err, &inv) {
		t.Fatalf("non-AI vendor: %v", err)
	}
	if _, err := h.svc.SetCreditAccount(ctx, "ops@ogen.app", "google", CreditAccountEdit{OpeningBalanceMicros: new(usd(1))}); !errors.As(err, &inv) {
		t.Fatalf("balance without date: %v", err)
	}
	if _, err := h.svc.SetCreditAccount(ctx, "ops@ogen.app", "google", CreditAccountEdit{OpeningBalanceMicros: new(usd(1)), OpeningDate: new("2026-12-01")}); !errors.As(err, &inv) {
		t.Fatalf("future date: %v", err)
	}
	if _, err := h.svc.SetCreditAccount(ctx, "ops@ogen.app", "google", CreditAccountEdit{AlertDays: new(0)}); !errors.As(err, &inv) {
		t.Fatalf("zero alert days: %v", err)
	}
	cv, err := h.svc.SetCreditAccount(ctx, "ops@ogen.app", "google", CreditAccountEdit{AlertDays: new(45)})
	if err != nil || cv.AlertDays != 45 || cv.Configured {
		t.Fatalf("alert only = %+v, %v", cv, err)
	}
	audit, _ := h.svc.repo.AuditFor(ctx, auditCreditEntity, "google")
	if len(audit) != 1 || audit[0].Actor != "ops@ogen.app" {
		t.Fatalf("audit = %+v", audit)
	}
}

// ── Reconciliation ──────────────────────────────────────────────────────────

type fakeVendorCosts struct {
	rep ogenvendorcost.Report
	err error
}

func (f *fakeVendorCosts) AnthropicCost(context.Context, time.Time, time.Time) (ogenvendorcost.Report, error) {
	return f.rep, f.err
}

func rowOf(t *testing.T, r Reconciliation, vendor, month string) ReconRow {
	t.Helper()
	for _, x := range r.Rows {
		if x.VendorID == vendor && x.Month == month {
			return x
		}
	}
	t.Fatalf("row %s %s missing", vendor, month)
	return ReconRow{}
}

func monthTotal(t *testing.T, h *harness, vendor, month string) int64 {
	t.Helper()
	var total int64
	for _, b := range companyBuckets(t, h) {
		if b.Period == month && b.VendorID == vendor && b.Direction == fin.DirExpense {
			total += b.USDMicros
		}
	}
	return total
}

func reconcileTable(t *testing.T, h *harness) Reconciliation {
	t.Helper()
	r, err := h.svc.Reconciliation(t.Context(), day("2026-08-01"), day("2026-10-01"))
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// Sep Anthropic: estimate $1,021.80 (30 × $34.06), charged $1,048.20 → +2.6%,
// within 5%: reconciled automatically and Sep's total becomes the charge.
// Tenants' AI cost doesn't move.
func TestFetchReconcilesWithinThreshold(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	dailyUsage(t, h, "anthropic", "claude-sonnet-5", "2026-09-01", "2026-09-30", usd(34.06))
	dailyUsage(t, h, "anthropic", "claude-sonnet-5", "2026-10-01", "2026-10-25", usd(34))
	tenantsBefore, err := h.svc.repo.AICostByTenant(ctx, day("2026-09-01"))
	if err != nil {
		t.Fatal(err)
	}

	costs := []ogenvendorcost.DailyCost{{Date: "2026-10-10", Model: "claude-sonnet-5", CostType: "tokens", USDMicros: usd(400)}}
	// $1,048.20 over Sep: $34.94 a day on the 1st–30th.
	for d := day("2026-09-01"); d.Month() == time.September; d = d.AddDate(0, 0, 1) {
		costs = append(costs, ogenvendorcost.DailyCost{Date: d.Format(time.DateOnly), Model: "claude-sonnet-5", CostType: "tokens", USDMicros: usd(34.94)})
	}
	h.svc.SetVendorCosts(&fakeVendorCosts{rep: ogenvendorcost.Report{Configured: true, Costs: costs}})
	if err := h.svc.FetchVendorCharges(ctx); err != nil {
		t.Fatal(err)
	}

	table := reconcileTable(t, h)
	sep := rowOf(t, table, "anthropic", "2026-09")
	if sep.Status != fin.ChargeAutoAccepted || *sep.ChargedMicros != usd(1048.20) || sep.EstimateMicros != usd(1021.80) ||
		*sep.DiffMicros != usd(26.40) || *sep.DiffPct != 2.6 || sep.OverThreshold || *sep.AdjustmentMicros != usd(26.40) {
		t.Fatalf("sep = %+v", sep)
	}
	if got := monthTotal(t, h, "anthropic", "2026-09"); got != usd(1048.20) {
		t.Fatalf("Sep company total = %d, want the charge", got)
	}
	oct := rowOf(t, table, "anthropic", "2026-10")
	if oct.Status != fin.ChargeOpen || oct.ChargedMicros != nil || *oct.ChargedToDateMicros != usd(400) {
		t.Fatalf("oct = %+v", oct)
	}
	if table.Vendors[0].VendorID != "anthropic" || !table.Vendors[0].Connected {
		t.Fatalf("connection = %+v", table.Vendors)
	}

	// Reconciliation entries stay company level.
	var tenanted int
	if err := h.db.NewRaw(`SELECT count(*) FROM finance_ledger_entries WHERE source = 'reconciliation' AND tenant_id IS NOT NULL`).Scan(ctx, &tenanted); err != nil {
		t.Fatal(err)
	}
	if tenanted != 0 {
		t.Fatalf("%d reconciliation entries carry a tenant", tenanted)
	}
	if _, err := h.db.Exec(`UPDATE finance_ledger_entries SET tenant_id = 't-a' WHERE source = 'reconciliation'`); err == nil {
		t.Fatal("the database let a reconciliation entry carry a tenant")
	}
	tenantsAfter, _ := h.svc.repo.AICostByTenant(ctx, day("2026-09-01"))
	if tenantsAfter["t-a"] != tenantsBefore["t-a"] || tenantsAfter["t-b"] != tenantsBefore["t-b"] {
		t.Fatalf("tenant AI cost moved: %v → %v", tenantsBefore, tenantsAfter)
	}

	// Late usage changes the estimate: the adjustment follows, the total stays.
	aiUsage(t, h, "anthropic", "2026-09-30", "claude-haiku-5-5", "t-a", usd(3))
	if err := h.svc.ReconcileAll(ctx); err != nil {
		t.Fatal(err)
	}
	if got := monthTotal(t, h, "anthropic", "2026-09"); got != usd(1048.20) {
		t.Fatalf("Sep total after late usage = %d", got)
	}

	// Re-running is a no-op: one auto audit row so far, still.
	before, _ := h.svc.repo.AuditFor(ctx, auditReconEntity, "anthropic:2026-09")
	_ = h.svc.ReconcileAll(ctx)
	after, _ := h.svc.repo.AuditFor(ctx, auditReconEntity, "anthropic:2026-09")
	if len(after) != len(before) {
		t.Fatalf("idempotent reconcile added audit rows: %d → %d", len(before), len(after))
	}
}

// Sep Google: estimate $162.90, manual charge $149.10 → −8.5%, over 5%: it
// waits for Review. Accept posts −$13.80; both actions are audited.
func TestManualChargeOverThresholdAcceptAndDismiss(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	dailyUsage(t, h, "google", "gemini-3.8-flash", "2026-09-01", "2026-09-30", usd(5.43))
	dailyUsage(t, h, "google", "gemini-3.8-flash", "2026-08-01", "2026-08-31", usd(5))

	if _, err := h.svc.EnterManualCharge(ctx, "ops@ogen.app", "google", day("2026-09-01"), ManualCharge{ChargedMicros: new(usd(149.10)), Note: "Cloud Billing console"}); err != nil {
		t.Fatal(err)
	}
	sep := rowOf(t, reconcileTable(t, h), "google", "2026-09")
	if sep.Status != fin.ChargePendingReview || !sep.OverThreshold || *sep.DiffPct != -8.5 || sep.Source != fin.ChargeSourceManual {
		t.Fatalf("sep = %+v", sep)
	}
	if got := monthTotal(t, h, "google", "2026-09"); got != usd(162.90) {
		t.Fatalf("pending month total = %d, want the estimate", got)
	}

	eff, err := h.svc.AcceptCharge(ctx, "ops@ogen.app", "google", day("2026-09-01"))
	if err != nil {
		t.Fatal(err)
	}
	if eff.AmountMicros != -usd(13.80) || eff.Entries != 1 {
		t.Fatalf("accept effect = %+v", eff)
	}
	if got := monthTotal(t, h, "google", "2026-09"); got != usd(149.10) {
		t.Fatalf("accepted month total = %d", got)
	}
	if _, err := h.svc.AcceptCharge(ctx, "ops@ogen.app", "google", day("2026-09-01")); !errors.As(err, new(*ErrConflict)) {
		t.Fatalf("second accept: %v", err)
	}

	// Aug: $170 against $155 (+9.7%) → Keep estimate needs a reason.
	if _, err := h.svc.EnterManualCharge(ctx, "ops@ogen.app", "google", day("2026-08-01"), ManualCharge{ChargedMicros: new(usd(170))}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.DismissCharge(ctx, "ops@ogen.app", "google", day("2026-08-01"), " "); !errors.As(err, new(*ErrInvalid)) {
		t.Fatalf("dismiss without reason: %v", err)
	}
	if _, err := h.svc.DismissCharge(ctx, "ops@ogen.app", "google", day("2026-08-01"), "Includes a Workspace invoice"); err != nil {
		t.Fatal(err)
	}
	aug := rowOf(t, reconcileTable(t, h), "google", "2026-08")
	if aug.Status != fin.ChargeDismissed || aug.Note != "Includes a Workspace invoice" || aug.ReviewedBy != "ops@ogen.app" {
		t.Fatalf("aug = %+v", aug)
	}
	if got := monthTotal(t, h, "google", "2026-08"); got != usd(155) {
		t.Fatalf("dismissed month total = %d", got)
	}

	detail, err := h.svc.ReconciliationDetail(ctx, "google", day("2026-09-01"))
	if err != nil {
		t.Fatal(err)
	}
	actions := []string{}
	for _, a := range detail.Audit {
		actions = append(actions, a.Actor+" "+a.Action)
	}
	joined := strings.Join(actions, ", ")
	if !strings.Contains(joined, "ops@ogen.app reconciliation.accept") || !strings.Contains(joined, "ops@ogen.app reconciliation.manual") {
		t.Fatalf("audit = %s", joined)
	}
	if detail.HasBreakdown || len(detail.Days) != 30 || detail.Days[0].EstimateMicros != usd(5.43) {
		t.Fatalf("detail days = %d, breakdown %v", len(detail.Days), detail.HasBreakdown)
	}
	augAudit, _ := h.svc.repo.AuditFor(ctx, auditReconEntity, "google:2026-08")
	if len(augAudit) == 0 || augAudit[0].Action != "reconciliation.dismiss" {
		t.Fatalf("aug audit = %+v", augAudit)
	}

	// An open month can't be reviewed.
	if _, err := h.svc.AcceptCharge(ctx, "ops@ogen.app", "google", day("2026-10-01")); !errors.As(err, new(*ErrConflict)) {
		t.Fatalf("accept open month: %v", err)
	}
}

func TestThresholdChangeReconcilesAgain(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	dailyUsage(t, h, "google", "gemini-3.8-flash", "2026-09-01", "2026-09-30", usd(5.43))
	if _, err := h.svc.EnterManualCharge(ctx, "ops@ogen.app", "google", day("2026-09-01"), ManualCharge{ChargedMicros: new(usd(149.10))}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.SetSettings(ctx, "ops@ogen.app", SettingsEdit{DriftThresholdPct: new(7)}); !errors.As(err, new(*ErrInvalid)) {
		t.Fatalf("7%%: %v", err)
	}
	s, err := h.svc.SetSettings(ctx, "ops@ogen.app", SettingsEdit{DriftThresholdPct: new(10)})
	if err != nil || s.DriftThresholdPct != 10 {
		t.Fatalf("settings = %+v, %v", s, err)
	}
	sep := rowOf(t, reconcileTable(t, h), "google", "2026-09")
	if sep.Status != fin.ChargeAutoAccepted || sep.OverThreshold {
		t.Fatalf("sep at 10%% = %+v", sep)
	}
	if got := monthTotal(t, h, "google", "2026-09"); got != usd(149.10) {
		t.Fatalf("total = %d", got)
	}
	// Back to 2%: the automatic entry is withdrawn and the month waits again.
	if _, err := h.svc.SetSettings(ctx, "ops@ogen.app", SettingsEdit{DriftThresholdPct: new(2)}); err != nil {
		t.Fatal(err)
	}
	if sep := rowOf(t, reconcileTable(t, h), "google", "2026-09"); sep.Status != fin.ChargePendingReview {
		t.Fatalf("sep at 2%% = %+v", sep)
	}
	if got := monthTotal(t, h, "google", "2026-09"); got != usd(162.90) {
		t.Fatalf("total = %d", got)
	}
	audit, _ := h.svc.repo.AuditFor(ctx, auditSettingEntity, fin.SettingDriftThreshold)
	if len(audit) != 2 {
		t.Fatalf("settings audit = %d rows", len(audit))
	}
}

func TestNotConnectedStillAllowsManual(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	dailyUsage(t, h, "anthropic", "claude-sonnet-5", "2026-09-01", "2026-09-30", usd(10))
	h.svc.SetVendorCosts(&fakeVendorCosts{rep: ogenvendorcost.Report{Configured: false}})
	if err := h.svc.FetchVendorCharges(ctx); err != nil {
		t.Fatal(err)
	}
	table := reconcileTable(t, h)
	if sep := rowOf(t, table, "anthropic", "2026-09"); sep.Status != "not_connected" {
		t.Fatalf("sep = %+v", sep)
	}
	if table.Vendors[0].Connected || !strings.Contains(table.Vendors[0].Hint, "anthropic_admin_api_key") {
		t.Fatalf("connection = %+v", table.Vendors[0])
	}
	if _, err := h.svc.EnterManualCharge(ctx, "ops@ogen.app", "anthropic", day("2026-09-01"), ManualCharge{ChargedMicros: new(usd(305))}); err != nil {
		t.Fatal(err)
	}
	sep := rowOf(t, reconcileTable(t, h), "anthropic", "2026-09")
	if sep.Status != fin.ChargeAutoAccepted || sep.Source != fin.ChargeSourceManual {
		t.Fatalf("manual sep = %+v", sep)
	}
	// A later fetch never overwrites the manual charge.
	h.svc.SetVendorCosts(&fakeVendorCosts{rep: ogenvendorcost.Report{Configured: true, Costs: []ogenvendorcost.DailyCost{{Date: "2026-09-10", Model: "claude-sonnet-5", CostType: "tokens", USDMicros: usd(999)}}}})
	if err := h.svc.FetchVendorCharges(ctx); err != nil {
		t.Fatal(err)
	}
	if sep := rowOf(t, reconcileTable(t, h), "anthropic", "2026-09"); *sep.ChargedMicros != usd(305) {
		t.Fatalf("fetch overwrote the manual charge: %+v", sep)
	}
	// Awaiting: Google has no charge for a closed month.
	if g := rowOf(t, reconcileTable(t, h), "google", "2026-09"); g.Status != "awaiting" {
		t.Fatalf("google sep = %+v", g)
	}
}

func TestFetchKeyRejectedIsRecorded(t *testing.T) {
	h := newHarness(t)
	h.svc.SetVendorCosts(&fakeVendorCosts{err: ogenvendorcost.ErrKeyRejected})
	if err := h.svc.FetchVendorCharges(t.Context()); err == nil {
		t.Fatal("want the fetch error")
	}
	st, _ := h.svc.repo.GetSync(t.Context(), SyncVendorCostsAnthropic)
	if st.LastError == "" {
		t.Fatal("sync error not recorded")
	}
}
