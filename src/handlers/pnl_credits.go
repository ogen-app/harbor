package handlers

import (
	"time"

	"github.com/gofiber/fiber/v2"

	"github.com/ogen-app/harbor/src/finance"
)

// registerCredits adds the AI credits tab: balances and runway, the
// Estimated vs charged table, the Review actions and the settings.
func (h *PnLHandler) registerCredits(app *fiber.App, requireAuth fiber.Handler) {
	app.Get("/api/pnl/credits", requireAuth, h.Credits)
	app.Put("/api/pnl/credits/accounts/:vendor", requireAuth, h.SetCreditAccount)
	app.Get("/api/pnl/reconciliation", requireAuth, h.Reconciliation)
	app.Get("/api/pnl/reconciliation/:vendor/:month", requireAuth, h.ReconciliationDetail)
	app.Post("/api/pnl/reconciliation/:vendor/:month/accept", requireAuth, h.reconAction("accept"))
	app.Post("/api/pnl/reconciliation/:vendor/:month/dismiss", requireAuth, h.reconAction("dismiss"))
	app.Post("/api/pnl/reconciliation/:vendor/:month/manual", requireAuth, h.reconAction("manual"))
	app.Get("/api/pnl/settings", requireAuth, h.Settings)
	app.Put("/api/pnl/settings", requireAuth, h.SetSettings)
}

// Credits godoc
// @Summary  AI credit balances, runway, low-balance alerts and the balance chart
// @Tags     pnl
// @Produce  json
// @Success  200  {object}  finance.Credits
// @Router   /api/pnl/credits [get]
func (h *PnLHandler) Credits(c *fiber.Ctx) error {
	out, err := h.svc.Credits(c.Context())
	if err != nil {
		return pnlError(c, "credits", err)
	}
	return c.JSON(out)
}

// SetCreditAccount godoc
// @Summary  Set an AI vendor's opening balance and date, and its alert days
// @Tags     pnl
// @Accept   json
// @Produce  json
// @Param    vendor  path  string                      true  "AI vendor id (anthropic, google)"
// @Param    body    body  finance.CreditAccountEdit   true  "Fields to change"
// @Success  200     {object}  finance.CreditVendor
// @Router   /api/pnl/credits/accounts/{vendor} [put]
func (h *PnLHandler) SetCreditAccount(c *fiber.Ctx) error {
	actor, err := h.operator(c)
	if err != nil {
		return err
	}
	var ed finance.CreditAccountEdit
	if err := c.BodyParser(&ed); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid body")
	}
	out, err := h.svc.SetCreditAccount(c.Context(), actor, c.Params("vendor"), ed)
	if err != nil {
		return pnlError(c, "credits.account", err)
	}
	return c.JSON(out)
}

// Reconciliation godoc
// @Summary  Estimated vs charged, one row per AI vendor per month, newest first
// @Tags     pnl
// @Produce  json
// @Param    from  query  string  false  "First month, YYYY-MM (default: five months before to)"
// @Param    to    query  string  false  "Last month, YYYY-MM (default: this month)"
// @Success  200   {object}  finance.Reconciliation
// @Router   /api/pnl/reconciliation [get]
func (h *PnLHandler) Reconciliation(c *fiber.Ctx) error {
	now := time.Now().UTC()
	thisMonth := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	to, err := parseMonth(c.Query("to"), thisMonth)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "to is YYYY-MM")
	}
	from, err := parseMonth(c.Query("from"), to.AddDate(0, -5, 0))
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "from is YYYY-MM")
	}
	if from.After(to) {
		return fiber.NewError(fiber.StatusBadRequest, "from is after to")
	}
	if from.AddDate(0, finance.MaxMonths-1, 0).Before(to) {
		return fiber.NewError(fiber.StatusBadRequest, "at most 36 months")
	}
	out, err := h.svc.Reconciliation(c.Context(), from, to)
	if err != nil {
		return pnlError(c, "reconciliation", err)
	}
	return c.JSON(out)
}

func reconMonth(c *fiber.Ctx) (time.Time, error) {
	m, err := time.Parse("2006-01", c.Params("month"))
	if err != nil {
		return time.Time{}, fiber.NewError(fiber.StatusNotFound, "not found")
	}
	return m, nil
}

