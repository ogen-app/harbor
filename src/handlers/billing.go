package handlers

import (
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/ogen-app/harbor/src/logging"
	"github.com/ogen-app/harbor/src/repository/ogenbilling"
)

// BillingHandler is the REST surface for billing oversight (CON-327, the Harbor
// side of CON-322). Like AnnouncementsHandler it is a thin adapter over a gRPC
// client — subscriptions, the webhook log, the gate and the cutover all live in
// Ogen behind the wire. Dunning is operator-decides: Ogen never changes a
// workspace's tier or status itself, so this is where the operator sees billing
// trouble and acts on it (suspend/move-tier reuse the tenant + tier-entitlement
// routes).
type BillingHandler struct {
	client *ogenbilling.Client
	// appBaseURL is Ogen's public app origin, used by the UI to build the
	// free-month share link ({appBaseURL}/signup?plan=<tier_id>). '' hides it.
	appBaseURL string
}

func NewBillingHandler(client *ogenbilling.Client, appBaseURL string) *BillingHandler {
	return &BillingHandler{client: client, appBaseURL: strings.TrimRight(appBaseURL, "/")}
}

// Register mounts the billing routes behind auth. The per-tenant routes sit two
// segments under /api/tenants/:id, so they never collide with the tenant detail
// route.
func (h *BillingHandler) Register(app *fiber.App, requireAuth fiber.Handler) {
	app.Get("/api/billing/settings", requireAuth, h.Settings)
	app.Get("/api/billing/attention", requireAuth, h.Attention)
	app.Get("/api/billing/free-trial-tier", requireAuth, h.FreeTrialTier)
	app.Put("/api/billing/free-trial-tier", requireAuth, h.SetFreeTrialTier)
	app.Post("/api/billing/cutover", requireAuth, h.Cutover)
	app.Get("/api/tenants/:id/billing", requireAuth, h.TenantBilling)
	app.Put("/api/tenants/:id/billing/required", requireAuth, h.SetRequired)
	app.Put("/api/tenants/:id/billing/complimentary", requireAuth, h.SetComplimentary)
	app.Post("/api/tenants/:id/billing/resync", requireAuth, h.Resync)
}

// billingSettingsResponse: `available` distinguishes a down/unconfigured
// billing-admin service from a configured one, so the page renders a soft
// "unavailable" state instead of an error.
type billingSettingsResponse struct {
	Available  bool                 `json:"available"`
	Settings   ogenbilling.Settings `json:"settings"`
	AppBaseURL string               `json:"appBaseUrl"`
}

type billingAttentionResponse struct {
	Available     bool                        `json:"available"`
	Items         []ogenbilling.AttentionItem `json:"items"`
	NextPageToken string                      `json:"nextPageToken"`
}

type tenantBillingResponse struct {
	Available bool                      `json:"available"`
	Billing   ogenbilling.TenantBilling `json:"billing"`
	// Corrected is set by resync only: subscriptions whose mirror changed.
	Corrected int32 `json:"corrected"`
}

type freeTrialTierResponse struct {
	Available bool                      `json:"available"`
	Offer     ogenbilling.FreeTrialTier `json:"offer"`
}

type setBillingRequiredRequest struct {
	Required bool   `json:"required"`
	Reason   string `json:"reason"`
}

type setComplimentaryRequest struct {
	Complimentary bool   `json:"complimentary"`
	Reason        string `json:"reason"`
}

type setFreeTrialTierRequest struct {
	TierID string `json:"tierId"` // '' turns the offer off
	Reason string `json:"reason"`
}

type cutoverRequest struct {
	DryRun bool `json:"dryRun"`
}

// Settings godoc
// @Summary  Billing provider settings (provider, test/live, configured)
// @Tags     billing
// @Produce  json
// @Success  200  {object}  billingSettingsResponse
// @Router   /api/billing/settings [get]
func (h *BillingHandler) Settings(c *fiber.Ctx) error {
	start := time.Now()
	s, err := h.client.Settings(c.Context())
	logBilling(c, start, err)
	if err != nil {
		if isBillingUnavailable(err) {
			return c.JSON(billingSettingsResponse{Available: false, AppBaseURL: h.appBaseURL})
		}
		return mapBillingError(err)
	}
	return c.JSON(billingSettingsResponse{Available: true, Settings: s, AppBaseURL: h.appBaseURL})
}

