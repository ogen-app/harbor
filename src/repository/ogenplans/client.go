// Package ogenplans is Harbor's gRPC client for Ogen's internal
// PlanAdminService — the operator surface for VERSIONED tier entitlements
// (CON-243/CON-294): authoring immutable tier versions (draft → active →
// retired), their price + entitlement snapshots, and binding a tenant to a
// specific version.
//
// Like ogensecrets/ogentenants/ogenplatforms (whose listener and shared bearer
// token this reuses), the client is best-effort: an unconfigured (empty
// addr/token) client is nil and every method returns ErrUnavailable, which the
// handler renders as a soft "unavailable" state. The bearer token is injected
// into outgoing gRPC metadata by a client interceptor and is never logged.
//
// A published (active or retired) version is immutable in Ogen; the only writes
// are: create a draft, replace a draft's body, publish, retire (optionally
// reassigning live tenants first), delete a draft, and assign a tenant. The
// entitlements blob is a proto Struct on the wire and a
// map[string]any here — a numeric value, a bool, or nil for an unlimited
// numeric — matching the feature catalog's value_type.
package ogenplans

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	plansv1 "github.com/ogen-app/harbor/gen/plans/v1"
)

// ErrUnavailable is returned by every method on a nil (unconfigured) client.
// Callers treat it as "tier-entitlement management unavailable", not a hard
// error — mirroring the ogensecrets/ogentenants/ogenplatforms nil-client
// contract.
var ErrUnavailable = errors.New("ogen plan-admin service not configured")

const defaultTimeout = 10 * time.Second

// TierVersion is one immutable pricing + entitlement snapshot of a tier. The
// JSON shape round-trips through the UI: List/Get return it, and the draft
// editor sends Purchasable + Entitlements + Prices back on Update.
type TierVersion struct {
	ID                  string         `json:"id"`
	TierID              string         `json:"tierId"`
	Version             int32          `json:"version"`
	Status              string         `json:"status"` // draft | active | retired
	Purchasable         bool           `json:"purchasable"`
	ChangeReason        string         `json:"changeReason"`
	Entitlements        map[string]any `json:"entitlements"` // feature key -> number | bool | null (unlimited)
	Prices              []Price        `json:"prices"`
	LiveAssignmentCount int32          `json:"liveAssignmentCount"`
	CreatedAt           time.Time      `json:"createdAt"`
	PublishedAt         *time.Time     `json:"publishedAt"` // nil while draft
	RetiredAt           *time.Time     `json:"retiredAt"`   // nil unless retired
}

// Price is one net (VAT-exclusive) price in ISO-4217 minor units. CountryCode
// "" is the default price for the currency/interval.
type Price struct {
	Currency        string `json:"currency"`
	BillingInterval string `json:"billingInterval"` // month | year
	NetMinor        int64  `json:"netMinor"`        // minor units, e.g. cents
	CountryCode     string `json:"countryCode"`
}

// Feature is one entry of the engineering-owned entitlement catalog — the valid
// keys plus their type/metadata, so the UI renders rows without hardcoding.
type Feature struct {
	Key         string `json:"key"`
	Name        string `json:"name"`
	Category    string `json:"category"`
	LinearIssue string `json:"linearIssue"`
	Status      string `json:"status"`    // live | in_progress | flag_off | planned
	ValueType   string `json:"valueType"` // numeric | boolean
	IsMaterial  bool   `json:"isMaterial"`
	Reset       string `json:"reset"` // numeric only: standing | monthly | total | per_post
	Description string `json:"description"`
}

// VersionAssignment is one tenant's live (open-ended) assignment on a version —
// the enumerated form behind TierVersion.LiveAssignmentCount, used to name the
// tenants blocking a retire.
type VersionAssignment struct {
	TenantID   string    `json:"tenantId"`
	TenantName string    `json:"tenantName"`
	ValidFrom  time.Time `json:"validFrom"`
}

// Client is a thin, safe wrapper over the generated PlanAdminServiceClient.
type Client struct {
	conn    *grpc.ClientConn
	rpc     plansv1.PlanAdminServiceClient
	timeout time.Duration
}

