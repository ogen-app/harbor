package handlers

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/gofiber/fiber/v2"
)

// fakeReceipts records receipt.received events, idempotent on the Resend id
// like the real ledger.
type fakeReceipts struct{ seen map[string]bool }

func (f *fakeReceipts) RecordReceiptEvent(_ context.Context, id string) (bool, error) {
	if f.seen == nil {
		f.seen = map[string]bool{}
	}
	created := !f.seen[id]
	f.seen[id] = true
	return created, nil
}

// receipt.received rides the same signed URL as tenant.registered (CON-420): it
// is recorded once, a redelivery is accepted as a duplicate, and the tenant
// notifier is never called.
func TestWebhookReceiptReceived(t *testing.T) {
	notifier := &fakeNotifier{}
	receipts := &fakeReceipts{}
	app := newWebhookApp(NewWebhooksHandler(notifier, receipts, newFakeUserRepo(), []string{"ops@ogen.app"}, testWebhookSecret))

	body, _ := json.Marshal(map[string]string{"event": "receipt.received", "resend_email_id": "re_1"})
	for i, wantDup := range []bool{false, true} {
		code, out := postWebhook(t, app, body, sign(testWebhookSecret, body))
		if code != fiber.StatusOK {
			t.Fatalf("delivery %d: status %d (%v)", i, code, out)
		}
		if out["duplicate"] != wantDup {
			t.Fatalf("delivery %d: duplicate = %v, want %v", i, out["duplicate"], wantDup)
		}
	}
	if notifier.calls != 0 {
		t.Fatalf("tenant notifier called %d times for a receipt event", notifier.calls)
	}

	// A bad signature never reaches the ledger.
	other, _ := json.Marshal(map[string]string{"event": "receipt.received", "resend_email_id": "re_2"})
	if code, _ := postWebhook(t, app, other, sign("wrong", other)); code != fiber.StatusUnauthorized {
		t.Fatalf("bad signature: status %d, want 401", code)
	}
	if receipts.seen["re_2"] {
		t.Fatal("unsigned receipt event was recorded")
	}
}

func TestWebhookReceiptReceivedValidation(t *testing.T) {
	app := newWebhookApp(NewWebhooksHandler(&fakeNotifier{}, nil, newFakeUserRepo(), nil, testWebhookSecret))
	for name, tc := range map[string]struct {
		payload map[string]string
		want    int
	}{
		"missing id":       {map[string]string{"event": "receipt.received"}, fiber.StatusBadRequest},
		"ledger not wired": {map[string]string{"event": "receipt.received", "resend_email_id": "re_1"}, fiber.StatusServiceUnavailable},
		"unknown event":    {map[string]string{"event": "something.else"}, fiber.StatusBadRequest},
	} {
		body, _ := json.Marshal(tc.payload)
		if code, out := postWebhook(t, app, body, sign(testWebhookSecret, body)); code != tc.want {
			t.Errorf("%s: status %d, want %d (%v)", name, code, tc.want, out)
		}
	}
}
