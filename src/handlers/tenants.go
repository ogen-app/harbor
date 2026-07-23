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
	"github.com/uptrace/bun"

	"github.com/ogen-app/harbor/src/tenantstats"
)

// TenantsHandler serves Ogen tenant data (read-only) from the Ogen control-plane
// pool, plus the analytics pool for AI-spend metrics. Pools may be nil
// (unconfigured) or unreachable; both are reported as unavailable rather than an
// error, so the dashboard can render a soft state.
type TenantsHandler struct {
	ogenDB      *bun.DB
	analyticsDB *bun.DB
}

func NewTenantsHandler(ogenDB, analyticsDB *bun.DB) *TenantsHandler {
	return &TenantsHandler{ogenDB: ogenDB, analyticsDB: analyticsDB}
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
	ID             string                  `json:"id"`
	Name           string                  `json:"name"`
	Slug           string                  `json:"slug"`
	CreatedAt      time.Time               `json:"createdAt"`
	Status         string                  `json:"status"`
	Users          int                     `json:"users"`
	ZernioProfiles int                     `json:"zernioProfiles"`
	R2Bytes        int64                   `json:"r2Bytes"`
	Spend          tenantstats.VendorSpend `json:"spend"`
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
	if h.ogenDB == nil {
		return c.JSON(fiber.Map{"tenants": []tenantRow{}, "available": false, "error": "ogen database not configured"})
	}

	// Base identity + Ogen-side metrics. Correlated subqueries keep this a single
	// round trip and avoid fan-out from the LEFT JOINs multiplying rows.
	var scanned []struct {
		ID             string    `bun:"id"`
		Name           string    `bun:"name"`
		Slug           string    `bun:"slug"`
		CreatedAt      time.Time `bun:"created_at"`
		Users          int       `bun:"users"`
		ZernioProfiles int       `bun:"zernio_profiles"`
		R2Bytes        int64     `bun:"r2_bytes"`
	}
	err := h.ogenDB.NewRaw(`
		SELECT
			t.id, t.name, t.slug, t.created_at,
			(SELECT count(*) FROM users u
				WHERE u.tenant_id = t.id) AS users,
			(SELECT count(*) FROM social_accounts sa
				WHERE sa.tenant_id = t.id AND sa.is_active = true AND sa.deleted_at IS NULL) AS zernio_profiles,
			(SELECT COALESCE(sum(af.size_bytes), 0) FROM asset_files af
				WHERE af.tenant_id = t.id) AS r2_bytes
		FROM tenants t
		ORDER BY t.created_at`).Scan(c.Context(), &scanned)
	if err != nil {
		return c.JSON(fiber.Map{"tenants": []tenantRow{}, "available": false, "error": err.Error()})
	}

	// Cross-database AI spend (analytics DB), merged by tenant id. Best-effort:
	// spendAvailable=false just hides the concentration bars.
	spend, spendAvailable := tenantstats.SpendByTenant(c.Context(), h.analyticsDB)

	rows := make([]tenantRow, len(scanned))
	for i, s := range scanned {
		rows[i] = tenantRow{
			ID:             s.ID,
			Name:           s.Name,
			Slug:           s.Slug,
			CreatedAt:      s.CreatedAt,
			Status:         "active", // Ogen has no lifecycle column yet
			Users:          s.Users,
			ZernioProfiles: s.ZernioProfiles,
			R2Bytes:        s.R2Bytes,
			Spend:          spend[s.ID],
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
	if h.ogenDB == nil {
		return c.JSON(fiber.Map{"available": false, "error": "ogen database not configured"})
	}
	id := c.Params("id")

	// Same identity + Ogen-side metrics as List, scoped to one tenant.
	var s struct {
		ID             string    `bun:"id"`
		Name           string    `bun:"name"`
		Slug           string    `bun:"slug"`
		CreatedAt      time.Time `bun:"created_at"`
		Users          int       `bun:"users"`
		ZernioProfiles int       `bun:"zernio_profiles"`
		R2Bytes        int64     `bun:"r2_bytes"`
	}
	err := h.ogenDB.NewRaw(`
		SELECT
			t.id, t.name, t.slug, t.created_at,
			(SELECT count(*) FROM users u
				WHERE u.tenant_id = t.id) AS users,
			(SELECT count(*) FROM social_accounts sa
				WHERE sa.tenant_id = t.id AND sa.is_active = true AND sa.deleted_at IS NULL) AS zernio_profiles,
			(SELECT COALESCE(sum(af.size_bytes), 0) FROM asset_files af
				WHERE af.tenant_id = t.id) AS r2_bytes
		FROM tenants t
		WHERE t.id = ?`, id).Scan(c.Context(), &s)
	if err != nil {
		// No row for this id is a not-found (soft), not a hard error.
		if errors.Is(err, sql.ErrNoRows) {
			return c.JSON(fiber.Map{"available": true, "found": false})
		}
		return c.JSON(fiber.Map{"available": false, "error": err.Error()})
	}

	// Cross-database AI spend, indexed to this tenant. Best-effort like List.
	spend, spendAvailable := tenantstats.SpendByTenant(c.Context(), h.analyticsDB)

	tenant := tenantRow{
		ID:             s.ID,
		Name:           s.Name,
		Slug:           s.Slug,
		CreatedAt:      s.CreatedAt,
		Status:         "active", // Ogen has no lifecycle column yet
		Users:          s.Users,
		ZernioProfiles: s.ZernioProfiles,
		R2Bytes:        s.R2Bytes,
		Spend:          spend[s.ID],
	}

	return c.JSON(fiber.Map{
		"available":      true,
		"found":          true,
		"tenant":         tenant,
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
	if h.ogenDB == nil {
		return c.JSON(fiber.Map{"days": []regDay{}, "available": false, "error": "ogen database not configured"})
	}

	// Pull the raw registrations in-window and build the dense series in Go, so
	// each day can carry the list of tenant names. Bucketed by UTC calendar day.
	var rows []struct {
		Date string `bun:"date"`
		Name string `bun:"name"`
	}
	err := h.ogenDB.NewRaw(`
		SELECT to_char((created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS date, name
		FROM tenants
		WHERE (created_at AT TIME ZONE 'UTC')::date >= (now() AT TIME ZONE 'UTC')::date - ?
		ORDER BY created_at`, regWindowDays-1).Scan(c.Context(), &rows)
	if err != nil {
		return c.JSON(fiber.Map{"days": []regDay{}, "available": false, "error": err.Error()})
	}

	byDay := make(map[string][]string, len(rows))
	for _, r := range rows {
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

// activityEvent is one entry in a tenant's recent-activity feed, sourced from the
// Ogen post_logs audit trail.
type activityEvent struct {
	At      time.Time `bun:"event_timestamp" json:"at"`
	Type    string    `bun:"event_type"      json:"type"`
	Status  string    `bun:"to_status"       json:"status"`
	Summary string    `bun:"summary"         json:"summary"`
}

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
	if h.ogenDB == nil {
		return c.JSON(fiber.Map{"activity": []activityEvent{}, "available": false, "error": "ogen database not configured"})
	}
	id := c.Params("id")

	var events []activityEvent
	err := h.ogenDB.NewRaw(`
		SELECT
			event_timestamp,
			event_type,
			COALESCE(to_status, '') AS to_status,
			COALESCE(summary, '')   AS summary
		FROM post_logs
		WHERE tenant_id = ?
		ORDER BY event_timestamp DESC
		LIMIT 15`, id).Scan(c.Context(), &events)
	if err != nil {
		return c.JSON(fiber.Map{"activity": []activityEvent{}, "available": false, "error": err.Error()})
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
	if h.ogenDB == nil {
		return c.JSON(fiber.Map{"available": false, "error": "ogen database not configured"})
	}
	overview := tenantstats.Collect(c.Context(), h.ogenDB, h.analyticsDB)
	return c.JSON(fiber.Map{"available": true, "overview": overview})
}
