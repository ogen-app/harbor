package handlers

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"

	"github.com/ogen-app/harbor/src/finance"
	"github.com/ogen-app/harbor/src/logging"
	fin "github.com/ogen-app/harbor/src/repository/finance"
)

// TenantNamer resolves tenant ids to names for the Ledger. ogen.TenantRepository
// satisfies it; a failure only leaves names blank.
type TenantNamer interface {
	TenantNames(ctx context.Context) (map[string]string, error)
}

// PnLHandler is the REST surface of the Profit & loss page (CON-420): status,
// the summary strip, the monthly P&L, the Ledger, the receipt drawer and the
// Needs attention actions. Every number comes from the finance ledger through
// one aggregation, and every mutation is audited and returns its effect.
type PnLHandler struct {
	svc      *finance.Service
	tenants  TenantNamer
	operator OperatorLookup
}

func NewPnLHandler(svc *finance.Service, tenants TenantNamer, operator OperatorLookup) *PnLHandler {
	return &PnLHandler{svc: svc, tenants: tenants, operator: operator}
}

func (h *PnLHandler) Register(app *fiber.App, requireAuth fiber.Handler) {
	app.Get("/api/pnl/status", requireAuth, h.Status)
	app.Get("/api/pnl/summary", requireAuth, h.Summary)
	app.Get("/api/pnl/monthly", requireAuth, h.Monthly)
	app.Get("/api/pnl/daily", requireAuth, h.Daily)
	app.Get("/api/pnl/ledger", requireAuth, h.Ledger)
	app.Get("/api/pnl/ledger/children", requireAuth, h.LedgerChildren)
	app.Get("/api/pnl/attention", requireAuth, h.Attention)
	app.Get("/api/pnl/vendors", requireAuth, h.Vendors)
	app.Post("/api/pnl/vendors", requireAuth, h.CreateVendor)
	app.Get("/api/pnl/receipts/:id", requireAuth, uuidParams, h.Receipt)
	app.Get("/api/pnl/receipts/:id/attachments/:attId", requireAuth, uuidParams, h.Attachment)
	app.Patch("/api/pnl/receipts/:id", requireAuth, uuidParams, h.UpdateReceipt)
	app.Post("/api/pnl/receipts/:id/approve", requireAuth, uuidParams, h.receiptAction("approve"))
	app.Post("/api/pnl/receipts/:id/reject", requireAuth, uuidParams, h.receiptAction("reject"))
	app.Post("/api/pnl/receipts/:id/restore", requireAuth, uuidParams, h.receiptAction("restore"))
	app.Post("/api/pnl/receipts/:id/void", requireAuth, uuidParams, h.receiptAction("void"))
	app.Post("/api/pnl/receipts/:id/reextract", requireAuth, uuidParams, h.receiptAction("reextract"))
	app.Post("/api/pnl/emails/:id/retry", requireAuth, uuidParams, h.emailAction("retry"))
	app.Post("/api/pnl/emails/:id/ignore", requireAuth, uuidParams, h.emailAction("ignore"))
}

// uuidParams answers 404 for a malformed :id or :attId. Receipt, email and
// attachment ids are UUID columns, so a bad one would otherwise fail in
// Postgres and surface as a 500.
func uuidParams(c *fiber.Ctx) error {
	for _, name := range []string{"id", "attId"} {
		if v := c.Params(name); v != "" {
			if _, err := uuid.Parse(v); err != nil {
				return fiber.NewError(fiber.StatusNotFound, "not found")
			}
		}
	}
	return c.Next()
}

// Status godoc
// @Summary  Data freshness, inbox and attention counts for the P&L header
// @Tags     pnl
// @Produce  json
// @Success  200  {object}  finance.Status
// @Router   /api/pnl/status [get]
func (h *PnLHandler) Status(c *fiber.Ctx) error {
	st, err := h.svc.Status(c.Context())
	if err != nil {
		return pnlError(c, "status", err)
	}
	return c.JSON(st)
}

// Summary godoc
// @Summary  Month to date vs the same days of last month
// @Tags     pnl
// @Produce  json
// @Success  200  {object}  finance.Summary
// @Router   /api/pnl/summary [get]
func (h *PnLHandler) Summary(c *fiber.Ctx) error {
	s, err := h.svc.Summary(c.Context())
	if err != nil {
		return pnlError(c, "summary", err)
	}
	return c.JSON(s)
}

