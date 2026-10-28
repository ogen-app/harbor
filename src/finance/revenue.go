package finance

import (
	"context"
	"fmt"
	"strings"
	"time"

	fin "github.com/ogen-app/harbor/src/repository/finance"
	"github.com/ogen-app/harbor/src/repository/ogenbilling"
)

const (
	// revenueOverlap is how far back each pass re-reads, so a payment Ogen
	// lists again with changed amounts is re-upserted.
	revenueOverlap = 7 * 24 * time.Hour
	paymentPage    = 500
)

// SyncRevenueKey is the sync-state key for one billing mode.
func SyncRevenueKey(testMode bool) string {
	if testMode {
		return "revenue:test"
	}
	return "revenue:live"
}

// SyncRevenue copies the current billing mode's payments into the ledger:
// gross revenue, with tax and the provider fee as separate deducted entries,
// and refunds and chargebacks as negative revenue in the month they happen.
// It is idempotent on Ogen's payment id, and test and live payments are kept
// apart by their mode. The first pass backfills all history.
func (s *Service) SyncRevenue(ctx context.Context) error {
	settings, err := s.payments.Settings(ctx)
	if err != nil {
		_ = s.repo.SyncFailed(ctx, SyncRevenueKey(false), err.Error())
		_ = s.repo.SyncFailed(ctx, SyncRevenueKey(true), err.Error())
		return fmt.Errorf("read billing settings: %w", err)
	}
	key := SyncRevenueKey(settings.TestMode)
	state, err := s.repo.GetSync(ctx, key)
	if err != nil {
		return err
	}
	var from time.Time
	if state.LastSuccessAt != nil {
		from = state.LastSuccessAt.Add(-revenueOverlap)
	}

	var entries []fin.LedgerEntry
	token := ""
	for {
		page, err := s.payments.ListPayments(ctx, from, time.Time{}, settings.TestMode, paymentPage, token)
		if err != nil {
			_ = s.repo.SyncFailed(ctx, key, err.Error())
			return fmt.Errorf("list payments: %w", err)
		}
		for _, p := range page.Payments {
			entries = append(entries, PaymentEntries(p)...)
		}
		if page.NextPageToken == "" {
			break
		}
		token = page.NextPageToken
	}

	today := dateOnly(s.now())
	err = s.repo.InTx(ctx, func(ctx context.Context, tx *fin.Repository) error {
		if err := tx.UpsertPaymentEntries(ctx, entries); err != nil {
			return fmt.Errorf("upsert payments: %w", err)
		}
		return tx.SyncSucceeded(ctx, key, &today)
	})
	if err != nil {
		_ = s.repo.SyncFailed(ctx, key, err.Error())
	}
	return err
}

// PaymentEntries turns one payment into its ledger components. Amounts are
// signed: revenue positive; tax, fee and refunds negative (deducted).
func PaymentEntries(p ogenbilling.Payment) []fin.LedgerEntry {
	day := dateOnly(p.OccurredAt)
	ref := "#" + p.ProviderID
	base := fin.LedgerEntry{
		Source:     fin.SourceBilling,
		SourceRef:  p.ID,
		VendorID:   fin.VendorLemonSqueezy,
		Currency:   strings.ToUpper(p.Currency),
		BookedDate: day,
		TestMode:   p.TestMode,
	}
	if p.TenantID != "" {
		base.TenantID = new(p.TenantID)
	}
	if base.Currency != "USD" && p.Total != 0 && p.TotalUSD != 0 {
		// USD per unit of currency, from the provider's own conversion.
		rate := float64(centsToMicros(p.TotalUSD)) / float64(minorToMicros(p.Currency, p.Total))
		base.FxRate = &rate
		base.FxDate = &day
	}
	entry := func(direction, desc string, sign, minor, usdCents int64) fin.LedgerEntry {
		e := base
		e.Direction = direction
		e.Description = desc
		e.AmountMicros = sign * minorToMicros(p.Currency, minor)
		e.AmountUSDMicros = sign * centsToMicros(usdCents)
		return e
	}

	var out []fin.LedgerEntry
	switch p.Kind {
	case "refund", "chargeback":
		word := "Refund"
		if p.Kind == "chargeback" {
			word = "Chargeback"
		}
		out = append(out, entry(fin.DirRefund, word+" of "+ref, -1, p.Total, p.TotalUSD))
	default:
		desc := "Subscription payment " + ref
		if p.Kind == "order" {
			desc = "Order " + ref
		}
		out = append(out, entry(fin.DirRevenue, desc, 1, p.Total, p.TotalUSD))
		if p.Tax != 0 {
			out = append(out, entry(fin.DirTax, "Tax on "+ref, -1, p.Tax, p.TaxUSD))
		}
		if p.Fee != 0 {
			desc := "Fee on " + ref
			if p.FeeIsEstimated {
				desc += " (estimated)"
			}
			out = append(out, entry(fin.DirFee, desc, -1, p.Fee, p.FeeUSD))
		}
	}
	return out
}

func centsToMicros(c int64) int64 { return c * 10_000 }

// zeroDecimal lists ISO 4217 currencies whose minor unit is the major unit.
var zeroDecimal = map[string]bool{"JPY": true, "KRW": true, "VND": true, "CLP": true, "ISK": true}

func minorToMicros(currency string, minor int64) int64 {
	if zeroDecimal[strings.ToUpper(currency)] {
		return minor * 1_000_000
	}
	return minor * 10_000
}
