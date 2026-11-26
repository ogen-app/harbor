package finance

import (
	"context"
	"fmt"
	"strconv"
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
//
// A payment Ogen has not converted to USD yet (its ECB rate is not known) is
// left out, and the oldest one is kept as the sync's pending_from: later passes
// read back to it, however far behind the overlap window, until it converts.
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
		if state.PendingFrom != nil && state.PendingFrom.Before(from) {
			from = *state.PendingFrom
		}
	}

	var entries []fin.LedgerEntry
	var pendingFrom *time.Time
	token := ""
	for {
		page, err := s.payments.ListPayments(ctx, from, time.Time{}, settings.TestMode, paymentPage, token)
		if err != nil {
			_ = s.repo.SyncFailed(ctx, key, err.Error())
			return fmt.Errorf("list payments: %w", err)
		}
		for _, p := range page.Payments {
			if p.TotalUSD == nil {
				if pendingFrom == nil || p.OccurredAt.Before(*pendingFrom) {
					pendingFrom = new(p.OccurredAt)
				}
				continue
			}
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
		if err := tx.SyncSucceeded(ctx, key, &today); err != nil {
			return err
		}
		return tx.SetSyncPendingFrom(ctx, key, pendingFrom)
	})
	if err != nil {
		_ = s.repo.SyncFailed(ctx, key, err.Error())
	}
	return err
}

// PaymentEntries turns one payment into its ledger components. Amounts are
// signed: revenue positive; tax, fee and refunds negative (deducted). It returns
// nothing for a payment whose USD amounts are not known yet: the ledger's USD
// column is required, and a guessed rate would be booked as fact.
func PaymentEntries(p ogenbilling.Payment) []fin.LedgerEntry {
	if p.TotalUSD == nil {
		return nil
	}
	day := dateOnly(p.OccurredAt)
	ref := "#" + p.ProviderID
	base := fin.LedgerEntry{
		Source:     fin.SourceBilling,
		SourceRef:  p.ID,
		VendorID:   paymentVendor(p.Provider),
		Currency:   strings.ToUpper(p.Currency),
		BookedDate: day,
		TestMode:   p.TestMode,
	}
	if p.TenantID != "" {
		base.TenantID = new(p.TenantID)
	}
	paymentFx(&base, p, day)
	entry := func(direction, desc string, sign, minor int64, usdCents *int64) fin.LedgerEntry {
		e := base
		e.Direction = direction
		e.Description = desc
		e.AmountMicros = sign * minorToMicros(p.Currency, minor)
		if usdCents != nil {
			e.AmountUSDMicros = sign * centsToMicros(*usdCents)
		}
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

// paymentVendor is the revenue vendor of a billing provider. An unknown
// provider is booked under Polar, the running one.
func paymentVendor(provider string) string {
	if provider == fin.VendorLemonSqueezy {
		return fin.VendorLemonSqueezy
	}
	return fin.VendorPolar
}

// paymentFx records the conversion on a non-USD payment. Ogen's own rate (Polar
// payments, converted at the ECB reference rate) is used as is; for Lemon
// Squeezy, which converted its own amounts, the rate is derived from them.
func paymentFx(e *fin.LedgerEntry, p ogenbilling.Payment, day time.Time) {
	if p.FxSource != "" {
		e.FxSource = new(p.FxSource)
	}
	if e.Currency == "USD" {
		return
	}
	if rate, err := strconv.ParseFloat(p.FxRate, 64); err == nil && rate > 0 {
		e.FxRate = &rate
		e.FxDate = &day
		if d, err := time.Parse(time.DateOnly, p.FxDate); err == nil {
			e.FxDate = &d
		}
		return
	}
	if p.Total != 0 && *p.TotalUSD != 0 {
		rate := float64(centsToMicros(*p.TotalUSD)) / float64(minorToMicros(p.Currency, p.Total))
		e.FxRate = &rate
		e.FxDate = &day
	}
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
