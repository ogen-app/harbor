// Package ogenemail is Harbor's gRPC client for Ogen's internal
// EmailAdminService — the operator surface for READING a tenant's
// transactional/marketing email history and per-email detail (CON-298), powering
// Harbor's /tenants/{id} Emails tab (CON-192).
//
// Like ogensecrets/ogentenants/ogenplatforms/ogenplans (whose listener and
// shared bearer token this reuses), the client is best-effort: an unconfigured
// (empty addr/token) client is nil and every method returns ErrUnavailable,
// which the handler renders as a soft "unavailable" state rather than failing
// boot. The bearer token is injected into outgoing gRPC metadata by a client
// interceptor and is never logged.
//
// Harbor has no access to the Resend API key (ogen's SecretsService is
// write-only), so all Resend-sourced data is served through ogen: the list +
// engagement rollups come from email_logs, the delivery/open/click timeline from
// email_events, and the rendered body is fetched live from Resend on
// GetTenantEmail. When that live fetch is unavailable, EmailDetail.BodyAvailable
// is false and the body fields are empty; the summary + timeline still return.
package ogenemail

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/timestamppb"

	emailv1 "github.com/ogen-app/harbor/gen/email/v1"
)

// ErrUnavailable is returned by every method on a nil (unconfigured) client.
// Callers treat it as "email history unavailable", not a hard error — mirroring
// the ogensecrets/ogentenants/ogenplatforms/ogenplans nil-client contract.
var ErrUnavailable = errors.New("ogen email-admin service not configured")

const defaultTimeout = 10 * time.Second

// EmailSummary is one email_logs row plus its denormalised engagement rollup —
// enough to render the list without touching Resend.
type EmailSummary struct {
	ID          string     `json:"id"`
	TenantID    string     `json:"tenantId"`
	ToEmail     string     `json:"toEmail"`
	TemplateID  string     `json:"templateId"`
	Kind        string     `json:"kind"` // transactional | marketing
	Status      string     `json:"status"`
	LastEvent   string     `json:"lastEvent"`   // most recent Resend event type ('' if none yet)
	LastEventAt *time.Time `json:"lastEventAt"` // nil until the first event
	OpensCount  int32      `json:"opensCount"`
	ClicksCount int32      `json:"clicksCount"`
	Error       string     `json:"error"` // provider error for terminal failures ('' otherwise)
	CreatedAt   time.Time  `json:"createdAt"`
}

// EmailEvent is one persisted Resend webhook event (the append-only timeline).
type EmailEvent struct {
	Type       string    `json:"type"` // delivered | opened | clicked | delivery_delayed | bounced | complained
	OccurredAt time.Time `json:"occurredAt"`
}

// EmailDetail is a summary plus the rendered body (live from Resend) and the
// full persisted event timeline. EmailSummary is embedded so its fields marshal
// inline — the UI reads one flat object for both list rows and detail.
type EmailDetail struct {
	EmailSummary

	// Rendered body, fetched live from Resend GET /emails/{id}. BodyAvailable is
	// false when the Resend key is unset or the fetch failed; the fields below are
	// then empty.
	BodyAvailable bool     `json:"bodyAvailable"`
	Subject       string   `json:"subject"`
	HTML          string   `json:"html"`
	Text          string   `json:"text"`
	From          string   `json:"from"`
	ReplyTo       string   `json:"replyTo"`
	CC            []string `json:"cc"`
	BCC           []string `json:"bcc"`

	// Persisted timeline (from email_events), oldest first.
	Events []EmailEvent `json:"events"`
}

// EmailFilter narrows a ListTenantEmails query. All fields are optional; an empty
// field is "any".
type EmailFilter struct {
	Status          []string // any-of match; empty = any status
	Kind            string   // transactional | marketing; empty = any
	RecipientSubstr string   // case-insensitive substring match on to_email
}

// Client is a thin, safe wrapper over the generated EmailAdminServiceClient.
type Client struct {
	conn    *grpc.ClientConn
	rpc     emailv1.EmailAdminServiceClient
	timeout time.Duration
}

// New dials Ogen's internal gRPC surface. Enabled only when BOTH addr and token
// are set (matching Ogen's server, which starts only when both are configured);
// either empty returns (nil, nil): a nil client that reports ErrUnavailable, so
// the tab degrades softly rather than failing boot. grpc.NewClient connects
// lazily, so this never blocks on Ogen being up.
func New(addr, token string) (*Client, error) {
	if addr == "" || token == "" {
		return nil, nil
	}
	conn, err := grpc.NewClient(
		addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithChainUnaryInterceptor(bearerTokenInterceptor(token)),
	)
	if err != nil {
		return nil, fmt.Errorf("ogenemail: dial %q: %w", addr, err)
	}
	return &Client{conn: conn, rpc: emailv1.NewEmailAdminServiceClient(conn), timeout: defaultTimeout}, nil
}

