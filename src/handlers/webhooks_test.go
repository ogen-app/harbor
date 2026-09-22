package handlers

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"

	"github.com/ogen-app/harbor/src/models"
	"github.com/ogen-app/harbor/src/repository/ogenemail"
)

const testWebhookSecret = "shh"

// fakeNotifier records the notify call and returns a canned result.
type fakeNotifier struct {
	gotTenantID   string
	gotRecipients []string
	enqueued      int
	err           error
	calls         int
}

func (f *fakeNotifier) NotifyOperatorsTenantRegistered(_ context.Context, tenantID string, recipients []string) (int, error) {
	f.calls++
	f.gotTenantID = tenantID
	f.gotRecipients = recipients
	if f.err != nil {
		return 0, f.err
	}
	return f.enqueued, nil
}

// erroringUserRepo implements harbor.UserRepository but fails List, to exercise
// the recipient-lookup-failure path. The other methods are unused here.
type erroringUserRepo struct{}

func (erroringUserRepo) GetByID(context.Context, string) (*models.User, error) {
	return nil, errors.New("unused")
}
func (erroringUserRepo) GetByEmail(context.Context, string) (*models.User, error) {
	return nil, errors.New("unused")
}
func (erroringUserRepo) List(context.Context) ([]models.User, error) {
	return nil, errors.New("db down")
}
func (erroringUserRepo) Upsert(context.Context, *models.User) error { return errors.New("unused") }

