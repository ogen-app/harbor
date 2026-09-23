package ogenmodelconfig

import (
	"sync"
	"time"
)

// Tier is the minimal tier identity the drawer needs for its per-tier tabs
// (id + display name + colour). In fixture mode it comes from fixtureTiers()
// below so the seeded assignments' tier_ids stay internally consistent.
//
// TODO(CON-308): once wired, the model-config handler should source tiers from
// the existing tenant-admin client (ogentenants.ListTiers) — real tier_ids —
// and this fixture set goes away.
type Tier struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

func fixtureTiers() []Tier {
	return []Tier{
		{ID: "tier_free", Name: "Free", Color: "#94a3b8"},
		{ID: "tier_pro", Name: "Pro", Color: "#6366f1"},
		{ID: "tier_ent", Name: "Enterprise", Color: "#0ea5e9"},
	}
}

// flowCatalog is the code-owned flow/slot catalog (CON-308 §5.1). Orchestrated
// flows (post_assistant) declare several slots; embed is global-only.
func flowCatalog() []Flow {
	chat := CapabilityChat
	embed := CapabilityEmbed
	return []Flow{
		{Key: "content_plan", Description: "Generate a tenant's content plan.", Slots: []FlowSlot{
			{Key: "main", Description: "Plan generation + long rewrites.", Capability: chat},
		}},
		{Key: "draft_post", Description: "Draft a single post from a brief.", Slots: []FlowSlot{
			{Key: "main", Description: "Post drafting.", Capability: chat},
		}},
		{Key: "enrich_brief", Description: "Expand a thin brief into a full one.", Slots: []FlowSlot{
			{Key: "main", Description: "Brief enrichment.", Capability: chat},
		}},
		{Key: "consistency", Description: "Check briefs & posts for consistency.", Slots: []FlowSlot{
			{Key: "main", Description: "Consistency evaluation (structured output).", Capability: chat},
		}},
		{Key: "post_quality", Description: "Score a drafted post's quality.", Slots: []FlowSlot{
			{Key: "main", Description: "Quality scoring (structured output).", Capability: chat},
		}},
		{Key: "post_assistant", Description: "Interactive post assistant (planner + writer).", Slots: []FlowSlot{
			{Key: "planner", Description: "Cheap planner loop (multi-turn tools).", Capability: chat},
			{Key: "writer", Description: "Capable writer for the editPost tool.", Capability: chat},
		}},
		{Key: "campaign_assistant", Description: "Orchestrates sub-flows for a campaign.", Slots: []FlowSlot{
			{Key: "orchestrator", Description: "Delegating orchestrator (multi-turn tools).", Capability: chat},
		}},
		{Key: "embed", Description: "Asset & query embedding pipeline.", Slots: []FlowSlot{
			{Key: "main", Description: "Vector embedding — must stay homogeneous per tenant.", Capability: embed, GlobalOnly: true},
		}},
	}
}

// Model ids used across the fixtures (kept as consts so seed rows and the
// catalog can't drift apart).
const (
	modelSonnet      = "claude-sonnet-4-5-20250929"
	modelHaiku       = "claude-haiku-4-5-20251001"
	modelGeminiFlash = "gemini-2.5-flash"
	modelGeminiPro   = "gemini-2.5-pro"
	modelGeminiEmbed = "gemini-embedding-2"

	// A model referenced by a seeded override but absent from the catalog, to
	// exercise the drift/stale-model flag (CON-308 §11, CON-309 §3.5).
	modelRetired = "claude-sonnet-3-5-retired-20240620"

	priceVersion = "2026-09-01"
)

