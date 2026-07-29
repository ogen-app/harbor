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
	tenants  ogen.TenantRepository
	spend    analytics.SpendRepository
	activity analytics.ActivityRepository
}

func NewTenantsHandler(tenants ogen.TenantRepository, spend analytics.SpendRepository, activity analytics.ActivityRepository) *TenantsHandler {
	return &TenantsHandler{tenants: tenants, spend: spend, activity: activity}
}

func (h *TenantsHandler) Register(app *fiber.App, requireAuth fiber.Handler) {
	app.Get("/api/tenants", requireAuth, h.List)
	app.Get("/api/tenants/overview", requireAuth, h.Overview)
	app.Get("/api/tenants/registrations", requireAuth, h.Registrations)
	app.Get("/api/tenants/:id/activity", requireAuth, h.Activity)
	app.Get("/api/tenants/:id/activity/:eventId", requireAuth, h.ActivityEvent)
	app.Get("/api/tenants/:id/daily-cost", requireAuth, h.DailyCost)
	app.Get("/api/tenants/:id/users", requireAuth, h.Users)
	app.Get("/api/tenants/:id/zernio", requireAuth, h.Zernio)
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

const regWindowDays = 90

// Registrations godoc
// @Summary      Tenant registrations (90 days)
// @Description  Daily count and names of tenants created over the last 90 days,
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

// recentActivityLimit is the default cap on a tenant's activity feed (the
// Tenants-table expanded row uses it; the detail page requests more via ?limit).
// activityMaxLimit bounds the ?limit override so the query stays cheap.
const (
	recentActivityLimit = 15
	activityMaxLimit    = 500
)

// activityWindowDays is the span of the detail page's activity chart.
const activityWindowDays = 90

// activityDay is one day of the activity chart: an ISO date, the day total, and
// the per-category split (only categories with events that day are present).
type activityDay struct {
	Date   string         `json:"date"`
	Total  int            `json:"total"`
	Counts map[string]int `json:"counts"`
}

// Activity godoc
// @Summary      Tenant recent activity
// @Description  A tenant's recent tenant_activity_events (newest first) plus, on the
// @Description  initial unfiltered page, a dense 90-day daily event-count series
// @Description  for the detail page's activity chart. Events page via a keyset
// @Description  cursor (beforeAt+beforeId) and can be scoped to one category
// @Description  and/or UTC day; hasMore signals whether an older page exists.
// @Description  Sourced from the centralised tenant_activity_events hypertable in the
// @Description  analytics DB (Ogen CON-125). Also loaded when a row is expanded
// @Description  in the Tenants table.
// @Tags         tenants
// @Produce      json
// @Param        id        path   string  true   "Tenant ID"
// @Param        limit     query  int     false  "Max events (1-500, default 15)"
// @Param        category  query  string  false  "Only events in this category"
// @Param        day       query  string  false  "Only events on this UTC day (YYYY-MM-DD)"
// @Param        beforeAt  query  string  false  "Keyset cursor: occurred_at of the last loaded event (RFC3339)"
// @Param        beforeId  query  string  false  "Keyset cursor: id of the last loaded event"
// @Success      200  {object}  map[string]any
// @Router       /api/tenants/{id}/activity [get]
func (h *TenantsHandler) Activity(c *fiber.Ctx) error {
	if !h.activity.Available() {
		return c.JSON(fiber.Map{"activity": []analytics.ActivityEvent{}, "series": []activityDay{}, "categories": []string{}, "hasMore": false, "available": false, "error": "analytics database not configured"})
	}
	id := c.Params("id")

	limit := c.QueryInt("limit", recentActivityLimit)
	if limit < 1 {
		limit = recentActivityLimit
	}
	if limit > activityMaxLimit {
		limit = activityMaxLimit
	}

	q := analytics.ActivityQuery{
		TenantID: id,
		Category: strings.TrimSpace(c.Query("category")),
		Day:      strings.TrimSpace(c.Query("day")),
		Limit:    limit + 1, // one extra row tells us whether an older page exists
	}
	// Keyset cursor for lazy-loading older events: the client echoes back the last
	// row's occurred_at + id. A malformed timestamp is a client error, not a
	// silent fall-back to the first page — which would make the client re-serve
	// and duplicate rows it already has.
	if at := strings.TrimSpace(c.Query("beforeAt")); at != "" {
		t, perr := time.Parse(time.RFC3339Nano, at)
		if perr != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"available": true, "error": "invalid beforeAt cursor"})
		}
		q.BeforeAt = t
		q.BeforeID = strings.TrimSpace(c.Query("beforeId"))
		q.HasCursor = true
	}

	events, err := h.activity.Events(c.Context(), q)
	if err != nil {
		return c.JSON(fiber.Map{"activity": []analytics.ActivityEvent{}, "series": []activityDay{}, "categories": []string{}, "hasMore": false, "available": false, "error": err.Error()})
	}
	hasMore := len(events) > limit
	if hasMore {
		events = events[:limit]
	}

	// The chart's dense series + legend are only needed on the initial, unfiltered
	// page; the client keeps them while paging and switching chart selections.
	if q.HasCursor || q.Category != "" || q.Day != "" {
		return c.JSON(fiber.Map{"activity": events, "hasMore": hasMore, "available": true})
	}

	// 90-day daily event counts split by category, zero-filled for the chart.
	// Best-effort: a query failure yields a flat series while the event list
	// still renders.
	counts, _ := h.activity.ActivitySeries(c.Context(), id, activityWindowDays)
	byDay := make(map[string]map[string]int, len(counts))
	catTotals := make(map[string]int)
	for _, r := range counts {
		if byDay[r.Date] == nil {
			byDay[r.Date] = make(map[string]int)
		}
		byDay[r.Date][r.Category] += r.Count
		catTotals[r.Category] += r.Count
	}

	now := time.Now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	series := make([]activityDay, 0, activityWindowDays)
	for i := activityWindowDays - 1; i >= 0; i-- {
		date := today.AddDate(0, 0, -i).Format("2006-01-02")
		cm := byDay[date]
		if cm == nil {
			cm = map[string]int{}
		}
		total := 0
		for _, v := range cm {
			total += v
		}
		series = append(series, activityDay{Date: date, Total: total, Counts: cm})
	}

	// Categories ordered by total desc (stable legend + colour order); ties
	// broken by name for determinism.
	categories := make([]string, 0, len(catTotals))
	for cat := range catTotals {
		categories = append(categories, cat)
	}
	sort.Slice(categories, func(a, b int) bool {
		if catTotals[categories[a]] != catTotals[categories[b]] {
			return catTotals[categories[a]] > catTotals[categories[b]]
		}
		return categories[a] < categories[b]
	})

	return c.JSON(fiber.Map{"activity": events, "series": series, "categories": categories, "hasMore": hasMore, "available": true})
}

