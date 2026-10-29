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

// Freshness thresholds for the header status.
const (
	aiStaleAfter      = 24 * time.Hour
	revenueStaleAfter = time.Hour
)

// ── Status ──────────────────────────────────────────────────────────────────

type SourceState struct {
	State       string     `json:"state"` // ok | stale | unavailable
	ThroughDate *string    `json:"throughDate"`
	LastRunAt   *time.Time `json:"lastRunAt"`  // AI usage
	LastSyncAt  *time.Time `json:"lastSyncAt"` // revenue
	TestMode    bool       `json:"testMode"`
	Error       string     `json:"error"`
}

type InboxState struct {
	InboxAddress   string     `json:"inboxAddress"`
	LastReceivedAt *time.Time `json:"lastReceivedAt"`
	PendingEmails  int        `json:"pendingEmails"`
	EverReceived   bool       `json:"everReceived"`
}

type AttentionCounts struct {
	Open             int   `json:"open"`
	OpenAmountMicros int64 `json:"openAmountMicros"`
	Rejected         int   `json:"rejected"`
}

type Status struct {
	AIUsage   SourceState     `json:"aiUsage"`
	Revenue   SourceState     `json:"revenue"`
	Receipts  InboxState      `json:"receipts"`
	Attention AttentionCounts `json:"attention"`
}

// revenueMode is the billing mode the revenue sync last ran in, and its state.
// Reports show that mode's payments only.
func (s *Service) revenueMode(ctx context.Context) (bool, fin.SyncState, error) {
	live, err := s.repo.GetSync(ctx, SyncRevenueKey(false))
	if err != nil {
		return false, live, err
	}
	test, err := s.repo.GetSync(ctx, SyncRevenueKey(true))
	if err != nil {
		return false, live, err
	}
	// Prefer the mode that last succeeded; then the one last attempted.
	switch {
	case test.LastSuccessAt != nil && (live.LastSuccessAt == nil || test.LastSuccessAt.After(*live.LastSuccessAt)):
		return true, test, nil
	case live.LastSuccessAt != nil:
		return false, live, nil
	}
	return false, live, nil
}

func (s *Service) Status(ctx context.Context) (Status, error) {
	var out Status
	now := s.now()

	ai, err := s.repo.GetSync(ctx, SyncAIUsage)
	if err != nil {
		return out, err
	}
	out.AIUsage = SourceState{State: "ok", LastRunAt: ai.LastSuccessAt, Error: ai.LastError}
	switch {
	case ai.LastSuccessAt == nil:
		out.AIUsage.State = "unavailable"
		out.AIUsage.Error = cmp.Or(ai.LastError, "AI usage has not been read yet")
	case now.Sub(*ai.LastSuccessAt) > aiStaleAfter:
		out.AIUsage.State = "stale"
	}
	if d, err := s.repo.LatestAIDate(ctx); err == nil && d != nil {
		out.AIUsage.ThroughDate = new(d.Format(time.DateOnly))
	}

	testMode, rev, err := s.revenueMode(ctx)
	if err != nil {
		return out, err
	}
	out.Revenue = SourceState{State: "ok", LastSyncAt: rev.LastSuccessAt, TestMode: testMode, Error: rev.LastError}
	switch {
	case rev.LastSuccessAt == nil:
		out.Revenue.State = "unavailable"
		out.Revenue.Error = cmp.Or(rev.LastError, "Payments have not been synced yet")
	case rev.LastError != "" && now.Sub(*rev.LastSuccessAt) > revenueStaleAfter:
		out.Revenue.State = "stale"
	}

	out.Receipts.InboxAddress = s.inbox
	if out.Receipts.LastReceivedAt, err = s.repo.LastReceivedAt(ctx); err != nil {
		return out, err
	}
	out.Receipts.EverReceived = out.Receipts.LastReceivedAt != nil
	if out.Receipts.PendingEmails, err = s.repo.CountEmails(ctx, fin.EmailPending); err != nil {
		return out, err
	}

	open, err := s.repo.ReceiptsByStatus(ctx, fin.StatusNeedsAttention)
	if err != nil {
		return out, err
	}
	failed, err := s.repo.CountEmails(ctx, fin.EmailFailed)
	if err != nil {
		return out, err
	}
	out.Attention.Open = len(open) + failed
	for i := range open {
		if v := receiptUSD(&open[i]); v != nil {
			out.Attention.OpenAmountMicros += *v
		}
	}
	rejected, err := s.repo.ReceiptsByStatus(ctx, fin.StatusRejected)
	if err != nil {
		return out, err
	}
	out.Attention.Rejected = len(rejected)
	return out, nil
}

