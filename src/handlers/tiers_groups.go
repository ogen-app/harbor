package handlers

import (
	"errors"
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v2"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/ogen-app/harbor/src/logging"
	"github.com/ogen-app/harbor/src/repository/ogentenants"
)

// TiersGroupsHandler is the REST surface Harbor's UI calls to manage Ogen's
// tenant-classification catalog: tiers (1 per tenant) and groups (many-to-many).
// It is a thin adapter over the ogentenants gRPC client — all validation, name
// uniqueness, and delete-protection (the 'default' tier, tiers still assigned to
// a tenant) live in Ogen behind the wire. Tiers and Groups share the same shape
// and CRUD, so the two route families are symmetric.
type TiersGroupsHandler struct {
	client *ogentenants.Client
}

func NewTiersGroupsHandler(client *ogentenants.Client) *TiersGroupsHandler {
	return &TiersGroupsHandler{client: client}
}

// Register mounts the tier/group routes behind auth. Only signed-in Harbor
// operators may reach them; Harbor→Ogen is separately authenticated by the
// shared gRPC token.
func (h *TiersGroupsHandler) Register(app *fiber.App, requireAuth fiber.Handler) {
	app.Get("/api/tiers", requireAuth, h.ListTiers)
	app.Post("/api/tiers", requireAuth, h.CreateTier)
	app.Put("/api/tiers/:id", requireAuth, h.UpdateTier)
	app.Delete("/api/tiers/:id", requireAuth, h.DeleteTier)

	app.Get("/api/groups", requireAuth, h.ListGroups)
	app.Post("/api/groups", requireAuth, h.CreateGroup)
	app.Put("/api/groups/:id", requireAuth, h.UpdateGroup)
	app.Delete("/api/groups/:id", requireAuth, h.DeleteGroup)
}

// entryWriteRequest is the create/update body. Color is optional ("#RRGGBB" or
// ""); Ogen rejects any other form with InvalidArgument.
type entryWriteRequest struct {
	Name        string `json:"name"`
	Color       string `json:"color"`
	Description string `json:"description"`
}

// listResponse mirrors the secrets pattern: `available` distinguishes a
// down/unconfigured tenant-admin service from a genuinely empty catalog, so the
// UI can render a soft "unavailable" state instead of an error.
type entryListResponse struct {
	Available bool                `json:"available"`
	Entries   []ogentenants.Entry `json:"entries"`
}

// ── Tiers ────────────────────────────────────────────────────────────────────

func (h *TiersGroupsHandler) ListTiers(c *fiber.Ctx) error {
	start := time.Now()
	out, err := h.client.ListTiers(c.Context())
	logTiersGroups(c, "tiers", "", start, err)
	return h.respondList(c, out, err)
}

func (h *TiersGroupsHandler) CreateTier(c *fiber.Ctx) error {
	start := time.Now()
	req, err := parseEntryBody(c)
	if err != nil {
		logTiersGroups(c, "tiers", "", start, err)
		return err
	}
	entry, cerr := h.client.CreateTier(c.Context(), req.Name, req.Color, req.Description)
	logTiersGroups(c, "tiers", req.Name, start, cerr)
	if cerr != nil {
		return mapTierGroupError(cerr, "tier")
	}
	return c.Status(fiber.StatusCreated).JSON(entry)
}

func (h *TiersGroupsHandler) UpdateTier(c *fiber.Ctx) error {
	start := time.Now()
	id := c.Params("id")
	req, err := parseEntryBody(c)
	if err != nil {
		logTiersGroups(c, "tiers", id, start, err)
		return err
	}
	entry, uerr := h.client.UpdateTier(c.Context(), id, req.Name, req.Color, req.Description)
	logTiersGroups(c, "tiers", id, start, uerr)
	if uerr != nil {
		return mapTierGroupError(uerr, "tier")
	}
	return c.JSON(entry)
}

