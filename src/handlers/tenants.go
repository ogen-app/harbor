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
}

type tenant struct {
	ID        string    `bun:"id"         json:"id"`
	Name      string    `bun:"name"       json:"name"`
	Slug      string    `bun:"slug"       json:"slug"`
	CreatedAt time.Time `bun:"created_at" json:"createdAt"`
	Users     int       `bun:"users"      json:"users"`
}

// List godoc
// @Summary      Ogen tenants
// @Description  Tenants in the Ogen control-plane database, with per-tenant user counts.
// @Tags         tenants
// @Produce      json
// @Success      200  {object}  map[string]any
// @Router       /api/tenants [get]
func (h *TenantsHandler) List(c *fiber.Ctx) error {
	if h.ogenDB == nil {
		return c.JSON(fiber.Map{"tenants": []tenant{}, "available": false, "error": "ogen database not configured"})
	}

	var tenants []tenant
	err := h.ogenDB.NewRaw(`
		SELECT t.id, t.name, t.slug, t.created_at, count(u.id) AS users
		FROM tenants t
		LEFT JOIN users u ON u.tenant_id = t.id
		GROUP BY t.id, t.name, t.slug, t.created_at
		ORDER BY t.created_at`).Scan(c.Context(), &tenants)
	if err != nil {
		return c.JSON(fiber.Map{"tenants": []tenant{}, "available": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"tenants": tenants, "available": true})
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
