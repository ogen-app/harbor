package handlers

import (
	"errors"

	"github.com/gofiber/fiber/v2"

	"github.com/ogen-app/harbor/src/stats/lifecycle"
)

// LifecycleHandler serves the Lifecycle tab on /tenants (CON-437) and the
// Lifecycle card on a tenant. Like the overview, an unavailable Ogen DB is a
// soft state ({available: false}), not an error.
type LifecycleHandler struct{ svc *lifecycle.Service }

func NewLifecycleHandler(svc *lifecycle.Service) *LifecycleHandler {
	return &LifecycleHandler{svc: svc}
}

// Register must run before TenantsHandler.Register: its /api/tenants/:id route
// would otherwise claim /api/tenants/lifecycle.
func (h *LifecycleHandler) Register(app *fiber.App, requireAuth fiber.Handler) {
	app.Get("/api/tenants/lifecycle", requireAuth, h.Board)
	app.Get("/api/tenants/lifecycle/cohorts", requireAuth, h.Cohorts)
	app.Get("/api/tenants/:id/lifecycle", requireAuth, h.Tenant)
}

// Board godoc
// @Summary  Lifecycle board: funnel, tenants by stage, churned, movement
// @Tags     tenants
// @Produce  json
// @Success  200  {object}  map[string]any
// @Router   /api/tenants/lifecycle [get]
func (h *LifecycleHandler) Board(c *fiber.Ctx) error {
	b, err := h.svc.Board(c.Context())
	if err != nil {
		return c.JSON(fiber.Map{"available": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"available": true, "board": b})
}

// Cohorts godoc
// @Summary  Weekly signup cohorts: share that reached each stage, days to first post
// @Tags     tenants
// @Produce  json
// @Success  200  {object}  map[string]any
// @Router   /api/tenants/lifecycle/cohorts [get]
func (h *LifecycleHandler) Cohorts(c *fiber.Ctx) error {
	r, err := h.svc.Cohorts(c.Context())
	if err != nil {
		return c.JSON(fiber.Map{"available": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"available": true, "report": r})
}

// Tenant godoc
// @Summary  One tenant's lifecycle: milestones, stage and health over time
// @Tags     tenants
// @Produce  json
// @Param    id  path  string  true  "Tenant id"
// @Success  200  {object}  map[string]any
// @Failure  404  {object}  map[string]any
// @Router   /api/tenants/{id}/lifecycle [get]
func (h *LifecycleHandler) Tenant(c *fiber.Ctx) error {
	t, err := h.svc.Tenant(c.Context(), c.Params("id"))
	switch {
	case errors.Is(err, lifecycle.ErrNotFound):
		return fiber.NewError(fiber.StatusNotFound, err.Error())
	case err != nil:
		return c.JSON(fiber.Map{"available": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"available": true, "lifecycle": t})
}
