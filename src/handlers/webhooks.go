package handlers

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"strings"

	"github.com/gofiber/fiber/v2"

	"github.com/ogen-app/harbor/src/logging"
	"github.com/ogen-app/harbor/src/repository/harbor"
)

// OperatorNotifier asks Ogen to send the admin_tenant_registered notification to
// the given operator recipients and returns how many sends were enqueued.
// *ogenemail.Client satisfies it; a nil interface means the surface is
// unconfigured (the handler reports it unavailable).
type OperatorNotifier interface {
	NotifyOperatorsTenantRegistered(ctx context.Context, tenantID string, recipients []string) (int, error)
}

// WebhooksHandler serves Ogen's inbound service-to-service webhooks. Unlike the
// operator-facing handlers these routes carry no Google session (Ogen calls them
// machine-to-machine), so they authenticate with a shared HMAC signature instead
// of requireAuth (CON-229).
type WebhooksHandler struct {
	email         OperatorNotifier
	users         harbor.UserRepository
	allowedEmails []string
	secret        string
}

// NewWebhooksHandler builds the webhook handler. email is the ogen EmailAdmin
// notifier (nil ⇒ the surface reports unavailable); users + allowedEmails resolve
// the operator recipient set; secret verifies Ogen's signature (empty ⇒ skip).
func NewWebhooksHandler(email OperatorNotifier, users harbor.UserRepository, allowedEmails []string, secret string) *WebhooksHandler {
	return &WebhooksHandler{email: email, users: users, allowedEmails: allowedEmails, secret: strings.TrimSpace(secret)}
}

// Register mounts the webhook routes. They are PUBLIC (no requireAuth): Ogen has
// no operator session, so authenticity is proven by the HMAC signature instead.
func (h *WebhooksHandler) Register(app *fiber.App) {
	app.Post("/api/webhooks/tenant-registered", h.TenantRegistered)
}

type tenantRegisteredPayload struct {
	Event    string `json:"event"`
	TenantID string `json:"tenant_id"`
}

// TenantRegistered handles Ogen's "a new tenant registered" webhook (CON-229):
// verify the signature, resolve the full operator recipient set, and ask Ogen to
// send the admin_tenant_registered notification to each. Transient failures
// return 5xx so Ogen's durable River job retries; the send is idempotent per
// (tenant, recipient), so a retry never double-sends.
func (h *WebhooksHandler) TenantRegistered(c *fiber.Ctx) error {
	body := c.Body()
	// This endpoint is public (Ogen has no operator session), so the HMAC
	// signature is the ONLY gate — fail closed. An unconfigured secret rejects
	// with 503 (rather than silently accepting unsigned requests); Ogen keeps the
	// webhook job and retries once the secret is set on both sides.
	if h.secret == "" {
		slog.ErrorContext(c.Context(), "tenant-registered webhook: OGEN_WEBHOOK_SECRET not configured; rejecting", logging.AttrComponent, "webhooks")
		return fiber.NewError(fiber.StatusServiceUnavailable, "webhook authentication unavailable")
	}
	if !validHMAC(h.secret, body, c.Get("X-Ogen-Signature")) {
		slog.WarnContext(c.Context(), "tenant-registered webhook: bad signature", logging.AttrComponent, "webhooks")
		return fiber.NewError(fiber.StatusUnauthorized, "invalid signature")
	}

	var payload tenantRegisteredPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid body")
	}
	tenantID := strings.TrimSpace(payload.TenantID)
	if tenantID == "" {
		return fiber.NewError(fiber.StatusBadRequest, "tenant_id is required")
	}
	if h.email == nil {
		// The gRPC surface is unconfigured — 503 so Ogen retries once it's reachable.
		return fiber.NewError(fiber.StatusServiceUnavailable, "email service unavailable")
	}

	recipients, err := h.resolveRecipients(c.Context())
	if err != nil {
		// A transient recipient-lookup failure must not silently drop the notice
		// (Ogen wouldn't retry a 2xx): 5xx so the webhook job retries. The send is
		// idempotent per (tenant, recipient), so the retry never double-sends.
		slog.WarnContext(c.Context(), "tenant-registered webhook: resolve recipients failed", logging.AttrComponent, "webhooks", "tenant_id", tenantID, logging.AttrError, err)
		return fiber.NewError(fiber.StatusServiceUnavailable, "recipient lookup failed")
	}
	if len(recipients) == 0 {
		// No operators to notify — accept (200) so Ogen doesn't retry a no-op.
		slog.InfoContext(c.Context(), "tenant-registered webhook: no recipients", logging.AttrComponent, "webhooks", "tenant_id", tenantID)
		return c.JSON(fiber.Map{"enqueued": 0})
	}

	enqueued, err := h.email.NotifyOperatorsTenantRegistered(c.Context(), tenantID, recipients)
	if err != nil {
		slog.WarnContext(c.Context(), "tenant-registered webhook: notify failed", logging.AttrComponent, "webhooks", "tenant_id", tenantID, logging.AttrError, err)
		// Reuse the emails handler's gRPC→HTTP mapping; a 5xx tells Ogen to retry.
		return mapEmailError(err)
	}
	slog.InfoContext(c.Context(), "tenant-registered webhook: notified operators", logging.AttrComponent, "webhooks", "tenant_id", tenantID, "recipients", len(recipients), "enqueued", enqueued)
	return c.JSON(fiber.Map{"enqueued": enqueued})
}

// resolveRecipients is the full operator set: the AUTH_ALLOWED_EMAILS allowlist
// (authoritative — includes operators who never signed in) unioned with the
// users table (real signed-in operators), de-duplicated case-insensitively. A
// users-table read failure is returned to the caller (→ 5xx → Ogen retries)
// rather than swallowed, so users-table-only recipients are never silently
// dropped on a transient DB blip.
func (h *WebhooksHandler) resolveRecipients(ctx context.Context) ([]string, error) {
	seen := make(map[string]struct{})
	var out []string
	add := func(e string) {
		e = strings.ToLower(strings.TrimSpace(e))
		if e == "" {
			return
		}
		if _, dup := seen[e]; dup {
			return
		}
		seen[e] = struct{}{}
		out = append(out, e)
	}
	for _, e := range h.allowedEmails {
		add(e)
	}
	if h.users != nil {
		users, err := h.users.List(ctx)
		if err != nil {
			return nil, err
		}
		for i := range users {
			add(users[i].Email)
		}
	}
	return out, nil
}

// validHMAC constant-time verifies an "sha256=<hex>" signature over body. It
// mirrors the signing in Ogen's notify_harbor_tenant_registered worker.
func validHMAC(secret string, body []byte, header string) bool {
	want := strings.TrimPrefix(strings.TrimSpace(header), "sha256=")
	if want == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	got := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(got), []byte(want))
}