// Attention godoc
// @Summary  Workspaces needing an operator billing decision, newest first
// @Tags     billing
// @Produce  json
// @Param    page_size   query  int     false  "Page size (server-clamped)"
// @Param    page_token  query  string  false  "Opaque cursor from a prior response"
// @Success  200  {object}  billingAttentionResponse
// @Router   /api/billing/attention [get]
func (h *BillingHandler) Attention(c *fiber.Ctx) error {
	start := time.Now()
	page, err := h.client.Attention(c.Context(), int32(c.QueryInt("page_size", 0)), c.Query("page_token"))
	logBilling(c, start, err)
	if err != nil {
		if isBillingUnavailable(err) {
			return c.JSON(billingAttentionResponse{Available: false, Items: []ogenbilling.AttentionItem{}})
		}
		return mapBillingError(err)
	}
	return c.JSON(billingAttentionResponse{Available: true, Items: page.Items, NextPageToken: page.NextPageToken})
}

// TenantBilling godoc
// @Summary  One workspace's billing picture (subscriptions, changes, webhooks)
// @Tags     billing
// @Produce  json
// @Param    id  path  string  true  "Tenant id"
// @Success  200  {object}  tenantBillingResponse
// @Router   /api/tenants/{id}/billing [get]
func (h *BillingHandler) TenantBilling(c *fiber.Ctx) error {
	start := time.Now()
	b, err := h.client.TenantBilling(c.Context(), c.Params("id"))
	logBilling(c, start, err)
	if err != nil {
		if isBillingUnavailable(err) {
			return c.JSON(tenantBillingResponse{Available: false, Billing: emptyTenantBilling(c.Params("id"))})
		}
		return mapBillingError(err)
	}
	return c.JSON(tenantBillingResponse{Available: true, Billing: b})
}

// SetRequired godoc
// @Summary  Comp/exempt a workspace (required=false) or put it back behind the gate
// @Tags     billing
// @Accept   json
// @Produce  json
// @Param    id  path  string  true  "Tenant id"
// @Success  200  {object}  tenantBillingResponse
// @Router   /api/tenants/{id}/billing/required [put]
func (h *BillingHandler) SetRequired(c *fiber.Ctx) error {
	start := time.Now()
	var req setBillingRequiredRequest
	if err := c.BodyParser(&req); err != nil {
		logBilling(c, start, err)
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		return fiber.NewError(fiber.StatusBadRequest, "a reason is required")
	}
	b, err := h.client.SetBillingRequired(c.Context(), c.Params("id"), req.Required, reason)
	logBilling(c, start, err)
	if err != nil {
		return mapBillingError(err)
	}
	return c.JSON(tenantBillingResponse{Available: true, Billing: b})
}

// SetComplimentary godoc
// @Summary  Make a workspace a complimentary tester one, or end its beta access
// @Tags     billing
// @Accept   json
// @Produce  json
// @Param    id  path  string  true  "Tenant id"
// @Success  200  {object}  tenantBillingResponse
// @Router   /api/tenants/{id}/billing/complimentary [put]
func (h *BillingHandler) SetComplimentary(c *fiber.Ctx) error {
	start := time.Now()
	var req setComplimentaryRequest
	if err := c.BodyParser(&req); err != nil {
		logBilling(c, start, err)
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		return fiber.NewError(fiber.StatusBadRequest, "a reason is required")
	}
	b, err := h.client.SetComplimentary(c.Context(), c.Params("id"), req.Complimentary, reason)
	logBilling(c, start, err)
	if err != nil {
		return mapBillingError(err)
	}
	return c.JSON(tenantBillingResponse{Available: true, Billing: b})
}

// Resync godoc
// @Summary  Re-read a workspace's subscriptions from the provider
// @Tags     billing
// @Produce  json
// @Param    id  path  string  true  "Tenant id"
// @Success  200  {object}  tenantBillingResponse
// @Router   /api/tenants/{id}/billing/resync [post]
func (h *BillingHandler) Resync(c *fiber.Ctx) error {
	start := time.Now()
	b, corrected, err := h.client.Resync(c.Context(), c.Params("id"))
	logBilling(c, start, err)
	if err != nil {
		return mapBillingError(err)
	}
	return c.JSON(tenantBillingResponse{Available: true, Billing: b, Corrected: corrected})
}

// FreeTrialTier godoc
// @Summary  The free-month offer: current tier (or off) + eligible tiers
// @Tags     billing
// @Produce  json
// @Success  200  {object}  freeTrialTierResponse
// @Router   /api/billing/free-trial-tier [get]
func (h *BillingHandler) FreeTrialTier(c *fiber.Ctx) error {
	start := time.Now()
	offer, err := h.client.FreeTrialTier(c.Context())
	logBilling(c, start, err)
	if err != nil {
		if isBillingUnavailable(err) {
			return c.JSON(freeTrialTierResponse{Available: false, Offer: ogenbilling.FreeTrialTier{EligibleTierIDs: []string{}}})
		}
		return mapBillingError(err)
	}
	return c.JSON(freeTrialTierResponse{Available: true, Offer: offer})
}

