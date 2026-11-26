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
// fails ("operator decides"). Statuses are Ogen's own subscription statuses,
// whatever the provider; the provider's raw status rides along as
// ProviderStatus so the UI shows exactly what Polar reported.
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
// offer (the mode cutover is refused in test mode; configured=false means the
// Polar access token or webhook secret is missing).
type Settings struct {
	Provider          string `json:"provider"` // none | polar
	TestMode          bool   `json:"testMode"` // Polar sandbox
	Configured        bool   `json:"configured"`
	OrganizationID    string `json:"organizationId"` // the organization of the running mode
	APIVersion        string `json:"apiVersion"`     // the Polar API version requests are pinned to
	TrialTeardownLive bool   `json:"trialTeardownLive"`
}

// Subscription mirrors one provider subscription. Optional instants are
// pointers: nil means unset (e.g. FirstPaidAt nil = never paid).
type Subscription struct {
	ID                     string `json:"id"`
	Provider               string `json:"provider"`
	ProviderSubscriptionID string `json:"providerSubscriptionId"`
	ProviderCustomerID     string `json:"providerCustomerId"`
	ProviderProductID      string `json:"providerProductId"`
	TierVersionPriceID     string `json:"tierVersionPriceId"` // '' when unmapped
	TierID                 string `json:"tierId"`             // '' when unmapped
	TierVersionID          string `json:"tierVersionId"`      // '' when unmapped
	Status                 string `json:"status"`             // Ogen subscription status
	ProviderStatus         string `json:"providerStatus"`     // the provider's raw status, for support
	// PendingProductID is the product a scheduled change moves to at the
	// provider at PendingEffectiveAt; '' when nothing is pending.
	PendingProductID   string     `json:"pendingProductId"`
	PendingEffectiveAt *time.Time `json:"pendingEffectiveAt"`
	// CancelAtPeriodEnd: cancelled by the owner, live until EndsAt.
	CancelAtPeriodEnd bool       `json:"cancelAtPeriodEnd"`
	TestMode          bool       `json:"testMode"`
	RenewsAt          *time.Time `json:"renewsAt"`
	EndsAt            *time.Time `json:"endsAt"`
	TrialEndsAt       *time.Time `json:"trialEndsAt"`
	FirstPaidAt       *time.Time `json:"firstPaidAt"`
	CardBrand         string     `json:"cardBrand"`
	CardLastFour      string     `json:"cardLastFour"`
	InvalidatedAt     *time.Time `json:"invalidatedAt"`
	InvalidatedReason string     `json:"invalidatedReason"`
	TeardownAt        *time.Time `json:"teardownAt"`
	AccountID         string     `json:"accountId"`
	Duplicate         bool       `json:"duplicate"`
	CreatedAt         *time.Time `json:"createdAt"`
	UpdatedAt         *time.Time `json:"updatedAt"`
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
	// TierVersionPriceID is set for unmapped_price: a sellable price with no
	// product (or an archived one) in the current mode (TenantID and TenantName
	// are '' then).
	TierVersionPriceID string `json:"tierVersionPriceId"`
}

// ProductPrice is a product's fixed price in one currency.
type ProductPrice struct {
	Currency    string `json:"currency"`    // ISO 4217
	AmountMinor int64  `json:"amountMinor"` // excluding tax
}

// ProviderProduct is one recurring product of the Polar organization (CON-523).
// A product bills one interval and may carry a fixed price in several
// currencies, so it can sell one price row per currency: MappedPriceIDs.
type ProviderProduct struct {
	ID                 string         `json:"id"`
	Name               string         `json:"name"`
	Interval           string         `json:"interval"`      // month | year
	IntervalCount      int32          `json:"intervalCount"` // billing periods per interval; 1 is the norm
	Prices             []ProductPrice `json:"prices"`
	HasFreeTrial       bool           `json:"hasFreeTrial"`
	TrialInterval      string         `json:"trialInterval"` // day | week | month | year; '' without a trial
	TrialIntervalCount int32          `json:"trialIntervalCount"`
	Archived           bool           `json:"archived"` // an archived product cannot be bought
	TestMode           bool           `json:"testMode"`
	MappedPriceIDs     []string       `json:"mappedPriceIds"`
}

