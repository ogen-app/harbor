package handlers

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"slices"
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

// ReceiptEvents records a forwarded vendor receipt for the finance ledger
// (CON-420). *finance.Service satisfies it; nil means the ledger is not wired.
type ReceiptEvents interface {
	RecordReceiptEvent(ctx context.Context, resendEmailID string) (created bool, err error)
}

// WebhooksHandler serves Ogen's inbound service-to-service webhooks. Unlike the
// operator-facing handlers these routes carry no Google session (Ogen calls them
// machine-to-machine), so they authenticate with a shared HMAC signature instead
// of requireAuth (CON-229).
type WebhooksHandler struct {
	email         OperatorNotifier
	receipts      ReceiptEvents
	users         harbor.UserRepository
	allowedEmails []string
	secret        string
}

// NewWebhooksHandler builds the webhook handler. email is the ogen EmailAdmin
// notifier (nil ⇒ the surface reports unavailable); receipts records
// receipt.received events (nil ⇒ unavailable); users + allowedEmails resolve the
// operator recipient set; secret verifies Ogen's signature (empty ⇒ reject).
func NewWebhooksHandler(email OperatorNotifier, receipts ReceiptEvents, users harbor.UserRepository, allowedEmails []string, secret string) *WebhooksHandler {
	return &WebhooksHandler{email: email, receipts: receipts, users: users, allowedEmails: allowedEmails, secret: strings.TrimSpace(secret)}
}

// Register mounts the webhook routes. They are PUBLIC (no requireAuth): Ogen has
// no operator session, so authenticity is proven by the HMAC signature instead.
// river-service posts every event to one HARBOR_WEBHOOK_URL, so both paths take
// every event and dispatch on its "event" field.
func (h *WebhooksHandler) Register(app *fiber.App) {
	app.Post("/api/webhooks/tenant-registered", h.Handle)
	app.Post("/api/webhooks/ogen", h.Handle)
}

// Webhook event names.
const (
	eventTenantRegistered = "tenant.registered"
	eventReceiptReceived  = "receipt.received"
)

type webhookPayload struct {
	Event         string `json:"event"`
	TenantID      string `json:"tenant_id"`
	ResendEmailID string `json:"resend_email_id"`
}

// Handle verifies Ogen's signature and dispatches on the event: a new tenant
// registered (CON-229), or a vendor receipt arrived at the inbox (CON-420). A
// payload without an event is a tenant registration, as before CON-420.
func (h *WebhooksHandler) Handle(c *fiber.Ctx) error {
	body := c.Body()
	// This endpoint is public (Ogen has no operator session), so the HMAC
	// signature is the ONLY gate — fail closed. An unconfigured secret rejects
	// with 503 (rather than silently accepting unsigned requests); Ogen keeps the
	// webhook job and retries once the secret is set on both sides.
	if h.secret == "" {
		slog.ErrorContext(c.Context(), "ogen webhook: OGEN_WEBHOOK_SECRET not configured; rejecting", logging.AttrComponent, "webhooks")
		return fiber.NewError(fiber.StatusServiceUnavailable, "webhook authentication unavailable")
	}
	if !validHMAC(h.secret, body, c.Get("X-Ogen-Signature")) {
		slog.WarnContext(c.Context(), "ogen webhook: bad signature", logging.AttrComponent, "webhooks")
		return fiber.NewError(fiber.StatusUnauthorized, "invalid signature")
	}

	var payload webhookPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid body")
	}
	switch strings.TrimSpace(payload.Event) {
	case eventTenantRegistered, "":
		return h.tenantRegistered(c, payload)
	case eventReceiptReceived:
		return h.receiptReceived(c, payload)
	default:
		// A final 4xx: river-service does not retry it.
		return fiber.NewError(fiber.StatusBadRequest, "unknown event")
	}
}

// receiptReceived records a forwarded receipt as pending, idempotent on the
// Resend id; the receipt job fetches and reads it. A redelivery is accepted and
// adds nothing (the webhook has no replay guard).
func (h *WebhooksHandler) receiptReceived(c *fiber.Ctx, payload webhookPayload) error {
	id := strings.TrimSpace(payload.ResendEmailID)
	if id == "" {
		return fiber.NewError(fiber.StatusBadRequest, "resend_email_id is required")
	}
	if h.receipts == nil {
		return fiber.NewError(fiber.StatusServiceUnavailable, "finance ledger unavailable")
	}
	created, err := h.receipts.RecordReceiptEvent(c.Context(), id)
	if err != nil {
		// 5xx so river-service retries; the insert is idempotent.
		slog.WarnContext(c.Context(), "receipt webhook: record failed", logging.AttrComponent, "webhooks", "resend_email_id", id, logging.AttrError, err)
		return fiber.NewError(fiber.StatusServiceUnavailable, "could not record the receipt")
	}
	slog.InfoContext(c.Context(), "receipt webhook: recorded", logging.AttrComponent, "webhooks", "resend_email_id", id, "duplicate", !created)
	return c.JSON(fiber.Map{"accepted": true, "duplicate": !created})
}

// tenantRegistered handles Ogen's "a new tenant registered" webhook (CON-229):
// resolve the full operator recipient set, and ask Ogen to send the
// admin_tenant_registered notification to each. Transient failures return 5xx
// so Ogen's durable River job retries; the send is idempotent per (tenant,
// recipient), so a retry never double-sends.
func (h *WebhooksHandler) tenantRegistered(c *fiber.Ctx, payload webhookPayload) error {
	tenantID := strings.TrimSpace(payload.TenantID)
	if tenantID == "" {
		return fiber.NewError(fiber.StatusBadRequest, "tenant_id is required")
	}
	if h.email == nil {
		// The gRPC surface is unconfigured — 503 so Ogen retries once it's reachable.
		return fiber.NewError(fiber.StatusServiceUnavailable, "email service unavailable")
	}

	recipients, err := ResolveOperators(c.Context(), h.allowedEmails, h.users)
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

// ResolveOperators is the full operator set: the AUTH_ALLOWED_EMAILS allowlist
// (authoritative — includes operators who never signed in) unioned with the
// users table (real signed-in operators), de-duplicated case-insensitively. A
// users-table read failure is returned to the caller (→ 5xx → Ogen retries)
// rather than swallowed, so users-table-only recipients are never silently
// dropped on a transient DB blip.
func ResolveOperators(ctx context.Context, allowedEmails []string, users harbor.UserRepository) ([]string, error) {
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
	for _, e := range allowedEmails {
		add(e)
	}
	if users != nil {
		list, err := users.List(ctx)
		if err != nil {
			return nil, err
		}
		for i := range list {
			add(list[i].Email)
		}
	}
	return out, nil
}

// OperatorDirectory answers "is this address a Harbor operator?" from the set
// ResolveOperators builds. The finance ledger accepts receipts forwarded only
// by operators (CON-420).
type OperatorDirectory struct {
	AllowedEmails []string
	Users         harbor.UserRepository
}

func (d OperatorDirectory) IsOperator(ctx context.Context, email string) (bool, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return false, nil
	}
	ops, err := ResolveOperators(ctx, d.AllowedEmails, d.Users)
	if err != nil {
		return false, err
	}
	return slices.Contains(ops, email), nil
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
