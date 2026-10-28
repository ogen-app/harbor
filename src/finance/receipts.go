package finance

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	fin "github.com/ogen-app/harbor/src/repository/finance"
)

// RestoreWindow is how long a rejected receipt is kept (and restorable).
const RestoreWindow = 30 * 24 * time.Hour

// ErrConflict is a request the receipt's state does not allow (wrong status, a
// duplicate invoice). The message says why.
type ErrConflict struct{ Msg string }

func (e *ErrConflict) Error() string { return e.Msg }

// ErrInvalid is a malformed edit.
type ErrInvalid struct{ Msg string }

func (e *ErrInvalid) Error() string { return e.Msg }

// ChecksFailed is returned when an action needs every check to pass.
type ChecksFailed struct{ Checks []fin.Check }

func (e *ChecksFailed) Error() string {
	var msgs []string
	for _, c := range e.Checks {
		if !c.OK {
			msgs = append(msgs, cmp.Or(c.Detail, c.Label))
		}
	}
	return "checks failed: " + strings.Join(msgs, "; ")
}

func conflict(format string, args ...any) error {
	return &ErrConflict{Msg: fmt.Sprintf(format, args...)}
}

// ReceiptEdit is a PATCH body. A nil field is left alone; Clear* empties a
// nullable field. Amounts are micros of the receipt currency.
type ReceiptEdit struct {
	VendorID           *string    `json:"vendorId"`
	InvoiceNumber      *string    `json:"invoiceNumber"`
	Kind               *string    `json:"kind"`
	IssueDate          *string    `json:"issueDate"`
	ServicePeriodStart *string    `json:"servicePeriodStart"`
	ServicePeriodEnd   *string    `json:"servicePeriodEnd"`
	Currency           *string    `json:"currency"`
	FxRate             *float64   `json:"fxRate"`
	SubtotalMicros     *int64     `json:"subtotalMicros"`
	TaxMicros          *int64     `json:"taxMicros"`
	TotalMicros        *int64     `json:"totalMicros"`
	Lines              []fin.Line `json:"lines"`
}

var currencyCode = regexp.MustCompile(`^[A-Z]{3}$`)

var receiptKinds = []string{"invoice", "receipt", "prepayment", "refund", "credit_note", "unknown"}

func (ed ReceiptEdit) apply(rc *fin.Receipt) error {
	if ed.VendorID != nil {
		if v := strings.TrimSpace(*ed.VendorID); v == "" {
			rc.VendorID = nil
		} else {
			rc.VendorID = &v
		}
	}
	if ed.InvoiceNumber != nil {
		rc.InvoiceNumber = strings.TrimSpace(*ed.InvoiceNumber)
	}
	if ed.Kind != nil {
		if !slices.Contains(receiptKinds, *ed.Kind) {
			return &ErrInvalid{Msg: "unknown kind " + *ed.Kind}
		}
		rc.Kind = *ed.Kind
	}
	for _, d := range []struct {
		in  *string
		out **time.Time
	}{{ed.IssueDate, &rc.IssueDate}, {ed.ServicePeriodStart, &rc.ServicePeriodStart}, {ed.ServicePeriodEnd, &rc.ServicePeriodEnd}} {
		if d.in == nil {
			continue
		}
		if strings.TrimSpace(*d.in) == "" {
			*d.out = nil
			continue
		}
		t := parseDate(*d.in)
		if t == nil {
			return &ErrInvalid{Msg: "dates are YYYY-MM-DD"}
		}
		*d.out = t
	}
	if ed.Currency != nil {
		c := strings.ToUpper(strings.TrimSpace(*ed.Currency))
		if c != "" && !currencyCode.MatchString(c) {
			return &ErrInvalid{Msg: "currency is a three-letter ISO code"}
		}
		rc.Currency = c
	}
	if ed.FxRate != nil {
		if *ed.FxRate <= 0 {
			rc.FxRate = nil
		} else {
			rc.FxRate = ed.FxRate
		}
	}
	if ed.SubtotalMicros != nil {
		rc.SubtotalMicros = ed.SubtotalMicros
	}
	if ed.TaxMicros != nil {
		rc.TaxMicros = ed.TaxMicros
	}
	if ed.TotalMicros != nil {
		rc.TotalMicros = ed.TotalMicros
	}
	if ed.Lines != nil {
		rc.Lines = ed.Lines
	}
	if strings.EqualFold(rc.Currency, "USD") {
		rc.FxRate = nil
	}
	return nil
}

