package finance

import (
	"cmp"
	"context"
	"fmt"
	"math"
	"strings"

	fin "github.com/ogen-app/harbor/src/repository/finance"
)

// post books a checked receipt: one ledger entry per line, plus one for tax.
// A prepaid-credit top-up (any receipt from an AI-pipeline vendor, or one the
// model read as a prepayment) is a prepayment, never an expense: AI expense
// comes from the token pipeline. A refund or credit note is a negative
// expense. Receipts count on their invoice date.
func (s *Service) post(ctx context.Context, tx *fin.Repository, rc *fin.Receipt, vendor *fin.Vendor) (Effect, error) {
	if vendor == nil && rc.VendorID != nil {
		v, err := tx.GetVendor(ctx, *rc.VendorID)
		if err != nil {
			return Effect{}, fmt.Errorf("load vendor: %w", err)
		}
		vendor = v
	}
	if vendor == nil || rc.IssueDate == nil || rc.TotalMicros == nil {
		return Effect{}, fmt.Errorf("receipt %s is not postable", rc.ID)
	}
	entries := ReceiptEntries(rc, vendor)
	if err := tx.InsertEntries(ctx, entries); err != nil {
		return Effect{}, fmt.Errorf("post receipt: %w", err)
	}
	var sum int64
	for _, e := range entries {
		sum += e.AmountUSDMicros
	}
	return Effect{AmountMicros: sum, Month: rc.IssueDate.Format("2006-01"), Entries: len(entries)}.withSummary(), nil
}

// ReceiptEntries builds the ledger entries for a checked receipt.
func ReceiptEntries(rc *fin.Receipt, vendor *fin.Vendor) []fin.LedgerEntry {
	direction := fin.DirExpense
	if vendor.IsAIPipeline || rc.Kind == "prepayment" {
		direction = fin.DirPrepayment
	}
	sign := int64(1)
	if rc.Kind == "refund" || rc.Kind == "credit_note" {
		sign = -1
	}
	currency := cmp.Or(strings.ToUpper(rc.Currency), "USD")
	rate := 1.0
	if currency != "USD" && rc.FxRate != nil {
		rate = *rc.FxRate
	}
	label := cmp.Or(rc.InvoiceNumber, "receipt")

	base := fin.LedgerEntry{
		Direction:          direction,
		Source:             fin.SourceReceipt,
		SourceRef:          rc.ID,
		VendorID:           vendor.ID,
		ReceiptID:          &rc.ID,
		EmailID:            rc.EmailID,
		Currency:           currency,
		ServicePeriodStart: rc.ServicePeriodStart,
		ServicePeriodEnd:   rc.ServicePeriodEnd,
		BookedDate:         *rc.IssueDate,
	}
	if currency != "USD" {
		base.FxRate = rc.FxRate
		base.FxDate = cmp.Or(rc.FxDate, rc.IssueDate)
	}
	add := func(out []fin.LedgerEntry, desc string, amount int64) []fin.LedgerEntry {
		e := base
		e.Description = desc
		e.AmountMicros = sign * amount
		e.AmountUSDMicros = sign * toUSD(amount, rate)
		return append(out, e)
	}

	var out []fin.LedgerEntry
	for _, l := range rc.Lines {
		if l.AmountMicros == nil || *l.AmountMicros == 0 {
			continue
		}
		out = add(out, cmp.Or(strings.TrimSpace(l.Description), "Invoice "+label), *l.AmountMicros)
	}
	tax := deref(rc.TaxMicros)
	if len(out) == 0 {
		// No usable lines: one entry for everything before tax.
		out = add(out, "Invoice "+label, *rc.TotalMicros-tax)
	}
	if tax != 0 {
		out = add(out, "Tax", tax)
	}
	return out
}

func toUSD(micros int64, rate float64) int64 {
	return int64(math.Round(float64(micros) * rate))
}

// bookingReason explains, in plain words, which month a receipt counts in.
func bookingReason(rc *fin.Receipt) string {
	if rc.IssueDate == nil {
		return "It has no invoice date yet, so it does not count in any month."
	}
	s := fmt.Sprintf("Counts in %s: receipts count on their invoice date (%s).",
		rc.IssueDate.Format("Jan 2006"), rc.IssueDate.Format("Jan 2, 2006"))
	if rc.ServicePeriodStart != nil && rc.ServicePeriodEnd != nil {
		s += fmt.Sprintf(" It pays for %s – %s.", rc.ServicePeriodStart.Format("Jan 2"), rc.ServicePeriodEnd.Format("Jan 2, 2006"))
	}
	return s
}

// receiptUSD is a receipt's signed total in USD (nil when it cannot be told:
// no total, or a foreign currency with no rate).
func receiptUSD(rc *fin.Receipt) *int64 {
	if rc.TotalMicros == nil {
		return nil
	}
	rate := 1.0
	if c := strings.ToUpper(rc.Currency); c != "" && c != "USD" {
		if rc.FxRate == nil {
			return nil
		}
		rate = *rc.FxRate
	}
	v := toUSD(*rc.TotalMicros, rate)
	if rc.Kind == "refund" || rc.Kind == "credit_note" {
		v = -v
	}
	return &v
}

// receiptMonth is the month a receipt counts in: its invoice date, or when it
// arrived while the date is unknown.
func receiptMonth(rc *fin.Receipt) string {
	if rc.IssueDate != nil {
		return rc.IssueDate.Format("2006-01")
	}
	return rc.CreatedAt.UTC().Format("2006-01")
}
