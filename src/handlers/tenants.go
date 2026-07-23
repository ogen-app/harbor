package handlers

import (
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/ogen-app/harbor/src/repository/analytics"
	"github.com/ogen-app/harbor/src/repository/ogen"
	"github.com/ogen-app/harbor/src/stats/tenants"
)

// TenantsHandler serves Ogen tenant data (read-only) via the origin-scoped
// repositories: the Ogen control-plane pool (identity + metrics) and the
// analytics pool (AI spend). Either repository may be unavailable (unconfigured
// or unreachable); that is reported as a soft state rather than an error, so the
// dashboard can still render.
type TenantsHandler struct {
	tenants ogen.TenantRepository
	spend   analytics.SpendRepository
}

func NewTenantsHandler(tenants ogen.TenantRepository, spend analytics.SpendRepository) *TenantsHandler {
	return &TenantsHandler{tenants: tenants, spend: spend}
}

func (h *TenantsHandler) Register(app *fiber.App, requireAuth fiber.Handler) {
	app.Get("/api/tenants", requireAuth, h.List)
	app.Get("/api/tenants/overview", requireAuth, h.Overview)
	app.Get("/api/tenants/registrations", requireAuth, h.Registrations)
	app.Get("/api/tenants/:id/activity", requireAuth, h.Activity)
	// Registered after the static /overview and /registrations paths so those
	// win over the :id param; Fiber matches routes in registration order.
	app.Get("/api/tenants/:id", requireAuth, h.Detail)
}

// tenantRow is one row of the Tenants table: identity plus the metric columns
// (users, Zernio profiles, R2 storage) and, when analytics is available, the
// current-period AI-spend split by model vendor.
type tenantRow struct {
	ID             string                `json:"id"`
	Name           string                `json:"name"`
	Slug           string                `json:"slug"`
	CreatedAt      time.Time             `json:"createdAt"`
	Status         string                `json:"status"`
	Users          int                   `json:"users"`
	ZernioProfiles int                   `json:"zernioProfiles"`
	R2Bytes        int64                 `json:"r2Bytes"`
	Spend          analytics.VendorSpend `json:"spend"`
}

// rowFromMetrics builds a table row from a tenant's Ogen-side metrics and its
// (possibly zero) AI spend. Ogen has no lifecycle column yet, so status is
// always "active".
func rowFromMetrics(m ogen.TenantMetrics, spend analytics.VendorSpend) tenantRow {
	return tenantRow{
		ID:             m.ID,
		Name:           m.Name,
		Slug:           m.Slug,
		CreatedAt:      m.CreatedAt,
		Status:         "active",
		Users:          m.Users,
		ZernioProfiles: m.ZernioProfiles,
		R2Bytes:        m.R2Bytes,
		Spend:          spend,
	}
}

// tenantFilter is one structured token from the Tenants table's power search: a
// field, an operator, and a value. Matching mirrors the client so UI and API
// agree. Filtering runs in Go (not SQL) because AI spend is merged from the
// separate analytics DB and can't be joined against the Ogen tenants table;
// unknown fields/operators are treated as no-ops.
type tenantFilter struct {
	Field    string `json:"field"`
	Operator string `json:"operator"`
	Value    string `json:"value"`
}

func (f tenantFilter) match(t tenantRow) bool {
	switch f.Field {
	case "name":
		has := strings.Contains(strings.ToLower(t.Name), strings.ToLower(f.Value))
		if f.Operator == "does not contain" {
			return !has
		}
		return has
	case "status":
		if f.Operator == "is not" {
			return t.Status != f.Value
		}
		return t.Status == f.Value
	case "spend":
		n, err := strconv.ParseFloat(strings.TrimSpace(f.Value), 64)
		if err != nil {
			return true
		}
		usd := float64(t.Spend.TotalMicros) / 1e6
		if f.Operator == "less than" {
			return usd < n
		}
		return usd > n
	case "zernio":
		n, err := strconv.Atoi(strings.TrimSpace(f.Value))
		if err != nil {
			return true
		}
		switch f.Operator {
		case "less than":
			return t.ZernioProfiles < n
		case "equals":
			return t.ZernioProfiles == n
		default:
			return t.ZernioProfiles > n
		}
	}
	return true
}

