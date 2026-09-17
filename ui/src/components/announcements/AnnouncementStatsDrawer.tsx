"use client";

import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ChartLineData01Icon } from "@hugeicons/core-free-icons";
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { Loader } from "@/components/ui/loader";
import { cn } from "@/lib/utils";
import type { CatalogEntry } from "@/components/tiers-groups/types";
import { StatusBadge, audienceSummary, formatWindow } from "./format";
import type { AnnouncementWithStats } from "./types";

interface AnnouncementStatsDrawerProps {
  announcementId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tiers: CatalogEntry[];
  groups: CatalogEntry[];
}

// AnnouncementStatsDrawer is the slide-over detail/stats view (CON-300 chose a
// drawer over a dedicated route, matching the Platforms modal pattern). The body
// lives in StatsBody, which Radix mounts fresh each open (DrawerContent unmounts
// when closed) — so it fetches once per open without resetting state in an effect.
export function AnnouncementStatsDrawer({
  announcementId,
  open,
  onOpenChange,
  tiers,
  groups,
}: AnnouncementStatsDrawerProps) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-w-[min(42rem,calc(100vw-2.5rem))] gap-0 p-0">
        {announcementId && (
          <StatsBody
            key={announcementId}
            announcementId={announcementId}
            tiers={tiers}
            groups={groups}
          />
        )}
      </DrawerContent>
    </Drawer>
  );
}

// StatsBody calls GetAnnouncement on mount for the freshest full stat set —
// unique users/tenants clicked & dismissed, the eligible-audience denominator,
// and a CTA click-through readout — plus the announcement's content and targeting.
function StatsBody({
  announcementId,
  tiers,
  groups,
}: {
  announcementId: string;
  tiers: CatalogEntry[];
  groups: CatalogEntry[];
}) {
  const [data, setData] = useState<AnnouncementWithStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/announcements/${encodeURIComponent(announcementId)}`, {
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok) {
          const detail = (await r.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(detail?.error || `Request failed (${r.status})`);
        }
        return r.json() as Promise<AnnouncementWithStats>;
      })
      .then(setData)
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Failed to load stats.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [announcementId]);

  const a = data?.announcement;
  const s = data?.stats;
  const clickRate =
    s && s.eligibleUsers > 0
      ? (s.uniqueUsersClicked / s.eligibleUsers) * 100
      : null;

  return (
    <>
      <div className="shrink-0 px-6 pt-6 pr-12">
        <DrawerTitle className="flex items-center gap-2">
          <HugeiconsIcon
            icon={ChartLineData01Icon}
            className="size-5 text-tertiary-foreground"
          />
          {a?.title?.trim() || "Announcement"}
        </DrawerTitle>
        <DrawerDescription className="mt-1">
          Engagement and delivery for this announcement.
        </DrawerDescription>
      </div>

      <div className="mt-4 shrink-0 border-b border-border" />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-tertiary-foreground">
            <Loader className="size-4 border-[1.5px]" />
            Loading…
          </div>
        ) : error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : a && s ? (
          <div className="grid gap-6">
            {/* Meta line */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <StatusBadge status={a.status} />
              <span className="text-secondary-foreground">
                <span className="text-tertiary-foreground">Audience: </span>
                {audienceSummary(a, tiers, groups)}
              </span>
              <span className="text-secondary-foreground">
                <span className="text-tertiary-foreground">Window: </span>
                {formatWindow(a.startsAt, a.endsAt)}
              </span>
            </div>

            {/* Stats grid */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <StatCard
                label="Users clicked"
                value={s.uniqueUsersClicked}
                sub={
                  clickRate !== null
                    ? `${clickRate.toFixed(1)}% of eligible`
                    : undefined
                }
              />
              <StatCard
                label="Tenants clicked"
                value={s.uniqueTenantsClicked}
              />
              <StatCard label="Eligible users" value={s.eligibleUsers} muted />
              <StatCard
                label="Users dismissed"
                value={s.uniqueUsersDismissed}
              />
              <StatCard
                label="Tenants dismissed"
                value={s.uniqueTenantsDismissed}
              />
              <StatCard
                label="Eligible tenants"
                value={s.eligibleTenants}
                muted
              />
            </div>
            <p className="-mt-3 text-xs text-tertiary-foreground">
              Eligible counts are the audience the targeting selects among active
              tenants — the denominator for click/dismiss rates, since
              impressions aren’t tracked.
            </p>

            {/* Content preview */}
            <section className="grid gap-3 rounded-lg border border-border bg-secondary/20 p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
                Content
              </h3>
              {a.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={a.imageUrl}
                  alt={a.imageAlt}
                  className="max-h-48 w-full rounded-md object-cover"
                />
              )}
              <p className="text-sm font-medium text-foreground">{a.title}</p>
              <p className="text-sm whitespace-pre-wrap text-secondary-foreground">
                {a.body}
              </p>
              {a.ctaLabel && (
                <div className="text-sm">
                  <span className="text-tertiary-foreground">CTA: </span>
                  <span className="font-medium text-foreground">
                    {a.ctaLabel}
                  </span>{" "}
                  <a
                    href={a.ctaUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-xs text-secondary-foreground underline underline-offset-2 hover:text-foreground"
                  >
                    {a.ctaUrl}
                  </a>
                </div>
              )}
            </section>
          </div>
        ) : null}
      </div>
    </>
  );
}

// StatCard is one metric tile: a large number over a small label, with an
// optional sub-line (e.g. a rate). `muted` styles the denominator tiles.
function StatCard({
  label,
  value,
  sub,
  muted,
}: {
  label: string;
  value: number;
  sub?: string;
  muted?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border px-4 py-3",
        muted ? "border-border bg-secondary/20" : "border-border bg-primary",
      )}
    >
      <div className="text-2xl font-medium tabular-nums text-foreground">
        {value.toLocaleString()}
      </div>
      <div className="mt-0.5 text-xs text-tertiary-foreground">{label}</div>
      {sub && (
        <div className="mt-1 text-xs font-medium text-emerald-700">{sub}</div>
      )}
    </div>
  );
}
