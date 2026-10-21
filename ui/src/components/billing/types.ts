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
  | "scheduled_change_failed";

export interface AttentionItem {
  tenantId: string;
  tenantName: string;
  reason: AttentionReason | string;
  subscription: Subscription | null;
  webhookEvent: WebhookEvent | null;
  since: string | null;
  teardownStatus: "" | "dry_run" | "enqueued" | string;
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

export interface CutoverResult {
  dryRun: boolean;
  count: number;
  tenantIds: string[];
}
