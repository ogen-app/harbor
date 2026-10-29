package finance

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"math/bits"
	"slices"
	"time"

	"github.com/uptrace/bun"

	"github.com/ogen-app/harbor/src/logging"
	"github.com/ogen-app/harbor/src/repository/analytics"
	fin "github.com/ogen-app/harbor/src/repository/finance"
	"github.com/ogen-app/harbor/src/repository/ogen"
)

// Shared cost allocation (CON-432). Each shared vendor's posted bill for a
// month is split across tenants by its rule's driver: share = bill × tenant
// driver ÷ total driver, rounded by largest remainder in micros so the shares
// add up exactly to the bill. Allocations are stored apart from the ledger;
// the company P&L never reads them.
//
// The month's drivers are snapshotted so a past month stays explainable after
// Ogen's data changes. The current and previous months are refreshed hourly
// until they close. Each split remembers its rule: saving rules re-splits only
// the chosen months, and every other re-split (a changed bill, a refreshed
// snapshot) keeps the rule the month was split with.

// DriverSource reads the per-tenant monthly drivers that live outside Harbor.
// month is the first day of a UTC month; each returns tenant → quantity.
type DriverSource interface {
	ActiveTenants(ctx context.Context, month time.Time) (map[string]int64, error)
	PostsPublished(ctx context.Context, month time.Time) (map[string]int64, error)
	EmailsSent(ctx context.Context, month time.Time) (map[string]int64, error)
	ActiveUsers(ctx context.Context, month time.Time) (map[string]int64, error)
}

// DriverSources is the production DriverSource: Ogen's control-plane DB for
// tenants, posts and emails, and the analytics DB for active users. Either
// pool may be nil; its drivers then report unavailable.
type DriverSources struct {
	Ogen      *ogen.AllocationDrivers
	Analytics *bun.DB
}

func (d DriverSources) ActiveTenants(ctx context.Context, month time.Time) (map[string]int64, error) {
	return d.Ogen.ActiveTenants(ctx, month)
}

func (d DriverSources) PostsPublished(ctx context.Context, month time.Time) (map[string]int64, error) {
	return d.Ogen.PostsPublished(ctx, month)
}

func (d DriverSources) EmailsSent(ctx context.Context, month time.Time) (map[string]int64, error) {
	return d.Ogen.EmailsSent(ctx, month)
}

func (d DriverSources) ActiveUsers(ctx context.Context, month time.Time) (map[string]int64, error) {
	return analytics.ActiveUsersByTenant(ctx, d.Analytics, month)
}

func unavailable(err error) bool {
	return errors.Is(err, ogen.ErrUnavailable) || errors.Is(err, analytics.ErrUnavailable)
}

// RuleOption describes one allocation rule for the drawer's select.
type RuleOption struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	Driver string `json:"driver"` // '' for none
}

// AllocationRuleOptions lists the rules in the drawer's order.
var AllocationRuleOptions = []RuleOption{
	{Key: fin.RuleEven, Label: "Even split across active tenants", Driver: fin.DriverActiveTenants},
	{Key: fin.RuleAICost, Label: "By AI cost share", Driver: fin.DriverAICost},
	{Key: fin.RuleActiveUsers, Label: "By active users", Driver: fin.DriverActiveUsers},
	{Key: fin.RulePosts, Label: "By posts published", Driver: fin.DriverPosts},
	{Key: fin.RuleEmails, Label: "By emails sent", Driver: fin.DriverEmails},
	{Key: fin.RuleNone, Label: "Don’t split (company overhead)"},
}

var allDrivers = []string{fin.DriverActiveTenants, fin.DriverAICost, fin.DriverActiveUsers, fin.DriverPosts, fin.DriverEmails}

func ruleOption(rule string) (RuleOption, bool) {
	i := slices.IndexFunc(AllocationRuleOptions, func(o RuleOption) bool { return o.Key == rule })
	if i < 0 {
		return RuleOption{}, false
	}
	return AllocationRuleOptions[i], true
}

