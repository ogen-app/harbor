// Package ogenreceipts is Harbor's gRPC client for Ogen's ReceiptService
// (receipts.v1, CON-415): ProcessReceipt turns one vendor receipt email into
// structured data for the finance ledger (CON-412/420). Ogen fetches the email
// from Resend with its own key and runs the extraction model; it keeps nothing,
// so Harbor stores the raw email, the attachments and every extraction.
//
// Like the other Ogen admin clients it shares OGEN_GRPC_ADDR/OGEN_GRPC_TOKEN and
// is best-effort: an unconfigured client is nil and every method returns
// ErrUnavailable, which the receipt job treats as "retry later".
package ogenreceipts

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"

	receiptsv1 "github.com/ogen-app/harbor/gen/receipts/v1"
)

// ErrUnavailable is returned by every method on a nil (unconfigured) client.
var ErrUnavailable = errors.New("ogen receipt service not configured")

// ProcessReceipt fetches from Resend and runs a model synchronously, so it gets
// far more time than the admin reads.
const defaultTimeout = 2 * time.Minute

// maxMessageBytes is receipts.v1's documented per-service gRPC limit: a
// response carries the raw MIME (≤ 25 MiB) plus every decoded attachment.
const maxMessageBytes = 64 << 20

// Headers are the parsed headers of the received email.
type Headers struct {
	From          string
	To            []string
	Subject       string
	Date          *time.Time
	MessageID     string
	ForwardedFrom string // the original sender when the email is a forward
}

// Attachment is one decoded MIME attachment.
type Attachment struct {
	Filename    string
	ContentType string
	Content     []byte
}

// LineItem is one printed line. Amounts are micros of the receipt currency.
type LineItem struct {
	Description     string `json:"description"`
	QuantityMicros  *int64 `json:"quantityMicros"`
	UnitPriceMicros *int64 `json:"unitPriceMicros"`
	AmountMicros    *int64 `json:"amountMicros"`
}

// Extraction is the model's reading of the receipt, as printed. Kind is
// invoice | receipt | prepayment | refund | credit_note | unknown. It is stored
// as JSON in every extraction version, so the tags are the stored shape.
type Extraction struct {
	Kind               string     `json:"kind"`
	MerchantName       string     `json:"merchantName"`
	DocumentNumber     string     `json:"documentNumber"`
	IssueDate          string     `json:"issueDate"`
	ServicePeriodStart string     `json:"servicePeriodStart"`
	ServicePeriodEnd   string     `json:"servicePeriodEnd"`
	Currency           string     `json:"currency"`
	SubtotalMicros     *int64     `json:"subtotalMicros"`
	TaxMicros          *int64     `json:"taxMicros"`
	TotalMicros        *int64     `json:"totalMicros"`
	LineItems          []LineItem `json:"lineItems"`
	ConfidenceNotes    string     `json:"confidenceNotes"`
}

// Usage is what the extraction cost. CostMicros is USD.
type Usage struct {
	ModelID       string
	PromptVersion string
	InputTokens   int64
	OutputTokens  int64
	CostMicros    int64
}

// Result is one processed email.
type Result struct {
	RawMIME     []byte
	Headers     Headers
	TextBody    string
	HTMLBody    string
	Attachments []Attachment
	Extraction  Extraction
	Usage       Usage
}

// Client wraps the ReceiptService stub. A nil *Client is the unconfigured state.
type Client struct {
	conn    *grpc.ClientConn
	rpc     receiptsv1.ReceiptServiceClient
	timeout time.Duration
}

