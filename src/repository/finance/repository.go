package finance

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"time"

	"github.com/uptrace/bun"
)

// ErrNotFound is returned when a row does not exist.
var ErrNotFound = errors.New("not found")

// Repository reads and writes the finance tables. The zero value is unusable;
// build it with New. WithTx returns a copy bound to a transaction.
type Repository struct {
	db  *bun.DB
	idb bun.IDB
}

func New(db *bun.DB) *Repository { return &Repository{db: db, idb: db} }

// DB is the underlying pool, for advisory locks and transactions.
func (r *Repository) DB() *bun.DB { return r.db }

// WithTx returns a Repository whose methods run inside tx.
func (r *Repository) WithTx(tx bun.Tx) *Repository { return &Repository{db: r.db, idb: tx} }

// InTx runs fn in a transaction with a tx-bound Repository.
func (r *Repository) InTx(ctx context.Context, fn func(ctx context.Context, tx *Repository) error) error {
	return r.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		return fn(ctx, r.WithTx(tx))
	})
}

func notFound(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

// ── Vendors ─────────────────────────────────────────────────────────────────

func (r *Repository) ListVendors(ctx context.Context) ([]Vendor, error) {
	var out []Vendor
	err := r.idb.NewSelect().Model(&out).Order("v.name").Scan(ctx)
	return out, err
}

func (r *Repository) GetVendor(ctx context.Context, id string) (*Vendor, error) {
	v := new(Vendor)
	if err := r.idb.NewSelect().Model(v).Where("v.id = ?", id).Scan(ctx); err != nil {
		return nil, notFound(err)
	}
	return v, nil
}

func (r *Repository) InsertVendor(ctx context.Context, v *Vendor) error {
	_, err := r.idb.NewInsert().Model(v).Returning("*").Exec(ctx)
	return err
}

// ── Inbound emails ──────────────────────────────────────────────────────────

// InsertPendingEmail records a receipt.received event. It is idempotent on the
// Resend id: created is false when the email was already known.
func (r *Repository) InsertPendingEmail(ctx context.Context, resendEmailID string) (created bool, err error) {
	e := &InboundEmail{ResendEmailID: resendEmailID, Status: EmailPending, ToAddrs: []string{}}
	res, err := r.idb.NewInsert().Model(e).
		Column("resend_email_id", "status", "to_addrs").
		On("CONFLICT (resend_email_id) DO NOTHING").
		Exec(ctx)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// DueEmails returns pending emails whose next attempt is due, oldest first.
// Bodies are not loaded.
func (r *Repository) DueEmails(ctx context.Context, limit int) ([]InboundEmail, error) {
	var out []InboundEmail
	err := r.idb.NewSelect().Model(&out).
		ExcludeColumn("text_body", "html_body", "raw_mime").
		Where("e.status = ?", EmailPending).
		Where("e.next_attempt_at <= now()").
		Order("e.next_attempt_at").
		Limit(limit).
		Scan(ctx)
	return out, err
}

func (r *Repository) GetEmail(ctx context.Context, id string) (*InboundEmail, error) {
	e := new(InboundEmail)
	if err := r.idb.NewSelect().Model(e).Where("e.id = ?", id).Scan(ctx); err != nil {
		return nil, notFound(err)
	}
	return e, nil
}

// ScheduleEmailRetry records a transient failure and when to try again.
func (r *Repository) ScheduleEmailRetry(ctx context.Context, id string, attempts int, next time.Time, msg string) error {
	_, err := r.idb.NewUpdate().Model((*InboundEmail)(nil)).
		Set("attempts = ?", attempts).
		Set("next_attempt_at = ?", next).
		Set("last_error = ?", msg).
		Set("updated_at = now()").
		Where("id = ?", id).
		Exec(ctx)
	return err
}

// SetEmailStatus moves an email to status with an error message (” clears it).
// Moving to pending makes it due now.
func (r *Repository) SetEmailStatus(ctx context.Context, id, status, msg string) error {
	q := r.idb.NewUpdate().Model((*InboundEmail)(nil)).
		Set("status = ?", status).
		Set("last_error = ?", msg).
		Set("updated_at = now()").
		Where("id = ?", id)
	if status == EmailPending {
		q = q.Set("next_attempt_at = now()").Set("attempts = 0")
	}
	_, err := q.Exec(ctx)
	return err
}

// StoreFetchedEmail saves the email's content and marks it fetched.
func (r *Repository) StoreFetchedEmail(ctx context.Context, e *InboundEmail) error {
	_, err := r.idb.NewUpdate().Model(e).
		Column("status", "fetched_at", "from_addr", "forwarded_from", "to_addrs", "subject",
			"message_id", "email_date", "text_body", "html_body", "raw_mime", "last_error", "attempts").
		Set("updated_at = now()").
		WherePK().
		Exec(ctx)
	return err
}

// LastReceivedAt is when the newest email arrived (nil when none ever did).
func (r *Repository) LastReceivedAt(ctx context.Context) (*time.Time, error) {
	var t *time.Time
	err := r.idb.NewRaw(`SELECT max(received_at) FROM finance_inbound_emails`).Scan(ctx, &t)
	return t, err
}

func (r *Repository) CountEmails(ctx context.Context, status string) (int, error) {
	return r.idb.NewSelect().Model((*InboundEmail)(nil)).Where("status = ?", status).Count(ctx)
}

// FailedEmails lists emails that could not be fetched or read, newest first.
func (r *Repository) FailedEmails(ctx context.Context) ([]InboundEmail, error) {
	var out []InboundEmail
	err := r.idb.NewSelect().Model(&out).
		ExcludeColumn("text_body", "html_body", "raw_mime").
		Where("e.status = ?", EmailFailed).
		Order("e.received_at DESC").
		Scan(ctx)
	return out, err
}

// EmailsByIDs loads emails without their bodies, keyed by id.
func (r *Repository) EmailsByIDs(ctx context.Context, ids []string) (map[string]InboundEmail, error) {
	out := make(map[string]InboundEmail, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	var rows []InboundEmail
	err := r.idb.NewSelect().Model(&rows).
		ExcludeColumn("text_body", "html_body", "raw_mime").
		Where("e.id IN (?)", bun.List(ids)).
		Scan(ctx)
	for _, e := range rows {
		out[e.ID] = e
	}
	return out, err
}

func (r *Repository) InsertAttachments(ctx context.Context, atts []Attachment) error {
	if len(atts) == 0 {
		return nil
	}
	_, err := r.idb.NewInsert().Model(&atts).Exec(ctx)
	return err
}

// ListAttachments lists an email's attachments without their content.
func (r *Repository) ListAttachments(ctx context.Context, emailID string) ([]Attachment, error) {
	var out []Attachment
	err := r.idb.NewSelect().Model(&out).
		Column("id", "email_id", "filename", "content_type", "size_bytes", "created_at").
		ColumnExpr("content IS NOT NULL AS stored").
		Where("a.email_id = ?", emailID).
		Order("a.created_at", "a.filename").
		Scan(ctx)
	return out, err
}

func (r *Repository) GetAttachment(ctx context.Context, emailID, id string) (*Attachment, error) {
	a := new(Attachment)
	if err := r.idb.NewSelect().Model(a).Where("a.id = ? AND a.email_id = ?", id, emailID).Scan(ctx); err != nil {
		return nil, notFound(err)
	}
	return a, nil
}

// ── Receipts ────────────────────────────────────────────────────────────────

func (r *Repository) InsertReceipt(ctx context.Context, rc *Receipt) error {
	_, err := r.idb.NewInsert().Model(rc).Returning("*").Exec(ctx)
	return err
}

// UpdateReceipt writes every editable column of rc.
func (r *Repository) UpdateReceipt(ctx context.Context, rc *Receipt) error {
	_, err := r.idb.NewUpdate().Model(rc).
		ExcludeColumn("id", "email_id", "created_at", "updated_at").
		Set("updated_at = now()").
		WherePK().
		Returning("*").
		Exec(ctx)
	return err
}

// GetReceipt loads one receipt; forUpdate locks the row for the transaction.
func (r *Repository) GetReceipt(ctx context.Context, id string, forUpdate bool) (*Receipt, error) {
	rc := new(Receipt)
	q := r.idb.NewSelect().Model(rc).Where("r.id = ?", id)
	if forUpdate {
		q = q.For("UPDATE")
	}
	if err := q.Scan(ctx); err != nil {
		return nil, notFound(err)
	}
	return rc, nil
}

// ReceiptByEmail is the receipt read from an email, if any.
func (r *Repository) ReceiptByEmail(ctx context.Context, emailID string) (*Receipt, error) {
	rc := new(Receipt)
	if err := r.idb.NewSelect().Model(rc).Where("r.email_id = ?", emailID).
		Order("r.created_at DESC").Limit(1).Scan(ctx); err != nil {
		return nil, notFound(err)
	}
	return rc, nil
}

// LiveReceipt finds the live (not rejected or voided) receipt for a vendor and
// invoice number, other than exceptID.
func (r *Repository) LiveReceipt(ctx context.Context, vendorID, invoice, exceptID string) (*Receipt, error) {
	rc := new(Receipt)
	q := r.idb.NewSelect().Model(rc).
		Where("r.vendor_id = ?", vendorID).
		Where("r.invoice_number = ?", invoice).
		Where("r.status NOT IN (?)", bun.List([]string{StatusRejected, StatusVoided}))
	if exceptID != "" {
		q = q.Where("r.id <> ?", exceptID)
	}
	if err := q.Limit(1).Scan(ctx); err != nil {
		return nil, notFound(err)
	}
	return rc, nil
}

// ReceiptsByStatus lists receipts in one status, newest first.
func (r *Repository) ReceiptsByStatus(ctx context.Context, status string) ([]Receipt, error) {
	var out []Receipt
	err := r.idb.NewSelect().Model(&out).Where("r.status = ?", status).Order("r.created_at DESC").Scan(ctx)
	return out, err
}

// PurgeRejected deletes receipts rejected before cutoff, then their stored
// emails (the raw MIME and attachments go with them). Ledger entries survive:
// the cost of reading a rejected receipt was still spent. Run it in a
// transaction; the second statement must see the first one's deletes, which a
// single data-modifying CTE would not.
func (r *Repository) PurgeRejected(ctx context.Context, cutoff time.Time) (int64, error) {
	var emailIDs []string
	err := r.idb.NewRaw(`
		DELETE FROM finance_receipts
		WHERE status = ? AND rejected_at < ?
		RETURNING COALESCE(email_id::text, '')`,
		StatusRejected, cutoff).Scan(ctx, &emailIDs)
	if err != nil || len(emailIDs) == 0 {
		return 0, err
	}
	n := int64(len(emailIDs))
	emailIDs = slices.DeleteFunc(emailIDs, func(id string) bool { return id == "" })
	if len(emailIDs) == 0 {
		return n, nil
	}
	_, err = r.idb.NewRaw(`
		DELETE FROM finance_inbound_emails e
		WHERE e.id::text IN (?)
		  AND NOT EXISTS (SELECT 1 FROM finance_receipts rc WHERE rc.email_id = e.id)`,
		bun.List(emailIDs)).Exec(ctx)
	return n, err
}

// LastFxRate is the most recent rate used for a currency (nil when none).
func (r *Repository) LastFxRate(ctx context.Context, currency string) (*float64, error) {
	var rate *float64
	err := r.idb.NewRaw(`
		SELECT fx_rate::float8 FROM finance_receipts
		WHERE upper(currency) = upper(?) AND fx_rate IS NOT NULL AND status IN (?)
		ORDER BY updated_at DESC LIMIT 1`,
		currency, bun.List([]string{StatusParsed, StatusApproved})).Scan(ctx, &rate)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return rate, err
}

// ── Extractions ─────────────────────────────────────────────────────────────

// InsertExtraction stores the next version for the email.
func (r *Repository) InsertExtraction(ctx context.Context, x *Extraction) error {
	err := r.idb.NewRaw(`SELECT COALESCE(max(version), 0) + 1 FROM finance_receipt_extractions WHERE email_id = ?`, x.EmailID).
		Scan(ctx, &x.Version)
	if err != nil {
		return err
	}
	_, err = r.idb.NewInsert().Model(x).Returning("*").Exec(ctx)
	return err
}

// LinkExtractions points an email's extractions at its receipt.
func (r *Repository) LinkExtractions(ctx context.Context, emailID, receiptID string) error {
	_, err := r.idb.NewUpdate().Model((*Extraction)(nil)).
		Set("receipt_id = ?", receiptID).
		Where("email_id = ? AND receipt_id IS NULL", emailID).
		Exec(ctx)
	return err
}

func (r *Repository) ListExtractions(ctx context.Context, emailID string) ([]Extraction, error) {
	var out []Extraction
	err := r.idb.NewSelect().Model(&out).Where("x.email_id = ?", emailID).Order("x.version DESC").Scan(ctx)
	return out, err
}

// ── Ledger ──────────────────────────────────────────────────────────────────

func (r *Repository) InsertEntries(ctx context.Context, entries []LedgerEntry) error {
	if len(entries) == 0 {
		return nil
	}
	_, err := r.idb.NewInsert().Model(&entries).Exec(ctx)
	return err
}

// VoidReceiptEntries voids a receipt's live entries and returns what it voided.
func (r *Repository) VoidReceiptEntries(ctx context.Context, receiptID string) (count int, sumUSD int64, err error) {
	var row struct {
		N   int   `bun:"n"`
		Sum int64 `bun:"s"`
	}
	err = r.idb.NewRaw(`
		WITH v AS (
			UPDATE finance_ledger_entries SET voided_at = now(), updated_at = now()
			WHERE receipt_id = ? AND source = ? AND voided_at IS NULL
			RETURNING amount_usd_micros
		)
		SELECT count(*) AS n, COALESCE(sum(amount_usd_micros), 0) AS s FROM v`,
		receiptID, SourceReceipt).Scan(ctx, &row)
	return row.N, row.Sum, err
}

// ReceiptEntries lists every entry posted for a receipt, voided ones included.
func (r *Repository) ReceiptEntries(ctx context.Context, receiptID string) ([]LedgerEntry, error) {
	var out []LedgerEntry
	err := r.idb.NewSelect().Model(&out).Where("l.receipt_id = ?", receiptID).
		Order("l.created_at", "l.description").Scan(ctx)
	return out, err
}

// UpsertAIEntries upserts token-pipeline rows on their (day, vendor, model,
// tenant) key, reviving any that were voided.
func (r *Repository) UpsertAIEntries(ctx context.Context, entries []LedgerEntry) error {
	for chunk := range chunks(entries, 1000) {
		_, err := r.idb.NewInsert().Model(&chunk).
			On("CONFLICT (source, booked_date, vendor_id, COALESCE(model, ''), COALESCE(tenant_id, '')) WHERE source = 'token_pipeline' DO UPDATE").
			Set("amount_micros = EXCLUDED.amount_micros").
			Set("amount_usd_micros = EXCLUDED.amount_usd_micros").
			Set("description = EXCLUDED.description").
			Set("voided_at = NULL").
			Set("updated_at = now()").
			Exec(ctx)
		if err != nil {
			return err
		}
	}
	return nil
}

// DeleteStaleAIEntries removes token-pipeline rows in [from, to] that this
// transaction's upsert did not touch (their usage disappeared upstream).
func (r *Repository) DeleteStaleAIEntries(ctx context.Context, from, to time.Time) (int64, error) {
	res, err := r.idb.NewDelete().Model((*LedgerEntry)(nil)).
		Where("source = ?", SourceTokenPipeline).
		Where("booked_date BETWEEN ? AND ?", from, to).
		Where("updated_at < now()").
		Exec(ctx)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// UpsertPaymentEntries upserts payment components on (payment id, direction).
func (r *Repository) UpsertPaymentEntries(ctx context.Context, entries []LedgerEntry) error {
	for chunk := range chunks(entries, 1000) {
		_, err := r.idb.NewInsert().Model(&chunk).
			On("CONFLICT (source_ref, direction) WHERE source = 'billing_v1' DO UPDATE").
			Set("amount_micros = EXCLUDED.amount_micros").
			Set("currency = EXCLUDED.currency").
			Set("amount_usd_micros = EXCLUDED.amount_usd_micros").
			Set("description = EXCLUDED.description").
			Set("booked_date = EXCLUDED.booked_date").
			Set("tenant_id = EXCLUDED.tenant_id").
			Set("test_mode = EXCLUDED.test_mode").
			Set("updated_at = now()").
			Exec(ctx)
		if err != nil {
			return err
		}
	}
	return nil
}

func chunks[T any](s []T, n int) func(yield func([]T) bool) {
	return func(yield func([]T) bool) {
		for len(s) > 0 {
			k := min(n, len(s))
			if !yield(s[:k]) {
				return
			}
			s = s[k:]
		}
	}
}

// ── Audit ───────────────────────────────────────────────────────────────────

// Audit appends one audit row. before/after/effect are marshalled to JSON.
func (r *Repository) Audit(ctx context.Context, actor, action, entityType, entityID string, before, after, effect any) error {
	e := &AuditEntry{Actor: actor, Action: action, EntityType: entityType, EntityID: entityID}
	var err error
	if e.Before, err = marshalOrNil(before); err != nil {
		return err
	}
	if e.After, err = marshalOrNil(after); err != nil {
		return err
	}
	if e.Effect, err = marshalOrNil(effect); err != nil {
		return err
	}
	_, err = r.idb.NewInsert().Model(e).Exec(ctx)
	return err
}

func marshalOrNil(v any) (json.RawMessage, error) {
	if v == nil {
		return nil, nil
	}
	return json.Marshal(v)
}

// AuditFor lists an entity's audit rows, newest first.
func (r *Repository) AuditFor(ctx context.Context, entityType, entityID string) ([]AuditEntry, error) {
	var out []AuditEntry
	err := r.idb.NewSelect().Model(&out).
		Where("au.entity_type = ? AND au.entity_id = ?", entityType, entityID).
		Order("au.created_at DESC", "au.id DESC").
		Scan(ctx)
	return out, err
}

// ── Sync state ──────────────────────────────────────────────────────────────

// GetSync returns a sync's state; a never-run sync is a zero row with Key set.
func (r *Repository) GetSync(ctx context.Context, key string) (SyncState, error) {
	s := SyncState{Key: key}
	err := r.idb.NewSelect().Model(&s).WherePK().Scan(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return SyncState{Key: key}, nil
	}
	return s, err
}

// SyncSucceeded records a successful pass; through may be nil.
func (r *Repository) SyncSucceeded(ctx context.Context, key string, through *time.Time) error {
	_, err := r.idb.NewRaw(`
		INSERT INTO finance_sync_state (key, last_attempt_at, last_success_at, last_error, through_date, updated_at)
		VALUES (?, now(), now(), '', ?, now())
		ON CONFLICT (key) DO UPDATE SET
			last_attempt_at = now(), last_success_at = now(), last_error = '',
			through_date = COALESCE(EXCLUDED.through_date, finance_sync_state.through_date),
			updated_at = now()`, key, through).Exec(ctx)
	return err
}

// SyncFailed records a failed pass.
func (r *Repository) SyncFailed(ctx context.Context, key, msg string) error {
	_, err := r.idb.NewRaw(`
		INSERT INTO finance_sync_state (key, last_attempt_at, last_error, updated_at)
		VALUES (?, now(), ?, now())
		ON CONFLICT (key) DO UPDATE SET last_attempt_at = now(), last_error = EXCLUDED.last_error, updated_at = now()`,
		key, msg).Exec(ctx)
	return err
}
