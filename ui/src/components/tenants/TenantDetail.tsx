"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  ArrowLeftIcon,
  BracketsCurlyIcon,
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
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
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

// Per-category colours: fixed, semantic hues for the known CON-125 categories,
// with a stable per-id hash into a fallback palette for anything else, so a
// given category always keeps the same colour.
const CATEGORY_COLORS: Record<string, string> = {
  post: "bg-blue-500",
  authentication: "bg-emerald-500",
  ai_flow: "bg-violet-500",
  campaign: "bg-amber-500",
  publish: "bg-rose-500",
};
const CATEGORY_FALLBACK = [
  "bg-cyan-500",
  "bg-fuchsia-500",
  "bg-orange-500",
  "bg-lime-500",
  "bg-indigo-500",
  "bg-pink-500",
] as const;

// djb2 hash → non-negative int, for a stable fallback colour per category id.
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++)
    h = (Math.imul(h, 33) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}
function categoryColor(category: string): string {
  return (
    CATEGORY_COLORS[category] ??
    CATEGORY_FALLBACK[hashString(category) % CATEGORY_FALLBACK.length]
  );
}

// prettyCategory turns "ai_flow" → "AI flow": words joined by spaces, first
// title-cased, and "ai" upper-cased.
function prettyCategory(category: string): string {
  if (!category) return "Unknown";
  return category
    .split(/[_-]/)
    .filter(Boolean)
    .map((w, i) =>
      w === "ai" ? "AI" : i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w,
    )
    .join(" ");
}

// niceCountScale picks a rounded integer y-axis maximum and evenly-spaced integer
// ticks (~4 intervals) for the event-count axis.
function niceCountScale(max: number): { max: number; ticks: number[] } {
  if (max <= 0) return { max: 1, ticks: [0, 1] };
  const rawStep = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = Math.max(
    1,
    (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag,
  );
  const niceMax = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= niceMax + step / 1000; v += step) ticks.push(Math.round(v));
  return { max: niceMax, ticks };
}

