package handlers

import (
	"errors"
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v2"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/ogen-app/harbor/src/logging"
	"github.com/ogen-app/harbor/src/repository/ogenplatforms"
)

// PlatformsHandler is the REST surface Harbor's UI calls to manage Ogen's
// publishable social-platform catalog (CON-292/293). It is a thin adapter over
// the ogenplatforms gRPC client — the data model, seed catalog, and all
// validation live in Ogen behind the wire. It exposes the full catalog surface:
// list, create, whole-resource update (also how sort_order/reorder and the
// enabled-from-edit-form persist), enable/disable, delete (with force), and the
// global-limits panel.
type PlatformsHandler struct {
	client *ogenplatforms.Client
}

func NewPlatformsHandler(client *ogenplatforms.Client) *PlatformsHandler {
	return &PlatformsHandler{client: client}
}

// Register mounts the platforms routes behind auth. Only signed-in Harbor
// operators may reach them; Harbor→Ogen is separately authenticated by the
// shared gRPC token.
func (h *PlatformsHandler) Register(app *fiber.App, requireAuth fiber.Handler) {
	app.Get("/api/platforms", requireAuth, h.List)

	// Static /global-limits routes are registered before the /:id routes so
	// Fiber doesn't capture "global-limits" as a platform :id on PUT.
	app.Get("/api/platforms/global-limits", requireAuth, h.GetGlobalLimits)
	app.Put("/api/platforms/global-limits", requireAuth, h.UpdateGlobalLimits)

	app.Post("/api/platforms", requireAuth, h.Create)
	app.Put("/api/platforms/:id/enabled", requireAuth, h.SetEnabled)
	app.Put("/api/platforms/:id", requireAuth, h.Update)
	app.Delete("/api/platforms/:id", requireAuth, h.Delete)
}

// platformsListResponse mirrors the secrets/tiers pattern: `available`
// distinguishes a down/unconfigured platform-admin service from a genuinely
// empty catalog, so the UI can render a soft "unavailable" state instead of an
// error.
type platformsListResponse struct {
	Available bool                     `json:"available"`
	Platforms []ogenplatforms.Platform `json:"platforms"`
}

type platformEnabledRequest struct {
	Enabled bool `json:"enabled"`
}

// globalLimitsResponse flags availability like the list endpoint, so the
// global-limits panel degrades softly when Ogen is unreachable.
type globalLimitsResponse struct {
	Available bool                       `json:"available"`
	Limits    ogenplatforms.GlobalLimits `json:"limits"`
}

// List godoc
// @Summary  List the social-platform catalog (including disabled)
// @Tags     platforms
// @Produce  json
// @Success  200  {object}  platformsListResponse
// @Router   /api/platforms [get]
func (h *PlatformsHandler) List(c *fiber.Ctx) error {
	start := time.Now()
	// include_disabled=true: operators manage the whole catalog, so disabled
	// rows (seeded TikTok/Pinterest/Reddit, and anything newly added — Ogen
	// creates platforms disabled) must be visible and toggleable (AC #8).
	out, err := h.client.List(c.Context(), true)
	logPlatforms(c, start, err)
	if err != nil {
		// A down/unconfigured upstream is a soft state, not a 5xx: return an
		// empty list flagged unavailable so the page renders gracefully.
		if isPlatformsUnavailable(err) {
			return c.JSON(platformsListResponse{Available: false, Platforms: []ogenplatforms.Platform{}})
		}
		return mapPlatformError(err)
	}
	if out == nil {
		out = []ogenplatforms.Platform{}
	}
	return c.JSON(platformsListResponse{Available: true, Platforms: out})
}

// Create godoc
// @Summary  Create a platform (server-minted id, created disabled)
// @Tags     platforms
// @Accept   json
// @Produce  json
// @Success  201  {object}  ogenplatforms.Platform
// @Router   /api/platforms [post]
func (h *PlatformsHandler) Create(c *fiber.Ctx) error {
	start := time.Now()
	p, err := parsePlatformBody(c)
	if err != nil {
		logPlatforms(c, start, err)
		return err
	}
	p.ID = "" // id is server-minted; ignore anything the client sent.
	out, cerr := h.client.Create(c.Context(), p)
	logPlatforms(c, start, cerr)
	if cerr != nil {
		return mapPlatformError(cerr)
	}
	return c.Status(fiber.StatusCreated).JSON(out)
}

// Update godoc
// @Summary  Replace a platform (whole-resource; also persists sort_order)
// @Tags     platforms
// @Accept   json
// @Produce  json
// @Param    id  path  string  true  "Platform id"
// @Success  200  {object}  ogenplatforms.Platform
// @Router   /api/platforms/{id} [put]
func (h *PlatformsHandler) Update(c *fiber.Ctx) error {
	start := time.Now()
	p, err := parsePlatformBody(c)
	if err != nil {
		logPlatforms(c, start, err)
		return err
	}
	p.ID = c.Params("id") // path is authoritative for the target.
	out, uerr := h.client.Update(c.Context(), p)
	logPlatforms(c, start, uerr)
	if uerr != nil {
		return mapPlatformError(uerr)
	}
	return c.JSON(out)
}

