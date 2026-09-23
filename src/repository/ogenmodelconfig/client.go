package ogenmodelconfig

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// ErrUnavailable is returned by every method on a nil (unconfigured) client, so
// the handler can render a soft "unavailable" state — matching the sibling
// ogen* clients.
var ErrUnavailable = errors.New("ogen model-config service not configured")

// Client is Harbor's model-config client. It is currently backed by an
// in-memory fixture store (see the package doc + fixtures.go); the exported
// surface is exactly the set of RPCs it will forward to once
// gen/modelconfig/v1 exists.
type Client struct {
	store *store
}

// New returns a model-config client. It intentionally ignores addr/token for
// now and always returns a live fixture-backed client so the CON-309 screens are
// exercisable before CON-308 publishes the contract.
//
// TODO(CON-308): mirror ogenplatforms.New — return (nil, nil) when addr/token
// are empty, otherwise grpc.NewClient(addr, …bearerTokenInterceptor(token)) and
// hold the generated ModelConfigAdminServiceClient. Each method below then calls
// its RPC with proto↔DTO converters instead of the store.
func New(_, _ string) (*Client, error) {
	return &Client{store: newStore()}, nil
}

// Close releases any underlying connection. Safe on a nil client / fixture mode.
func (c *Client) Close() error { return nil }

// ── Reads (code-owned catalogs) ────────────────────────────────────────────

// ListFlows returns the configurable flow/slot catalog.
func (c *Client) ListFlows(_ context.Context) ([]Flow, error) {
	if c == nil {
		return nil, ErrUnavailable
	}
	return flowCatalog(), nil
}

// ListModels returns the model catalog, optionally filtered to one capability
// ("chat"/"embed"); an empty capability returns all.
func (c *Client) ListModels(_ context.Context, capability string) ([]Model, error) {
	if c == nil {
		return nil, ErrUnavailable
	}
	all := modelCatalog()
	if capability == "" {
		return all, nil
	}
	out := make([]Model, 0, len(all))
	for _, m := range all {
		if m.Capability == capability {
			out = append(out, m)
		}
	}
	return out, nil
}

// Tiers returns the tier set used for the drawer's per-tier tabs.
//
// TODO(CON-308): source these from the tenant-admin client instead of fixtures.
func (c *Client) Tiers(_ context.Context) ([]Tier, error) {
	if c == nil {
		return nil, ErrUnavailable
	}
	return fixtureTiers(), nil
}

// ── Reads (assignments) ────────────────────────────────────────────────────

// ListConfig returns assignment rows. An empty tierID returns every scope
// (global defaults + all tier overrides); a non-empty tierID returns only that
// tier's overrides.
func (c *Client) ListConfig(_ context.Context, tierID string) ([]SlotAssignment, error) {
	if c == nil {
		return nil, ErrUnavailable
	}
	out := c.store.list(tierID, tierID == "")
	sort.Slice(out, func(i, j int) bool {
		if out[i].FlowKey != out[j].FlowKey {
			return out[i].FlowKey < out[j].FlowKey
		}
		if out[i].SlotKey != out[j].SlotKey {
			return out[i].SlotKey < out[j].SlotKey
		}
		return out[i].TierID < out[j].TierID
	})
	return out, nil
}

// GetEffectiveConfig resolves every (flow, slot) for a tier: the tier override
// when present, else the global default. Marks which one won via FromTierOverride.
func (c *Client) GetEffectiveConfig(_ context.Context, tierID string) ([]ResolvedSlot, error) {
	if c == nil {
		return nil, ErrUnavailable
	}
	if tierID == "" {
		return nil, status.Error(codes.InvalidArgument, "tier_id is required")
	}
	var out []ResolvedSlot
	for _, f := range flowCatalog() {
		for _, s := range f.Slots {
			r := ResolvedSlot{FlowKey: f.Key, SlotKey: s.Key}
			if !s.GlobalOnly {
				if a, ok := c.store.get(tierID, f.Key, s.Key); ok {
					r.ModelID, r.FromTierOverride = a.ModelID, true
					out = append(out, r)
					continue
				}
			}
			if a, ok := c.store.get("", f.Key, s.Key); ok {
				r.ModelID = a.ModelID
			}
			out = append(out, r)
		}
	}
	return out, nil
}

// ── Writes ──────────────────────────────────────────────────────────────────

// SetSlotModel upserts an assignment. An empty tierID sets the global default;
// a non-empty tierID sets a per-tier override. Validation mirrors CON-308 §8 and
// is returned as gRPC status errors so the handler maps them identically to the
// real service.
func (c *Client) SetSlotModel(_ context.Context, tierID, flow, slot, model string) (SlotAssignment, error) {
	if c == nil {
		return SlotAssignment{}, ErrUnavailable
	}
	if _, err := c.validateSet(tierID, flow, slot, model); err != nil {
		return SlotAssignment{}, err
	}
	return c.store.set(SlotAssignment{TierID: tierID, FlowKey: flow, SlotKey: slot, ModelID: model}), nil
}

