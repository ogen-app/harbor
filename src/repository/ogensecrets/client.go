// Package ogensecrets is Harbor's gRPC client for Ogen's internal
// SecretsService. It manages Ogen's envelope-encrypted `secret` table through
// Ogen's own secrets.Store (over the wire) rather than the database, so Harbor
// reuses Ogen's crypto, name allowlist, and hot-reload hooks without
// duplicating any of them.
//
// Like the origin-scoped DB repositories, this client is best-effort: an
// unconfigured (empty addr) client is nil and every method returns
// ErrUnavailable, which the handler renders as a soft "unavailable" state. The
// bearer token is injected into outgoing gRPC metadata by a client interceptor
// and is never logged. Plaintext only ever travels one way (into Set); no RPC
// returns it.
package ogensecrets

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"

	secretsv1 "github.com/ogen-app/harbor/gen/secrets/v1"
)

// ErrUnavailable is returned by every method on a nil (unconfigured) client.
// Callers treat it as "secrets management unavailable", not a hard error —
// mirroring the ogen/analytics repositories' nil-pool contract.
var ErrUnavailable = errors.New("ogen secrets service not configured")

const defaultTimeout = 10 * time.Second

// SecretMeta is the non-sensitive view of one allowlist slot. It never carries
// any key material or plaintext. When Set is false the slot is empty and the
// timestamp/version fields are zero.
type SecretMeta struct {
	Name        string    `json:"name"`
	Set         bool      `json:"set"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
	KEKVersion  int       `json:"kekVersion"`
	Algorithm   string    `json:"algorithm"`
	Decryptable bool      `json:"decryptable"`
}

// Client is a thin, safe wrapper over the generated SecretsServiceClient.
type Client struct {
	conn    *grpc.ClientConn
	rpc     secretsv1.SecretsServiceClient
	timeout time.Duration
}

// New dials Ogen's internal gRPC surface. The client is enabled only when BOTH
// addr and token are set — mirroring Ogen's server, which starts only when both
// are configured. Either one empty returns (nil, nil): a nil client that
// reports ErrUnavailable, so the Secrets tab degrades softly (matches the
// empty-DSN pattern for the external DB pools) rather than failing boot.
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
		return nil, fmt.Errorf("ogensecrets: dial %q: %w", addr, err)
	}
	return &Client{conn: conn, rpc: secretsv1.NewSecretsServiceClient(conn), timeout: defaultTimeout}, nil
}

// Close releases the underlying connection. Safe on a nil client.
func (c *Client) Close() error {
	if c == nil || c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

// List returns one entry per allowlisted name (Ogen owns the allowlist), each
// marked set/unset with metadata.
func (c *Client) List(ctx context.Context) ([]SecretMeta, error) {
	if c == nil {
		return nil, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.List(ctx, &secretsv1.ListRequest{})
	if err != nil {
		return nil, err
	}
	out := make([]SecretMeta, 0, len(resp.GetSecrets()))
	for _, m := range resp.GetSecrets() {
		out = append(out, metaFromProto(m))
	}
	return out, nil
}

// Set upserts a plaintext value for an allowlisted name and returns the new
// metadata plus whether the row was freshly created (vs rotated).
func (c *Client) Set(ctx context.Context, name, value string) (SecretMeta, bool, error) {
	if c == nil {
		return SecretMeta{}, false, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.Set(ctx, &secretsv1.SetRequest{Name: name, Value: value})
	if err != nil {
		return SecretMeta{}, false, err
	}
	return metaFromProto(resp.GetSecret()), resp.GetCreated(), nil
}

// Delete removes a stored secret. A missing name returns a NotFound status.
func (c *Client) Delete(ctx context.Context, name string) error {
	if c == nil {
		return ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	_, err := c.rpc.Delete(ctx, &secretsv1.DeleteRequest{Name: name})
	return err
}

func metaFromProto(m *secretsv1.SecretMetadata) SecretMeta {
	if m == nil {
		return SecretMeta{}
	}
	return SecretMeta{
		Name:        m.GetName(),
		Set:         m.GetSet(),
		CreatedAt:   m.GetCreatedAt().AsTime(),
		UpdatedAt:   m.GetUpdatedAt().AsTime(),
		KEKVersion:  int(m.GetKekVersion()),
		Algorithm:   m.GetAlgorithm(),
		Decryptable: m.GetDecryptable(),
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