func (h *TiersGroupsHandler) DeleteTier(c *fiber.Ctx) error {
	start := time.Now()
	id := c.Params("id")
	err := h.client.DeleteTier(c.Context(), id)
	logTiersGroups(c, "tiers", id, start, err)
	if err != nil {
		return mapTierGroupError(err, "tier")
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// ── Groups ───────────────────────────────────────────────────────────────────

func (h *TiersGroupsHandler) ListGroups(c *fiber.Ctx) error {
	start := time.Now()
	out, err := h.client.ListGroups(c.Context())
	logTiersGroups(c, "groups", "", start, err)
	return h.respondList(c, out, err)
}

func (h *TiersGroupsHandler) CreateGroup(c *fiber.Ctx) error {
	start := time.Now()
	req, err := parseEntryBody(c)
	if err != nil {
		logTiersGroups(c, "groups", "", start, err)
		return err
	}
	entry, cerr := h.client.CreateGroup(c.Context(), req.Name, req.Color, req.Description)
	logTiersGroups(c, "groups", req.Name, start, cerr)
	if cerr != nil {
		return mapTierGroupError(cerr, "group")
	}
	return c.Status(fiber.StatusCreated).JSON(entry)
}

func (h *TiersGroupsHandler) UpdateGroup(c *fiber.Ctx) error {
	start := time.Now()
	id := c.Params("id")
	req, err := parseEntryBody(c)
	if err != nil {
		logTiersGroups(c, "groups", id, start, err)
		return err
	}
	entry, uerr := h.client.UpdateGroup(c.Context(), id, req.Name, req.Color, req.Description)
	logTiersGroups(c, "groups", id, start, uerr)
	if uerr != nil {
		return mapTierGroupError(uerr, "group")
	}
	return c.JSON(entry)
}

func (h *TiersGroupsHandler) DeleteGroup(c *fiber.Ctx) error {
	start := time.Now()
	id := c.Params("id")
	err := h.client.DeleteGroup(c.Context(), id)
	logTiersGroups(c, "groups", id, start, err)
	if err != nil {
		return mapTierGroupError(err, "group")
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// ── Shared helpers ───────────────────────────────────────────────────────────

// respondList renders a list result: a down/unconfigured upstream is a soft
// state (empty list flagged unavailable), matching the Secrets tab, so the page
// degrades gracefully rather than throwing a 5xx.
func (h *TiersGroupsHandler) respondList(c *fiber.Ctx, entries []ogentenants.Entry, err error) error {
	if err != nil {
		if isTierGroupUnavailable(err) {
			return c.JSON(entryListResponse{Available: false, Entries: []ogentenants.Entry{}})
		}
		return mapTierGroupError(err, "")
	}
	if entries == nil {
		entries = []ogentenants.Entry{}
	}
	return c.JSON(entryListResponse{Available: true, Entries: entries})
}

func parseEntryBody(c *fiber.Ctx) (entryWriteRequest, error) {
	var req entryWriteRequest
	if err := c.BodyParser(&req); err != nil {
		return req, fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	return req, nil
}

func isTierGroupUnavailable(err error) bool {
	// status.Code classifies a raw context deadline as DeadlineExceeded too, so
	// this covers both a gRPC deadline and a local context timeout.
	switch status.Code(err) {
	case codes.Unavailable, codes.DeadlineExceeded:
		return true
	}
	return errors.Is(err, ogentenants.ErrUnavailable)
}

// mapTierGroupError translates client/gRPC errors to HTTP statuses. The gRPC
// codes come from Ogen's TenantAdminService: InvalidArgument → 400, NotFound →
// 404, AlreadyExists (name clash) → 409, FailedPrecondition (default tier /
// tier still assigned) → 409. Unauthenticated means Harbor's shared token is
// wrong (operator-facing 502); Unavailable → 503; anything else → 500. kind
// ("tier"/"group") tailors the NotFound message; "" falls back to a generic one.
func mapTierGroupError(err error, kind string) error {
	if errors.Is(err, ogentenants.ErrUnavailable) {
		return fiber.NewError(fiber.StatusServiceUnavailable, "tenant-admin service unavailable")
	}
	// A deadline — a gRPC DeadlineExceeded or a raw context timeout — is an
	// availability problem, not a server fault, so map it to 503. status.Code
	// classifies context.DeadlineExceeded, but status.FromError reports ok=false
	// for it, so handle it before the ok check below (which would return raw 500).
	if status.Code(err) == codes.DeadlineExceeded {
		return fiber.NewError(fiber.StatusServiceUnavailable, "tenant-admin service unavailable")
	}
	st, ok := status.FromError(err)
	if !ok {
		return err
	}
	notFoundMsg := "not found"
	if kind != "" {
		notFoundMsg = kind + " not found"
	}
	switch st.Code() {
	case codes.InvalidArgument:
		return fiber.NewError(fiber.StatusBadRequest, st.Message())
	case codes.NotFound:
		return fiber.NewError(fiber.StatusNotFound, notFoundMsg)
	case codes.AlreadyExists:
		return fiber.NewError(fiber.StatusConflict, st.Message())
	case codes.FailedPrecondition:
		return fiber.NewError(fiber.StatusConflict, st.Message())
	case codes.Unauthenticated:
		return fiber.NewError(fiber.StatusBadGateway, "tenant-admin service authentication failed")
	case codes.Unavailable:
		return fiber.NewError(fiber.StatusServiceUnavailable, "tenant-admin service unavailable")
	default:
		return fiber.NewError(fiber.StatusInternalServerError, "tenant-admin request failed")
	}
}

// logTiersGroups emits a structured line with the surface (tiers/groups) and the
// entry name/id + status class, never the request body.
func logTiersGroups(c *fiber.Ctx, surface, ref string, start time.Time, err error) {
	attrs := []any{logging.AttrComponent, "tiers_groups", "surface", surface, "method", c.Method(), "path", c.Path(), "duration_ms", time.Since(start).Milliseconds()}
	if ref != "" {
		attrs = append(attrs, "ref", ref)
	}
	if err != nil {
		attrs = append(attrs, "code", status.Code(err).String())
	}
	slog.InfoContext(c.Context(), "tiers/groups request", attrs...)
}