// modelCatalog mirrors the vendor registry (CON-86) flattened by ListModels:
// two Anthropic chat models, two Gemini chat models (present so the v1
// "Anthropic-only chat" rejection is demonstrable), and one Gemini embed model.
// Rates are micros per million tokens ($3.00/1M ⇒ 3_000_000).
func modelCatalog() []Model {
	return []Model{
		{
			ID: modelSonnet, Vendor: "anthropic", Capability: CapabilityChat, PriceVersion: priceVersion,
			Rates: []ModelRate{
				{Kind: "input", MicrosPerMillion: 3_000_000},
				{Kind: "output", MicrosPerMillion: 15_000_000},
				{Kind: "cache_read", MicrosPerMillion: 300_000},
				{Kind: "cache_write", MicrosPerMillion: 3_750_000},
			},
			Capabilities: ModelCapabilities{Tools: true, StructuredOutput: true, Streaming: true, MaxOutputTokens: 64_000, ContextWindow: 200_000, Live: true},
		},
		{
			ID: modelHaiku, Vendor: "anthropic", Capability: CapabilityChat, PriceVersion: priceVersion,
			Rates: []ModelRate{
				{Kind: "input", MicrosPerMillion: 1_000_000},
				{Kind: "output", MicrosPerMillion: 5_000_000},
				{Kind: "cache_read", MicrosPerMillion: 100_000},
				{Kind: "cache_write", MicrosPerMillion: 1_250_000},
			},
			Capabilities: ModelCapabilities{Tools: true, StructuredOutput: true, Streaming: true, MaxOutputTokens: 64_000, ContextWindow: 200_000, Live: true},
		},
		{
			ID: modelGeminiFlash, Vendor: "gemini", Capability: CapabilityChat, PriceVersion: priceVersion,
			Rates: []ModelRate{
				{Kind: "input", MicrosPerMillion: 300_000},
				{Kind: "output", MicrosPerMillion: 2_500_000},
				{Kind: "cache_read", MicrosPerMillion: 75_000},
			},
			Capabilities: ModelCapabilities{Tools: true, StructuredOutput: true, Streaming: true, MaxOutputTokens: 65_536, ContextWindow: 1_000_000, Live: true},
		},
		{
			ID: modelGeminiPro, Vendor: "gemini", Capability: CapabilityChat, PriceVersion: priceVersion,
			Rates: []ModelRate{
				{Kind: "input", MicrosPerMillion: 1_250_000},
				{Kind: "output", MicrosPerMillion: 10_000_000},
				{Kind: "cache_read", MicrosPerMillion: 312_500},
			},
			Capabilities: ModelCapabilities{Tools: true, StructuredOutput: true, Streaming: true, MaxOutputTokens: 65_536, ContextWindow: 2_000_000, Live: true},
		},
		{
			ID: modelGeminiEmbed, Vendor: "gemini", Capability: CapabilityEmbed, PriceVersion: priceVersion,
			Rates: []ModelRate{
				{Kind: "input", MicrosPerMillion: 150_000},
			},
			Capabilities: ModelCapabilities{EmbedDims: 3072, Live: true},
		},
	}
}

// assignmentKey identifies one config row. An empty tier is the global default.
type assignmentKey struct{ tier, flow, slot string }

// store is the mutable in-memory assignment set backing the fixtures. Set/Clear
// mutate it under the lock so the UI's edits persist for the process lifetime,
// making the whole feature exercisable before the real gRPC contract lands.
type store struct {
	mu          sync.RWMutex
	assignments map[assignmentKey]SlotAssignment
}

func newStore() *store {
	s := &store{assignments: make(map[assignmentKey]SlotAssignment)}
	now := time.Now().UTC()
	seed := []SlotAssignment{
		// Global defaults — reproduce today's per-flow models exactly (CON-308 §5.1).
		{FlowKey: "content_plan", SlotKey: "main", ModelID: modelSonnet},
		{FlowKey: "draft_post", SlotKey: "main", ModelID: modelSonnet},
		{FlowKey: "enrich_brief", SlotKey: "main", ModelID: modelSonnet},
		{FlowKey: "consistency", SlotKey: "main", ModelID: modelSonnet},
		{FlowKey: "post_quality", SlotKey: "main", ModelID: modelSonnet},
		{FlowKey: "post_assistant", SlotKey: "planner", ModelID: modelHaiku},
		{FlowKey: "post_assistant", SlotKey: "writer", ModelID: modelSonnet},
		{FlowKey: "campaign_assistant", SlotKey: "orchestrator", ModelID: modelHaiku},
		{FlowKey: "embed", SlotKey: "main", ModelID: modelGeminiEmbed},

		// A few tier overrides so "varies by tier" + effective-config are non-trivial.
		{TierID: "tier_free", FlowKey: "content_plan", SlotKey: "main", ModelID: modelHaiku},
		{TierID: "tier_ent", FlowKey: "post_assistant", SlotKey: "planner", ModelID: modelSonnet},
		// A drift row: references a model no longer in the catalog (CON-309 §3.5).
		{TierID: "tier_free", FlowKey: "consistency", SlotKey: "main", ModelID: modelRetired},
	}
	for _, a := range seed {
		a.UpdatedAt = now
		s.assignments[assignmentKey{a.TierID, a.FlowKey, a.SlotKey}] = a
	}
	return s
}

func (s *store) list(tier string, all bool) []SlotAssignment {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]SlotAssignment, 0, len(s.assignments))
	for k, a := range s.assignments {
		if all || k.tier == tier {
			out = append(out, a)
		}
	}
	return out
}

func (s *store) get(tier, flow, slot string) (SlotAssignment, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	a, ok := s.assignments[assignmentKey{tier, flow, slot}]
	return a, ok
}

func (s *store) set(a SlotAssignment) SlotAssignment {
	s.mu.Lock()
	defer s.mu.Unlock()
	a.UpdatedAt = time.Now().UTC()
	s.assignments[assignmentKey{a.TierID, a.FlowKey, a.SlotKey}] = a
	return a
}

func (s *store) clear(tier, flow, slot string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.assignments, assignmentKey{tier, flow, slot})
}

// clearAllTierOverrides removes every per-tier override for a (flow, slot),
// leaving only the global default — the write half of "use for all tiers".
func (s *store) clearAllTierOverrides(flow, slot string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for k := range s.assignments {
		if k.tier != "" && k.flow == flow && k.slot == slot {
			delete(s.assignments, k)
		}
	}
}
