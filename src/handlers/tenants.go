package handlers

import (
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
	app.Get("/api/tenants/:id/activity", requireAuth, h.Activity)
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

	return c.JSON(fiber.Map{"tenants": rows, "available": true, "spendAvailable": spendAvailable})
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
