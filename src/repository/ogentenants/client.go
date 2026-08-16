// Package ogentenants is Harbor's gRPC client for Ogen's internal
// TenantAdminService — the operator surface for tenant classification (tiers,
// 1 per tenant; groups, many-to-many). This iteration covers the tier/group
// CATALOG (list + create/update/delete); tenant<->tier/group assignment lives
// behind the same service and can be added later.
//
// Like ogensecrets (whose listener and shared bearer token this reuses), the
// client is best-effort: an unconfigured (empty addr/token) client is nil and
// every method returns ErrUnavailable, which the handler renders as a soft
// "unavailable" state. The bearer token is injected into outgoing gRPC metadata
// by a client interceptor and is never logged.
package ogentenants

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"

	tenantsv1 "github.com/ogen-app/harbor/gen/tenants/v1"
)

// ErrUnavailable is returned by every method on a nil (unconfigured) client.
// Callers treat it as "tier/group management unavailable", not a hard error —
// mirroring the ogensecrets nil-client contract.
var ErrUnavailable = errors.New("ogen tenant-admin service not configured")

const defaultTimeout = 10 * time.Second

// Entry is one catalog item — a tier or a group. Both share the same shape in
// the proto (id/name/color/description/timestamps), so Harbor uses one type for
// both surfaces. Color is an optional "#RRGGBB" hex string ("" = none).
type Entry struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Color       string    `json:"color"`
	Description string    `json:"description"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// Client is a thin, safe wrapper over the generated TenantAdminServiceClient.
type Client struct {
	conn    *grpc.ClientConn
	rpc     tenantsv1.TenantAdminServiceClient
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
		return nil, fmt.Errorf("ogentenants: dial %q: %w", addr, err)
	}
	return &Client{conn: conn, rpc: tenantsv1.NewTenantAdminServiceClient(conn), timeout: defaultTimeout}, nil
}

// Close releases the underlying connection. Safe on a nil client.
func (c *Client) Close() error {
	if c == nil || c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

// ── Tiers ────────────────────────────────────────────────────────────────────

func (c *Client) ListTiers(ctx context.Context) ([]Entry, error) {
	if c == nil {
		return nil, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.ListTiers(ctx, &tenantsv1.ListTiersRequest{})
	if err != nil {
		return nil, err
	}
	out := make([]Entry, 0, len(resp.GetTiers()))
	for _, t := range resp.GetTiers() {
		out = append(out, entryFromTier(t))
	}
	return out, nil
}

func (c *Client) CreateTier(ctx context.Context, name, color, description string) (Entry, error) {
	if c == nil {
		return Entry{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.CreateTier(ctx, &tenantsv1.CreateTierRequest{Name: name, Color: color, Description: description})
	if err != nil {
		return Entry{}, err
	}
	return entryFromTier(resp.GetTier()), nil
}

func (c *Client) UpdateTier(ctx context.Context, id, name, color, description string) (Entry, error) {
	if c == nil {
		return Entry{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.UpdateTier(ctx, &tenantsv1.UpdateTierRequest{Id: id, Name: name, Color: color, Description: description})
	if err != nil {
		return Entry{}, err
	}
	return entryFromTier(resp.GetTier()), nil
}

func (c *Client) DeleteTier(ctx context.Context, id string) error {
	if c == nil {
		return ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	_, err := c.rpc.DeleteTier(ctx, &tenantsv1.DeleteTierRequest{Id: id})
	return err
}

// ── Groups ───────────────────────────────────────────────────────────────────

func (c *Client) ListGroups(ctx context.Context) ([]Entry, error) {
	if c == nil {
		return nil, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.ListGroups(ctx, &tenantsv1.ListGroupsRequest{})
	if err != nil {
		return nil, err
	}
	out := make([]Entry, 0, len(resp.GetGroups()))
	for _, g := range resp.GetGroups() {
		out = append(out, entryFromGroup(g))
	}
	return out, nil
}

func (c *Client) CreateGroup(ctx context.Context, name, color, description string) (Entry, error) {
	if c == nil {
		return Entry{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.CreateGroup(ctx, &tenantsv1.CreateGroupRequest{Name: name, Color: color, Description: description})
	if err != nil {
		return Entry{}, err
	}
	return entryFromGroup(resp.GetGroup()), nil
}

func (c *Client) UpdateGroup(ctx context.Context, id, name, color, description string) (Entry, error) {
	if c == nil {
		return Entry{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.UpdateGroup(ctx, &tenantsv1.UpdateGroupRequest{Id: id, Name: name, Color: color, Description: description})
	if err != nil {
		return Entry{}, err
	}
	return entryFromGroup(resp.GetGroup()), nil
}

func (c *Client) DeleteGroup(ctx context.Context, id string) error {
	if c == nil {
		return ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	_, err := c.rpc.DeleteGroup(ctx, &tenantsv1.DeleteGroupRequest{Id: id})
	return err
}

// ── Tenant assignment ────────────────────────────────────────────────────────
// These mutate a single tenant's classification. Reads of the same data go
// straight to the Ogen DB (see repository/ogen); writes go through gRPC so
// Ogen enforces the invariants (tier required, membership idempotent).

// SetTenantTier assigns (or reassigns) the tenant's single tier. Tier is
// required, so there is no "unassign" — this always sets a valid tier id.
func (c *Client) SetTenantTier(ctx context.Context, tenantID, tierID string) error {
	if c == nil {
		return ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	_, err := c.rpc.SetTenantTier(ctx, &tenantsv1.SetTenantTierRequest{TenantId: tenantID, TierId: tierID})
	return err
}

// AddTenantToGroup adds the tenant to a group (idempotent).
func (c *Client) AddTenantToGroup(ctx context.Context, tenantID, groupID string) error {
	if c == nil {
		return ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	_, err := c.rpc.AddTenantToGroup(ctx, &tenantsv1.AddTenantToGroupRequest{TenantId: tenantID, GroupId: groupID})
	return err
}

// RemoveTenantFromGroup removes the tenant from a group (idempotent).
func (c *Client) RemoveTenantFromGroup(ctx context.Context, tenantID, groupID string) error {
	if c == nil {
		return ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	_, err := c.rpc.RemoveTenantFromGroup(ctx, &tenantsv1.RemoveTenantFromGroupRequest{TenantId: tenantID, GroupId: groupID})
	return err
}

// ── tenant lifecycle status (CON-190) ────────────────────────────────────────

// SetTenantStatus drives the whole tenant lifecycle through a single RPC:
// suspend, reactivate, soft-delete, and restore (deleted -> active). status is
// one of active | suspended | deleted; reason is recorded for 'suspended' and
// ignored/cleared otherwise. Idempotent — setting the current status is a
// success no-op. Ogen rejects suspending/deleting the 'default' tenant with
// FailedPrecondition (surfaced to the operator as 409).
func (c *Client) SetTenantStatus(ctx context.Context, tenantID, status, reason string) error {
	if c == nil {
		return ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	_, err := c.rpc.SetTenantStatus(ctx, &tenantsv1.SetTenantStatusRequest{TenantId: tenantID, Status: status, Reason: reason})
	return err
}

func entryFromTier(t *tenantsv1.Tier) Entry {
	if t == nil {
		return Entry{}
	}
	return Entry{
		ID:          t.GetId(),
		Name:        t.GetName(),
		Color:       t.GetColor(),
		Description: t.GetDescription(),
		CreatedAt:   t.GetCreatedAt().AsTime(),
		UpdatedAt:   t.GetUpdatedAt().AsTime(),
	}
}

func entryFromGroup(g *tenantsv1.Group) Entry {
	if g == nil {
		return Entry{}
	}
	return Entry{
		ID:          g.GetId(),
		Name:        g.GetName(),
		Color:       g.GetColor(),
		Description: g.GetDescription(),
		CreatedAt:   g.GetCreatedAt().AsTime(),
		UpdatedAt:   g.GetUpdatedAt().AsTime(),
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
