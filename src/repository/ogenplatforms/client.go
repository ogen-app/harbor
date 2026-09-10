// Package ogenplatforms is Harbor's gRPC client for Ogen's internal
// PlatformAdminService — the operator surface for the publishable
// social-platform catalog and its per-platform media/text limits (CON-292/293).
// This iteration covers the read path (list the whole catalog, including
// disabled platforms); the catalog writes and the global-limits panel live
// behind the same service and land in later iterations.
//
// Like ogensecrets/ogentenants (whose listener and shared bearer token this
// reuses), the client is best-effort: an unconfigured (empty addr/token) client
// is nil and every method returns ErrUnavailable, which the handler renders as
// a soft "unavailable" state. The bearer token is injected into outgoing gRPC
// metadata by a client interceptor and is never logged.
package ogenplatforms

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"

	platformsv1 "github.com/ogen-app/harbor/gen/platforms/v1"
)

// ErrUnavailable is returned by every method on a nil (unconfigured) client.
// Callers treat it as "platform management unavailable", not a hard error —
// mirroring the ogensecrets/ogentenants nil-client contract.
var ErrUnavailable = errors.New("ogen platform-admin service not configured")

const defaultTimeout = 10 * time.Second

// Platform is the non-proto view of one catalog entry the UI's list needs. The
// per-media constraint sub-messages (image/video/pdf/text) are intentionally
// omitted here — they drive the edit form, a later iteration — while identity,
// post types, ordering, and read-only usage are carried so the list can render
// name+icon, the enabled state, the Zernio slug, post-type count, and the
// connected-accounts / scheduled-posts guards.
type Platform struct {
	ID                 string            `json:"id"`
	Name               string            `json:"name"`
	ZernioID           string            `json:"zernioId"`
	Enabled            bool              `json:"enabled"`
	ConnectSupported   bool              `json:"connectSupported"`
	Cadence            string            `json:"cadence"`
	Constraints        string            `json:"constraints"`
	PostTypes          map[string]string `json:"postTypes"`
	SupportedPostTypes []string          `json:"supportedPostTypes"`
	SortOrder          int32             `json:"sortOrder"`
	Usage              PlatformUsage     `json:"usage"`
	CreatedAt          time.Time         `json:"createdAt"`
	UpdatedAt          time.Time         `json:"updatedAt"`
}

// PlatformUsage is the read-only footprint that drives the disable/delete
// guards: how many accounts are connected and how many posts are scheduled.
type PlatformUsage struct {
	ConnectedAccounts int32 `json:"connectedAccounts"`
	ScheduledPosts    int32 `json:"scheduledPosts"`
}

// Client is a thin, safe wrapper over the generated PlatformAdminServiceClient.
type Client struct {
	conn    *grpc.ClientConn
	rpc     platformsv1.PlatformAdminServiceClient
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
		return nil, fmt.Errorf("ogenplatforms: dial %q: %w", addr, err)
	}
	return &Client{conn: conn, rpc: platformsv1.NewPlatformAdminServiceClient(conn), timeout: defaultTimeout}, nil
}

// Close releases the underlying connection. Safe on a nil client.
func (c *Client) Close() error {
	if c == nil || c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

// List returns the platform catalog. Operators manage the whole catalog, so
// includeDisabled=true surfaces disabled rows too (the seeded TikTok/Pinterest/
// Reddit and any freshly-added platform, which Ogen creates disabled) — without
// it they'd be invisible and could never be toggled on.
func (c *Client) List(ctx context.Context, includeDisabled bool) ([]Platform, error) {
	if c == nil {
		return nil, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.ListPlatforms(ctx, &platformsv1.ListPlatformsRequest{IncludeDisabled: includeDisabled})
	if err != nil {
		return nil, err
	}
	out := make([]Platform, 0, len(resp.GetPlatforms()))
	for _, p := range resp.GetPlatforms() {
		out = append(out, platformFromProto(p))
	}
	return out, nil
}

func platformFromProto(p *platformsv1.Platform) Platform {
	if p == nil {
		return Platform{}
	}
	return Platform{
		ID:                 p.GetId(),
		Name:               p.GetName(),
		ZernioID:           p.GetZernioId(),
		Enabled:            p.GetEnabled(),
		ConnectSupported:   p.GetConnectSupported(),
		Cadence:            p.GetCadence(),
		Constraints:        p.GetConstraints(),
		PostTypes:          p.GetPostTypes(),
		SupportedPostTypes: p.GetSupportedPostTypes(),
		SortOrder:          p.GetSortOrder(),
		Usage: PlatformUsage{
			ConnectedAccounts: p.GetUsage().GetConnectedAccounts(),
			ScheduledPosts:    p.GetUsage().GetScheduledPosts(),
		},
		CreatedAt: p.GetCreatedAt().AsTime(),
		UpdatedAt: p.GetUpdatedAt().AsTime(),
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
