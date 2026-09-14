package handlers

import (
	"errors"
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v2"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/ogen-app/harbor/src/logging"
	"github.com/ogen-app/harbor/src/repository/ogenplans"
	"github.com/ogen-app/harbor/src/repository/ogentenants"
)

// TierEntitlementsHandler is the REST surface Harbor's UI calls to manage Ogen's
// versioned tier entitlements (CON-243/CON-294/CON-296). It is a thin adapter
// over two gRPC clients: ogenplans (PlanAdminService — versions, prices,
// entitlements, assignment) and ogentenants (TenantAdminService — the tier
// catalog that supplies the matrix columns; PlanAdminService has no ListTiers).
// The data model, feature catalog, immutability rules, and all validation live
// in Ogen behind the wire.
type TierEntitlementsHandler struct {
	plans   *ogenplans.Client
	tenants *ogentenants.Client
}

func NewTierEntitlementsHandler(plans *ogenplans.Client, tenants *ogentenants.Client) *TierEntitlementsHandler {
	return &TierEntitlementsHandler{plans: plans, tenants: tenants}
}

// Register mounts the tier-entitlement routes behind auth. Only signed-in Harbor
// operators may reach them; Harbor→Ogen is separately authenticated by the
// shared gRPC token. Static sub-paths are registered before parameterised ones
// so Fiber doesn't capture a literal segment as a path param.
func (h *TierEntitlementsHandler) Register(app *fiber.App, requireAuth fiber.Handler) {
	// The matrix: catalog rows + every tier's versions.
	app.Get("/api/tier-entitlements", requireAuth, h.Matrix)

	// Version authoring.
	app.Post("/api/tier-entitlements/tiers/:tierId/versions", requireAuth, h.CreateVersion)
	app.Put("/api/tier-entitlements/versions/:id", requireAuth, h.UpdateDraft)
	app.Post("/api/tier-entitlements/versions/:id/publish", requireAuth, h.Publish)
	app.Post("/api/tier-entitlements/versions/:id/retire", requireAuth, h.Retire)

	// Tenant assignment + resolved view.
	app.Get("/api/tier-entitlements/tenants/:tenantId", requireAuth, h.TenantEntitlements)
	app.Put("/api/tier-entitlements/tenants/:tenantId/version", requireAuth, h.AssignTenant)
}

// matrixTier is one tier column: its identity (from the tenant tier catalog)
// plus every version (newest first) the UI can render or drill into. The UI
// picks which version to show per tier (latest active by default).
type matrixTier struct {
	TierID    string                  `json:"tierId"`
	TierName  string                  `json:"tierName"`
	TierColor string                  `json:"tierColor"`
	Versions  []ogenplans.TierVersion `json:"versions"`
}

// matrixResponse is the whole feature × tier-version matrix. `available` flags a
// down/unconfigured upstream (either gRPC client) so the page renders a soft
// "unavailable" state instead of an error — mirroring the platforms/tiers list.
type matrixResponse struct {
	Available bool                `json:"available"`
	Features  []ogenplans.Feature `json:"features"`
	Tiers     []matrixTier        `json:"tiers"`
}

// unavailableMatrix is the soft-fail body: available=false with non-nil empty
// slices so the UI can render the "unavailable" state and still map safely.
func unavailableMatrix() matrixResponse {
	return matrixResponse{Available: false, Features: []ogenplans.Feature{}, Tiers: []matrixTier{}}
}

// Matrix godoc
// @Summary  The feature × tier-version entitlement matrix
// @Tags     tier-entitlements
// @Produce  json
// @Success  200  {object}  matrixResponse
// @Router   /api/tier-entitlements [get]
func (h *TierEntitlementsHandler) Matrix(c *fiber.Ctx) error {
	start := time.Now()

	features, err := h.plans.ListFeatures(c.Context())
	if err != nil {
		logPlans(c, start, err)
		if isPlansUnavailable(err) {
			return c.JSON(unavailableMatrix())
		}
		return mapPlanError(err)
	}

	tiers, err := h.tenants.ListTiers(c.Context())
	if err != nil {
		logPlans(c, start, err)
		if isPlansUnavailable(err) {
			return c.JSON(unavailableMatrix())
		}
		return mapPlanError(err)
	}

	cols := make([]matrixTier, 0, len(tiers))
	for _, t := range tiers {
		versions, verr := h.plans.ListTierVersions(c.Context(), t.ID)
		if verr != nil {
			logPlans(c, start, verr)
			if isPlansUnavailable(verr) {
				return c.JSON(unavailableMatrix())
			}
			return mapPlanError(verr)
		}
		if versions == nil {
			versions = []ogenplans.TierVersion{}
		}
		cols = append(cols, matrixTier{
			TierID:    t.ID,
			TierName:  t.Name,
			TierColor: t.Color,
			Versions:  versions,
		})
	}

	logPlans(c, start, nil)
	if features == nil {
		features = []ogenplans.Feature{}
	}
	return c.JSON(matrixResponse{Available: true, Features: features, Tiers: cols})
}

