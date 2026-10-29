package handlers

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/ogen-app/harbor/src/repository/ogenbilling"
)

type fakePlans struct {
	billing  ogenbilling.TenantBilling
	mappings []ogenbilling.VariantMapping
	err      error
}

func (f *fakePlans) TenantBilling(context.Context, string) (ogenbilling.TenantBilling, error) {
	return f.billing, f.err
}

func (f *fakePlans) VariantMappings(_ context.Context, testMode bool) (ogenbilling.VariantMappingList, error) {
	return ogenbilling.VariantMappingList{TestMode: testMode, Mappings: f.mappings}, f.err
}

// The plan line follows the subscription the tenant pays on, in the report's
// billing mode, and is left out when nothing resolves.
func TestTenantPlan(t *testing.T) {
	plans := &fakePlans{
		billing: ogenbilling.TenantBilling{Subscriptions: []ogenbilling.Subscription{
			{Status: "expired", TierVersionPriceID: "old"},
			{Status: "on_trial", TierVersionPriceID: "trial"},
			{Status: "active", TierVersionPriceID: "pro-m"},
			{Status: "active", TierVersionPriceID: "test", TestMode: true},
			{Status: "active", TierVersionPriceID: "gone", InvalidatedAt: new(time.Now())},
		}},
		mappings: []ogenbilling.VariantMapping{
			{TierVersionPriceID: "trial", TierName: "Starter", NetMinor: 0, Currency: "USD", Interval: "month"},
			{TierVersionPriceID: "pro-m", TierName: "Pro", NetMinor: 4900, Currency: "USD", Interval: "month"},
		},
	}
	h := &PnLHandler{plans: plans}

	p := h.tenantPlan(t.Context(), "t1", false)
	if p == nil || p.TierName != "Pro" || p.NetMinor != 4900 || p.Interval != "month" || p.Status != "active" {
		t.Fatalf("plan = %+v", p)
	}
	if p := h.tenantPlan(t.Context(), "t1", true); p != nil {
		t.Errorf("test mode resolved to %+v with no mapping", p)
	}

	plans.billing.Subscriptions = plans.billing.Subscriptions[:2]
	if p := h.tenantPlan(t.Context(), "t1", false); p == nil || p.TierName != "Starter" {
		t.Errorf("trial plan = %+v", p)
	}
	plans.err = ogenbilling.ErrUnavailable
	if p := h.tenantPlan(t.Context(), "t1", false); p != nil {
		t.Errorf("billing down: plan = %+v", p)
	}
	if p := (&PnLHandler{}).tenantPlan(t.Context(), "t1", false); p != nil {
		t.Errorf("no billing client: plan = %+v", p)
	}
}

func TestMonthRange(t *testing.T) {
	app := fiber.New()
	app.Get("/", func(c *fiber.Ctx) error {
		if _, _, err := monthRange(c); err != nil {
			return err
		}
		return c.SendStatus(fiber.StatusOK)
	})
	for q, want := range map[string]int{
		"":                         fiber.StatusOK,
		"?from=2026-05&to=2026-10": fiber.StatusOK,
		"?from=2026-11&to=2026-10": fiber.StatusBadRequest,
		"?from=2023-01&to=2026-10": fiber.StatusBadRequest,
		"?from=2026-5":             fiber.StatusBadRequest,
		"?from=2026-05&to=October": fiber.StatusBadRequest,
	} {
		resp, err := app.Test(httptest.NewRequest("GET", "/"+q, nil))
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != want {
			t.Errorf("%q: status %d, want %d", q, resp.StatusCode, want)
		}
	}
}