// ActivityEvent godoc
// @Summary      Tenant activity event detail
// @Description  Every field of a single tenant_activity_events row (except tenant_id),
// @Description  including tags and payload, for the detail popover. Loaded on
// @Description  demand when the row's details button is clicked.
// @Tags         tenants
// @Produce      json
// @Param        id       path   string  true  "Tenant ID"
// @Param        eventId  path   string  true  "Activity event ID"
// @Success      200  {object}  map[string]any
// @Router       /api/tenants/{id}/activity/{eventId} [get]
func (h *TenantsHandler) ActivityEvent(c *fiber.Ctx) error {
	if !h.activity.Available() {
		return c.JSON(fiber.Map{"available": false, "error": "analytics database not configured"})
	}
	event, err := h.activity.ActivityByID(c.Context(), c.Params("id"), c.Params("eventId"))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return c.JSON(fiber.Map{"available": true, "found": false})
		}
		return c.JSON(fiber.Map{"available": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"available": true, "found": true, "event": event})
}

// DailyCost godoc
// @Summary      Tenant daily token cost by model
// @Description  Per-day AI token cost for a single tenant over the last N days
// @Description  (default 30, max 90), split by model — the per-tenant twin of
// @Description  /api/analytics/daily-cost. Powers the detail page's token-cost chart.
// @Tags         tenants
// @Produce      json
// @Param        id    path      string  true   "Tenant ID"
// @Param        days  query     int     false  "Window size in days (1-90)"
// @Success      200   {object}  map[string]any
// @Router       /api/tenants/{id}/daily-cost [get]
func (h *TenantsHandler) DailyCost(c *fiber.Ctx) error {
	if !h.spend.Available() {
		return c.JSON(fiber.Map{"available": false, "error": "analytics database not configured"})
	}
	days := dailyCostWindow(c)
	rows, err := h.spend.DailyCostByModelForTenant(c.Context(), c.Params("id"), days)
	if err != nil {
		return c.JSON(fiber.Map{"available": false, "error": err.Error()})
	}
	return c.JSON(buildDailyCost(rows, days))
}

// tenantUsersLimit caps a tenant's user list (an admin tenant has a bounded
// number of members; this is a safety ceiling, not pagination).
const tenantUsersLimit = 200

// Users godoc
// @Summary      Tenant users
// @Description  Members of a tenant (name, email, joined date) from the Ogen
// @Description  users table, newest first. Powers the /tenants/{id} user list.
// @Tags         tenants
// @Produce      json
// @Param        id   path      string  true  "Tenant ID"
// @Success      200  {object}  map[string]any
// @Router       /api/tenants/{id}/users [get]
func (h *TenantsHandler) Users(c *fiber.Ctx) error {
	if !h.tenants.Available() {
		return c.JSON(fiber.Map{"users": []ogen.User{}, "available": false, "error": "ogen database not configured"})
	}

	users, err := h.tenants.Users(c.Context(), c.Params("id"), tenantUsersLimit)
	if err != nil {
		return c.JSON(fiber.Map{"users": []ogen.User{}, "available": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"users": users, "available": true})
}

// Zernio godoc
// @Summary      Tenant Zernio accounts
// @Description  A tenant's connected social profiles (platform, username) with
// @Description  per-account post throughput — scheduled, published, failed, and
// @Description  total. Powers the /tenants/{id} Zernio accounts block.
// @Tags         tenants
// @Produce      json
// @Param        id   path      string  true  "Tenant ID"
// @Success      200  {object}  map[string]any
// @Router       /api/tenants/{id}/zernio [get]
func (h *TenantsHandler) Zernio(c *fiber.Ctx) error {
	if !h.tenants.Available() {
		return c.JSON(fiber.Map{"accounts": []ogen.ZernioAccount{}, "available": false, "error": "ogen database not configured"})
	}

	accounts, err := h.tenants.ZernioAccounts(c.Context(), c.Params("id"))
	if err != nil {
		return c.JSON(fiber.Map{"accounts": []ogen.ZernioAccount{}, "available": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"accounts": accounts, "available": true})
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
