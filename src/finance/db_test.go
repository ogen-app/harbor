package finance

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/uptrace/bun"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/ogen-app/harbor/src/database"
	"github.com/ogen-app/harbor/src/repository/analytics"
	fin "github.com/ogen-app/harbor/src/repository/finance"
	"github.com/ogen-app/harbor/src/repository/ogenbilling"
	"github.com/ogen-app/harbor/src/repository/ogenreceipts"
)

// testDB creates a fresh database on HARBOR_TEST_DSN's server, migrates it and
// adds a plain vendor_usage_events table standing in for Ogen's analytics
// hypertable. Tests skip when the variable is unset, e.g.
//
//	HARBOR_TEST_DSN=postgres://harbor:harbor@localhost:55432/harbor?sslmode=disable go test ./src/finance/
func testDB(t *testing.T) *bun.DB {
	t.Helper()
	dsn := os.Getenv("HARBOR_TEST_DSN")
	if dsn == "" {
		t.Skip("HARBOR_TEST_DSN not set")
	}
	admin, err := database.New(dsn, false)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	name := "finance_test_" + hex.EncodeToString(b)
	if _, err := admin.Exec("CREATE DATABASE " + name); err != nil {
		t.Fatalf("create database: %v", err)
	}
	u, _ := url.Parse(dsn)
	u.Path = "/" + name
	db, err := database.New(u.String(), false)
	if err != nil {
		t.Fatalf("connect test db: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
		_, _ = admin.Exec("DROP DATABASE IF EXISTS " + name + " WITH (FORCE)")
		_ = admin.Close()
	})
	if err := database.Migrate(context.Background(), db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE vendor_usage_events (
		occurred_at TIMESTAMPTZ NOT NULL, tenant_id TEXT, vendor TEXT NOT NULL DEFAULT '',
		model TEXT NOT NULL DEFAULT '', cost_micros BIGINT NOT NULL)`); err != nil {
		t.Fatalf("create usage table: %v", err)
	}
	return db
}

// ── fakes ───────────────────────────────────────────────────────────────────

type fakeProcessor struct {
	byID  map[string]ogenreceipts.Result
	raw   ogenreceipts.Result // returned for ProcessRawMIME
	calls int
}

func (f *fakeProcessor) ProcessByResendID(_ context.Context, id string) (ogenreceipts.Result, error) {
	f.calls++
	r, ok := f.byID[id]
	if !ok {
		return ogenreceipts.Result{}, status.Error(codes.NotFound, "no such email")
	}
	return r, nil
}

func (f *fakeProcessor) ProcessRawMIME(context.Context, []byte) (ogenreceipts.Result, error) {
	f.calls++
	return f.raw, nil
}

type fakePayments struct {
	testMode bool
	payments []ogenbilling.Payment
	err      error
}

func (f *fakePayments) Settings(context.Context) (ogenbilling.Settings, error) {
	if f.err != nil {
		return ogenbilling.Settings{}, f.err
	}
	return ogenbilling.Settings{Provider: "lemonsqueezy", TestMode: f.testMode, Configured: true}, nil
}

func (f *fakePayments) ListPayments(_ context.Context, _, _ time.Time, testMode bool, _ int32, _ string) (ogenbilling.PaymentPage, error) {
	if f.err != nil {
		return ogenbilling.PaymentPage{}, f.err
	}
	var out ogenbilling.PaymentPage
	for _, p := range f.payments {
		if p.TestMode == testMode {
			out.Payments = append(out.Payments, p)
		}
	}
	return out, nil
}

type operatorSet map[string]bool

func (o operatorSet) IsOperator(_ context.Context, email string) (bool, error) { return o[email], nil }

type harness struct {
	db       *bun.DB
	svc      *Service
	proc     *fakeProcessor
	payments *fakePayments
	spend    analytics.SpendRepository
	now      time.Time
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	db := testDB(t)
	h := &harness{
		db:       db,
		proc:     &fakeProcessor{byID: map[string]ogenreceipts.Result{}},
		payments: &fakePayments{},
		spend:    analytics.NewSpendRepository(db),
		now:      time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC),
	}
	h.svc = New(fin.New(db), h.proc, h.payments, h.spend, operatorSet{"ops@ogen.app": true}, "receipts@inbound.test")
	h.svc.now = func() time.Time { return h.now }
	return h
}

// receive delivers a receipt.received event and runs the receipt job once.
func (h *harness) receive(t *testing.T, resendID string, res ogenreceipts.Result) {
	t.Helper()
	h.proc.byID[resendID] = res
	if _, err := h.svc.RecordReceiptEvent(t.Context(), resendID); err != nil {
		t.Fatalf("record: %v", err)
	}
	if err := h.svc.ProcessDueEmails(t.Context()); err != nil {
		t.Fatalf("process: %v", err)
	}
}

func micros(dollars float64) *int64 { return new(int64(dollars * 1_000_000)) }

// railwayReceipt is a well-formed forwarded Stripe receipt: four lines that
// add up, no tax.
func railwayReceipt(invoice string) ogenreceipts.Result {
	return ogenreceipts.Result{
		RawMIME: []byte("From: ops@ogen.app\r\nSubject: Fwd: Your receipt from Railway\r\n\r\nbody"),
		Headers: ogenreceipts.Headers{
			From: "Ops <ops@ogen.app>", Subject: "Fwd: Your receipt from Railway #" + invoice,
			ForwardedFrom: "Railway <invoice+statements@railway.app>",
		},
		HTMLBody: "<p>Receipt</p>",
		Attachments: []ogenreceipts.Attachment{
			{Filename: "invoice.pdf", ContentType: "application/pdf", Content: []byte("%PDF-1.4")},
		},
		Extraction: ogenreceipts.Extraction{
			Kind: "receipt", MerchantName: "Railway Corporation", DocumentNumber: invoice,
			IssueDate: "2026-10-01", ServicePeriodStart: "2026-09-01", ServicePeriodEnd: "2026-09-30",
			Currency: "usd", SubtotalMicros: micros(86.18), TaxMicros: micros(0), TotalMicros: micros(86.18),
			LineItems: []ogenreceipts.LineItem{
				{Description: "Hobby plan", AmountMicros: micros(5)},
				{Description: "Compute, vCPU", AmountMicros: micros(41.2)},
				{Description: "Compute, memory", AmountMicros: micros(36.5)},
				{Description: "Network egress", AmountMicros: micros(3.48)},
			},
		},
		Usage: ogenreceipts.Usage{ModelID: "claude-haiku-5-5", PromptVersion: "receipt-v1", InputTokens: 3000, OutputTokens: 400, CostMicros: 4_200},
	}
}
