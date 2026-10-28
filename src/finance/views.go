package finance

import (
	"cmp"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"

	fin "github.com/ogen-app/harbor/src/repository/finance"
	"github.com/ogen-app/harbor/src/repository/ogenreceipts"
)

// ── Ledger ──────────────────────────────────────────────────────────────────

type LedgerRow struct {
	Key                  string   `json:"key"`
	Kind                 string   `json:"kind"` // ai_group | receipt | entry
	BookedDate           string   `json:"bookedDate"`
	VendorID             string   `json:"vendorId"`
	VendorName           string   `json:"vendorName"`
	Description          string   `json:"description"`
	Source               string   `json:"source"`
	Direction            string   `json:"direction"`
	AmountMicros         int64    `json:"amountMicros"`
	Currency             string   `json:"currency"`
	OriginalAmountMicros int64    `json:"originalAmountMicros"`
	FxRate               *float64 `json:"fxRate"`
	Entries              int      `json:"entries"`
	Expandable           bool     `json:"expandable"`
	ReceiptID            string   `json:"receiptId"`
	TenantID             string   `json:"tenantId"`
	TenantName           string   `json:"tenantName"`
	Model                string   `json:"model"`
	InvoiceNumber        string   `json:"invoiceNumber"`
	TestMode             bool     `json:"testMode"`
}

type LedgerPage struct {
	Rows       []LedgerRow `json:"rows"`
	NextCursor string      `json:"nextCursor"`
	Totals     struct {
		Rows         int   `json:"rows"`
		Entries      int   `json:"entries"`
		AmountMicros int64 `json:"amountMicros"`
	} `json:"totals"`
	PendingAttention PendingAmount `json:"pendingAttention"`
}

// LedgerFilter is fin.LedgerFilter without the billing mode, which the
// service fills in so the Ledger agrees with the P&L.
type LedgerFilter = fin.LedgerFilter

// Ledger returns one page of grouped Ledger rows. tenantNames resolves tenant
// ids to names (may be nil).
func (s *Service) Ledger(ctx context.Context, f LedgerFilter, cursor string, limit int, tenantNames map[string]string) (LedgerPage, error) {
	var out LedgerPage
	out.Rows = []LedgerRow{}
	testMode, _, err := s.revenueMode(ctx)
	if err != nil {
		return out, err
	}
	f.TestMode = testMode
	cur, err := decodeCursor(cursor)
	if err != nil {
		return out, &ErrInvalid{Msg: "bad cursor"}
	}
	groups, err := s.repo.LedgerPage(ctx, f, cur, limit+1)
	if err != nil {
		return out, err
	}
	if len(groups) > limit {
		groups = groups[:limit]
		last := groups[len(groups)-1]
		out.NextCursor = encodeCursor(last.BookedDate, last.Key)
	}
	names, err := s.vendorNames(ctx)
	if err != nil {
		return out, err
	}
	for _, g := range groups {
		out.Rows = append(out.Rows, ledgerRow(g, names, tenantNames))
	}
	t, err := s.repo.LedgerTotals(ctx, f)
	if err != nil {
		return out, err
	}
	out.Totals.Rows, out.Totals.Entries, out.Totals.AmountMicros = t.Rows, t.Entries, t.USDMicros

	open, err := s.repo.ReceiptsByStatus(ctx, fin.StatusNeedsAttention)
	if err != nil {
		return out, err
	}
	for i := range open {
		out.PendingAttention.Count++
		if v := receiptUSD(&open[i]); v != nil {
			out.PendingAttention.AmountMicros += *v
		}
	}
	return out, nil
}

