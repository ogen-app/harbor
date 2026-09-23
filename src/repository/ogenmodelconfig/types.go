// Package ogenmodelconfig is Harbor's client for Ogen's internal
// ModelConfigAdminService — the operator surface that assigns a concrete model
// to each (tier, flow, slot) and reads the code-owned model catalog with
// pricing (CON-308 §6, consumed by the Harbor screens in CON-309).
//
// Like the sibling ogen* clients (ogenplatforms/ogentenants), it reuses the
// shared OGEN_GRPC_ADDR/OGEN_GRPC_TOKEN listener and the same bearer-token gate;
// an unconfigured client degrades to a soft "unavailable" state rather than a
// hard error.
//
// NOTE (CON-308 dependency): the gRPC contract this binds to ships in the shared
// buf.build/ogen-app/proto module under modelconfig/v1, which is not yet
// published (CON-308 is in progress). Until `make proto` can generate
// gen/modelconfig/v1, this package is backed by an in-memory fixture store
// (fixtures.go) that mirrors the wire contract exactly — realistic flows,
// models, pricing and assignments, with Set/Clear actually mutating the store so
// the UI is fully exercisable end-to-end. Swapping to the real gRPC client is a
// contained change in client.go (dial like ogenplatforms; replace each store
// call with the matching RPC + proto↔DTO converters). The DTO shapes below are
// the wire messages 1:1, so nothing downstream changes.
package ogenmodelconfig

import "time"

// Capability discriminates a slot/model between text-generation ("chat") and
// vector embedding ("embed"). A model may only fill a slot of the same
// capability (CON-308 §8).
const (
	CapabilityChat  = "chat"
	CapabilityEmbed = "embed"
)

// FlowSlot is one independently-assignable model slot on a flow. Single-model
// flows have one slot ("main"); orchestrated flows declare several (e.g.
// post_assistant → planner, writer). GlobalOnly slots (embed) admit no per-tier
// override.
type FlowSlot struct {
	Key         string `json:"key"`
	Description string `json:"description"`
	Capability  string `json:"capability"`
	GlobalOnly  bool   `json:"globalOnly"`
}

// Flow is a configurable genkit generation flow and its slots (the code-owned
// catalog returned by ListFlows).
type Flow struct {
	Key         string     `json:"key"`
	Description string     `json:"description"`
	Slots       []FlowSlot `json:"slots"`
}

// ModelRate is one per-kind price line, in micros per million tokens
// (input=3_000_000 ⇒ $3.00 / 1M). Kind ∈ input|output|cache_read|cache_write|…
type ModelRate struct {
	Kind             string `json:"kind"`
	MicrosPerMillion int64  `json:"microsPerMillion"`
}

// ModelCapabilities is the model's declared feature support, validated against a
// slot's requirements on write and surfaced as badges in the picker (CON-308
// §8a). Live means the vendor plugin is registered and an API key is present.
type ModelCapabilities struct {
	Tools            bool  `json:"tools"`
	StructuredOutput bool  `json:"structuredOutput"`
	Streaming        bool  `json:"streaming"`
	MaxOutputTokens  int32 `json:"maxOutputTokens"`
	ContextWindow    int32 `json:"contextWindow"`
	EmbedDims        int32 `json:"embedDims"`
	Live             bool  `json:"live"`
}

// Model is a registered model with vendor, capability, versioned pricing and its
// capability contract — the ListModels row that gives Harbor "pricing for free".
type Model struct {
	ID           string            `json:"id"`
	Vendor       string            `json:"vendor"`
	Capability   string            `json:"capability"`
	PriceVersion string            `json:"priceVersion"`
	Rates        []ModelRate       `json:"rates"`
	Capabilities ModelCapabilities `json:"capabilities"`
}

// SlotAssignment is one config row. An empty TierID is the global-default row
// (the required fallback); a non-empty TierID is a per-tier override.
type SlotAssignment struct {
	TierID    string    `json:"tierId"`
	FlowKey   string    `json:"flowKey"`
	SlotKey   string    `json:"slotKey"`
	ModelID   string    `json:"modelId"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// ResolvedSlot is what a tenant on a given tier actually gets for a slot:
// the tier override when present, else the global default. FromTierOverride
// distinguishes the two (drives the effective-config preview, CON-308 §7).
type ResolvedSlot struct {
	FlowKey          string `json:"flowKey"`
	SlotKey          string `json:"slotKey"`
	ModelID          string `json:"modelId"`
	FromTierOverride bool   `json:"fromTierOverride"`
}

// TestResult is the outcome of a live golden-probe (TestSlotModel, CON-308 §8a):
// pass/fail with a detail message, latency, a small output sample, and the list
// of static requirements the model failed (empty when it actually ran).
type TestResult struct {
	Passed            bool     `json:"passed"`
	Detail            string   `json:"detail"`
	LatencyMs         int64    `json:"latencyMs"`
	Sample            string   `json:"sample"`
	UnmetRequirements []string `json:"unmetRequirements"`
}