// ── Totals ──────────────────────────────────────────────────────────────────

// totals is one period's P&L, folded from ledger buckets.
type totals struct {
	gross, tax, fees, refunds, expenses, prepaid int64
}

func (t totals) net() int64 { return t.gross + t.tax + t.fees + t.refunds }

func (t *totals) add(b fin.Bucket) {
	switch b.Direction {
	case fin.DirRevenue:
		t.gross += b.USDMicros
	case fin.DirTax:
		t.tax += b.USDMicros
	case fin.DirFee:
		t.fees += b.USDMicros
	case fin.DirRefund:
		t.refunds += b.USDMicros
	case fin.DirExpense:
		t.expenses += b.USDMicros
	case fin.DirPrepayment:
		t.prepaid += b.USDMicros
	}
}

func marginPct(profit, net int64) *float64 {
	if net <= 0 {
		return nil
	}
	return new(float64(profit) / float64(net) * 100)
}

// ── Summary ─────────────────────────────────────────────────────────────────

type Period struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Label string `json:"label"`
}

type Figure[T int64 | float64] struct {
	Value    *T `json:"value"`
	Previous *T `json:"previous"`
}

type Provisional struct {
	Month        string `json:"month"`
	Count        int    `json:"count"`
	AmountMicros int64  `json:"amountMicros"`
}

type Summary struct {
	Period         Period          `json:"period"`
	Compare        Period          `json:"compare"`
	NetRevenue     Figure[int64]   `json:"netRevenue"`
	Expenses       Figure[int64]   `json:"expenses"`
	Profit         Figure[int64]   `json:"profit"`
	MarginPct      Figure[float64] `json:"marginPct"`
	PrepaidCredits Figure[int64]   `json:"prepaidCredits"`
	Provisional    *Provisional    `json:"provisional"`
	AsOf           time.Time       `json:"asOf"`
}

// Summary compares this month to date with the same days of last month, so a
// partial month is never compared with a whole one.
func (s *Service) Summary(ctx context.Context) (Summary, error) {
	now := s.now().UTC()
	today := dateOnly(now)
	start := time.Date(today.Year(), today.Month(), 1, 0, 0, 0, 0, time.UTC)
	prevStart := start.AddDate(0, -1, 0)
	prevEnd := earliest(prevStart.AddDate(0, 0, today.Day()-1), start.AddDate(0, 0, -1))

	testMode, rev, err := s.revenueMode(ctx)
	if err != nil {
		return Summary{}, err
	}
	cur, err := s.periodTotals(ctx, start, today, testMode)
	if err != nil {
		return Summary{}, err
	}
	prev, err := s.periodTotals(ctx, prevStart, prevEnd, testMode)
	if err != nil {
		return Summary{}, err
	}

	out := Summary{
		Period:         Period{From: start.Format(time.DateOnly), To: today.Format(time.DateOnly), Label: fmt.Sprintf("%s to date (%s)", start.Format("January"), dayRange(start, today))},
		Compare:        Period{From: prevStart.Format(time.DateOnly), To: prevEnd.Format(time.DateOnly), Label: dayRange(prevStart, prevEnd)},
		Expenses:       Figure[int64]{Value: new(cur.expenses), Previous: new(prev.expenses)},
		PrepaidCredits: Figure[int64]{Value: new(cur.prepaid), Previous: new(prev.prepaid)},
		AsOf:           now,
	}
	// Unavailable revenue is never shown as zero: net, profit and margin stay null.
	if rev.LastSuccessAt != nil {
		cp, pp := cur.net()-cur.expenses, prev.net()-prev.expenses
		out.NetRevenue = Figure[int64]{Value: new(cur.net()), Previous: new(prev.net())}
		out.Profit = Figure[int64]{Value: &cp, Previous: &pp}
		out.MarginPct = Figure[float64]{Value: marginPct(cp, cur.net()), Previous: marginPct(pp, prev.net())}
	}

	pending, err := s.pendingByMonth(ctx)
	if err != nil {
		return Summary{}, err
	}
	month := start.Format("2006-01")
	var p Provisional
	for _, c := range pending {
		if c.month == month {
			p.Count += c.count
			p.AmountMicros += c.amount
		}
	}
	if p.Count > 0 {
		p.Month = month
		out.Provisional = &p
	}
	return out, nil
}