// Monthly godoc
// @Summary  The monthly P&L table for whole UTC months
// @Tags     pnl
// @Produce  json
// @Param    from  query  string  false  "First month, YYYY-MM (default: five months ago)"
// @Param    to    query  string  false  "Last month, YYYY-MM (default: this month)"
// @Success  200   {object}  finance.Monthly
// @Router   /api/pnl/monthly [get]
func (h *PnLHandler) Monthly(c *fiber.Ctx) error {
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
		return fiber.NewError(fiber.StatusBadRequest, fmt.Sprintf("at most %d months", finance.MaxMonths))
	}
	m, err := h.svc.Monthly(c.Context(), from, to)
	if err != nil {
		return pnlError(c, "monthly", err)
	}
	return c.JSON(m)
}

// Daily godoc
// @Summary  One UTC month day by day: net revenue, expenses by vendor and receipts
// @Tags     pnl
// @Produce  json
// @Param    month  query  string  false  "Month, YYYY-MM (default: this month)"
// @Success  200    {object}  finance.Daily
// @Router   /api/pnl/daily [get]
func (h *PnLHandler) Daily(c *fiber.Ctx) error {
	now := time.Now().UTC()
	month, err := parseMonth(c.Query("month"), time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC))
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "month is YYYY-MM")
	}
	d, err := h.svc.Daily(c.Context(), month)
	if err != nil {
		return pnlError(c, "daily", err)
	}
	return c.JSON(d)
}

func parseMonth(s string, def time.Time) (time.Time, error) {
	if s == "" {
		return def, nil
	}
	return time.Parse("2006-01", s)
}

const (
	ledgerDefaultLimit = 50
	ledgerMaxLimit     = 200
)

// Ledger godoc
// @Summary  Grouped ledger rows with smart-filter fields and keyset pagination
// @Tags     pnl
// @Produce  json
// @Param    from    query  string  false  "First booked date, YYYY-MM-DD (default: start of this month)"
// @Param    to      query  string  false  "Last booked date, YYYY-MM-DD (default: today)"
// @Param    cursor  query  string  false  "Opaque cursor from a prior page"
// @Param    limit   query  int     false  "Rows per page (1-200, default 50)"
// @Success  200     {object}  finance.LedgerPage
// @Router   /api/pnl/ledger [get]
func (h *PnLHandler) Ledger(c *fiber.Ctx) error {
	f, err := ledgerFilter(c)
	if err != nil {
		return err
	}
	limit := c.QueryInt("limit", ledgerDefaultLimit)
	if limit < 1 || limit > ledgerMaxLimit {
		limit = ledgerDefaultLimit
	}
	page, err := h.svc.Ledger(c.Context(), f, c.Query("cursor"), limit, h.tenantNames(c.Context()))
	if err != nil {
		return pnlError(c, "ledger", err)
	}
	return c.JSON(page)
}

// LedgerChildren godoc
// @Summary  The entries of one grouped Ledger row (same filters as the Ledger)
// @Tags     pnl
// @Produce  json
// @Param    key  query  string  true  "The row key"
// @Router   /api/pnl/ledger/children [get]
func (h *PnLHandler) LedgerChildren(c *fiber.Ctx) error {
	key := c.Query("key")
	if key == "" {
		return fiber.NewError(fiber.StatusBadRequest, "key is required")
	}
	f, err := ledgerFilter(c)
	if err != nil {
		return err
	}
	rows, err := h.svc.LedgerChildren(c.Context(), f, key, h.tenantNames(c.Context()))
	if err != nil {
		return pnlError(c, "ledger.children", err)
	}
	return c.JSON(fiber.Map{"rows": rows})
}

func (h *PnLHandler) tenantNames(ctx context.Context) map[string]string {
	if h.tenants == nil {
		return nil
	}
	names, err := h.tenants.TenantNames(ctx)
	if err != nil {
		slog.DebugContext(ctx, "pnl: tenant names unavailable", logging.AttrComponent, "pnl", logging.AttrError, err)
		return nil
	}
	return names
}

