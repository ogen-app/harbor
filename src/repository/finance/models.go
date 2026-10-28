// Package finance is the bun-backed data-access layer for Harbor's finance
// ledger (CON-412/420): vendors, inbound receipt emails, receipts and their
// extraction versions, ledger entries, the audit log and sync state. All of it
// lives in Harbor's own database.
//
// The judgement (checks, posting rules, aggregation) lives in src/finance; this
// package only reads and writes rows. Repository.WithTx runs the same methods
// inside a transaction.
package finance

import (
	"encoding/json"
	"time"

	"github.com/uptrace/bun"
)

// Receipt statuses. parsed and approved receipts are posted to the ledger.
const (
	StatusParsed         = "parsed"
	StatusNeedsAttention = "needs_attention"
	StatusApproved       = "approved"
	StatusRejected       = "rejected"
	StatusVoided         = "voided"
)

// Inbound email statuses.
const (
	EmailPending = "pending"
	EmailFetched = "fetched"
	EmailFailed  = "failed"
	EmailIgnored = "ignored"
)

// Ledger directions and sources.
const (
	DirRevenue    = "revenue"
	DirTax        = "tax"
	DirFee        = "fee"
	DirRefund     = "refund"
	DirExpense    = "expense"
	DirPrepayment = "prepayment"

	SourceReceipt           = "receipt"
	SourceTokenPipeline     = "token_pipeline"
	SourceBilling           = "billing_v1"
	SourceReceiptExtraction = "receipt_extraction"
)

// VendorLemonSqueezy is the revenue vendor every payment is booked against.
const VendorLemonSqueezy = "lemonsqueezy"

// MatchRules are case-insensitive substrings: Merchant against the printed
// merchant name, Senders against the original sender's address.
type MatchRules struct {
	Merchant []string `json:"merchant,omitempty"`
	Senders  []string `json:"senders,omitempty"`
}

type Vendor struct {
	bun.BaseModel `bun:"table:finance_vendors,alias:v"`

	ID           string     `bun:"id,pk"`
	Name         string     `bun:"name,notnull"`
	Category     string     `bun:"category,notnull"`
	MatchRules   MatchRules `bun:"match_rules,type:jsonb,notnull"`
	IsAIPipeline bool       `bun:"is_ai_pipeline,notnull"`
	CreatedAt    time.Time  `bun:"created_at,notnull,default:current_timestamp"`
	UpdatedAt    time.Time  `bun:"updated_at,notnull,default:current_timestamp"`
}

type InboundEmail struct {
	bun.BaseModel `bun:"table:finance_inbound_emails,alias:e"`

	ID            string     `bun:"id,pk,type:uuid,default:gen_random_uuid()"`
	ResendEmailID string     `bun:"resend_email_id,notnull"`
	Status        string     `bun:"status,notnull"`
	Attempts      int        `bun:"attempts,notnull"`
	NextAttemptAt time.Time  `bun:"next_attempt_at,notnull,default:current_timestamp"`
	LastError     string     `bun:"last_error,notnull"`
	ReceivedAt    time.Time  `bun:"received_at,notnull,default:current_timestamp"`
	FetchedAt     *time.Time `bun:"fetched_at"`
	FromAddr      string     `bun:"from_addr,notnull"`
	ForwardedFrom string     `bun:"forwarded_from,notnull"`
	ToAddrs       []string   `bun:"to_addrs,array,notnull"`
	Subject       string     `bun:"subject,notnull"`
	MessageID     string     `bun:"message_id,notnull"`
	EmailDate     *time.Time `bun:"email_date"`
	TextBody      []byte     `bun:"text_body"`
	HTMLBody      []byte     `bun:"html_body"`
	RawMIME       []byte     `bun:"raw_mime"`
	CreatedAt     time.Time  `bun:"created_at,notnull,default:current_timestamp"`
	UpdatedAt     time.Time  `bun:"updated_at,notnull,default:current_timestamp"`
}

type Attachment struct {
	bun.BaseModel `bun:"table:finance_email_attachments,alias:a"`

	ID          string    `bun:"id,pk,type:uuid,default:gen_random_uuid()"`
	EmailID     string    `bun:"email_id,type:uuid,notnull"`
	Filename    string    `bun:"filename,notnull"`
	ContentType string    `bun:"content_type,notnull"`
	SizeBytes   int64     `bun:"size_bytes,notnull"`
	Content     []byte    `bun:"content"` // nil when over the cap
	CreatedAt   time.Time `bun:"created_at,notnull,default:current_timestamp"`
	// Stored is set by ListAttachments, which skips the content itself.
	Stored bool `bun:"stored,scanonly"`
}

// Line is one receipt line as stored in finance_receipts.line_items. Amounts
// are micros of the receipt currency.
type Line struct {
	Description     string `json:"description"`
	QuantityMicros  *int64 `json:"quantityMicros"`
	UnitPriceMicros *int64 `json:"unitPriceMicros"`
	AmountMicros    *int64 `json:"amountMicros"`
}

// Check is one validation result, stored on the receipt.
type Check struct {
	Key    string `json:"key"`
	OK     bool   `json:"ok"`
	Label  string `json:"label"`
	Detail string `json:"detail"`
}

