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
// validation live in Ogen behind the wire. This iteration exposes the read path
// (list the whole catalog); catalog writes and the global-limits panel land in
// later iterations.
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
}

// platformsListResponse mirrors the secrets/tiers pattern: `available`
// distinguishes a down/unconfigured platform-admin service from a genuinely
// empty catalog, so the UI can render a soft "unavailable" state instead of an
// error.
type platformsListResponse struct {
	Available bool                     `json:"available"`
	Platforms []ogenplatforms.Platform `json:"platforms"`
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