// SetFreeTrialTier godoc
// @Summary  Mark exactly one tier as the free-month tier, or turn the offer off
// @Tags     billing
// @Accept   json
// @Produce  json
// @Success  200  {object}  freeTrialTierResponse
// @Router   /api/billing/free-trial-tier [put]
func (h *BillingHandler) SetFreeTrialTier(c *fiber.Ctx) error {
	start := time.Now()
	var req setFreeTrialTierRequest
	if err := c.BodyParser(&req); err != nil {
		logBilling(c, start, err)
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	reason := strings.TrimSpace(req.Reason)
	if reason == "" {
		return fiber.NewError(fiber.StatusBadRequest, "a reason is required")
	}
	offer, err := h.client.SetFreeTrialTier(c.Context(), strings.TrimSpace(req.TierID), reason)
	logBilling(c, start, err)
	if err != nil {
		return mapBillingError(err)
	}
	return c.JSON(freeTrialTierResponse{Available: true, Offer: offer})
}

// Cutover godoc
// @Summary  Sandbox→live cutover: invalidate test subscriptions (dryRun lists only)
// @Tags     billing
// @Accept   json
// @Produce  json
// @Success  200  {object}  ogenbilling.CutoverResult
// @Router   /api/billing/cutover [post]
func (h *BillingHandler) Cutover(c *fiber.Ctx) error {
	start := time.Now()
	var req cutoverRequest
	if err := c.BodyParser(&req); err != nil {
		logBilling(c, start, err)
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	out, err := h.client.InvalidateTestSubscriptions(c.Context(), req.DryRun)
	logBilling(c, start, err)
	if err != nil {
		return mapBillingError(err)
	}
	return c.JSON(out)
}

// emptyTenantBilling is the never-null shape returned with available=false, so
// the UI can map over every list.
func emptyTenantBilling(tenantID string) ogenbilling.TenantBilling {
	return ogenbilling.TenantBilling{
		TenantID:            tenantID,
		Subscriptions:       []ogenbilling.Subscription{},
		ScheduledChanges:    []ogenbilling.ScheduledChange{},
		RecentWebhookEvents: []ogenbilling.WebhookEvent{},
		Owners:              []ogenbilling.OwnerTrial{},
	}
}

// isBillingUnavailable reports whether err means "billing-admin service can't be
// reached right now": an unconfigured (nil) client, or a gRPC Unavailable /
// deadline (Ogen down, slow, or billing off with BILLING_PROVIDER=none).
func isBillingUnavailable(err error) bool {
	switch status.Code(err) {
	case codes.Unavailable, codes.DeadlineExceeded:
		return true
	}
	return errors.Is(err, ogenbilling.ErrUnavailable)
}

// mapBillingError translates client/gRPC errors to HTTP statuses so the UI can
// show them inline. Ogen's message is passed through for the operator-facing
// codes — notably FailedPrecondition ("still in test mode", "tier has no
// one-month trial variant"), which the screens show as is.
func mapBillingError(err error) error {
	if errors.Is(err, ogenbilling.ErrUnavailable) {
		return fiber.NewError(fiber.StatusServiceUnavailable, "billing-admin service unavailable")
	}
	// status.FromError reports ok=false for a bare context.DeadlineExceeded, so
	// classify it before the ok check (which would otherwise 500).
	if status.Code(err) == codes.DeadlineExceeded {
		return fiber.NewError(fiber.StatusServiceUnavailable, "billing-admin service unavailable")
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
		return fiber.NewError(fiber.StatusBadGateway, "billing-admin service authentication failed")
	case codes.Unavailable:
		// Billing off or the provider failed: Ogen's message says which.
		return fiber.NewError(fiber.StatusServiceUnavailable, st.Message())
	default:
		return fiber.NewError(fiber.StatusInternalServerError, "billing request failed")
	}
}

// logBilling emits a structured line with the method/path + status class.
func logBilling(c *fiber.Ctx, start time.Time, err error) {
	attrs := []any{logging.AttrComponent, "billing", "method", c.Method(), "path", c.Path(), "duration_ms", time.Since(start).Milliseconds()}
	if err != nil {
		attrs = append(attrs, "code", status.Code(err).String())
	}
	slog.InfoContext(c.Context(), "billing request", attrs...)
}
