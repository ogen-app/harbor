// Types mirroring the /api/tier-entitlements JSON contract (src/handlers/plans.go
// + src/repository/ogenplans). The matrix renders catalog `features` as rows and
// `tiers` (each with its versions) as columns.

// An entitlement value: a number, a boolean, or null. A null NUMERIC means
// "unlimited" (∞); an absent key means "not configured" (—). Booleans are
// capability gates.
export type EntitlementValue = number | boolean | null;

export interface Feature {
  key: string;
  name: string;
  category: string;
  linearIssue: string;
  status: string; // live | in_progress | flag_off | planned
  valueType: string; // numeric | boolean
  isMaterial: boolean;
  reset: string; // numeric only: standing | monthly | total | per_post
  description: string;
}

export interface Price {
  currency: string; // ISO-4217
  billingInterval: string; // month | year
  netMinor: number; // minor units, e.g. cents
  countryCode: string; // "" = default for the currency/interval
}

export interface TierVersion {
  id: string;
  tierId: string;
  version: number;
  status: string; // draft | active | retired
  purchasable: boolean;
  changeReason: string;
  // May be null over the wire (the proto field is optional); normalise to {}
  // before indexing.
  entitlements: Record<string, EntitlementValue> | null;
  prices: Price[];
  liveAssignmentCount: number;
  createdAt: string;
  publishedAt: string | null;
  retiredAt: string | null;
}

export interface MatrixTier {
  tierId: string;
  tierName: string;
  tierColor: string;
  versions: TierVersion[]; // newest version first
}

export interface MatrixResponse {
  available: boolean;
  features: Feature[];
  tiers: MatrixTier[];
}

// One tenant's live (open-ended) assignment on a version — the enumerated form
// behind TierVersion.liveAssignmentCount, used to name the tenants blocking a
// retire (GET /versions/{id}/assignments).
export interface VersionAssignment {
  tenantId: string;
  tenantName: string;
  validFrom: string;
}

export interface AssignmentsResponse {
  // false when the upstream is unreachable (the read route degrades softly).
  available: boolean;
  assignments: VersionAssignment[];
  total: number;
}

// The outcome of a retire: the now-retired version plus how many tenants were
// migrated when a reassignment target was supplied (0 otherwise).
export interface RetireResult {
  version: TierVersion;
  reassignedCount: number;
}
