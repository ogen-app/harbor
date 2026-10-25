import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { CatalogEntry } from "@/components/tiers-groups/types";

// Shared presentation helpers for the billing surfaces (the /billing page, the
// tenant Billing tab and the Tenants table column), so statuses, reasons and
// dates read the same everywhere. Status strings are Lemon Squeezy's own
// vocabulary, passed through unchanged by Ogen.

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
// (complimentary, not_required, awaiting_checkout) plus Lemon Squeezy's
// subscription statuses. complimentary is a tester's workspace (CON-333).
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
    hint: "A renewal payment failed; Lemon Squeezy is retrying.",
  },
  unpaid: {
    tone: "bad",
    label: "Unpaid",
    hint: "Payment retries are exhausted. The workspace keeps its tier until you act.",
  },
  paused: {
    tone: "warn",
    label: "Paused",
    hint: "Payment collection is paused in Lemon Squeezy.",
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
    hint: "The workspace has more than one live subscription; refund or cancel one in Lemon Squeezy.",
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

// ModeBadge marks Lemon Squeezy test-mode (sandbox) vs live data.
export function ModeBadge({ testMode }: { testMode: boolean }) {
  return testMode ? (
    <Chip tone="warn" label="Test mode" />
  ) : (
    <Chip tone="good" label="Live" />
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
// (or a dash when the variant is unmapped).
export function tierName(tierId: string, tiers: CatalogEntry[]): string {
  if (!tierId) return "—";
  return tiers.find((t) => t.id === tierId)?.name ?? tierId;
}

// Lemon Squeezy is the merchant of record: refunds and cancellations happen in
// its dashboard. These deep links land on the subscription / the list.
export const LEMON_SQUEEZY_DASHBOARD = "https://app.lemonsqueezy.com/subscriptions";

export function lemonSqueezySubscriptionUrl(providerSubscriptionId: string): string {
  return providerSubscriptionId
    ? `${LEMON_SQUEEZY_DASHBOARD}/${encodeURIComponent(providerSubscriptionId)}`
    : LEMON_SQUEEZY_DASHBOARD;
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
