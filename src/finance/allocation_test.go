package finance

import (
	"encoding/json"
	"errors"
	"math"
	"math/rand/v2"
	"slices"
	"strings"
	"testing"
	"time"

	fin "github.com/ogen-app/harbor/src/repository/finance"
	"github.com/ogen-app/harbor/src/repository/ogenreceipts"
)

func sumShares(s []share) int64 {
	var n int64
	for _, x := range s {
		n += x.Amount
	}
	return n
}

func TestSplitBill(t *testing.T) {
	cases := []struct {
		name string
		bill int64
		q    map[string]int64
		want map[string]int64
	}{
		{"even thirds", 100, map[string]int64{"a": 1, "b": 1, "c": 1}, map[string]int64{"a": 34, "b": 33, "c": 33}},
		{"proportional", 1_000, map[string]int64{"a": 1, "b": 3}, map[string]int64{"a": 250, "b": 750}},
		{"largest remainder wins", 10, map[string]int64{"a": 1, "b": 2}, map[string]int64{"a": 3, "b": 7}},
		{"zero quantity left out", 9, map[string]int64{"a": 1, "b": 0, "c": 2}, map[string]int64{"a": 3, "c": 6}},
		{"credit", -100, map[string]int64{"a": 1, "b": 1, "c": 1}, map[string]int64{"a": -34, "b": -33, "c": -33}},
		{"zero bill", 0, map[string]int64{"a": 1}, map[string]int64{"a": 0}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := map[string]int64{}
			for _, s := range splitBill(c.bill, c.q) {
				got[s.TenantID] = s.Amount
			}
			if len(got) != len(c.want) {
				t.Fatalf("got %v, want %v", got, c.want)
			}
			for k, v := range c.want {
				if got[k] != v {
					t.Fatalf("got %v, want %v", got, c.want)
				}
			}
		})
	}
	if s := splitBill(100, map[string]int64{"a": 0}); s != nil {
		t.Errorf("no positive quantity: got %v, want nil", s)
	}
}

// Property: for random bills and drivers the shares add up exactly to the
// bill, each is within one micro of its exact proportion, and the result does
// not depend on map order. Large drivers (AI cost in micros) must not
// overflow.
func TestSplitBillAddsUpExactly(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	for i := range 5_000 {
		bill := r.Int64N(5_000_000_000) - 500_000_000 // −$500 … $4,500
		if i%10 == 0 {
			bill = r.Int64N(math.MaxInt64 / 4)
		}
		n := 1 + r.IntN(60)
		q := map[string]int64{}
		var total float64
		for j := range n {
			v := r.Int64N(1_000)
			if i%7 == 0 {
				v = r.Int64N(math.MaxInt64 / int64(n)) // huge AI-cost drivers
			}
			q[string(rune('A'+j%26))+string(rune('a'+j/26))] = v
			total += float64(v)
		}
		got := splitBill(bill, q)
		if total == 0 {
			if got != nil {
				t.Fatalf("case %d: zero total split %v", i, got)
			}
			continue
		}
		if s := sumShares(got); s != bill {
			t.Fatalf("case %d: shares add up to %d, bill %d", i, s, bill)
		}
		for _, s := range got {
			exact := float64(bill) * float64(s.Quantity) / total
			if math.Abs(float64(s.Amount)-exact) > 1+math.Abs(exact)*1e-9 {
				t.Fatalf("case %d: tenant %s got %d, exact %.2f", i, s.TenantID, s.Amount, exact)
			}
		}
		if again := splitBill(bill, q); !slices.Equal(again, got) {
			t.Fatalf("case %d: not deterministic", i)
		}
	}
}

