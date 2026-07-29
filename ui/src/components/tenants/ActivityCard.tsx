"use client";

// The reusable "Recent activity" panel: a 90-day category-stacked volume chart,
// a power-search filter, then a lazily-loaded, scrollable table of events. Driven
// entirely by an `endpoint` so it serves both the per-tenant detail page
// (/api/tenants/:id/activity) and the global Activity page (/api/activity, with
// an optional ?tenant= scope). Extracted from TenantDetail so both share one
// implementation.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { BracketsCurlyIcon, XIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { InfoIcon } from "@/components/dashboard/primitives";
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
  type ActivityEvent,
  type ActivityDay,
  type ActivityState,
  formatDateTime,
} from "@/components/tenants/shared";
import {
  ActivityFilterBar,
  type ActivityFilterToken,
  type ActivityFieldKey,
  type ActivityOptions,
} from "@/components/tenants/ActivityFilterBar";

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

// ActivitySelection is the chart-driven filter applied to the events table: a
// category (from a legend click) optionally narrowed to one UTC day (from a
// stacked sub-bar click). null means "latest events, unfiltered".
type ActivitySelection = { category: string; date?: string };

// ActivityChart is a 90-day daily event-volume chart with bars stacked and
// coloured by category, a y-axis, per-day tooltips, and category hover-linking —
// mirroring the DailyTokenCost chart. Clicking a legend item selects that
// category; clicking a stacked sub-bar selects that category on that day. The
// current selection stays highlighted (its bars lit, others dimmed).
function ActivityChart({
  series,
  categories,
  selected,
  onSelect,
}: {
  series: ActivityDay[];
  categories: string[];
  selected: ActivitySelection | null;
  onSelect: (next: ActivitySelection) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const colorOf = new Map(categories.map((c) => [c, categoryColor(c)]));
  // Hover gives transient feedback; the persisted selection lights its category
  // whenever nothing is hovered. Either dims every other category.
  const selectedCategory = selected?.category ?? null;
  const active = hovered ?? selectedCategory;

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
              const daySelected = selected?.date === d.date;
              return (
                <Tooltip key={d.date}>
                  <TooltipTrigger asChild>
                    <div
                      tabIndex={0}
                      aria-label={`${fmtDay(d.date)} · ${d.total} ${d.total === 1 ? "event" : "events"}`}
                      className={cn(
                        "flex h-full flex-1 cursor-default flex-col-reverse justify-start gap-px rounded-sm",
                        daySelected && "bg-secondary/70",
                      )}
                    >
                      {segs.map((s) => (
                        <button
                          type="button"
                          key={s.category}
                          onMouseEnter={() => setHovered(s.category)}
                          onMouseLeave={() => setHovered(null)}
                          onClick={() =>
                            onSelect({ category: s.category, date: d.date })
                          }
                          aria-label={`${prettyCategory(s.category)} · ${fmtDay(d.date)} · ${s.count} ${s.count === 1 ? "event" : "events"}`}
                          className={cn(
                            "w-full cursor-pointer rounded-sm transition-opacity",
                            colorOf.get(s.category),
                            active && active !== s.category
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
                            active && active !== s.category && "opacity-40",
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

      {/* Legend — each entry selects its category (click again to clear). */}
      {categories.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2">
          {categories.map((c) => (
            <button
              type="button"
              key={c}
              onMouseEnter={() => setHovered(c)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => onSelect({ category: c })}
              aria-pressed={selectedCategory === c}
              className={cn(
                "flex cursor-pointer items-center gap-1.5 text-xs transition-opacity",
                active && active !== c ? "opacity-40" : "opacity-100",
                selectedCategory === c
                  ? "font-medium text-foreground"
                  : "text-secondary-foreground",
              )}
            >
              <span className={cn("size-2.5 rounded-sm", categoryColor(c))} />
              {prettyCategory(c)}
            </button>
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

// Full tenant_activity_events row (every field except tenant_id), loaded on demand.
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
// full event asynchronously and renders every field. The detail endpoint is
// tenant-scoped, so it resolves the tenant from the event itself — which works
// for both the per-tenant page and the cross-tenant global feed.
function EventDetailPopover({ event }: { event: ActivityEvent }) {
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
      `/api/tenants/${encodeURIComponent(event.tenantId)}/activity/${encodeURIComponent(event.id)}`,
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
  }, [open, detail, event.tenantId, event.id]);

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
// parent; the header stays pinned. When showTenant is set (the global feed) a
// leading Tenant column links each event to its tenant, with the display name
// resolved via tenantName.
function ActivityTable({
  events,
  showTenant,
  tenantName,
}: {
  events: ActivityEvent[];
  showTenant?: boolean;
  tenantName?: (tenantId: string) => string;
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
          {showTenant && <th className={ACTIVITY_TH}>Tenant</th>}
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
            {showTenant && (
              <td className={cn(ACTIVITY_TD, "max-w-[12rem]")}>
                <Link
                  href={`/tenants/${encodeURIComponent(e.tenantId)}`}
                  className="block truncate font-medium text-foreground hover:underline"
                >
                  {tenantName?.(e.tenantId) ?? e.tenantId}
                </Link>
              </td>
            )}
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
              <EventDetailPopover event={e} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// One page of the events table. limit+1 on the server tells us whether an older
// page exists, echoed back as hasMore.
interface ActivityPageResponse {
  activity?: ActivityEvent[];
  hasMore?: boolean;
  available: boolean;
  error?: string;
}

// ACTIVITY_PAGE is the page size for both the initial load and each lazy-load;
// LOAD_MORE_PX is how close to the bottom (in px) triggers the next page.
const ACTIVITY_PAGE = 50;
const LOAD_MORE_PX = 240;

// Default header tooltip copy (the per-tenant phrasing). The global page passes
// its own cross-tenant wording via infoText.
const DEFAULT_INFO_TEXT =
  "Behavioural events for this tenant from the centralised tenant_activity_events store (Ogen CON-125). The chart shows daily event volume over the last 90 days; the table lists individual events. Click a bar or legend entry to focus the table on that category (and day); it lazy-loads more as you scroll.";

// ActivityCard is the screen-tall recent-activity panel: a 90-day volume chart,
// a power-search filter, then a lazily-loaded, scrollable table of events. The
// chart drives a server-side selection (a category, optionally one day); the
// table then pages through just those events. With no selection it pages through
// the latest events.
//
// It is source-agnostic: `endpoint` is the list/series URL and `tenantFilter`,
// when set, is appended as ?tenant= to every request so the global feed can be
// scoped to one tenant. `showTenant`/`tenantName` add and label the Tenant
// column for the cross-tenant view.
export function ActivityCard({
  state,
  endpoint,
  tenantFilter,
  showTenant,
  tenantName,
  infoText = DEFAULT_INFO_TEXT,
}: {
  state: ActivityState;
  endpoint: string;
  tenantFilter?: string;
  showTenant?: boolean;
  tenantName?: (tenantId: string) => string;
  infoText?: string;
}) {
  const series = state.series ?? [];
  const categories = state.categories ?? [];
  const total = series.reduce((sum, d) => sum + d.total, 0);

  const [filters, setFilters] = useState<ActivityFilterToken[]>([]);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [selection, setSelection] = useState<ActivitySelection | null>(null);
  // listLoading covers a selection switch (whole table replaced); moreLoading a
  // lazy-load appended to the bottom.
  const [listLoading, setListLoading] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // Seed the table from the parent's initial (unfiltered) fetch, once it lands.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || state.loading || state.error) return;
    seeded.current = true;
    setEvents(state.events ?? []);
    setHasMore(state.hasMore ?? false);
  }, [state]);

  // Fetch one page for a selection, optionally after a keyset cursor (the last
  // loaded event). Shared by selection switches and lazy-loads.
  const fetchPage = useCallback(
    async (
      sel: ActivitySelection | null,
      cursor?: ActivityEvent,
    ): Promise<ActivityPageResponse> => {
      const params = new URLSearchParams({ limit: String(ACTIVITY_PAGE) });
      if (tenantFilter) params.set("tenant", tenantFilter);
      if (sel) {
        params.set("category", sel.category);
        if (sel.date) params.set("day", sel.date);
      }
      if (cursor) {
        params.set("beforeAt", cursor.at);
        params.set("beforeId", cursor.id);
      }
      const res = await fetch(`${endpoint}?${params.toString()}`);
      if (!res.ok) throw new Error(`request failed (${res.status})`);
      return (await res.json()) as ActivityPageResponse;
    },
    [endpoint, tenantFilter],
  );

  // Switch the table to a new chart selection (or back to "latest"). A request
  // counter drops any response that a newer selection has superseded.
  const reqId = useRef(0);
  const applySelection = useCallback(
    (next: ActivitySelection | null) => {
      setSelection(next);
      setListError(null);
      setListLoading(true);
      const id = ++reqId.current;
      fetchPage(next)
        .then((j) => {
          if (id !== reqId.current) return;
          if (j.available) {
            setEvents(j.activity ?? []);
            setHasMore(Boolean(j.hasMore));
          } else {
            setEvents([]);
            setHasMore(false);
            setListError(j.error ?? "unavailable");
          }
        })
        .catch((e: unknown) => {
          if (id !== reqId.current) return;
          setEvents([]);
          setHasMore(false);
          setListError(e instanceof Error ? e.message : "Failed to load");
        })
        .finally(() => {
          if (id === reqId.current) setListLoading(false);
        });
    },
    [fetchPage],
  );

  // Toggle: re-selecting the exact same category/day clears back to "latest".
  const onSelect = useCallback(
    (next: ActivitySelection) => {
      const same =
        selection?.category === next.category &&
        (selection?.date ?? undefined) === next.date;
      applySelection(same ? null : next);
    },
    [selection, applySelection],
  );

  // Append the next page of older events for the current view (infinite scroll).
  const loadMore = useCallback(() => {
    if (moreLoading || listLoading || !hasMore || events.length === 0) return;
    setMoreLoading(true);
    // Pin the current selection's request identity: if applySelection bumps it
    // while this page is in flight, the page belongs to a superseded list and
    // must not append (or overwrite hasMore).
    const id = reqId.current;
    const cursor = events[events.length - 1];
    fetchPage(selection, cursor)
      .then((j) => {
        if (id !== reqId.current) return;
        if (j.available) {
          setEvents((prev) => [...prev, ...(j.activity ?? [])]);
          setHasMore(Boolean(j.hasMore));
        } else {
          setHasMore(false);
        }
      })
      .catch(() => {
        // Leave hasMore untouched so a scroll can retry — a transient failure
        // must not permanently end pagination for this view.
      })
      .finally(() => setMoreLoading(false));
  }, [moreLoading, listLoading, hasMore, events, selection, fetchPage]);

  // The filter bar narrows the loaded rows client-side (options come from them).
  const options = useMemo(() => activityOptions(events), [events]);
  const filtered = useMemo(
    () => events.filter((e) => filters.every((f) => matchActivity(f, e))),
    [events, filters],
  );

  // Auto-fill is driven by the unfiltered loaded set, never the rendered rows: a
  // narrow client-side filter must not page through the whole history just to
  // fill the viewport with the few rows it matches.
  const loadedCount = events.length;
  const filterActive = filters.length > 0;

  // Scroll-fade strips (fade under the sticky header / above the bottom edge) and
  // the lazy-load trigger share one scroll handler.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const onScroll = (el: HTMLDivElement) => {
    setAtTop(el.scrollTop <= 0);
    const remaining = el.scrollHeight - (el.scrollTop + el.clientHeight);
    setAtBottom(Math.ceil(remaining) <= 0);
    if (remaining < LOAD_MORE_PX) loadMore();
  };
  // Recompute the fade strips whenever the rendered rows change (filter applied
  // or cleared, page appended, selection switched).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAtTop(el.scrollTop <= 0);
    setAtBottom(Math.ceil(el.scrollHeight - (el.scrollTop + el.clientHeight)) <= 0);
  }, [filtered]);

  // Auto-page while the loaded (unfiltered) content doesn't fill the viewport, so
  // short first pages can't strand more events out of reach. Suspended while a
  // client-side filter is active — that filter narrows the loaded rows, it must
  // not drive fetching, and loadMore stops once hasMore is exhausted.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || filterActive || loadedCount === 0) return;
    if (el.scrollHeight <= el.clientHeight + 4) loadMore();
  }, [loadedCount, filterActive, loadMore]);

  // A new chart selection replaces the whole list — jump back to the top so its
  // newest events are in view rather than a stale scroll offset.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [selection]);

  return (
    <section className="flex h-[calc(100vh-13rem)] min-h-[32rem] flex-col overflow-hidden rounded-lg bg-primary">
      <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div className="flex items-center gap-1.5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
            Recent activity
          </h2>
          <InfoIcon text={infoText} />
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
            <ActivityChart
              series={series}
              categories={categories}
              selected={selection}
              onSelect={onSelect}
            />
          </div>
          {/* Active chart selection — shown only when the table is focused on a
              category/day, with a control to clear it back to latest events. */}
          {selection && (
            <div className="flex items-center gap-2 border-b border-border px-6 py-2.5 text-xs">
              <span className="text-tertiary-foreground">Showing</span>
              <span className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-2 py-1">
                <span
                  className={cn(
                    "size-2 rounded-sm",
                    categoryColor(selection.category),
                  )}
                />
                <span className="font-medium text-foreground">
                  {prettyCategory(selection.category)}
                </span>
                {selection.date && (
                  <span className="text-tertiary-foreground">
                    · {fmtDay(selection.date)}
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => applySelection(null)}
                className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-tertiary-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <XIcon className="size-3.5" weight="bold" />
                Clear
              </button>
            </div>
          )}
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
              onScroll={(e) => onScroll(e.currentTarget)}
              className="h-full overflow-auto"
            >
              {listLoading && events.length === 0 ? (
                <div className="flex items-center gap-2 px-6 py-6 text-xs text-tertiary-foreground">
                  <Loader className="size-3.5 border-[1.5px]" />
                  Loading events…
                </div>
              ) : listError ? (
                <p className="px-6 py-6 text-xs text-tertiary-foreground">
                  Events unavailable — {listError}
                </p>
              ) : (
                <>
                  <ActivityTable
                    events={filtered}
                    showTenant={showTenant}
                    tenantName={tenantName}
                  />
                  {moreLoading && (
                    <div className="flex items-center justify-center gap-2 px-6 py-4 text-xs text-tertiary-foreground">
                      <Loader className="size-3.5 border-[1.5px]" />
                      Loading more…
                    </div>
                  )}
                  {!hasMore && !listLoading && filtered.length > 0 && (
                    <p className="px-6 py-4 text-center text-[11px] text-tertiary-foreground">
                      End of activity
                    </p>
                  )}
                </>
              )}
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
