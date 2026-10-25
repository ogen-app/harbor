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
	"github.com/ogen-app/harbor/src/repository/harbor"
	"github.com/ogen-app/harbor/src/repository/ogeninvites"
)

// OperatorLookup resolves the signed-in operator's identity (their email) for
// the audit fields Ogen records (created_by / updated_by). It is always taken
// from the session server-side, never from the request body.
type OperatorLookup func(c *fiber.Ctx) (string, error)

// NewOperatorLookup resolves the operator from the session RequireAuth stored.
func NewOperatorLookup(users harbor.UserRepository) OperatorLookup {
	return func(c *fiber.Ctx) (string, error) {
		s, ok := sessionFrom(c)
		if !ok {
			return "", fiber.NewError(fiber.StatusUnauthorized, "authentication required")
		}
		u, err := users.GetByID(c.Context(), s.UserID)
		if err != nil {
			return "", err
		}
		return u.Email, nil
	}
}

// InvitesHandler is the REST surface for complimentary tester invites and the
// signup mode (CON-334, the Harbor side of CON-333). Like BillingHandler it is a
// thin adapter over a gRPC client — tokens, emails and redemption all live in
// Ogen behind the wire.
type InvitesHandler struct {
	client   *ogeninvites.Client
	operator OperatorLookup
}

func NewInvitesHandler(client *ogeninvites.Client, operator OperatorLookup) *InvitesHandler {
	return &InvitesHandler{client: client, operator: operator}
}

// Register mounts the invite + signup-settings routes behind auth. The action
// routes sit one segment under /api/invites/:id, so they never collide with the
// detail route.
func (h *InvitesHandler) Register(app *fiber.App, requireAuth fiber.Handler) {
	app.Get("/api/signup-settings", requireAuth, h.SignupSettings)
	app.Put("/api/signup-settings", requireAuth, h.UpdateSignupSettings)
	app.Get("/api/invites", requireAuth, h.List)
	app.Post("/api/invites", requireAuth, h.Create)
	app.Get("/api/invites/:id", requireAuth, h.Get)
	app.Post("/api/invites/:id/resend", requireAuth, h.Resend)
	app.Post("/api/invites/:id/revoke", requireAuth, h.Revoke)
}

// signupSettingsResponse: `available` distinguishes a down/unconfigured
// invite-admin service from a configured one, so the page (and the sidebar
// mode pill) render a soft "unavailable" state instead of an error.
type signupSettingsResponse struct {
	Available bool                       `json:"available"`
	Settings  ogeninvites.SignupSettings `json:"settings"`
}

type updateSignupSettingsRequest struct {
	Mode               string `json:"mode"`
	MaxOwnedWorkspaces int32  `json:"maxOwnedWorkspaces"`
}

type invitesListResponse struct {
	Available     bool                 `json:"available"`
	Invites       []ogeninvites.Invite `json:"invites"`
	NextPageToken string               `json:"nextPageToken"`
}

type inviteResponse struct {
	Invite ogeninvites.Invite `json:"invite"`
	// Replaced is set by create only: a pending invite for the address was
	// replaced and its link no longer works.
	Replaced bool `json:"replaced"`
}

type createInviteRequest struct {
	Email          string   `json:"email"`
	TierID         string   `json:"tierId"`
	GroupIDs       []string `json:"groupIds"`
	ExpiresInHours int32    `json:"expiresInHours"`
	Message        string   `json:"message"`
	Note           string   `json:"note"`
}

type resendInviteRequest struct {
	ExpiresInHours int32 `json:"expiresInHours"` // 0 = the original lifetime
}

// SignupSettings godoc
// @Summary  The signup mode (open | invite_only) and the workspace cap
// @Tags     invites
// @Produce  json
// @Success  200  {object}  signupSettingsResponse
// @Router   /api/signup-settings [get]
func (h *InvitesHandler) SignupSettings(c *fiber.Ctx) error {
	start := time.Now()
	s, err := h.client.SignupSettings(c.Context())
	logInvites(c, start, err)
	if err != nil {
		if isInvitesUnavailable(err) {
			return c.JSON(signupSettingsResponse{Available: false})
		}
		return mapInviteError(c, err)
	}
	return c.JSON(signupSettingsResponse{Available: true, Settings: s})
}

