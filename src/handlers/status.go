package handlers

import (
	"context"

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
			probeDB(c.Context(), "ogen", "Ogen database", "PostgreSQL", h.ogenDB, true),
			probeDB(c.Context(), "analytics", "Analytics database", "TimescaleDB", h.analyticsDB, false),
		},
	})
}

// probeDB pings the pool and, when reachable, reads the database's on-disk size.
// A nil pool or any error is reported (never fatal) so the UI can render a
// disconnected state.
func probeDB(ctx context.Context, key, label, kind string, db *bun.DB, includeRiver bool) dbStatus {
	s := dbStatus{Key: key, Label: label, Kind: kind}
	if db == nil {
		s.Error = "not configured"
		return s
	}
	if err := db.PingContext(ctx); err != nil {
		s.Error = err.Error()
		return s
	}
	s.Connected = true

	var size int64
	if err := db.NewRaw("SELECT pg_database_size(current_database())").Scan(ctx, &size); err != nil {
		s.Error = "size unavailable: " + err.Error()
		return s
	}
	s.SizeBytes = size
	s.Stats = dbstats.Collect(ctx, db, includeRiver)
	return s
}