// UpdateReceipt applies an operator's edit. A receipt in Needs attention keeps
// waiting there with fresh checks. A posted receipt is re-posted (old entries
// voided, new ones added); an edit that would fail a check is refused.
func (s *Service) UpdateReceipt(ctx context.Context, actor, id string, ed ReceiptEdit) (*fin.Receipt, Effect, error) {
	var out *fin.Receipt
	var eff Effect
	err := s.repo.InTx(ctx, func(ctx context.Context, tx *fin.Repository) error {
		rc, err := tx.GetReceipt(ctx, id, true)
		if err != nil {
			return err
		}
		if !slices.Contains([]string{fin.StatusNeedsAttention, fin.StatusParsed, fin.StatusApproved}, rc.Status) {
			return conflict("a %s receipt can't be edited", statusWord(rc.Status))
		}
		before := receiptSnapshot(rc)
		if err := ed.apply(rc); err != nil {
			return err
		}
		if rc.VendorID != nil {
			if _, err := tx.GetVendor(ctx, *rc.VendorID); err != nil {
				return &ErrInvalid{Msg: "unknown vendor " + *rc.VendorID}
			}
		}
		rc.Edited = true
		rc.Checks = RunChecks(rc, CheckInput{DuplicateOf: s.duplicateOf(ctx, tx, rc)})
		failure := FirstFailure(rc.Checks)
		if failure.Key == CheckDuplicate {
			return conflict("%s", failure.Detail)
		}

		if rc.Status == fin.StatusNeedsAttention {
			rc.AttentionReason = failure.Key
			eff = Effect{}.withSummary()
		} else {
			if failure.Key != "" {
				return &ChecksFailed{Checks: rc.Checks}
			}
			n, sum, err := tx.VoidReceiptEntries(ctx, rc.ID)
			if err != nil {
				return err
			}
			voided := Effect{AmountMicros: -sum, Month: receiptMonth(rc), Entries: n}
			posted, err := s.post(ctx, tx, rc, nil)
			if err != nil {
				return err
			}
			eff = combine(voided, posted)
		}
		if err := tx.UpdateReceipt(ctx, rc); err != nil {
			return mapUnique(err)
		}
		out = rc
		return tx.Audit(ctx, actor, "edit", "receipt", rc.ID, before, receiptSnapshot(rc), eff)
	})
	return out, eff, err
}

// ApproveReceipt posts a receipt from Needs attention. Every check must pass.
func (s *Service) ApproveReceipt(ctx context.Context, actor, id string) (*fin.Receipt, Effect, error) {
	return s.transition(ctx, actor, id, "approve", func(ctx context.Context, tx *fin.Repository, rc *fin.Receipt) (Effect, error) {
		if rc.Status != fin.StatusNeedsAttention {
			return Effect{}, conflict("only a receipt in Needs attention can be approved (this one is %s)", statusWord(rc.Status))
		}
		rc.Checks = RunChecks(rc, CheckInput{DuplicateOf: s.duplicateOf(ctx, tx, rc)})
		if FirstFailure(rc.Checks).Key != "" {
			return Effect{}, &ChecksFailed{Checks: rc.Checks}
		}
		rc.Status = fin.StatusApproved
		rc.AttentionReason = ""
		if err := tx.UpdateReceipt(ctx, rc); err != nil {
			return Effect{}, mapUnique(err)
		}
		return s.post(ctx, tx, rc, nil)
	})
}

