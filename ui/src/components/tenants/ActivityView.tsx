"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CaretUpDownIcon,
  CheckIcon,
  MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { ActivityCard } from "@/components/tenants/ActivityCard";
import {
  type Tenant,
  type ActivityEvent,
  type ActivityDay,
  type ActivityState,
} from "@/components/tenants/shared";

// Header tooltip copy for each scope. The per-tenant wording matches the detail
// page; the all-tenants wording explains the extra Tenant column and selector.
const ALL_INFO =
  "Behavioural events across all tenants from the centralised tenant_activity_events store (Ogen CON-125). The chart shows daily event volume over the last 90 days; the table lists individual events with their tenant. Pick a tenant to scope the view, or click a bar or legend entry to focus on a category (and day); it lazy-loads more as you scroll.";
const ONE_INFO =
  "Behavioural events for this tenant from the centralised tenant_activity_events store (Ogen CON-125). The chart shows daily event volume over the last 90 days; the table lists individual events. Click a bar or legend entry to focus the table on that category (and day); it lazy-loads more as you scroll.";

// ActivityView is the global Activity page: the reusable ActivityCard driven by
// the cross-tenant /api/activity endpoint, with a tenant selector that scopes it
// to a single tenant (?tenant=<id>) or back to all tenants.
export function ActivityView() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  // null = all tenants; otherwise the selected tenant id.
  const [selected, setSelected] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityState>({ loading: true });

  // Tenant list for the selector and the table's id → name lookup. Best-effort:
  // if it fails the feed still works, the Tenant column just shows raw ids.
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

  const nameOf = useMemo(() => {
    const byId = new Map(tenants.map((t) => [t.id, t.name]));
    return (id: string) => byId.get(id) ?? id;
  }, [tenants]);

  // (Re)load the first page + dense 90-day series whenever the scope changes.
  // ActivityCard is remounted via `key` on scope change, so it re-seeds cleanly
  // from this fresh state (loading is set synchronously in onSelect so the new
  // instance never briefly shows the previous scope's rows).
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ limit: "50" });
    if (selected) params.set("tenant", selected);
    fetch(`/api/activity?${params.toString()}`, { signal: controller.signal })
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
  }, [selected]);

  // Switch scope: reset to loading synchronously so the remounted (keyed) card
  // never seeds from the outgoing scope's already-loaded rows.
  const onSelect = (id: string | null) => {
    setSelected(id);
    setActivity({ loading: true });
  };

  return (
    <main className="flex-1 overflow-auto flex flex-col">
      <header className="h-20 border-b border-border flex items-center justify-between gap-4 px-6 shrink-0">
        <h1 className="text-2xl font-display font-medium">Activity</h1>
        <TenantSelect tenants={tenants} value={selected} onChange={onSelect} />
      </header>
      <div className="p-6">
        <ActivityCard
          key={selected ?? "__all__"}
          state={activity}
          endpoint="/api/activity"
          tenantFilter={selected ?? undefined}
          showTenant={!selected}
          tenantName={nameOf}
          infoText={selected ? ONE_INFO : ALL_INFO}
        />
      </div>
    </main>
  );
}

// TenantSelect is a searchable dropdown: "All tenants" plus every tenant by name.
function TenantSelect({
  tenants,
  value,
  onChange,
}: {
  tenants: Tenant[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const label = value
    ? (tenants.find((t) => t.id === value)?.name ?? value)
    : "All tenants";

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tenants;
    return tenants.filter(
      (t) =>
        t.name.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q),
    );
  }, [tenants, query]);

  const choose = (id: string | null) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="min-w-[15rem] justify-between gap-2"
          aria-label="Filter by tenant"
        >
          <span className="truncate">{label}</span>
          <CaretUpDownIcon className="size-4 shrink-0 text-tertiary-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[18rem] p-0">
        <div className="flex items-center gap-2 border-b border-border px-3">
          <MagnifyingGlassIcon className="size-4 shrink-0 text-tertiary-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tenants…"
            className="w-full bg-transparent py-2.5 text-sm outline-none placeholder:text-tertiary-foreground"
            aria-label="Search tenants"
          />
        </div>
        <ul className="max-h-72 overflow-y-auto p-1">
          <li>
            <TenantOption
              label="All tenants"
              selected={value === null}
              onClick={() => choose(null)}
              emphasise
            />
          </li>
          {filtered.map((t) => (
            <li key={t.id}>
              <TenantOption
                label={t.name || t.slug || t.id}
                selected={value === t.id}
                onClick={() => choose(t.id)}
              />
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="px-2.5 py-3 text-sm text-tertiary-foreground">
              No tenants found
            </li>
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function TenantOption({
  label,
  selected,
  onClick,
  emphasise,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  emphasise?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-secondary",
        selected && "bg-secondary/60",
      )}
    >
      <CheckIcon
        className={cn("size-4 shrink-0", selected ? "opacity-100" : "opacity-0")}
      />
      <span className={cn("min-w-0 flex-1 truncate", emphasise && "font-medium")}>
        {label}
      </span>
    </button>
  );
}
