package ogenmodelconfig

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/types/known/timestamppb"

	modelconfigv1 "github.com/ogen-app/harbor/gen/modelconfig/v1"
)

// ErrUnavailable is returned by every method on a nil (unconfigured) client, so
// the handler can render a soft "unavailable" state — matching the sibling
// ogen* clients.
var ErrUnavailable = errors.New("ogen model-config service not configured")

const defaultTimeout = 10 * time.Second

// Client is a thin, safe wrapper over the generated ModelConfigAdminServiceClient.
type Client struct {
	conn    *grpc.ClientConn
	rpc     modelconfigv1.ModelConfigAdminServiceClient
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
		return nil, fmt.Errorf("ogenmodelconfig: dial %q: %w", addr, err)
	}
	return &Client{conn: conn, rpc: modelconfigv1.NewModelConfigAdminServiceClient(conn), timeout: defaultTimeout}, nil
}

// Close releases the underlying connection. Safe on a nil client.
func (c *Client) Close() error {
	if c == nil || c.conn == nil {
		return nil
	}
	return c.conn.Close()
}

// ── Reads (code-owned catalogs) ────────────────────────────────────────────

// ListFlows returns the configurable flow/slot catalog.
func (c *Client) ListFlows(ctx context.Context) ([]Flow, error) {
	if c == nil {
		return nil, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.ListFlows(ctx, &modelconfigv1.ListFlowsRequest{})
	if err != nil {
		return nil, err
	}
	out := make([]Flow, 0, len(resp.GetFlows()))
	for _, f := range resp.GetFlows() {
		out = append(out, flowFromProto(f))
	}
	return out, nil
}

// ListModels returns the model catalog, optionally filtered to one capability
// ("chat"/"embed"); an empty capability returns all.
func (c *Client) ListModels(ctx context.Context, capability string) ([]Model, error) {
	if c == nil {
		return nil, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.ListModels(ctx, &modelconfigv1.ListModelsRequest{Capability: capability})
	if err != nil {
		return nil, err
	}
	out := make([]Model, 0, len(resp.GetModels()))
	for _, m := range resp.GetModels() {
		out = append(out, modelFromProto(m))
	}
	return out, nil
}

// ── Reads (assignments) ────────────────────────────────────────────────────

// ListConfig returns assignment rows. An empty tierID returns every scope
// (global defaults + all tier overrides); a non-empty tierID returns only that
// tier's overrides.
func (c *Client) ListConfig(ctx context.Context, tierID string) ([]SlotAssignment, error) {
	if c == nil {
		return nil, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.ListConfig(ctx, &modelconfigv1.ListConfigRequest{TierId: tierID})
	if err != nil {
		return nil, err
	}
	out := make([]SlotAssignment, 0, len(resp.GetAssignments()))
	for _, a := range resp.GetAssignments() {
		out = append(out, assignmentFromProto(a))
	}
	return out, nil
}

// GetEffectiveConfig resolves every (flow, slot) for a tier: the tier override
// when present, else the global default (FromTierOverride distinguishes them).
func (c *Client) GetEffectiveConfig(ctx context.Context, tierID string) ([]ResolvedSlot, error) {
	if c == nil {
		return nil, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.GetEffectiveConfig(ctx, &modelconfigv1.GetEffectiveConfigRequest{TierId: tierID})
	if err != nil {
		return nil, err
	}
	out := make([]ResolvedSlot, 0, len(resp.GetSlots()))
	for _, s := range resp.GetSlots() {
		out = append(out, resolvedFromProto(s))
	}
	return out, nil
}

// ── Writes ──────────────────────────────────────────────────────────────────

// SetSlotModel upserts an assignment. An empty tierID sets the global default;
// a non-empty tierID sets a per-tier override. Validation (capability match,
// global-only, unknown model, non-Anthropic chat in v1, requirements) is
// enforced server-side and surfaced as gRPC status errors.
func (c *Client) SetSlotModel(ctx context.Context, tierID, flow, slot, model string) (SlotAssignment, error) {
	if c == nil {
		return SlotAssignment{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.SetSlotModel(ctx, &modelconfigv1.SetSlotModelRequest{
		TierId:  tierID,
		FlowKey: flow,
		SlotKey: slot,
		ModelId: model,
	})
	if err != nil {
		return SlotAssignment{}, err
	}
	return assignmentFromProto(resp.GetAssignment()), nil
}

// ClearSlotModel removes a per-tier override. tierID is required — a global
// default can't be cleared. Clearing a non-existent override is a no-op OK.
func (c *Client) ClearSlotModel(ctx context.Context, tierID, flow, slot string) error {
	if c == nil {
		return ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	_, err := c.rpc.ClearSlotModel(ctx, &modelconfigv1.ClearSlotModelRequest{
		TierId:  tierID,
		FlowKey: flow,
		SlotKey: slot,
	})
	return err
}

// SetSlotModelAllTiers sets the global default to model and removes every
// per-tier override for the slot, so all tiers inherit the one model. This is
// the BFF composition behind the drawer's "Save and use for all Tiers" action:
// there is no bulk RPC, so it fans out over SetSlotModel(global) +
// ClearSlotModel(tier) for each existing override.
func (c *Client) SetSlotModelAllTiers(ctx context.Context, flow, slot, model string) (SlotAssignment, error) {
	if c == nil {
		return SlotAssignment{}, ErrUnavailable
	}
	set, err := c.SetSlotModel(ctx, "", flow, slot, model)
	if err != nil {
		return SlotAssignment{}, err
	}
	rows, err := c.ListConfig(ctx, "")
	if err != nil {
		return SlotAssignment{}, err
	}
	for _, a := range rows {
		if a.TierID != "" && a.FlowKey == flow && a.SlotKey == slot {
			if err := c.ClearSlotModel(ctx, a.TierID, flow, slot); err != nil {
				return SlotAssignment{}, err
			}
		}
	}
	return set, nil
}

// TestSlotModel runs the flow's golden probe against a candidate model
// (CON-308 §8a): pass/fail with a detail message, latency, output sample, and
// any statically-unmet requirements.
func (c *Client) TestSlotModel(ctx context.Context, flow, slot, model string) (TestResult, error) {
	if c == nil {
		return TestResult{}, ErrUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	resp, err := c.rpc.TestSlotModel(ctx, &modelconfigv1.TestSlotModelRequest{
		FlowKey: flow,
		SlotKey: slot,
		ModelId: model,
	})
	if err != nil {
		return TestResult{}, err
	}
	return TestResult{
		Passed:            resp.GetPassed(),
		Detail:            resp.GetDetail(),
		LatencyMs:         resp.GetLatencyMs(),
		Sample:            resp.GetSample(),
		UnmetRequirements: resp.GetUnmetRequirements(),
	}, nil
}

// ── proto → DTO ──────────────────────────────────────────────────────────────

func flowFromProto(f *modelconfigv1.Flow) Flow {
	if f == nil {
		return Flow{}
	}
	slots := make([]FlowSlot, 0, len(f.GetSlots()))
	for _, s := range f.GetSlots() {
		slots = append(slots, slotFromProto(s))
	}
	return Flow{Key: f.GetKey(), Description: f.GetDescription(), Slots: slots}
}

func slotFromProto(s *modelconfigv1.FlowSlot) FlowSlot {
	if s == nil {
		return FlowSlot{}
	}
	return FlowSlot{
		Key:         s.GetKey(),
		Description: s.GetDescription(),
		Capability:  s.GetCapability(),
		GlobalOnly:  s.GetGlobalOnly(),
	}
}

func modelFromProto(m *modelconfigv1.Model) Model {
	if m == nil {
		return Model{}
	}
	rates := make([]ModelRate, 0, len(m.GetRates()))
	for _, r := range m.GetRates() {
		rates = append(rates, ModelRate{Kind: r.GetKind(), MicrosPerMillion: r.GetMicrosPerMillion()})
	}
	return Model{
		ID:           m.GetId(),
		Vendor:       m.GetVendor(),
		Capability:   m.GetCapability(),
		PriceVersion: m.GetPriceVersion(),
		Rates:        rates,
		Capabilities: capsFromProto(m.GetCapabilities()),
	}
}

func capsFromProto(c *modelconfigv1.ModelCapabilities) ModelCapabilities {
	if c == nil {
		return ModelCapabilities{}
	}
	return ModelCapabilities{
		Tools:            c.GetTools(),
		StructuredOutput: c.GetStructuredOutput(),
		Streaming:        c.GetStreaming(),
		MaxOutputTokens:  c.GetMaxOutputTokens(),
		ContextWindow:    c.GetContextWindow(),
		EmbedDims:        c.GetEmbedDims(),
		Live:             c.GetLive(),
	}
}

func assignmentFromProto(a *modelconfigv1.SlotAssignment) SlotAssignment {
	if a == nil {
		return SlotAssignment{}
	}
	return SlotAssignment{
		TierID:    a.GetTierId(),
		FlowKey:   a.GetFlowKey(),
		SlotKey:   a.GetSlotKey(),
		ModelID:   a.GetModelId(),
		UpdatedAt: tsToTime(a.GetUpdatedAt()),
	}
}

func resolvedFromProto(s *modelconfigv1.ResolvedSlot) ResolvedSlot {
	if s == nil {
		return ResolvedSlot{}
	}
	return ResolvedSlot{
		FlowKey:          s.GetFlowKey(),
		SlotKey:          s.GetSlotKey(),
		ModelID:          s.GetModelId(),
		FromTierOverride: s.GetFromTierOverride(),
	}
}

func tsToTime(ts *timestamppb.Timestamp) time.Time {
	if ts == nil {
		return time.Time{}
	}
	return ts.AsTime()
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