// parseFilters decodes the JSON `filters` query param. A missing or malformed
// value yields no filters (the full list), never an error.
func parseFilters(raw string) []tenantFilter {
	if raw == "" {
		return nil
	}
	var filters []tenantFilter
	if err := json.Unmarshal([]byte(raw), &filters); err != nil {
		return nil
	}
	return filters
}

// List godoc
// @Summary      Ogen tenants
// @Description  Tenants in the Ogen control-plane database with per-tenant
// @Description  metrics: user counts, connected Zernio (social) profiles, R2
// @Description  storage bytes, and current-period AI spend split by vendor.
// @Tags         tenants
// @Produce      json
// @Success      200  {object}  map[string]any
// @Router       /api/tenants [get]
func (h *TenantsHandler) List(c *fiber.Ctx) error {
	if !h.tenants.Available() {
		return c.JSON(fiber.Map{"tenants": []tenantRow{}, "available": false, "error": "ogen database not configured"})
	}

	metrics, err := h.tenants.ListMetrics(c.Context())
	if err != nil {
		return c.JSON(fiber.Map{"tenants": []tenantRow{}, "available": false, "error": err.Error()})
	}

	// Cross-database AI spend, merged by tenant id. Best-effort: an error just
	// hides the concentration bars (spendAvailable=false).
	spend, spendErr := h.spend.ByTenant(c.Context())
	spendAvailable := spendErr == nil

	rows := make([]tenantRow, len(metrics))
	for i, m := range metrics {
		rows[i] = rowFromMetrics(m, spend[m.ID])
	}

	// Distinct statuses across all tenants, for the filter dropdown — computed
	// before filtering so the option list never shrinks with the results.
	statusSet := map[string]struct{}{}
	for _, r := range rows {
		statusSet[r.Status] = struct{}{}
	}
	statuses := make([]string, 0, len(statusSet))
	for s := range statusSet {
		statuses = append(statuses, s)
	}
	sort.Strings(statuses)

	total := len(rows)

	// Server-side power search: keep tenants matching every filter (AND).
	if filters := parseFilters(c.Query("filters")); len(filters) > 0 {
		filtered := make([]tenantRow, 0, len(rows))
		for _, r := range rows {
			match := true
			for _, f := range filters {
				if !f.match(r) {
					match = false
					break
				}
			}
			if match {
				filtered = append(filtered, r)
			}
		}
		rows = filtered
	}

	return c.JSON(fiber.Map{
		"tenants":        rows,
		"total":          total,
		"statuses":       statuses,
		"available":      true,
		"spendAvailable": spendAvailable,
	})
}

// Detail godoc
// @Summary      Ogen tenant detail
// @Description  A single tenant with the same identity and metric columns as the
// @Description  Tenants list (users, Zernio profiles, R2 storage, current-period
// @Description  AI spend split by vendor). Powers the /tenants/{id} detail page.
// @Tags         tenants
// @Produce      json
// @Param        id   path      string  true  "Tenant ID"
// @Success      200  {object}  map[string]any
// @Router       /api/tenants/{id} [get]
func (h *TenantsHandler) Detail(c *fiber.Ctx) error {
	if !h.tenants.Available() {
		return c.JSON(fiber.Map{"available": false, "error": "ogen database not configured"})
	}
	id := c.Params("id")

	metrics, err := h.tenants.GetMetrics(c.Context(), id)
	if err != nil {
		// No row for this id is a not-found (soft), not a hard error.
		if errors.Is(err, sql.ErrNoRows) {
			return c.JSON(fiber.Map{"available": true, "found": false})
		}
		return c.JSON(fiber.Map{"available": false, "error": err.Error()})
	}

	// Cross-database AI spend, indexed to this tenant. Best-effort like List.
	spend, spendErr := h.spend.ByTenant(c.Context())
	spendAvailable := spendErr == nil

	return c.JSON(fiber.Map{
		"available":      true,
		"found":          true,
		"tenant":         rowFromMetrics(*metrics, spend[metrics.ID]),
		"spendAvailable": spendAvailable,
	})
}

