package finance

import (
	"slices"
	"testing"
	"time"

	"github.com/ogen-app/harbor/src/repository/ogenbilling"
	"github.com/ogen-app/harbor/src/repository/ogenreceipts"
)

// The daily chart folds the same buckets as the monthly table: for every month,
// its days add up to the table's net revenue, total expenses, profit and each
// vendor's row. Voided entries, test-mode payments, prepayments and receipts
// waiting in Needs attention count in neither.
func TestDailyAddsUpToMonthly(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	h.now = time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)

	at := func(m time.Month, d int) time.Time { return time.Date(2026, m, d, 9, 0, 0, 0, time.UTC) }
	h.payments.payments = []ogenbilling.Payment{
		// September loses money: $50 net against $120 of expenses.
		{ID: "p1", ProviderID: "LS-1", Kind: "subscription_invoice", Currency: "USD", Total: 6000, TotalUSD: 6000, Tax: 500, TaxUSD: 500, Fee: 500, FeeUSD: 500, OccurredAt: at(9, 4)},
		{ID: "p2", ProviderID: "LS-2", Kind: "subscription_invoice", Currency: "USD", Total: 24000, TotalUSD: 24000, Tax: 4000, TaxUSD: 4000, Fee: 1000, FeeUSD: 1000, OccurredAt: at(10, 3)},
		{ID: "p3", ProviderID: "LS-2", Kind: "refund", Currency: "USD", Total: 2000, TotalUSD: 2000, OccurredAt: at(10, 20)},
		{ID: "p4", ProviderID: "LS-T", Kind: "order", Currency: "USD", Total: 99900, TotalUSD: 99900, OccurredAt: at(10, 5), TestMode: true},
	}
	if err := h.svc.SyncRevenue(ctx); err != nil {
		t.Fatal(err)
	}

	entry := func(direction, source, vendor string, day time.Time, usd float64, voided bool) {
		t.Helper()
		var voidedAt *time.Time
		model := vendor + "-model"
		if voided {
			voidedAt, model = &h.now, model+"-voided"
		}
		if _, err := h.db.Exec(`INSERT INTO finance_ledger_entries
			(direction, source, vendor_id, amount_micros, amount_usd_micros, booked_date, model, voided_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			direction, source, vendor, int64(usd*1e6), int64(usd*1e6), day, model, voidedAt); err != nil {
			t.Fatal(err)
		}
	}
	for d := 1; d <= 30; d++ {
		entry("expense", "token_pipeline", "anthropic", at(9, d), 3, false)
		if d%3 == 0 {
			entry("expense", "token_pipeline", "google", at(9, d), 0.5, false)
		}
	}
	for d := 1; d <= 26; d++ {
		entry("expense", "token_pipeline", "anthropic", at(10, d), 4.25, false)
		entry("expense", "token_pipeline", "google", at(10, d), 0.37, false)
	}
	entry("expense", "token_pipeline", "anthropic", at(10, 7), 500, true) // voided
	entry("prepayment", "receipt", "anthropic", at(10, 2), 1000, false)   // top-up: not in P&L
	entry("expense", "receipt_extraction", "anthropic", at(10, 1), 0.0042, false)
	h.receive(t, "re_rw", railwayReceipt("2213-4471")) // posts on its issue date, Oct 1

	pending := railwayReceipt("ZRN-0042")
	pending.Headers.ForwardedFrom = "billing@zernio.com"
	pending.Extraction.MerchantName = "Zernio"
	pending.Extraction.IssueDate = "2026-10-12"
	pending.Extraction.LineItems = []ogenreceipts.LineItem{{Description: "Growth plan", AmountMicros: micros(99)}}
	pending.Extraction.SubtotalMicros, pending.Extraction.TotalMicros = micros(99), micros(118.80) // totals don't add up
	h.receive(t, "re_z", pending)

	m, err := h.svc.Monthly(ctx, monthStart(2026, 9), monthStart(2026, 10))
	if err != nil {
		t.Fatal(err)
	}
	rowValue := func(key string, col int) int64 {
		for _, r := range m.Rows {
			if r.Key == key && r.Cells[col].Value != nil {
				return int64(*r.Cells[col].Value)
			}
		}
		return 0
	}

	for col, month := range []time.Time{monthStart(2026, 9), monthStart(2026, 10)} {
		d, err := h.svc.Daily(ctx, month)
		if err != nil {
			t.Fatal(err)
		}
		var net, exp int64
		byVendor := map[string]int64{}
		for _, p := range d.Days {
			if p.NetRevenue == nil {
				t.Fatalf("%s: day %s has no revenue", d.Month, p.Date)
			}
			net += *p.NetRevenue
			exp += p.Expenses
			var vendors int64
			for id, v := range p.ExpensesByVendor {
				byVendor[id] += v
				vendors += v
			}
			if vendors != p.Expenses {
				t.Errorf("%s: vendors %d ≠ expenses %d", p.Date, vendors, p.Expenses)
			}
		}
		if want := rowValue("net_revenue", col); net != want || *d.Totals.NetRevenue != want {
			t.Errorf("%s net: days %d, totals %d, monthly %d", d.Month, net, *d.Totals.NetRevenue, want)
		}
		if want := rowValue("total_expenses", col); exp != want || d.Totals.Expenses != want {
			t.Errorf("%s expenses: days %d, totals %d, monthly %d", d.Month, exp, d.Totals.Expenses, want)
		}
		if want := rowValue("profit", col); *d.Totals.Profit != want {
			t.Errorf("%s profit: %d, monthly %d", d.Month, *d.Totals.Profit, want)
		}
		for id, v := range byVendor {
			if want := rowValue("expense:"+id, col); v != want {
				t.Errorf("%s %s: days %d, monthly %d", d.Month, id, v, want)
			}
		}
	}

	sep, _ := h.svc.Daily(ctx, monthStart(2026, 9))
	if len(sep.Days) != 30 || *sep.Totals.Profit >= 0 || sep.Provisional != nil {
		t.Errorf("september: %d days, profit %d, provisional %+v", len(sep.Days), *sep.Totals.Profit, sep.Provisional)
	}
	if sep.Compare.Label != "Aug 1–31" {
		t.Errorf("whole month compares with %q", sep.Compare.Label)
	}

	oct, _ := h.svc.Daily(ctx, monthStart(2026, 10))
	if len(oct.Days) != 26 || oct.Period.Label != "October 1–26" || oct.Compare.Label != "Sep 1–26" {
		t.Errorf("october: %d days, %q vs %q", len(oct.Days), oct.Period.Label, oct.Compare.Label)
	}
	if oct.Provisional == nil || oct.Provisional.Count != 1 {
		t.Errorf("october provisional = %+v", oct.Provisional)
	}
	if r := oct.Days[0].Receipts; len(r) != 1 || r[0].VendorID != "railway" || r[0].AmountMicros != 86_180_000 {
		t.Errorf("oct 1 receipts = %+v", r)
	}
	var ids []string
	for _, v := range oct.Vendors {
		ids = append(ids, v.ID)
	}
	if !slices.Equal(ids, []string{"anthropic", "google", "railway"}) {
		t.Errorf("vendors = %v", ids)
	}
	// Same days of September, matching the summary strip.
	sum, _ := h.svc.Summary(ctx)
	if *oct.Previous.Profit != *sum.Profit.Previous || *oct.Totals.Profit != *sum.Profit.Value {
		t.Errorf("previous %d / %d, summary %d / %d", *oct.Previous.Profit, *oct.Totals.Profit, *sum.Profit.Previous, *sum.Profit.Value)
	}

	// A month that hasn't started has no days.
	if nov, _ := h.svc.Daily(ctx, monthStart(2026, 11)); len(nov.Days) != 0 {
		t.Errorf("november has %d days", len(nov.Days))
	}
}