// ledgerFilter reads the Ledger's date range and smart-filter fields. List
// fields repeat (?vendor=a&vendor=b) and take a not_ prefix to negate.
func ledgerFilter(c *fiber.Ctx) (fin.LedgerFilter, error) {
	q, err := url.ParseQuery(string(c.Request().URI().QueryString()))
	if err != nil {
		return fin.LedgerFilter{}, fiber.NewError(fiber.StatusBadRequest, "bad query")
	}
	now := time.Now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	f := fin.LedgerFilter{
		From:       time.Date(today.Year(), today.Month(), 1, 0, 0, 0, 0, time.UTC),
		To:         today,
		Vendors:    q["vendor"],
		NotVendors: q["not_vendor"],
		Types:      q["type"],
		NotTypes:   q["not_type"],
		Sources:    q["source"],
		NotSources: q["not_source"],
		Tenants:    q["tenant"],
		Models:     q["model"],
		Invoice:    strings.TrimSpace(q.Get("invoice")),
		Query:      strings.TrimSpace(q.Get("q")),
	}
	for name, dst := range map[string]*time.Time{"from": &f.From, "to": &f.To} {
		if v := q.Get(name); v != "" {
			t, err := time.Parse(time.DateOnly, v)
			if err != nil {
				return f, fiber.NewError(fiber.StatusBadRequest, name+" is YYYY-MM-DD")
			}
			*dst = t
		}
	}
	for name, dst := range map[string]**int64{"amount_min": &f.AmountMin, "amount_max": &f.AmountMax} {
		if v := q.Get(name); v != "" {
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil {
				return f, fiber.NewError(fiber.StatusBadRequest, name+" is USD micros")
			}
			*dst = &n
		}
	}
	return f, nil
}

// Attention godoc
// @Summary  Receipts that failed a check, emails that could not be read, and the Rejected list
// @Tags     pnl
// @Produce  json
// @Success  200  {object}  finance.Attention
// @Router   /api/pnl/attention [get]
func (h *PnLHandler) Attention(c *fiber.Ctx) error {
	a, err := h.svc.Attention(c.Context())
	if err != nil {
		return pnlError(c, "attention", err)
	}
	return c.JSON(a)
}

type vendorView struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Category     string `json:"category"`
	IsAIPipeline bool   `json:"isAiPipeline"`
}

func viewVendor(v fin.Vendor) vendorView {
	return vendorView{ID: v.ID, Name: v.Name, Category: v.Category, IsAIPipeline: v.IsAIPipeline}
}

// Vendors godoc
// @Summary  The vendor catalog
// @Tags     pnl
// @Produce  json
// @Router   /api/pnl/vendors [get]
func (h *PnLHandler) Vendors(c *fiber.Ctx) error {
	vs, err := h.svc.Repo().ListVendors(c.Context())
	if err != nil {
		return pnlError(c, "vendors", err)
	}
	out := make([]vendorView, 0, len(vs))
	for _, v := range vs {
		out = append(out, viewVendor(v))
	}
	return c.JSON(fiber.Map{"vendors": out})
}

// CreateVendor godoc
// @Summary  Add a vendor (from Needs attention)
// @Tags     pnl
// @Accept   json
// @Produce  json
// @Router   /api/pnl/vendors [post]
func (h *PnLHandler) CreateVendor(c *fiber.Ctx) error {
	actor, err := h.operator(c)
	if err != nil {
		return err
	}
	var in finance.NewVendor
	if err := c.BodyParser(&in); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid body")
	}
	v, err := h.svc.CreateVendor(c.Context(), actor, in)
	if err != nil {
		return pnlError(c, "vendors.create", err)
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"vendor": viewVendor(*v)})
}

// Receipt godoc
// @Summary  One receipt with its email, extractions, entries and history
// @Tags     pnl
// @Produce  json
// @Success  200  {object}  finance.ReceiptDetail
// @Router   /api/pnl/receipts/{id} [get]
func (h *PnLHandler) Receipt(c *fiber.Ctx) error {
	d, err := h.svc.ReceiptDetail(c.Context(), c.Params("id"))
	if err != nil {
		return pnlError(c, "receipt", err)
	}
	return c.JSON(d)
}

// Attachment godoc
// @Summary  Download one stored attachment of a receipt's email
// @Tags     pnl
// @Router   /api/pnl/receipts/{id}/attachments/{attId} [get]
func (h *PnLHandler) Attachment(c *fiber.Ctx) error {
	repo := h.svc.Repo()
	rc, err := repo.GetReceipt(c.Context(), c.Params("id"), false)
	if err != nil {
		return pnlError(c, "attachment", err)
	}
	if rc.EmailID == nil {
		return fiber.NewError(fiber.StatusNotFound, "not found")
	}
	a, err := repo.GetAttachment(c.Context(), *rc.EmailID, c.Params("attId"))
	if err != nil {
		return pnlError(c, "attachment", err)
	}
	if a.Content == nil {
		return fiber.NewError(fiber.StatusNotFound, "this attachment was too large to keep")
	}
	// Always a download, never rendered in Harbor's origin.
	c.Set(fiber.HeaderContentType, "application/octet-stream")
	c.Set("X-Content-Type-Options", "nosniff")
	c.Set(fiber.HeaderContentDisposition, fmt.Sprintf("attachment; filename=%q", safeFilename(a.Filename)))
	return c.Send(a.Content)
}