const (
	// SyncAllocations is the sync-state key of the allocation job.
	SyncAllocations = "allocations"
	// snapshotRefresh is how often an open month's drivers are re-read.
	snapshotRefresh = time.Hour
	monthLayout     = "2006-01"
)

func firstOfMonth(t time.Time) time.Time {
	t = t.UTC()
	return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC)
}

// ── Rounding ────────────────────────────────────────────────────────────────

// share is one tenant's part of a bill.
type share struct {
	TenantID string
	Amount   int64
	Quantity int64
}

// splitBill divides bill across the tenants in proportion to their positive
// quantities. Each tenant first gets floor(|bill| × q ÷ total); the micros left
// over go one each to the largest remainders (ties by tenant id), so the
// shares add up exactly to bill. A negative bill (a credit) splits the same
// way with the sign flipped. Returns nil when no tenant has a positive
// quantity. Products are taken in 128 bits, so large AI-cost drivers can't
// overflow.
func splitBill(bill int64, quantities map[string]int64) []share {
	var total uint64
	tenants := make([]string, 0, len(quantities))
	for t, q := range quantities {
		if q > 0 {
			tenants = append(tenants, t)
			total += uint64(q)
		}
	}
	if total == 0 {
		return nil
	}
	slices.Sort(tenants)
	neg := bill < 0
	abs := uint64(bill)
	if neg {
		abs = uint64(-bill)
	}
	out := make([]share, len(tenants))
	rems := make([]uint64, len(tenants))
	var assigned uint64
	for i, t := range tenants {
		q := uint64(quantities[t])
		hi, lo := bits.Mul64(abs, q)
		// q ≤ total, so the quotient ≤ abs and hi < total: Div64 can't panic.
		quo, rem := bits.Div64(hi, lo, total)
		out[i] = share{TenantID: t, Amount: int64(quo), Quantity: int64(q)}
		rems[i] = rem
		assigned += quo
	}
	order := make([]int, len(tenants))
	for i := range order {
		order[i] = i
	}
	slices.SortStableFunc(order, func(a, b int) int { return cmp.Compare(rems[b], rems[a]) })
	for _, i := range order[:abs-assigned] {
		out[i].Amount++
	}
	if neg {
		for i := range out {
			out[i].Amount = -out[i].Amount
		}
	}
	return out
}

// ── Planning ────────────────────────────────────────────────────────────────

// plan is how one (month, vendor) bill splits under a rule.
type plan struct {
	split  fin.AllocationSplit
	shares []share
}

// planSplit splits bill by rule using the month's captured drivers. ready is
// false when the driver it needs hasn't been captured (its source was
// unavailable), so the caller keeps the vendor's previous split. A driver that
// totals zero falls back to an even split; with no active tenants either the
// bill stays at company level, flagged.
func planSplit(month time.Time, vendorID string, bill int64, rule string, drivers map[string]map[string]int64) (p plan, ready bool) {
	p.split = fin.AllocationSplit{Month: month, VendorID: vendorID, Rule: rule, BillUSDMicros: bill}
	opt, ok := ruleOption(rule)
	if !ok || opt.Driver == "" {
		p.split.Rule = fin.RuleNone
		return p, true
	}
	driver := opt.Driver
	q, ok := drivers[driver]
	if !ok {
		return p, false
	}
	if sumPositive(q) == 0 {
		p.split.Fallback = true
		driver = fin.DriverActiveTenants
		if q, ok = drivers[driver]; !ok {
			return p, false
		}
	}
	p.shares = splitBill(bill, q)
	if p.shares == nil {
		return p, true // nobody to split across
	}
	p.split.Driver = &driver
	p.split.DriverTotal = sumPositive(q)
	return p, true
}

func sumPositive(q map[string]int64) int64 {
	var n int64
	for _, v := range q {
		if v > 0 {
			n += v
		}
	}
	return n
}

