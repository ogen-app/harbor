package handlers

import (
	"sort"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/ogen-app/harbor/src/repository/analytics"
)

// AnalyticsHandler serves aggregate views over the Ogen analytics/TimescaleDB
// pool (usage_events). Best-effort: an unconfigured or unreachable pool is
// reported as a soft "unavailable" state so the dashboard still renders.
type AnalyticsHandler struct {
	spend analytics.SpendRepository
}

func NewAnalyticsHandler(spend analytics.SpendRepository) *AnalyticsHandler {
	return &AnalyticsHandler{spend: spend}
}

func (h *AnalyticsHandler) Register(app *fiber.App, requireAuth fiber.Handler) {
	app.Get("/api/analytics/daily-cost", requireAuth, h.DailyCost)
}

// Daily-cost chart window bounds (days). The client may request a different
// window via ?days=, clamped to keep the query cheap.
const (
	dailyCostDefaultDays = 30
	dailyCostMaxDays     = 90
)

// modelTotal is one model's summed cost over the window. Ordered by cost desc,
// it drives the chart's legend order and colour assignment.
type modelTotal struct {
	Model      string `json:"model"`
	CostMicros int64  `json:"costMicros"`
}

// costDay is one calendar day of the chart: the ISO date, the day total, and
// the per-model cost split (only models with spend that day are present).
type costDay struct {
	Date        string           `json:"date"`
	TotalMicros int64            `json:"totalMicros"`
	Costs       map[string]int64 `json:"costs"`
}

// DailyCost godoc
// @Summary      Daily token cost by model
// @Description  Per-day AI token cost for the last N days (default 30, max 90),
// @Description  split by model, as a dense zero-filled series for the daily
// @Description  token-cost chart, plus per-model totals for the legend.
// @Tags         analytics
// @Produce      json
// @Param        days  query     int  false  "Window size in days (1-90)"
// @Success      200   {object}  map[string]any
// @Router       /api/analytics/daily-cost [get]
func (h *AnalyticsHandler) DailyCost(c *fiber.Ctx) error {
	if !h.spend.Available() {
		return c.JSON(fiber.Map{"available": false, "error": "analytics database not configured"})
	}

	days := dailyCostWindow(c)
	rows, err := h.spend.DailyCostByModel(c.Context(), days)
	if err != nil {
		return c.JSON(fiber.Map{"available": false, "error": err.Error()})
	}
	return c.JSON(buildDailyCost(rows, days))
}

// dailyCostWindow reads the ?days= window for the daily-cost charts, clamped to
// [1, dailyCostMaxDays] with dailyCostDefaultDays as the fallback.
func dailyCostWindow(c *fiber.Ctx) int {
	days := c.QueryInt("days", dailyCostDefaultDays)
	if days < 1 {
		days = dailyCostDefaultDays
	}
	if days > dailyCostMaxDays {
		days = dailyCostMaxDays
	}
	return days
}

// buildDailyCost turns raw (day, model) cost buckets into the daily token-cost
// chart response: a dense zero-filled day series, per-model totals ordered for
// the legend, and the grand total. Shared by the global and per-tenant charts.
func buildDailyCost(rows []analytics.DailyModelCost, days int) fiber.Map {
	// Index the raw (day, model) buckets and accumulate per-model + grand totals.
	byDay := make(map[string]map[string]int64, len(rows))
	modelTotals := make(map[string]int64)
	var grand int64
	for _, r := range rows {
		if byDay[r.Date] == nil {
			byDay[r.Date] = make(map[string]int64)
		}
		byDay[r.Date][r.Model] += r.CostMicros
		modelTotals[r.Model] += r.CostMicros
		grand += r.CostMicros
	}

	// Dense zero-filled day series (oldest → newest) over UTC calendar days, so
	// the chart always has one column per day even when nothing was spent.
	now := time.Now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	series := make([]costDay, 0, days)
	for i := days - 1; i >= 0; i-- {
		date := today.AddDate(0, 0, -i).Format("2006-01-02")
		costs := byDay[date]
		if costs == nil {
			costs = map[string]int64{}
		}
		var dayTotal int64
		for _, v := range costs {
			dayTotal += v
		}
		series = append(series, costDay{Date: date, TotalMicros: dayTotal, Costs: costs})
	}

	// Models ordered by total cost desc (stable legend + colour order); ties
	// broken by model name for determinism.
	models := make([]modelTotal, 0, len(modelTotals))
	for m, t := range modelTotals {
		models = append(models, modelTotal{Model: m, CostMicros: t})
	}
	sort.Slice(models, func(a, b int) bool {
		if models[a].CostMicros != models[b].CostMicros {
			return models[a].CostMicros > models[b].CostMicros
		}
		return models[a].Model < models[b].Model
	})

	return fiber.Map{
		"available":   true,
		"windowDays":  days,
		"totalMicros": grand,
		"models":      models,
		"days":        series,
	}
}