func (s *Service) periodTotals(ctx context.Context, from, to time.Time, testMode bool) (totals, error) {
	buckets, err := s.repo.Buckets(ctx, from, to, testMode, fin.GrainNone)
	if err != nil {
		return totals{}, err
	}
	var t totals
	for _, b := range buckets {
		t.add(b)
	}
	return t, nil
}

func dayRange(from, to time.Time) string {
	if from.Equal(to) {
		return from.Format("Jan 2")
	}
	return fmt.Sprintf("%s–%d", from.Format("Jan 2"), to.Day())
}

// pendingCell is the receipts waiting in Needs attention for one vendor and
// month. They count nowhere until approved.
type pendingCell struct {
	month, vendor string
	count         int
	amount        int64
}

func (s *Service) pendingByMonth(ctx context.Context) ([]pendingCell, error) {
	open, err := s.repo.ReceiptsByStatus(ctx, fin.StatusNeedsAttention)
	if err != nil {
		return nil, err
	}
	idx := map[[2]string]int{}
	var out []pendingCell
	for i := range open {
		rc := &open[i]
		vendor := "unmatched"
		if rc.VendorID != nil {
			vendor = *rc.VendorID
		}
		key := [2]string{receiptMonth(rc), vendor}
		j, ok := idx[key]
		if !ok {
			j = len(out)
			idx[key] = j
			out = append(out, pendingCell{month: key[0], vendor: vendor})
		}
		out[j].count++
		if v := receiptUSD(rc); v != nil {
			out[j].amount += *v
		}
	}
	return out, nil
}

// ── Monthly P&L ─────────────────────────────────────────────────────────────

type Provenance struct {
	Rows     int `json:"rows"`
	Models   int `json:"models"`
	Tenants  int `json:"tenants"`
	Receipts int `json:"receipts"`
	Payments int `json:"payments"`
}

func (p *Provenance) add(b fin.Bucket) {
	p.Rows += b.Rows
	p.Models += b.Models
	p.Tenants += b.Tenants
	p.Receipts += b.Receipts
	p.Payments += b.Payments
}

type PendingAmount struct {
	Count        int   `json:"count"`
	AmountMicros int64 `json:"amountMicros"`
}

type Drill struct {
	From      string   `json:"from"`
	To        string   `json:"to"`
	Vendor    string   `json:"vendor,omitempty"`
	Direction []string `json:"direction,omitempty"`
	Source    []string `json:"source,omitempty"`
	Tenant    string   `json:"tenant,omitempty"`
}

type Cell struct {
	Value       *float64       `json:"value"`
	Unavailable bool           `json:"unavailable"`
	Pending     *PendingAmount `json:"pending"`
	// Awaiting marks a shared vendor's month whose bill isn't posted yet: its
	// allocation counts as 0 until the receipt is approved (tenant P&L).
	Awaiting   bool       `json:"awaiting,omitzero"`
	Provenance Provenance `json:"provenance"`
	Drill      *Drill     `json:"drill"`
}

type Row struct {
	Key         string `json:"key"`
	Section     string `json:"section"` // revenue | expenses | profit | memo
	Label       string `json:"label"`
	SourceLabel string `json:"sourceLabel"`
	Kind        string `json:"kind"` // line | total | margin
	VendorID    string `json:"vendorId"`
	Cells       []Cell `json:"cells"`
	Total       Cell   `json:"total"`
}

type Monthly struct {
	Months           []string      `json:"months"`
	RevenueAvailable bool          `json:"revenueAvailable"`
	RevenueError     string        `json:"revenueError"`
	Rows             []Row         `json:"rows"`
	Provisional      []Provisional `json:"provisional"`
}

// MaxMonths bounds the monthly table.
const MaxMonths = 36