type Receipt struct {
	bun.BaseModel `bun:"table:finance_receipts,alias:r"`

	ID                  string     `bun:"id,pk,type:uuid,default:gen_random_uuid()"`
	EmailID             *string    `bun:"email_id,type:uuid"`
	VendorID            *string    `bun:"vendor_id"`
	MerchantName        string     `bun:"merchant_name,notnull"`
	InvoiceNumber       string     `bun:"invoice_number,notnull"`
	Kind                string     `bun:"kind,notnull"`
	IssueDate           *time.Time `bun:"issue_date,type:date"`
	ServicePeriodStart  *time.Time `bun:"service_period_start,type:date"`
	ServicePeriodEnd    *time.Time `bun:"service_period_end,type:date"`
	Currency            string     `bun:"currency,notnull"`
	SubtotalMicros      *int64     `bun:"subtotal_micros"`
	TaxMicros           *int64     `bun:"tax_micros"`
	TotalMicros         *int64     `bun:"total_micros"`
	FxRate              *float64   `bun:"fx_rate"`
	FxDate              *time.Time `bun:"fx_date,type:date"`
	Lines               []Line     `bun:"line_items,type:jsonb,notnull"`
	Checks              []Check    `bun:"checks,type:jsonb,notnull"`
	Status              string     `bun:"status,notnull"`
	AttentionReason     string     `bun:"attention_reason,notnull"`
	RejectedReason      string     `bun:"rejected_reason,notnull"`
	Edited              bool       `bun:"edited,notnull"`
	CurrentExtractionID *string    `bun:"current_extraction_id,type:uuid"`
	RejectedAt          *time.Time `bun:"rejected_at"`
	VoidedAt            *time.Time `bun:"voided_at"`
	CreatedAt           time.Time  `bun:"created_at,notnull,default:current_timestamp"`
	UpdatedAt           time.Time  `bun:"updated_at,notnull,default:current_timestamp"`
}

type Extraction struct {
	bun.BaseModel `bun:"table:finance_receipt_extractions,alias:x"`

	ID            string          `bun:"id,pk,type:uuid,default:gen_random_uuid()"`
	EmailID       string          `bun:"email_id,type:uuid,notnull"`
	ReceiptID     *string         `bun:"receipt_id,type:uuid"`
	Version       int             `bun:"version,notnull"`
	ModelID       string          `bun:"model_id,notnull"`
	PromptVersion string          `bun:"prompt_version,notnull"`
	InputTokens   int64           `bun:"input_tokens,notnull"`
	OutputTokens  int64           `bun:"output_tokens,notnull"`
	CostMicros    int64           `bun:"cost_micros,notnull"`
	Extraction    json.RawMessage `bun:"extraction,type:jsonb,notnull"`
	CreatedAt     time.Time       `bun:"created_at,notnull,default:current_timestamp"`
}

type LedgerEntry struct {
	bun.BaseModel `bun:"table:finance_ledger_entries,alias:l"`

	ID                 string     `bun:"id,pk,type:uuid,default:gen_random_uuid()"`
	Direction          string     `bun:"direction,notnull"`
	Source             string     `bun:"source,notnull"`
	SourceRef          string     `bun:"source_ref,notnull"`
	VendorID           string     `bun:"vendor_id,notnull"`
	ReceiptID          *string    `bun:"receipt_id,type:uuid"`
	EmailID            *string    `bun:"email_id,type:uuid"`
	Description        string     `bun:"description,notnull"`
	AmountMicros       int64      `bun:"amount_micros,notnull"`
	Currency           string     `bun:"currency,notnull"`
	AmountUSDMicros    int64      `bun:"amount_usd_micros,notnull"`
	FxRate             *float64   `bun:"fx_rate"`
	FxDate             *time.Time `bun:"fx_date,type:date"`
	ServicePeriodStart *time.Time `bun:"service_period_start,type:date"`
	ServicePeriodEnd   *time.Time `bun:"service_period_end,type:date"`
	BookedDate         time.Time  `bun:"booked_date,type:date,notnull"`
	TenantID           *string    `bun:"tenant_id"`
	Model              *string    `bun:"model"`
	TestMode           bool       `bun:"test_mode,notnull"`
	VoidedAt           *time.Time `bun:"voided_at"`
	CreatedAt          time.Time  `bun:"created_at,notnull,default:current_timestamp"`
	UpdatedAt          time.Time  `bun:"updated_at,notnull,default:current_timestamp"`
	// GroupKey is the Ledger row the entry belongs to (set by report reads).
	GroupKey string `bun:"gkey,scanonly"`
}

type AuditEntry struct {
	bun.BaseModel `bun:"table:finance_audit_log,alias:au"`

	ID         int64           `bun:"id,pk,autoincrement"`
	Actor      string          `bun:"actor,notnull"`
	Action     string          `bun:"action,notnull"`
	EntityType string          `bun:"entity_type,notnull"`
	EntityID   string          `bun:"entity_id,notnull"`
	Before     json.RawMessage `bun:"before,type:jsonb"`
	After      json.RawMessage `bun:"after,type:jsonb"`
	Effect     json.RawMessage `bun:"effect,type:jsonb"`
	CreatedAt  time.Time       `bun:"created_at,notnull,default:current_timestamp"`
}

type SyncState struct {
	bun.BaseModel `bun:"table:finance_sync_state,alias:s"`

	Key           string     `bun:"key,pk"`
	LastAttemptAt *time.Time `bun:"last_attempt_at"`
	LastSuccessAt *time.Time `bun:"last_success_at"`
	LastError     string     `bun:"last_error,notnull"`
	ThroughDate   *time.Time `bun:"through_date,type:date"`
	UpdatedAt     time.Time  `bun:"updated_at,notnull,default:current_timestamp"`
}
