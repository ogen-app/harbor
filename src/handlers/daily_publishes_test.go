package handlers

import (
	"encoding/json"
	"io"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/ogen-app/harbor/src/repository/ogen"
)

// buildDailyPublishes must produce a dense, one-column-per-day series ending on
// today (UTC), correct per-day + grand totals, and platforms ordered by count
// desc with name as the tie-break.
func TestBuildDailyPublishes(t *testing.T) {
	today := time.Now().UTC().Format("2006-01-02")
	rows := []ogen.PublishingDayStat{
		{Date: today, Platform: "Instagram", Count: 3},
		{Date: today, Platform: "LinkedIn", Count: 5},
		{Date: today, Platform: "Facebook", Count: 5}, // ties LinkedIn on count
	}

	out := buildDailyPublishes(rows, 7)

	if out["available"] != true {
		t.Fatalf("available = %v, want true", out["available"])
	}
	if out["windowDays"].(int) != 7 {
		t.Errorf("windowDays = %v, want 7", out["windowDays"])
	}
	if out["total"].(int) != 13 {
		t.Errorf("total = %v, want 13", out["total"])
	}

	series := out["days"].([]publishingDay)
	if len(series) != 7 {
		t.Fatalf("series length = %d, want 7 (dense fill)", len(series))
	}
	last := series[len(series)-1]
	if last.Date != today {
		t.Errorf("last day = %s, want today %s", last.Date, today)
	}
	if last.Total != 13 {
		t.Errorf("last day total = %d, want 13", last.Total)
	}
	if last.Counts["Instagram"] != 3 {
		t.Errorf("last day Instagram = %d, want 3", last.Counts["Instagram"])
	}
	// Earlier days are zero-filled (never nil), so the chart can map over them.
	if series[0].Total != 0 || series[0].Counts == nil {
		t.Errorf("first day = %+v, want zero-filled with non-nil counts", series[0])
	}

	platforms := out["platforms"].([]platformTotal)
	if len(platforms) != 3 {
		t.Fatalf("platforms length = %d, want 3", len(platforms))
	}
	// Count desc, ties broken alphabetically: Facebook(5), LinkedIn(5), Instagram(3).
	want := []string{"Facebook", "LinkedIn", "Instagram"}
	for i, w := range want {
		if platforms[i].Platform != w {
			t.Errorf("platforms[%d] = %s, want %s", i, platforms[i].Platform, w)
		}
	}
}

// An unconfigured Ogen pool must degrade to a soft 200 { available:false },
// never a hard error — matching the other dashboard reads.
func TestDailyPublishes_SoftUnavailable(t *testing.T) {
	app := fiber.New()
	// A nil pool yields a repo whose Available() is false.
	NewTenantsHandler(ogen.NewTenantRepository(nil), nil, nil, nil).Register(app, passAuth)

	resp, err := app.Test(httptest.NewRequest("GET", "/api/tenants/daily-publishes", nil))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if resp.StatusCode != fiber.StatusOK {
		t.Fatalf("status = %d, want 200 (soft unavailable)", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	var got struct {
		Available bool `json:"available"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode: %v (body=%s)", err, body)
	}
	if got.Available {
		t.Errorf("available = true, want false when the Ogen pool is nil")
	}
}