func ledgerRow(g fin.LedgerGroup, vendors, tenants map[string]string) LedgerRow {
	kind, _, _ := strings.Cut(g.Key, ":")
	r := LedgerRow{
		Key:                  g.Key,
		Kind:                 map[string]string{"ai": "ai_group", "reading": "ai_group", "receipt": "receipt", "entry": "entry"}[kind],
		BookedDate:           g.BookedDate.Format(time.DateOnly),
		VendorID:             g.VendorID,
		VendorName:           cmp.Or(vendors[g.VendorID], g.VendorID),
		Description:          g.Description,
		Source:               g.Source,
		Direction:            g.Direction,
		AmountMicros:         g.USDMicros,
		Currency:             g.Currency,
		OriginalAmountMicros: g.OrigMicros,
		FxRate:               g.FxRate,
		Entries:              g.Entries,
		ReceiptID:            g.ReceiptID,
		InvoiceNumber:        g.InvoiceNumber,
		TestMode:             g.TestMode,
	}
	switch {
	case kind == "reading":
		// What reading forwarded receipts cost that day (a fraction of a cent each).
		r.Expandable = g.Entries > 1
		r.Description = "Receipt reading · " + plural(g.Entries, "receipt", "receipts")
		if g.Entries > 1 {
			r.ReceiptID = ""
		}
	case r.Kind == "ai_group":
		r.Expandable = true
		r.Description = fmt.Sprintf("AI usage · %s · %s", plural(g.Models, "model", "models"), plural(g.Tenants, "tenant", "tenants"))
	case r.Kind == "receipt":
		r.Expandable = g.Entries > 1
		if g.Entries > 1 {
			r.Description = fmt.Sprintf("Invoice %s · %d lines", cmp.Or(g.InvoiceNumber, "without a number"), g.Entries)
		}
	default:
		r.TenantID, r.Model = g.TenantID, g.Model
		r.TenantName = tenants[g.TenantID]
	}
	return r
}

type LedgerChild struct {
	ID           string `json:"id"`
	Description  string `json:"description"`
	Model        string `json:"model"`
	TenantID     string `json:"tenantId"`
	TenantName   string `json:"tenantName"`
	AmountMicros int64  `json:"amountMicros"`
	Direction    string `json:"direction"`
}

// LedgerChildren lists one grouped row's entries under the same filter.
func (s *Service) LedgerChildren(ctx context.Context, f LedgerFilter, key string, tenantNames map[string]string) ([]LedgerChild, error) {
	testMode, _, err := s.revenueMode(ctx)
	if err != nil {
		return nil, err
	}
	f.TestMode = testMode
	entries, err := s.repo.LedgerChildren(ctx, f, key)
	if err != nil {
		return nil, err
	}
	out := make([]LedgerChild, 0, len(entries))
	for _, e := range entries {
		c := LedgerChild{ID: e.ID, Description: e.Description, AmountMicros: e.AmountUSDMicros, Direction: e.Direction}
		if e.Model != nil {
			c.Model = *e.Model
		}
		if e.TenantID != nil {
			c.TenantID = *e.TenantID
			c.TenantName = tenantNames[c.TenantID]
		}
		out = append(out, c)
	}
	return out, nil
}

func encodeCursor(d time.Time, key string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(d.Format(time.DateOnly) + "|" + key))
}

func decodeCursor(s string) (*fin.LedgerCursor, error) {
	if s == "" {
		return nil, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, err
	}
	date, key, ok := strings.Cut(string(raw), "|")
	if !ok {
		return nil, fmt.Errorf("bad cursor")
	}
	d, err := time.Parse(time.DateOnly, date)
	if err != nil {
		return nil, err
	}
	return &fin.LedgerCursor{BookedDate: d, Key: key}, nil
}

func (s *Service) vendorNames(ctx context.Context) (map[string]string, error) {
	vendors, err := s.repo.ListVendors(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(vendors))
	for _, v := range vendors {
		out[v.ID] = v.Name
	}
	return out, nil
}

// ── Receipt detail ──────────────────────────────────────────────────────────