func (p plan) rows() []fin.Allocation {
	out := make([]fin.Allocation, 0, len(p.shares))
	for _, s := range p.shares {
		out = append(out, fin.Allocation{
			Month: p.split.Month, VendorID: p.split.VendorID, TenantID: s.TenantID,
			AmountUSDMicros: s.Amount, DriverQuantity: s.Quantity,
		})
	}
	return out
}

func (p plan) shareOf(tenantID string) (amount, quantity int64) {
	for _, s := range p.shares {
		if s.TenantID == tenantID {
			return s.Amount, s.Quantity
		}
	}
	return 0, 0
}

// ── Drivers ─────────────────────────────────────────────────────────────────

func (s *Service) readDriver(ctx context.Context, month time.Time, driver string) (map[string]int64, error) {
	if driver == fin.DriverAICost {
		return s.repo.AICostByTenant(ctx, month)
	}
	if s.drivers == nil {
		return nil, ogen.ErrUnavailable
	}
	switch driver {
	case fin.DriverActiveTenants:
		return s.drivers.ActiveTenants(ctx, month)
	case fin.DriverPosts:
		return s.drivers.PostsPublished(ctx, month)
	case fin.DriverEmails:
		return s.drivers.EmailsSent(ctx, month)
	case fin.DriverActiveUsers:
		return s.drivers.ActiveUsers(ctx, month)
	}
	return nil, fmt.Errorf("unknown driver %q", driver)
}

// captureDrivers snapshots the month's drivers: all of them when refresh, else
// only those never captured. A source that is unavailable is skipped (its
// previous snapshot stays), never stored as zeros. It reports whether anything
// was captured.
func (s *Service) captureDrivers(ctx context.Context, month time.Time, refresh bool) (bool, error) {
	snaps, err := s.repo.DriverSnapshots(ctx, month)
	if err != nil {
		return false, err
	}
	var errs []error
	captured := false
	for _, d := range allDrivers {
		if _, ok := snaps[d]; ok && !refresh {
			continue
		}
		q, err := s.readDriver(ctx, month, d)
		if err != nil {
			if !unavailable(err) {
				errs = append(errs, fmt.Errorf("%s %s: %w", d, month.Format(monthLayout), err))
			}
			continue
		}
		if err := s.repo.ReplaceDrivers(ctx, month, d, q); err != nil {
			return captured, err
		}
		captured = true
	}
	return captured, errors.Join(errs...)
}

// ── Re-splitting ────────────────────────────────────────────────────────────

// resplitMonth recomputes the month's splits inside tx. ruleFor picks each
// vendor's rule given its current split (nil when it has none). A vendor
// without a posted bill loses its split; one whose driver isn't captured keeps
// it, and is returned in skipped.
func resplitMonth(ctx context.Context, tx *fin.Repository, month time.Time, ruleFor func(vendorID string, current *fin.AllocationSplit) string) (skipped []string, err error) {
	bills, err := tx.SharedBills(ctx, month, month)
	if err != nil {
		return nil, err
	}
	billBy := make(map[string]int64, len(bills))
	for _, b := range bills {
		billBy[b.VendorID] = b.USDMicros
	}
	splits, err := tx.SplitsForMonth(ctx, month)
	if err != nil {
		return nil, err
	}
	drivers, err := tx.Drivers(ctx, month)
	if err != nil {
		return nil, err
	}
	vendors := slices.Sorted(maps.Keys(billBy))
	for v := range splits {
		if _, ok := billBy[v]; !ok {
			vendors = append(vendors, v)
		}
	}
	for _, v := range vendors {
		bill, ok := billBy[v]
		if !ok {
			if err := tx.DeleteSplit(ctx, month, v); err != nil {
				return skipped, err
			}
			continue
		}
		var current *fin.AllocationSplit
		if sp, ok := splits[v]; ok {
			current = &sp
		}
		p, ready := planSplit(month, v, bill, ruleFor(v, current), drivers)
		if !ready {
			skipped = append(skipped, v)
			continue
		}
		if err := tx.ReplaceSplit(ctx, p.split, p.rows()); err != nil {
			return skipped, err
		}
	}
	return skipped, nil
}