func safeFilename(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == '"' || r == '\\' || r == '/' {
			return '_'
		}
		return r
	}, s)
	if s == "" {
		return "attachment"
	}
	return s
}

type receiptResponse struct {
	Receipt finance.ReceiptView `json:"receipt"`
	Effect  finance.Effect      `json:"effect"`
}

// UpdateReceipt godoc
// @Summary  Edit a receipt (Needs attention editor, or a posted receipt, which is re-posted)
// @Tags     pnl
// @Accept   json
// @Produce  json
// @Success  200  {object}  receiptResponse
// @Router   /api/pnl/receipts/{id} [patch]
func (h *PnLHandler) UpdateReceipt(c *fiber.Ctx) error {
	actor, err := h.operator(c)
	if err != nil {
		return err
	}
	var ed finance.ReceiptEdit
	if err := c.BodyParser(&ed); err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "invalid body")
	}
	rc, eff, err := h.svc.UpdateReceipt(c.Context(), actor, c.Params("id"), ed)
	if err != nil {
		return pnlError(c, "receipt.update", err)
	}
	return h.receiptResult(c, rc, eff)
}

// receiptAction serves approve, reject, restore, void and reextract. reject and
// void take an optional {reason}.
func (h *PnLHandler) receiptAction(action string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		actor, err := h.operator(c)
		if err != nil {
			return err
		}
		var body struct {
			Reason string `json:"reason"`
		}
		if len(c.Body()) > 0 {
			if err := c.BodyParser(&body); err != nil {
				return fiber.NewError(fiber.StatusBadRequest, "invalid body")
			}
		}
		id := c.Params("id")
		ctx := c.Context()
		var (
			rc  *fin.Receipt
			eff finance.Effect
		)
		switch action {
		case "approve":
			rc, eff, err = h.svc.ApproveReceipt(ctx, actor, id)
		case "reject":
			rc, eff, err = h.svc.RejectReceipt(ctx, actor, id, body.Reason)
		case "restore":
			rc, eff, err = h.svc.RestoreReceipt(ctx, actor, id)
		case "void":
			rc, eff, err = h.svc.VoidReceipt(ctx, actor, id, body.Reason)
		case "reextract":
			rc, eff, err = h.svc.ReextractReceipt(ctx, actor, id)
		}
		if err != nil {
			return pnlError(c, "receipt."+action, err)
		}
		return h.receiptResult(c, rc, eff)
	}
}

func (h *PnLHandler) receiptResult(c *fiber.Ctx, rc *fin.Receipt, eff finance.Effect) error {
	var email *fin.InboundEmail
	if rc.EmailID != nil {
		email, _ = h.svc.Repo().GetEmail(c.Context(), *rc.EmailID)
	}
	view, err := h.svc.ReceiptView(c.Context(), rc, email)
	if err != nil {
		return pnlError(c, "receipt.view", err)
	}
	return c.JSON(receiptResponse{Receipt: view, Effect: eff})
}

func (h *PnLHandler) emailAction(action string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		actor, err := h.operator(c)
		if err != nil {
			return err
		}
		if action == "retry" {
			err = h.svc.RetryEmail(c.Context(), actor, c.Params("id"))
		} else {
			err = h.svc.IgnoreEmail(c.Context(), actor, c.Params("id"))
		}
		if err != nil {
			return pnlError(c, "email."+action, err)
		}
		return c.JSON(fiber.Map{"ok": true})
	}
}

// pnlError maps finance errors to HTTP: missing → 404, a state conflict → 409,
// a bad edit → 400, failing checks → 422 with the checks, and an Ogen call
// that failed → 502. Anything else is a 500.
func pnlError(c *fiber.Ctx, section string, err error) error {
	if finance.IsNotFound(err) {
		return fiber.NewError(fiber.StatusNotFound, "not found")
	}
	if e, ok := errors.AsType[*finance.ErrConflict](err); ok {
		return fiber.NewError(fiber.StatusConflict, e.Msg)
	}
	if e, ok := errors.AsType[*finance.ErrInvalid](err); ok {
		return fiber.NewError(fiber.StatusBadRequest, e.Msg)
	}
	if e, ok := errors.AsType[*finance.ChecksFailed](err); ok {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"error": e.Error(), "checks": e.Checks})
	}
	if section == "receipt.reextract" {
		slog.WarnContext(c.Context(), "pnl: re-extract failed", logging.AttrComponent, "pnl", logging.AttrError, err)
		return fiber.NewError(fiber.StatusBadGateway, "the receipt could not be read again: "+err.Error())
	}
	return fmt.Errorf("pnl %s: %w", section, err)
}
