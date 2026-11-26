// Shapes of Harbor's /api/billing* REST surface (CON-327) — a thin adapter over
// Ogen's billing.v1.BillingAdminService. Mirrors src/repository/ogenbilling.
// Optional instants are null when unset (e.g. firstPaidAt null = never paid).

export interface BillingSettings {
  provider: string; // none | polar
  testMode: boolean; // Polar sandbox
  configured: boolean; // access token + webhook secret both set
  organizationId: string; // the Polar organization of the running mode
  apiVersion: string; // the Polar API version requests are pinned to
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
  providerProductId: string;
  tierVersionPriceId: string;
  tierId: string;
  tierVersionId: string;
  status: string; // Ogen subscription status, whatever the provider
  providerStatus: string; // the provider's raw status, for support
  // The product a scheduled change moves to at the provider on
  // pendingEffectiveAt; '' when nothing is pending.
  pendingProductId: string;
  pendingEffectiveAt: string | null;
  cancelAtPeriodEnd: boolean; // cancelled by the owner, live until endsAt
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
  // Set for unmapped_price: a sellable price with no product (or an archived
  // one) in the current mode (tenantId and tenantName are '' then).
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

// ── Product mapping (CON-404/407, Polar since CON-523) ─────────────────────────
// Each sellable tier price is sold through one Polar product, mapped separately
// for sandbox (test) and production (live). A product bills one interval and
// may carry a fixed price in several currencies, so it can sell one price row
// per currency.

export type BillingMode = "test" | "live";

export interface ProductPrice {
  currency: string; // ISO 4217
  amountMinor: number; // excluding tax
}

export interface ProviderProduct {
  id: string;
  name: string;
  interval: string; // month | year
  intervalCount: number; // billing periods per interval; 1 is the norm
  prices: ProductPrice[];
  hasFreeTrial: boolean;
  trialInterval: string; // day | week | month | year; '' without a trial
  trialIntervalCount: number;
  archived: boolean; // an archived product cannot be bought or mapped
  testMode: boolean;
  mappedPriceIds: string[]; // the price rows it sells in its mode, one per currency
}

// ok | unmapped | product_missing | product_archived | price_mismatch |
// currency_mismatch | interval_mismatch | mode_mismatch | trial_missing |
// unchecked
export type MappingStatus = string;

export interface ProductMapping {
  tierVersionPriceId: string;
  tierId: string;
  tierName: string;
  tierVersionId: string;
  tierVersion: number;
  interval: string; // month | year
  netMinor: number; // excluding tax
  currency: string; // the row's currency, the product price it is sold at
  countryCode: string; // '' = the currency's default price
  freeTrialTier: boolean; // its products must carry a one-month trial
  productId: string; // '' when unmapped
  product: ProviderProduct | null;
  status: MappingStatus;
  message: string; // Ogen's explanation for every status but ok
  updatedAt: string | null;
  updatedBy: string;
}

export interface ProductMappingsResponse {
  available: boolean;
  testMode: boolean;
  // false: statuses could not come from Polar (no access token for the mode).
  checked: boolean;
  mappings: ProductMapping[];
}

export interface ProviderProductsResponse {
  available: boolean;
  readable: boolean; // false: Ogen cannot read the mode; message says why
  message: string;
  products: ProviderProduct[];
}

export interface ProductSuggestion {
  tierVersionPriceId: string;
  product: ProviderProduct;
}

export interface ProductSuggestionsResponse {
  available: boolean;
  readable: boolean;
  message: string;
  suggestions: ProductSuggestion[];
}

// provider_switch: subscriptions of another provider than the running one
// (Lemon Squeezy → Polar), allowed in either mode. mode_cutover: sandbox
// subscriptions at the switch to production, refused while in sandbox.
export type CutoverScope = "provider_switch" | "mode_cutover";

export interface CutoverResult {
  dryRun: boolean;
  count: number;
  tenantIds: string[];
}
