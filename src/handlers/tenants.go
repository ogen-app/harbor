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
	"github.com/ogen-app/harbor/src/repository/ogentenants"
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
	// admin is the gRPC client for tenant-classification WRITES (tier/group
	// assignment). Reads come from the Ogen DB via `tenants`. May be nil when the
	// gRPC surface is unconfigured — writes then return 503.
	admin *ogentenants.Client
}

func NewTenantsHandler(tenants ogen.TenantRepository, spend analytics.SpendRepository, activity analytics.ActivityRepository, admin *ogentenants.Client) *TenantsHandler {
	return &TenantsHandler{tenants: tenants, spend: spend, activity: activity, admin: admin}
}

func (h *TenantsHandler) Register(app *fiber.App, requireAuth fiber.Handler) {
	app.Get("/api/tenants", requireAuth, h.List)
	app.Get("/api/tenants/overview", requireAuth, h.Overview)
	app.Get("/api/tenants/registrations", requireAuth, h.Registrations)
	app.Get("/api/tenants/daily-publishes", requireAuth, h.DailyPublishes)
	// Cross-tenant activity feed for the global Activity page (?tenant= narrows
	// it to one tenant); the per-tenant feed below is the same payload scoped by
	// path param.
	app.Get("/api/activity", requireAuth, h.GlobalActivity)
	app.Get("/api/tenants/:id/activity", requireAuth, h.Activity)
	app.Get("/api/tenants/:id/activity/:eventId", requireAuth, h.ActivityEvent)
	app.Get("/api/tenants/:id/daily-cost", requireAuth, h.DailyCost)
	app.Get("/api/tenants/:id/users", requireAuth, h.Users)
	app.Get("/api/tenants/:id/zernio", requireAuth, h.Zernio)
	// Tenant classification writes (tier assignment + group membership) — these
	// go through the gRPC surface, unlike the DB-backed reads above. Distinct
	// path shapes, so they never collide with the :id detail route below.
	app.Put("/api/tenants/:id/tier", requireAuth, h.SetTier)
	app.Put("/api/tenants/:id/status", requireAuth, h.SetStatus)
	app.Post("/api/tenants/:id/groups/:groupId", requireAuth, h.AddGroup)
	app.Delete("/api/tenants/:id/groups/:groupId", requireAuth, h.RemoveGroup)
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
	StatusReason   string                `json:"statusReason"`
	Users          int                   `json:"users"`
	ZernioProfiles int                   `json:"zernioProfiles"`
	R2Bytes        int64                 `json:"r2Bytes"`
	Spend          analytics.VendorSpend `json:"spend"`
	// Classification (CON-208), read from the Ogen DB. Tier is nil when the
	// classification tables are absent; Groups is always non-nil (possibly empty).
	Tier   *ogen.Tier   `json:"tier"`
	Groups []ogen.Group `json:"groups"`
	// Activity (CON-223) is the trailing activitySparkWindowDays daily
	// activity-event counts (oldest→newest) for this tenant's sparkline. Nil when
	// analytics is unavailable; a zero-filled slice when the tenant had no events.
	Activity []int `json:"activity"`
}

