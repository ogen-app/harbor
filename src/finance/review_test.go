package finance

import (
	"testing"
	"time"
)

// After an outage longer than the trailing window, the next pass re-reads
// from the last covered day, so usage in the gap still lands.
func TestMaterialiseRecoversAfterOutage(t *testing.T) {
	h := newHarness(t)
	ctx := t.Context()
	h.now = time.Now().UTC()
	today := dateOnly(h.now)
	if err := h.svc.MaterialiseAIUsage(ctx); err != nil { // first pass: nothing yet
		t.Fatal(err)
	}
	// Pretend the last success was 10 days ago; usage arrived 7 days ago.
	if _, err := h.db.Exec(`UPDATE finance_sync_state SET last_success_at = ?, through_date = ? WHERE key = ?`,
		today.AddDate(0, 0, -10), today.AddDate(0, 0, -10), SyncAIUsage); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Exec(`INSERT INTO vendor_usage_events VALUES (?, 't1', 'anthropic', 'claude-sonnet-5', 777)`,
		today.AddDate(0, 0, -7).Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.MaterialiseAIUsage(ctx); err != nil {
		t.Fatal(err)
	}
	if _, sum := ledgerSum(t, h.db, "source = 'token_pipeline'"); sum != 777 {
		t.Fatalf("usage in the outage gap = %d, want 777", sum)
	}
}

// The seeded Google vendor matches AI billing only: any other Google invoice
// would otherwise become prepaid credit and drop out of expenses.
func TestSeededGoogleMatchesAIBillingOnly(t *testing.T) {
	h := newHarness(t)
	vendors, err := h.svc.repo.ListVendors(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ merchant, sender, want string }{
		{"Google Cloud EMEA Limited", "payments-noreply@google.com", "google"},
		{"Gemini API", "", "google"},
		{"Google Workspace", "payments-noreply@google.com", ""},
		{"Google Ads", "ads-noreply@google.com", ""},
	} {
		got := ""
		if v := MatchVendor(vendors, tc.merchant, tc.sender); v != nil {
			got = v.ID
		}
		if got != tc.want {
			t.Errorf("%q from %q matched %q, want %q", tc.merchant, tc.sender, got, tc.want)
		}
	}
}
