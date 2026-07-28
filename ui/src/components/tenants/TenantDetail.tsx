"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeftIcon,
  InstagramLogoIcon,
  FacebookLogoIcon,
  XLogoIcon,
  TwitterLogoIcon,
  LinkedinLogoIcon,
  TiktokLogoIcon,
  YoutubeLogoIcon,
  PinterestLogoIcon,
  ThreadsLogoIcon,
  SnapchatLogoIcon,
  RedditLogoIcon,
  WhatsappLogoIcon,
  TelegramLogoIcon,
  DiscordLogoIcon,
  MastodonLogoIcon,
  TwitchLogoIcon,
  type Icon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { InfoIcon } from "@/components/dashboard/primitives";
import { DailyTokenCostChart } from "@/components/dashboard/DailyTokenCostChart";
import { Loader } from "@/components/ui/loader";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import {
  type Tenant,
  type ActivityEvent,
  type ActivityDay,
  type ActivityState,
  type TenantUser,
  type UsersState,
  type ZernioAccount,
  type ZernioState,
  formatDate,
  formatDateTime,
  formatBytes,
  StatusLabel,
  DetailRow,
} from "@/components/tenants/shared";
import {
  ActivityFilterBar,
  type ActivityFilterToken,
  type ActivityFieldKey,
  type ActivityOptions,
} from "@/components/tenants/ActivityFilterBar";

interface DetailResponse {
  available: boolean;
  found?: boolean;
  tenant?: Tenant;
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

// MetricCell is one cell of the metric strip (dividers/background are owned by
// the parent ProfileCard).
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
      <p className="mt-2 font-display text-2xl font-semibold text-foreground">
        {value}
      </p>
    </div>
  );
}