// Close releases the underlying connection. Safe on a nil client.
func (c *Client) Close() error {
	if c == nil || c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

// ListTenantEmails returns one tenant's emails (newest first, keyset-paginated)
// plus the opaque cursor for the next page (” when there are no more). tenant_id
// is authoritative server-side scoping in Ogen.
func (c *Client) ListTenantEmails(ctx context.Context, tenantID string, pageSize int32, pageToken string, filter EmailFilter) ([]EmailSummary, string, error) {
	if c == nil {
		return nil, "", ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.ListTenantEmails(ctx, &emailv1.ListTenantEmailsRequest{
		TenantId:  tenantID,
		PageSize:  pageSize,
		PageToken: pageToken,
		Filter: &emailv1.EmailFilter{
			Status:          filter.Status,
			Kind:            filter.Kind,
			RecipientSubstr: filter.RecipientSubstr,
		},
	})
	if err != nil {
		return nil, "", err
	}
	out := make([]EmailSummary, 0, len(resp.GetEmails()))
	for _, e := range resp.GetEmails() {
		out = append(out, summaryFromProto(e))
	}
	return out, resp.GetNextPageToken(), nil
}

// GetTenantEmail returns one email's summary + persisted event timeline + the
// rendered body fetched live from Resend. When the body can't be fetched,
// BodyAvailable is false and the body fields are empty.
func (c *Client) GetTenantEmail(ctx context.Context, tenantID, emailID string) (EmailDetail, error) {
	if c == nil {
		return EmailDetail{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.GetTenantEmail(ctx, &emailv1.GetTenantEmailRequest{
		TenantId: tenantID,
		EmailId:  emailID,
	})
	if err != nil {
		return EmailDetail{}, err
	}
	return detailFromProto(resp.GetEmail()), nil
}

// NotifyOperatorsTenantRegistered asks Ogen to send the admin_tenant_registered
// notification email to the given operator recipients for a newly-registered
// tenant (CON-229). Ogen re-loads the tenant (authoritative), renders the
// template, and enqueues one durable send per recipient; it returns how many
// were enqueued. Recipient trim/lower/dedupe happens server-side, so the caller
// may pass the raw operator set.
func (c *Client) NotifyOperatorsTenantRegistered(ctx context.Context, tenantID string, recipients []string) (int, error) {
	if c == nil {
		return 0, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.NotifyOperatorsTenantRegistered(ctx, &emailv1.NotifyOperatorsTenantRegisteredRequest{
		TenantId:        tenantID,
		RecipientEmails: recipients,
	})
	if err != nil {
		return 0, err
	}
	return int(resp.GetEnqueued()), nil
}

// ── proto -> JSON conversion ─────────────────────────────────────────────────

// summaryFromProto maps a proto EmailSummary to the JSON shape the UI holds,
// normalising the optional last_event_at timestamp.
func summaryFromProto(e *emailv1.EmailSummary) EmailSummary {
	if e == nil {
		return EmailSummary{}
	}
	return EmailSummary{
		ID:          e.GetId(),
		TenantID:    e.GetTenantId(),
		ToEmail:     e.GetToEmail(),
		TemplateID:  e.GetTemplateId(),
		Kind:        e.GetKind(),
		Status:      e.GetStatus(),
		LastEvent:   e.GetLastEvent(),
		LastEventAt: optTime(e.GetLastEventAt()),
		OpensCount:  e.GetOpensCount(),
		ClicksCount: e.GetClicksCount(),
		Error:       e.GetError(),
		CreatedAt:   e.GetCreatedAt().AsTime(),
	}
}

// detailFromProto maps a proto EmailDetail to its JSON shape, always emitting
// non-nil slices so clients can index cc/bcc/events without a null guard.
func detailFromProto(d *emailv1.EmailDetail) EmailDetail {
	if d == nil {
		return EmailDetail{Events: []EmailEvent{}, CC: []string{}, BCC: []string{}}
	}
	events := make([]EmailEvent, 0, len(d.GetEvents()))
	for _, ev := range d.GetEvents() {
		events = append(events, EmailEvent{
			Type:       ev.GetType(),
			OccurredAt: ev.GetOccurredAt().AsTime(),
		})
	}
	cc := d.GetCc()
	if cc == nil {
		cc = []string{}
	}
	bcc := d.GetBcc()
	if bcc == nil {
		bcc = []string{}
	}
	return EmailDetail{
		EmailSummary:  summaryFromProto(d.GetSummary()),
		BodyAvailable: d.GetBodyAvailable(),
		Subject:       d.GetSubject(),
		HTML:          d.GetHtml(),
		Text:          d.GetText(),
		From:          d.GetFrom(),
		ReplyTo:       d.GetReplyTo(),
		CC:            cc,
		BCC:           bcc,
		Events:        events,
	}
}

// optTime maps an unset proto timestamp to a nil *time.Time (JSON null) rather
// than the zero epoch, so "no event yet" reads cleanly.
func optTime(ts *timestamppb.Timestamp) *time.Time {
	if ts == nil {
		return nil
	}
	t := ts.AsTime()
	return &t
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
