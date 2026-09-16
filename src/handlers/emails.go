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
	"github.com/ogen-app/harbor/src/repository/ogenemail"
)

// EmailsHandler is the REST surface behind the /tenants/{id} Emails tab
// (CON-192). It is a thin adapter over the ogenemail gRPC client: Ogen owns the
// email_logs history, the persisted delivery/open/click timeline, and the live
// Resend body fetch (Harbor has no Resend key). tenant_id scoping is enforced
// server-side in Ogen; Harbor passes the path :id through.
type EmailsHandler struct {
	client *ogenemail.Client
}

func NewEmailsHandler(client *ogenemail.Client) *EmailsHandler {
	return &EmailsHandler{client: client}
}

const (
	// defaultEmailPageSize is the list page size when the client sends no limit;
	// maxEmailPageSize caps it (Ogen clamps too, but we avoid sending garbage).
	defaultEmailPageSize = 25
	maxEmailPageSize     = 200
)

// Register mounts the tenant-scoped email routes behind auth. Both are
// two-segment shapes (:id/emails, :id/emails/:emailId), so they never collide
// with the one-segment /api/tenants/:id detail route registered by
// TenantsHandler — Fiber matches on segment count.
func (h *EmailsHandler) Register(app *fiber.App, requireAuth fiber.Handler) {
	app.Get("/api/tenants/:id/emails", requireAuth, h.List)
	app.Get("/api/tenants/:id/emails/:emailId", requireAuth, h.Detail)
}

// emailsListResponse mirrors the platforms/secrets pattern: `available`
// distinguishes a down/unconfigured email-admin service from a tenant that
// simply has no email yet, so the tab renders a soft "unavailable" state instead
// of an error. nextCursor is ” when there are no more pages.
type emailsListResponse struct {
	Available  bool                     `json:"available"`
	Emails     []ogenemail.EmailSummary `json:"emails"`
	NextCursor string                   `json:"nextCursor"`
}

type emailDetailResponse struct {
	Available bool                   `json:"available"`
	Email     *ogenemail.EmailDetail `json:"email,omitempty"`
}

// List godoc
// @Summary      List a tenant's sent emails (newest first, keyset-paginated)
// @Description  Recipient, template, kind, status and engagement rollup per email.
// @Description  Filter with status (comma-separated any-of), kind, and q (recipient
// @Description  substring); page with limit + cursor (opaque next-page token).
// @Tags         emails
// @Produce      json
// @Param        id      path   string  true   "Tenant ID"
// @Param        limit   query  int     false  "Page size (1-200, default 25)"
// @Param        cursor  query  string  false  "Opaque keyset cursor from a prior nextCursor"
// @Param        status  query  string  false  "Comma-separated statuses (any-of match)"
// @Param        kind    query  string  false  "transactional | marketing"
// @Param        q       query  string  false  "Case-insensitive recipient substring"
// @Success      200  {object}  emailsListResponse
// @Router       /api/tenants/{id}/emails [get]
func (h *EmailsHandler) List(c *fiber.Ctx) error {
	start := time.Now()
	pageSize := c.QueryInt("limit", defaultEmailPageSize)
	if pageSize < 1 {
		pageSize = defaultEmailPageSize
	}
	if pageSize > maxEmailPageSize {
		pageSize = maxEmailPageSize
	}
	filter := ogenemail.EmailFilter{
		Status:          emailStatusFilter(c.Query("status")),
		Kind:            strings.TrimSpace(c.Query("kind")),
		RecipientSubstr: strings.TrimSpace(c.Query("q")),
	}

	emails, next, err := h.client.ListTenantEmails(c.Context(), c.Params("id"), int32(pageSize), c.Query("cursor"), filter)
	logEmails(c, start, err)
	if err != nil {
		// A down/unconfigured upstream is a soft state, not a 5xx: return an empty
		// list flagged unavailable so the tab renders gracefully.
		if isEmailsUnavailable(err) {
			return c.JSON(emailsListResponse{Available: false, Emails: []ogenemail.EmailSummary{}})
		}
		return mapEmailError(err)
	}
	if emails == nil {
		emails = []ogenemail.EmailSummary{}
	}
	return c.JSON(emailsListResponse{Available: true, Emails: emails, NextCursor: next})
}

