// Package ogenbilling is Harbor's gRPC client for Ogen's internal
// BillingAdminService — the operator surface for billing oversight (CON-322/326,
// the Billing screens CON-327): provider settings, the attention list, one
// workspace's billing picture, the comp/exempt flag, resync, the free-month tier
// and the sandbox→live cutover.
//
// Like ogenannouncements (whose listener and shared bearer token this reuses),
// the client is best-effort: an unconfigured (empty addr/token) client is nil and
// every method returns ErrUnavailable, which the handler renders as a soft
// "unavailable" state. The bearer token is injected into outgoing gRPC metadata
// by a client interceptor and is never logged.
//
// Ogen never changes a workspace's tier or status on its own when a payment
// fails ("operator decides"); the DTOs here carry the provider's vocabulary
// through unchanged so the UI shows exactly what Lemon Squeezy reported.
package ogenbilling

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/timestamppb"

	billingv1 "github.com/ogen-app/harbor/gen/billing/v1"
)

// ErrUnavailable is returned by every method on a nil (unconfigured) client.
// Callers treat it as "billing oversight unavailable", not a hard error —
// mirroring the other Ogen admin clients' nil-client contract.
var ErrUnavailable = errors.New("ogen billing-admin service not configured")

const defaultTimeout = 10 * time.Second

// Settings is the provider configuration the console needs to decide what it may
// offer (the cutover is refused in test mode; configured=false means the Lemon
// Squeezy API key or webhook secret is missing).
type Settings struct {
	Provider          string `json:"provider"` // none | lemonsqueezy
	TestMode          bool   `json:"testMode"`
	Configured        bool   `json:"configured"`
	StoreID           string `json:"storeId"`
	TrialTeardownLive bool   `json:"trialTeardownLive"`
}

// Subscription mirrors one provider subscription. Optional instants are
// pointers: nil means unset (e.g. FirstPaidAt nil = never paid).
type Subscription struct {
	ID                     string     `json:"id"`
	Provider               string     `json:"provider"`
	ProviderSubscriptionID string     `json:"providerSubscriptionId"`
	ProviderCustomerID     string     `json:"providerCustomerId"`
	ProviderVariantID      string     `json:"providerVariantId"`
	TierVersionPriceID     string     `json:"tierVersionPriceId"` // '' when unmapped
	TierID                 string     `json:"tierId"`             // '' when unmapped
	TierVersionID          string     `json:"tierVersionId"`      // '' when unmapped
	Status                 string     `json:"status"`             // Lemon Squeezy vocabulary
	TestMode               bool       `json:"testMode"`
	RenewsAt               *time.Time `json:"renewsAt"`
	EndsAt                 *time.Time `json:"endsAt"`
	TrialEndsAt            *time.Time `json:"trialEndsAt"`
	FirstPaidAt            *time.Time `json:"firstPaidAt"`
	CardBrand              string     `json:"cardBrand"`
	CardLastFour           string     `json:"cardLastFour"`
	InvalidatedAt          *time.Time `json:"invalidatedAt"`
	InvalidatedReason      string     `json:"invalidatedReason"`
	TeardownAt             *time.Time `json:"teardownAt"`
	AccountID              string     `json:"accountId"`
	Duplicate              bool       `json:"duplicate"`
	CreatedAt              *time.Time `json:"createdAt"`
	UpdatedAt              *time.Time `json:"updatedAt"`
}

// ScheduledChange is a downgrade that lands at the billing boundary.
type ScheduledChange struct {
	ID                     string     `json:"id"`
	SubscriptionID         string     `json:"subscriptionId"`
	FromTierVersionPriceID string     `json:"fromTierVersionPriceId"`
	ToTierVersionPriceID   string     `json:"toTierVersionPriceId"`
	EffectiveAt            *time.Time `json:"effectiveAt"`
	Status                 string     `json:"status"` // pending | provider_applied | applied | cancelled | failed
	CreatedBy              string     `json:"createdBy"`
	CreatedAt              *time.Time `json:"createdAt"`
}

// WebhookEvent is one entry of Ogen's raw webhook ingest log.
type WebhookEvent struct {
	ID               string     `json:"id"`
	EventName        string     `json:"eventName"`
	ProviderObjectID string     `json:"providerObjectId"`
	TestMode         bool       `json:"testMode"`
	Outcome          string     `json:"outcome"` // applied | stale | ignored_mode | ignored_unknown | failed | duplicate
	Error            string     `json:"error"`
	ReceivedAt       *time.Time `json:"receivedAt"`
	ProcessedAt      *time.Time `json:"processedAt"`
}

