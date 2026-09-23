package handlers

import (
	"errors"
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v2"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/ogen-app/harbor/src/logging"
	"github.com/ogen-app/harbor/src/repository/ogenmodelconfig"
)

// ModelConfigHandler is the REST surface Harbor's UI calls to assign a model to
// each (tier, flow, slot) and read the code-owned model catalog with pricing
// (CON-309, the operator counterpart to CON-308's ModelConfigAdminService). It
// is a thin adapter over the ogenmodelconfig client — the flow/slot catalog,
// model catalog+pricing, resolution and all validation live behind the wire.
type ModelConfigHandler struct {
	client *ogenmodelconfig.Client
}

func NewModelConfigHandler(client *ogenmodelconfig.Client) *ModelConfigHandler {
	return &ModelConfigHandler{client: client}
}

// Register mounts the model-config routes behind auth. Static sub-paths are
// declared before the bare /slot POST so Fiber routing stays unambiguous.
func (h *ModelConfigHandler) Register(app *fiber.App, requireAuth fiber.Handler) {
	app.Get("/api/model-config", requireAuth, h.Bootstrap)
	app.Post("/api/model-config/slot/clear", requireAuth, h.ClearSlot)
	app.Post("/api/model-config/slot/global-all", requireAuth, h.SetSlotAllTiers)
	app.Post("/api/model-config/slot", requireAuth, h.SetSlot)
	app.Post("/api/model-config/test", requireAuth, h.TestSlot)
}

// modelConfigResponse is the single first-paint payload: the code-owned catalogs
// (flows, models), the current assignments (global defaults + tier overrides),
// and the tier set for the drawer's per-tier tabs. `available` distinguishes a
// down/unconfigured service from genuinely empty data, so the page renders a soft
// "unavailable" state instead of an error.
type modelConfigResponse struct {
	Available   bool                             `json:"available"`
	Flows       []ogenmodelconfig.Flow           `json:"flows"`
	Models      []ogenmodelconfig.Model          `json:"models"`
	Assignments []ogenmodelconfig.SlotAssignment `json:"assignments"`
	Tiers       []ogenmodelconfig.Tier           `json:"tiers"`
}

type setSlotRequest struct {
	TierID  string `json:"tierId"`
	FlowKey string `json:"flowKey"`
	SlotKey string `json:"slotKey"`
	ModelID string `json:"modelId"`
}

type clearSlotRequest struct {
	TierID  string `json:"tierId"`
	FlowKey string `json:"flowKey"`
	SlotKey string `json:"slotKey"`
}

type testSlotRequest struct {
	FlowKey string `json:"flowKey"`
	SlotKey string `json:"slotKey"`
	ModelID string `json:"modelId"`
}

type slotAssignmentResponse struct {
	Assignment ogenmodelconfig.SlotAssignment `json:"assignment"`
}

// Bootstrap godoc
// @Summary  Read the flow/model catalogs, assignments and tiers in one payload
// @Tags     model-config
// @Produce  json
// @Success  200  {object}  modelConfigResponse
// @Router   /api/model-config [get]
func (h *ModelConfigHandler) Bootstrap(c *fiber.Ctx) error {
	start := time.Now()
	ctx := c.Context()

	flows, err := h.client.ListFlows(ctx)
	if err != nil {
		return h.bootstrapErr(c, start, err)
	}
	models, err := h.client.ListModels(ctx, "")
	if err != nil {
		return h.bootstrapErr(c, start, err)
	}
	assignments, err := h.client.ListConfig(ctx, "")
	if err != nil {
		return h.bootstrapErr(c, start, err)
	}
	tiers, err := h.client.Tiers(ctx)
	if err != nil {
		return h.bootstrapErr(c, start, err)
	}

	logModelConfig(c, start, nil)
	return c.JSON(modelConfigResponse{
		Available:   true,
		Flows:       flows,
		Models:      models,
		Assignments: assignments,
		Tiers:       tiers,
	})
}

// bootstrapErr renders a soft "unavailable" first-paint when the service is
// down/unconfigured, and maps genuine errors otherwise.
func (h *ModelConfigHandler) bootstrapErr(c *fiber.Ctx, start time.Time, err error) error {
	logModelConfig(c, start, err)
	if isModelConfigUnavailable(err) {
		return c.JSON(modelConfigResponse{
			Available:   false,
			Flows:       []ogenmodelconfig.Flow{},
			Models:      []ogenmodelconfig.Model{},
			Assignments: []ogenmodelconfig.SlotAssignment{},
			Tiers:       []ogenmodelconfig.Tier{},
		})
	}
	return mapModelConfigError(err)
}