// ProfileCard merges the tenant's core metrics (users, Zernio, R2) and its
// identity details into a single card: a metric strip above, identity below.
function ProfileCard({ tenant }: { tenant: Tenant }) {
  return (
    <div className="rounded-lg bg-primary">
      <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
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
      </div>
      <div className="border-t border-border p-6">
        <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
          Identity
        </h2>
        <div className="grid gap-x-10 gap-y-2.5 sm:grid-cols-2">
          <DetailRow
            label="Tenant ID"
            value={<span className="font-mono">{tenant.id}</span>}
          />
          <DetailRow
            label="Slug"
            value={<span className="font-mono">{tenant.slug}</span>}
          />
          <DetailRow label="Registered" value={formatDate(tenant.createdAt)} />
          <DetailRow label="Status" value={<StatusLabel status={tenant.status} />} />
        </div>
      </div>
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

// ── zernio accounts ────────────────────────────────────────────────────────────

// Each known platform maps to its Phosphor brand logo, tinted in the platform's
// brand colour (no background). The text-[#…] literals are static so Tailwind
// picks them up; black-brand marks use text-foreground so they adapt to theme.
type PlatformStyle = { Icon: Icon; color: string };

const PLATFORMS: Record<string, PlatformStyle> = {
  instagram: { Icon: InstagramLogoIcon, color: "text-[#E4405F]" },
  facebook: { Icon: FacebookLogoIcon, color: "text-[#1877F2]" },
  twitter: { Icon: TwitterLogoIcon, color: "text-[#1DA1F2]" },
  x: { Icon: XLogoIcon, color: "text-foreground" },
  linkedin: { Icon: LinkedinLogoIcon, color: "text-[#0A66C2]" },
  tiktok: { Icon: TiktokLogoIcon, color: "text-foreground" },
  youtube: { Icon: YoutubeLogoIcon, color: "text-[#FF0000]" },
  pinterest: { Icon: PinterestLogoIcon, color: "text-[#E60023]" },
  threads: { Icon: ThreadsLogoIcon, color: "text-foreground" },
  snapchat: { Icon: SnapchatLogoIcon, color: "text-[#F5B301]" },
  reddit: { Icon: RedditLogoIcon, color: "text-[#FF4500]" },
  whatsapp: { Icon: WhatsappLogoIcon, color: "text-[#25D366]" },
  telegram: { Icon: TelegramLogoIcon, color: "text-[#229ED9]" },
  discord: { Icon: DiscordLogoIcon, color: "text-[#5865F2]" },
  mastodon: { Icon: MastodonLogoIcon, color: "text-[#6364FF]" },
  twitch: { Icon: TwitchLogoIcon, color: "text-[#9146FF]" },
};

// Common alternative spellings → canonical platform key.
const PLATFORM_ALIASES: Record<string, string> = {
  ig: "instagram",
  fb: "facebook",
  meta: "facebook",
  yt: "youtube",
  snap: "snapchat",
  xtwitter: "x",
  twitterx: "x",
};

function platformStyle(platform: string): PlatformStyle | null {
  const key = platform.toLowerCase().replace(/[^a-z0-9]/g, "");
  return PLATFORMS[PLATFORM_ALIASES[key] ?? key] ?? null;
}

// PlatformBadge shows a connected profile's social-network logo tinted in its
// brand colour, falling back to the platform's first two letters when the
// network isn't recognised.
function PlatformBadge({ platform }: { platform: string }) {
  const style = platformStyle(platform);
  if (!style) {
    return (
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-xs font-semibold uppercase text-tertiary-foreground">
        {platform.slice(0, 2) || "–"}
      </span>
    );
  }
  const { Icon: PlatformIcon, color } = style;
  return (
    <span className="flex size-9 shrink-0 items-center justify-center">
      <PlatformIcon className={cn("size-7", color)} weight="fill" />
    </span>
  );
}

// AccountStat is one labelled throughput number in a Zernio account row.
function AccountStat({
  label,
  value,
  danger,
}: {
  label: string;
  value: number;
  danger?: boolean;
}) {
  return (
    <div className="text-right">
      <p
        className={cn(
          "font-display text-base font-semibold leading-none tabular-nums",
          danger && value > 0 ? "text-red-600" : "text-foreground",
        )}
      >
        {value}
      </p>
      <p className="mt-1 text-[10px] uppercase tracking-wide text-tertiary-foreground">
        {label}
      </p>
    </div>
  );
}

function ZernioRow({ account: a }: { account: ZernioAccount }) {
  return (
    <li className="flex flex-col gap-4 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <PlatformBadge platform={a.platform} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">
            {a.username ? `@${a.username}` : "—"}
          </p>
          <p className="truncate text-xs text-tertiary-foreground">
            <span className="capitalize">{a.platform || "unknown"}</span>
            {a.lastPostAt
              ? ` · last post ${formatDate(a.lastPostAt)}`
              : a.createdAt
                ? ` · joined ${formatDate(a.createdAt)}`
                : ""}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 sm:justify-end">
        <AccountStat label="Scheduled" value={a.scheduledPosts} />
        <AccountStat label="Published" value={a.publishedPosts} />
        <AccountStat label="Failed" value={a.failedPosts} danger />
        <AccountStat label="Total" value={a.totalPosts} />
        <span className="inline-flex items-center gap-1.5">
          <span
            className={cn(
              "size-2 rounded-full",
              a.isActive ? "bg-emerald-500" : "bg-amber-500",
            )}
          />
          <span className="text-xs text-secondary-foreground">
            {a.isActive ? "Active" : "Inactive"}
          </span>
        </span>
      </div>
    </li>
  );
}

// ZernioSection is the screen-wide connected-accounts block: one row per social
// profile with its post throughput.
function ZernioSection({ state, total }: { state: ZernioState; total: number }) {
  const count = state.accounts?.length ?? total;
  return (
    <section className="rounded-lg bg-primary">
      <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div className="flex items-center gap-1.5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
            Zernio accounts
          </h2>
          <InfoIcon text="Social profiles this tenant has connected through Zernio, each with its post throughput — scheduled, published, failed, and total — from the Ogen posts table." />
        </div>
        <span className="text-xs tabular-nums text-tertiary-foreground">
          {count}
        </span>
      </div>
      {state.loading ? (
        <div className="flex items-center gap-2 px-6 py-5 text-xs text-tertiary-foreground">
          <Loader className="size-3.5 border-[1.5px]" />
          Loading accounts…
        </div>
      ) : state.error ? (
        <p className="px-6 py-5 text-xs text-tertiary-foreground">
          Accounts unavailable — {state.error}
        </p>
      ) : !state.accounts || state.accounts.length === 0 ? (
        <p className="px-6 py-5 text-xs text-tertiary-foreground">
          No connected accounts
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {state.accounts.map((a) => (
            <ZernioRow key={a.id} account={a} />
          ))}
        </ul>
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

// px — matches CHART_H (the plot height) in DailyTokenCostChart so the two
// charts on the detail page share the same height and x-axis treatment.
const ACTIVITY_CHART_H = 240;

// ActivityChart is a 90-day daily event-volume bar chart (mirrors the Tenants
// page registrations chart, in the activity accent colour).
function ActivityChart({ series }: { series: ActivityDay[] }) {
  const max = Math.max(1, ...series.map((d) => d.count));
  // Label roughly seven x-axis ticks, evenly spaced (mirrors DailyTokenCostChart).
  const labelStride = Math.max(1, Math.ceil(series.length / 7));
  return (
    <div>
      <div className="flex items-end gap-[2px]" style={{ height: ACTIVITY_CHART_H }}>
        {series.map((d) =>
          d.count > 0 ? (
            <Tooltip key={d.date}>
              <TooltipTrigger asChild>
                <div
                  tabIndex={0}
                  aria-label={`${fmtDay(d.date)} · ${d.count} ${d.count === 1 ? "event" : "events"}`}
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
      {/* X-axis date labels, aligned under their bars (mirrors the daily
          token-cost chart). */}
      <div className="mt-2 flex gap-[2px]">
        {series.map((d, i) => (
          <span
            key={d.date}
            className="flex-1 text-center text-[11px] text-tertiary-foreground"
          >
            {i % labelStride === 0 ? (
              <span className="inline-block whitespace-nowrap">
                {fmtDay(d.date)}
              </span>
            ) : null}
          </span>
        ))}
      </div>
    </div>
  );
}

// activityOptions collects the distinct non-empty values present for each
// filterable field, feeding the filter bar's value suggestions.
function activityOptions(events: ActivityEvent[]): ActivityOptions {
  const sets: Record<ActivityFieldKey, Set<string>> = {
    category: new Set(),
    type: new Set(),
    status: new Set(),
    source: new Set(),
  };
  for (const e of events) {
    if (e.category) sets.category.add(e.category);
    if (e.type) sets.type.add(e.type);
    if (e.status) sets.status.add(e.status);
    if (e.source) sets.source.add(e.source);
  }
  return {
    category: [...sets.category].sort(),
    type: [...sets.type].sort(),
    status: [...sets.status].sort(),
    source: [...sets.source].sort(),
  };
}

// matchActivity applies one filter token to an event (is / is not, exact match).
function matchActivity(token: ActivityFilterToken, e: ActivityEvent): boolean {
  const v = e[token.field];
  return token.operator === "is not" ? v !== token.value : v === token.value;
}

// ── activity table ────────────────────────────────────────────────────────────

const ACTIVITY_TH =
  "sticky top-0 z-10 border-b border-border bg-primary py-2.5 font-semibold";

// ActivityTable lists activity events with the CON-125 fields (source shown as a
// tag). It scrolls within its screen-tall parent; the header stays pinned.
function ActivityTable({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="px-6 py-6 text-sm text-tertiary-foreground">
        No activity matches the current filters.
      </p>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-[11px] uppercase tracking-wide text-tertiary-foreground">
          <th className={cn(ACTIVITY_TH, "px-6")}>Time</th>
          <th className={ACTIVITY_TH}>Category</th>
          <th className={ACTIVITY_TH}>Type</th>
          <th className={ACTIVITY_TH}>Status</th>
          <th className={cn(ACTIVITY_TH, "px-6")}>Source</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {events.map((e, i) => (
          <tr key={i} className="transition-colors hover:bg-secondary/40">
            <td className="whitespace-nowrap px-6 py-2.5 tabular-nums text-tertiary-foreground">
              {formatDateTime(e.at)}
            </td>
            <td className="py-2.5 text-secondary-foreground">
              {e.category || "—"}
            </td>
            <td className="py-2.5 font-medium text-foreground">
              {e.type || "—"}
            </td>
            <td className="py-2.5 text-secondary-foreground">
              {e.status || "—"}
            </td>
            <td className="px-6 py-2.5">
              {e.source ? (
                <span className="inline-flex items-center rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
                  {e.source}
                </span>
              ) : (
                <span className="text-tertiary-foreground">—</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ActivityCard is the screen-tall recent-activity panel: a 90-day volume chart,
// a power-search filter, then a scrollable table of events.
function ActivityCard({ state }: { state: ActivityState }) {
  const [filters, setFilters] = useState<ActivityFilterToken[]>([]);
  const series = state.series ?? [];
  const events = useMemo(() => state.events ?? [], [state.events]);
  const total = series.reduce((sum, d) => sum + d.count, 0);

  const options = useMemo(() => activityOptions(events), [events]);
  const filtered = useMemo(
    () => events.filter((e) => filters.every((f) => matchActivity(f, e))),
    [events, filters],
  );

  return (
    <section className="flex h-[calc(100vh-12rem)] min-h-[32rem] flex-col overflow-hidden rounded-lg bg-primary">
      <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div className="flex items-center gap-1.5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
            Recent activity
          </h2>
          <InfoIcon text="Behavioural events for this tenant from the centralised activity_events store (Ogen CON-125). The chart shows daily event volume over the last 90 days; the table lists individual events, filterable by category, type, status, and source." />
        </div>
        {!state.loading && !state.error && (
          <span className="text-xs tabular-nums text-tertiary-foreground">
            {total} in 90 days
          </span>
        )}
      </div>

      {state.loading ? (
        <div className="flex items-center gap-2 px-6 py-6 text-xs text-tertiary-foreground">
          <Loader className="size-3.5 border-[1.5px]" />
          Loading activity…
        </div>
      ) : state.error ? (
        <p className="px-6 py-6 text-xs text-tertiary-foreground">
          Activity unavailable — {state.error}
        </p>
      ) : (
        <>
          <div className="border-b border-border p-6">
            <ActivityChart series={series} />
          </div>
          {/* Filter — placed between the chart and the table. */}
          <div className="border-b border-border px-6 py-3">
            <ActivityFilterBar
              tokens={filters}
              onTokensChange={setFilters}
              options={options}
            />
          </div>
          {/* Table fills the remaining height and scrolls. */}
          <div className="min-h-0 flex-1 overflow-auto">
            <ActivityTable events={filtered} />
          </div>
        </>
      )}
    </section>
  );
}

// ── main ────────────────────────────────────────────────────────────────────

// Section tabs on the detail page. "General information" holds the profile,
// users, Zernio accounts and token cost; "Recent activity" the activity card;
// "Emails" is a placeholder for now.
const DETAIL_TABS = ["General information", "Recent activity", "Emails"] as const;

// Stable, consistently-derived ids linking each tab to its panel (ARIA).
const tabId = (i: number) => `tenant-tab-${i}`;
const tabPanelId = (i: number) => `tenant-tabpanel-${i}`;

export function TenantDetail() {
  const [id, setId] = useState<string | null>(null);
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityState>({ loading: true });
  const [users, setUsers] = useState<UsersState>({ loading: true });
  const [zernio, setZernio] = useState<ZernioState>({ loading: true });
  const [tab, setTab] = useState(0);

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

    // Request a full page of events so the (filterable) table isn't near-empty;
    // the chart series is always the dense 90-day window regardless.
    fetch(`/api/tenants/${enc}/activity?limit=200`, { signal: controller.signal })
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

    fetch(`/api/tenants/${enc}/zernio`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`request failed (${r.status})`);
        return r.json();
      })
      .then(
        (j: {
          accounts: ZernioAccount[];
          available: boolean;
          error?: string;
        }) =>
          setZernio(
            j.available
              ? { loading: false, accounts: j.accounts }
              : { loading: false, error: j.error ?? "unavailable" },
          ),
      )
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setZernio({
          loading: false,
          error: e instanceof Error ? e.message : "Failed to load",
        });
      });

    return () => controller.abort();
  }, [id]);

  // Number keys 1..N jump straight to a tab (page-level, no focus needed).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
          target.closest?.('[role="combobox"],[role="textbox"]'))
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= DETAIL_TABS.length) {
        e.preventDefault();
        setTab(n - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
        {/* Section tabs */}
        <div
          role="tablist"
          className="flex gap-6 overflow-x-auto border-b border-border"
        >
          {DETAIL_TABS.map((label, i) => (
            <button
              key={label}
              id={tabId(i)}
              type="button"
              role="tab"
              aria-selected={i === tab}
              aria-controls={tabPanelId(i)}
              aria-keyshortcuts={String(i + 1)}
              onClick={() => setTab(i)}
              className={cn(
                "relative -mb-px flex shrink-0 items-center gap-2 border-b-2 py-3 text-sm whitespace-nowrap transition-colors outline-none cursor-pointer",
                i === tab
                  ? "border-foreground font-semibold text-foreground"
                  : "border-transparent font-medium text-tertiary-foreground hover:text-secondary-foreground",
              )}
            >
              {label}
              {/* Dim keyboard-shortcut hint (press 1 / 2 / 3). */}
              <span
                aria-hidden
                className="inline-flex size-4 items-center justify-center rounded-[3px] border border-border text-[10px] font-normal text-tertiary-foreground"
              >
                {i + 1}
              </span>
            </button>
          ))}
        </div>

        {tab === 0 && (
          <div
            role="tabpanel"
            id={tabPanelId(0)}
            aria-labelledby={tabId(0)}
            tabIndex={0}
            className="space-y-6"
          >
            <ProfileCard tenant={t} />

            {/* Users and Zernio side by side on large screens (equal height,
                matched to the taller card via the grid's default stretch); a
                single stacked column on small ones. */}
            <div className="grid gap-6 lg:grid-cols-2">
              <UsersSection state={users} total={t.users} />
              <ZernioSection state={zernio} total={t.zernioProfiles} />
            </div>

            <DailyTokenCostChart tenantId={t.id} />
          </div>
        )}

        {tab === 1 && (
          <div
            role="tabpanel"
            id={tabPanelId(1)}
            aria-labelledby={tabId(1)}
            tabIndex={0}
          >
            <ActivityCard state={activity} />
          </div>
        )}

        {tab === 2 && (
          <div
            role="tabpanel"
            id={tabPanelId(2)}
            aria-labelledby={tabId(2)}
            tabIndex={0}
            className="rounded-lg bg-primary p-6"
          >
            <h2 className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
              Emails
            </h2>
            <p className="mt-3 text-sm text-tertiary-foreground">
              No emails yet.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
