// Shapes of the /api/model-config surface. Mirror the Go DTOs in
// src/repository/ogenmodelconfig (camelCase JSON), which in turn mirror the
// modelconfig/v1 gRPC contract (CON-308 §6) consumed by these screens (CON-309).

export type Capability = "chat" | "embed";

export interface FlowSlot {
  key: string;
  description: string;
  capability: Capability;
  globalOnly: boolean;
}

export interface Flow {
  key: string;
  description: string;
  slots: FlowSlot[];
}

// One per-kind price line, in micros per million tokens
// (input: 3_000_000 ⇒ $3.00 / 1M). Kind ∈ input|output|cache_read|cache_write.
export interface ModelRate {
  kind: string;
  microsPerMillion: number;
}

export interface ModelCapabilities {
  tools: boolean;
  structuredOutput: boolean;
  streaming: boolean;
  maxOutputTokens: number;
  contextWindow: number;
  embedDims: number;
  live: boolean;
}

export interface Model {
  id: string;
  vendor: string;
  capability: Capability;
  priceVersion: string;
  rates: ModelRate[];
  capabilities: ModelCapabilities;
}

// One config row. An empty tierId is the global-default row; a non-empty tierId
// is a per-tier override.
export interface SlotAssignment {
  tierId: string;
  flowKey: string;
  slotKey: string;
  modelId: string;
  updatedAt: string;
}

export interface Tier {
  id: string;
  name: string;
  color: string;
}

export interface TestResult {
  passed: boolean;
  detail: string;
  latencyMs: number;
  sample: string;
  unmetRequirements: string[];
}

// GET /api/model-config — the single first-paint payload.
export interface ModelConfigResponse {
  available: boolean;
  flows: Flow[];
  models: Model[];
  assignments: SlotAssignment[];
  tiers: Tier[];
}

// Body for POST /api/model-config/slot and /slot/global-all.
export interface SetSlotInput {
  tierId?: string;
  flowKey: string;
  slotKey: string;
  modelId: string;
}

// The "scope" a drawer tab edits: the global default, or a specific tier.
export const GLOBAL_SCOPE = "";