// regDay is one day in the registrations chart: an ISO date, the number of
// tenants created that day, and their names (for the hover tooltip).
type regDay struct {
	Date  string   `json:"date"`
	Count int      `json:"count"`
	Names []string `json:"names"`
}

const regWindowDays = 60

// Registrations godoc
// @Summary      Tenant registrations (60 days)
// @Description  Daily count and names of tenants created over the last 60 days,
// @Description  as a dense zero-filled series for the registrations bar chart.
// @Tags         tenants
// @Produce      json
// @Success      200  {object}  map[string]any
// @Router       /api/tenants/registrations [get]
func (h *TenantsHandler) Registrations(c *fiber.Ctx) error {
	if !h.tenants.Available() {
		return c.JSON(fiber.Map{"days": []regDay{}, "available": false, "error": "ogen database not configured"})
	}

	// Pull the raw registrations in-window and build the dense series here, so
	// each day can carry the list of tenant names. Bucketed by UTC calendar day.
	regs, err := h.tenants.Registrations(c.Context(), regWindowDays)
	if err != nil {
		return c.JSON(fiber.Map{"days": []regDay{}, "available": false, "error": err.Error()})
	}

	byDay := make(map[string][]string, len(regs))
	for _, r := range regs {
		byDay[r.Date] = append(byDay[r.Date], r.Name)
	}

	now := time.Now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	days := make([]regDay, 0, regWindowDays)
	for i := regWindowDays - 1; i >= 0; i-- {
		date := today.AddDate(0, 0, -i).Format("2006-01-02")
		names := byDay[date]
		if names == nil {
			names = []string{}
		}
		days = append(days, regDay{Date: date, Count: len(names), Names: names})
	}
	return c.JSON(fiber.Map{"days": days, "available": true})
}

// recentActivityLimit caps a tenant's activity feed.
const recentActivityLimit = 15

// Activity godoc
// @Summary      Tenant recent activity
// @Description  Most recent post_logs events for a tenant. Loaded lazily when a
// @Description  tenant row is expanded in the Tenants table.
// @Tags         tenants
// @Produce      json
// @Param        id   path      string  true  "Tenant ID"
// @Success      200  {object}  map[string]any
// @Router       /api/tenants/{id}/activity [get]
func (h *TenantsHandler) Activity(c *fiber.Ctx) error {
	if !h.tenants.Available() {
		return c.JSON(fiber.Map{"activity": []ogen.ActivityEvent{}, "available": false, "error": "ogen database not configured"})
	}

	events, err := h.tenants.Activity(c.Context(), c.Params("id"), recentActivityLimit)
	if err != nil {
		return c.JSON(fiber.Map{"activity": []ogen.ActivityEvent{}, "available": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"activity": events, "available": true})
}

// Overview godoc
// @Summary      Tenant dashboard overview
// @Description  Aggregated tenant metrics: lifecycle headline, movement,
// @Description  activity pulse, AI-spend concentration, quota (placeholder),
// @Description  and exception counts.
// @Tags         tenants
// @Produce      json
// @Success      200  {object}  map[string]any
// @Router       /api/tenants/overview [get]
func (h *TenantsHandler) Overview(c *fiber.Ctx) error {
	if !h.tenants.Available() {
		return c.JSON(fiber.Map{"available": false, "error": "ogen database not configured"})
	}
	overview := tenants.Collect(c.Context(), h.tenants, h.spend)
	return c.JSON(fiber.Map{"available": true, "overview": overview})
}