// grid builds rows of per-month cells from ledger buckets. Monthly and
// TenantPnL share it, so a figure is folded the same way on both.
type grid struct {
	months  []time.Time
	col     map[string]int
	buckets []fin.Bucket
	today   time.Time
	// tenant scopes every drill to one tenant's entries ('' = all).
	tenant string
}

// monthsIn lists the whole UTC months [from, to], at most MaxMonths.
func monthsIn(fromMonth, toMonth time.Time) []time.Time {
	var months []time.Time
	for m := fromMonth; !m.After(toMonth) && len(months) < MaxMonths; m = m.AddDate(0, 1, 0) {
		months = append(months, m)
	}
	return months
}

func monthKeys(months []time.Time) []string {
	out := make([]string, len(months))
	for i, m := range months {
		out[i] = m.Format("2006-01")
	}
	return out
}

func newGrid(months []time.Time, buckets []fin.Bucket, today time.Time, tenant string) *grid {
	g := &grid{months: months, col: map[string]int{}, buckets: buckets, today: today, tenant: tenant}
	for i, m := range monthKeys(months) {
		g.col[m] = i
	}
	return g
}

func (g *grid) end() time.Time { return g.months[len(g.months)-1].AddDate(0, 1, -1) }

func (g *grid) monthDrill(d Drill, i int) *Drill {
	d.From = g.months[i].Format(time.DateOnly)
	d.To = earliest(g.months[i].AddDate(0, 1, -1), g.today).Format(time.DateOnly)
	d.Tenant = g.tenant
	return &d
}

func (g *grid) rangeDrill(d Drill) *Drill {
	d.From = g.months[0].Format(time.DateOnly)
	d.To = earliest(g.end(), g.today).Format(time.DateOnly)
	d.Tenant = g.tenant
	return &d
}

// row sums the buckets that match into one row with per-month cells.
func (g *grid) row(key, section, label, sourceLabel, vendorID string, drill Drill, match func(fin.Bucket) bool) Row {
	n := len(g.months)
	r := Row{Key: key, Section: section, Label: label, SourceLabel: sourceLabel, Kind: "line", VendorID: vendorID,
		Cells: make([]Cell, n)}
	var total int64
	found := false
	sums := make([]int64, n)
	has := make([]bool, n)
	for _, b := range g.buckets {
		i, ok := g.col[b.Period]
		if !ok || !match(b) {
			continue
		}
		sums[i] += b.USDMicros
		has[i] = true
		r.Cells[i].Provenance.add(b)
		r.Total.Provenance.add(b)
		total += b.USDMicros
		found = true
	}
	for i := range n {
		if has[i] {
			r.Cells[i].Value = new(float64(sums[i]))
		}
		r.Cells[i].Drill = g.monthDrill(drill, i)
	}
	if found {
		r.Total.Value = new(float64(total))
	}
	r.Total.Drill = g.rangeDrill(drill)
	return r
}

// sum adds rows cell by cell; a missing value counts as zero.
func (g *grid) sum(key, section, label, kind string, rows ...Row) Row {
	r := Row{Key: key, Section: section, Label: label, Kind: kind, Cells: make([]Cell, len(g.months))}
	for i := range g.months {
		var v int64
		for _, x := range rows {
			if x.Cells[i].Value != nil {
				v += int64(*x.Cells[i].Value)
			}
		}
		r.Cells[i].Value = new(float64(v))
	}
	var t int64
	for _, x := range rows {
		if x.Total.Value != nil {
			t += int64(*x.Total.Value)
		}
	}
	r.Total.Value = new(float64(t))
	return r
}

func isDir(d string) func(fin.Bucket) bool {
	return func(b fin.Bucket) bool { return b.Direction == d }
}