// RejectReceipt moves a receipt from Needs attention to Rejected, where it is
// kept for RestoreWindow.
func (s *Service) RejectReceipt(ctx context.Context, actor, id, reason string) (*fin.Receipt, Effect, error) {
	return s.transition(ctx, actor, id, "reject", func(ctx context.Context, tx *fin.Repository, rc *fin.Receipt) (Effect, error) {
		if rc.Status != fin.StatusNeedsAttention {
			return Effect{}, conflict("only a receipt in Needs attention can be ignored (this one is %s)", statusWord(rc.Status))
		}
		reject(rc, s.now(), cmp.Or(strings.TrimSpace(reason), "Ignored by "+actor))
		return Effect{}.withSummary(), tx.UpdateReceipt(ctx, rc)
	})
}

// RestoreReceipt brings a rejected receipt back to Needs attention.
func (s *Service) RestoreReceipt(ctx context.Context, actor, id string) (*fin.Receipt, Effect, error) {
	return s.transition(ctx, actor, id, "restore", func(ctx context.Context, tx *fin.Repository, rc *fin.Receipt) (Effect, error) {
		if rc.Status != fin.StatusRejected {
			return Effect{}, conflict("only a rejected receipt can be restored (this one is %s)", statusWord(rc.Status))
		}
		if rc.RejectedAt != nil && s.now().Sub(*rc.RejectedAt) > RestoreWindow {
			return Effect{}, conflict("this receipt was rejected more than 30 days ago")
		}
		rc.Status = fin.StatusNeedsAttention
		rc.RejectedAt = nil
		rc.RejectedReason = ""
		rc.Checks = RunChecks(rc, CheckInput{DuplicateOf: s.duplicateOf(ctx, tx, rc)})
		rc.AttentionReason = FirstFailure(rc.Checks).Key
		if err := tx.UpdateReceipt(ctx, rc); err != nil {
			return Effect{}, mapUnique(err)
		}
		return Effect{}.withSummary(), nil
	})
}

// VoidReceipt takes a posted receipt out of the books.
func (s *Service) VoidReceipt(ctx context.Context, actor, id, reason string) (*fin.Receipt, Effect, error) {
	return s.transition(ctx, actor, id, "void", func(ctx context.Context, tx *fin.Repository, rc *fin.Receipt) (Effect, error) {
		if rc.Status != fin.StatusParsed && rc.Status != fin.StatusApproved {
			return Effect{}, conflict("only a receipt in the ledger can be voided (this one is %s)", statusWord(rc.Status))
		}
		n, sum, err := tx.VoidReceiptEntries(ctx, rc.ID)
		if err != nil {
			return Effect{}, err
		}
		now := s.now()
		rc.Status = fin.StatusVoided
		rc.VoidedAt = &now
		rc.RejectedReason = strings.TrimSpace(reason)
		return Effect{AmountMicros: -sum, Month: receiptMonth(rc), Entries: n}.withSummary(), tx.UpdateReceipt(ctx, rc)
	})
}

