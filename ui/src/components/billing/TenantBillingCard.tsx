"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  CreditCardIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ui/loader";
import { cn } from "@/lib/utils";
import type { CatalogEntry } from "@/components/tiers-groups/types";
import {
  BillingStatusBadge,
  ChangeStatusBadge,
  Chip,
  ModeBadge,
  OutcomeBadge,
  LEMON_SQUEEZY_DASHBOARD,
  errorText,
  formatDate,
  formatDateTime,
  humanize,
  lemonSqueezySubscriptionUrl,
  tierName,
  useTierCatalog,
} from "./format";
import { ReasonDialog, type ReasonRequest } from "./ReasonDialog";
import type {
  Subscription,
  TenantBilling,
  TenantBillingResponse,
} from "./types";

// TenantBillingCard is the tenant detail page's Billing tab (CON-327): the
// workspace's subscriptions (incl. test mode and the invalidated state), any
// scheduled downgrade, the billing_required flag with the comp/exempt toggle,
// the owners' free-month eligibility and the last 20 webhook events. Dunning is
// operator-decides — Ogen never changes the tier or status itself — so this is
// read + the two billing actions (comp/exempt, resync); suspend and tier moves
// live in the Tenants table menu and on /billing.
export function TenantBillingCard({ tenantId }: { tenantId: string }) {
  const [data, setData] = useState<TenantBillingResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resyncing, setResyncing] = useState(false);
  const [notice, setNotice] = useState<{ msg: string; error?: boolean } | null>(
    null,
  );
  const [request, setRequest] = useState<ReasonRequest | null>(null);
  const tiers = useTierCatalog();

  const enc = encodeURIComponent(tenantId);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/tenants/${enc}/billing`, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(await errorText(r));
        return r.json() as Promise<TenantBillingResponse>;
      })
      .then((j) => {
        setData(j);
        setError(null);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Failed to load billing.");
      });
    return () => controller.abort();
  }, [enc]);

  const flash = useCallback((msg: string, isError = false) => {
    setNotice({ msg, error: isError });
    window.setTimeout(() => setNotice(null), 4000);
  }, []);

  const resync = async () => {
    setResyncing(true);
    try {
      const res = await fetch(`/api/tenants/${enc}/billing/resync`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(await errorText(res));
      const j = (await res.json()) as TenantBillingResponse;
      setData(j);
      const n = j.corrected ?? 0;
      flash(
        n === 0
          ? "Resynced: already in step with Lemon Squeezy."
          : `Resynced: ${n} subscription${n === 1 ? "" : "s"} corrected.`,
      );
    } catch (e) {
      flash(e instanceof Error ? e.message : "Resync failed.", true);
    } finally {
      setResyncing(false);
    }
  };

  const askSetRequired = (required: boolean) =>
    setRequest({
      title: required ? "Require billing" : "Comp / exempt this workspace",
      description: required
        ? "Puts the workspace back behind the billing gate. If it has no subscription, its members are asked to check out before they can keep using the app."
        : "Lets the workspace use the app without checking out — for friends, internal workspaces and design partners. Existing subscriptions are not cancelled; do that in Lemon Squeezy.",
      confirmLabel: required ? "Require billing" : "Comp workspace",
      placeholder: required ? "e.g. design-partner period ended" : "e.g. design partner",
      run: async (reason) => {
        const res = await fetch(`/api/tenants/${enc}/billing/required`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ required, reason }),
        });
        if (!res.ok) throw new Error(await errorText(res));
        setData((await res.json()) as TenantBillingResponse);
        flash(required ? "Billing is required again." : "Workspace comped.");
      },
    });

  if (!data && !error) {
    return (
      <Card>
        <div className="flex items-center gap-2 p-6 text-sm text-tertiary-foreground">
          <Loader className="size-4" />
          Loading billing…
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <p className="p-6 text-sm text-destructive">{error}</p>
      </Card>
    );
  }

  if (!data?.available) {
    return (
      <Card>
        <p className="p-6 text-sm text-tertiary-foreground">
          The billing-admin service is unavailable. Check that Ogen is running
          and that Harbor’s <code className="font-mono">OGEN_GRPC_ADDR</code> /{" "}
          <code className="font-mono">OGEN_GRPC_TOKEN</code> are configured.
        </p>
      </Card>
    );
  }

  const b = data.billing;

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-foreground">Billing</h2>
            <p className="mt-1 max-w-xl text-xs text-tertiary-foreground">
              Mirrored from Lemon Squeezy. Ogen never changes this workspace’s
              tier or status on its own when a payment fails — you decide.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={resync}
              disabled={resyncing}
            >
              {resyncing ? (
                <Loader className="size-3.5 border-[1.5px]" />
              ) : (
                <ArrowsClockwiseIcon className="size-4" />
              )}
              Resync
            </Button>
            <Button
              variant="defaultInverted"
              size="sm"
              className="font-semibold"
              onClick={() => askSetRequired(!b.billingRequired)}
            >
              {b.billingRequired ? "Comp / exempt…" : "Require billing…"}
            </Button>
          </div>
        </div>

        <GateSummary billing={b} />
      </Card>

      <Card>
        <SectionHeader
          title="Subscriptions"
          aside={
            <a
              href={LEMON_SQUEEZY_DASHBOARD}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-tertiary-foreground hover:text-foreground"
            >
              Refunds &amp; cancellations in Lemon Squeezy
              <ArrowSquareOutIcon className="size-3.5" />
            </a>
          }
        />
        {b.subscriptions.length === 0 ? (
          <Empty icon={<CreditCardIcon className="size-7 text-quaternary" />}>
            {b.billingRequired
              ? "No subscription yet — the workspace hasn’t checked out."
              : "No subscription. The workspace is comped or grandfathered."}
          </Empty>
        ) : (
          <div className="divide-y divide-border">
            {b.subscriptions.map((s) => (
              <SubscriptionRow key={s.id} s={s} tiers={tiers} />
            ))}
          </div>
        )}
      </Card>

      {b.scheduledChanges.length > 0 && (
        <Card>
          <SectionHeader title="Scheduled changes" />
          <div className="divide-y divide-border">
            {b.scheduledChanges.map((c) => (
              <div
                key={c.id}
                className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 px-6 py-3 text-sm"
              >
                <span className="min-w-0 truncate font-mono text-xs text-secondary-foreground">
                  {c.fromTierVersionPriceId || "—"} →{" "}
                  {c.toTierVersionPriceId || "—"}
                </span>
                <span className="text-xs text-secondary-foreground">
                  Effective {formatDate(c.effectiveAt)}
                </span>
                <span className="justify-self-end">
                  <ChangeStatusBadge status={c.status} />
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Card>
          <SectionHeader title="Owners · free month" />
          {b.owners.length === 0 ? (
            <Empty>No owners found.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {b.owners.map((o) => (
                <li
                  key={o.userId}
                  className="flex items-center justify-between gap-3 px-6 py-3 text-sm"
                >
                  <span className="min-w-0 truncate text-secondary-foreground">
                    {o.email || o.userId}
                  </span>
                  {o.trialEligible ? (
                    <Chip tone="good" label="Eligible" />
                  ) : (
                    <Chip tone="neutral" label="Used" />
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <SectionHeader title="Recent webhook events" />
          {b.recentWebhookEvents.length === 0 ? (
            <Empty>No webhook events for this workspace.</Empty>
          ) : (
            <div className="divide-y divide-border">
              {b.recentWebhookEvents.map((w) => (
                <div
                  key={w.id}
                  className="grid grid-cols-[7.5rem_minmax(0,1fr)_auto] items-start gap-3 px-6 py-3 text-sm"
                >
                  <span className="text-xs tabular-nums text-tertiary-foreground">
                    {formatDateTime(w.receivedAt)}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-secondary-foreground">
                      {w.eventName}
                      {w.testMode && (
                        <span className="text-tertiary-foreground"> · test</span>
                      )}
                    </span>
                    {w.error && (
                      <span className="mt-0.5 block text-xs break-words text-destructive">
                        {w.error}
                      </span>
                    )}
                  </span>
                  <OutcomeBadge outcome={w.outcome} />
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <ReasonDialog request={request} onClose={() => setRequest(null)} />

      {notice && (
        <div
          role={notice.error ? "alert" : "status"}
          className={cn(
            "fixed bottom-6 right-6 z-[200] max-w-sm rounded-md border bg-primary px-4 py-2 text-sm shadow-xl",
            notice.error
              ? "border-destructive/40 text-destructive"
              : "border-border text-foreground",
          )}
        >
          {notice.msg}
        </div>
      )}
    </div>
  );
}

// GateSummary reads the gate in one line: is billing required (the stored
// flag), and is the 402 gate on right now (required and no subscription).
function GateSummary({ billing: b }: { billing: TenantBilling }) {
  const current = b.subscriptions.find((s) => !s.invalidatedAt) ?? null;
  return (
    <dl className="grid gap-x-8 gap-y-3 px-6 py-4 text-sm sm:grid-cols-3">
      <Fact label="Billing">
        <BillingStatusBadge
          status={
            current
              ? current.status
              : b.billingRequired
                ? "awaiting_checkout"
                : "not_required"
          }
        />
      </Fact>
      <Fact label="Billing required">
        {b.billingRequired ? (
          <span className="text-secondary-foreground">Yes</span>
        ) : (
          <Chip tone="info" label="Comped / exempt" />
        )}
      </Fact>
      <Fact label="Checkout gate">
        {b.gated ? (
          <Chip tone="warn" label="On — members must check out" />
        ) : (
          <span className="text-secondary-foreground">Off</span>
        )}
      </Fact>
    </dl>
  );
}

function SubscriptionRow({ s, tiers }: { s: Subscription; tiers: CatalogEntry[] }) {
  const invalidated = !!s.invalidatedAt;
  return (
    <div className={cn("px-6 py-4", invalidated && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-2">
        <BillingStatusBadge status={s.status} />
        <ModeBadge testMode={s.testMode} />
        {s.duplicate && <Chip tone="warn" label="Duplicate" />}
        {invalidated && (
          <Chip
            tone="neutral"
            label={`Invalidated${s.invalidatedReason ? ` · ${humanize(s.invalidatedReason)}` : ""}`}
          />
        )}
        {!s.firstPaidAt && <Chip tone="neutral" label="Never paid" />}
        {s.teardownAt && (
          <Chip tone="bad" label={`Teardown ${formatDate(s.teardownAt)}`} />
        )}
        <a
          href={lemonSqueezySubscriptionUrl(s.providerSubscriptionId)}
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1 text-xs text-tertiary-foreground hover:text-foreground"
        >
          #{s.providerSubscriptionId || s.id}
          <ArrowSquareOutIcon className="size-3.5" />
        </a>
      </div>
      <dl className="mt-3 grid gap-x-8 gap-y-2 text-xs sm:grid-cols-3 lg:grid-cols-6">
        <Fact label="Tier">{tierName(s.tierId, tiers)}</Fact>
        <Fact label="Renews">{formatDate(s.renewsAt)}</Fact>
        <Fact label="Ends">{formatDate(s.endsAt)}</Fact>
        <Fact label="Trial ends">{formatDate(s.trialEndsAt)}</Fact>
        <Fact label="First paid">
          {s.firstPaidAt ? formatDate(s.firstPaidAt) : "Never"}
        </Fact>
        <Fact label="Card">
          {s.cardBrand
            ? `${humanize(s.cardBrand)} ···· ${s.cardLastFour}`
            : "—"}
        </Fact>
      </dl>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-tertiary-foreground">
        {label}
      </dt>
      <dd className="mt-1 truncate text-secondary-foreground">{children}</dd>
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-xl bg-primary">{children}</div>;
}

function SectionHeader({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-3">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {aside}
    </div>
  );
}

function Empty({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 p-8 text-center">
      {icon}
      <p className="text-sm text-tertiary-foreground">{children}</p>
    </div>
  );
}
