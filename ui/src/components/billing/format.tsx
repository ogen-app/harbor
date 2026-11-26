import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { CatalogEntry } from "@/components/tiers-groups/types";
import type { BillingSettings, BillingSettingsResponse } from "./types";

// Shared presentation helpers for the billing surfaces (the /billing page, the
// tenant Billing tab and the Tenants table column), so statuses, reasons and
// dates read the same everywhere. Status strings are Ogen's own subscription
// statuses, whatever the provider; the provider's raw status is shown apart.

type Tone = "good" | "warn" | "bad" | "neutral" | "info";

const TONE: Record<Tone, { dot: string; chip: string }> = {
  good: { dot: "bg-emerald-500", chip: "bg-emerald-500/10 text-emerald-700" },
  warn: { dot: "bg-amber-500", chip: "bg-amber-500/10 text-amber-700" },
  bad: { dot: "bg-red-500", chip: "bg-red-500/10 text-red-700" },
  info: { dot: "bg-sky-500", chip: "bg-sky-500/10 text-sky-700" },
  neutral: {
    dot: "bg-neutral-400",
    chip: "bg-neutral-400/15 text-tertiary-foreground",
  },
};

// Every value a billing status can take: the tenant-list summary values
// (complimentary, not_required, awaiting_checkout) plus Ogen's subscription
// statuses. complimentary is a tester's workspace.
const BILLING_STATUS: Record<string, { tone: Tone; label: string }> = {
  complimentary: { tone: "good", label: "Complimentary" },
  not_required: { tone: "neutral", label: "Not required" },
  awaiting_checkout: { tone: "info", label: "Awaiting checkout" },
  on_trial: { tone: "info", label: "On trial" },
  active: { tone: "good", label: "Active" },
  paused: { tone: "warn", label: "Paused" },
  past_due: { tone: "bad", label: "Past due" },
  unpaid: { tone: "bad", label: "Unpaid" },
  cancelled: { tone: "warn", label: "Cancelled" },
  expired: { tone: "neutral", label: "Expired" },
};

export function billingStatusLabel(status: string): string {
  return BILLING_STATUS[status]?.label ?? humanize(status);
}

// BillingStatusBadge is the colour-coded chip for a billing status. An empty
// status (billing off) renders a dim dash.
export function BillingStatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  if (!status) {
    return <span className="text-xs text-tertiary-foreground">—</span>;
  }
  const s = BILLING_STATUS[status] ?? { tone: "neutral" as Tone, label: humanize(status) };
  return <Chip tone={s.tone} label={s.label} className={className} />;
}

// Attention reasons (ListBillingAttention), worded for the operator.
const REASON: Record<string, { tone: Tone; label: string; hint: string }> = {
  past_due: {
    tone: "bad",
    label: "Past due",
    hint: "A renewal payment failed; Polar is retrying the card.",
  },
  unpaid: {
    tone: "bad",
    label: "Unpaid",
    hint: "Payment retries are exhausted. The workspace keeps its tier until you act.",
  },
  paused: {
    tone: "warn",
    label: "Paused",
    hint: "Payment collection is paused at the payment provider.",
  },
  expired: {
    tone: "neutral",
    label: "Expired",
    hint: "The subscription ended in the last 30 days.",
  },
  expired_never_paid: {
    tone: "warn",
    label: "Trial expired, never paid",
    hint: "A free trial ended without a payment.",
  },
  duplicate: {
    tone: "warn",
    label: "Duplicate subscription",
    hint: "The workspace has more than one live subscription; refund or cancel one in Polar.",
  },
  unresolved_webhook: {
    tone: "bad",
    label: "Unresolved webhook",
    hint: "A webhook arrived that Ogen couldn't match to a workspace.",
  },
  scheduled_change_failed: {
    tone: "bad",
    label: "Scheduled change failed",
    hint: "A downgrade scheduled for the billing boundary could not be applied.",
  },
  unmapped_price: {
    tone: "warn",
    label: "Price not sellable",
    hint: "No Polar product sells this price, or its product is archived, so the pricing page shows it as unavailable.",
  },
};

export function ReasonBadge({ reason }: { reason: string }) {
  const r = REASON[reason] ?? { tone: "neutral" as Tone, label: humanize(reason) };
  return <Chip tone={r.tone} label={r.label} />;
}

