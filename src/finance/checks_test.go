package finance

import (
	"testing"
	"time"

	fin "github.com/ogen-app/harbor/src/repository/finance"
)

var catalog = []fin.Vendor{
	{ID: "railway", Name: "Railway", MatchRules: fin.MatchRules{Merchant: []string{"railway"}, Senders: []string{"railway.app"}}},
	{ID: "anthropic", Name: "Anthropic", IsAIPipeline: true, MatchRules: fin.MatchRules{Merchant: []string{"anthropic"}}},
}

func TestMatchVendor(t *testing.T) {
	for _, tc := range []struct{ merchant, sender, want string }{
		{"Railway Corporation", "", "railway"},
		{"Stripe", "Railway <invoice+statements@mail.railway.app>", "railway"},
		{"Anthropic, PBC", "", "anthropic"},
		{"Figma, Inc.", "invoice@figma.com", ""},
		{"", "evil@notrailway.app", ""}, // a suffix match needs a dot boundary
	} {
		got := ""
		if v := MatchVendor(catalog, tc.merchant, tc.sender); v != nil {
			got = v.ID
		}
		if got != tc.want {
			t.Errorf("MatchVendor(%q, %q) = %q, want %q", tc.merchant, tc.sender, got, tc.want)
		}
	}
}

func TestRunChecks(t *testing.T) {
	vendor := "railway"
	ok := func() *fin.Receipt {
		return &fin.Receipt{
			VendorID: &vendor, Currency: "USD", IssueDate: new(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)),
			SubtotalMicros: micros(99), TaxMicros: micros(19.80), TotalMicros: micros(118.80),
			Lines: []fin.Line{{Description: "Growth", AmountMicros: micros(99)}},
		}
	}
	if f := FirstFailure(RunChecks(ok(), CheckInput{})); f.Key != "" {
		t.Fatalf("clean receipt failed %+v", f)
	}
	for name, tc := range map[string]struct {
		mutate func(*fin.Receipt)
		in     CheckInput
		want   string
		detail string
	}{
		"no vendor":     {func(r *fin.Receipt) { r.VendorID = nil; r.MerchantName = "Figma, Inc." }, CheckInput{}, CheckVendor, "No vendor matches “Figma, Inc.”"},
		"duplicate":     {func(*fin.Receipt) {}, CheckInput{DuplicateOf: "2213-4471"}, CheckDuplicate, "Duplicate of invoice 2213-4471"},
		"missing tax":   {func(r *fin.Receipt) { r.TaxMicros = micros(0) }, CheckInput{}, CheckTotals, "Subtotal $99.00 + tax $0.00 ≠ total $118.80"},
		"lines":         {func(r *fin.Receipt) { r.Lines[0].AmountMicros = micros(90) }, CheckInput{}, CheckLines, "Line items $90.00 ≠ subtotal $99.00"},
		"no currency":   {func(r *fin.Receipt) { r.Currency = "" }, CheckInput{}, CheckCurrency, "Currency missing"},
		"eur no rate":   {func(r *fin.Receipt) { r.Currency = "EUR" }, CheckInput{}, CheckCurrency, "Billed in EUR: set the USD rate"},
		"no date":       {func(r *fin.Receipt) { r.IssueDate = nil }, CheckInput{}, CheckDate, "The invoice date could not be read"},
		"cent rounding": {func(r *fin.Receipt) { r.TotalMicros = micros(118.81) }, CheckInput{}, "", ""},
	} {
		r := ok()
		tc.mutate(r)
		f := FirstFailure(RunChecks(r, tc.in))
		if f.Key != tc.want || f.Detail != tc.detail {
			t.Errorf("%s: got %q %q, want %q %q", name, f.Key, f.Detail, tc.want, tc.detail)
		}
	}
}

func TestReceiptEntries(t *testing.T) {
	day := time.Date(2026, 10, 14, 0, 0, 0, 0, time.UTC)
	rate := 1.08
	cf := &fin.Vendor{ID: "cloudflare"}

	// A EUR credit note: negative expense, converted at the stored rate.
	rc := &fin.Receipt{ID: "r1", Kind: "credit_note", Currency: "EUR", FxRate: &rate, IssueDate: &day,
		SubtotalMicros: micros(20), TaxMicros: micros(0.88), TotalMicros: micros(20.88),
		Lines: []fin.Line{{Description: "Domain renewal", AmountMicros: micros(20)}}}
	es := ReceiptEntries(rc, cf)
	if len(es) != 2 || es[0].Direction != fin.DirExpense || es[0].AmountUSDMicros != -21_600_000 || es[1].Description != "Tax" {
		t.Fatalf("credit note entries = %+v", es)
	}
	if es[0].FxRate == nil || *es[0].FxDate != day {
		t.Errorf("rate not stored: %+v", es[0])
	}

	// Any receipt from an AI-pipeline vendor is prepaid credit, never expense.
	top := &fin.Receipt{ID: "r2", Kind: "receipt", Currency: "USD", IssueDate: &day, TotalMicros: micros(500)}
	es = ReceiptEntries(top, &catalog[1])
	if len(es) != 1 || es[0].Direction != fin.DirPrepayment || es[0].AmountUSDMicros != 500_000_000 {
		t.Fatalf("top-up entries = %+v", es)
	}
}

func TestFormatMicros(t *testing.T) {
	for in, want := range map[int64]string{118_800_000: "$118.80", -1_234_567_890: "−$1,234.57", 0: "$0.00"} {
		if got := FormatMicros(in, "USD"); got != want {
			t.Errorf("FormatMicros(%d) = %q, want %q", in, got, want)
		}
	}
	if got := FormatMicros(20_880_000, "eur"); got != "20.88 EUR" {
		t.Errorf("EUR = %q", got)
	}
}
