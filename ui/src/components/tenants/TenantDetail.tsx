"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { Bar, Dot, InfoIcon } from "@/components/dashboard/primitives";
import { Loader } from "@/components/ui/loader";
import { Button } from "@/components/ui/button";
import {
  type Tenant,
  type VendorSpend,
  type ActivityEvent,
  type ActivityState,
  formatDate,
  formatUSD,
  formatBytes,
  spendSegments,
  StatusLabel,
  DetailRow,
  RecentActivity,
} from "@/components/tenants/shared";

interface DetailResponse {
  available: boolean;
  found?: boolean;
  tenant?: Tenant;
  spendAvailable?: boolean;
  error?: string;
}

// tenantIdFromLocation reads the trailing path segment (/tenants/<id>) from the
// browser URL. The detail route ships as a single static shell that the Go
// server serves for every /tenants/<id> request, so the real id lives in the URL
// rather than in the build-time route param. Read on the client only (in an
// effect) to avoid a hydration mismatch against the prerendered shell.
function tenantIdFromLocation(): string | null {
  const parts = window.location.pathname.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  return last ? decodeURIComponent(last) : null;
}

// ── page chrome ───────────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex-1 overflow-auto flex flex-col">
      <header className="h-20 border-b border-border flex items-center gap-4 px-6 shrink-0">
        <Button
          asChild
          variant="ghost"
          size="smIcon"
          aria-label="Back to tenants"
        >
          <Link href="/tenants">
            <ArrowLeftIcon className="size-4" />
          </Link>
        </Button>
        {children}
      </header>
    </main>
  );
}

// ── metric cards ──────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  info,
}: {
  label: string;
  value: React.ReactNode;
  info?: string;
}) {
  return (
    <div className="rounded-lg bg-primary p-5">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
          {label}
        </span>
        {info && <InfoIcon text={info} />}
      </div>
      <p className="mt-2 font-display text-2xl font-semibold tabular-nums text-foreground">
        {value}
      </p>
    </div>
  );
}

function SpendCard({
  spend,
  available,
}: {
  spend: VendorSpend;
  available: boolean;
}) {
  const hasOther = spend.otherMicros > 0;
  return (
    <div className="rounded-lg bg-primary p-5">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
          AI spend (month)
        </span>
        <InfoIcon text="This tenant's AI model cost for the current billing period, from the Timescale analytics rollups. The bar splits spend by vendor — Anthropic, Google, and Other." />
      </div>
      {!available ? (
        <p className="mt-2 text-sm text-tertiary-foreground">
          Analytics unavailable
        </p>
      ) : (
        <>
          <p className="mt-2 font-display text-2xl font-semibold tabular-nums text-foreground">
            {formatUSD(spend.totalMicros)}
          </p>
          {spend.totalMicros > 0 && (
            <>
              <Bar className="mt-3" segments={spendSegments(spend)} />
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-tertiary-foreground">
                <Dot color="bg-orange-500" label="Anthropic" />
                <Dot color="bg-blue-500" label="Google" />
                {hasOther && <Dot color="bg-neutral-400" label="Other" />}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ── main ────────────────────────────────────────────────────────────────────

export function TenantDetail() {
  const [id, setId] = useState<string | null>(null);
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityState>({ loading: true });

  // Resolve the tenant id from the URL after mount (see tenantIdFromLocation).
  useEffect(() => {
    setId(tenantIdFromLocation());
  }, []);

  // Load the tenant detail + recent activity once the id is known.
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    const enc = encodeURIComponent(id);

    fetch(`/api/tenants/${enc}`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`request failed (${r.status})`);
        return r.json();
      })
      .then((j: DetailResponse) => {
        setData(j);
        setError(null);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Failed to load");
      });

    fetch(`/api/tenants/${enc}/activity`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`request failed (${r.status})`);
        return r.json();
      })
      .then(
        (j: { activity: ActivityEvent[]; available: boolean; error?: string }) =>
          setActivity(
            j.available
              ? { loading: false, events: j.activity }
              : { loading: false, error: j.error ?? "unavailable" },
          ),
      )
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setActivity({
          loading: false,
          error: e instanceof Error ? e.message : "Failed to load",
        });
      });

    return () => controller.abort();
  }, [id]);

  // Resolving the id / first fetch in flight.
  if (!data && !error) {
    return (
      <Shell>
        <div className="flex items-center gap-2 text-sm text-tertiary-foreground">
          <Loader className="size-4" />
          Loading tenant…
        </div>
      </Shell>
    );
  }

  // Transport error, database unavailable, or unknown tenant — soft states.
  if (error || !data?.available || data.found === false || !data.tenant) {
    const message =
      error ||
      (data && !data.available
        ? data.error || "Ogen database not reachable"
        : "This tenant could not be found.");
    return (
      <Shell>
        <div>
          <h1 className="text-2xl font-display font-medium">Tenant</h1>
          <p className="text-xs text-tertiary-foreground">{message}</p>
        </div>
      </Shell>
    );
  }

  const t = data.tenant;
  const spendAvailable = data.spendAvailable ?? false;

  return (
    <main className="flex-1 overflow-auto flex flex-col">
      <header className="h-20 border-b border-border flex items-center gap-4 px-6 shrink-0">
        <Button
          asChild
          variant="ghost"
          size="smIcon"
          aria-label="Back to tenants"
        >
          <Link href="/tenants">
            <ArrowLeftIcon className="size-4" />
          </Link>
        </Button>
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-display font-medium">
            {t.name}
          </h1>
          <p className="truncate font-mono text-xs text-tertiary-foreground">
            {t.slug}
          </p>
        </div>
        <div className="ml-auto">
          <StatusLabel status={t.status} />
        </div>
      </header>

      <div className="p-6 space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Users"
            value={t.users}
            info="People with a user account in this tenant, from the Ogen control-plane database."
          />
          <StatCard
            label="Zernio profiles"
            value={t.zernioProfiles}
            info="Active social profiles this tenant has connected through Zernio."
          />
          <StatCard
            label="R2 storage"
            value={formatBytes(t.r2Bytes)}
            info="Total size of this tenant's files stored in Cloudflare R2 object storage."
          />
          <SpendCard spend={t.spend} available={spendAvailable} />
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <section className="rounded-lg bg-primary p-6">
            <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
              Identity
            </h2>
            <div className="space-y-2.5">
              <DetailRow
                label="Tenant ID"
                value={<span className="font-mono">{t.id}</span>}
              />
              <DetailRow
                label="Slug"
                value={<span className="font-mono">{t.slug}</span>}
              />
              <DetailRow label="Registered" value={formatDate(t.createdAt)} />
              <DetailRow
                label="Status"
                value={<span className="capitalize">{t.status}</span>}
              />
            </div>
          </section>

          <section className="rounded-lg bg-primary p-6">
            <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
              Recent activity
            </h2>
            <RecentActivity state={activity} />
          </section>
        </div>
      </div>
    </main>
  );
}
