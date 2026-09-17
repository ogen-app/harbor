package handlers

import (
	"errors"
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v2"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/ogen-app/harbor/src/logging"
	"github.com/ogen-app/harbor/src/repository/ogenannouncements"
)

// AnnouncementsHandler is the REST surface Harbor's UI calls to author, target,
// schedule and measure tenant announcements (CON-230/300). Like PlatformsHandler
// it is a thin adapter over a gRPC client — the data model, delivery, and all
// stats computation live in Ogen behind the wire. It exposes the full lifecycle:
// list history (status filter + pagination, each row with its engagement stats),
// detail+stats, create/whole-resource-update of the authored fields, the
// publish/archive status transition, and draft-only delete.
type AnnouncementsHandler struct {
	client *ogenannouncements.Client
}

func NewAnnouncementsHandler(client *ogenannouncements.Client) *AnnouncementsHandler {
	return &AnnouncementsHandler{client: client}
}

// Register mounts the announcement routes behind auth. Only signed-in Harbor
// operators may reach them; Harbor→Ogen is separately authenticated by the
// shared gRPC token. The /:id/status transition lives a segment deeper than
// /:id, so route order is not load-bearing here (unlike platforms' static
// /global-limits).
func (h *AnnouncementsHandler) Register(app *fiber.App, requireAuth fiber.Handler) {
	app.Get("/api/announcements", requireAuth, h.List)
	app.Get("/api/announcements/:id", requireAuth, h.Detail)
	app.Post("/api/announcements", requireAuth, h.Create)
	app.Put("/api/announcements/:id/status", requireAuth, h.SetStatus)
	app.Put("/api/announcements/:id", requireAuth, h.Update)
	app.Delete("/api/announcements/:id", requireAuth, h.Delete)
}

// announcementsListResponse mirrors the platforms/tiers pattern: `available`
// distinguishes a down/unconfigured announcement-admin service from a genuinely
// empty history, so the UI can render a soft "unavailable" state instead of an
// error. nextPageToken is "" on the last page.
type announcementsListResponse struct {
	Available     bool                                      `json:"available"`
	Items         []ogenannouncements.AnnouncementWithStats `json:"items"`
	NextPageToken string                                    `json:"nextPageToken"`
}

// announcementStatusRequest is the body of PUT /:id/status.
type announcementStatusRequest struct {
	Status string `json:"status"`
}

// List godoc
// @Summary  List announcement history (any status unless filtered), newest first
// @Tags     announcements
// @Produce  json
// @Param    status      query  string  false  "Filter: draft | published | archived"
// @Param    page_size   query  int     false  "Page size (server-clamped)"
// @Param    page_token  query  string  false  "Opaque keyset cursor from a prior response"
// @Success  200  {object}  announcementsListResponse
// @Router   /api/announcements [get]
func (h *AnnouncementsHandler) List(c *fiber.Ctx) error {
	start := time.Now()
	res, err := h.client.List(
		c.Context(),
		c.Query("status"),
		int32(c.QueryInt("page_size", 0)),
		c.Query("page_token"),
	)
	logAnnouncements(c, start, err)
	if err != nil {
		// A down/unconfigured upstream is a soft state, not a 5xx: return an
		// empty page flagged unavailable so the page renders gracefully.
		if isAnnouncementsUnavailable(err) {
			return c.JSON(announcementsListResponse{Available: false, Items: []ogenannouncements.AnnouncementWithStats{}})
		}
		return mapAnnouncementError(err)
	}
	if res.Items == nil {
		res.Items = []ogenannouncements.AnnouncementWithStats{}
	}
	return c.JSON(announcementsListResponse{Available: true, Items: res.Items, NextPageToken: res.NextPageToken})
}

// Detail godoc
// @Summary  Get one announcement with its targeting and full stat set
// @Tags     announcements
// @Produce  json
// @Param    id  path  string  true  "Announcement id"
// @Success  200  {object}  ogenannouncements.AnnouncementWithStats
// @Router   /api/announcements/{id} [get]
func (h *AnnouncementsHandler) Detail(c *fiber.Ctx) error {
	start := time.Now()
	out, err := h.client.Get(c.Context(), c.Params("id"))
	logAnnouncements(c, start, err)
	if err != nil {
		return mapAnnouncementError(err)
	}
	return c.JSON(out)
}

// Create godoc
// @Summary  Create a draft announcement (server-minted id, created draft)
// @Tags     announcements
// @Accept   json
// @Produce  json
// @Success  201  {object}  ogenannouncements.Announcement
// @Router   /api/announcements [post]
func (h *AnnouncementsHandler) Create(c *fiber.Ctx) error {
	start := time.Now()
	a, err := parseAnnouncementBody(c)
	if err != nil {
		logAnnouncements(c, start, err)
		return err
	}
	// id and status are server-owned: Ogen mints the id and creates it draft.
	a.ID = ""
	out, cerr := h.client.Create(c.Context(), a)
	logAnnouncements(c, start, cerr)
	if cerr != nil {
		return mapAnnouncementError(cerr)
	}
	return c.Status(fiber.StatusCreated).JSON(out)
}

