package finance

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/ogen-app/harbor/src/logging"
	fin "github.com/ogen-app/harbor/src/repository/finance"
	"github.com/ogen-app/harbor/src/repository/ogenreceipts"
)

const (
	// MaxAttachmentBytes is the stored-attachment cap; larger ones keep their
	// metadata only.
	MaxAttachmentBytes = 10 << 20
	// maxFetchAttempts bounds retries of a transient ProcessReceipt failure.
	maxFetchAttempts = 20
	// dueBatch is how many pending emails one receipt-job tick handles.
	dueBatch = 10
	// systemActor is the audit actor for automatic actions.
	systemActor = "system"
)

// RecordReceiptEvent handles receipt.received: it records the email as
// pending, idempotent on the Resend id (the webhook has no replay guard, and a
// redelivery must add nothing).
func (s *Service) RecordReceiptEvent(ctx context.Context, resendEmailID string) (created bool, err error) {
	return s.repo.InsertPendingEmail(ctx, strings.TrimSpace(resendEmailID))
}

// ProcessDueEmails is the receipt job: it fetches and extracts every due
// pending email through Ogen and stores the result.
func (s *Service) ProcessDueEmails(ctx context.Context) error {
	due, err := s.repo.DueEmails(ctx, dueBatch)
	if err != nil {
		return err
	}
	for i := range due {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		s.processEmail(ctx, &due[i])
	}
	return nil
}

func (s *Service) processEmail(ctx context.Context, e *fin.InboundEmail) {
	log := slog.With(logging.AttrComponent, "finance.receipts", "email_id", e.ID, "resend_email_id", e.ResendEmailID)
	res, err := s.receipts.ProcessByResendID(ctx, e.ResendEmailID)
	if err != nil {
		s.recordFetchFailure(ctx, e, err)
		return
	}
	if err := s.ingest(ctx, e, res); err != nil {
		log.WarnContext(ctx, "receipt: store failed; will retry", logging.AttrError, err)
		s.recordFetchFailure(ctx, e, err)
		return
	}
	log.InfoContext(ctx, "receipt: ingested")
}

// recordFetchFailure retries transient errors with backoff and fails the email
// on a permanent one (NotFound: Resend dropped it; InvalidArgument: bad MIME),
// which puts it in Needs attention.
func (s *Service) recordFetchFailure(ctx context.Context, e *fin.InboundEmail, err error) {
	log := slog.With(logging.AttrComponent, "finance.receipts", "email_id", e.ID)
	if errors.Is(err, ogenreceipts.ErrUnavailable) {
		// Not configured here: wait without spending an attempt.
		if uerr := s.repo.ScheduleEmailRetry(ctx, e.ID, e.Attempts, s.now().Add(time.Minute), fetchErrorMessage(err)); uerr != nil {
			log.WarnContext(ctx, "receipt: schedule retry", logging.AttrError, uerr)
		}
		return
	}
	code := status.Code(err)
	permanent := code == codes.NotFound || code == codes.InvalidArgument || code == codes.PermissionDenied
	attempts := e.Attempts + 1
	if permanent || attempts >= maxFetchAttempts {
		msg := fetchErrorMessage(err)
		log.WarnContext(ctx, "receipt: fetch failed permanently", "code", code.String(), logging.AttrError, err)
		if uerr := s.repo.SetEmailStatus(ctx, e.ID, fin.EmailFailed, msg); uerr != nil {
			log.WarnContext(ctx, "receipt: mark failed", logging.AttrError, uerr)
		}
		_ = s.repo.Audit(ctx, systemActor, "fetch_failed", "email", e.ID, nil, map[string]string{"error": msg}, nil)
		return
	}
	// 10s, 20s, 40s … capped at an hour.
	backoff := min(time.Duration(math.Pow(2, float64(attempts-1)))*10*time.Second, time.Hour)
	log.InfoContext(ctx, "receipt: fetch failed; retrying", "attempts", attempts, "backoff", backoff.String(), logging.AttrError, err)
	if uerr := s.repo.ScheduleEmailRetry(ctx, e.ID, attempts, s.now().Add(backoff), err.Error()); uerr != nil {
		log.WarnContext(ctx, "receipt: schedule retry", logging.AttrError, uerr)
	}
}

func fetchErrorMessage(err error) string {
	switch status.Code(err) {
	case codes.NotFound:
		return "Resend no longer has this email"
	case codes.InvalidArgument:
		return "The email could not be read: " + status.Convert(err).Message()
	}
	if errors.Is(err, ogenreceipts.ErrUnavailable) {
		return "The receipt service is not configured"
	}
	return err.Error()
}