// OwnerTrial reports whether a workspace owner may still get the free month.
type OwnerTrial struct {
	UserID        string `json:"userId"`
	AccountID     string `json:"accountId"`
	Email         string `json:"email"`
	TrialEligible bool   `json:"trialEligible"`
}

// TenantBilling is one workspace's billing picture. Gated is the live 402 state
// (billing required and no subscription yet); BillingRequired is the stored flag.
// Complimentary marks a tester's workspace (CON-333): never billed, so
// BillingRequired is always false with it.
type TenantBilling struct {
	TenantID            string            `json:"tenantId"`
	BillingRequired     bool              `json:"billingRequired"`
	Complimentary       bool              `json:"complimentary"`
	Gated               bool              `json:"gated"`
	Subscriptions       []Subscription    `json:"subscriptions"`
	ScheduledChanges    []ScheduledChange `json:"scheduledChanges"`
	RecentWebhookEvents []WebhookEvent    `json:"recentWebhookEvents"`
	Owners              []OwnerTrial      `json:"owners"`
}

// AttentionItem is one reason a workspace needs an operator. Subscription is nil
// for unresolved_webhook (which carries WebhookEvent and no tenant instead).
type AttentionItem struct {
	TenantID       string        `json:"tenantId"`
	TenantName     string        `json:"tenantName"`
	Reason         string        `json:"reason"`
	Subscription   *Subscription `json:"subscription"`
	WebhookEvent   *WebhookEvent `json:"webhookEvent"`
	Since          *time.Time    `json:"since"`
	TeardownStatus string        `json:"teardownStatus"` // '' | dry_run | enqueued
}

// AttentionPage is one page of the attention list. NextPageToken is "" on the
// last page.
type AttentionPage struct {
	Items         []AttentionItem `json:"items"`
	NextPageToken string          `json:"nextPageToken"`
}

// FreeTrialTier describes the marketing free-month offer. TierID "" = off.
type FreeTrialTier struct {
	TierID          string   `json:"tierId"`
	TierName        string   `json:"tierName"`
	TrialDays       int32    `json:"trialDays"`
	EligibleTierIDs []string `json:"eligibleTierIds"`
}

// CutoverResult is the outcome of InvalidateTestSubscriptions (dry run or real).
type CutoverResult struct {
	DryRun    bool     `json:"dryRun"`
	Count     int32    `json:"count"`
	TenantIDs []string `json:"tenantIds"`
}

// Client is a thin, safe wrapper over the generated BillingAdminServiceClient.
type Client struct {
	conn    *grpc.ClientConn
	rpc     billingv1.BillingAdminServiceClient
	timeout time.Duration
}

// New dials Ogen's internal gRPC surface. Enabled only when BOTH addr and token
// are set; either empty returns (nil, nil): a nil client that reports
// ErrUnavailable, so the page degrades softly rather than failing boot.
// grpc.NewClient connects lazily, so this never blocks on Ogen being up.
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
		return nil, fmt.Errorf("ogenbilling: dial %q: %w", addr, err)
	}
	return &Client{conn: conn, rpc: billingv1.NewBillingAdminServiceClient(conn), timeout: defaultTimeout}, nil
}

