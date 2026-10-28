package finance

import (
	"context"
	"time"

	"github.com/uptrace/bun"
)

// Every report reads the ledger through countedEntries: live (not voided)
// entries, with payments limited to one billing mode so test data never mixes
// with live. Receipts that are pending or need attention have no entries, so
// they count nowhere until approved. P&L, summary and Ledger all share it, so
// their numbers agree.
func countedEntries(q *bun.SelectQuery, from, to time.Time, testMode bool) *bun.SelectQuery {
	return q.
		Where("l.voided_at IS NULL").
		Where("l.booked_date >= ? AND l.booked_date <= ?", from, to).
		Where("(l.source <> ? OR l.test_mode = ?)", SourceBilling, testMode)
}

// Bucket is one aggregate of counted entries. Month is "YYYY-MM" (” when the
// query was not split by month).
type Bucket struct {
	Month     string `bun:"month"`
	Direction string `bun:"direction"`
	Source    string `bun:"source"`
	VendorID  string `bun:"vendor_id"`
	USDMicros int64  `bun:"usd_micros"`
	Rows      int    `bun:"rows"`
	Models    int    `bun:"models"`
	Tenants   int    `bun:"tenants"`
	Receipts  int    `bun:"receipts"`
	Payments  int    `bun:"payments"`
}

// Buckets sums counted entries booked in [from, to] (dates, inclusive) by
// direction, source and vendor, and by month when byMonth.
func (r *Repository) Buckets(ctx context.Context, from, to time.Time, testMode, byMonth bool) ([]Bucket, error) {
	monthExpr := "''"
	if byMonth {
		monthExpr = "to_char(l.booked_date, 'YYYY-MM')"
	}
	var out []Bucket
	q := r.idb.NewSelect().
		TableExpr("finance_ledger_entries AS l").
		ColumnExpr(monthExpr+" AS month").
		ColumnExpr("l.direction, l.source, l.vendor_id").
		ColumnExpr("sum(l.amount_usd_micros) AS usd_micros").
		ColumnExpr("count(*) AS rows").
		ColumnExpr("count(DISTINCT l.model) AS models").
		ColumnExpr("count(DISTINCT l.tenant_id) AS tenants").
		ColumnExpr("count(DISTINCT l.receipt_id) AS receipts").
		ColumnExpr("count(DISTINCT l.source_ref) FILTER (WHERE l.source = ?) AS payments", SourceBilling)
	err := countedEntries(q, from, to, testMode).
		GroupExpr("1, l.direction, l.source, l.vendor_id").
		Scan(ctx, &out)
	return out, err
}

// LedgerFilter narrows the Ledger. Empty fields do not filter. Amount bounds
// compare the absolute USD amount.
type LedgerFilter struct {
	From, To   time.Time
	TestMode   bool
	Vendors    []string
	NotVendors []string
	Types      []string
	NotTypes   []string
	Sources    []string
	NotSources []string
	Tenants    []string
	Models     []string
	AmountMin  *int64
	AmountMax  *int64
	Invoice    string
	Query      string
}

func (f LedgerFilter) apply(q *bun.SelectQuery) *bun.SelectQuery {
	q = countedEntries(q, f.From, f.To, f.TestMode)
	in := func(col string, vals []string, negate bool) {
		if len(vals) == 0 {
			return
		}
		if negate {
			q = q.Where(col+" NOT IN (?)", bun.List(vals))
		} else {
			q = q.Where(col+" IN (?)", bun.List(vals))
		}
	}
	in("l.vendor_id", f.Vendors, false)
	in("l.vendor_id", f.NotVendors, true)
	in("l.direction", f.Types, false)
	in("l.direction", f.NotTypes, true)
	in("l.source", f.Sources, false)
	in("l.source", f.NotSources, true)
	in("l.tenant_id", f.Tenants, false)
	if len(f.Models) > 0 {
		q = q.WhereGroup(" AND ", func(q *bun.SelectQuery) *bun.SelectQuery {
			for _, m := range f.Models {
				q = q.WhereOr("l.model ILIKE ?", "%"+escapeLike(m)+"%")
			}
			return q
		})
	}
	if f.AmountMin != nil {
		q = q.Where("abs(l.amount_usd_micros) >= ?", *f.AmountMin)
	}
	if f.AmountMax != nil {
		q = q.Where("abs(l.amount_usd_micros) <= ?", *f.AmountMax)
	}
	if f.Invoice != "" {
		q = q.Where("l.receipt_id IN (SELECT id FROM finance_receipts WHERE invoice_number ILIKE ?)", "%"+escapeLike(f.Invoice)+"%")
	}
	if f.Query != "" {
		q = q.Where("l.description ILIKE ?", "%"+escapeLike(f.Query)+"%")
	}
	return q
}

func escapeLike(s string) string {
	out := make([]rune, 0, len(s))
	for _, c := range s {
		if c == '%' || c == '_' || c == '\\' {
			out = append(out, '\\')
		}
		out = append(out, c)
	}
	return string(out)
}

// groupKeyExpr groups AI usage and receipt-reading costs per vendor per day,
// and a receipt's lines, into one row each; everything else is its own row.
const groupKeyExpr = `CASE
	WHEN l.source = 'token_pipeline' THEN 'ai:' || to_char(l.booked_date, 'YYYY-MM-DD') || ':' || l.vendor_id
	WHEN l.source = 'receipt_extraction' THEN 'reading:' || to_char(l.booked_date, 'YYYY-MM-DD') || ':' || l.vendor_id
	WHEN l.source = 'receipt' AND l.receipt_id IS NOT NULL THEN 'receipt:' || l.receipt_id::text
	ELSE 'entry:' || l.id::text END`