// ingest stores one processed email and its receipt in a single transaction:
// the raw email, attachments and extraction version, then the receipt, which
// is posted when every check passes and otherwise waits in Needs attention.
func (s *Service) ingest(ctx context.Context, e *fin.InboundEmail, res ogenreceipts.Result) error {
	vendors, err := s.repo.ListVendors(ctx)
	if err != nil {
		return err
	}
	forwarder := EmailAddress(res.Headers.From)
	isOperator, err := s.operators.IsOperator(ctx, forwarder)
	if err != nil {
		return fmt.Errorf("resolve operators: %w", err)
	}

	return s.repo.InTx(ctx, func(ctx context.Context, tx *fin.Repository) error {
		now := s.now()
		e.Status = fin.EmailFetched
		e.FetchedAt = &now
		e.LastError = ""
		e.FromAddr = res.Headers.From
		e.ForwardedFrom = res.Headers.ForwardedFrom
		e.ToAddrs = res.Headers.To
		if e.ToAddrs == nil {
			e.ToAddrs = []string{}
		}
		e.Subject = res.Headers.Subject
		e.MessageID = res.Headers.MessageID
		e.EmailDate = res.Headers.Date
		e.TextBody = []byte(res.TextBody)
		e.HTMLBody = []byte(res.HTMLBody)
		e.RawMIME = res.RawMIME
		if err := tx.StoreFetchedEmail(ctx, e); err != nil {
			return fmt.Errorf("store email: %w", err)
		}
		if err := tx.InsertAttachments(ctx, attachmentRows(e.ID, res.Attachments)); err != nil {
			return fmt.Errorf("store attachments: %w", err)
		}
		x, err := s.storeExtraction(ctx, tx, e, res)
		if err != nil {
			return err
		}

		rc := receiptFromExtraction(res.Extraction)
		rc.EmailID = &e.ID
		rc.CurrentExtractionID = &x.ID
		vendor := MatchVendor(vendors, rc.MerchantName, cmp.Or(res.Headers.ForwardedFrom, res.Headers.From))
		if vendor != nil {
			rc.VendorID = &vendor.ID
		}

		switch dup := s.duplicateOf(ctx, tx, rc); {
		case !isOperator:
			reject(rc, now, fmt.Sprintf("Forwarder isn't a Harbor operator (%s)", cmp.Or(forwarder, "unknown sender")))
		case dup != "":
			reject(rc, now, "Duplicate of invoice "+dup)
		}
		if rc.Status == fin.StatusRejected {
			rc.Checks = RunChecks(rc, CheckInput{})
			if err := tx.InsertReceipt(ctx, rc); err != nil {
				return fmt.Errorf("insert receipt: %w", err)
			}
		} else if err := s.checkAndPost(ctx, tx, rc, vendor, fin.StatusParsed, true); err != nil {
			return err
		}

		if err := tx.LinkExtractions(ctx, e.ID, rc.ID); err != nil {
			return err
		}
		if err := s.bookExtractionCost(ctx, tx, e, rc.ID, res); err != nil {
			return err
		}
		return tx.Audit(ctx, systemActor, "ingest", "receipt", rc.ID, nil, receiptSnapshot(rc), nil)
	})
}

func reject(rc *fin.Receipt, now time.Time, reason string) {
	rc.Status = fin.StatusRejected
	rc.RejectedReason = reason
	rc.RejectedAt = &now
}

// duplicateOf is the invoice number of a live receipt with the same vendor and
// invoice number (” when there is none or the key is incomplete).
func (s *Service) duplicateOf(ctx context.Context, tx *fin.Repository, rc *fin.Receipt) string {
	if rc.VendorID == nil || rc.InvoiceNumber == "" {
		return ""
	}
	if _, err := tx.LiveReceipt(ctx, *rc.VendorID, rc.InvoiceNumber, rc.ID); err == nil {
		return rc.InvoiceNumber
	}
	return ""
}

// checkAndPost runs the checks and either posts the receipt with okStatus or
// leaves it in needs_attention. insert creates the row, otherwise it updates.
func (s *Service) checkAndPost(ctx context.Context, tx *fin.Repository, rc *fin.Receipt, vendor *fin.Vendor, okStatus string, insert bool) error {
	rc.Checks = RunChecks(rc, CheckInput{DuplicateOf: s.duplicateOf(ctx, tx, rc)})
	failure := FirstFailure(rc.Checks)
	if failure.Key == "" {
		rc.Status = okStatus
		rc.AttentionReason = ""
	} else {
		rc.Status = fin.StatusNeedsAttention
		rc.AttentionReason = failure.Key
	}
	var err error
	if insert {
		err = tx.InsertReceipt(ctx, rc)
	} else {
		err = tx.UpdateReceipt(ctx, rc)
	}
	if err != nil {
		return fmt.Errorf("save receipt: %w", err)
	}
	if failure.Key != "" {
		return nil
	}
	_, err = s.post(ctx, tx, rc, vendor)
	return err
}