// currentRules is every shared vendor's stored rule; a vendor without one is
// not split.
func (s *Service) currentRules(ctx context.Context, repo *fin.Repository) (map[string]string, []fin.Vendor, error) {
	vendors, err := repo.SharedVendors(ctx)
	if err != nil {
		return nil, nil, err
	}
	stored, err := repo.AllocationRules(ctx)
	if err != nil {
		return nil, nil, err
	}
	out := make(map[string]string, len(vendors))
	for _, v := range vendors {
		out[v.ID] = fin.RuleNone
		if r, ok := stored[v.ID]; ok {
			out[v.ID] = r.Rule
		}
	}
	return out, vendors, nil
}

// AllocateShared is the pnl.allocations job. It refreshes the open months'
// driver snapshots once they're an hour old, then re-splits those months and
// every month whose posted bill no longer matches its split (an approved,
// edited or voided receipt), so a shared-vendor receipt is split within one
// job cycle. Each re-split keeps the month's rule; a month split for the first
// time takes the current rules.
func (s *Service) AllocateShared(ctx context.Context) error {
	now := s.now()
	cur := firstOfMonth(now)
	months := map[time.Time]bool{}
	var errs []error

	for _, m := range []time.Time{cur.AddDate(0, -1, 0), cur} {
		snaps, err := s.repo.DriverSnapshots(ctx, m)
		if err != nil {
			return err
		}
		// Age only: a driver whose source is down is retried with the hourly
		// refresh, not on every tick.
		stale := len(snaps) == 0
		for _, at := range snaps {
			if now.Sub(at) >= snapshotRefresh {
				stale = true
			}
		}
		if !stale {
			continue
		}
		captured, err := s.captureDrivers(ctx, m, true)
		if err != nil {
			errs = append(errs, err)
		}
		if captured {
			months[m] = true
		}
	}

	drifted, err := s.repo.DriftedSplits(ctx)
	if err != nil {
		return err
	}
	for _, d := range drifted {
		months[d.Month] = true
	}
	if len(months) == 0 {
		return errors.Join(errs...)
	}

	rules, _, err := s.currentRules(ctx, s.repo)
	if err != nil {
		return err
	}
	keepRule := func(v string, current *fin.AllocationSplit) string {
		if current != nil {
			return current.Rule
		}
		return cmp.Or(rules[v], fin.RuleNone)
	}
	for _, m := range slices.SortedFunc(maps.Keys(months), time.Time.Compare) {
		if _, err := s.captureDrivers(ctx, m, false); err != nil {
			errs = append(errs, err)
		}
		err := s.repo.InTx(ctx, func(ctx context.Context, tx *fin.Repository) error {
			if err := tx.LockAllocations(ctx); err != nil {
				return err
			}
			skipped, err := resplitMonth(ctx, tx, m, keepRule)
			if len(skipped) > 0 {
				slog.DebugContext(ctx, "allocation: driver unavailable, split kept",
					logging.AttrComponent, "pnl", "month", m.Format(monthLayout), "vendors", skipped)
			}
			return err
		})
		if err != nil {
			errs = append(errs, fmt.Errorf("re-split %s: %w", m.Format(monthLayout), err))
		}
	}
	if err := errors.Join(errs...); err != nil {
		_ = s.repo.SyncFailed(ctx, SyncAllocations, err.Error())
		return err
	}
	return s.repo.SyncSucceeded(ctx, SyncAllocations, nil)
}

// RuleChange is one vendor's rule before and after a save.
type RuleChange struct {
	VendorID string `json:"vendorId"`
	From     string `json:"from"`
	To       string `json:"to"`
}