type ReceiptView struct {
	ID                 string      `json:"id"`
	Status             string      `json:"status"`
	VendorID           string      `json:"vendorId"`
	VendorName         string      `json:"vendorName"`
	MerchantName       string      `json:"merchantName"`
	InvoiceNumber      string      `json:"invoiceNumber"`
	Kind               string      `json:"kind"`
	IssueDate          *string     `json:"issueDate"`
	ServicePeriodStart *string     `json:"servicePeriodStart"`
	ServicePeriodEnd   *string     `json:"servicePeriodEnd"`
	BookedMonth        string      `json:"bookedMonth"`
	BookingReason      string      `json:"bookingReason"`
	Currency           string      `json:"currency"`
	SubtotalMicros     *int64      `json:"subtotalMicros"`
	TaxMicros          *int64      `json:"taxMicros"`
	TotalMicros        *int64      `json:"totalMicros"`
	FxRate             *float64    `json:"fxRate"`
	SuggestedFxRate    *float64    `json:"suggestedFxRate"`
	TotalUSDMicros     *int64      `json:"totalUsdMicros"`
	Lines              []fin.Line  `json:"lines"`
	Checks             []fin.Check `json:"checks"`
	AttentionReason    string      `json:"attentionReason"`
	AttentionDetail    string      `json:"attentionDetail"`
	RejectedReason     string      `json:"rejectedReason"`
	Edited             bool        `json:"edited"`
	ReceivedAt         time.Time   `json:"receivedAt"`
	ForwardedBy        string      `json:"forwardedBy"`
	From               string      `json:"from"`
	Subject            string      `json:"subject"`
	RejectedAt         *time.Time  `json:"rejectedAt"`
	PurgeAt            *time.Time  `json:"purgeAt"`
	VoidedAt           *time.Time  `json:"voidedAt"`
}

type EmailView struct {
	ID            string     `json:"id"`
	Subject       string     `json:"subject"`
	From          string     `json:"from"`
	ForwardedFrom string     `json:"forwardedFrom"`
	To            []string   `json:"to"`
	Date          *time.Time `json:"date"`
	MessageID     string     `json:"messageId"`
	TextBody      string     `json:"textBody"`
	HTMLBody      string     `json:"htmlBody"`
	ReceivedAt    time.Time  `json:"receivedAt"`
}

type AttachmentView struct {
	ID          string `json:"id"`
	Filename    string `json:"filename"`
	ContentType string `json:"contentType"`
	SizeBytes   int64  `json:"sizeBytes"`
	Stored      bool   `json:"stored"`
}

type ExtractionView struct {
	ID              string    `json:"id"`
	Version         int       `json:"version"`
	ModelID         string    `json:"modelId"`
	PromptVersion   string    `json:"promptVersion"`
	InputTokens     int64     `json:"inputTokens"`
	OutputTokens    int64     `json:"outputTokens"`
	CostMicros      int64     `json:"costMicros"`
	CreatedAt       time.Time `json:"createdAt"`
	ConfidenceNotes string    `json:"confidenceNotes"`
	Current         bool      `json:"current"`
}

type EntryView struct {
	ID           string     `json:"id"`
	Description  string     `json:"description"`
	Direction    string     `json:"direction"`
	AmountMicros int64      `json:"amountMicros"`
	BookedDate   string     `json:"bookedDate"`
	VoidedAt     *time.Time `json:"voidedAt"`
}

type HistoryView struct {
	At      time.Time `json:"at"`
	Actor   string    `json:"actor"`
	Action  string    `json:"action"`
	Summary string    `json:"summary"`
}

type ReceiptDetail struct {
	Receipt     ReceiptView      `json:"receipt"`
	Email       *EmailView       `json:"email"`
	Attachments []AttachmentView `json:"attachments"`
	Extractions []ExtractionView `json:"extractions"`
	Entries     []EntryView      `json:"entries"`
	History     []HistoryView    `json:"history"`
}