func (s *Service) storeExtraction(ctx context.Context, tx *fin.Repository, e *fin.InboundEmail, res ogenreceipts.Result) (*fin.Extraction, error) {
	raw, err := json.Marshal(res.Extraction)
	if err != nil {
		return nil, err
	}
	x := &fin.Extraction{
		EmailID:       e.ID,
		ModelID:       res.Usage.ModelID,
		PromptVersion: res.Usage.PromptVersion,
		InputTokens:   res.Usage.InputTokens,
		OutputTokens:  res.Usage.OutputTokens,
		CostMicros:    res.Usage.CostMicros,
		Extraction:    raw,
	}
	if err := tx.InsertExtraction(ctx, x); err != nil {
		return nil, fmt.Errorf("store extraction: %w", err)
	}
	return x, nil
}

// bookExtractionCost books what reading the receipt cost as an internal AI
// expense. Ogen's usage recorder skips calls with no tenant, so this cost
// would otherwise never appear anywhere.
func (s *Service) bookExtractionCost(ctx context.Context, tx *fin.Repository, e *fin.InboundEmail, receiptID string, res ogenreceipts.Result) error {
	if res.Usage.CostMicros <= 0 {
		return nil
	}
	vendor := cmp.Or(AIVendorForModel(res.Usage.ModelID), "anthropic")
	today := dateOnly(s.now())
	entry := fin.LedgerEntry{
		Direction:          fin.DirExpense,
		Source:             fin.SourceReceiptExtraction,
		SourceRef:          e.ID,
		VendorID:           vendor,
		ReceiptID:          &receiptID,
		EmailID:            &e.ID,
		Description:        "Receipt reading · " + cmp.Or(res.Headers.Subject, "receipt"),
		AmountMicros:       res.Usage.CostMicros,
		Currency:           "USD",
		AmountUSDMicros:    res.Usage.CostMicros,
		ServicePeriodStart: &today,
		ServicePeriodEnd:   &today,
		BookedDate:         today,
		Model:              new(res.Usage.ModelID),
	}
	return tx.InsertEntries(ctx, []fin.LedgerEntry{entry})
}

func attachmentRows(emailID string, atts []ogenreceipts.Attachment) []fin.Attachment {
	out := make([]fin.Attachment, 0, len(atts))
	for _, a := range atts {
		row := fin.Attachment{
			EmailID:     emailID,
			Filename:    a.Filename,
			ContentType: a.ContentType,
			SizeBytes:   int64(len(a.Content)),
		}
		if len(a.Content) <= MaxAttachmentBytes {
			row.Content = a.Content
		}
		out = append(out, row)
	}
	return out
}

// receiptFromExtraction copies the model's reading into a receipt.
func receiptFromExtraction(x ogenreceipts.Extraction) *fin.Receipt {
	rc := &fin.Receipt{
		MerchantName:       strings.TrimSpace(x.MerchantName),
		InvoiceNumber:      strings.TrimSpace(x.DocumentNumber),
		Kind:               cmp.Or(x.Kind, "unknown"),
		IssueDate:          parseDate(x.IssueDate),
		ServicePeriodStart: parseDate(x.ServicePeriodStart),
		ServicePeriodEnd:   parseDate(x.ServicePeriodEnd),
		Currency:           strings.ToUpper(strings.TrimSpace(x.Currency)),
		SubtotalMicros:     x.SubtotalMicros,
		TaxMicros:          x.TaxMicros,
		TotalMicros:        x.TotalMicros,
		Lines:              make([]fin.Line, 0, len(x.LineItems)),
		Checks:             []fin.Check{},
		Edited:             false,
	}
	for _, li := range x.LineItems {
		rc.Lines = append(rc.Lines, fin.Line{
			Description:     li.Description,
			QuantityMicros:  li.QuantityMicros,
			UnitPriceMicros: li.UnitPriceMicros,
			AmountMicros:    li.AmountMicros,
		})
	}
	return rc
}

// receiptSnapshot is the audit view of a receipt: what an operator can change.
func receiptSnapshot(rc *fin.Receipt) map[string]any {
	return map[string]any{
		"status":             rc.Status,
		"vendorId":           rc.VendorID,
		"invoiceNumber":      rc.InvoiceNumber,
		"kind":               rc.Kind,
		"issueDate":          rc.IssueDate,
		"servicePeriodStart": rc.ServicePeriodStart,
		"servicePeriodEnd":   rc.ServicePeriodEnd,
		"currency":           rc.Currency,
		"fxRate":             rc.FxRate,
		"subtotalMicros":     rc.SubtotalMicros,
		"taxMicros":          rc.TaxMicros,
		"totalMicros":        rc.TotalMicros,
		"lines":              rc.Lines,
		"attentionReason":    rc.AttentionReason,
		"rejectedReason":     rc.RejectedReason,
	}
}
