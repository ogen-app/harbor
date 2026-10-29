// Package ogenvendorcost is Harbor's gRPC client for Ogen's VendorCostService
// (vendorcost.v1): what an AI vendor actually charged, read with vendor keys
// that stay in Ogen. The AI credits tab of the Profit & loss page reconciles
// its token-pipeline estimate against it.
//
// Like the other Ogen admin clients it shares OGEN_GRPC_ADDR/OGEN_GRPC_TOKEN and
// is best-effort: an unconfigured client is nil and every method returns
// ErrUnavailable.
package ogenvendorcost

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	vendorcostv1 "github.com/ogen-app/harbor/gen/vendorcost/v1"
)

var (
	// ErrUnavailable is returned by every method on a nil (unconfigured)
	// client.
	ErrUnavailable = errors.New("ogen vendor cost service not configured")
	// ErrKeyRejected means Anthropic refused Ogen's Admin key; Message
	// carries Ogen's hint.
	ErrKeyRejected = errors.New("anthropic admin key rejected")
)

// Ogen pages through Anthropic's report and retries it, so a call may take a
// while.
const defaultTimeout = 2 * time.Minute

// DailyCost is the vendor's charge for one model and cost type on one UTC day.
// Model is "" for costs not tied to a model.
type DailyCost struct {
	Date      string
	Model     string
	CostType  string
	USDMicros int64
}

// Report is one GetAnthropicCost answer. Configured is false while Ogen has no
// Admin key; Costs is then empty.
type Report struct {
	Configured bool
	Costs      []DailyCost
	FetchedAt  time.Time
}

// Client wraps the VendorCostService stub. A nil *Client is the unconfigured
// state.
type Client struct {
	conn    *grpc.ClientConn
	rpc     vendorcostv1.VendorCostServiceClient
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
	)
	if err != nil {
		return nil, fmt.Errorf("ogenvendorcost: dial %q: %w", addr, err)
	}
	return &Client{conn: conn, rpc: vendorcostv1.NewVendorCostServiceClient(conn), timeout: defaultTimeout}, nil
}

func (c *Client) Close() error {
	if c == nil || c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

// AnthropicCost reads Anthropic's charges for the UTC days from through to,
// both inclusive (at most 92 days). A rejected Admin key is ErrKeyRejected
// wrapped with Ogen's hint; other gRPC errors pass through.
func (c *Client) AnthropicCost(ctx context.Context, from, to time.Time) (Report, error) {
	if c == nil {
		return Report{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	resp, err := c.rpc.GetAnthropicCost(ctx, &vendorcostv1.GetAnthropicCostRequest{
		FromDate: from.UTC().Format(time.DateOnly),
		ToDate:   to.UTC().Format(time.DateOnly),
	})
	if err != nil {
		if st, ok := status.FromError(err); ok && st.Code() == codes.FailedPrecondition {
			return Report{}, fmt.Errorf("%w: %s", ErrKeyRejected, st.Message())
		}
		return Report{}, err
	}
	out := Report{Configured: resp.GetConfigured(), Costs: make([]DailyCost, 0, len(resp.GetCosts()))}
	if resp.GetFetchedAt() != nil {
		out.FetchedAt = resp.GetFetchedAt().AsTime()
	}
	for _, c := range resp.GetCosts() {
		out.Costs = append(out.Costs, DailyCost{Date: c.GetDate(), Model: c.GetModel(), CostType: c.GetCostType(), USDMicros: c.GetCostUsdMicros()})
	}
	return out, nil
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
