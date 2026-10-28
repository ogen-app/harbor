package finance

import (
	"cmp"
	"fmt"
	"net/mail"
	"strings"

	fin "github.com/ogen-app/harbor/src/repository/finance"
)

// toleranceMicros absorbs rounding on printed amounts: one cent.
const toleranceMicros = 10_000

// Check keys, in the order they are shown and the first failing one is the
// receipt's attention reason.
const (
	CheckVendor    = "vendor"
	CheckDuplicate = "duplicate"
	CheckAmount    = "amount"
	CheckDate      = "date"
	CheckCurrency  = "currency"
	CheckTotals    = "totals"
	CheckLines     = "lines"
)

// MatchVendor resolves the printed merchant name, then the original sender's
// address, against the vendor catalog. It returns nil when nothing matches.
func MatchVendor(vendors []fin.Vendor, merchant, sender string) *fin.Vendor {
	m := strings.ToLower(merchant)
	for i := range vendors {
		for _, p := range vendors[i].MatchRules.Merchant {
			if p = strings.ToLower(strings.TrimSpace(p)); p != "" && strings.Contains(m, p) {
				return &vendors[i]
			}
		}
	}
	domain := strings.ToLower(senderDomain(sender))
	if domain == "" {
		return nil
	}
	for i := range vendors {
		for _, d := range vendors[i].MatchRules.Senders {
			d = strings.ToLower(strings.TrimSpace(d))
			if d != "" && (domain == d || strings.HasSuffix(domain, "."+d)) {
				return &vendors[i]
			}
		}
	}
	return nil
}

// EmailAddress extracts the bare lowercase address from a From-style header
// ("Jane <jane@x.com>" → "jane@x.com"). It returns the trimmed input when the
// header does not parse.
func EmailAddress(header string) string {
	if a, err := mail.ParseAddress(header); err == nil {
		return strings.ToLower(a.Address)
	}
	return strings.ToLower(strings.TrimSpace(strings.Trim(header, "<> ")))
}

func senderDomain(header string) string {
	_, domain, ok := strings.Cut(EmailAddress(header), "@")
	if !ok {
		return ""
	}
	return domain
}

// CheckInput is what the checks need besides the receipt itself.
type CheckInput struct {
	VendorName  string // '' when the vendor is not resolved
	DuplicateOf string // invoice number of the live receipt it duplicates, '' when none
}

// RunChecks validates a receipt: vendor resolved, not a duplicate, a total and
// a date, USD or a rate, subtotal + tax = total, and lines = subtotal. Every
// check is returned; the receipt passes when all are OK.
func RunChecks(r *fin.Receipt, in CheckInput) []fin.Check {
	checks := make([]fin.Check, 0, 7)
	add := func(key, label string, ok bool, detail string) {
		if ok {
			detail = ""
		}
		checks = append(checks, fin.Check{Key: key, OK: ok, Label: label, Detail: detail})
	}

	merchant := cmp.Or(r.MerchantName, "the merchant")
	add(CheckVendor, "Sender matches a vendor", r.VendorID != nil && *r.VendorID != "",
		fmt.Sprintf("No vendor matches “%s”", merchant))
	add(CheckDuplicate, "Not a duplicate", in.DuplicateOf == "",
		fmt.Sprintf("Duplicate of invoice %s", in.DuplicateOf))
	add(CheckAmount, "Total found", r.TotalMicros != nil, "The total could not be read")
	add(CheckDate, "Invoice date found", r.IssueDate != nil, "The invoice date could not be read")

	cur := strings.ToUpper(strings.TrimSpace(r.Currency))
	switch {
	case cur == "":
		add(CheckCurrency, "Currency is USD", false, "Currency missing")
	case cur != "USD" && r.FxRate == nil:
		add(CheckCurrency, "Currency is USD", false, fmt.Sprintf("Billed in %s: set the USD rate", cur))
	default:
		label := "Currency is USD"
		if cur != "USD" {
			label = fmt.Sprintf("%s converted at %g", cur, *r.FxRate)
		}
		add(CheckCurrency, label, true, "")
	}

	if r.TotalMicros != nil {
		sub, tax := deref(r.SubtotalMicros), deref(r.TaxMicros)
		if r.SubtotalMicros == nil {
			sub = linesSum(r.Lines)
		}
		ok := abs(sub+tax-*r.TotalMicros) <= toleranceMicros
		add(CheckTotals, "Subtotal + tax = total", ok, fmt.Sprintf("Subtotal %s + tax %s ≠ total %s",
			FormatMicros(sub, cur), FormatMicros(tax, cur), FormatMicros(*r.TotalMicros, cur)))
	}

	if len(r.Lines) > 0 && r.SubtotalMicros != nil {
		sum := linesSum(r.Lines)
		ok := abs(sum-*r.SubtotalMicros) <= toleranceMicros
		add(CheckLines, "Line items add up", ok, fmt.Sprintf("Line items %s ≠ subtotal %s",
			FormatMicros(sum, cur), FormatMicros(*r.SubtotalMicros, cur)))
	}
	return checks
}

// FirstFailure is the first failing check (” key when all pass).
func FirstFailure(checks []fin.Check) fin.Check {
	for _, c := range checks {
		if !c.OK {
			return c
		}
	}
	return fin.Check{}
}

func linesSum(lines []fin.Line) int64 {
	var s int64
	for _, l := range lines {
		s += deref(l.AmountMicros)
	}
	return s
}

// FormatMicros renders an amount for messages: "$118.80" for USD, "20.88 EUR"
// otherwise.
func FormatMicros(m int64, currency string) string {
	sign := ""
	if m < 0 {
		sign, m = "−", -m
	}
	cents := (m + 5_000) / 10_000
	s := fmt.Sprintf("%s.%02d", groupThousands(cents/100), cents%100)
	if currency == "" || strings.EqualFold(currency, "USD") {
		return sign + "$" + s
	}
	return sign + s + " " + strings.ToUpper(currency)
}

func groupThousands(n int64) string {
	s := fmt.Sprint(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

func deref(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

func abs(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}
