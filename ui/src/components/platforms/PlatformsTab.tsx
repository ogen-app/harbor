"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader } from "@/components/ui/loader";
import { cn } from "@/lib/utils";
import { PlatformIcon } from "./PlatformIcon";
import type { Platform, PlatformsListResponse } from "./types";

// Shared grid template so the header and every row align — columns:
// name · slug · post types · accounts · scheduled · status. Mirrors the
// /secrets + /tenants table layout (fixed-ish tracks so every row's columns
// line up regardless of content width).
const GRID =
  "grid grid-cols-[minmax(200px,2fr)_minmax(120px,1fr)_minmax(90px,0.7fr)_minmax(90px,0.7fr)_minmax(90px,0.7fr)_minmax(110px,0.8fr)] items-center gap-4";

// Display platforms in operator-managed order (sort_order), then name — the
// same order the forthcoming drag-to-reorder will persist.
function bySortOrder(a: Platform, b: Platform): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.name.localeCompare(b.name);
}

function postTypeCount(p: Platform): number {
  return Object.keys(p.postTypes ?? {}).length;
}

// PlatformsTab is the social-platform catalog manager, styled to match the
// /secrets + /tenants "All X" table: a rounded card with a title/blurb/count
// header bar and a grid body with divide-y rows. All state is Ogen's — this only
// calls Harbor's /api/platforms, which proxies to Ogen's platform-admin gRPC
// surface (fetched with include_disabled=true so disabled platforms show too).
// This iteration is read-only; add/edit/enable/delete and the global-limits
// panel land in later iterations.
export function PlatformsTab() {
  const [data, setData] = useState<PlatformsListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // reload re-fetches the list. setState lives in .then/.catch callbacks (async),
  // matching the codebase's fetch-in-effect pattern.
  const reload = useCallback((signal?: AbortSignal) => {
    return fetch("/api/platforms", { signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        return r.json() as Promise<PlatformsListResponse>;
      })
      .then((json) => {
        setData(json);
        setLoadError(null);
      })
      .catch((e: unknown) => {
        if (signal?.aborted) return;
        setLoadError(
          e instanceof Error ? e.message : "Failed to load platforms.",
        );
      })
      .finally(() => {
        if (!signal?.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  const available = data?.available ?? false;
  const platforms = [...(data?.platforms ?? [])].sort(bySortOrder);
  const enabledCount = platforms.filter((p) => p.enabled).length;

  return (
    <div className="rounded-xl bg-primary">
      {/* Header bar — title + blurb + count, mirroring the secrets/tenants table. */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">All platforms</h2>
          <p className="mt-1 max-w-xl text-xs text-tertiary-foreground">
            The social platforms Ogen can publish to, with their per-platform
            media and text limits. Disabled platforms are shown muted — existing
            scheduled posts still run, but new connects are blocked.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          {!loading && available && (
            <span className="flex items-center gap-2 text-xs text-tertiary-foreground">
              {refreshing && <Loader className="size-3.5 border-[1.5px]" />}
              {enabledCount} of {platforms.length} enabled
            </span>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-b-xl">
        {loading ? (
          <SkeletonRows />
        ) : loadError ? (
          <p className="p-6 text-sm text-destructive">{loadError}</p>
        ) : !available ? (
          <p className="p-6 text-sm text-tertiary-foreground">
            The platform-admin service is unavailable. Check that Ogen is running
            and that Harbor’s <code className="font-mono">OGEN_GRPC_ADDR</code> /{" "}
            <code className="font-mono">OGEN_GRPC_TOKEN</code> are configured.
          </p>
        ) : platforms.length === 0 ? (
          <p className="p-6 text-sm text-tertiary-foreground">
            No platforms in the catalog yet.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {/* header */}
            <div className={`${GRID} px-6 py-2.5`}>
              <HeaderCell label="Platform" />
              <HeaderCell label="Zernio slug" />
              <HeaderCell label="Post types" />
              <HeaderCell label="Accounts" />
              <HeaderCell label="Scheduled" />
              <HeaderCell label="Status" />
            </div>

            {/* rows */}
            {platforms.map((p) => (
              <PlatformRow key={p.id || p.zernioId} platform={p} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function HeaderCell({ label }: { label: string }) {
  return (
    <span className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
      {label}
    </span>
  );
}

function PlatformRow({ platform }: { platform: Platform }) {
  const types = postTypeCount(platform);
  const typeLabels = Object.values(platform.postTypes ?? {}).join(", ");
  return (
    <div
      className={cn(
        `${GRID} px-6 py-3.5 text-sm transition-colors hover:bg-secondary/40`,
        // Disabled platforms render muted (the whole row dims) so the enabled
        // catalog reads at a glance.
        !platform.enabled && "opacity-55",
      )}
    >
      {/* Platform name + brand icon */}
      <span className="flex min-w-0 items-center gap-2.5">
        <PlatformIcon
          zernioId={platform.zernioId}
          className="text-secondary-foreground"
        />
        <span className="truncate font-medium text-foreground">
          {platform.name}
        </span>
      </span>

      {/* Zernio slug */}
      <span className="truncate font-mono text-xs text-secondary-foreground">
        {platform.zernioId || <span className="text-tertiary-foreground">—</span>}
      </span>

      {/* Post-type count (labels on hover) */}
      <span
        className="text-secondary-foreground tabular-nums"
        title={typeLabels || undefined}
      >
        {types}
      </span>

      {/* Connected accounts */}
      <span className="text-secondary-foreground tabular-nums">
        {platform.usage.connectedAccounts}
      </span>

      {/* Scheduled posts */}
      <span className="text-secondary-foreground tabular-nums">
        {platform.usage.scheduledPosts}
      </span>

      {/* Enabled status */}
      <EnabledLabel enabled={platform.enabled} />
    </div>
  );
}

// EnabledLabel is the dot + state, mirroring the tenant StatusLabel: emerald for
// enabled, neutral for disabled.
function EnabledLabel({ enabled }: { enabled: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span
        className={cn(
          "size-2 rounded-full",
          enabled ? "bg-emerald-500" : "bg-neutral-400",
        )}
      />
      <span className="text-secondary-foreground">
        {enabled ? "Enabled" : "Disabled"}
      </span>
    </span>
  );
}

function SkeletonRows() {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className={`${GRID} px-6 py-3.5`}>
          <div className="flex items-center gap-2.5">
            <div className="size-5 animate-pulse rounded bg-secondary" />
            <div className="h-3 w-28 animate-pulse rounded bg-secondary" />
          </div>
          <div className="h-3 w-20 animate-pulse rounded bg-secondary" />
          <div className="h-3 w-8 animate-pulse rounded bg-secondary" />
          <div className="h-3 w-8 animate-pulse rounded bg-secondary" />
          <div className="h-3 w-8 animate-pulse rounded bg-secondary" />
          <div className="h-3 w-16 animate-pulse rounded bg-secondary" />
        </div>
      ))}
    </div>
  );
}