func TestPlanSplitFallback(t *testing.T) {
	m := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	drivers := map[string]map[string]int64{
		fin.DriverActiveTenants: {"a": 1, "b": 1},
		fin.DriverEmails:        {},
	}
	p, ok := planSplit(m, "resend", 1_000, fin.RuleEmails, drivers)
	if !ok || !p.split.Fallback || p.split.Driver == nil || *p.split.Driver != fin.DriverActiveTenants {
		t.Fatalf("zero emails: ok=%v split=%+v, want an even fallback", ok, p.split)
	}
	if sumShares(p.shares) != 1_000 || len(p.shares) != 2 {
		t.Fatalf("fallback shares = %+v", p.shares)
	}
	if _, ok := planSplit(m, "zernio", 1_000, fin.RulePosts, drivers); ok {
		t.Error("posts never captured: want not ready")
	}
	if p, ok := planSplit(m, "railway", 1_000, fin.RuleNone, drivers); !ok || p.shares != nil {
		t.Errorf("none: %+v", p)
	}
	empty := map[string]map[string]int64{fin.DriverActiveTenants: {}}
	if p, ok := planSplit(m, "railway", 1_000, fin.RuleEven, empty); !ok || !p.split.Fallback || p.shares != nil || p.split.Driver != nil {
		t.Errorf("no active tenants: ok=%v %+v, want flagged and unsplit", ok, p)
	}
}

// ── database ────────────────────────────────────────────────────────────────

// railwayIssued is a Railway receipt issued on date.
func railwayIssued(invoice, date string) ogenreceipts.Result {
	r := railwayReceipt(invoice)
	r.Extraction.IssueDate = date
	r.Extraction.ServicePeriodStart = ""
	r.Extraction.ServicePeriodEnd = ""
	return r
}

func allocationsOf(t *testing.T, h *harness, month time.Time, vendor string) (map[string]int64, int64) {
	t.Helper()
	rows, err := h.svc.repo.Allocations(t.Context(), month, month, "")
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]int64{}
	var sum int64
	for _, a := range rows {
		if a.VendorID == vendor {
			out[a.TenantID] = a.AmountUSDMicros
			sum += a.AmountUSDMicros
		}
	}
	return out, sum
}

func companyBuckets(t *testing.T, h *harness) []fin.Bucket {
	t.Helper()
	b, err := h.svc.repo.Buckets(t.Context(), time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(2026, 12, 31, 0, 0, 0, 0, time.UTC), false, fin.GrainMonth)
	if err != nil {
		t.Fatal(err)
	}
	slices.SortFunc(b, func(x, y fin.Bucket) int {
		return compareStrings(x.Period+x.Direction+x.Source+x.VendorID, y.Period+y.Direction+y.Source+y.VendorID)
	})
	return b
}

func compareStrings(a, b string) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

func TestAllocationDefaultsSeeded(t *testing.T) {
	h := newHarness(t)
	rules, _, err := h.svc.currentRules(t.Context(), h.svc.repo)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"railway": "even", "cloudflare": "even", "resend": "emails", "zernio": "posts"}
	if len(rules) != len(want) {
		t.Fatalf("shared vendors = %v, want %v", rules, want)
	}
	for v, r := range want {
		if rules[v] != r {
			t.Errorf("%s = %q, want %q", v, rules[v], r)
		}
	}
	// A vendor added later is shared but not split.
	if _, err := h.svc.CreateVendor(t.Context(), "ops@ogen.app", NewVendor{Name: "Sentry", Category: "infra"}); err != nil {
		t.Fatal(err)
	}
	rules, _, _ = h.svc.currentRules(t.Context(), h.svc.repo)
	if rules["sentry"] != fin.RuleNone {
		t.Errorf("new vendor rule = %q, want none", rules["sentry"])
	}
}