// revenue builds the revenue section: gross, fees, tax (only when there is
// any), refunds and the net total. Net is returned on its own as well.
func (g *grid) revenue() ([]Row, Row) {
	revSrc := []string{fin.SourceBilling}
	gross := g.row("revenue_gross", "revenue", "Lemon Squeezy, gross", "Payments", fin.VendorLemonSqueezy,
		Drill{Direction: []string{fin.DirRevenue}, Source: revSrc}, isDir(fin.DirRevenue))
	fees := g.row("fees", "revenue", "Fees (deducted)", "", "", Drill{Direction: []string{fin.DirFee}, Source: revSrc}, isDir(fin.DirFee))
	tax := g.row("tax", "revenue", "Tax (deducted)", "", "", Drill{Direction: []string{fin.DirTax}, Source: revSrc}, isDir(fin.DirTax))
	refunds := g.row("refunds", "revenue", "Refunds (deducted)", "", "", Drill{Direction: []string{fin.DirRefund}, Source: revSrc}, isDir(fin.DirRefund))
	net := g.sum("net_revenue", "revenue", "Net revenue", "total", gross, fees, tax, refunds)
	net.Total.Drill = g.rangeDrill(Drill{Source: revSrc})
	rows := []Row{gross, fees}
	if tax.Total.Value != nil {
		rows = append(rows, tax)
	}
	return append(rows, refunds, net), net
}

// result fills the bottom line (net minus costs) and its margin, per month and
// for the range. The margin is blank when net revenue is zero or less.
func (g *grid) result(result, margin *Row, net, costs Row) {
	cells := func(n, e *float64) (Cell, Cell) {
		p := new(*n - *e)
		var m Cell
		if *n > 0 {
			m.Value = new(*p / *n * 100)
		}
		return Cell{Value: p}, m
	}
	result.Cells, margin.Cells = make([]Cell, len(g.months)), make([]Cell, len(g.months))
	for i := range g.months {
		result.Cells[i], margin.Cells[i] = cells(net.Cells[i].Value, costs.Cells[i].Value)
	}
	result.Total, margin.Total = cells(net.Total.Value, costs.Total.Value)
}

// markUnavailable blanks rows that depend on revenue when it could not be
// read: revenue never shows as zero. Rows are pointers so the Total, a value
// field, is blanked on the row itself and not on a copy.
func markUnavailable(rows ...*Row) {
	for _, r := range rows {
		for j := range r.Cells {
			r.Cells[j] = Cell{Unavailable: true}
		}
		r.Total = Cell{Unavailable: true}
	}
}

func rowPtrs(rows []Row) []*Row {
	out := make([]*Row, len(rows))
	for i := range rows {
		out[i] = &rows[i]
	}
	return out
}