// SetSlot godoc
// @Summary  Assign a model to a (tier?, flow, slot) — empty tier sets the global default
// @Tags     model-config
// @Accept   json
// @Produce  json
// @Success  200  {object}  slotAssignmentResponse
// @Router   /api/model-config/slot [post]
func (h *ModelConfigHandler) SetSlot(c *fiber.Ctx) error {
	start := time.Now()
	var req setSlotRequest
	if err := c.BodyParser(&req); err != nil {
		logModelConfig(c, start, err)
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	out, err := h.client.SetSlotModel(c.Context(), req.TierID, req.FlowKey, req.SlotKey, req.ModelID)
	logModelConfig(c, start, err)
	if err != nil {
		return mapModelConfigError(err)
	}
	return c.JSON(slotAssignmentResponse{Assignment: out})
}

// SetSlotAllTiers godoc
// @Summary  Set the global default and clear every tier override for a slot
// @Tags     model-config
// @Accept   json
// @Produce  json
// @Success  200  {object}  slotAssignmentResponse
// @Router   /api/model-config/slot/global-all [post]
func (h *ModelConfigHandler) SetSlotAllTiers(c *fiber.Ctx) error {
	start := time.Now()
	var req setSlotRequest
	if err := c.BodyParser(&req); err != nil {
		logModelConfig(c, start, err)
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	out, err := h.client.SetSlotModelAllTiers(c.Context(), req.FlowKey, req.SlotKey, req.ModelID)
	logModelConfig(c, start, err)
	if err != nil {
		return mapModelConfigError(err)
	}
	return c.JSON(slotAssignmentResponse{Assignment: out})
}

// ClearSlot godoc
// @Summary  Remove a per-tier override (a global default can't be cleared)
// @Tags     model-config
// @Accept   json
// @Success  204
// @Router   /api/model-config/slot/clear [post]
func (h *ModelConfigHandler) ClearSlot(c *fiber.Ctx) error {
	start := time.Now()
	var req clearSlotRequest
	if err := c.BodyParser(&req); err != nil {
		logModelConfig(c, start, err)
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	err := h.client.ClearSlotModel(c.Context(), req.TierID, req.FlowKey, req.SlotKey)
	logModelConfig(c, start, err)
	if err != nil {
		return mapModelConfigError(err)
	}
	return c.SendStatus(fiber.StatusNoContent)
}

// TestSlot godoc
// @Summary  Run the flow's golden probe against a candidate model
// @Tags     model-config
// @Accept   json
// @Produce  json
// @Success  200  {object}  ogenmodelconfig.TestResult
// @Router   /api/model-config/test [post]
func (h *ModelConfigHandler) TestSlot(c *fiber.Ctx) error {
	start := time.Now()
	var req testSlotRequest
	if err := c.BodyParser(&req); err != nil {
		logModelConfig(c, start, err)
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	out, err := h.client.TestSlotModel(c.Context(), req.FlowKey, req.SlotKey, req.ModelID)
	logModelConfig(c, start, err)
	if err != nil {
		return mapModelConfigError(err)
	}
	return c.JSON(out)
}

// isModelConfigUnavailable reports whether err means the model-config service
// can't be reached right now (nil client, or a gRPC Unavailable / deadline).
func isModelConfigUnavailable(err error) bool {
	switch status.Code(err) {
	case codes.Unavailable, codes.DeadlineExceeded:
		return true
	}
	return errors.Is(err, ogenmodelconfig.ErrUnavailable)
}

// mapModelConfigError translates client/gRPC errors to HTTP statuses, matching
// the platforms/tiers contract so validation (capability mismatch, global-only
// override, unknown model, non-Anthropic chat model in v1) surfaces as inline,
// human-readable messages.
func mapModelConfigError(err error) error {
	if errors.Is(err, ogenmodelconfig.ErrUnavailable) {
		return fiber.NewError(fiber.StatusServiceUnavailable, "model-config service unavailable")
	}
	if status.Code(err) == codes.DeadlineExceeded {
		return fiber.NewError(fiber.StatusServiceUnavailable, "model-config service unavailable")
	}
	st, ok := status.FromError(err)
	if !ok {
		return err
	}
	switch st.Code() {
	case codes.InvalidArgument:
		return fiber.NewError(fiber.StatusBadRequest, st.Message())
	case codes.NotFound:
		return fiber.NewError(fiber.StatusNotFound, st.Message())
	case codes.FailedPrecondition:
		return fiber.NewError(fiber.StatusConflict, st.Message())
	case codes.Unauthenticated:
		return fiber.NewError(fiber.StatusBadGateway, "model-config service authentication failed")
	case codes.Unavailable:
		return fiber.NewError(fiber.StatusServiceUnavailable, "model-config service unavailable")
	default:
		return fiber.NewError(fiber.StatusInternalServerError, "model-config request failed")
	}
}

// logModelConfig emits a structured line with method/path + status class.
func logModelConfig(c *fiber.Ctx, start time.Time, err error) {
	attrs := []any{logging.AttrComponent, "model-config", "method", c.Method(), "path", c.Path(), "duration_ms", time.Since(start).Milliseconds()}
	if err != nil {
		attrs = append(attrs, "code", status.Code(err).String())
	}
	slog.InfoContext(c.Context(), "model-config request", attrs...)
}