// ReextractReceipt reads the stored email again (a new extraction version);
// the fresh read replaces any edits. A posted receipt is re-posted when it
// still passes, otherwise it moves to Needs attention.
func (s *Service) ReextractReceipt(ctx context.Context, actor, id string) (*fin.Receipt, Effect, error) {
	rc, err := s.repo.GetReceipt(ctx, id, false)
	if err != nil {
		return nil, Effect{}, err
	}
	if !slices.Contains([]string{fin.StatusNeedsAttention, fin.StatusParsed, fin.StatusApproved}, rc.Status) {
		return nil, Effect{}, conflict("a %s receipt can't be re-extracted", statusWord(rc.Status))
	}
	if rc.EmailID == nil {
		return nil, Effect{}, conflict("this receipt has no stored email")
	}
	email, err := s.repo.GetEmail(ctx, *rc.EmailID)
	if err != nil {
		return nil, Effect{}, err
	}
	if len(email.RawMIME) == 0 {
		return nil, Effect{}, conflict("this receipt has no stored email")
	}
	// The model call happens outside the transaction: it can take a while.
	res, err := s.receipts.ProcessRawMIME(ctx, email.RawMIME)
	if err != nil {
		return nil, Effect{}, err
	}
	vendors, err := s.repo.ListVendors(ctx)
	if err != nil {
		return nil, Effect{}, err
	}

	return s.transition(ctx, actor, id, "reextract", func(ctx context.Context, tx *fin.Repository, rc *fin.Receipt) (Effect, error) {
		if !slices.Contains([]string{fin.StatusNeedsAttention, fin.StatusParsed, fin.StatusApproved}, rc.Status) {
			return Effect{}, conflict("a %s receipt can't be re-extracted", statusWord(rc.Status))
		}
		x, err := s.storeExtraction(ctx, tx, email, res)
		if err != nil {
			return Effect{}, err
		}
		if err := tx.LinkExtractions(ctx, email.ID, rc.ID); err != nil {
			return Effect{}, err
		}
		if err := s.bookExtractionCost(ctx, tx, email, rc.ID, res); err != nil {
			return Effect{}, err
		}

		var voided Effect
		if rc.Status != fin.StatusNeedsAttention {
			n, sum, err := tx.VoidReceiptEntries(ctx, rc.ID)
			if err != nil {
				return Effect{}, err
			}
			voided = Effect{AmountMicros: -sum, Month: receiptMonth(rc), Entries: n}
		}
		fresh := receiptFromExtraction(res.Extraction)
		fresh.ID, fresh.EmailID, fresh.CreatedAt = rc.ID, rc.EmailID, rc.CreatedAt
		fresh.CurrentExtractionID = &x.ID
		if v := MatchVendor(vendors, fresh.MerchantName, cmp.Or(email.ForwardedFrom, email.FromAddr)); v != nil {
			fresh.VendorID = &v.ID
		}
		okStatus := rc.Status
		if okStatus == fin.StatusNeedsAttention {
			okStatus = fin.StatusParsed
		}
		*rc = *fresh
		if err := s.checkAndPost(ctx, tx, rc, nil, okStatus, false); err != nil {
			return Effect{}, mapUnique(err)
		}
		if rc.Status == fin.StatusNeedsAttention {
			return voided.withSummary(), nil
		}
		entries, err := tx.ReceiptEntries(ctx, rc.ID)
		if err != nil {
			return Effect{}, err
		}
		var posted Effect
		for _, e := range entries {
			if e.VoidedAt == nil && e.Source == fin.SourceReceipt {
				posted.AmountMicros += e.AmountUSDMicros
				posted.Entries++
			}
		}
		posted.Month = receiptMonth(rc)
		return combine(voided, posted), nil
	})
}

// transition loads and locks a receipt, applies fn and audits the result.
func (s *Service) transition(ctx context.Context, actor, id, action string,
	fn func(ctx context.Context, tx *fin.Repository, rc *fin.Receipt) (Effect, error),
) (*fin.Receipt, Effect, error) {
	var out *fin.Receipt
	var eff Effect
	err := s.repo.InTx(ctx, func(ctx context.Context, tx *fin.Repository) error {
		rc, err := tx.GetReceipt(ctx, id, true)
		if err != nil {
			return err
		}
		before := receiptSnapshot(rc)
		if eff, err = fn(ctx, tx, rc); err != nil {
			return err
		}
		out = rc
		return tx.Audit(ctx, actor, action, "receipt", rc.ID, before, receiptSnapshot(rc), eff)
	})
	return out, eff, err
}

// PurgeRejected deletes receipts rejected more than RestoreWindow ago, with
// their stored emails.
func (s *Service) PurgeRejected(ctx context.Context) error {
	return s.repo.InTx(ctx, func(ctx context.Context, tx *fin.Repository) error {
		_, err := tx.PurgeRejected(ctx, s.now().Add(-RestoreWindow))
		return err
	})
}