// Close releases the underlying connection. Safe on a nil client.
func (c *Client) Close() error {
	if c == nil || c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

// Settings reports the billing provider configuration.
func (c *Client) Settings(ctx context.Context) (Settings, error) {
	if c == nil {
		return Settings{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.GetBillingSettings(ctx, &billingv1.GetBillingSettingsRequest{})
	if err != nil {
		return Settings{}, err
	}
	return Settings{
		Provider:          resp.GetProvider(),
		TestMode:          resp.GetTestMode(),
		Configured:        resp.GetConfigured(),
		StoreID:           resp.GetStoreId(),
		TrialTeardownLive: resp.GetTrialTeardownLive(),
	}, nil
}

// Attention returns one page of workspaces needing an operator decision, newest
// first. pageSize is clamped server-side (0 = server default); pageToken is the
// opaque cursor from a prior page ("" for the first).
func (c *Client) Attention(ctx context.Context, pageSize int32, pageToken string) (AttentionPage, error) {
	if c == nil {
		return AttentionPage{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.ListBillingAttention(ctx, &billingv1.ListBillingAttentionRequest{PageSize: pageSize, PageToken: pageToken})
	if err != nil {
		return AttentionPage{}, err
	}
	items := make([]AttentionItem, 0, len(resp.GetItems()))
	for _, it := range resp.GetItems() {
		items = append(items, attentionFromProto(it))
	}
	return AttentionPage{Items: items, NextPageToken: resp.GetNextPageToken()}, nil
}

// TenantBilling returns one workspace's billing picture. NotFound for an
// unknown tenant.
func (c *Client) TenantBilling(ctx context.Context, tenantID string) (TenantBilling, error) {
	if c == nil {
		return TenantBilling{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.GetTenantBilling(ctx, &billingv1.GetTenantBillingRequest{TenantId: tenantID})
	if err != nil {
		return TenantBilling{}, err
	}
	return tenantBillingFromProto(resp.GetBilling()), nil
}

// SetBillingRequired comps/exempts a workspace (required=false) or puts it back
// behind the gate. reason is required (InvalidArgument without it).
func (c *Client) SetBillingRequired(ctx context.Context, tenantID string, required bool, reason string) (TenantBilling, error) {
	if c == nil {
		return TenantBilling{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.SetBillingRequired(ctx, &billingv1.SetBillingRequiredRequest{TenantId: tenantID, Required: required, Reason: reason})
	if err != nil {
		return TenantBilling{}, err
	}
	return tenantBillingFromProto(resp.GetBilling()), nil
}

// SetComplimentary makes a workspace a tester's complimentary one or ends that
// (CON-333): ending it puts the workspace behind the billing gate until it checks
// out. reason is required (InvalidArgument without it).
func (c *Client) SetComplimentary(ctx context.Context, tenantID string, complimentary bool, reason string) (TenantBilling, error) {
	if c == nil {
		return TenantBilling{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.SetComplimentary(ctx, &billingv1.SetComplimentaryRequest{TenantId: tenantID, Complimentary: complimentary, Reason: reason})
	if err != nil {
		return TenantBilling{}, err
	}
	return tenantBillingFromProto(resp.GetBilling()), nil
}

// Resync re-reads the workspace's subscriptions from the provider. corrected is
// the number of subscriptions whose mirror changed.
func (c *Client) Resync(ctx context.Context, tenantID string) (TenantBilling, int32, error) {
	if c == nil {
		return TenantBilling{}, 0, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.ResyncSubscription(ctx, &billingv1.ResyncSubscriptionRequest{TenantId: tenantID})
	if err != nil {
		return TenantBilling{}, 0, err
	}
	return tenantBillingFromProto(resp.GetBilling()), resp.GetCorrected(), nil
}

// FreeTrialTier returns the current free-month offer and the eligible tiers.
func (c *Client) FreeTrialTier(ctx context.Context) (FreeTrialTier, error) {
	if c == nil {
		return FreeTrialTier{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.GetFreeTrialTier(ctx, &billingv1.GetFreeTrialTierRequest{})
	if err != nil {
		return FreeTrialTier{}, err
	}
	return freeTrialFromProto(resp.GetOffer()), nil
}

// SetFreeTrialTier marks exactly one tier as the free-month tier (replacing the
// previous one), or turns the offer off with tierID "". FailedPrecondition when
// the tier lacks a one-month trial variant; reason is required.
func (c *Client) SetFreeTrialTier(ctx context.Context, tierID, reason string) (FreeTrialTier, error) {
	if c == nil {
		return FreeTrialTier{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.SetFreeTrialTier(ctx, &billingv1.SetFreeTrialTierRequest{TierId: tierID, Reason: reason})
	if err != nil {
		return FreeTrialTier{}, err
	}
	return freeTrialFromProto(resp.GetOffer()), nil
}

// InvalidateTestSubscriptions runs the sandbox→live cutover, or only lists the
// affected workspaces when dryRun is set. FailedPrecondition while Ogen still
// runs in test mode.
func (c *Client) InvalidateTestSubscriptions(ctx context.Context, dryRun bool) (CutoverResult, error) {
	if c == nil {
		return CutoverResult{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.InvalidateTestSubscriptions(ctx, &billingv1.InvalidateTestSubscriptionsRequest{DryRun: dryRun})
	if err != nil {
		return CutoverResult{}, err
	}
	ids := resp.GetTenantIds()
	if ids == nil {
		ids = []string{}
	}
	return CutoverResult{DryRun: resp.GetDryRun(), Count: resp.GetCount(), TenantIDs: ids}, nil
}

// ── proto → DTO ────────────────────────────────────────────────────────────────

func subscriptionFromProto(s *billingv1.Subscription) Subscription {
	return Subscription{
		ID:                     s.GetId(),
		Provider:               s.GetProvider(),
		ProviderSubscriptionID: s.GetProviderSubscriptionId(),
		ProviderCustomerID:     s.GetProviderCustomerId(),
		ProviderVariantID:      s.GetProviderVariantId(),
		TierVersionPriceID:     s.GetTierVersionPriceId(),
		TierID:                 s.GetTierId(),
		TierVersionID:          s.GetTierVersionId(),
		Status:                 s.GetStatus(),
		TestMode:               s.GetTestMode(),
		RenewsAt:               timePtr(s.GetRenewsAt()),
		EndsAt:                 timePtr(s.GetEndsAt()),
		TrialEndsAt:            timePtr(s.GetTrialEndsAt()),
		FirstPaidAt:            timePtr(s.GetFirstPaidAt()),
		CardBrand:              s.GetCardBrand(),
		CardLastFour:           s.GetCardLastFour(),
		InvalidatedAt:          timePtr(s.GetInvalidatedAt()),
		InvalidatedReason:      s.GetInvalidatedReason(),
		TeardownAt:             timePtr(s.GetTeardownAt()),
		AccountID:              s.GetAccountId(),
		Duplicate:              s.GetDuplicate(),
		CreatedAt:              timePtr(s.GetCreatedAt()),
		UpdatedAt:              timePtr(s.GetUpdatedAt()),
	}
}

func webhookFromProto(w *billingv1.WebhookEvent) WebhookEvent {
	return WebhookEvent{
		ID:               w.GetId(),
		EventName:        w.GetEventName(),
		ProviderObjectID: w.GetProviderObjectId(),
		TestMode:         w.GetTestMode(),
		Outcome:          w.GetOutcome(),
		Error:            w.GetError(),
		ReceivedAt:       timePtr(w.GetReceivedAt()),
		ProcessedAt:      timePtr(w.GetProcessedAt()),
	}
}

func tenantBillingFromProto(b *billingv1.TenantBilling) TenantBilling {
	out := TenantBilling{
		TenantID:            b.GetTenantId(),
		BillingRequired:     b.GetBillingRequired(),
		Complimentary:       b.GetComplimentary(),
		Gated:               b.GetGated(),
		Subscriptions:       make([]Subscription, 0, len(b.GetSubscriptions())),
		ScheduledChanges:    make([]ScheduledChange, 0, len(b.GetScheduledChanges())),
		RecentWebhookEvents: make([]WebhookEvent, 0, len(b.GetRecentWebhookEvents())),
		Owners:              make([]OwnerTrial, 0, len(b.GetOwners())),
	}
	for _, s := range b.GetSubscriptions() {
		out.Subscriptions = append(out.Subscriptions, subscriptionFromProto(s))
	}
	for _, sc := range b.GetScheduledChanges() {
		out.ScheduledChanges = append(out.ScheduledChanges, ScheduledChange{
			ID:                     sc.GetId(),
			SubscriptionID:         sc.GetSubscriptionId(),
			FromTierVersionPriceID: sc.GetFromTierVersionPriceId(),
			ToTierVersionPriceID:   sc.GetToTierVersionPriceId(),
			EffectiveAt:            timePtr(sc.GetEffectiveAt()),
			Status:                 sc.GetStatus(),
			CreatedBy:              sc.GetCreatedBy(),
			CreatedAt:              timePtr(sc.GetCreatedAt()),
		})
	}
	for _, w := range b.GetRecentWebhookEvents() {
		out.RecentWebhookEvents = append(out.RecentWebhookEvents, webhookFromProto(w))
	}
	for _, o := range b.GetOwners() {
		out.Owners = append(out.Owners, OwnerTrial{
			UserID:        o.GetUserId(),
			AccountID:     o.GetAccountId(),
			Email:         o.GetEmail(),
			TrialEligible: o.GetTrialEligible(),
		})
	}
	return out
}

func attentionFromProto(a *billingv1.AttentionItem) AttentionItem {
	out := AttentionItem{
		TenantID:       a.GetTenantId(),
		TenantName:     a.GetTenantName(),
		Reason:         a.GetReason(),
		Since:          timePtr(a.GetSince()),
		TeardownStatus: a.GetTeardownStatus(),
	}
	if s := a.GetSubscription(); s != nil {
		out.Subscription = new(subscriptionFromProto(s))
	}
	if w := a.GetWebhookEvent(); w != nil {
		out.WebhookEvent = new(webhookFromProto(w))
	}
	return out
}

func freeTrialFromProto(f *billingv1.FreeTrialTier) FreeTrialTier {
	ids := f.GetEligibleTierIds()
	if ids == nil {
		ids = []string{}
	}
	return FreeTrialTier{
		TierID:          f.GetTierId(),
		TierName:        f.GetTierName(),
		TrialDays:       f.GetTrialDays(),
		EligibleTierIDs: ids,
	}
}

// timePtr converts an optional proto timestamp to *time.Time — nil (and the zero
// timestamp Ogen sends for an unset field) both map to nil, so the UI can tell
// "unset" from a real instant.
func timePtr(ts *timestamppb.Timestamp) *time.Time {
	if ts == nil || (ts.GetSeconds() == 0 && ts.GetNanos() == 0) {
		return nil
	}
	return new(ts.AsTime())
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
