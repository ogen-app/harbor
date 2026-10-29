// Package finance is the judgement behind Harbor's Profit & loss page
// (CON-412/420): it ingests forwarded vendor receipts (via Ogen's
// ProcessReceipt), checks and posts them to the ledger, materialises AI usage
// from the token-cost pipeline, syncs payments from billing.v1, applies the
// operators' receipt actions with an audit trail, and builds the reports. The
// rows themselves live in src/repository/finance.
package finance

import (
	"context"
	"strings"
	"time"

	"github.com/ogen-app/harbor/src/repository/analytics"
	fin "github.com/ogen-app/harbor/src/repository/finance"
	"github.com/ogen-app/harbor/src/repository/ogenbilling"
	"github.com/ogen-app/harbor/src/repository/ogenreceipts"
)

// ReceiptProcessor is Ogen's ReceiptService. *ogenreceipts.Client satisfies it
// (a nil client returns ogenreceipts.ErrUnavailable).
type ReceiptProcessor interface {
	ProcessByResendID(ctx context.Context, resendEmailID string) (ogenreceipts.Result, error)
	ProcessRawMIME(ctx context.Context, raw []byte) (ogenreceipts.Result, error)
}

// PaymentSource is the billing.v1 surface the revenue sync reads.
// *ogenbilling.Client satisfies it.
type PaymentSource interface {
	Settings(ctx context.Context) (ogenbilling.Settings, error)
	ListPayments(ctx context.Context, from, to time.Time, testMode bool, pageSize int32, pageToken string) (ogenbilling.PaymentPage, error)
}

// UsageSource is the analytics spend pool the AI usage materialiser reads.
type UsageSource interface {
	DailyCostByModelTenant(ctx context.Context, from time.Time) ([]analytics.DailyModelTenantCost, error)
}

// OperatorDirectory says whether an address belongs to a Harbor operator: the
// only people whose forwards are accepted.
type OperatorDirectory interface {
	IsOperator(ctx context.Context, email string) (bool, error)
}

// Service holds the finance dependencies. Build it with New.
type Service struct {
	repo      *fin.Repository
	receipts  ReceiptProcessor
	payments  PaymentSource
	usage     UsageSource
	operators OperatorDirectory
	// drivers feeds shared cost allocation; nil leaves the Ogen and analytics
	// drivers unavailable.
	drivers DriverSource
	// vendorCosts reads what AI vendors charged; nil leaves reconciliation
	// to manually entered charges.
	vendorCosts VendorCostSource
	// inbox is the address operators forward receipts to ('' when unset).
	inbox string
	now   func() time.Time
}

func New(repo *fin.Repository, receipts ReceiptProcessor, payments PaymentSource, usage UsageSource, operators OperatorDirectory, drivers DriverSource, inbox string) *Service {
	return &Service{repo: repo, receipts: receipts, payments: payments, usage: usage, operators: operators, drivers: drivers, inbox: strings.TrimSpace(inbox), now: time.Now}
}

// SetVendorCosts wires the vendor cost reader behind reconciliation.
func (s *Service) SetVendorCosts(v VendorCostSource) { s.vendorCosts = v }

// Repo exposes the repository to the HTTP layer for plain reads.
func (s *Service) Repo() *fin.Repository { return s.repo }

// Effect is what a money-moving action did to the books: the signed USD
// amount it added (+) or removed (−), the month it lands in and the number of
// ledger entries it touched. Every mutation returns one and audits it.
type Effect struct {
	AmountMicros int64  `json:"amountMicros"`
	Month        string `json:"month"`
	Entries      int    `json:"entries"`
	Summary      string `json:"summary"`
}

func (e Effect) withSummary() Effect {
	month := monthLabel(e.Month)
	switch {
	case e.Entries == 0:
		e.Summary = "No change to the books"
	case e.AmountMicros >= 0:
		e.Summary = "Adds " + FormatMicros(e.AmountMicros, "USD") + " to " + month + " (" + plural(e.Entries, "entry", "entries") + ")"
	default:
		e.Summary = "Removes " + FormatMicros(-e.AmountMicros, "USD") + " from " + month + " (" + plural(e.Entries, "entry", "entries") + ")"
	}
	return e
}

// combine adds two effects (a re-post voids old entries and adds new ones).
func combine(a, b Effect) Effect {
	month := a.Month
	if month == "" {
		month = b.Month
	}
	return Effect{AmountMicros: a.AmountMicros + b.AmountMicros, Month: month, Entries: a.Entries + b.Entries}.withSummary()
}

func monthLabel(month string) string {
	t, err := time.Parse("2006-01", month)
	if err != nil {
		return month
	}
	return t.Format("Jan 2006")
}

func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return itoa(n) + " " + many
}

func itoa(n int) string { return groupThousands(int64(n)) }

// AIVendorForModel maps a model id to its pipeline vendor (” for non-AI),
// using the same classification as the Daily token cost chart.
func AIVendorForModel(model string) string {
	if !analytics.IsAIVendor(model) {
		return ""
	}
	m := strings.ToLower(model)
	if strings.Contains(m, "anthropic") || strings.Contains(m, "claude") {
		return "anthropic"
	}
	return "google"
}

func dateOnly(t time.Time) time.Time {
	t = t.UTC()
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

func parseDate(s string) *time.Time {
	t, err := time.Parse(time.DateOnly, strings.TrimSpace(s))
	if err != nil {
		return nil
	}
	return &t
}