// SetEnabled godoc
// @Summary  Soft-enable/disable a platform
// @Tags     platforms
// @Accept   json
// @Produce  json
// @Param    id  path  string  true  "Platform id"
// @Success  200  {object}  ogenplatforms.Platform
// @Router   /api/platforms/{id}/enabled [put]
func (h *PlatformsHandler) SetEnabled(c *fiber.Ctx) error {
	start := time.Now()
	var req platformEnabledRequest
	if err := c.BodyParser(&req); err != nil {
		logPlatforms(c, start, err)
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	out, err := h.client.SetEnabled(c.Context(), c.Params("id"), req.Enabled)
	logPlatforms(c, start, err)
	if err != nil {
		return mapPlatformError(err)
	}
	return c.JSON(out)
}

// Delete godoc
// @Summary  Delete a platform (force overrides the in-use guard)
// @Tags     platforms
// @Param    id     path   string  true   "Platform id"
// @Param    force  query  bool    false  "Override the in-use guard"
// @Success  204
// @Router   /api/platforms/{id} [delete]
func (h *PlatformsHandler) Delete(c *fiber.Ctx) error {
	start := time.Now()
	err := h.client.Delete(c.Context(), c.Params("id"), c.QueryBool("force", false))
	logPlatforms(c, start, err)
	if err != nil {
		return mapPlatformError(err)
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// GetGlobalLimits godoc
// @Summary  Read the five cross-platform ceilings
// @Tags     platforms
// @Produce  json
// @Success  200  {object}  globalLimitsResponse
// @Router   /api/platforms/global-limits [get]
func (h *PlatformsHandler) GetGlobalLimits(c *fiber.Ctx) error {
	start := time.Now()
	limits, err := h.client.GetGlobalLimits(c.Context())
	logPlatforms(c, start, err)
	if err != nil {
		if isPlatformsUnavailable(err) {
			return c.JSON(globalLimitsResponse{Available: false})
		}
		return mapPlatformError(err)
	}
	return c.JSON(globalLimitsResponse{Available: true, Limits: limits})
}

// UpdateGlobalLimits godoc
// @Summary  Write the five cross-platform ceilings
// @Tags     platforms
// @Accept   json
// @Produce  json
// @Success  200  {object}  ogenplatforms.GlobalLimits
// @Router   /api/platforms/global-limits [put]
func (h *PlatformsHandler) UpdateGlobalLimits(c *fiber.Ctx) error {
	start := time.Now()
	var l ogenplatforms.GlobalLimits
	if err := c.BodyParser(&l); err != nil {
		logPlatforms(c, start, err)
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	out, err := h.client.UpdateGlobalLimits(c.Context(), l)
	logPlatforms(c, start, err)
	if err != nil {
		return mapPlatformError(err)
	}
	return c.JSON(out)
}

// parsePlatformBody decodes the whole-resource JSON the Add/Edit form sends. A
// parse failure returns a fixed-shape 400 (never the body).
func parsePlatformBody(c *fiber.Ctx) (ogenplatforms.Platform, error) {
	var p ogenplatforms.Platform
	if err := c.BodyParser(&p); err != nil {
		return p, fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	return p, nil
}

// isPlatformsUnavailable reports whether err means "platform-admin service can't
// be reached right now" — the client is unconfigured (nil), or the gRPC call
// failed with Unavailable / a deadline (Ogen down / no listener / slow).
func isPlatformsUnavailable(err error) bool {
	switch status.Code(err) {
	case codes.Unavailable, codes.DeadlineExceeded:
		return true
	}
	return errors.Is(err, ogenplatforms.ErrUnavailable)
}

// mapPlatformError translates client/gRPC errors to HTTP statuses, matching the
// tiers/secrets contract. The write codes (InvalidArgument/AlreadyExists/
// FailedPrecondition) are mapped here already so the forthcoming catalog-write
// handlers surface them as inline, human-readable messages. Unauthenticated
// means Harbor's shared token is wrong (operator-facing 502); Unavailable → 503;
// anything else → 500.
func mapPlatformError(err error) error {
	if errors.Is(err, ogenplatforms.ErrUnavailable) {
		return fiber.NewError(fiber.StatusServiceUnavailable, "platform-admin service unavailable")
	}
	// A deadline is an availability problem, not a server fault: status.Code
	// classifies context.DeadlineExceeded, but status.FromError reports ok=false
	// for it, so handle it before the ok check below (which would 500).
	if status.Code(err) == codes.DeadlineExceeded {
		return fiber.NewError(fiber.StatusServiceUnavailable, "platform-admin service unavailable")
	}
	st, ok := status.FromError(err)
	if !ok {
		return err
	}
	switch st.Code() {
	case codes.InvalidArgument:
		return fiber.NewError(fiber.StatusBadRequest, st.Message())
	case codes.NotFound:
		return fiber.NewError(fiber.StatusNotFound, "platform not found")
	case codes.AlreadyExists:
		return fiber.NewError(fiber.StatusConflict, st.Message())
	case codes.FailedPrecondition:
		return fiber.NewError(fiber.StatusConflict, st.Message())
	case codes.Unauthenticated:
		return fiber.NewError(fiber.StatusBadGateway, "platform-admin service authentication failed")
	case codes.Unavailable:
		return fiber.NewError(fiber.StatusServiceUnavailable, "platform-admin service unavailable")
	default:
		return fiber.NewError(fiber.StatusInternalServerError, "platform request failed")
	}
}

// logPlatforms emits a structured line with the method/path + status class,
// never any secret material (there is none on this surface).
func logPlatforms(c *fiber.Ctx, start time.Time, err error) {
	attrs := []any{logging.AttrComponent, "platforms", "method", c.Method(), "path", c.Path(), "duration_ms", time.Since(start).Milliseconds()}
	if err != nil {
		attrs = append(attrs, "code", status.Code(err).String())
	}
	slog.InfoContext(c.Context(), "platforms request", attrs...)
}