func TestAllocateSharedSplitsBillExactly(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	oct := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	h.drivers.set("2026-10", fin.DriverActiveTenants, map[string]int64{"t1": 1, "t2": 1, "t3": 1})
	h.drivers.set("2026-09", fin.DriverActiveTenants, map[string]int64{"t1": 1, "t2": 1})

	h.receive(t, "re_1", railwayReceipt("A-1")) // $86.18 issued 2026-10-01
	before := companyBuckets(t, h)
	if err := h.svc.AllocateShared(ctx); err != nil {
		t.Fatalf("allocate: %v", err)
	}
	got, sum := allocationsOf(t, h, oct, "railway")
	if sum != 86_180_000 || len(got) != 3 {
		t.Fatalf("railway October = %v (sum %d), want 3 shares adding up to 86180000", got, sum)
	}
	// Equal remainders: the two leftover micros go to t1 and t2 (tenant id order).
	if got["t1"] != 28_726_667 || got["t2"] != 28_726_667 || got["t3"] != 28_726_666 {
		t.Errorf("shares = %v", got)
	}
	if after := companyBuckets(t, h); !slices.Equal(before, after) {
		t.Errorf("company totals changed:\n%v\n%v", before, after)
	}

	// Nothing drifted: a second pass in the same hour changes nothing.
	sp, _ := h.svc.repo.SplitsForMonth(ctx, oct)
	if err := h.svc.AllocateShared(ctx); err != nil {
		t.Fatal(err)
	}
	sp2, _ := h.svc.repo.SplitsForMonth(ctx, oct)
	if !sp2["railway"].ComputedAt.Equal(sp["railway"].ComputedAt) {
		t.Error("an unchanged month was re-split")
	}

	// A second receipt in the month re-splits it within one cycle.
	h.receive(t, "re_2", railwayIssued("A-2", "2026-10-15"))
	if err := h.svc.AllocateShared(ctx); err != nil {
		t.Fatal(err)
	}
	if _, sum := allocationsOf(t, h, oct, "railway"); sum != 2*86_180_000 {
		t.Fatalf("after a second receipt: sum %d, want %d", sum, 2*86_180_000)
	}

	// Voiding both drops the month's split.
	parsed, _ := h.svc.repo.ReceiptsByStatus(ctx, fin.StatusParsed)
	for _, rc := range parsed {
		if _, _, err := h.svc.VoidReceipt(ctx, "ops@ogen.app", rc.ID, ""); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.svc.AllocateShared(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := allocationsOf(t, h, oct, "railway"); len(got) != 0 {
		t.Errorf("after void: %v, want no shares", got)
	}
	if sp, _ := h.svc.repo.SplitsForMonth(ctx, oct); len(sp) != 0 {
		t.Errorf("after void: splits %v", sp)
	}
}

func TestSaveRulesResplitsOnlyRange(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	sep := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	oct := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	for _, m := range []string{"2026-09", "2026-10"} {
		h.drivers.set(m, fin.DriverActiveTenants, map[string]int64{"t1": 1, "t2": 1})
		h.drivers.set(m, fin.DriverPosts, map[string]int64{"t1": 3, "t2": 1})
	}
	h.receive(t, "re_s", railwayIssued("S-1", "2026-09-03"))
	h.receive(t, "re_o", railwayIssued("O-1", "2026-10-03"))
	if err := h.svc.AllocateShared(ctx); err != nil {
		t.Fatal(err)
	}
	before := companyBuckets(t, h)

	res, err := h.svc.SaveAllocationRules(ctx, "ops@ogen.app", map[string]string{"railway": fin.RulePosts}, oct, oct)
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	if !slices.Equal(res.Months, []string{"2026-10"}) || len(res.Changes) != 1 {
		t.Fatalf("saved = %+v", res)
	}
	if after := companyBuckets(t, h); !slices.Equal(before, after) {
		t.Error("company totals changed after a rule change")
	}

	octSplit, _ := h.svc.repo.SplitsForMonth(ctx, oct)
	sepSplit, _ := h.svc.repo.SplitsForMonth(ctx, sep)
	if octSplit["railway"].Rule != fin.RulePosts || sepSplit["railway"].Rule != fin.RuleEven {
		t.Fatalf("rules: Oct %q, Sep %q", octSplit["railway"].Rule, sepSplit["railway"].Rule)
	}
	if got, sum := allocationsOf(t, h, oct, "railway"); got["t1"] != 64_635_000 || sum != 86_180_000 {
		t.Errorf("October by posts = %v", got)
	}

	// A later bill change in September keeps September's own rule.
	h.receive(t, "re_s2", railwayIssued("S-2", "2026-09-20"))
	if err := h.svc.AllocateShared(ctx); err != nil {
		t.Fatal(err)
	}
	sepSplit, _ = h.svc.repo.SplitsForMonth(ctx, sep)
	if sepSplit["railway"].Rule != fin.RuleEven || sepSplit["railway"].BillUSDMicros != 2*86_180_000 {
		t.Errorf("September after drift = %+v", sepSplit["railway"])
	}

	// The save is audited and shows in the drawer's Changes.
	v, err := h.svc.Allocation(ctx, oct, "t2")
	if err != nil {
		t.Fatal(err)
	}
	if len(v.Changes) != 1 || v.Changes[0].Actor != "ops@ogen.app" || v.Changes[0].From != "2026-10" ||
		len(v.Changes[0].Changes) != 1 || v.Changes[0].Changes[0] != (RuleChange{VendorID: "railway", From: "even", To: "posts"}) {
		t.Errorf("changes = %+v", v.Changes)
	}

	// Saving the same rules again is a no-op.
	res, err = h.svc.SaveAllocationRules(ctx, "ops@ogen.app", map[string]string{"railway": fin.RulePosts}, sep, oct)
	if err != nil || len(res.Months) != 0 {
		t.Errorf("no-op save = %+v, %v", res, err)
	}
	if _, err := h.svc.SaveAllocationRules(ctx, "ops@ogen.app", map[string]string{"anthropic": fin.RuleEven}, oct, oct); !isInvalid(err) {
		t.Errorf("AI vendor: err = %v, want invalid", err)
	}
	if _, err := h.svc.SaveAllocationRules(ctx, "ops@ogen.app", map[string]string{"railway": "weighted"}, oct, oct); !isInvalid(err) {
		t.Errorf("unknown rule: err = %v, want invalid", err)
	}
}

func TestAllocationZeroDriverFallsBack(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	oct := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	h.drivers.set("2026-10", fin.DriverActiveTenants, map[string]int64{"t1": 1, "t2": 1})
	h.drivers.set("2026-10", fin.DriverPosts, map[string]int64{})
	h.receive(t, "re_1", railwayReceipt("A-1"))
	if _, err := h.svc.SaveAllocationRules(ctx, "ops@ogen.app", map[string]string{"railway": fin.RulePosts}, oct, oct); err != nil {
		t.Fatal(err)
	}
	sp, _ := h.svc.repo.SplitsForMonth(ctx, oct)
	if s := sp["railway"]; !s.Fallback || s.Driver == nil || *s.Driver != fin.DriverActiveTenants {
		t.Fatalf("split = %+v, want an even fallback", s)
	}
	if got, sum := allocationsOf(t, h, oct, "railway"); sum != 86_180_000 || got["t1"] != 43_090_000 {
		t.Errorf("fallback shares = %v", got)
	}
	v, err := h.svc.Allocation(ctx, oct, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range v.Vendors {
		if c.VendorID == "railway" && !c.Previews[fin.RulePosts].Fallback {
			t.Error("drawer doesn't flag the fallback")
		}
	}
}

// A driver whose source is down is never stored as zeros, and the vendor
// keeps its previous split until it can be read.
func TestAllocationDriverUnavailable(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	oct := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	h.drivers.down[fin.DriverActiveTenants] = true
	h.receive(t, "re_1", railwayReceipt("A-1"))
	if err := h.svc.AllocateShared(ctx); err != nil {
		t.Fatalf("allocate: %v", err)
	}
	if sp, _ := h.svc.repo.SplitsForMonth(ctx, oct); len(sp) != 0 {
		t.Fatalf("split written without its driver: %v", sp)
	}
	snaps, _ := h.svc.repo.DriverSnapshots(ctx, oct)
	if _, ok := snaps[fin.DriverActiveTenants]; ok {
		t.Fatal("an unavailable driver was snapshotted")
	}

	h.drivers.down = map[string]bool{}
	h.drivers.set("2026-10", fin.DriverActiveTenants, map[string]int64{"t1": 1})
	if err := h.svc.AllocateShared(ctx); err != nil {
		t.Fatal(err)
	}
	if got, _ := allocationsOf(t, h, oct, "railway"); got["t1"] != 86_180_000 {
		t.Errorf("after recovery = %v", got)
	}
}

func TestAllocationDrawer(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	oct := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	h.drivers.set("2026-10", fin.DriverActiveTenants, map[string]int64{"t1": 1, "t2": 1, "t3": 1, "t4": 1})
	h.drivers.set("2026-10", fin.DriverEmails, map[string]int64{"t1": 10, "t2": 90})
	h.receive(t, "re_1", railwayReceipt("A-1"))
	if err := h.svc.AllocateShared(ctx); err != nil {
		t.Fatal(err)
	}
	v, err := h.svc.Allocation(ctx, oct, "")
	if err != nil {
		t.Fatal(err)
	}
	if v.TenantID == "" || len(v.Tenants) != 4 || len(v.Vendors) != 4 {
		t.Fatalf("view = tenant %q, %d tenants, %d vendors", v.TenantID, len(v.Tenants), len(v.Vendors))
	}
	for _, c := range v.Vendors {
		switch c.VendorID {
		case "railway":
			p := c.Previews[fin.RuleEven]
			if c.Pending || c.BillMicros != 86_180_000 || p.DriverTotal != 4 || p.TenantQuantity != 1 || c.Stored == nil || c.Stored.ShareMicros != p.ShareMicros {
				t.Errorf("railway card = %+v / %+v", c, p)
			}
		case "resend":
			p := c.Previews[fin.RuleEmails]
			if !c.Pending || c.Rule != fin.RuleEmails || p.DriverTotal != 100 || p.ShareMicros != 0 {
				t.Errorf("resend card = %+v / %+v", c, p)
			}
		}
	}
}

func isInvalid(err error) bool {
	_, ok := errors.AsType[*ErrInvalid](err)
	return ok
}

// While a source is down, the open months are re-read once an hour, not on
// every tick: the newest capture decides staleness, and a failed driver keeps
// its old timestamp.
func TestAllocationRefreshIsHourlyWhileSourceDown(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	oct := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	h.drivers.set("2026-10", fin.DriverActiveTenants, map[string]int64{"t1": 1})
	if err := h.svc.AllocateShared(ctx); err != nil {
		t.Fatal(err)
	}
	first, _ := h.svc.repo.DriverSnapshots(ctx, oct)

	// Ogen goes down; an hour later one refresh runs and only Harbor's own
	// ai_cost is re-captured.
	h.drivers.down = map[string]bool{fin.DriverActiveTenants: true, fin.DriverPosts: true, fin.DriverEmails: true, fin.DriverActiveUsers: true}
	h.now = h.now.Add(61 * time.Minute)
	if err := h.svc.AllocateShared(ctx); err != nil {
		t.Fatal(err)
	}
	refreshed, _ := h.svc.repo.DriverSnapshots(ctx, oct)
	if !refreshed[fin.DriverAICost].After(first[fin.DriverAICost]) || !refreshed[fin.DriverActiveTenants].Equal(first[fin.DriverActiveTenants]) {
		t.Fatalf("after an hour: %v (was %v)", refreshed, first)
	}

	// The next tick inside the hour re-reads nothing.
	h.now = h.now.Add(time.Minute)
	if err := h.svc.AllocateShared(ctx); err != nil {
		t.Fatal(err)
	}
	again, _ := h.svc.repo.DriverSnapshots(ctx, oct)
	if !again[fin.DriverAICost].Equal(refreshed[fin.DriverAICost]) {
		t.Errorf("re-read on the next tick: %v → %v", refreshed[fin.DriverAICost], again[fin.DriverAICost])
	}
}

// A month with no tenant in any driver still serves an empty list, never null.
func TestAllocationViewEmptyTenants(t *testing.T) {
	h := newHarness(t)
	h.drivers.down[fin.DriverActiveTenants] = true
	v, err := h.svc.Allocation(t.Context(), time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC), "")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(v)
	if !strings.Contains(string(b), `"tenants":[]`) {
		t.Errorf("tenants not an empty array: %s", b)
	}
}