// ProductMapping is one sellable price row, the product that sells it in one
// mode and Ogen's check of the pair. Status is ok | unmapped | product_missing |
// product_archived | price_mismatch | currency_mismatch | interval_mismatch |
// mode_mismatch | trial_missing | unchecked; Message explains every status but
// ok. The row is sold at the product's price in Currency.
type ProductMapping struct {
	TierVersionPriceID string           `json:"tierVersionPriceId"`
	TierID             string           `json:"tierId"`
	TierName           string           `json:"tierName"`
	TierVersionID      string           `json:"tierVersionId"`
	TierVersion        int32            `json:"tierVersion"`
	Interval           string           `json:"interval"`
	NetMinor           int64            `json:"netMinor"` // excluding tax
	Currency           string           `json:"currency"`
	CountryCode        string           `json:"countryCode"` // '' = the currency's default price
	FreeTrialTier      bool             `json:"freeTrialTier"`
	ProductID          string           `json:"productId"` // '' when unmapped
	Product            *ProviderProduct `json:"product"`   // nil when unmapped or unreadable
	Status             string           `json:"status"`
	Message            string           `json:"message"`
	UpdatedAt          *time.Time       `json:"updatedAt"`
	UpdatedBy          string           `json:"updatedBy"`
}

// ProductMappingList is one mode's map. Checked is false when the statuses could
// not come from the provider (that mode's access token is not set, or it is down).
type ProductMappingList struct {
	TestMode bool             `json:"testMode"`
	Checked  bool             `json:"checked"`
	Mappings []ProductMapping `json:"mappings"`
}

