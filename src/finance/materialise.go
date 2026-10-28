package finance

import (
	"context"
	"fmt"
	"time"

	fin "github.com/ogen-app/harbor/src/repository/finance"
)

const (
	// SyncAIUsage is the sync-state key of the AI usage materialiser.
	SyncAIUsage = "ai_usage"
	// aiTrailingDays is how many days (today included) every pass re-reads, so
	// late-arriving usage events still land.
	aiTrailingDays = 3
)

// MaterialiseAIUsage copies AI consumption from the token-cost pipeline into
// the ledger as one expense row per UTC day × vendor × model × tenant, with
// the same bucketing as the Daily token cost chart. Non-AI rows (social
// platform usage also lands in vendor_usage_events) are skipped: Zernio is
// booked from its receipts and would otherwise count twice.
//
// The first successful pass backfills all history; later passes re-run the
// trailing days, upserting changed buckets and deleting vanished ones.
func (s *Service) MaterialiseAIUsage(ctx context.Context) error {
	state, err := s.repo.GetSync(ctx, SyncAIUsage)
	if err != nil {
		return err
	}
	today := dateOnly(s.now())
	from := today.AddDate(0, 0, -(aiTrailingDays - 1))
	if state.LastSuccessAt == nil {
		from = time.Time{}
	}

	rows, err := s.usage.DailyCostByModelTenant(ctx, from)
	if err != nil {
		_ = s.repo.SyncFailed(ctx, SyncAIUsage, err.Error())
		return fmt.Errorf("read AI usage: %w", err)
	}

	entries := make([]fin.LedgerEntry, 0, len(rows))
	for _, r := range rows {
		vendor := AIVendorForModel(r.Model)
		if vendor == "" || r.CostMicros == 0 {
			continue
		}
		day, err := time.Parse(time.DateOnly, r.Date)
		if err != nil {
			continue
		}
		e := fin.LedgerEntry{
			Direction:          fin.DirExpense,
			Source:             fin.SourceTokenPipeline,
			SourceRef:          r.Date,
			VendorID:           vendor,
			Description:        r.Model,
			AmountMicros:       r.CostMicros,
			Currency:           "USD",
			AmountUSDMicros:    r.CostMicros,
			ServicePeriodStart: &day,
			ServicePeriodEnd:   &day,
			BookedDate:         day,
			Model:              new(r.Model),
		}
		if r.TenantID != "" {
			e.TenantID = new(r.TenantID)
		}
		entries = append(entries, e)
	}

	err = s.repo.InTx(ctx, func(ctx context.Context, tx *fin.Repository) error {
		if err := tx.UpsertAIEntries(ctx, entries); err != nil {
			return fmt.Errorf("upsert AI usage: %w", err)
		}
		if _, err := tx.DeleteStaleAIEntries(ctx, from, today); err != nil {
			return fmt.Errorf("delete stale AI usage: %w", err)
		}
		return tx.SyncSucceeded(ctx, SyncAIUsage, &today)
	})
	if err != nil {
		_ = s.repo.SyncFailed(ctx, SyncAIUsage, err.Error())
	}
	return err
}