// RulesSaved is what a save did: the months it re-split, the changed rules,
// the vendor-months it couldn't re-split (driver unavailable) and a summary.
type RulesSaved struct {
	Months  []string     `json:"months"`
	Changes []RuleChange `json:"changes"`
	Skipped []string     `json:"skipped"`
	Summary string       `json:"summary"`
}

// allocationAudit is the effect stored with an allocation_rules.update entry.
type allocationAudit struct {
	From   string   `json:"from"`
	To     string   `json:"to"`
	Months []string `json:"months"`
}

const (
	auditRulesEntity = "allocation_rules"
	auditRulesID     = "shared"
	auditRulesAction = "allocation_rules.update"
)

// SaveAllocationRules stores the operator's rules and re-splits every month
// in [from, to] (first days of months) with them, in one transaction, audited
// as allocation_rules.update. Other months keep their earlier split and rule.
// Company totals don't change: allocations never touch the ledger. Vendors
// left out of rules keep their rule.
func (s *Service) SaveAllocationRules(ctx context.Context, actor string, rules map[string]string, from, to time.Time) (RulesSaved, error) {
	var out RulesSaved
	from, to = firstOfMonth(from), firstOfMonth(to)
	if from.After(to) {
		return out, &ErrInvalid{Msg: "from is after to"}
	}
	if from.AddDate(0, MaxMonths-1, 0).Before(to) {
		return out, &ErrInvalid{Msg: fmt.Sprintf("at most %d months", MaxMonths)}
	}
	current, _, err := s.currentRules(ctx, s.repo)
	if err != nil {
		return out, err
	}
	next := maps.Clone(current)
	for v, r := range rules {
		if _, ok := current[v]; !ok {
			return out, &ErrInvalid{Msg: "vendor " + v + " is not a shared vendor"}
		}
		if _, ok := ruleOption(r); !ok {
			return out, &ErrInvalid{Msg: "unknown rule " + r}
		}
		next[v] = r
	}
	for _, v := range slices.Sorted(maps.Keys(next)) {
		if next[v] != current[v] {
			out.Changes = append(out.Changes, RuleChange{VendorID: v, From: current[v], To: next[v]})
		}
	}
	if len(out.Changes) == 0 {
		out.Summary = "No change to the rules"
		return out, nil
	}

	var months []time.Time
	for m := from; !m.After(to); m = m.AddDate(0, 1, 0) {
		months = append(months, m)
		out.Months = append(out.Months, m.Format(monthLayout))
	}
	// Read missing drivers before the transaction: they come from other
	// databases and shouldn't hold it open.
	for _, m := range months {
		if _, err := s.captureDrivers(ctx, m, false); err != nil {
			slog.WarnContext(ctx, "allocation: driver capture failed", logging.AttrComponent, "pnl", logging.AttrError, err)
		}
	}

	before := map[string]string{}
	after := map[string]string{}
	for _, c := range out.Changes {
		before[c.VendorID] = c.From
		after[c.VendorID] = c.To
	}
	err = s.repo.InTx(ctx, func(ctx context.Context, tx *fin.Repository) error {
		if err := tx.LockAllocations(ctx); err != nil {
			return err
		}
		for _, c := range out.Changes {
			if err := tx.SetAllocationRule(ctx, c.VendorID, c.To, actor); err != nil {
				return err
			}
		}
		apply := func(v string, _ *fin.AllocationSplit) string { return next[v] }
		for _, m := range months {
			skipped, err := resplitMonth(ctx, tx, m, apply)
			if err != nil {
				return err
			}
			for _, v := range skipped {
				out.Skipped = append(out.Skipped, m.Format(monthLayout)+" "+v)
			}
		}
		eff := allocationAudit{From: from.Format(monthLayout), To: to.Format(monthLayout), Months: out.Months}
		return tx.Audit(ctx, actor, auditRulesAction, auditRulesEntity, auditRulesID, before, after, eff)
	})
	if err != nil {
		return RulesSaved{}, err
	}
	out.Summary = "Re-split " + plural(len(months), "month", "months") + ". Company totals stay the same."
	return out, nil
}