// Monthly builds the P&L table for whole UTC months [from, to] ("YYYY-MM").
func (s *Service) Monthly(ctx context.Context, fromMonth, toMonth time.Time) (Monthly, error) {
	today := dateOnly(s.now())
	months := monthsIn(fromMonth, toMonth)
	out := Monthly{Months: monthKeys(months), Rows: []Row{}, Provisional: []Provisional{}}
	if len(months) == 0 {
		return out, nil
	}
	rangeEnd := months[len(months)-1].AddDate(0, 1, -1)

	testMode, rev, err := s.revenueMode(ctx)
	if err != nil {
		return out, err
	}
	out.RevenueAvailable = rev.LastSuccessAt != nil
	if !out.RevenueAvailable {
		out.RevenueError = cmp.Or(rev.LastError, "Payments have not been synced yet")
	}
	buckets, err := s.repo.Buckets(ctx, months[0], rangeEnd, testMode, fin.GrainMonth)
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
	pending, err := s.pendingByMonth(ctx)
	if err != nil {
		return out, err
	}

	g := newGrid(months, buckets, today, "")
	col := g.col
	revenueRows, net := g.revenue()

	// Expenses per vendor: AI-pipeline vendors first, then by name.
	expVendors := map[string]bool{}
	expSources := map[string]map[string]bool{}
	for _, b := range buckets {
		if b.Direction == fin.DirExpense {
			expVendors[b.VendorID] = true
			if expSources[b.VendorID] == nil {
				expSources[b.VendorID] = map[string]bool{}
			}
			expSources[b.VendorID][b.Source] = true
		}
	}
	for _, p := range pending {
		if _, ok := col[p.month]; ok {
			expVendors[p.vendor] = true
		}
	}
	ids := make([]string, 0, len(expVendors))
	for id := range expVendors {
		ids = append(ids, id)
	}
	sortVendorIDs(ids, vendorByID)
	var expenseRows []Row
	for _, id := range ids {
		v := vendorByID[id]
		label := cmp.Or(v.Name, id)
		if id == "unmatched" {
			label = "Unmatched vendor"
		}
		r := g.row("expense:"+id, "expenses", label, expenseSourceLabel(v, expSources[id]), id,
			Drill{Vendor: id, Direction: []string{fin.DirExpense}},
			func(b fin.Bucket) bool { return b.Direction == fin.DirExpense && b.VendorID == id })
		if id == "unmatched" {
			r.VendorID = ""
			for i := range r.Cells {
				r.Cells[i].Drill = nil
			}
			r.Total.Drill = nil
		}
		var pendTotal PendingAmount
		for _, p := range pending {
			if i, ok := col[p.month]; ok && p.vendor == id {
				r.Cells[i].Pending = &PendingAmount{Count: p.count, AmountMicros: p.amount}
				pendTotal.Count += p.count
				pendTotal.AmountMicros += p.amount
			}
		}
		if pendTotal.Count > 0 {
			r.Total.Pending = &pendTotal
		}
		expenseRows = append(expenseRows, r)
	}
	totalExp := g.sum("total_expenses", "expenses", "Total expenses", "total", expenseRows...)
	totalExp.Total.Drill = g.rangeDrill(Drill{Direction: []string{fin.DirExpense}})

	// Profit and margin.
	profit := Row{Key: "profit", Section: "profit", Label: "Profit / loss", Kind: "total"}
	margin := Row{Key: "margin", Section: "profit", Label: "Margin", SourceLabel: "Total is blended", Kind: "margin"}
	g.result(&profit, &margin, net, totalExp)

	// Revenue never shows as zero when it is unavailable.
	if !out.RevenueAvailable {
		markUnavailable(append(rowPtrs(revenueRows), &profit, &margin)...)
	}

	// Memo: prepaid credits bought (cash, not expense).
	var memo []Row
	prepaidVendors := map[string]bool{}
	for _, b := range buckets {
		if b.Direction == fin.DirPrepayment {
			prepaidVendors[b.VendorID] = true
		}
	}
	for _, id := range slices.Sorted(maps.Keys(prepaidVendors)) {
		v := vendorByID[id]
		memo = append(memo, g.row("prepaid:"+id, "memo", cmp.Or(v.Name, id)+" credits", "Not in P&L", id,
			Drill{Vendor: id, Direction: []string{fin.DirPrepayment}},
			func(b fin.Bucket) bool { return b.Direction == fin.DirPrepayment && b.VendorID == id }))
	}

	out.Rows = slices.Concat(revenueRows, expenseRows, []Row{totalExp, profit, margin}, memo)
	for _, p := range pending {
		if _, ok := col[p.month]; ok {
			i := slices.IndexFunc(out.Provisional, func(x Provisional) bool { return x.Month == p.month })
			if i < 0 {
				out.Provisional = append(out.Provisional, Provisional{Month: p.month})
				i = len(out.Provisional) - 1
			}
			out.Provisional[i].Count += p.count
			out.Provisional[i].AmountMicros += p.amount
		}
	}
	slices.SortFunc(out.Provisional, func(a, b Provisional) int { return cmp.Compare(a.Month, b.Month) })
	return out, nil
}

// sortVendorIDs orders expense vendors as every P&L view shows them:
// AI-pipeline vendors first, then by name, "unmatched" last.
func sortVendorIDs(ids []string, vendorByID map[string]fin.Vendor) {
	slices.SortFunc(ids, func(a, b string) int {
		va, vb := vendorByID[a], vendorByID[b]
		if a == "unmatched" || b == "unmatched" {
			return cmp.Compare(boolInt(a == "unmatched"), boolInt(b == "unmatched"))
		}
		if c := cmp.Compare(boolInt(!va.IsAIPipeline), boolInt(!vb.IsAIPipeline)); c != 0 {
			return c
		}
		return cmp.Compare(va.Name, vb.Name)
	})
}

func expenseSourceLabel(v fin.Vendor, sources map[string]bool) string {
	ai := sources[fin.SourceTokenPipeline] || sources[fin.SourceReceiptExtraction] || v.IsAIPipeline
	rc := sources[fin.SourceReceipt] || (!v.IsAIPipeline && len(sources) == 0)
	switch {
	case ai && rc:
		return "AI usage + receipts"
	case ai:
		return "AI usage"
	default:
		return "Receipts"
	}
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func earliest(a, b time.Time) time.Time {
	if b.Before(a) {
		return b
	}
	return a
}