// UpdateSignupSettings godoc
// @Summary  Write the signup mode + workspace cap (whole resource)
// @Tags     invites
// @Accept   json
// @Produce  json
// @Success  200  {object}  signupSettingsResponse
// @Router   /api/signup-settings [put]
func (h *InvitesHandler) UpdateSignupSettings(c *fiber.Ctx) error {
	start := time.Now()
	var req updateSignupSettingsRequest
	if err := c.BodyParser(&req); err != nil {
		logInvites(c, start, err)
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	if req.Mode != ogeninvites.ModeOpen && req.Mode != ogeninvites.ModeInviteOnly {
		return fiber.NewError(fiber.StatusBadRequest, "mode must be open or invite_only")
	}
	if req.MaxOwnedWorkspaces < 0 {
		return fiber.NewError(fiber.StatusBadRequest, "the workspace cap must be 0 (unlimited) or more")
	}
	operator, err := h.operator(c)
	if err != nil {
		return err
	}
	s, err := h.client.UpdateSignupSettings(c.Context(), req.Mode, req.MaxOwnedWorkspaces, operator)
	logInvites(c, start, err)
	if err != nil {
		return mapInviteError(c, err)
	}
	return c.JSON(signupSettingsResponse{Available: true, Settings: s})
}

// List godoc
// @Summary  Tester invites, newest first (keyset-paginated)
// @Tags     invites
// @Produce  json
// @Param    status      query  string  false  "pending | expired | redeemed | revoked"
// @Param    q           query  string  false  "Case-insensitive email substring"
// @Param    page_size   query  int     false  "Page size (server-clamped)"
// @Param    page_token  query  string  false  "Opaque cursor from a prior response"
// @Success  200  {object}  invitesListResponse
// @Router   /api/invites [get]
func (h *InvitesHandler) List(c *fiber.Ctx) error {
	start := time.Now()
	page, err := h.client.ListInvites(c.Context(), ogeninvites.ListFilter{
		Status:     c.Query("status"),
		EmailQuery: strings.TrimSpace(c.Query("q")),
		PageSize:   int32(c.QueryInt("page_size", 0)),
		PageToken:  c.Query("page_token"),
	})
	logInvites(c, start, err)
	if err != nil {
		if isInvitesUnavailable(err) {
			return c.JSON(invitesListResponse{Available: false, Invites: []ogeninvites.Invite{}})
		}
		return mapInviteError(c, err)
	}
	return c.JSON(invitesListResponse{Available: true, Invites: page.Invites, NextPageToken: page.NextPageToken})
}

// Get godoc
// @Summary  One tester invite
// @Tags     invites
// @Produce  json
// @Param    id  path  string  true  "Invite id"
// @Success  200  {object}  inviteResponse
// @Router   /api/invites/{id} [get]
func (h *InvitesHandler) Get(c *fiber.Ctx) error {
	start := time.Now()
	inv, err := h.client.GetInvite(c.Context(), c.Params("id"))
	logInvites(c, start, err)
	if err != nil {
		return mapInviteError(c, err)
	}
	return c.JSON(inviteResponse{Invite: inv})
}

// Create godoc
// @Summary  Invite a complimentary tester (replaces a pending invite for the address)
// @Tags     invites
// @Accept   json
// @Produce  json
// @Success  200  {object}  inviteResponse
// @Router   /api/invites [post]
func (h *InvitesHandler) Create(c *fiber.Ctx) error {
	start := time.Now()
	var req createInviteRequest
	if err := c.BodyParser(&req); err != nil {
		logInvites(c, start, err)
		return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
	}
	email := strings.TrimSpace(req.Email)
	if email == "" {
		return fiber.NewError(fiber.StatusBadRequest, "an email is required")
	}
	tierID := strings.TrimSpace(req.TierID)
	if tierID == "" {
		return fiber.NewError(fiber.StatusBadRequest, "a tier is required")
	}
	operator, err := h.operator(c)
	if err != nil {
		return err
	}
	groupIDs := req.GroupIDs
	if groupIDs == nil {
		groupIDs = []string{}
	}
	inv, replaced, err := h.client.CreateInvite(c.Context(), ogeninvites.InviteInput{
		Email:          email,
		TierID:         tierID,
		GroupIDs:       groupIDs,
		ExpiresInHours: req.ExpiresInHours,
		Message:        strings.TrimSpace(req.Message),
		Note:           strings.TrimSpace(req.Note),
		CreatedBy:      operator,
	})
	logInvites(c, start, err)
	if err != nil {
		return mapInviteError(c, err)
	}
	return c.JSON(inviteResponse{Invite: inv, Replaced: replaced})
}

// Resend godoc
// @Summary  Send a pending (or expired) invite again with a new link
// @Tags     invites
// @Accept   json
// @Produce  json
// @Param    id  path  string  true  "Invite id"
// @Success  200  {object}  inviteResponse
// @Router   /api/invites/{id}/resend [post]
func (h *InvitesHandler) Resend(c *fiber.Ctx) error {
	start := time.Now()
	var req resendInviteRequest
	if len(c.Body()) > 0 {
		if err := c.BodyParser(&req); err != nil {
			logInvites(c, start, err)
			return fiber.NewError(fiber.StatusBadRequest, "invalid request body")
		}
	}
	inv, err := h.client.ResendInvite(c.Context(), c.Params("id"), req.ExpiresInHours)
	logInvites(c, start, err)
	if err != nil {
		return mapInviteError(c, err)
	}
	return c.JSON(inviteResponse{Invite: inv})
}

// Revoke godoc
// @Summary  Revoke a pending invite (its link stops working)
// @Tags     invites
// @Produce  json
// @Param    id  path  string  true  "Invite id"
// @Success  200  {object}  inviteResponse
// @Router   /api/invites/{id}/revoke [post]
func (h *InvitesHandler) Revoke(c *fiber.Ctx) error {
	start := time.Now()
	inv, err := h.client.RevokeInvite(c.Context(), c.Params("id"))
	logInvites(c, start, err)
	if err != nil {
		return mapInviteError(c, err)
	}
	return c.JSON(inviteResponse{Invite: inv})
}

// isInvitesUnavailable reports whether err means "invite-admin service can't be
// reached right now": an unconfigured (nil) client, or a gRPC Unavailable /
// deadline (Ogen down or slow).
func isInvitesUnavailable(err error) bool {
	switch status.Code(err) {
	case codes.Unavailable, codes.DeadlineExceeded:
		return true
	}
	return errors.Is(err, ogeninvites.ErrUnavailable)
}

// inviteErrorCodes are the FailedPrecondition sub-reasons Ogen prefixes its
// message with ("account_exists: …"). The UI keys its guidance copy off `code`.
var inviteErrorCodes = []string{"account_exists", "tier_not_active"}

// mapInviteError translates client/gRPC errors to HTTP statuses so the UI can
// show them inline. Ogen's message is passed through for the operator-facing
// codes; a known FailedPrecondition sub-reason is split off into `code`.
func mapInviteError(c *fiber.Ctx, err error) error {
	if errors.Is(err, ogeninvites.ErrUnavailable) {
		return fiber.NewError(fiber.StatusServiceUnavailable, "invite-admin service unavailable")
	}
	// status.FromError reports ok=false for a bare context.DeadlineExceeded, so
	// classify it before the ok check (which would otherwise 500).
	if status.Code(err) == codes.DeadlineExceeded {
		return fiber.NewError(fiber.StatusServiceUnavailable, "invite-admin service unavailable")
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
		for _, code := range inviteErrorCodes {
			if rest, found := strings.CutPrefix(st.Message(), code+":"); found {
				return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": strings.TrimSpace(rest), "code": code})
			}
		}
		return fiber.NewError(fiber.StatusConflict, st.Message())
	case codes.Unauthenticated:
		return fiber.NewError(fiber.StatusBadGateway, "invite-admin service authentication failed")
	case codes.Unavailable:
		return fiber.NewError(fiber.StatusServiceUnavailable, "invite-admin service unavailable")
	default:
		return fiber.NewError(fiber.StatusInternalServerError, "invite request failed")
	}
}

// logInvites emits a structured line with the method/path + status class.
func logInvites(c *fiber.Ctx, start time.Time, err error) {
	attrs := []any{logging.AttrComponent, "invites", "method", c.Method(), "path", c.Path(), "duration_ms", time.Since(start).Milliseconds()}
	if err != nil {
		attrs = append(attrs, "code", status.Code(err).String())
	}
	slog.InfoContext(c.Context(), "invites request", attrs...)
}
