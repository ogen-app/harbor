package finance

import (
	"cmp"
	"context"
	"fmt"
	"maps"
	"slices"
	"time"

	fin "github.com/ogen-app/harbor/src/repository/finance"
)

// ── Daily burn ──────────────────────────────────────────────────────────────

type DailyVendor struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	IsAIPipeline bool   `json:"isAiPipeline"`
}

// DailyReceipt is the receipt spend one vendor booked on one day. Receipts
// count on their invoice date, so they make the running expense total jump.
type DailyReceipt struct {
	VendorID     string `json:"vendorId"`
	Count        int    `json:"count"`
	AmountMicros int64  `json:"amountMicros"`
}

type DailyPoint struct {
	Date             string           `json:"date"`
	NetRevenue       *int64           `json:"netRevenue"` // null while revenue is unavailable
	Expenses         int64            `json:"expenses"`
	ExpensesByVendor map[string]int64 `json:"expensesByVendor"`
	Receipts         []DailyReceipt   `json:"receipts"`
}

// DailyTotals is one period's P&L. Net revenue and profit are null while
// revenue is unavailable.
type DailyTotals struct {
	NetRevenue *int64 `json:"netRevenue"`
	Expenses   int64  `json:"expenses"`
	Profit     *int64 `json:"profit"`
}

type Daily struct {
	Month            string        `json:"month"`
	Period           Period        `json:"period"`
	Compare          Period        `json:"compare"`
	RevenueAvailable bool          `json:"revenueAvailable"`
	RevenueError     string        `json:"revenueError"`
	TestMode         bool          `json:"testMode"`
	Vendors          []DailyVendor `json:"vendors"` // expense vendors with spend, in P&L order
	Days             []DailyPoint  `json:"days"`
	Totals           DailyTotals   `json:"totals"`
	Previous         DailyTotals   `json:"previous"`
	Provisional      *Provisional  `json:"provisional"`
}

// Daily is one UTC month day by day, up to today. It folds the same ledger
// buckets as Monthly, so its days add up to the month's column. A month still
// running compares with the same days of the month before (as Summary does); a
// whole month compares with the whole month before.
func (s *Service) Daily(ctx context.Context, month time.Time) (Daily, error) {
	today := dateOnly(s.now())
	start := time.Date(month.Year(), month.Month(), 1, 0, 0, 0, 0, time.UTC)
	monthEnd := start.AddDate(0, 1, -1)
	end := earliest(monthEnd, today)
	prevStart := start.AddDate(0, -1, 0)
	prevEnd := start.AddDate(0, 0, -1)
	if end.Before(monthEnd) && !end.Before(start) {
		prevEnd = earliest(prevStart.AddDate(0, 0, end.Day()-1), prevEnd)
	}

	out := Daily{
		Month:   start.Format("2006-01"),
		Period:  Period{From: start.Format(time.DateOnly), To: end.Format(time.DateOnly), Label: fmt.Sprintf("%s 1–%d", start.Format("January"), end.Day())},
		Compare: Period{From: prevStart.Format(time.DateOnly), To: prevEnd.Format(time.DateOnly), Label: dayRange(prevStart, prevEnd)},
		Vendors: []DailyVendor{},
		Days:    []DailyPoint{},
	}

	testMode, rev, err := s.revenueMode(ctx)
	if err != nil {
		return out, err
	}
	out.TestMode = testMode
	out.RevenueAvailable = rev.LastSuccessAt != nil
	if !out.RevenueAvailable {
		out.RevenueError = cmp.Or(rev.LastError, "Payments have not been synced yet")
	}

	prev, err := s.periodTotals(ctx, prevStart, prevEnd, testMode)
	if err != nil {
		return out, err
	}
	out.Previous = dailyTotals(prev, out.RevenueAvailable)

	if end.Before(start) {
		// A month that hasn't started has no days yet.
		out.Period.To, out.Period.Label = "", start.Format("January")
		return out, nil
	}

	buckets, err := s.repo.Buckets(ctx, start, end, testMode, fin.GrainDay)
	if err != nil {
		return out, err
	}
	vendors, err := s.repo.ListVendors(ctx)
	if err != nil {
		return out, err
	}
	vendorByID := map[string]fin.Vendor{}
	for _, v := range vendors {
		vendorByID[v.ID] = v
	}

	byDay := map[string]*totals{}
	var cur totals
	for _, b := range buckets {
		t := byDay[b.Period]
		if t == nil {
			t = &totals{}
			byDay[b.Period] = t
		}
		t.add(b)
		cur.add(b)
	}
	out.Totals = dailyTotals(cur, out.RevenueAvailable)

	idx := map[string]int{}
	for d := start; !d.After(end); d = d.AddDate(0, 0, 1) {
		key := d.Format(time.DateOnly)
		var t totals
		if x := byDay[key]; x != nil {
			t = *x
		}
		p := DailyPoint{Date: key, Expenses: t.expenses, ExpensesByVendor: map[string]int64{}, Receipts: []DailyReceipt{}}
		if out.RevenueAvailable {
			p.NetRevenue = new(t.net())
		}
		idx[key] = len(out.Days)
		out.Days = append(out.Days, p)
	}

	spent := map[string]bool{}
	for _, b := range buckets {
		i, ok := idx[b.Period]
		if !ok || b.Direction != fin.DirExpense {
			continue
		}
		p := &out.Days[i]
		p.ExpensesByVendor[b.VendorID] += b.USDMicros
		spent[b.VendorID] = true
		if b.Source == fin.SourceReceipt {
			p.Receipts = append(p.Receipts, DailyReceipt{VendorID: b.VendorID, Count: b.Receipts, AmountMicros: b.USDMicros})
		}
	}
	ids := slices.Collect(maps.Keys(spent))
	sortVendorIDs(ids, vendorByID)
	for _, id := range ids {
		v := vendorByID[id]
		out.Vendors = append(out.Vendors, DailyVendor{ID: id, Name: cmp.Or(v.Name, id), IsAIPipeline: v.IsAIPipeline})
	}
	for i := range out.Days {
		slices.SortFunc(out.Days[i].Receipts, func(a, b DailyReceipt) int {
			return cmp.Compare(slices.Index(ids, a.VendorID), slices.Index(ids, b.VendorID))
		})
	}

	pending, err := s.pendingByMonth(ctx)
	if err != nil {
		return out, err
	}
	var p Provisional
	for _, c := range pending {
		if c.month == out.Month {
			p.Count += c.count
			p.AmountMicros += c.amount
		}
	}
	if p.Count > 0 {
		p.Month = out.Month
		out.Provisional = &p
	}
	return out, nil
}

func dailyTotals(t totals, revenueAvailable bool) DailyTotals {
	out := DailyTotals{Expenses: t.expenses}
	if revenueAvailable {
		out.NetRevenue = new(t.net())
		out.Profit = new(t.net() - t.expenses)
	}
	return out
}
