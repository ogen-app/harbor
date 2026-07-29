"use client";

import { useEffect, useMemo, useState } from "react";
import { ActivityCard } from "@/components/tenants/ActivityCard";
import { type ActivityFilterToken } from "@/components/tenants/ActivityFilterBar";
import {
  type Tenant,
  type ActivityEvent,
  type ActivityDay,
  type ActivityState,
} from "@/components/tenants/shared";

// Header tooltip copy for each scope. The per-tenant wording matches the detail
// page; the all-tenants wording points at the Tenant filter.
const ALL_INFO =
  "Behavioural events across all tenants from the centralised tenant_activity_events store (Ogen CON-125). The chart shows daily event volume over the last 90 days; the table lists individual events with their tenant. Add a Tenant filter to scope to one tenant, or click a bar or legend entry to focus on a category (and day); it lazy-loads more as you scroll.";
const ONE_INFO =
  "Behavioural events for this tenant from the centralised tenant_activity_events store (Ogen CON-125). The chart shows daily event volume over the last 90 days; the table lists individual events. Click a bar or legend entry to focus the table on that category (and day); it lazy-loads more as you scroll.";

// ActivityView is the global Activity page: the reusable ActivityCard driven by
// the cross-tenant /api/activity endpoint. Tenant scoping is folded into the
// card's smart filter — a "Tenant is X" token re-scopes the feed to that tenant
// (?tenant=<id>). The filter tokens live here so they are owned alongside the
// tenant list; the card refreshes itself in place when the tenant token changes
// (no remount), so this only needs the one initial seed fetch.
export function ActivityView() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [filters, setFilters] = useState<ActivityFilterToken[]>([]);
  const [activity, setActivity] = useState<ActivityState>({ loading: true });

  // The tenant token, if any, is the current scope (null = all tenants) — used
  // only to pick the header tooltip; the card owns the actual scoped fetching.
  const scope = filters.find((f) => f.field === "tenant")?.value ?? null;

  // Tenant list for the filter's "Tenant" options and the table's id → name
  // lookup. Best-effort: if it fails the feed still works (no Tenant filter, raw
  // ids in the column).
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/tenants", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { tenants?: Tenant[]; available: boolean }) => {
        if (j.available && j.tenants) setTenants(j.tenants);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const tenantOptions = useMemo(
    () => tenants.map((t) => ({ id: t.id, name: t.name || t.slug || t.id })),
    [tenants],
  );
  const nameOf = useMemo(() => {
    const byId = new Map(tenants.map((t) => [t.id, t.name]));
    return (id: string) => byId.get(id) ?? id;
  }, [tenants]);

  // Initial (all-tenants) seed: the first page + dense 90-day series. Subsequent
  // tenant scoping is handled inside the card, so this runs once.
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/activity?limit=50", { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`request failed (${r.status})`);
        return r.json();
      })
      .then(
        (j: {
          activity: ActivityEvent[];
          series?: ActivityDay[];
          categories?: string[];
          hasMore?: boolean;
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
                  hasMore: j.hasMore,
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
    return () => controller.abort();
  }, []);

  return (
    <main className="flex-1 overflow-auto flex flex-col">
      <header className="h-20 border-b border-border flex items-center px-6 shrink-0">
        <h1 className="text-2xl font-display font-medium">Activity</h1>
      </header>
      <div className="p-6">
        <ActivityCard
          state={activity}
          endpoint="/api/activity"
          tenantName={nameOf}
          tenantOptions={tenantOptions}
          filters={filters}
          onFiltersChange={setFilters}
          infoText={scope ? ONE_INFO : ALL_INFO}
        />
      </div>
    </main>
  );
}