// New dials Ogen's operator listener. It returns (nil, nil) when addr or token
// is empty. grpc.NewClient connects lazily, so this never blocks on Ogen.
func New(addr, token string) (*Client, error) {
	if addr == "" || token == "" {
		return nil, nil
	}
	conn, err := grpc.NewClient(
		addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithChainUnaryInterceptor(bearerTokenInterceptor(token)),
		grpc.WithDefaultCallOptions(
			grpc.MaxCallRecvMsgSize(maxMessageBytes),
			grpc.MaxCallSendMsgSize(maxMessageBytes),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("ogenreceipts: dial %q: %w", addr, err)
	}
	return &Client{conn: conn, rpc: receiptsv1.NewReceiptServiceClient(conn), timeout: defaultTimeout}, nil
}

func (c *Client) Close() error {
	if c == nil || c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

// ProcessByResendID is the first pass: Ogen fetches the email from Resend.
// gRPC status codes pass through (NotFound: Resend no longer has it;
// InvalidArgument: bad or oversize MIME; Unavailable: retry).
func (c *Client) ProcessByResendID(ctx context.Context, resendEmailID string) (Result, error) {
	return c.process(ctx, &receiptsv1.ProcessReceiptRequest{
		Source: &receiptsv1.ProcessReceiptRequest_ResendEmailId{ResendEmailId: resendEmailID},
	})
}

// ProcessRawMIME re-extracts the copy Harbor stored after the first pass.
func (c *Client) ProcessRawMIME(ctx context.Context, raw []byte) (Result, error) {
	return c.process(ctx, &receiptsv1.ProcessReceiptRequest{
		Source: &receiptsv1.ProcessReceiptRequest_RawMime{RawMime: raw},
	})
}

func (c *Client) process(ctx context.Context, req *receiptsv1.ProcessReceiptRequest) (Result, error) {
	if c == nil {
		return Result{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.ProcessReceipt(ctx, req)
	if err != nil {
		return Result{}, err
	}
	return resultFromProto(resp), nil
}

func resultFromProto(r *receiptsv1.ProcessReceiptResponse) Result {
	h := r.GetHeaders()
	out := Result{
		RawMIME: r.GetRawMime(),
		Headers: Headers{
			From:          h.GetFrom(),
			To:            h.GetTo(),
			Subject:       h.GetSubject(),
			MessageID:     h.GetMessageId(),
			ForwardedFrom: h.GetForwardedFrom(),
		},
		TextBody: r.GetTextBody(),
		HTMLBody: r.GetHtmlBody(),
		Usage: Usage{
			ModelID:       r.GetUsage().GetModelId(),
			PromptVersion: r.GetUsage().GetPromptVersion(),
			InputTokens:   r.GetUsage().GetInputTokens(),
			OutputTokens:  r.GetUsage().GetOutputTokens(),
			CostMicros:    r.GetUsage().GetCostMicros(),
		},
	}
	if h.GetDate() != nil {
		out.Headers.Date = new(h.GetDate().AsTime())
	}
	for _, a := range r.GetAttachments() {
		out.Attachments = append(out.Attachments, Attachment{
			Filename:    a.GetFilename(),
			ContentType: a.GetContentType(),
			Content:     a.GetContent(),
		})
	}
	e := r.GetExtraction()
	out.Extraction = Extraction{
		Kind:               kindFromProto(e.GetKind()),
		MerchantName:       e.GetMerchantName(),
		DocumentNumber:     e.GetDocumentNumber(),
		IssueDate:          e.GetIssueDate(),
		ServicePeriodStart: e.GetServicePeriodStart(),
		ServicePeriodEnd:   e.GetServicePeriodEnd(),
		Currency:           e.GetCurrency(),
		SubtotalMicros:     e.SubtotalMicros,
		TaxMicros:          e.TaxMicros,
		TotalMicros:        e.TotalMicros,
		ConfidenceNotes:    e.GetConfidenceNotes(),
	}
	for _, li := range e.GetLineItems() {
		out.Extraction.LineItems = append(out.Extraction.LineItems, LineItem{
			Description:     li.GetDescription(),
			QuantityMicros:  li.QuantityMicros,
			UnitPriceMicros: li.UnitPriceMicros,
			AmountMicros:    li.AmountMicros,
		})
	}
	return out
}

func kindFromProto(k receiptsv1.ReceiptKind) string {
	switch k {
	case receiptsv1.ReceiptKind_RECEIPT_KIND_INVOICE:
		return "invoice"
	case receiptsv1.ReceiptKind_RECEIPT_KIND_RECEIPT:
		return "receipt"
	case receiptsv1.ReceiptKind_RECEIPT_KIND_PREPAYMENT:
		return "prepayment"
	case receiptsv1.ReceiptKind_RECEIPT_KIND_REFUND:
		return "refund"
	case receiptsv1.ReceiptKind_RECEIPT_KIND_CREDIT_NOTE:
		return "credit_note"
	default:
		return "unknown"
	}
}

// bearerTokenInterceptor injects `authorization: Bearer <token>` into the
// outgoing metadata of every unary call. The token is never logged.
func bearerTokenInterceptor(token string) grpc.UnaryClientInterceptor {
	bearer := "Bearer " + token
	return func(ctx context.Context, method string, req, reply any, cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
		ctx = metadata.AppendToOutgoingContext(ctx, "authorization", bearer)
		return invoker(ctx, method, req, reply, cc, opts...)
	}
}
