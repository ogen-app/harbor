"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { Bar, Dot, InfoIcon } from "@/components/dashboard/primitives";
import { Loader } from "@/components/ui/loader";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  type Tenant,
  type VendorSpend,
  type ActivityEvent,
  type ActivityDay,
  type ActivityState,
  type TenantUser,
  type UsersState,
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

// ── metrics card ──────────────────────────────────────────────────────────────

// CellLabel is the shared uppercase label + info tooltip atop each metric cell.
function CellLabel({ label, info }: { label: string; info?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
        {label}
      </span>
      {info && <InfoIcon text={info} />}
    </div>
  );
}

// MetricCell is one cell of the merged metrics card (dividers/background are
// owned by the parent MetricsCard).
function MetricCell({
  label,
  value,
  info,
}: {
  label: string;
  value: React.ReactNode;
  info?: string;
}) {
  return (
    <div className="p-5">
      <CellLabel label={label} info={info} />
      <p className="mt-2 font-display text-2xl font-semibold tabular-nums text-foreground">
        {value}
      </p>
    </div>
  );
}

// SpendCell is the AI-spend cell, with the per-vendor concentration bar.
function SpendCell({
  spend,
  available,
}: {
  spend: VendorSpend;
  available: boolean;
}) {
  const hasOther = spend.otherMicros > 0;
  return (
    <div className="p-5">
      <CellLabel
        label="AI spend (month)"
        info="This tenant's AI model cost for the current billing period, from the Timescale analytics rollups. The bar splits spend by vendor — Anthropic, Google, and Other."
      />
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

// MetricsCard merges the per-tenant metrics into one card, split into cells by
// vertical dividers on wide screens (stacked on narrow ones).
function MetricsCard({
  tenant,
  spendAvailable,
}: {
  tenant: Tenant;
  spendAvailable: boolean;
}) {
  return (
    <div className="grid grid-cols-1 divide-y divide-border rounded-lg bg-primary sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x">
      <MetricCell
        label="Users"
        value={tenant.users}
        info="People with a user account in this tenant, from the Ogen control-plane database."
      />
      <MetricCell
        label="Zernio profiles"
        value={tenant.zernioProfiles}
        info="Active social profiles this tenant has connected through Zernio."
      />
      <MetricCell
        label="R2 storage"
        value={formatBytes(tenant.r2Bytes)}
        info="Total size of this tenant's files stored in Cloudflare R2 object storage."
      />
      <SpendCell spend={tenant.spend} available={spendAvailable} />
    </div>
  );
}

// ── users list ────────────────────────────────────────────────────────────────

// initials derives up-to-two uppercase letters from a name, falling back to email.
function initials(name: string, email: string): string {
  const source = name.trim() || email;
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

function UserRow({ user }: { user: TenantUser }) {
  return (
    <li className="flex items-center gap-3 px-6 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold text-secondary-foreground">
        {initials(user.name, user.email)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {user.name || "—"}
        </p>
        <p className="truncate text-xs text-tertiary-foreground">
          {user.email || "—"}
        </p>
      </div>
      <span className="shrink-0 text-xs tabular-nums text-tertiary-foreground">
        {formatDate(user.createdAt)}
      </span>
    </li>
  );
}

// UsersSection lists a tenant's members. total is the authoritative count (the
// list itself is capped server-side), so a truncation note can be shown.
function UsersSection({ state, total }: { state: UsersState; total: number }) {
  return (
    <section className="rounded-lg bg-primary">
      <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
          Users
        </h2>
        <span className="text-xs tabular-nums text-tertiary-foreground">
          {total}
        </span>
      </div>
      {state.loading ? (
        <div className="flex items-center gap-2 px-6 py-5 text-xs text-tertiary-foreground">
          <Loader className="size-3.5 border-[1.5px]" />
          Loading users…
        </div>
      ) : state.error ? (
        <p className="px-6 py-5 text-xs text-tertiary-foreground">
          Users unavailable — {state.error}
        </p>
      ) : !state.users || state.users.length === 0 ? (
        <p className="px-6 py-5 text-xs text-tertiary-foreground">No users</p>
      ) : (
        <>
          <ul className="divide-y divide-border">
            {state.users.map((u) => (
              <UserRow key={u.id} user={u} />
            ))}
          </ul>
          {state.users.length < total && (
            <p className="border-t border-border px-6 py-3 text-xs text-tertiary-foreground">
              Showing the {state.users.length} most recent of {total}.
            </p>
          )}
        </>
      )}
    </section>
  );
}

// ── recent activity ───────────────────────────────────────────────────────────

// "2026-06-28" → "Jun 28" (parsed as local midnight to avoid TZ drift).
function fmtDay(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

const ACTIVITY_CHART_H = 48; // px

// ActivityChart is a 60-day daily event-volume bar chart (mirrors the Tenants
// page registrations chart, in the activity accent colour).
function ActivityChart({ series }: { series: ActivityDay[] }) {
  const max = Math.max(1, ...series.map((d) => d.count));
  return (
    <div>
      <div className="flex items-end gap-[2px]" style={{ height: ACTIVITY_CHART_H }}>
        {series.map((d) =>
          d.count > 0 ? (
            <Tooltip key={d.date}>
              <TooltipTrigger asChild>
                <div
                  className="flex-1 cursor-default rounded-sm bg-emerald-500 transition-colors hover:bg-emerald-400"
                  style={{
                    height: `${Math.max((d.count / max) * ACTIVITY_CHART_H, 3)}px`,
                  }}
                />
              </TooltipTrigger>
              <TooltipContent className="border-foreground bg-foreground text-left text-background">
                <p className="font-medium">{fmtDay(d.date)}</p>
                <p className="text-background/70">
                  {d.count} {d.count === 1 ? "event" : "events"}
                </p>
              </TooltipContent>
            </Tooltip>
          ) : (
            <div
              key={d.date}
              title={`${fmtDay(d.date)} · no activity`}
              className="flex-1 rounded-sm bg-secondary"
              style={{ height: "2px" }}
            />
          ),
        )}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-tertiary-foreground">
        <span>{series.length ? fmtDay(series[0].date) : ""}</span>
        <span>{series.length ? fmtDay(series[series.length - 1].date) : ""}</span>
      </div>
    </div>
  );
}

// ActivityCard is the screen-wide recent-activity card: a 60-day volume chart
// above a scrollable event list that fades out at the bottom.
function ActivityCard({ state }: { state: ActivityState }) {
  const series = state.series ?? [];
  const total = series.reduce((sum, d) => sum + d.count, 0);
  return (
    <section className="rounded-lg bg-primary p-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
            Recent activity
          </h2>
          <InfoIcon text="Publishing and content events for this tenant from the Ogen post_logs audit trail. The chart shows daily event volume over the last 60 days; the list shows the most recent events." />
        </div>
        {!state.loading && !state.error && (
          <span className="text-xs tabular-nums text-tertiary-foreground">
            {total} in 60 days
          </span>
        )}
      </div>

      {state.loading ? (
        <div className="mt-4 flex items-center gap-2 text-xs text-tertiary-foreground">
          <Loader className="size-3.5 border-[1.5px]" />
          Loading activity…
        </div>
      ) : state.error ? (
        <p className="mt-4 text-xs text-tertiary-foreground">
          Activity unavailable — {state.error}
        </p>
      ) : (
        <>
          <div className="mt-4">
            <ActivityChart series={series} />
          </div>
          {/* Scrollable event list, capped at 200px, fading out at the bottom
              so the cut-off reads as "there's more, scroll". */}
          <div className="relative mt-5">
            <div className="max-h-[200px] overflow-y-auto pr-1">
              <RecentActivity state={state} />
            </div>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-primary to-transparent" />
          </div>
        </>
      )}
    </section>
  );
}

// ── main ────────────────────────────────────────────────────────────────────

export function TenantDetail() {
  const [id, setId] = useState<string | null>(null);
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityState>({ loading: true });
  const [users, setUsers] = useState<UsersState>({ loading: true });

  // Resolve the tenant id from the URL after mount (see tenantIdFromLocation).
  useEffect(() => {
    // Client-only URL read (avoids a hydration mismatch vs. the static shell).
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
        (j: {
          activity: ActivityEvent[];
          series?: ActivityDay[];
          available: boolean;
          error?: string;
        }) =>
          setActivity(
            j.available
              ? { loading: false, events: j.activity, series: j.series }
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

    fetch(`/api/tenants/${enc}/users`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`request failed (${r.status})`);
        return r.json();
      })
      .then((j: { users: TenantUser[]; available: boolean; error?: string }) =>
        setUsers(
          j.available
            ? { loading: false, users: j.users }
            : { loading: false, error: j.error ?? "unavailable" },
        ),
      )
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setUsers({
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
        <MetricsCard tenant={t} spendAvailable={spendAvailable} />

        <section className="rounded-lg bg-primary p-6">
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
            Identity
          </h2>
          <div className="grid gap-x-10 gap-y-2.5 sm:grid-cols-2">
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

        <UsersSection state={users} total={t.users} />

        <ActivityCard state={activity} />
      </div>
    </main>
  );
}