// ProductSuggestion pairs an unmapped price row with the one product matching it.
type ProductSuggestion struct {
	TierVersionPriceID string          `json:"tierVersionPriceId"`
	Product            ProviderProduct `json:"product"`
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

// Cutover scopes for InvalidateSubscriptions, as Harbor's REST API names them.
const (
	// ScopeProviderSwitch invalidates every subscription of a provider other
	// than the running one (Lemon Squeezy → Polar). Allowed in either mode.
	ScopeProviderSwitch = "provider_switch"
	// ScopeModeCutover invalidates every test-mode subscription at the
	// sandbox→production switch. Refused while Ogen runs in test mode.
	ScopeModeCutover = "mode_cutover"
)

// CutoverResult is the outcome of InvalidateSubscriptions (dry run or real).
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
		OrganizationID:    resp.GetOrganizationId(),
		APIVersion:        resp.GetApiVersion(),
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
// a mapped price of the tier is sold by a product without a one-month trial;
// reason is required.
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

// InvalidateSubscriptions runs a cutover for scope (ScopeProviderSwitch or
// ScopeModeCutover), or only lists the affected workspaces when dryRun is set.
// InvalidArgument for any other scope; FailedPrecondition for a mode cutover
// while Ogen still runs in test mode.
func (c *Client) InvalidateSubscriptions(ctx context.Context, dryRun bool, scope string) (CutoverResult, error) {
	if c == nil {
		return CutoverResult{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.InvalidateSubscriptions(ctx, &billingv1.InvalidateSubscriptionsRequest{DryRun: dryRun, Scope: scopeToProto(scope)})
	if err != nil {
		return CutoverResult{}, err
	}
	ids := resp.GetTenantIds()
	if ids == nil {
		ids = []string{}
	}
	return CutoverResult{DryRun: resp.GetDryRun(), Count: resp.GetCount(), TenantIDs: ids}, nil
}

// ProviderProducts lists the organization's recurring products in one mode, for
// the mapping picker. FailedPrecondition, with a readable message, when that
// mode cannot be read (its access token is not set).
func (c *Client) ProviderProducts(ctx context.Context, testMode bool) ([]ProviderProduct, error) {
	if c == nil {
		return nil, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.ListProviderProducts(ctx, &billingv1.ListProviderProductsRequest{TestMode: testMode})
	if err != nil {
		return nil, err
	}
	out := make([]ProviderProduct, 0, len(resp.GetProducts()))
	for _, p := range resp.GetProducts() {
		out = append(out, productFromProto(p))
	}
	return out, nil
}

// ProductMappings lists every sellable price row of one mode with its product
// and the check result.
func (c *Client) ProductMappings(ctx context.Context, testMode bool) (ProductMappingList, error) {
	if c == nil {
		return ProductMappingList{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.ListProductMappings(ctx, &billingv1.ListProductMappingsRequest{TestMode: testMode})
	if err != nil {
		return ProductMappingList{}, err
	}
	out := ProductMappingList{
		TestMode: resp.GetTestMode(),
		Checked:  resp.GetChecked(),
		Mappings: make([]ProductMapping, 0, len(resp.GetMappings())),
	}
	for _, m := range resp.GetMappings() {
		out.Mappings = append(out.Mappings, mappingFromProto(m))
	}
	return out, nil
}

// SetProductMapping maps a price row to a product in one mode, or unmaps it with
// productID "". FailedPrecondition, with Ogen's readable message, when the
// product does not match the price or already sells another one in that
// currency; reason is required.
func (c *Client) SetProductMapping(ctx context.Context, priceID string, testMode bool, productID, reason string) (ProductMapping, error) {
	if c == nil {
		return ProductMapping{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.SetProductMapping(ctx, &billingv1.SetProductMappingRequest{
		TierVersionPriceId: priceID,
		TestMode:           testMode,
		ProductId:          productID,
		Reason:             reason,
	})
	if err != nil {
		return ProductMapping{}, err
	}
	return mappingFromProto(resp.GetMapping()), nil
}

// SuggestProductMappings proposes a product for every unmapped price row that
// exactly one free product matches. Nothing is saved.
func (c *Client) SuggestProductMappings(ctx context.Context, testMode bool) ([]ProductSuggestion, error) {
	if c == nil {
		return nil, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.SuggestProductMappings(ctx, &billingv1.SuggestProductMappingsRequest{TestMode: testMode})
	if err != nil {
		return nil, err
	}
	out := make([]ProductSuggestion, 0, len(resp.GetSuggestions()))
	for _, s := range resp.GetSuggestions() {
		out = append(out, ProductSuggestion{TierVersionPriceID: s.GetTierVersionPriceId(), Product: productFromProto(s.GetProduct())})
	}
	return out, nil
}

// Payment is one money movement at the provider (CON-415), for the finance
// ledger's revenue sync (CON-420). Amounts are in minor units of Currency and
// positive for every kind; Kind (order | subscription_invoice | refund |
// chargeback) gives the direction. The *USD fields are US cents: converted by
// Lemon Squeezy itself, or by Ogen at the ECB reference rate of the payment's
// day (FxSource "ecb") for a Polar payment in another currency. They are nil
// while that rate is not known yet, so a caller can tell "not converted" from
// 0. Fee is estimated by Ogen while FeeIsEstimated.
type Payment struct {
	ID                string
	Provider          string
	ProviderID        string // a refund carries the id of the order it reverses
	Kind              string
	TenantID          string
	TierID            string
	ProviderProductID string
	Currency          string
	Subtotal          int64
	Discount          int64
	Tax               int64
	Total             int64
	Refunded          int64
	SubtotalUSD       *int64
	DiscountUSD       *int64
	TaxUSD            *int64
	TotalUSD          *int64
	RefundedUSD       *int64
	Fee               int64
	FeeUSD            *int64
	FeeIsEstimated    bool
	Status            string
	OccurredAt        time.Time
	TestMode          bool
	// FxRate is the USD per unit of Currency the *USD amounts were converted at,
	// as a decimal string ("1" for USD); '' when not converted yet or converted
	// by the provider (Lemon Squeezy). FxSource is identity | ecb | polar and
	// FxDate the rate's day (YYYY-MM-DD), both '' with FxRate.
	FxRate   string
	FxSource string
	FxDate   string
}

// PaymentPage is one keyset page; NextPageToken is ” on the last page.
type PaymentPage struct {
	Payments      []Payment
	NextPageToken string
}

// ListPayments lists the payments that occurred in [from, to) in one mode,
// oldest first. A zero from means "from the first payment", a zero to "now".
func (c *Client) ListPayments(ctx context.Context, from, to time.Time, testMode bool, pageSize int32, pageToken string) (PaymentPage, error) {
	if c == nil {
		return PaymentPage{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	req := &billingv1.ListPaymentsRequest{TestMode: testMode, PageSize: pageSize, PageToken: pageToken}
	if !from.IsZero() {
		req.From = timestamppb.New(from)
	}
	if !to.IsZero() {
		req.To = timestamppb.New(to)
	}
	resp, err := c.rpc.ListPayments(ctx, req)
	if err != nil {
		return PaymentPage{}, err
	}
	out := PaymentPage{Payments: make([]Payment, 0, len(resp.GetPayments())), NextPageToken: resp.GetNextPageToken()}
	for _, p := range resp.GetPayments() {
		out.Payments = append(out.Payments, Payment{
			ID:                p.GetId(),
			Provider:          p.GetProvider(),
			ProviderID:        p.GetProviderId(),
			Kind:              p.GetKind(),
			TenantID:          p.GetTenantId(),
			TierID:            p.GetTierId(),
			ProviderProductID: p.GetProviderProductId(),
			Currency:          p.GetCurrency(),
			Subtotal:          p.GetSubtotal(),
			Discount:          p.GetDiscount(),
			Tax:               p.GetTax(),
			Total:             p.GetTotal(),
			Refunded:          p.GetRefunded(),
			SubtotalUSD:       p.SubtotalUsd,
			DiscountUSD:       p.DiscountUsd,
			TaxUSD:            p.TaxUsd,
			TotalUSD:          p.TotalUsd,
			RefundedUSD:       p.RefundedUsd,
			Fee:               p.GetFee(),
			FeeUSD:            p.FeeUsd,
			FeeIsEstimated:    p.GetFeeIsEstimated(),
			Status:            p.GetStatus(),
			OccurredAt:        p.GetOccurredAt().AsTime(),
			TestMode:          p.GetTestMode(),
			FxRate:            p.GetFxRate(),
			FxSource:          p.GetFxSource(),
			FxDate:            p.GetFxDate(),
		})
	}
	return out, nil
}

// ── proto → DTO ────────────────────────────────────────────────────────────────

func productFromProto(p *billingv1.ProviderProduct) ProviderProduct {
	prices := make([]ProductPrice, 0, len(p.GetPrices()))
	for _, pr := range p.GetPrices() {
		prices = append(prices, ProductPrice{Currency: pr.GetCurrency(), AmountMinor: pr.GetAmountMinor()})
	}
	mapped := p.GetMappedPriceIds()
	if mapped == nil {
		mapped = []string{}
	}
	return ProviderProduct{
		ID:                 p.GetId(),
		Name:               p.GetName(),
		Interval:           p.GetInterval(),
		IntervalCount:      p.GetIntervalCount(),
		Prices:             prices,
		HasFreeTrial:       p.GetHasFreeTrial(),
		TrialInterval:      p.GetTrialInterval(),
		TrialIntervalCount: p.GetTrialIntervalCount(),
		Archived:           p.GetArchived(),
		TestMode:           p.GetTestMode(),
		MappedPriceIDs:     mapped,
	}
}

func mappingFromProto(m *billingv1.ProductMapping) ProductMapping {
	out := ProductMapping{
		TierVersionPriceID: m.GetTierVersionPriceId(),
		TierID:             m.GetTierId(),
		TierName:           m.GetTierName(),
		TierVersionID:      m.GetTierVersionId(),
		TierVersion:        m.GetTierVersion(),
		Interval:           m.GetInterval(),
		NetMinor:           m.GetNetMinor(),
		Currency:           m.GetCurrency(),
		CountryCode:        m.GetCountryCode(),
		FreeTrialTier:      m.GetFreeTrialTier(),
		ProductID:          m.GetProductId(),
		Status:             m.GetStatus(),
		Message:            m.GetMessage(),
		UpdatedAt:          timePtr(m.GetUpdatedAt()),
		UpdatedBy:          m.GetUpdatedBy(),
	}
	if p := m.GetProduct(); p != nil {
		out.Product = new(productFromProto(p))
	}
	return out
}

func subscriptionFromProto(s *billingv1.Subscription) Subscription {
	return Subscription{
		ID:                     s.GetId(),
		Provider:               s.GetProvider(),
		ProviderSubscriptionID: s.GetProviderSubscriptionId(),
		ProviderCustomerID:     s.GetProviderCustomerId(),
		ProviderProductID:      s.GetProviderProductId(),
		TierVersionPriceID:     s.GetTierVersionPriceId(),
		TierID:                 s.GetTierId(),
		TierVersionID:          s.GetTierVersionId(),
		Status:                 s.GetStatus(),
		ProviderStatus:         s.GetProviderStatus(),
		PendingProductID:       s.GetPendingProductId(),
		PendingEffectiveAt:     timePtr(s.GetPendingEffectiveAt()),
		CancelAtPeriodEnd:      s.GetCancelAtPeriodEnd(),
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
		TenantID:           a.GetTenantId(),
		TenantName:         a.GetTenantName(),
		Reason:             a.GetReason(),
		Since:              timePtr(a.GetSince()),
		TeardownStatus:     a.GetTeardownStatus(),
		TierVersionPriceID: a.GetTierVersionPriceId(),
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

// scopeToProto maps a REST cutover scope to the proto enum; anything else is
// UNSPECIFIED, which Ogen refuses with InvalidArgument.
func scopeToProto(scope string) billingv1.InvalidationScope {
	switch scope {
	case ScopeProviderSwitch:
		return billingv1.InvalidationScope_INVALIDATION_SCOPE_PROVIDER_SWITCH
	case ScopeModeCutover:
		return billingv1.InvalidationScope_INVALIDATION_SCOPE_MODE_CUTOVER
	default:
		return billingv1.InvalidationScope_INVALIDATION_SCOPE_UNSPECIFIED
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