// CreateVersion godoc
// @Summary  Create a draft tier version (optionally cloned)
// @Tags     tier-entitlements
// @Accept   json
// @Produce  json
// @Param    tierId  path  string  true  "Tier id"
// @Success  201  {object}  ogenplans.TierVersion
// @Router   /api/tier-entitlements/tiers/{tierId}/versions [post]
func (h *TierEntitlementsHandler) CreateVersion(c *fiber.Ctx) error {
	start := time.Now()
	body, err := parseDraftBody(c)
	if err != nil {
		logPlans(c, start, err)
		return err
	}
	out, cerr := h.plans.CreateTierVersion(c.Context(), c.Params("tierId"), body)
	logPlans(c, start, cerr)
	if cerr != nil {
		return mapPlanError(cerr)
	}
	return c.Status(fiber.StatusCreated).JSON(out)
}

// UpdateDraft godoc
// @Summary  Replace a draft version's body (purchasable + entitlements + prices)
// @Tags     tier-entitlements
// @Accept   json
// @Produce  json
// @Param    id  path  string  true  "Tier version id"
// @Success  200  {object}  ogenplans.TierVersion
// @Router   /api/tier-entitlements/versions/{id} [put]
func (h *TierEntitlementsHandler) UpdateDraft(c *fiber.Ctx) error {
	start := time.Now()
	body, err := parseDraftBody(c)
	if err != nil {
		logPlans(c, start, err)
		return err
	}
	out, uerr := h.plans.UpdateTierVersionDraft(c.Context(), c.Params("id"), body)
	logPlans(c, start, uerr)
	if uerr != nil {
		return mapPlanError(uerr)
	}
	return c.JSON(out)
}

type publishRequest struct {
	ChangeReason string `json:"changeReason"`
}