// rowFromMetrics builds a table row from a tenant's Ogen-side metrics and its
// (possibly zero) AI spend. Status/StatusReason are the CON-190 lifecycle fields,
// read from the Ogen DB (falling back to "active" for an un-migrated Ogen).
func rowFromMetrics(m ogen.TenantMetrics, spend analytics.VendorSpend) tenantRow {
	status := m.Status
	if status == "" {
		status = "active"
	}
	return tenantRow{
		ID:             m.ID,
		Name:           m.Name,
		Slug:           m.Slug,
		CreatedAt:      m.CreatedAt,
		Status:         status,
		StatusReason:   m.StatusReason,
		Users:          m.Users,
		ZernioProfiles: m.ZernioProfiles,
		R2Bytes:        m.R2Bytes,
		Spend:          spend,
		Groups:         []ogen.Group{}, // never null, so the UI can map over it
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
	case "tier":
		name := ""
		if t.Tier != nil {
			name = t.Tier.Name
		}
		has := strings.EqualFold(name, f.Value)
		if f.Operator == "is not" {
			return !has
		}
		return has
	case "group":
		has := false
		for _, g := range t.Groups {
			if strings.EqualFold(g.Name, f.Value) {
				has = true
				break
			}
		}
		if f.Operator == "excludes" {
			return !has
		}
		return has
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

// activitySparkWindowDays is the trailing window for the Tenants-table activity
// sparkline (CON-223): one month of daily action counts per tenant.
const activitySparkWindowDays = 30

// buildActivitySparklines folds sparse per-tenant daily counts into a dense,
// zero-filled slice per tenant of length windowDays (oldest→newest UTC calendar
// days), keyed by tenant id — the fixed-length series each row's sparkline plots.
// Counts falling outside the window (clock skew at the boundary) are dropped.
func buildActivitySparklines(rows []analytics.TenantDayCount, windowDays int) map[string][]int {
	now := time.Now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	// UTC date "YYYY-MM-DD" → slot index in [0, windowDays).
	slot := make(map[string]int, windowDays)
	for i := 0; i < windowDays; i++ {
		date := today.AddDate(0, 0, -(windowDays-1-i)).Format("2006-01-02")
		slot[date] = i
	}
	byTenant := make(map[string][]int, len(rows))
	for _, r := range rows {
		i, ok := slot[r.Date]
		if !ok {
			continue
		}
		series := byTenant[r.TenantID]
		if series == nil {
			series = make([]int, windowDays)
			byTenant[r.TenantID] = series
		}
		series[i] += r.Count
	}
	return byTenant
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

	// Tenant classification, read from the Ogen DB (writes go via gRPC). All
	// best-effort: a failure leaves tier nil / groups empty and simply hides the
	// chips + filters rather than failing the list. The catalogs feed the filter
	// options and the row edit menu.
	tierByTenant, _ := h.tenants.TenantTiers(c.Context())
	groupsByTenant, _ := h.tenants.TenantGroups(c.Context())
	tierCatalog, _ := h.tenants.ListTiers(c.Context())
	groupCatalog, _ := h.tenants.ListGroups(c.Context())
	for i := range rows {
		if tier, ok := tierByTenant[rows[i].ID]; ok {
			t := tier
			rows[i].Tier = &t
		}
		if gs := groupsByTenant[rows[i].ID]; gs != nil {
			rows[i].Groups = gs
		}
	}
	if tierCatalog == nil {
		tierCatalog = []ogen.Tier{}
	}
	if groupCatalog == nil {
		groupCatalog = []ogen.Group{}
	}

	// Per-tenant activity sparklines (CON-223): a single grouped scan of the
	// analytics activity hypertable, folded into a dense 30-day daily-count series
	// per tenant. Best-effort — a failure just drops the column
	// (activityAvailable=false) rather than failing the list. A tenant with no
	// events gets a zero-filled series (a flat baseline), so the column always has
	// one point per day.
	activityAvailable := false
	if h.activity.Available() {
		if daily, err := h.activity.ActivityByTenantDaily(c.Context(), activitySparkWindowDays); err == nil {
			activityAvailable = true
			spark := buildActivitySparklines(daily, activitySparkWindowDays)
			for i := range rows {
				if series, ok := spark[rows[i].ID]; ok {
					rows[i].Activity = series
				} else {
					rows[i].Activity = make([]int, activitySparkWindowDays)
				}
			}
		}
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
		"tenants":           rows,
		"total":             total,
		"statuses":          statuses,
		"tiers":             tierCatalog,
		"groups":            groupCatalog,
		"available":         true,
		"spendAvailable":    spendAvailable,
		"activityAvailable": activityAvailable,
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

	row := rowFromMetrics(*metrics, spend[metrics.ID])
	// Classification for this tenant (best-effort), so the detail page can show
	// the tier + groups alongside the list.
	if tierByTenant, err := h.tenants.TenantTiers(c.Context()); err == nil {
		if tier, ok := tierByTenant[row.ID]; ok {
			t := tier
			row.Tier = &t
		}
	}
	if groupsByTenant, err := h.tenants.TenantGroups(c.Context()); err == nil {
		if gs := groupsByTenant[row.ID]; gs != nil {
			row.Groups = gs
		}
	}

	return c.JSON(fiber.Map{
		"available":      true,
		"found":          true,
		"tenant":         row,
		"spendAvailable": spendAvailable,
	})
}

// setTierRequest is the body of PUT /api/tenants/:id/tier.
type setTierRequest struct {
	TierID string `json:"tierId"`
}

// SetTier assigns (or reassigns) a tenant's tier via the gRPC surface. Tier is
// required, so this always sets a valid tier — there is no unassign.
//
// SetTier godoc
// @Summary  Set a tenant's tier
// @Tags     tenants
// @Accept   json
// @Param    id    path  string          true  "Tenant ID"
// @Param    body  body  setTierRequest  true  "Target tier id"
// @Success  204
// @Router   /api/tenants/{id}/tier [put]
func (h *TenantsHandler) SetTier(c *fiber.Ctx) error {
	var req setTierRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	if err := h.admin.SetTenantTier(c.Context(), c.Params("id"), req.TierID); err != nil {
		return mapTierGroupError(err, "tenant")
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// setStatusRequest is the body of PUT /api/tenants/:id/status.
type setStatusRequest struct {
	Status string `json:"status"`
	Reason string `json:"reason"`
}

// SetStatus drives a tenant's lifecycle — suspend, reactivate, soft-delete, or
// restore — via the gRPC surface. It maps to Ogen's single SetTenantStatus RPC:
// reason is recorded on suspend and cleared/ignored otherwise, and the call is
// idempotent. Ogen rejects suspending/deleting the 'default' tenant with
// FailedPrecondition, surfaced here as 409.
//
// SetStatus godoc
// @Summary  Set a tenant's lifecycle status
// @Tags     tenants
// @Accept   json
// @Param    id    path  string            true  "Tenant ID"
// @Param    body  body  setStatusRequest  true  "Target status + optional reason"
// @Success  204
// @Router   /api/tenants/{id}/status [put]
func (h *TenantsHandler) SetStatus(c *fiber.Ctx) error {
	var req setStatusRequest
	if err := c.BodyParser(&req); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	if err := h.admin.SetTenantStatus(c.Context(), c.Params("id"), req.Status, req.Reason); err != nil {
		return mapTierGroupError(err, "tenant")
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// AddGroup adds a tenant to a group (idempotent) via the gRPC surface.
//
// AddGroup godoc
// @Summary  Add a tenant to a group
// @Tags     tenants
// @Param    id       path  string  true  "Tenant ID"
// @Param    groupId  path  string  true  "Group ID"
// @Success  204
// @Router   /api/tenants/{id}/groups/{groupId} [post]
func (h *TenantsHandler) AddGroup(c *fiber.Ctx) error {
	if err := h.admin.AddTenantToGroup(c.Context(), c.Params("id"), c.Params("groupId")); err != nil {
		return mapTierGroupError(err, "")
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// RemoveGroup removes a tenant from a group (idempotent) via the gRPC surface.
//
// RemoveGroup godoc
// @Summary  Remove a tenant from a group
// @Tags     tenants
// @Param    id       path  string  true  "Tenant ID"
// @Param    groupId  path  string  true  "Group ID"
// @Success  204
// @Router   /api/tenants/{id}/groups/{groupId} [delete]
func (h *TenantsHandler) RemoveGroup(c *fiber.Ctx) error {
	if err := h.admin.RemoveTenantFromGroup(c.Context(), c.Params("id"), c.Params("groupId")); err != nil {
		return mapTierGroupError(err, "")
	}
	return c.SendStatus(fiber.StatusNoContent)
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

// publishingDay is one day of the daily-publishing chart: the ISO date, the day
// total, and the per-platform published-post counts (only platforms with posts
// that day are present) — the count twin of costDay.
type publishingDay struct {
	Date   string         `json:"date"`
	Total  int            `json:"total"`
	Counts map[string]int `json:"counts"`
}

// platformTotal is one platform's summed published-post count over the window.
// Ordered by count desc, it drives the chart's legend order and colour choice.
type platformTotal struct {
	Platform string `json:"platform"`
	Count    int    `json:"count"`
}

// DailyPublishes godoc
// @Summary      Daily publishes by platform
// @Description  Per-day published-post counts across all tenants for the last N
// @Description  days (default 30, max 90), split by platform, as a dense
// @Description  zero-filled series for the daily-publishing chart, plus per-platform
// @Description  totals for the legend. Sourced from the Ogen control-plane posts.
// @Tags         tenants
// @Produce      json
// @Param        days  query     int  false  "Window size in days (1-90)"
// @Success      200   {object}  map[string]any
// @Router       /api/tenants/daily-publishes [get]
func (h *TenantsHandler) DailyPublishes(c *fiber.Ctx) error {
	if !h.tenants.Available() {
		return c.JSON(fiber.Map{"available": false, "error": "ogen database not configured"})
	}
	days := dailyCostWindow(c) // same [1, 90] clamp as the daily-cost charts
	rows, err := h.tenants.DailyPublishesByPlatform(c.Context(), days)
	if err != nil {
		return c.JSON(fiber.Map{"available": false, "error": err.Error()})
	}
	return c.JSON(buildDailyPublishes(rows, days))
}

// buildDailyPublishes turns raw (day, platform) publish counts into the daily
// publishing chart response: a dense zero-filled day series, per-platform totals
// ordered for the legend, and the grand total — the count analogue of
// buildDailyCost.
func buildDailyPublishes(rows []ogen.PublishingDayStat, days int) fiber.Map {
	byDay := make(map[string]map[string]int, len(rows))
	platformTotals := make(map[string]int)
	var grand int
	for _, r := range rows {
		if byDay[r.Date] == nil {
			byDay[r.Date] = make(map[string]int)
		}
		byDay[r.Date][r.Platform] += r.Count
		platformTotals[r.Platform] += r.Count
		grand += r.Count
	}

	// Dense zero-filled day series (oldest → newest) over UTC calendar days, so the
	// chart always has one column per day even when nothing was published.
	now := time.Now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	series := make([]publishingDay, 0, days)
	for i := days - 1; i >= 0; i-- {
		date := today.AddDate(0, 0, -i).Format("2006-01-02")
		counts := byDay[date]
		if counts == nil {
			counts = map[string]int{}
		}
		total := 0
		for _, v := range counts {
			total += v
		}
		series = append(series, publishingDay{Date: date, Total: total, Counts: counts})
	}

	// Platforms ordered by total count desc (stable legend + colour order); ties
	// broken by name for determinism.
	platforms := make([]platformTotal, 0, len(platformTotals))
	for p, t := range platformTotals {
		platforms = append(platforms, platformTotal{Platform: p, Count: t})
	}
	sort.Slice(platforms, func(a, b int) bool {
		if platforms[a].Count != platforms[b].Count {
			return platforms[a].Count > platforms[b].Count
		}
		return platforms[a].Platform < platforms[b].Platform
	})

	return fiber.Map{
		"available":  true,
		"windowDays": days,
		"total":      grand,
		"platforms":  platforms,
		"days":       series,
	}
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
	return h.writeActivity(c, c.Params("id"))
}

// GlobalActivity godoc
// @Summary      Cross-tenant recent activity
// @Description  The tenant_activity_events feed across all tenants (newest first),
// @Description  with the same paging, filtering, and 90-day chart series as the
// @Description  per-tenant endpoint. An optional ?tenant=<id> narrows it to a
// @Description  single tenant, so the global Activity page can switch scope
// @Description  without a different endpoint. Each event carries its tenantId.
// @Tags         tenants
// @Produce      json
// @Param        tenant    query  string  false  "Scope to a single tenant ID (default: all tenants)"
// @Param        limit     query  int     false  "Max events (1-500, default 15)"
// @Param        category  query  string  false  "Only events in this category"
// @Param        day       query  string  false  "Only events on this UTC day (YYYY-MM-DD)"
// @Param        beforeAt  query  string  false  "Keyset cursor: occurred_at of the last loaded event (RFC3339)"
// @Param        beforeId  query  string  false  "Keyset cursor: id of the last loaded event"
// @Success      200  {object}  map[string]any
// @Router       /api/activity [get]
func (h *TenantsHandler) GlobalActivity(c *fiber.Ctx) error {
	return h.writeActivity(c, strings.TrimSpace(c.Query("tenant")))
}

// writeActivity serves an activity page scoped to tenantID, or — when tenantID is
// empty — spanning every tenant. It is the shared body behind both the per-tenant
// (/api/tenants/:id/activity) and global (/api/activity) endpoints: a keyset-paged
// event list plus, on the initial unfiltered page, the dense 90-day category
// series for the chart.
func (h *TenantsHandler) writeActivity(c *fiber.Ctx, tenantID string) error {
	if !h.activity.Available() {
		return c.JSON(fiber.Map{"activity": []analytics.ActivityEvent{}, "series": []activityDay{}, "categories": []string{}, "hasMore": false, "available": false, "error": "analytics database not configured"})
	}

	limit := c.QueryInt("limit", recentActivityLimit)
	if limit < 1 {
		limit = recentActivityLimit
	}
	if limit > activityMaxLimit {
		limit = activityMaxLimit
	}

	q := analytics.ActivityQuery{
		TenantID: tenantID,
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
	counts, _ := h.activity.ActivitySeries(c.Context(), tenantID, activityWindowDays)
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