// ReceiptView builds the API view of a receipt (with its email headers when
// email is non-nil).
func (s *Service) ReceiptView(ctx context.Context, rc *fin.Receipt, email *fin.InboundEmail) (ReceiptView, error) {
	names, err := s.vendorNames(ctx)
	if err != nil {
		return ReceiptView{}, err
	}
	v := ReceiptView{
		ID:              rc.ID,
		Status:          rc.Status,
		MerchantName:    rc.MerchantName,
		InvoiceNumber:   rc.InvoiceNumber,
		Kind:            rc.Kind,
		BookedMonth:     receiptMonth(rc),
		BookingReason:   bookingReason(rc),
		Currency:        rc.Currency,
		SubtotalMicros:  rc.SubtotalMicros,
		TaxMicros:       rc.TaxMicros,
		TotalMicros:     rc.TotalMicros,
		FxRate:          rc.FxRate,
		TotalUSDMicros:  receiptUSD(rc),
		Lines:           cmpSlice(rc.Lines),
		Checks:          cmpSlice(rc.Checks),
		AttentionReason: rc.AttentionReason,
		RejectedReason:  rc.RejectedReason,
		Edited:          rc.Edited,
		ReceivedAt:      rc.CreatedAt,
		RejectedAt:      rc.RejectedAt,
		VoidedAt:        rc.VoidedAt,
	}
	if rc.VendorID != nil {
		v.VendorID = *rc.VendorID
		v.VendorName = cmp.Or(names[*rc.VendorID], *rc.VendorID)
	}
	v.IssueDate, v.ServicePeriodStart, v.ServicePeriodEnd = dateStr(rc.IssueDate), dateStr(rc.ServicePeriodStart), dateStr(rc.ServicePeriodEnd)
	for _, c := range rc.Checks {
		if !c.OK && c.Key == rc.AttentionReason {
			v.AttentionDetail = c.Detail
		}
	}
	if rc.RejectedAt != nil {
		v.PurgeAt = new(rc.RejectedAt.Add(RestoreWindow))
	}
	if c := strings.ToUpper(rc.Currency); c != "" && c != "USD" {
		if v.SuggestedFxRate, err = s.repo.LastFxRate(ctx, c); err != nil {
			return v, err
		}
	}
	if email != nil {
		v.ReceivedAt = email.ReceivedAt
		v.ForwardedBy = EmailAddress(email.FromAddr)
		v.From = cmp.Or(email.ForwardedFrom, email.FromAddr)
		v.Subject = email.Subject
	}
	return v, nil
}