// ── Drawer ──────────────────────────────────────────────────────────────────

// AllocationView is the "Shared cost allocation" drawer for one month,
// previewing one tenant.
type AllocationView struct {
	Month    string `json:"month"`
	TenantID string `json:"tenantId"`
	// Tenants is everyone with a driver in the month, largest previewed share
	// first: the drawer's tenant picker. Names are filled by the handler.
	Tenants []AllocationTenant `json:"tenants"`
	Rules   []RuleOption       `json:"rules"`
	Vendors []AllocationVendor `json:"vendors"`
	Changes []AllocationChange `json:"changes"`
	// ShareMicros is the previewed tenant's total under the current rules.
	ShareMicros int64 `json:"shareMicros"`
}

type AllocationTenant struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	ShareMicros int64  `json:"shareMicros"`
}

// AllocationVendor is one vendor card.
type AllocationVendor struct {
	VendorID string `json:"vendorId"`
	Name     string `json:"name"`
	Category string `json:"category"`
	// Rule is the vendor's current rule.
	Rule string `json:"rule"`
	// BillMicros is the posted bill for the month; Pending when there is none
	// yet (its receipt hasn't arrived or waits in Needs attention).
	BillMicros int64 `json:"billMicros"`
	Pending    bool  `json:"pending"`
	// Stored is the month's saved split, nil when it hasn't been split.
	Stored *StoredSplit `json:"stored"`
	// Previews is the split under each rule, keyed by rule, so the select
	// updates the card without a round trip.
	Previews map[string]AllocationPreview `json:"previews"`
}

// StoredSplit is a saved split as the tenant sees it.
type StoredSplit struct {
	Rule        string    `json:"rule"`
	Fallback    bool      `json:"fallback"`
	ShareMicros int64     `json:"shareMicros"`
	ComputedAt  time.Time `json:"computedAt"`
	// Stale is set when the bill changed since; the job re-splits it shortly.
	Stale bool `json:"stale"`
}

// AllocationPreview is one rule applied to the month.
type AllocationPreview struct {
	// Available is false when the rule's driver couldn't be read.
	Available bool   `json:"available"`
	Driver    string `json:"driver"` // the driver used ('' when nothing is split)
	// Fallback: the rule's driver totalled zero, so the split is even (or,
	// with no Driver, there was nobody to split across).
	Fallback       bool  `json:"fallback"`
	TenantQuantity int64 `json:"tenantQuantity"`
	DriverTotal    int64 `json:"driverTotal"`
	DriverTenants  int   `json:"driverTenants"`
	ShareMicros    int64 `json:"shareMicros"`
}

// AllocationChange is one earlier save, from the audit log.
type AllocationChange struct {
	At      time.Time    `json:"at"`
	Actor   string       `json:"actor"`
	Changes []RuleChange `json:"changes"`
	From    string       `json:"from"`
	To      string       `json:"to"`
}