export function reasonHint(reason: string): string {
  return REASON[reason]?.hint ?? "";
}

export const ATTENTION_REASONS = Object.keys(REASON);

export function reasonLabel(reason: string): string {
  return REASON[reason]?.label ?? humanize(reason);
}

// Webhook ingest outcomes.
const OUTCOME_TONE: Record<string, Tone> = {
  applied: "good",
  stale: "neutral",
  duplicate: "neutral",
  ignored_mode: "warn",
  ignored_unknown: "warn",
  failed: "bad",
};

export function OutcomeBadge({ outcome }: { outcome: string }) {
  return <Chip tone={OUTCOME_TONE[outcome] ?? "neutral"} label={humanize(outcome)} />;
}

const CHANGE_TONE: Record<string, Tone> = {
  pending: "info",
  provider_applied: "info",
  applied: "good",
  cancelled: "neutral",
  failed: "bad",
};

export function ChangeStatusBadge({ status }: { status: string }) {
  return <Chip tone={CHANGE_TONE[status] ?? "neutral"} label={humanize(status)} />;
}

// ModeBadge marks sandbox (test mode) vs production (live) data.
export function ModeBadge({ testMode }: { testMode: boolean }) {
  return testMode ? (
    <Chip tone="warn" label="Sandbox" />
  ) : (
    <Chip tone="good" label="Production" />
  );
}

export function Chip({
  tone,
  label,
  className,
}: {
  tone: Tone;
  label: string;
  className?: string;
}) {
  const t = TONE[tone];
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        t.chip,
        className,
      )}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", t.dot)} />
      {label}
    </span>
  );
}