// ActivityChart is a 90-day daily event-volume chart with bars stacked and
// coloured by category, a y-axis, per-day tooltips, and category hover-linking —
// mirroring the DailyTokenCost chart.
function ActivityChart({
  series,
  categories,
}: {
  series: ActivityDay[];
  categories: string[];
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const colorOf = new Map(categories.map((c) => [c, categoryColor(c)]));

  const maxDay = Math.max(0, ...series.map((d) => d.total));
  const { max: axisMax, ticks } = niceCountScale(maxDay);

  // Label roughly seven x-axis ticks, evenly spaced (mirrors DailyTokenCostChart).
  const labelStride = Math.max(1, Math.ceil(series.length / 7));

  return (
    <div>
      {/* Plot: y-axis label gutter + gridded bars */}
      <div className="flex gap-2">
        <div
          className="relative w-8 shrink-0"
          style={{ height: ACTIVITY_CHART_H }}
          aria-hidden
        >
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute right-0 -translate-y-1/2 text-[11px] text-tertiary-foreground"
              style={{ bottom: `${(t / axisMax) * 100}%` }}
            >
              {t}
            </span>
          ))}
        </div>

        <div className="relative flex-1" style={{ height: ACTIVITY_CHART_H }}>
          {/* Gridlines */}
          {ticks.map((t) => (
            <div
              key={t}
              className="absolute inset-x-0 border-t border-border/60"
              style={{ bottom: `${(t / axisMax) * 100}%` }}
            />
          ))}

          {/* Stacked bars — one column per day */}
          <div className="absolute inset-0 flex items-end gap-[2px]">
            {series.map((d) => {
              if (d.total <= 0) {
                return (
                  <div
                    key={d.date}
                    className="flex-1"
                    title={`${fmtDay(d.date)} · no activity`}
                    aria-label={`${fmtDay(d.date)} · no activity`}
                  />
                );
              }
              // Segments ordered by legend rank (largest category at the bottom).
              const segs = categories
                .map((c) => ({ category: c, count: d.counts[c] ?? 0 }))
                .filter((s) => s.count > 0);
              return (
                <Tooltip key={d.date}>
                  <TooltipTrigger asChild>
                    <div
                      tabIndex={0}
                      aria-label={`${fmtDay(d.date)} · ${d.total} ${d.total === 1 ? "event" : "events"}`}
                      className="flex h-full flex-1 cursor-default flex-col-reverse justify-start gap-px"
                    >
                      {segs.map((s) => (
                        <div
                          key={s.category}
                          onMouseEnter={() => setHovered(s.category)}
                          onMouseLeave={() => setHovered(null)}
                          className={cn(
                            "w-full rounded-sm transition-opacity",
                            colorOf.get(s.category),
                            hovered && hovered !== s.category
                              ? "opacity-20"
                              : "opacity-100",
                          )}
                          style={{
                            height: `${Math.max((s.count / axisMax) * ACTIVITY_CHART_H, 2)}px`,
                          }}
                        />
                      ))}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent className="min-w-44 border-foreground bg-foreground text-left text-background">
                    <p className="font-medium">{fmtDay(d.date)}</p>
                    <p className="text-background/70">
                      {d.total} {d.total === 1 ? "event" : "events"}
                    </p>
                    <ul className="mt-1.5 space-y-1">
                      {segs.map((s) => (
                        <li
                          key={s.category}
                          onMouseEnter={() => setHovered(s.category)}
                          onMouseLeave={() => setHovered(null)}
                          className={cn(
                            "flex items-center justify-between gap-4 transition-opacity",
                            hovered && hovered !== s.category && "opacity-40",
                          )}
                        >
                          <span className="flex items-center gap-1.5">
                            <span
                              className={cn(
                                "size-2 rounded-full",
                                colorOf.get(s.category),
                              )}
                            />
                            {prettyCategory(s.category)}
                          </span>
                          <span className="font-medium">{s.count}</span>
                        </li>
                      ))}
                    </ul>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        </div>
      </div>

      {/* X-axis date labels, aligned under their bars (offset past the y gutter). */}
      <div className="ml-10 mt-2 flex gap-[2px]">
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

      {/* Legend */}
      {categories.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2">
          {categories.map((c) => (
            <span
              key={c}
              onMouseEnter={() => setHovered(c)}
              onMouseLeave={() => setHovered(null)}
              className={cn(
                "flex cursor-default items-center gap-1.5 text-xs text-secondary-foreground transition-opacity",
                hovered && hovered !== c && "opacity-40",
              )}
            >
              <span className={cn("size-2.5 rounded-sm", categoryColor(c))} />
              {prettyCategory(c)}
            </span>
          ))}
        </div>
      )}
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

// Fixed header height (h-10 = 40px) so the top scroll-fade can align exactly
// beneath the sticky header; z-20 keeps the header above the fade strips.
const ACTIVITY_TH =
  "sticky top-0 z-20 h-10 border-b border-border bg-primary px-3 align-middle font-semibold first:pl-6 last:pr-6";
const ACTIVITY_TD = "px-3 py-2.5 first:pl-6 last:pr-6 align-middle";

// Full activity_events row (every field except tenant_id), loaded on demand.
interface ActivityEventDetail {
  id: string;
  userId: string;
  category: string;
  type: string;
  entityType: string;
  entityId: string;
  status: string;
  source: string;
  tags: string[];
  payload: unknown;
  at: string;
}

// ScalarValue is a single boxed value cell in the details popover.
function ScalarValue({ children }: { children: ReactNode }) {
  return (
    <span className="block break-words rounded-md bg-secondary/40 px-2 py-1 font-mono text-xs text-foreground">
      {children}
    </span>
  );
}

// detailRows maps a loaded event to labelled cells: scalars as boxed values,
// tags as a chip list, payload as pretty-printed JSON.
function detailRows(d: ActivityEventDetail): { label: string; node: ReactNode }[] {
  const scalar = (v: string) => <ScalarValue>{v || "—"}</ScalarValue>;
  return [
    { label: "Time", node: scalar(formatDateTime(d.at)) },
    { label: "ID", node: scalar(d.id) },
    { label: "User", node: scalar(d.userId) },
    { label: "Category", node: scalar(d.category) },
    { label: "Type", node: scalar(d.type) },
    { label: "Entity type", node: scalar(d.entityType) },
    { label: "Entity ID", node: scalar(d.entityId) },
    { label: "Status", node: scalar(d.status) },
    { label: "Source", node: scalar(d.source) },
    {
      label: "Tags",
      node:
        d.tags && d.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {d.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        ) : (
          <ScalarValue>—</ScalarValue>
        ),
    },
    {
      label: "Payload",
      node: (
        <pre className="max-h-48 overflow-auto rounded-md bg-secondary/40 p-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-foreground">
          {JSON.stringify(d.payload ?? {}, null, 2)}
        </pre>
      ),
    },
  ];
}

// EventDetailPopover is the per-row "{ }" ghost button; opening it loads the
// full event asynchronously and renders every field.
function EventDetailPopover({
  tenantId,
  event,
}: {
  tenantId: string;
  event: ActivityEvent;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ActivityEventDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch on first open (result cached afterwards; a prior error retries).
  useEffect(() => {
    if (!open || detail) return;
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    fetch(
      `/api/tenants/${encodeURIComponent(tenantId)}/activity/${encodeURIComponent(event.id)}`,
      { signal: controller.signal },
    )
      .then((r) => {
        if (!r.ok) throw new Error(`request failed (${r.status})`);
        return r.json();
      })
      .then(
        (j: {
          available: boolean;
          found?: boolean;
          event?: ActivityEventDetail;
          error?: string;
        }) => {
          if (controller.signal.aborted) return;
          if (j.available && j.event) {
            setDetail(j.event);
            setError(null);
          } else {
            setError(
              j.error ??
                (j.found === false ? "Event not found" : "unavailable"),
            );
          }
        },
      )
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Failed to load");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, detail, tenantId, event.id]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="smIcon"
          aria-label="Event details"
          className="text-tertiary-foreground hover:text-foreground data-[state=open]:text-foreground"
        >
          <BracketsCurlyIcon className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96">
        <div className="mb-3">
          <p className="truncate font-medium text-foreground">
            {event.type || "Event"}
          </p>
          <p className="text-xs text-tertiary-foreground">
            Activity event details
          </p>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 py-2 text-xs text-tertiary-foreground">
            <Loader className="size-3.5 border-[1.5px]" />
            Loading…
          </div>
        ) : error ? (
          <p className="py-2 text-xs text-tertiary-foreground">
            Failed to load — {error}
          </p>
        ) : detail ? (
          <dl className="space-y-2">
            {detailRows(detail).map((r) => (
              <div key={r.label} className="flex items-start gap-3">
                <dt className="w-24 shrink-0 py-1 text-xs text-tertiary-foreground">
                  {r.label}
                </dt>
                <dd className="min-w-0 flex-1">{r.node}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

// ActivityTable lists activity events with the CON-125 fields (source shown as a
// tag, plus a per-row details popover). It scrolls within its screen-tall
// parent; the header stays pinned.
function ActivityTable({
  events,
  tenantId,
}: {
  events: ActivityEvent[];
  tenantId: string;
}) {
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
          <th className={ACTIVITY_TH}>Time</th>
          <th className={ACTIVITY_TH}>Category</th>
          <th className={ACTIVITY_TH}>Type</th>
          <th className={ACTIVITY_TH}>Status</th>
          <th className={ACTIVITY_TH}>Source</th>
          <th className={ACTIVITY_TH}>
            <span className="sr-only">Details</span>
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {events.map((e) => (
          <tr key={e.id} className="transition-colors hover:bg-secondary/40">
            <td
              className={cn(
                ACTIVITY_TD,
                "whitespace-nowrap tabular-nums text-tertiary-foreground",
              )}
            >
              {formatDateTime(e.at)}
            </td>
            <td className={cn(ACTIVITY_TD, "text-secondary-foreground")}>
              {e.category || "—"}
            </td>
            <td className={cn(ACTIVITY_TD, "font-medium text-foreground")}>
              {e.type || "—"}
            </td>
            <td className={cn(ACTIVITY_TD, "text-secondary-foreground")}>
              {e.status || "—"}
            </td>
            <td className={ACTIVITY_TD}>
              {e.source ? (
                <span className="inline-flex items-center rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">
                  {e.source}
                </span>
              ) : (
                <span className="text-tertiary-foreground">—</span>
              )}
            </td>
            <td className={cn(ACTIVITY_TD, "w-10 text-right")}>
              <EventDetailPopover tenantId={tenantId} event={e} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ActivityCard is the screen-tall recent-activity panel: a 90-day volume chart,
// a power-search filter, then a scrollable table of events.
function ActivityCard({
  state,
  tenantId,
}: {
  state: ActivityState;
  tenantId: string;
}) {
  const [filters, setFilters] = useState<ActivityFilterToken[]>([]);
  const series = state.series ?? [];
  const categories = state.categories ?? [];
  const events = useMemo(() => state.events ?? [], [state.events]);
  const total = series.reduce((sum, d) => sum + d.total, 0);

  const options = useMemo(() => activityOptions(events), [events]);
  const filtered = useMemo(
    () => events.filter((e) => filters.every((f) => matchActivity(f, e))),
    [events, filters],
  );

  // Scroll-fade strips: fade content under the sticky header (top) and above the
  // bottom edge, shown only while there is more to scroll to in that direction.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const syncFades = (el: HTMLDivElement) => {
    setAtTop(el.scrollTop <= 0);
    setAtBottom(Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight);
  };
  // Recompute when the row set changes (the scrollable height changes with it).
  useEffect(() => {
    if (scrollRef.current) syncFades(scrollRef.current);
  }, [filtered]);

  return (
    <section className="flex h-[calc(100vh-13rem)] min-h-[32rem] flex-col overflow-hidden rounded-lg bg-primary">
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
            <ActivityChart series={series} categories={categories} />
          </div>
          {/* Filter — placed between the chart and the table. */}
          <div className="border-b border-border px-6 py-3">
            <ActivityFilterBar
              tokens={filters}
              onTokensChange={setFilters}
              options={options}
            />
          </div>
          {/* Table fills the remaining height and scrolls, with fade strips
              overlapping the top (under the header) and bottom edges. */}
          <div className="relative min-h-0 flex-1">
            <div
              ref={scrollRef}
              onScroll={(e) => syncFades(e.currentTarget)}
              className="h-full overflow-auto"
            >
              <ActivityTable events={filtered} tenantId={tenantId} />
            </div>
            {/* Top strip — sits just below the 40px sticky header. */}
            <div
              aria-hidden
              className={cn(
                "pointer-events-none absolute inset-x-0 top-10 z-10 h-10 bg-linear-to-b from-primary to-transparent transition-opacity duration-200",
                atTop ? "opacity-0" : "opacity-100",
              )}
            />
            {/* Bottom strip — the same fade, flipped. */}
            <div
              aria-hidden
              className={cn(
                "pointer-events-none absolute inset-x-0 bottom-0 z-10 h-10 bg-linear-to-t from-primary to-transparent transition-opacity duration-200",
                atBottom ? "opacity-0" : "opacity-100",
              )}
            />
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
          categories?: string[];
          available: boolean;
          error?: string;
        }) =>
          setActivity(
            j.available
              ? {
                  loading: false,
                  events: j.activity,
                  series: j.series,
                  categories: j.categories,
                }
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
            <ActivityCard state={activity} tenantId={t.id} />
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