// ReceiptDetail is everything the receipt drawer shows.
func (s *Service) ReceiptDetail(ctx context.Context, id string) (ReceiptDetail, error) {
	var out ReceiptDetail
	rc, err := s.repo.GetReceipt(ctx, id, false)
	if err != nil {
		return out, err
	}
	var email *fin.InboundEmail
	if rc.EmailID != nil {
		if email, err = s.repo.GetEmail(ctx, *rc.EmailID); err != nil && !IsNotFound(err) {
			return out, err
		}
	}
	if out.Receipt, err = s.ReceiptView(ctx, rc, email); err != nil {
		return out, err
	}
	out.Attachments, out.Extractions = []AttachmentView{}, []ExtractionView{}
	if email != nil {
		out.Email = &EmailView{
			ID: email.ID, Subject: email.Subject, From: email.FromAddr, ForwardedFrom: email.ForwardedFrom,
			To: email.ToAddrs, Date: email.EmailDate, MessageID: email.MessageID,
			TextBody: string(email.TextBody), HTMLBody: string(email.HTMLBody), ReceivedAt: email.ReceivedAt,
		}
		atts, err := s.repo.ListAttachments(ctx, email.ID)
		if err != nil {
			return out, err
		}
		for _, a := range atts {
			out.Attachments = append(out.Attachments, AttachmentView{ID: a.ID, Filename: a.Filename, ContentType: a.ContentType, SizeBytes: a.SizeBytes, Stored: a.Stored})
		}
		xs, err := s.repo.ListExtractions(ctx, email.ID)
		if err != nil {
			return out, err
		}
		for _, x := range xs {
			var ext ogenreceipts.Extraction
			_ = json.Unmarshal(x.Extraction, &ext)
			out.Extractions = append(out.Extractions, ExtractionView{
				ID: x.ID, Version: x.Version, ModelID: x.ModelID, PromptVersion: x.PromptVersion,
				InputTokens: x.InputTokens, OutputTokens: x.OutputTokens, CostMicros: x.CostMicros,
				CreatedAt: x.CreatedAt, ConfidenceNotes: ext.ConfidenceNotes,
				Current: rc.CurrentExtractionID != nil && *rc.CurrentExtractionID == x.ID,
			})
		}
	}
	entries, err := s.repo.ReceiptEntries(ctx, rc.ID)
	if err != nil {
		return out, err
	}
	out.Entries = []EntryView{}
	for _, e := range entries {
		if e.Source != fin.SourceReceipt {
			continue // the reading cost shows with its extraction version
		}
		out.Entries = append(out.Entries, EntryView{ID: e.ID, Description: e.Description, Direction: e.Direction,
			AmountMicros: e.AmountUSDMicros, BookedDate: e.BookedDate.Format(time.DateOnly), VoidedAt: e.VoidedAt})
	}
	audit, err := s.repo.AuditFor(ctx, "receipt", rc.ID)
	if err != nil {
		return out, err
	}
	out.History = []HistoryView{}
	for _, a := range audit {
		out.History = append(out.History, HistoryView{At: a.CreatedAt, Actor: a.Actor, Action: a.Action, Summary: historySummary(a)})
	}
	return out, nil
}

func historySummary(a fin.AuditEntry) string {
	var eff Effect
	if len(a.Effect) > 0 {
		_ = json.Unmarshal(a.Effect, &eff)
	}
	var after struct {
		Status          string `json:"status"`
		AttentionReason string `json:"attentionReason"`
		RejectedReason  string `json:"rejectedReason"`
	}
	_ = json.Unmarshal(a.After, &after)
	switch a.Action {
	case "ingest":
		switch after.Status {
		case fin.StatusParsed:
			return "Read automatically and posted"
		case fin.StatusRejected:
			return "Received and rejected: " + after.RejectedReason
		default:
			return "Received; needs attention (" + reasonLabel(after.AttentionReason) + ")"
		}
	case "edit":
		return "Edited. " + eff.Summary
	case "approve":
		return "Approved. " + eff.Summary
	case "reject":
		return "Ignored → Rejected"
	case "restore":
		return "Restored to Needs attention"
	case "void":
		return "Voided. " + eff.Summary
	case "reextract":
		return "Re-extracted. " + eff.Summary
	}
	return a.Action
}

// ── Needs attention ─────────────────────────────────────────────────────────

type AttentionItem struct {
	Kind           string     `json:"kind"` // receipt | email
	ID             string     `json:"id"`
	ReceivedAt     time.Time  `json:"receivedAt"`
	Subject        string     `json:"subject"`
	From           string     `json:"from"`
	TotalMicros    *int64     `json:"totalMicros"`
	Currency       string     `json:"currency"`
	Reason         string     `json:"reason"`
	ReasonLabel    string     `json:"reasonLabel"`
	Detail         string     `json:"detail"`
	NextStep       string     `json:"nextStep"`
	RejectedReason string     `json:"rejectedReason"`
	PurgeAt        *time.Time `json:"purgeAt"`
}

type Attention struct {
	Open     []AttentionItem `json:"open"`
	Rejected []AttentionItem `json:"rejected"`
}