// Publish godoc
// @Summary  Publish a draft version (draft → active; change_reason required)
// @Tags     tier-entitlements
// @Accept   json
// @Produce  json
// @Param    id  path  string  true  "Tier version id"
// @Success  200  {object}  ogenplans.TierVersion
// @Router   /api/tier-entitlements/versions/{id}/publish [post]
func (h *TierEntitlementsHandler) Publish(c *fiber.Ctx) error {
	start := time.Now()
	var req publishRequest
	if err := c.BodyParser(&req); err != nil {
		logPlans(c, start, err)
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	out, err := h.plans.PublishTierVersion(c.Context(), c.Params("id"), req.ChangeReason)
	logPlans(c, start, err)
	if err != nil {
		return mapPlanError(err)
	}
	return c.JSON(out)
}

// Retire godoc
// @Summary  Retire an active version (guarded; force overrides live assignments)
// @Tags     tier-entitlements
// @Produce  json
// @Param    id     path   string  true   "Tier version id"
// @Param    force  query  bool    false  "Retire even if live assignments remain"
// @Success  200  {object}  ogenplans.TierVersion
// @Router   /api/tier-entitlements/versions/{id}/retire [post]
func (h *TierEntitlementsHandler) Retire(c *fiber.Ctx) error {
	start := time.Now()
	out, err := h.plans.RetireTierVersion(c.Context(), c.Params("id"), c.QueryBool("force", false))
	logPlans(c, start, err)
	if err != nil {
		return mapPlanError(err)
	}
	return c.JSON(out)
}

// TenantEntitlements godoc
// @Summary  The version + entitlements in force for a tenant now
// @Tags     tier-entitlements
// @Produce  json
// @Param    tenantId  path  string  true  "Tenant id"
// @Success  200  {object}  ogenplans.TierVersion
// @Router   /api/tier-entitlements/tenants/{tenantId} [get]
func (h *TierEntitlementsHandler) TenantEntitlements(c *fiber.Ctx) error {
	start := time.Now()
	out, err := h.plans.GetTenantEntitlements(c.Context(), c.Params("tenantId"))
	logPlans(c, start, err)
	if err != nil {
		return mapPlanError(err)
	}
	return c.JSON(out)
}

type assignRequest struct {
	TierVersionID string `json:"tierVersionId"`
	Reason        string `json:"reason"`
}

// AssignTenant godoc
// @Summary  Bind a tenant to a specific tier version
// @Tags     tier-entitlements
// @Accept   json
// @Produce  json
// @Param    tenantId  path  string  true  "Tenant id"
// @Success  200  {object}  ogenplans.TierVersion
// @Router   /api/tier-entitlements/tenants/{tenantId}/version [put]
func (h *TierEntitlementsHandler) AssignTenant(c *fiber.Ctx) error {
	start := time.Now()
	var req assignRequest
	if err := c.BodyParser(&req); err != nil {
		logPlans(c, start, err)
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	out, err := h.plans.SetTenantTierVersion(c.Context(), c.Params("tenantId"), req.TierVersionID, req.Reason)
	logPlans(c, start, err)
	if err != nil {
		return mapPlanError(err)
	}
	return c.JSON(out)
}

// parseDraftBody decodes the whole draft body (purchasable + entitlements +
// prices, plus cloneFromVersionId on create). A parse failure returns a
// fixed-shape 400 (never the body).
func parseDraftBody(c *fiber.Ctx) (ogenplans.DraftBody, error) {
	var b ogenplans.DraftBody
	if err := c.BodyParser(&b); err != nil {
		return b, fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	return b, nil
}

// isPlansUnavailable reports whether err means "the plan/tenant-admin service
// can't be reached right now" — an unconfigured (nil) client, or a gRPC call
// that failed with Unavailable / a deadline. Checks both clients' sentinels
// because the matrix needs both.
func isPlansUnavailable(err error) bool {
	switch status.Code(err) {
	case codes.Unavailable, codes.DeadlineExceeded:
		return true
	}
	return errors.Is(err, ogenplans.ErrUnavailable) || errors.Is(err, ogentenants.ErrUnavailable)
}

// mapPlanError translates client/gRPC errors to HTTP statuses, matching the
// platforms/tiers contract. Publish without a change_reason → 400; mutating a
// published version or retiring one with live assignments → 409 (with Ogen's
// message, which carries the blocking tenant list); unknown ids → 404;
// Unauthenticated (Harbor's shared token is wrong) → 502; Unavailable → 503.
func mapPlanError(err error) error {
	if errors.Is(err, ogenplans.ErrUnavailable) || errors.Is(err, ogentenants.ErrUnavailable) {
		return fiber.NewError(fiber.StatusServiceUnavailable, "tier-entitlement service unavailable")
	}
	// A deadline is an availability problem, not a server fault: status.FromError
	// reports ok=false for it, so handle it before the ok check below.
	if status.Code(err) == codes.DeadlineExceeded {
		return fiber.NewError(fiber.StatusServiceUnavailable, "tier-entitlement service unavailable")
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
	case codes.AlreadyExists:
		return fiber.NewError(fiber.StatusConflict, st.Message())
	case codes.FailedPrecondition:
		return fiber.NewError(fiber.StatusConflict, st.Message())
	case codes.Unauthenticated:
		return fiber.NewError(fiber.StatusBadGateway, "tier-entitlement service authentication failed")
	case codes.Unavailable:
		return fiber.NewError(fiber.StatusServiceUnavailable, "tier-entitlement service unavailable")
	default:
		return fiber.NewError(fiber.StatusInternalServerError, "tier-entitlement request failed")
	}
}

// logPlans emits a structured line with the method/path + status class. There is
// no secret material on this surface.
func logPlans(c *fiber.Ctx, start time.Time, err error) {
	attrs := []any{logging.AttrComponent, "tier-entitlements", "method", c.Method(), "path", c.Path(), "duration_ms", time.Since(start).Milliseconds()}
	if err != nil {
		attrs = append(attrs, "code", status.Code(err).String())
	}
	slog.InfoContext(c.Context(), "tier-entitlements request", attrs...)
}