// humanize turns a snake_case token into "Sentence case".
export function humanize(s: string): string {
  if (!s) return "";
  const words = s.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// tierName resolves a tier id against the catalog, falling back to the raw id
// (or a dash when the product is unmapped).
export function tierName(tierId: string, tiers: CatalogEntry[]): string {
  if (!tierId) return "—";
  return tiers.find((t) => t.id === tierId)?.name ?? tierId;
}

// Polar is the merchant of record: refunds, cancellations and products
// live in its dashboard, on sandbox.polar.sh in test mode and polar.sh in
// production. PolarOrg is what a link needs from the billing settings.
//
// The dashboard paths below are unverified until the Polar sandbox spike
// confirms them; they are built here only, so a fix is one place.
export type PolarOrg = Pick<BillingSettings, "organizationId" | "testMode">;

export function polarDashboardUrl(org: PolarOrg | null, path = ""): string {
  const host = org?.testMode === false ? "https://polar.sh" : "https://sandbox.polar.sh";
  if (!org?.organizationId) return `${host}/dashboard`;
  return `${host}/dashboard/${encodeURIComponent(org.organizationId)}${path}`;
}

export function polarSubscriptionsUrl(org: PolarOrg | null): string {
  return polarDashboardUrl(org, "/sales/subscriptions");
}

// Products are created in the Polar dashboard, then mapped in Harbor.
export function polarProductsUrl(org: PolarOrg | null): string {
  return polarDashboardUrl(org, "/products");
}

// Subscriptions from before the provider switch belong to Lemon Squeezy: they
// are cancelled or refunded in its dashboard, so their link stays there.
const LEGACY_LEMON_SQUEEZY_SUBSCRIPTIONS = "https://app.lemonsqueezy.com/subscriptions";

// subscriptionUrl deep-links a subscription in its provider's dashboard, or
// lands on the subscription list without one. A Polar subscription opens on the
// host of its own mode: sandbox rows stay listed after the switch to
// production. The organization is known only for the running mode, so a row of
// the other mode lands on that host's dashboard.
export function subscriptionUrl(
  s: { provider: string; providerSubscriptionId: string; testMode: boolean } | null,
  org: PolarOrg | null,
): string {
  const id = s?.providerSubscriptionId ? `/${encodeURIComponent(s.providerSubscriptionId)}` : "";
  if (s?.provider === "lemonsqueezy") return LEGACY_LEMON_SQUEEZY_SUBSCRIPTIONS + id;
  if (!s) return polarSubscriptionsUrl(org);
  if (!org?.organizationId || org.testMode !== s.testMode) {
    return polarDashboardUrl({ organizationId: "", testMode: s.testMode });
  }
  return polarSubscriptionsUrl(org) + id;
}

// providerName is a subscription's provider as the operator reads it.
export function providerName(provider: string): string {
  if (provider === "polar") return "Polar";
  if (provider === "lemonsqueezy") return "Lemon Squeezy";
  return humanize(provider);
}

// useBillingSettings reads the billing settings once (null while loading or
// when the billing-admin service is unavailable), for the dashboard links.
export function useBillingSettings(): BillingSettings | null {
  const [settings, setSettings] = useState<BillingSettings | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/billing/settings", { signal: controller.signal })
      .then((r) => (r.ok ? (r.json() as Promise<BillingSettingsResponse>) : null))
      .then((j) => setSettings(j?.available ? j.settings : null))
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return settings;
}

// Product-mapping checks. The label is Harbor's;
// the explanation under it is always Ogen's message. "suggested" is
// Harbor-side: an unmapped price with a suggestion from SuggestProductMappings.
const MAPPING_STATUS: Record<string, { tone: Tone; label: string }> = {
  ok: { tone: "good", label: "Matches" },
  suggested: { tone: "info", label: "Suggested" },
  unmapped: { tone: "warn", label: "Not mapped" },
  product_missing: { tone: "bad", label: "Product gone" },
  product_archived: { tone: "bad", label: "Product archived" },
  price_mismatch: { tone: "bad", label: "Price differs" },
  currency_mismatch: { tone: "bad", label: "No price in currency" },
  interval_mismatch: { tone: "bad", label: "Interval differs" },
  mode_mismatch: { tone: "bad", label: "Wrong mode" },
  trial_missing: { tone: "warn", label: "No 1-month trial" },
  unchecked: { tone: "neutral", label: "Not checked" },
};

export function MappingStatusBadge({ status }: { status: string }) {
  const s = MAPPING_STATUS[status] ?? { tone: "neutral" as Tone, label: humanize(status) };
  return <Chip tone={s.tone} label={s.label} />;
}

// formatMoney renders minor units in the price's currency, e.g. €1,000.00.
export function formatMoney(minor: number, currency: string): string {
  const cur = (currency || "").toUpperCase();
  try {
    return new Intl.NumberFormat("en-IE", { style: "currency", currency: cur }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${cur}`.trim();
  }
}

// priceIn is a product's fixed price in one currency, if it has one.
export function priceIn(
  prices: { currency: string; amountMinor: number }[],
  currency: string,
): { currency: string; amountMinor: number } | undefined {
  const cur = currency.toUpperCase();
  return prices.find((p) => p.currency.toUpperCase() === cur);
}

// pricesLabel lists a product's prices, e.g. "€50.00 · $55.00".
export function pricesLabel(prices: { currency: string; amountMinor: number }[]): string {
  if (prices.length === 0) return "no fixed price";
  return prices.map((p) => formatMoney(p.amountMinor, p.currency)).join(" · ");
}

// intervalLabel: month → Monthly, year → Yearly.
export function intervalLabel(interval: string): string {
  if (interval === "month") return "Monthly";
  if (interval === "year") return "Yearly";
  return humanize(interval);
}

// trialLabel describes a product's trial, e.g. "trial 1 month" or "no trial".
export function trialLabel(v: { hasFreeTrial: boolean; trialInterval: string; trialIntervalCount: number }): string {
  if (!v.hasFreeTrial || !v.trialInterval) return "no trial";
  const n = v.trialIntervalCount || 1;
  return `trial ${n} ${v.trialInterval}${n === 1 ? "" : "s"}`;
}

// The cutover runbook lives in the ogen repo.
export const CUTOVER_RUNBOOK_URL =
  "https://github.com/ogen-app/ogen/blob/main/docs/billing-cutover.md";

// errorText pulls Fiber's {error} message out of a failed response.
export async function errorText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error || `Request failed (${res.status})`;
}

// useTierCatalog fetches the tier catalog once to resolve tier ids to names.
// Degrades to an empty list when the tenant-admin surface is down.
export function useTierCatalog(): CatalogEntry[] {
  const [tiers, setTiers] = useState<CatalogEntry[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/tiers", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { entries?: CatalogEntry[] } | null) => setTiers(j?.entries ?? []))
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return tiers;
}