// Detail godoc
// @Summary      One email: summary + persisted timeline + body (live from Resend)
// @Description  When the Resend body can't be fetched, the response still carries
// @Description  the summary + timeline with bodyAvailable=false.
// @Tags         emails
// @Produce      json
// @Param        id       path  string  true  "Tenant ID"
// @Param        emailId  path  string  true  "Email log ID"
// @Success      200  {object}  emailDetailResponse
// @Router       /api/tenants/{id}/emails/{emailId} [get]
func (h *EmailsHandler) Detail(c *fiber.Ctx) error {
	start := time.Now()
	detail, err := h.client.GetTenantEmail(c.Context(), c.Params("id"), c.Params("emailId"))
	logEmails(c, start, err)
	if err != nil {
		if isEmailsUnavailable(err) {
			return c.JSON(emailDetailResponse{Available: false})
		}
		return mapEmailError(err)
	}
	return c.JSON(emailDetailResponse{Available: true, Email: &detail})
}

// emailStatusFilter splits a comma-separated status query into an any-of list,
// trimming blanks. Empty ⇒ nil (Ogen treats an empty filter as "any status").
func emailStatusFilter(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// isEmailsUnavailable reports whether err means "email-admin service can't be
// reached right now" — the client is unconfigured (nil), or the gRPC call failed
// with Unavailable / a deadline (Ogen down / no listener / slow). Unimplemented
// is included so an Ogen that predates the EmailAdminService (CON-298) degrades
// to the soft "unavailable" tab rather than surfacing a 500.
func isEmailsUnavailable(err error) bool {
	switch status.Code(err) {
	case codes.Unavailable, codes.DeadlineExceeded, codes.Unimplemented:
		return true
	}
	return errors.Is(err, ogenemail.ErrUnavailable)
}

// mapEmailError translates client/gRPC errors to HTTP statuses, matching the
// platforms/tiers/secrets contract. This surface is read-only, so the common
// non-availability code is NotFound (unknown tenant/email); InvalidArgument
// covers a malformed cursor. Unauthenticated means Harbor's shared token is
// wrong (operator-facing 502); Unavailable → 503; anything else → 500.
func mapEmailError(err error) error {
	if errors.Is(err, ogenemail.ErrUnavailable) {
		return fiber.NewError(fiber.StatusServiceUnavailable, "email-admin service unavailable")
	}
	// A deadline is an availability problem, not a server fault: status.Code
	// classifies context.DeadlineExceeded, but status.FromError reports ok=false
	// for it, so handle it before the ok check below (which would 500).
	if status.Code(err) == codes.DeadlineExceeded {
		return fiber.NewError(fiber.StatusServiceUnavailable, "email-admin service unavailable")
	}
	st, ok := status.FromError(err)
	if !ok {
		return err
	}
	switch st.Code() {
	case codes.InvalidArgument:
		return fiber.NewError(fiber.StatusBadRequest, st.Message())
	case codes.NotFound:
		return fiber.NewError(fiber.StatusNotFound, "email not found")
	case codes.Unauthenticated:
		return fiber.NewError(fiber.StatusBadGateway, "email-admin service authentication failed")
	case codes.Unavailable:
		return fiber.NewError(fiber.StatusServiceUnavailable, "email-admin service unavailable")
	default:
		return fiber.NewError(fiber.StatusInternalServerError, "email request failed")
	}
}

// logEmails emits a structured line with the method/path + status class. Email
// bodies never reach this surface's logs — only ids/metadata.
func logEmails(c *fiber.Ctx, start time.Time, err error) {
	attrs := []any{logging.AttrComponent, "emails", "method", c.Method(), "path", c.Path(), "duration_ms", time.Since(start).Milliseconds()}
	if err != nil {
		attrs = append(attrs, "code", status.Code(err).String())
	}
	slog.InfoContext(c.Context(), "emails request", attrs...)
}