// ClearSlotModel removes a per-tier override. tierID is required — a global
// default can't be cleared (there must always be one). Clearing a non-existent
// override is a no-op OK.
func (c *Client) ClearSlotModel(_ context.Context, tierID, flow, slot string) error {
	if c == nil {
		return ErrUnavailable
	}
	if tierID == "" {
		return status.Error(codes.InvalidArgument, "tier_id is required to clear an override; the global default can't be cleared")
	}
	if _, ok := findSlot(flow, slot); !ok {
		return status.Errorf(codes.NotFound, "unknown flow/slot %q/%q", flow, slot)
	}
	c.store.clear(tierID, flow, slot)
	return nil
}

// SetSlotModelAllTiers sets the global default to model and removes every
// per-tier override for the slot, so all tiers inherit the one model. This is
// the BFF composition behind the drawer's "Save and use for all Tiers" action.
//
// TODO(CON-308): fan out to SetSlotModel(global) + ClearSlotModel(tier) per
// tier over the real service (there is no bulk RPC).
func (c *Client) SetSlotModelAllTiers(ctx context.Context, flow, slot, model string) (SlotAssignment, error) {
	if c == nil {
		return SlotAssignment{}, ErrUnavailable
	}
	a, err := c.SetSlotModel(ctx, "", flow, slot, model)
	if err != nil {
		return SlotAssignment{}, err
	}
	c.store.clearAllTierOverrides(flow, slot)
	return a, nil
}

// TestSlotModel runs the flow's golden probe against a candidate model
// (CON-308 §8a). In fixture mode it derives a deterministic pass/fail from the
// static capability check; a real probe would additionally catch missing keys,
// unregistered plugins and schema non-adherence.
func (c *Client) TestSlotModel(_ context.Context, flow, slot, model string) (TestResult, error) {
	if c == nil {
		return TestResult{}, ErrUnavailable
	}
	fs, ok := findSlot(flow, slot)
	if !ok {
		return TestResult{}, status.Errorf(codes.NotFound, "unknown flow/slot %q/%q", flow, slot)
	}
	m, ok := findModel(model)
	if !ok {
		return TestResult{}, status.Errorf(codes.InvalidArgument, "unknown model %q", model)
	}
	if unmet := staticUnmet(fs, m); len(unmet) > 0 {
		return TestResult{
			Passed:            false,
			Detail:            "model does not meet the slot's static requirements",
			LatencyMs:         0,
			UnmetRequirements: unmet,
		}, nil
	}
	if !m.Capabilities.Live {
		return TestResult{Passed: false, Detail: "vendor plugin not registered or API key missing", LatencyMs: 0}, nil
	}
	// A plausible probe latency that varies a little by model so the badge feels real.
	latency := int64(420 + len(model)%7*35)
	return TestResult{
		Passed:    true,
		Detail:    "ok",
		LatencyMs: latency,
		Sample:    fmt.Sprintf("[%s] probe for %s/%s produced a well-formed response.", m.ID, flow, slot),
	}, nil
}

// ── Validation helpers ──────────────────────────────────────────────────────

func (c *Client) validateSet(tierID, flow, slot, model string) (FlowSlot, error) {
	fs, ok := findSlot(flow, slot)
	if !ok {
		return FlowSlot{}, status.Errorf(codes.NotFound, "unknown flow/slot %q/%q", flow, slot)
	}
	if fs.GlobalOnly && tierID != "" {
		return FlowSlot{}, status.Errorf(codes.FailedPrecondition, "%s is global-only and can't have a per-tier override", flow)
	}
	m, ok := findModel(model)
	if !ok {
		return FlowSlot{}, status.Errorf(codes.InvalidArgument, "unknown model %q", model)
	}
	if m.Capability != fs.Capability {
		return FlowSlot{}, status.Errorf(codes.InvalidArgument, "%s/%s needs a %s model; %s is %s", flow, slot, fs.Capability, model, m.Capability)
	}
	// v1: chat slots accept Anthropic models only (CON-308 §4 out-of-scope).
	if fs.Capability == CapabilityChat && m.Vendor != "anthropic" {
		return FlowSlot{}, status.Errorf(codes.InvalidArgument, "chat slots accept Anthropic models only in v1; %s is %s", model, m.Vendor)
	}
	return fs, nil
}

func findSlot(flow, slot string) (FlowSlot, bool) {
	for _, f := range flowCatalog() {
		if f.Key != flow {
			continue
		}
		for _, s := range f.Slots {
			if s.Key == slot {
				return s, true
			}
		}
	}
	return FlowSlot{}, false
}

func findModel(id string) (Model, bool) {
	for _, m := range modelCatalog() {
		if m.ID == id {
			return m, true
		}
	}
	return Model{}, false
}

// staticUnmet reports which of the slot's capability requirements the model
// fails. The fixture catalog's models all support tools/structured/streaming,
// so this is exercised mainly by the embed-dims match; the real §8a matrix is
// richer.
func staticUnmet(fs FlowSlot, m Model) []string {
	var unmet []string
	if fs.Capability == CapabilityEmbed && m.Capabilities.EmbedDims != 3072 {
		unmet = append(unmet, "embed_dims=3072")
	}
	return unmet
}
