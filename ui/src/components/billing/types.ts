// Shapes of Harbor's /api/billing* REST surface (CON-327) — a thin adapter over
// Ogen's billing.v1.BillingAdminService. Mirrors src/repository/ogenbilling.
// Optional instants are null when unset (e.g. firstPaidAt null = never paid).

export interface BillingSettings {
  provider: string; // none | lemonsqueezy
  testMode: boolean;
  configured: boolean; // API key + webhook secret both set
  storeId: string;
  trialTeardownLive: boolean; // never-paid trials torn down (true) or only logged
}

export interface BillingSettingsResponse {
  available: boolean;
  settings: BillingSettings;
  appBaseUrl: string; // Ogen's public origin for the share link ('' = unknown)
}

export interface Subscription {
  id: string;
  provider: string;
  providerSubscriptionId: string;
  providerCustomerId: string;
  providerVariantId: string;
  tierVersionPriceId: string;
  tierId: string;
  tierVersionId: string;
  status: string; // Lemon Squeezy vocabulary
  testMode: boolean;
  renewsAt: string | null;
  endsAt: string | null;
  trialEndsAt: string | null;
  firstPaidAt: string | null;
  cardBrand: string;
  cardLastFour: string;
  invalidatedAt: string | null;
  invalidatedReason: string;
  teardownAt: string | null;
  accountId: string;
  duplicate: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ScheduledChange {
  id: string;
  subscriptionId: string;
  fromTierVersionPriceId: string;
  toTierVersionPriceId: string;
  effectiveAt: string | null;
  status: string; // pending | provider_applied | applied | cancelled | failed
  createdBy: string;
  createdAt: string | null;
}

export interface WebhookEvent {
  id: string;
  eventName: string;
  providerObjectId: string;
  testMode: boolean;
  outcome: string; // applied | stale | ignored_mode | ignored_unknown | failed | duplicate
  error: string;
  receivedAt: string | null;
  processedAt: string | null;
}

export interface OwnerTrial {
  userId: string;
  accountId: string;
  email: string;
  trialEligible: boolean;
}

export interface TenantBilling {
  tenantId: string;
  billingRequired: boolean;
  // A tester's workspace (CON-333): never billed, so billingRequired is false.
  // End it with SetComplimentary, not the comp/exempt toggle.
  complimentary: boolean;
  gated: boolean;
  subscriptions: Subscription[];
  scheduledChanges: ScheduledChange[];
  recentWebhookEvents: WebhookEvent[];
  owners: OwnerTrial[];
}

export interface TenantBillingResponse {
  available: boolean;
  billing: TenantBilling;
  corrected?: number;
}

export type AttentionReason =
  | "past_due"
  | "unpaid"
  | "paused"
  | "expired"
  | "expired_never_paid"
  | "duplicate"
  | "unresolved_webhook"
  | "scheduled_change_failed"
  | "unmapped_price";

export interface AttentionItem {
  tenantId: string;
  tenantName: string;
  reason: AttentionReason | string;
  subscription: Subscription | null;
  webhookEvent: WebhookEvent | null;
  since: string | null;
  teardownStatus: "" | "dry_run" | "enqueued" | string;
  // Set for unmapped_price: a sellable price with no variant in the current
  // mode (tenantId and tenantName are '' then).
  tierVersionPriceId: string;
}

export interface AttentionResponse {
  available: boolean;
  items: AttentionItem[];
  nextPageToken: string;
}

export interface FreeTrialTier {
  tierId: string; // '' = offer off
  tierName: string;
  trialDays: number;
  eligibleTierIds: string[];
}

export interface FreeTrialTierResponse {
  available: boolean;
  offer: FreeTrialTier;
}

// ── Variant mapping (CON-404/407) ──────────────────────────────────────────────
// Each sellable tier price is sold through one Lemon Squeezy variant, mapped
// separately for test and live mode.

export type BillingMode = "test" | "live";

export interface ProviderVariant {
  id: string;
  productId: string;
  productName: string;
  name: string;
  priceMinor: number; // excluding tax
  currency: string;
  interval: string; // month | year
  hasFreeTrial: boolean;
  trialInterval: string; // day | week | month | year; '' without a trial
  trialIntervalCount: number;
  status: string; // the provider's variant status, e.g. published
  testMode: boolean;
  mappedPriceId: string; // the price this variant sells in its mode; '' = none
}

// ok | unmapped | variant_missing | price_mismatch | currency_mismatch |
// interval_mismatch | mode_mismatch | trial_missing | unchecked
export type MappingStatus = string;

export interface VariantMapping {
  tierVersionPriceId: string;
  tierId: string;
  tierName: string;
  tierVersionId: string;
  tierVersion: number;
  interval: string; // month | year
  netMinor: number; // excluding tax
  currency: string;
  countryCode: string; // '' = the currency's default price
  freeTrialTier: boolean; // its variants must carry a one-month trial
  variantId: string; // '' when unmapped
  variant: ProviderVariant | null;
  status: MappingStatus;
  message: string; // Ogen's explanation for every status but ok
  updatedAt: string | null;
  updatedBy: string;
}

export interface VariantMappingsResponse {
  available: boolean;
  testMode: boolean;
  // false: statuses could not come from Lemon Squeezy (no API key for the mode).
  checked: boolean;
  mappings: VariantMapping[];
}

export interface ProviderVariantsResponse {
  available: boolean;
  readable: boolean; // false: Ogen cannot read the mode; message says why
  message: string;
  variants: ProviderVariant[];
}

export interface VariantSuggestion {
  tierVersionPriceId: string;
  variant: ProviderVariant;
}

export interface VariantSuggestionsResponse {
  available: boolean;
  readable: boolean;
  message: string;
  suggestions: VariantSuggestion[];
}

export interface CutoverResult {
  dryRun: boolean;
  count: number;
  tenantIds: string[];
}