func sign(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func postWebhook(t *testing.T, app *fiber.App, body []byte, sig string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest("POST", "/api/webhooks/tenant-registered", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	if sig != "" {
		req.Header.Set("X-Ogen-Signature", sig)
	}
	resp, err := app.Test(req)
	if err != nil {
		t.Fatalf("app.Test: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return resp.StatusCode, out
}

func newWebhookApp(h *WebhooksHandler) *fiber.App {
	app := fiber.New()
	h.Register(app)
	return app
}

func TestWebhookTenantRegistered_HappyPath(t *testing.T) {
	users := newFakeUserRepo()
	_ = users.Upsert(context.Background(), &models.User{ID: "u1", Email: "Dev@Ogen.app", GoogleSub: "g1"})
	notifier := &fakeNotifier{enqueued: 2}
	h := NewWebhooksHandler(notifier, users, []string{"ops@ogen.app", " ops@ogen.app "}, testWebhookSecret)
	app := newWebhookApp(h)

	body, _ := json.Marshal(map[string]string{"event": "tenant.registered", "tenant_id": "tn-1"})
	code, out := postWebhook(t, app, body, sign(testWebhookSecret, body))
	if code != fiber.StatusOK {
		t.Fatalf("status: got %d want 200 (%v)", code, out)
	}
	if notifier.calls != 1 || notifier.gotTenantID != "tn-1" {
		t.Fatalf("notify not called correctly: calls=%d tenant=%q", notifier.calls, notifier.gotTenantID)
	}
	// allowlist ("ops@ogen.app", duplicate) ∪ users ("Dev@Ogen.app"), deduped + lowered.
	got := strings.Join(notifier.gotRecipients, ",")
	if len(notifier.gotRecipients) != 2 || !strings.Contains(got, "ops@ogen.app") || !strings.Contains(got, "dev@ogen.app") {
		t.Fatalf("recipients not resolved/deduped/lowered: %v", notifier.gotRecipients)
	}
}

func TestWebhookTenantRegistered_BadSignature(t *testing.T) {
	notifier := &fakeNotifier{enqueued: 1}
	h := NewWebhooksHandler(notifier, newFakeUserRepo(), []string{"ops@ogen.app"}, testWebhookSecret)
	app := newWebhookApp(h)

	body, _ := json.Marshal(map[string]string{"tenant_id": "tn-1"})
	code, _ := postWebhook(t, app, body, "sha256=deadbeef") // wrong signature
	if code != fiber.StatusUnauthorized {
		t.Fatalf("status: got %d want 401", code)
	}
	if notifier.calls != 0 {
		t.Fatal("notify must not run on a bad signature")
	}
}

func TestWebhookTenantRegistered_MissingSignatureHeader(t *testing.T) {
	notifier := &fakeNotifier{enqueued: 1}
	h := NewWebhooksHandler(notifier, newFakeUserRepo(), []string{"ops@ogen.app"}, testWebhookSecret)
	app := newWebhookApp(h)

	body, _ := json.Marshal(map[string]string{"tenant_id": "tn-1"})
	code, _ := postWebhook(t, app, body, "") // no signature header at all
	if code != fiber.StatusUnauthorized {
		t.Fatalf("status: got %d want 401", code)
	}
	if notifier.calls != 0 {
		t.Fatal("notify must not run without a signature")
	}
}

func TestWebhookTenantRegistered_NoSecretFailsClosed(t *testing.T) {
	// A public endpoint with no secret configured must reject (503), not skip auth.
	notifier := &fakeNotifier{enqueued: 1}
	h := NewWebhooksHandler(notifier, newFakeUserRepo(), []string{"ops@ogen.app"}, "") // no secret
	app := newWebhookApp(h)

	body, _ := json.Marshal(map[string]string{"tenant_id": "tn-1"})
	code, _ := postWebhook(t, app, body, "")
	if code != fiber.StatusServiceUnavailable {
		t.Fatalf("status: got %d want 503", code)
	}
	if notifier.calls != 0 {
		t.Fatal("notify must not run when the webhook secret is unset")
	}
}

func TestWebhookTenantRegistered_NoRecipientsIsNoOp(t *testing.T) {
	notifier := &fakeNotifier{enqueued: 5}
	h := NewWebhooksHandler(notifier, newFakeUserRepo(), []string{"", "  "}, testWebhookSecret) // no real recipients
	app := newWebhookApp(h)

	body, _ := json.Marshal(map[string]string{"tenant_id": "tn-1"})
	code, out := postWebhook(t, app, body, sign(testWebhookSecret, body))
	if code != fiber.StatusOK {
		t.Fatalf("status: got %d want 200", code)
	}
	if notifier.calls != 0 {
		t.Fatal("notify must not run when there are no recipients")
	}
	if out["enqueued"] != float64(0) {
		t.Fatalf("enqueued: got %v want 0", out["enqueued"])
	}
}

func TestWebhookTenantRegistered_MissingTenantID(t *testing.T) {
	h := NewWebhooksHandler(&fakeNotifier{}, newFakeUserRepo(), []string{"ops@ogen.app"}, testWebhookSecret)
	app := newWebhookApp(h)

	body, _ := json.Marshal(map[string]string{"event": "tenant.registered"})
	code, _ := postWebhook(t, app, body, sign(testWebhookSecret, body))
	if code != fiber.StatusBadRequest {
		t.Fatalf("status: got %d want 400", code)
	}
}

func TestWebhookTenantRegistered_RecipientLookupFails(t *testing.T) {
	// A users-table read failure must 5xx (so Ogen retries), not silently drop
	// users-table recipients by proceeding with the allowlist alone.
	notifier := &fakeNotifier{enqueued: 1}
	h := NewWebhooksHandler(notifier, erroringUserRepo{}, []string{"ops@ogen.app"}, testWebhookSecret)
	app := newWebhookApp(h)

	body, _ := json.Marshal(map[string]string{"tenant_id": "tn-1"})
	code, _ := postWebhook(t, app, body, sign(testWebhookSecret, body))
	if code != fiber.StatusServiceUnavailable {
		t.Fatalf("status: got %d want 503", code)
	}
	if notifier.calls != 0 {
		t.Fatal("notify must not run when recipient resolution failed")
	}
}

func TestWebhookTenantRegistered_Unavailable(t *testing.T) {
	// The notifier surfaces ErrUnavailable → 503 so Ogen retries.
	notifier := &fakeNotifier{err: ogenemail.ErrUnavailable}
	h := NewWebhooksHandler(notifier, newFakeUserRepo(), []string{"ops@ogen.app"}, testWebhookSecret)
	app := newWebhookApp(h)

	body, _ := json.Marshal(map[string]string{"tenant_id": "tn-1"})
	code, _ := postWebhook(t, app, body, sign(testWebhookSecret, body))
	if code != fiber.StatusServiceUnavailable {
		t.Fatalf("status: got %d want 503", code)
	}
	if notifier.calls != 1 {
		t.Fatalf("notify calls: got %d want 1", notifier.calls)
	}
}