func (s *Service) Attention(ctx context.Context) (Attention, error) {
	out := Attention{Open: []AttentionItem{}, Rejected: []AttentionItem{}}
	open, err := s.repo.ReceiptsByStatus(ctx, fin.StatusNeedsAttention)
	if err != nil {
		return out, err
	}
	rejected, err := s.repo.ReceiptsByStatus(ctx, fin.StatusRejected)
	if err != nil {
		return out, err
	}
	var ids []string
	for _, rc := range append(open, rejected...) {
		if rc.EmailID != nil {
			ids = append(ids, *rc.EmailID)
		}
	}
	emails, err := s.repo.EmailsByIDs(ctx, ids)
	if err != nil {
		return out, err
	}
	item := func(rc *fin.Receipt) AttentionItem {
		it := AttentionItem{Kind: "receipt", ID: rc.ID, ReceivedAt: rc.CreatedAt, TotalMicros: rc.TotalMicros,
			Currency: rc.Currency, Reason: rc.AttentionReason, ReasonLabel: reasonLabel(rc.AttentionReason),
			NextStep: nextStep(rc.AttentionReason), RejectedReason: rc.RejectedReason}
		for _, c := range rc.Checks {
			if !c.OK && c.Key == rc.AttentionReason {
				it.Detail = c.Detail
			}
		}
		if rc.EmailID != nil {
			if e, ok := emails[*rc.EmailID]; ok {
				it.ReceivedAt, it.Subject, it.From = e.ReceivedAt, e.Subject, cmp.Or(e.ForwardedFrom, e.FromAddr)
			}
		}
		if it.Subject == "" {
			it.Subject = strings.TrimSpace(rc.MerchantName + " " + rc.InvoiceNumber)
		}
		if rc.RejectedAt != nil {
			it.PurgeAt = new(rc.RejectedAt.Add(RestoreWindow))
		}
		return it
	}
	for i := range open {
		out.Open = append(out.Open, item(&open[i]))
	}
	for i := range rejected {
		out.Rejected = append(out.Rejected, item(&rejected[i]))
	}

	failed, err := s.repo.FailedEmails(ctx)
	if err != nil {
		return out, err
	}
	for _, e := range failed {
		out.Open = append(out.Open, AttentionItem{Kind: "email", ID: e.ID, ReceivedAt: e.ReceivedAt,
			Subject: cmp.Or(e.Subject, "Email "+e.ResendEmailID), From: cmp.Or(e.ForwardedFrom, e.FromAddr),
			Reason: "fetch_failed", ReasonLabel: reasonLabel("fetch_failed"), Detail: e.LastError, NextStep: nextStep("fetch_failed")})
	}
	sortNewest(out.Open)
	return out, nil
}

func sortNewest(items []AttentionItem) {
	slices.SortStableFunc(items, func(a, b AttentionItem) int { return b.ReceivedAt.Compare(a.ReceivedAt) })
}

func reasonLabel(key string) string {
	return cmp.Or(map[string]string{
		CheckVendor:    "Unknown vendor",
		CheckDuplicate: "Duplicate invoice",
		CheckAmount:    "Total missing",
		CheckDate:      "Invoice date missing",
		CheckCurrency:  "Currency needs a rate",
		CheckTotals:    "Totals don't add up",
		CheckLines:     "Line items don't add up",
		"fetch_failed": "Couldn't fetch the email",
	}[key], key)
}

func nextStep(key string) string {
	return map[string]string{
		CheckVendor:    "Match it to a vendor, or add one",
		CheckDuplicate: "Fix the invoice number, or ignore it",
		CheckAmount:    "Enter the total from the email",
		CheckDate:      "Enter the invoice date from the email",
		CheckCurrency:  "Set the currency and its USD rate",
		CheckTotals:    "Correct the amounts next to the email",
		CheckLines:     "Correct the line items next to the email",
		"fetch_failed": "Retry, or ignore it",
	}[key]
}

func dateStr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	return new(t.Format(time.DateOnly))
}

func cmpSlice[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
