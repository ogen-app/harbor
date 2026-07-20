// Package handlers holds the Fiber HTTP handlers. Each handler is a struct with
// its dependencies, a NewXHandler constructor, and a Register(app) method that
// mounts its routes — mirroring the ../ogen handler convention.
package handlers

import (
	"github.com/gofiber/fiber/v2"
	"github.com/uptrace/bun"
)

// HealthHandler reports service + datastore health.
type HealthHandler struct {
	db *bun.DB
}

// NewHealthHandler builds the health handler.
func NewHealthHandler(db *bun.DB) *HealthHandler {
	return &HealthHandler{db: db}
}

// Register mounts the health routes.
func (h *HealthHandler) Register(app *fiber.App) {
	app.Get("/api/health", h.Health)
}

// Health godoc
// @Summary      Health check
// @Description  Returns service status and database connectivity. Responds 503
// @Description  when the database is unreachable.
// @Tags         system
// @Produce      json
// @Success      200  {object}  map[string]string
// @Failure      503  {object}  map[string]string
// @Router       /api/health [get]
func (h *HealthHandler) Health(c *fiber.Ctx) error {
	if err := h.db.PingContext(c.Context()); err != nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
			"status": "unhealthy",
			"error":  err.Error(),
		})
	}
	return c.JSON(fiber.Map{"status": "ok"})
}