// Update godoc
// @Summary  Replace an announcement's authored fields + targeting (whole-resource)
// @Tags     announcements
// @Accept   json
// @Produce  json
// @Param    id  path  string  true  "Announcement id"
// @Success  200  {object}  ogenannouncements.Announcement
// @Router   /api/announcements/{id} [put]
func (h *AnnouncementsHandler) Update(c *fiber.Ctx) error {
	start := time.Now()
	a, err := parseAnnouncementBody(c)
	if err != nil {
		logAnnouncements(c, start, err)
		return err
	}
	a.ID = c.Params("id") // path is authoritative for the target.
	out, uerr := h.client.Update(c.Context(), a)
	logAnnouncements(c, start, uerr)
	if uerr != nil {
		return mapAnnouncementError(uerr)
	}
	return c.JSON(out)
}

// SetStatus godoc
// @Summary  Transition the lifecycle (publish / archive / back to draft)
// @Tags     announcements
// @Accept   json
// @Produce  json
// @Param    id  path  string  true  "Announcement id"
// @Success  200  {object}  ogenannouncements.Announcement
// @Router   /api/announcements/{id}/status [put]
func (h *AnnouncementsHandler) SetStatus(c *fiber.Ctx) error {
	start := time.Now()
	var req announcementStatusRequest
	if err := c.BodyParser(&req); err != nil {
		logAnnouncements(c, start, err)
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	out, err := h.client.SetStatus(c.Context(), c.Params("id"), req.Status)
	logAnnouncements(c, start, err)
	if err != nil {
		return mapAnnouncementError(err)
	}
	return c.JSON(out)
}

// Delete godoc
// @Summary  Delete a draft announcement (published/archived are retained)
// @Tags     announcements
// @Param    id  path  string  true  "Announcement id"
// @Success  204
// @Router   /api/announcements/{id} [delete]
func (h *AnnouncementsHandler) Delete(c *fiber.Ctx) error {
	start := time.Now()
	err := h.client.Delete(c.Context(), c.Params("id"))
	logAnnouncements(c, start, err)
	if err != nil {
		return mapAnnouncementError(err)
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// parseAnnouncementBody decodes the whole-resource JSON the create/edit form
// sends. A parse failure returns a fixed-shape 400 (never the body).
func parseAnnouncementBody(c *fiber.Ctx) (ogenannouncements.Announcement, error) {
	var a ogenannouncements.Announcement
	if err := c.BodyParser(&a); err != nil {
		return a, fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	return a, nil
}

// isAnnouncementsUnavailable reports whether err means "announcement-admin
// service can't be reached right now" — the client is unconfigured (nil), or the
// gRPC call failed with Unavailable / a deadline (Ogen down / no listener / slow).
func isAnnouncementsUnavailable(err error) bool {
	switch status.Code(err) {
	case codes.Unavailable, codes.DeadlineExceeded:
		return true
	}
	return errors.Is(err, ogenannouncements.ErrUnavailable)
}

// mapAnnouncementError translates client/gRPC errors to HTTP statuses, matching
// the platforms/tiers contract so the UI surfaces them as inline, human-readable
// messages. FailedPrecondition carries Ogen's message (e.g. "delete a published
// announcement — archive it instead"). Unauthenticated means Harbor's shared
// token is wrong (operator-facing 502); Unavailable → 503; anything else → 500.
func mapAnnouncementError(err error) error {
	if errors.Is(err, ogenannouncements.ErrUnavailable) {
		return fiber.NewError(fiber.StatusServiceUnavailable, "announcement-admin service unavailable")
	}
	// A deadline is an availability problem, not a server fault: status.Code
	// classifies context.DeadlineExceeded, but status.FromError reports ok=false
	// for it, so handle it before the ok check below (which would 500).
	if status.Code(err) == codes.DeadlineExceeded {
		return fiber.NewError(fiber.StatusServiceUnavailable, "announcement-admin service unavailable")
	}
	st, ok := status.FromError(err)
	if !ok {
		return err
	}
	switch st.Code() {
	case codes.InvalidArgument:
		return fiber.NewError(fiber.StatusBadRequest, st.Message())
	case codes.NotFound:
		return fiber.NewError(fiber.StatusNotFound, "announcement not found")
	case codes.FailedPrecondition:
		return fiber.NewError(fiber.StatusConflict, st.Message())
	case codes.Unauthenticated:
		return fiber.NewError(fiber.StatusBadGateway, "announcement-admin service authentication failed")
	case codes.Unavailable:
		return fiber.NewError(fiber.StatusServiceUnavailable, "announcement-admin service unavailable")
	default:
		return fiber.NewError(fiber.StatusInternalServerError, "announcement request failed")
	}
}

// logAnnouncements emits a structured line with the method/path + status class.
func logAnnouncements(c *fiber.Ctx, start time.Time, err error) {
	attrs := []any{logging.AttrComponent, "announcements", "method", c.Method(), "path", c.Path(), "duration_ms", time.Since(start).Milliseconds()}
	if err != nil {
		attrs = append(attrs, "code", status.Code(err).String())
	}
	slog.InfoContext(c.Context(), "announcements request", attrs...)
}
