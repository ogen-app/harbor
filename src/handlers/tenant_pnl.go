package handlers

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/ogen-app/harbor/src/finance"
	"github.com/ogen-app/harbor/src/logging"
	"github.com/ogen-app/harbor/src/repository/ogenbilling"
)

// PlanSource is the billing.v1 surface the Tenant P&L tab reads for its plan
// line: the tenant's subscriptions and the price each one is mapped to.
// *ogenbilling.Client satisfies it (a nil client returns ErrUnavailable).
type PlanSource interface {
	TenantBilling(ctx context.Context, tenantID string) (ogenbilling.TenantBilling, error)
	VariantMappings(ctx context.Context, testMode bool) (ogenbilling.VariantMappingList, error)
}

// planLookupTimeout bounds the best-effort plan line so a slow billing service
// never holds up the P&L.
const planLookupTimeout = 3 * time.Second

// tenantPlan is the price the tenant subscribes at ("Pro plan, $49.00 a month").
type tenantPlan struct {
	TierName string `json:"tierName"`
	NetMinor int64  `json:"netMinor"` // excluding tax
	Currency string `json:"currency"`
	Interval string `json:"interval"` // month | year
	Status   string `json:"status"`   // Lemon Squeezy vocabulary
}

type tenantPnLResponse struct {
	finance.TenantPnL
	// Plan is nil when the tenant has no subscription in this billing mode, or
	// billing could not be read; the tab then falls back to the tier name.
	Plan *tenantPlan `json:"plan"`
}

// TenantPnL godoc
// @Summary  One tenant's P&L: revenue minus measured AI cost, per month
// @Tags     pnl
// @Produce  json
// @Param    id    path   string  true   "Tenant id"
// @Param    from  query  string  false  "First month, YYYY-MM (default: five months ago)"
// @Param    to    query  string  false  "Last month, YYYY-MM (default: this month)"
// @Success  200   {object}  tenantPnLResponse
// @Router   /api/tenants/{id}/pnl [get]
func (h *PnLHandler) TenantPnL(c *fiber.Ctx) error {
	from, to, err := monthRange(c)
	if err != nil {
		return err
	}
	tenantID := c.Params("id")
	p, err := h.svc.TenantPnL(c.Context(), tenantID, from, to)
	if err != nil {
		return pnlError(c, "tenant", err)
	}
	return c.JSON(tenantPnLResponse{TenantPnL: p, Plan: h.tenantPlan(c.Context(), tenantID, p.TestMode)})
}

// monthRange reads ?from=&to= (YYYY-MM): the last six months by default, at
// most MaxMonths.
func monthRange(c *fiber.Ctx) (time.Time, time.Time, error) {
	now := time.Now().UTC()
	thisMonth := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	to, err := parseMonth(c.Query("to"), thisMonth)
	if err != nil {
		return to, to, fiber.NewError(fiber.StatusBadRequest, "to is YYYY-MM")
	}
	from, err := parseMonth(c.Query("from"), to.AddDate(0, -5, 0))
	if err != nil {
		return from, to, fiber.NewError(fiber.StatusBadRequest, "from is YYYY-MM")
	}
	if from.After(to) {
		return from, to, fiber.NewError(fiber.StatusBadRequest, "from is after to")
	}
	if from.AddDate(0, finance.MaxMonths-1, 0).Before(to) {
		return from, to, fiber.NewError(fiber.StatusBadRequest, fmt.Sprintf("at most %d months", finance.MaxMonths))
	}
	return from, to, nil
}

// subscriptionRank orders a tenant's subscriptions for the plan line: the one
// it pays on first, then a trial, then one in trouble. Ended ones never show.
var subscriptionRank = map[string]int{"active": 0, "on_trial": 1, "past_due": 2, "unpaid": 3, "paused": 4}

// tenantPlan resolves the tenant's current subscription to its mapped price.
// Best effort: any failure only leaves the plan line out.
func (h *PnLHandler) tenantPlan(ctx context.Context, tenantID string, testMode bool) *tenantPlan {
	if h.plans == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, planLookupTimeout)
	defer cancel()
	warn := func(what string, err error) {
		slog.DebugContext(ctx, "pnl: plan line unavailable", logging.AttrComponent, "pnl", "step", what, logging.AttrError, err)
	}

	b, err := h.plans.TenantBilling(ctx, tenantID)
	if err != nil {
		warn("tenant_billing", err)
		return nil
	}
	subs := slices.DeleteFunc(slices.Clone(b.Subscriptions), func(s ogenbilling.Subscription) bool {
		_, live := subscriptionRank[s.Status]
		return !live || s.TestMode != testMode || s.TierVersionPriceID == "" || s.InvalidatedAt != nil
	})
	if len(subs) == 0 {
		return nil
	}
	sub := slices.MinFunc(subs, func(a, b ogenbilling.Subscription) int {
		return subscriptionRank[a.Status] - subscriptionRank[b.Status]
	})

	m, err := h.plans.VariantMappings(ctx, testMode)
	if err != nil {
		warn("variant_mappings", err)
		return nil
	}
	i := slices.IndexFunc(m.Mappings, func(v ogenbilling.VariantMapping) bool {
		return v.TierVersionPriceID == sub.TierVersionPriceID
	})
	if i < 0 {
		return nil
	}
	v := m.Mappings[i]
	return &tenantPlan{TierName: v.TierName, NetMinor: v.NetMinor, Currency: v.Currency, Interval: v.Interval, Status: sub.Status}
}
