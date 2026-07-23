package handlers

import (
	"github.com/gofiber/fiber/v2"
	"github.com/uptrace/bun"

	"github.com/ogen-app/harbor/src/dbstats"
)

// StatusHandler reports live connectivity + size of the external databases
// (Ogen's control-plane and analytics/TimescaleDB pools). Either pool may be
// nil (unconfigured); a per-request ping reflects live reachability.
type StatusHandler struct {
	ogenDB      *bun.DB
	analyticsDB *bun.DB
}

func NewStatusHandler(ogenDB, analyticsDB *bun.DB) *StatusHandler {
	return &StatusHandler{ogenDB: ogenDB, analyticsDB: analyticsDB}
}

// Register mounts the status routes behind auth.
func (h *StatusHandler) Register(app *fiber.App, requireAuth fiber.Handler) {
	app.Get("/api/status/databases", requireAuth, h.Databases)
}

type dbStatus struct {
	Key       string         `json:"key"`
	Label     string         `json:"label"`
	Kind      string         `json:"kind"`
	Connected bool           `json:"connected"`
	SizeBytes int64          `json:"sizeBytes"`
	Error     string         `json:"error,omitempty"`
	Stats     *dbstats.Stats `json:"stats,omitempty"`
}

// Databases godoc
// @Summary      Database status
// @Description  Live connectivity and on-disk size of the Ogen and analytics
// @Description  databases.
// @Tags         system
// @Produce      json
// @Success      200  {object}  map[string]any
// @Router       /api/status/databases [get]
func (h *StatusHandler) Databases(c *fiber.Ctx) error {
	return c.JSON(fiber.Map{
		"databases": []dbStatus{
			// River queue depth is only collected for the Ogen database.
			statusOf("ogen", "Ogen database", "PostgreSQL",
				dbstats.ProbePool(c.Context(), h.ogenDB, true)),
			statusOf("analytics", "Analytics database", "TimescaleDB",
				dbstats.ProbePool(c.Context(), h.analyticsDB, false)),
		},
	})
}

// statusOf maps a database probe onto the API's dbStatus shape.
func statusOf(key, label, kind string, p dbstats.Probe) dbStatus {
	return dbStatus{
		Key:       key,
		Label:     label,
		Kind:      kind,
		Connected: p.Connected,
		SizeBytes: p.SizeBytes,
		Error:     p.Err,
		Stats:     p.Stats,
	}
}