// New dials Ogen's internal gRPC surface. Enabled only when BOTH addr and token
// are set (matching Ogen's server, which starts only when both are configured);
// either empty returns (nil, nil): a nil client that reports ErrUnavailable, so
// the page degrades softly rather than failing boot. grpc.NewClient connects
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
		return nil, fmt.Errorf("ogenplans: dial %q: %w", addr, err)
	}
	return &Client{conn: conn, rpc: plansv1.NewPlanAdminServiceClient(conn), timeout: defaultTimeout}, nil
}

// Close releases the underlying connection. Safe on a nil client.
func (c *Client) Close() error {
	if c == nil || c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

// ── Reads ──────────────────────────────────────────────────────────────────

// ListFeatures returns the engineering-owned feature catalog (the matrix rows).
func (c *Client) ListFeatures(ctx context.Context) ([]Feature, error) {
	if c == nil {
		return nil, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.ListFeatures(ctx, &plansv1.ListFeaturesRequest{})
	if err != nil {
		return nil, err
	}
	out := make([]Feature, 0, len(resp.GetFeatures()))
	for _, f := range resp.GetFeatures() {
		out = append(out, featureFromProto(f))
	}
	return out, nil
}

// ListTierVersions returns every version of one tier (all statuses), newest
// version first, each with its prices and live-assignment count.
func (c *Client) ListTierVersions(ctx context.Context, tierID string) ([]TierVersion, error) {
	if c == nil {
		return nil, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.ListTierVersions(ctx, &plansv1.ListTierVersionsRequest{TierId: tierID})
	if err != nil {
		return nil, err
	}
	out := make([]TierVersion, 0, len(resp.GetVersions()))
	for _, v := range resp.GetVersions() {
		out = append(out, versionFromProto(v))
	}
	return out, nil
}

// GetTierVersion returns one version with its prices and live-assignment count.
func (c *Client) GetTierVersion(ctx context.Context, id string) (TierVersion, error) {
	if c == nil {
		return TierVersion{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.GetTierVersion(ctx, &plansv1.GetTierVersionRequest{Id: id})
	if err != nil {
		return TierVersion{}, err
	}
	return versionFromProto(resp.GetVersion()), nil
}

// GetTenantEntitlements resolves the version + entitlements in force for a
// tenant right now.
func (c *Client) GetTenantEntitlements(ctx context.Context, tenantID string) (TierVersion, error) {
	if c == nil {
		return TierVersion{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.GetTenantEntitlements(ctx, &plansv1.GetTenantEntitlementsRequest{TenantId: tenantID})
	if err != nil {
		return TierVersion{}, err
	}
	return versionFromProto(resp.GetVersion()), nil
}

// ── Version authoring ──────────────────────────────────────────────────────

// DraftBody is the mutable payload of a draft version — what the editor sends
// on create/update. CloneFromVersionID (create only) seeds entitlements +
// prices from an existing version.
type DraftBody struct {
	Purchasable        bool           `json:"purchasable"`
	Entitlements       map[string]any `json:"entitlements"`
	Prices             []Price        `json:"prices"`
	CloneFromVersionID string         `json:"cloneFromVersionId"`
}

// CreateTierVersion creates a DRAFT version for a tier (version = the tier's
// current max + 1), optionally cloning an existing version as the starting
// point.
func (c *Client) CreateTierVersion(ctx context.Context, tierID string, body DraftBody) (TierVersion, error) {
	if c == nil {
		return TierVersion{}, ErrUnavailable
	}
	ent, err := structFromMap(body.Entitlements)
	if err != nil {
		return TierVersion{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.CreateTierVersion(ctx, &plansv1.CreateTierVersionRequest{
		TierId:             tierID,
		Purchasable:        body.Purchasable,
		Entitlements:       ent,
		Prices:             pricesToProto(body.Prices),
		CloneFromVersionId: body.CloneFromVersionID,
	})
	if err != nil {
		return TierVersion{}, err
	}
	return versionFromProto(resp.GetVersion()), nil
}

// UpdateTierVersionDraft replaces the mutable body (purchasable + entitlements +
// prices) of a DRAFT version. Ogen rejects this with FailedPrecondition once the
// version is published.
func (c *Client) UpdateTierVersionDraft(ctx context.Context, id string, body DraftBody) (TierVersion, error) {
	if c == nil {
		return TierVersion{}, ErrUnavailable
	}
	ent, err := structFromMap(body.Entitlements)
	if err != nil {
		return TierVersion{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.UpdateTierVersionDraft(ctx, &plansv1.UpdateTierVersionDraftRequest{
		Id:           id,
		Purchasable:  body.Purchasable,
		Entitlements: ent,
		Prices:       pricesToProto(body.Prices),
	})
	if err != nil {
		return TierVersion{}, err
	}
	return versionFromProto(resp.GetVersion()), nil
}

// PublishTierVersion transitions a draft to active. Ogen returns InvalidArgument
// if changeReason is empty.
func (c *Client) PublishTierVersion(ctx context.Context, id, changeReason string) (TierVersion, error) {
	if c == nil {
		return TierVersion{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.PublishTierVersion(ctx, &plansv1.PublishTierVersionRequest{Id: id, ChangeReason: changeReason})
	if err != nil {
		return TierVersion{}, err
	}
	return versionFromProto(resp.GetVersion()), nil
}

// RetireResult is the outcome of a retire: the now-retired version plus the
// number of tenants migrated when a reassignment target was supplied (0
// otherwise).
type RetireResult struct {
	Version         TierVersion `json:"version"`
	ReassignedCount int32       `json:"reassignedCount"`
}

// RetireTierVersion transitions an active version to retired (CON-297). When
// live assignments remain, Ogen refuses with FailedPrecondition and names the
// blocking tenants, unless the operator either supplies reassignToVersionID
// (migrate them onto another active version, atomic with the retire) or sets
// force (grandfather them onto the now-retired version). force and
// reassignToVersionID are mutually exclusive — Ogen rejects both together with
// InvalidArgument.
func (c *Client) RetireTierVersion(ctx context.Context, id string, force bool, reassignToVersionID string) (RetireResult, error) {
	if c == nil {
		return RetireResult{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.RetireTierVersion(ctx, &plansv1.RetireTierVersionRequest{
		Id:                  id,
		Force:               force,
		ReassignToVersionId: reassignToVersionID,
	})
	if err != nil {
		return RetireResult{}, err
	}
	return RetireResult{
		Version:         versionFromProto(resp.GetVersion()),
		ReassignedCount: resp.GetReassignedCount(),
	}, nil
}

// DeleteTierVersion hard-deletes a DRAFT version and its price rows (CON-297).
// Ogen returns FailedPrecondition for a published (active/retired) version —
// those are immutable audit artifacts — and NotFound for an unknown id.
func (c *Client) DeleteTierVersion(ctx context.Context, id string) error {
	if c == nil {
		return ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	_, err := c.rpc.DeleteTierVersion(ctx, &plansv1.DeleteTierVersionRequest{Id: id})
	return err
}

// ListTierVersionAssignments enumerates the tenants currently holding a live
// (open-ended) assignment on a version (CON-297) — the enumerated form of
// TierVersion.LiveAssignmentCount, driving the reassignment picker before a
// retire. limit/offset page the result; a 0 limit lets Ogen clamp to its
// default. Returns the page plus the total live-assignment count.
func (c *Client) ListTierVersionAssignments(ctx context.Context, versionID string, limit, offset int32) ([]VersionAssignment, int32, error) {
	if c == nil {
		return nil, 0, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.ListTierVersionAssignments(ctx, &plansv1.ListTierVersionAssignmentsRequest{
		TierVersionId: versionID,
		Limit:         limit,
		Offset:        offset,
	})
	if err != nil {
		return nil, 0, err
	}
	out := make([]VersionAssignment, 0, len(resp.GetAssignments()))
	for _, a := range resp.GetAssignments() {
		out = append(out, versionAssignmentFromProto(a))
	}
	return out, resp.GetTotal(), nil
}

// ── Tenant assignment ──────────────────────────────────────────────────────

// SetTenantTierVersion binds a tenant to a specific version. reason is the
// assignment reason (upgrade | downgrade | migration_accepted | grandfathered |
// …). Returns the version now in force.
func (c *Client) SetTenantTierVersion(ctx context.Context, tenantID, tierVersionID, reason string) (TierVersion, error) {
	if c == nil {
		return TierVersion{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.SetTenantTierVersion(ctx, &plansv1.SetTenantTierVersionRequest{
		TenantId:      tenantID,
		TierVersionId: tierVersionID,
		Reason:        reason,
	})
	if err != nil {
		return TierVersion{}, err
	}
	return versionFromProto(resp.GetVersion()), nil
}

// ── proto <-> JSON conversion ──────────────────────────────────────────────

// versionFromProto maps a proto TierVersion to the JSON shape the UI holds,
// normalising the optional entitlements Struct and unset timestamps.
func versionFromProto(v *plansv1.TierVersion) TierVersion {
	if v == nil {
		return TierVersion{}
	}
	prices := make([]Price, 0, len(v.GetPrices()))
	for _, p := range v.GetPrices() {
		prices = append(prices, Price{
			Currency:        p.GetCurrency(),
			BillingInterval: p.GetBillingInterval(),
			NetMinor:        p.GetNetMinor(),
			CountryCode:     p.GetCountryCode(),
		})
	}
	// Always a non-nil map (like prices, an empty slice): the proto entitlements
	// field is optional, and emitting JSON null here would break clients that
	// index it. An omitted field becomes {}.
	ent := map[string]any{}
	if s := v.GetEntitlements(); s != nil {
		ent = s.AsMap() // numbers -> float64, unlimited -> nil, bool -> bool
	}
	return TierVersion{
		ID:                  v.GetId(),
		TierID:              v.GetTierId(),
		Version:             v.GetVersion(),
		Status:              v.GetStatus(),
		Purchasable:         v.GetPurchasable(),
		ChangeReason:        v.GetChangeReason(),
		Entitlements:        ent,
		Prices:              prices,
		LiveAssignmentCount: v.GetLiveAssignmentCount(),
		CreatedAt:           v.GetCreatedAt().AsTime(),
		PublishedAt:         optTime(v.GetPublishedAt()),
		RetiredAt:           optTime(v.GetRetiredAt()),
	}
}

// versionAssignmentFromProto maps a proto VersionAssignment to its JSON shape.
func versionAssignmentFromProto(a *plansv1.VersionAssignment) VersionAssignment {
	if a == nil {
		return VersionAssignment{}
	}
	return VersionAssignment{
		TenantID:   a.GetTenantId(),
		TenantName: a.GetTenantName(),
		ValidFrom:  a.GetValidFrom().AsTime(),
	}
}

// featureFromProto maps one proto catalog Feature to its JSON shape.
func featureFromProto(f *plansv1.Feature) Feature {
	if f == nil {
		return Feature{}
	}
	return Feature{
		Key:         f.GetKey(),
		Name:        f.GetName(),
		Category:    f.GetCategory(),
		LinearIssue: f.GetLinearIssue(),
		Status:      f.GetStatus(),
		ValueType:   f.GetValueType(),
		IsMaterial:  f.GetIsMaterial(),
		Reset:       f.GetReset_(),
		Description: f.GetDescription(),
	}
}

// pricesToProto maps the JSON price rows a draft carries to their proto form.
func pricesToProto(prices []Price) []*plansv1.Price {
	if len(prices) == 0 {
		return nil
	}
	out := make([]*plansv1.Price, 0, len(prices))
	for _, p := range prices {
		out = append(out, &plansv1.Price{
			Currency:        p.Currency,
			BillingInterval: p.BillingInterval,
			NetMinor:        p.NetMinor,
			CountryCode:     p.CountryCode,
		})
	}
	return out
}

// structFromMap builds a proto Struct for the entitlements blob. A nil map is
// sent as an empty Struct (never nil), so "clear all entitlements" is
// expressible. structpb accepts float64/bool/nil/string values, which is
// exactly what the catalog's numeric/boolean/unlimited cells decode to.
func structFromMap(m map[string]any) (*structpb.Struct, error) {
	if m == nil {
		m = map[string]any{}
	}
	s, err := structpb.NewStruct(m)
	if err != nil {
		return nil, fmt.Errorf("ogenplans: invalid entitlements: %w", err)
	}
	return s, nil
}

// optTime maps an unset proto timestamp to a nil *time.Time (JSON null) rather
// than the zero epoch, so "not published" / "not retired" read cleanly.
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