// ReconciliationDetail godoc
// @Summary  One AI vendor-month for the Review drawer: daily and per-model estimate vs charge, and its audit trail
// @Tags     pnl
// @Produce  json
// @Param    vendor  path  string  true  "AI vendor id"
// @Param    month   path  string  true  "Month, YYYY-MM"
// @Success  200     {object}  finance.ReconDetail
// @Router   /api/pnl/reconciliation/{vendor}/{month} [get]
func (h *PnLHandler) ReconciliationDetail(c *fiber.Ctx) error {
	month, err := reconMonth(c)
	if err != nil {
		return err
	}
	out, err := h.svc.ReconciliationDetail(c.Context(), c.Params("vendor"), month)
	if err != nil {
		return pnlError(c, "reconciliation.detail", err)
	}
	return c.JSON(out)
}

type reconActionBody struct {
	// Reason is required by dismiss.
	Reason string `json:"reason"`
	// ChargedMicros and Note are read by manual.
	ChargedMicros *int64 `json:"chargedMicros"`
	Note          string `json:"note"`
}

type reconActionResponse struct {
	Effect finance.Effect      `json:"effect"`
	Detail finance.ReconDetail `json:"detail"`
}

// reconAction godoc
// @Summary  Accept a charge waiting for review, keep the estimate (dismiss, with a reason), or enter a charge by hand (manual)
// @Tags     pnl
// @Accept   json
// @Produce  json
// @Param    vendor  path  string           true  "AI vendor id"
// @Param    month   path  string           true  "Month, YYYY-MM"
// @Param    body    body  reconActionBody  false "dismiss: {reason}; manual: {chargedMicros, note}"
// @Success  200     {object}  reconActionResponse
// @Router   /api/pnl/reconciliation/{vendor}/{month}/accept [post]
// @Router   /api/pnl/reconciliation/{vendor}/{month}/dismiss [post]
// @Router   /api/pnl/reconciliation/{vendor}/{month}/manual [post]
func (h *PnLHandler) reconAction(action string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		actor, err := h.operator(c)
		if err != nil {
			return err
		}
		month, err := reconMonth(c)
		if err != nil {
			return err
		}
		var body reconActionBody
		if len(c.Body()) > 0 {
			if err := c.BodyParser(&body); err != nil {
				return fiber.NewError(fiber.StatusBadRequest, "invalid body")
			}
		}
		vendor := c.Params("vendor")
		ctx := c.Context()
		var eff finance.Effect
		switch action {
		case "accept":
			eff, err = h.svc.AcceptCharge(ctx, actor, vendor, month)
		case "dismiss":
			eff, err = h.svc.DismissCharge(ctx, actor, vendor, month, body.Reason)
		case "manual":
			eff, err = h.svc.EnterManualCharge(ctx, actor, vendor, month, finance.ManualCharge{ChargedMicros: body.ChargedMicros, Note: body.Note})
		}
		if err != nil {
			return pnlError(c, "reconciliation."+action, err)
		}
		detail, err := h.svc.ReconciliationDetail(ctx, vendor, month)
		if err != nil {
			return pnlError(c, "reconciliation.detail", err)
		}
		return c.JSON(reconActionResponse{Effect: eff, Detail: detail})
	}
}

// Settings godoc
// @Summary  Global finance settings (the reconciliation threshold)
// @Tags     pnl
// @Produce  json
// @Success  200  {object}  finance.FinanceSettings
// @Router   /api/pnl/settings [get]
func (h *PnLHandler) Settings(c *fiber.Ctx) error {
	out, err := h.svc.Settings(c.Context())
	if err != nil {
		return pnlError(c, "settings", err)
	}
	return c.JSON(out)
}

// SetSettings godoc
// @Summary  Change global finance settings; audited, and closed months are re-reconciled
// @Tags     pnl
// @Accept   json
// @Produce  json
// @Param    body  body  finance.SettingsEdit  true  "Fields to change"
// @Success  200   {object}  finance.FinanceSettings
// @Router   /api/pnl/settings [put]
func (h *PnLHandler) SetSettings(c *fiber.Ctx) error {
	actor, err := h.operator(c)
	if err != nil {
		return err
	}
	var ed finance.SettingsEdit
	if err := c.BodyParser(&ed); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid body")
	}
	out, err := h.svc.SetSettings(c.Context(), actor, ed)
	if err != nil {
		return pnlError(c, "settings.update", err)
	}
	return c.JSON(out)
}