// RetryEmail puts a failed email back in the queue.
func (s *Service) RetryEmail(ctx context.Context, actor, id string) error {
	return s.emailAction(ctx, actor, id, "retry", fin.EmailPending)
}

// IgnoreEmail hides a failed email from Needs attention.
func (s *Service) IgnoreEmail(ctx context.Context, actor, id string) error {
	return s.emailAction(ctx, actor, id, "ignore", fin.EmailIgnored)
}

func (s *Service) emailAction(ctx context.Context, actor, id, action, to string) error {
	return s.repo.InTx(ctx, func(ctx context.Context, tx *fin.Repository) error {
		e, err := tx.GetEmail(ctx, id)
		if err != nil {
			return err
		}
		if e.Status != fin.EmailFailed {
			return conflict("only an email that failed can be %s", map[string]string{"retry": "retried", "ignore": "ignored"}[action])
		}
		if err := tx.SetEmailStatus(ctx, id, to, ""); err != nil {
			return err
		}
		return tx.Audit(ctx, actor, action, "email", id, map[string]string{"status": e.Status}, map[string]string{"status": to}, nil)
	})
}

// NewVendor is a vendor an operator adds from Needs attention.
type NewVendor struct {
	Name            string `json:"name"`
	Category        string `json:"category"`
	MerchantPattern string `json:"merchantPattern"`
	SenderDomain    string `json:"senderDomain"`
}

var vendorCategories = []string{"ai", "infra", "email", "domains", "social", "other"}

// CreateVendor adds a vendor to the catalog. Its id is derived from the name.
func (s *Service) CreateVendor(ctx context.Context, actor string, in NewVendor) (*fin.Vendor, error) {
	name := strings.TrimSpace(in.Name)
	id := slug(name)
	if id == "" {
		return nil, &ErrInvalid{Msg: "a vendor needs a name"}
	}
	category := cmp.Or(in.Category, "other")
	if !slices.Contains(vendorCategories, category) {
		return nil, &ErrInvalid{Msg: "unknown category " + category}
	}
	v := &fin.Vendor{ID: id, Name: name, Category: category}
	if p := strings.TrimSpace(in.MerchantPattern); p != "" {
		v.MatchRules.Merchant = []string{strings.ToLower(p)}
	} else {
		v.MatchRules.Merchant = []string{strings.ToLower(name)}
	}
	if d := strings.ToLower(strings.TrimSpace(strings.TrimPrefix(in.SenderDomain, "@"))); d != "" {
		v.MatchRules.Senders = []string{d}
	}
	err := s.repo.InTx(ctx, func(ctx context.Context, tx *fin.Repository) error {
		if _, err := tx.GetVendor(ctx, id); err == nil {
			return conflict("a vendor called %s already exists", name)
		}
		if err := tx.InsertVendor(ctx, v); err != nil {
			return err
		}
		return tx.Audit(ctx, actor, "create", "vendor", id, nil, v, nil)
	})
	return v, err
}

func slug(s string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z' || r >= '0' && r <= '9':
			b.WriteRune(r)
			dash = false
		case b.Len() > 0 && !dash:
			b.WriteByte('-')
			dash = true
		}
	}
	return strings.TrimSuffix(b.String(), "-")
}

func statusWord(status string) string {
	return map[string]string{
		fin.StatusParsed:         "posted",
		fin.StatusApproved:       "approved",
		fin.StatusNeedsAttention: "waiting in Needs attention",
		fin.StatusRejected:       "rejected",
		fin.StatusVoided:         "voided",
	}[status]
}

// mapUnique turns the live-invoice unique index into a conflict.
func mapUnique(err error) error {
	if err != nil && strings.Contains(err.Error(), "uq_finance_receipts_vendor_invoice") {
		return conflict("another receipt already has this vendor and invoice number")
	}
	return err
}

// IsNotFound reports a missing receipt, email or vendor.
func IsNotFound(err error) bool { return errors.Is(err, fin.ErrNotFound) }
