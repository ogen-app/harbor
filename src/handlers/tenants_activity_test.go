package handlers

import (
	"testing"
	"time"

	"github.com/ogen-app/harbor/src/repository/analytics"
)

// buildActivitySparklines must fold sparse (tenant, day) counts into a dense
// per-tenant series of length windowDays ending today (UTC), summing same-day
// duplicates, keying by tenant, and dropping out-of-window rows.
func TestBuildActivitySparklines(t *testing.T) {
	now := time.Now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	todayStr := today.Format("2006-01-02")
	yesterday := today.AddDate(0, 0, -1).Format("2006-01-02")
	tooOld := today.AddDate(0, 0, -30).Format("2006-01-02") // outside a 30-day window
	const window = 30

	rows := []analytics.TenantDayCount{
		{TenantID: "a", Date: todayStr, Count: 3},
		{TenantID: "a", Date: todayStr, Count: 2}, // same day → summed
		{TenantID: "a", Date: yesterday, Count: 1},
		{TenantID: "b", Date: todayStr, Count: 7},
		{TenantID: "a", Date: tooOld, Count: 9}, // dropped (outside window)
	}

	got := buildActivitySparklines(rows, window)

	a, ok := got["a"]
	if !ok {
		t.Fatal("tenant a missing from result")
	}
	if len(a) != window {
		t.Fatalf("tenant a series length = %d, want %d", len(a), window)
	}
	if a[window-1] != 5 {
		t.Errorf("tenant a today (last slot) = %d, want 5 (3+2)", a[window-1])
	}
	if a[window-2] != 1 {
		t.Errorf("tenant a yesterday = %d, want 1", a[window-2])
	}
	// The dropped too-old row must not leak into any slot: total is 3+2+1 = 6.
	sum := 0
	for _, v := range a {
		sum += v
	}
	if sum != 6 {
		t.Errorf("tenant a total = %d, want 6 (out-of-window row dropped)", sum)
	}

	if b := got["b"]; b[window-1] != 7 {
		t.Errorf("tenant b today = %d, want 7", b[window-1])
	}

	if _, exists := got["c"]; exists {
		t.Error("tenant c has no events and must be absent from the map")
	}
}