// LedgerGroup is one Ledger row.
type LedgerGroup struct {
	Key            string    `bun:"gkey"`
	BookedDate     time.Time `bun:"booked_date"`
	VendorID       string    `bun:"vendor_id"`
	Source         string    `bun:"source"`
	Direction      string    `bun:"direction"`
	USDMicros      int64     `bun:"usd_micros"`
	OrigMicros     int64     `bun:"orig_micros"`
	Currency       string    `bun:"currency"`
	FxRate         *float64  `bun:"fx_rate"`
	Entries        int       `bun:"entries"`
	Models         int       `bun:"models"`
	Tenants        int       `bun:"tenants"`
	Description    string    `bun:"description"`
	ReceiptID      string    `bun:"receipt_id"`
	TenantID       string    `bun:"tenant_id"`
	Model          string    `bun:"model"`
	TestMode       bool      `bun:"test_mode"`
	InvoiceNumber  string    `bun:"invoice_number"`
	SourceRef      string    `bun:"source_ref"`
	ReceiptEntries int       `bun:"receipt_entries"`
}

// LedgerCursor is the keyset position after a row: booked date desc, then key desc.
type LedgerCursor struct {
	BookedDate time.Time
	Key        string
}

func (r *Repository) filtered(f LedgerFilter) *bun.SelectQuery {
	q := r.idb.NewSelect().
		TableExpr("finance_ledger_entries AS l").
		ColumnExpr("l.*").
		ColumnExpr(groupKeyExpr + " AS gkey")
	return f.apply(q)
}

// LedgerPage returns up to limit grouped rows after cursor (nil = first page).
func (r *Repository) LedgerPage(ctx context.Context, f LedgerFilter, cursor *LedgerCursor, limit int) ([]LedgerGroup, error) {
	q := r.idb.NewSelect().
		With("f", r.filtered(f)).
		TableExpr("f").
		ColumnExpr("f.gkey").
		ColumnExpr("max(f.booked_date) AS booked_date").
		ColumnExpr("min(f.vendor_id) AS vendor_id").
		ColumnExpr("min(f.source) AS source").
		ColumnExpr("min(f.direction) AS direction").
		ColumnExpr("sum(f.amount_usd_micros) AS usd_micros").
		ColumnExpr("sum(f.amount_micros) AS orig_micros").
		ColumnExpr("min(f.currency) AS currency").
		ColumnExpr("max(f.fx_rate)::float8 AS fx_rate").
		ColumnExpr("count(*) AS entries").
		ColumnExpr("count(DISTINCT f.model) AS models").
		ColumnExpr("count(DISTINCT f.tenant_id) AS tenants").
		ColumnExpr("min(f.description) AS description").
		ColumnExpr("COALESCE(min(f.receipt_id::text), '') AS receipt_id").
		ColumnExpr("COALESCE(min(f.tenant_id), '') AS tenant_id").
		ColumnExpr("COALESCE(min(f.model), '') AS model").
		ColumnExpr("bool_or(f.test_mode) AS test_mode").
		ColumnExpr("min(f.source_ref) AS source_ref").
		GroupExpr("f.gkey")

	outer := r.idb.NewSelect().
		With("g", q).
		TableExpr("g").
		ColumnExpr("g.*").
		ColumnExpr("COALESCE(rc.invoice_number, '') AS invoice_number").
		ColumnExpr(`COALESCE((SELECT count(*) FROM finance_ledger_entries le
			WHERE le.receipt_id::text = g.receipt_id AND le.voided_at IS NULL AND le.source = 'receipt'), 0) AS receipt_entries`).
		Join("LEFT JOIN finance_receipts AS rc ON rc.id::text = NULLIF(g.receipt_id, '')")
	if cursor != nil {
		outer = outer.Where("(g.booked_date, g.gkey) < (?, ?)", cursor.BookedDate, cursor.Key)
	}
	var out []LedgerGroup
	err := outer.OrderExpr("g.booked_date DESC, g.gkey DESC").Limit(limit).Scan(ctx, &out)
	return out, err
}

// LedgerTotals counts the grouped rows and entries and sums the filtered range.
type LedgerTotals struct {
	Rows      int   `bun:"rows"`
	Entries   int   `bun:"entries"`
	USDMicros int64 `bun:"usd_micros"`
}

func (r *Repository) LedgerTotals(ctx context.Context, f LedgerFilter) (LedgerTotals, error) {
	var out LedgerTotals
	err := r.idb.NewSelect().
		With("f", r.filtered(f)).
		TableExpr("f").
		ColumnExpr("count(DISTINCT f.gkey) AS rows").
		ColumnExpr("count(*) AS entries").
		ColumnExpr("COALESCE(sum(f.amount_usd_micros), 0) AS usd_micros").
		Scan(ctx, &out)
	return out, err
}

// LedgerChildren lists the entries of one grouped row, largest first.
func (r *Repository) LedgerChildren(ctx context.Context, f LedgerFilter, key string) ([]LedgerEntry, error) {
	var out []LedgerEntry
	err := r.idb.NewSelect().
		With("f", r.filtered(f)).
		TableExpr("f AS l").
		ColumnExpr("l.*").
		Where("l.gkey = ?", key).
		OrderExpr("abs(l.amount_usd_micros) DESC, l.id").
		Scan(ctx, &out)
	return out, err
}

// LatestAIDate is the newest day with materialised AI usage (nil when none).
func (r *Repository) LatestAIDate(ctx context.Context) (*time.Time, error) {
	var t *time.Time
	err := r.idb.NewRaw(`SELECT max(booked_date) FROM finance_ledger_entries WHERE source = ? AND voided_at IS NULL`,
		SourceTokenPipeline).Scan(ctx, &t)
	return t, err
}