// Allocation builds the drawer for month, previewing tenantID (or, when it is
// empty, the tenant with the largest share). Drivers never captured for the
// month are read first.
func (s *Service) Allocation(ctx context.Context, month time.Time, tenantID string) (AllocationView, error) {
	month = firstOfMonth(month)
	out := AllocationView{Month: month.Format(monthLayout), Rules: AllocationRuleOptions, Vendors: []AllocationVendor{}, Changes: []AllocationChange{}}
	if _, err := s.captureDrivers(ctx, month, false); err != nil {
		slog.WarnContext(ctx, "allocation: driver capture failed", logging.AttrComponent, "pnl", logging.AttrError, err)
	}
	rules, vendors, err := s.currentRules(ctx, s.repo)
	if err != nil {
		return out, err
	}
	bills, err := s.repo.SharedBills(ctx, month, month)
	if err != nil {
		return out, err
	}
	billBy := map[string]int64{}
	for _, b := range bills {
		billBy[b.VendorID] = b.USDMicros
	}
	splits, err := s.repo.SplitsForMonth(ctx, month)
	if err != nil {
		return out, err
	}
	stored, err := s.repo.Allocations(ctx, month, month, "")
	if err != nil {
		return out, err
	}
	drivers, err := s.repo.Drivers(ctx, month)
	if err != nil {
		return out, err
	}

	// Rank every tenant with a driver by its share under the current rules.
	totals := map[string]int64{}
	for _, q := range drivers {
		for t := range q {
			totals[t] = 0
		}
	}
	plans := map[string]map[string]plan{}
	ready := map[string]map[string]bool{}
	for _, v := range vendors {
		plans[v.ID], ready[v.ID] = map[string]plan{}, map[string]bool{}
		for _, opt := range AllocationRuleOptions {
			// A vendor with no posted bill splits $0: its shares are zero but
			// the driver still shows.
			p, ok := planSplit(month, v.ID, billBy[v.ID], opt.Key, drivers)
			plans[v.ID][opt.Key], ready[v.ID][opt.Key] = p, ok
		}
		for _, sh := range plans[v.ID][rules[v.ID]].shares {
			totals[sh.TenantID] += sh.Amount
		}
	}
	for t, n := range totals {
		out.Tenants = append(out.Tenants, AllocationTenant{ID: t, ShareMicros: n})
	}
	slices.SortFunc(out.Tenants, func(a, b AllocationTenant) int {
		return cmp.Or(cmp.Compare(b.ShareMicros, a.ShareMicros), cmp.Compare(a.ID, b.ID))
	})
	if tenantID == "" && len(out.Tenants) > 0 {
		tenantID = out.Tenants[0].ID
	}
	out.TenantID = tenantID
	out.ShareMicros = totals[tenantID]

	for _, v := range vendors {
		bill, posted := billBy[v.ID]
		card := AllocationVendor{
			VendorID: v.ID, Name: v.Name, Category: v.Category, Rule: rules[v.ID],
			BillMicros: bill, Pending: !posted, Previews: map[string]AllocationPreview{},
		}
		for _, opt := range AllocationRuleOptions {
			p := plans[v.ID][opt.Key]
			pv := AllocationPreview{Available: ready[v.ID][opt.Key], Fallback: p.split.Fallback, DriverTotal: p.split.DriverTotal, DriverTenants: len(p.shares)}
			if p.split.Driver != nil {
				pv.Driver = *p.split.Driver
			}
			pv.ShareMicros, pv.TenantQuantity = p.shareOf(tenantID)
			card.Previews[opt.Key] = pv
		}
		if sp, ok := splits[v.ID]; ok {
			st := &StoredSplit{Rule: sp.Rule, Fallback: sp.Fallback, ComputedAt: sp.ComputedAt, Stale: sp.BillUSDMicros != bill || !posted}
			for _, a := range stored {
				if a.VendorID == v.ID && a.TenantID == tenantID {
					st.ShareMicros = a.AmountUSDMicros
				}
			}
			card.Stored = st
		}
		out.Vendors = append(out.Vendors, card)
	}

	audit, err := s.repo.AuditFor(ctx, auditRulesEntity, auditRulesID)
	if err != nil {
		return out, err
	}
	for _, a := range audit {
		var before, after map[string]string
		var eff allocationAudit
		_ = json.Unmarshal(a.Before, &before)
		_ = json.Unmarshal(a.After, &after)
		_ = json.Unmarshal(a.Effect, &eff)
		ch := AllocationChange{At: a.CreatedAt, Actor: a.Actor, From: eff.From, To: eff.To}
		for _, v := range slices.Sorted(maps.Keys(after)) {
			ch.Changes = append(ch.Changes, RuleChange{VendorID: v, From: before[v], To: after[v]})
		}
		out.Changes = append(out.Changes, ch)
	}
	return out, nil
}
