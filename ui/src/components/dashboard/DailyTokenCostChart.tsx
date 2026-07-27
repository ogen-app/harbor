"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { HandCoinsIcon } from "@phosphor-icons/react";
import { InfoIcon } from "@/components/dashboard/primitives";
import {
    Tooltip,
    TooltipTrigger,
    TooltipContent,
} from "@/components/ui/tooltip";

interface ModelTotal {
    model: string;
    costMicros: number;
}
interface CostDay {
    date: string;
    totalMicros: number;
    costs: Record<string, number>;
}
interface DailyCostResponse {
    available: boolean;
    windowDays: number;
    totalMicros: number;
    models: ModelTotal[];
    days: CostDay[];
    error?: string;
}

// Window shown by the chart (also the max the API allows).
const WINDOW_DAYS = 90;

// Colour families by vendor: Anthropic in oranges, Google in blues, everything
// else in neutral greys. A model's shade is fixed by a hash of its id within its
// family, so a given model always keeps the same colour regardless of its cost
// rank or which other models are present.
type Vendor = "anthropic" | "google" | "other";

const VENDOR_SHADES: Record<Vendor, readonly string[]> = {
    anthropic: [
        "bg-orange-500",
        "bg-orange-400",
        "bg-orange-600",
        "bg-amber-500",
        "bg-amber-400",
        "bg-orange-300",
    ],
    google: [
        "bg-blue-500",
        "bg-blue-400",
        "bg-blue-600",
        "bg-sky-500",
        "bg-sky-400",
        "bg-blue-300",
    ],
    other: ["bg-neutral-500", "bg-neutral-400", "bg-neutral-600", "bg-neutral-300"],
};

// classifyVendor maps a model id to its colour family, mirroring the backend's
// vendor classification (src/repository/analytics/spend.go).
function classifyVendor(model: string): Vendor {
    const v = model.toLowerCase();
    if (v.includes("claude") || v.includes("anthropic")) return "anthropic";
    if (v.includes("gemini") || v.includes("google") || v.includes("vertex"))
        return "google";
    return "other";
}

// hashString folds a model id into a non-negative 32-bit int (djb2), so a shade
// can be picked from the id alone — no dependency on the surrounding model set.
function hashString(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = (Math.imul(h, 33) + s.charCodeAt(i)) | 0;
    }
    return h >>> 0;
}

// buildColorMap assigns every model a stable colour from its vendor's shade
// family. The shade is chosen by hashing the model id into that family's list,
// so a model's colour depends only on its own id: adding or removing other
// models never reshuffles existing assignments, nor does a change in cost rank.
function buildColorMap(modelIds: string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const id of modelIds) {
        const shades = VENDOR_SHADES[classifyVendor(id)];
        out.set(id, shades[hashString(id) % shades.length]);
    }
    return out;
}

const CHART_H = 240; // px — plot height, excluding axes

// "2026-07-17" → "Jul 17" (parsed as local midnight to avoid TZ drift).
function fmtDate(date: string): string {
    return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
    });
}

// fmtAxis renders a y-axis tick: "US$0", "US$1", "US$1.50".
function fmtAxis(usd: number): string {
    if (usd === 0) return "US$0";
    return Number.isInteger(usd) ? `US$${usd}` : `US$${usd.toFixed(2)}`;
}

// fmtUSD renders a spend value for tooltips/legend/totals, keeping small
// amounts legible while compacting large ones.
function fmtUSD(micros: number): string {
    const d = micros / 1e6;
    if (d === 0) return "$0";
    if (d < 0.01) return `$${d.toFixed(4)}`;
    if (d < 1) return `$${d.toFixed(3)}`;
    if (d < 1000) return `$${d.toFixed(2)}`;
    return `$${(d / 1000).toFixed(1)}k`;
}

// prettyModel turns a raw model id ("claude-sonnet-4-5") into a display name
// ("Claude Sonnet 4.5"): title-case words, join adjacent version numbers with
// a dot, and leave already-numeric tokens (e.g. "2.5") alone.
function prettyModel(id: string): string {
    if (!id || id === "unknown") return "Unknown";
    const words = id.split(/[-_]/).filter(Boolean).map((p) => {
        if (/\d/.test(p)) return p; // version-ish token, keep as-is
        if (p === "gpt" || p === "ai") return p.toUpperCase();
        return p.charAt(0).toUpperCase() + p.slice(1);
    });
    return words.reduce((out, w, i) => {
        if (i === 0) return w;
        const joinDot = /^\d+$/.test(w) && /\d$/.test(words[i - 1]);
        return out + (joinDot ? "." : " ") + w;
    }, "");
}

// niceScale picks a rounded y-axis maximum and evenly-spaced ticks (~4
// intervals) so gridline labels land on clean values like the inspiration.
function niceScale(maxUSD: number): { max: number; ticks: number[] } {
    if (maxUSD <= 0) return { max: 1, ticks: [0, 0.5, 1] };
    const rawStep = maxUSD / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    const step =
        (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) *
        mag;
    const max = Math.ceil(maxUSD / step) * step;
    const ticks: number[] = [];
    for (let v = 0; v <= max + step / 1000; v += step) {
        ticks.push(Number(v.toFixed(10)));
    }
    return { max, ticks };
}

// "2026-07" → the previous calendar month's prefix, "2026-06".
function prevMonthPrefix(prefix: string): string {
    const [y, m] = prefix.split("-").map(Number);
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    return `${py}-${String(pm).padStart(2, "0")}`;
}

// "2026-07" → "July" (long) or "Jul" (short).
function monthName(prefix: string, long = false): string {
    const [y, m] = prefix.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
        month: long ? "long" : "short",
    });
}

// SummaryCell is one aggregated-total cell in the card footer (dividers and
// background are owned by the parent strip), mirroring the tenant metric cells.
function SummaryCell({
    label,
    value,
    info,
}: {
    label: string;
    value: string;
    info: string;
}) {
    return (
        <div className="p-5">
            <div className="flex items-center gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
                    {label}
                </span>
                <InfoIcon text={info} />
            </div>
            <p className="mt-2 font-display text-2xl font-semibold text-foreground">
                {value}
            </p>
        </div>
    );
}

// DailyTokenCostChart renders the daily token-cost dashboard. With no props it
// covers all tenants (the home dashboard); pass tenantId to scope it to a single
// tenant (the /tenants/[id] detail page) — the visuals are identical, only the
// data source differs.
export function DailyTokenCostChart({ tenantId }: { tenantId?: string } = {}) {
    const [data, setData] = useState<DailyCostResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    // Model highlighted by hovering a bar segment, tooltip row, or legend entry;
    // all of that model's segments stay lit while the rest dim.
    const [hoveredModel, setHoveredModel] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        const url = tenantId
            ? `/api/tenants/${encodeURIComponent(tenantId)}/daily-cost?days=${WINDOW_DAYS}`
            : `/api/analytics/daily-cost?days=${WINDOW_DAYS}`;
        fetch(url)
            .then((r) => {
                if (!r.ok) throw new Error(`request failed (${r.status})`);
                return r.json();
            })
            .then((j: DailyCostResponse) => {
                if (active) setData(j);
            })
            .catch((e: unknown) => {
                if (active)
                    setError(e instanceof Error ? e.message : "Failed to load");
            });
        return () => {
            active = false;
        };
    }, [tenantId]);

    const days = data?.days ?? [];
    const models = data?.models ?? [];
    const colorOf = buildColorMap(models.map((m) => m.model));

    const maxDayUSD = Math.max(0, ...days.map((d) => d.totalMicros / 1e6));
    const { max: axisMax, ticks } = niceScale(maxDayUSD);
    const axisMaxMicros = axisMax * 1e6;

    // Label roughly seven x-axis ticks, evenly spaced across the window.
    const labelStride = Math.max(1, Math.ceil(days.length / 7));

    // Calendar-month aggregates, derived from the daily series (a 90-day window
    // always fully contains both the current and previous calendar months).
    const lastDate = days.length ? days[days.length - 1].date : "";
    const thisMonth = lastDate.slice(0, 7);
    const lastMonth = thisMonth ? prevMonthPrefix(thisMonth) : "";
    const sumMonth = (prefix: string) =>
        days
            .filter((d) => prefix && d.date.startsWith(prefix))
            .reduce((s, d) => s + d.totalMicros, 0);

    return (
        <div className="overflow-hidden rounded-lg bg-primary">
            {/* Header — compact uppercase style matching the sibling sections on
                the tenant detail page; the full display title with icon on the
                home dashboard (beside the Tenants/Databases cards). */}
            {tenantId ? (
                <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
                    <div className="flex items-center gap-1.5">
                        <h2 className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
                            Daily token cost
                        </h2>
                        <InfoIcon text="This tenant's AI token cost per day, split by model, over the last 90 days. Anthropic models are shown in orange, Google in blue." />
                    </div>
                    {data?.available && (
                        <span className="shrink-0 text-xs tabular-nums text-tertiary-foreground">
                            Last {data.windowDays} days
                        </span>
                    )}
                </div>
            ) : (
                <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-3">
                    <h2 className="flex items-center gap-2 text-xl font-medium text-foreground font-display">
                        <HandCoinsIcon className="size-6" weight="bold" />
                        Daily token cost
                    </h2>
                    {data?.available && (
                        <span className="shrink-0 text-xs text-tertiary-foreground">
                            Last {data.windowDays} days
                        </span>
                    )}
                </div>
            )}

            <div className="p-6">
                <p className="text-xs text-tertiary-foreground">
                    Summed AI token cost per day, split by model.
                </p>

                {error || (data && !data.available) ? (
                    <p className="mt-4 text-sm text-tertiary-foreground">
                        Token cost unavailable —{" "}
                        {error || data?.error || "analytics database not reachable"}
                    </p>
                ) : !data ? (
                    <div
                        className="mt-6 animate-pulse rounded bg-secondary"
                        style={{ height: CHART_H }}
                    />
                ) : (
                    <>
                        {/* Plot: y-axis label gutter + gridded bars */}
                        <div className="mt-6 flex gap-2">
                            <div
                                className="relative w-12 shrink-0"
                                style={{ height: CHART_H }}
                                aria-hidden
                            >
                                {ticks.map((t) => (
                                    <span
                                        key={t}
                                        className="absolute right-0 -translate-y-1/2 text-[11px] text-tertiary-foreground"
                                        style={{ bottom: `${(t / axisMax) * 100}%` }}
                                    >
                                        {fmtAxis(t)}
                                    </span>
                                ))}
                            </div>

                            <div className="relative flex-1" style={{ height: CHART_H }}>
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
                                    {days.map((d) => {
                                        if (d.totalMicros <= 0) {
                                            return (
                                                <div
                                                    key={d.date}
                                                    className="flex-1"
                                                    title={`${fmtDate(d.date)} · no spend`}
                                                    aria-label={`${fmtDate(d.date)} · no spend`}
                                                />
                                            );
                                        }
                                        // Segments ordered by legend rank (largest at the
                                        // bottom), each sized against the shared axis max.
                                        const segs = models
                                            .map((m) => ({
                                                model: m.model,
                                                micros: d.costs[m.model] ?? 0,
                                            }))
                                            .filter((s) => s.micros > 0);
                                        return (
                                            <Tooltip key={d.date}>
                                                <TooltipTrigger asChild>
                                                    <div
                                                        tabIndex={0}
                                                        aria-label={`${fmtDate(d.date)} · ${fmtUSD(d.totalMicros)} total`}
                                                        className="flex h-full flex-1 cursor-default flex-col-reverse justify-start gap-[2px]"
                                                    >
                                                        {segs.map((s) => (
                                                            <div
                                                                key={s.model}
                                                                onMouseEnter={() => setHoveredModel(s.model)}
                                                                onMouseLeave={() => setHoveredModel(null)}
                                                                className={cn(
                                                                    "w-full rounded-sm transition-opacity",
                                                                    colorOf.get(s.model),
                                                                    hoveredModel && hoveredModel !== s.model
                                                                        ? "opacity-20"
                                                                        : "opacity-100",
                                                                )}
                                                                style={{
                                                                    height: `${Math.max(
                                                                        (s.micros / axisMaxMicros) * CHART_H,
                                                                        2,
                                                                    )}px`,
                                                                }}
                                                            />
                                                        ))}
                                                    </div>
                                                </TooltipTrigger>
                                                <TooltipContent className="min-w-44 border-foreground bg-foreground text-left text-background">
                                                    <p className="font-medium">{fmtDate(d.date)}</p>
                                                    <p className="text-background/70">
                                                        {fmtUSD(d.totalMicros)} total
                                                    </p>
                                                    <ul className="mt-1.5 space-y-1">
                                                        {segs.map((s) => (
                                                            <li
                                                                key={s.model}
                                                                onMouseEnter={() => setHoveredModel(s.model)}
                                                                onMouseLeave={() => setHoveredModel(null)}
                                                                className={cn(
                                                                    "flex items-center justify-between gap-4 transition-opacity",
                                                                    hoveredModel && hoveredModel !== s.model && "opacity-40",
                                                                )}
                                                            >
                                                                <span className="flex items-center gap-1.5">
                                                                    <span
                                                                        className={cn(
                                                                            "size-2 rounded-full",
                                                                            colorOf.get(s.model),
                                                                        )}
                                                                    />
                                                                    {prettyModel(s.model)}
                                                                </span>
                                                                <span className="font-medium">
                                                                    {fmtUSD(s.micros)}
                                                                </span>
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

                        {/* X-axis date labels, aligned under their bars */}
                        <div className="ml-14 mt-2 flex gap-[2px]">
                            {days.map((d, i) => (
                                <span
                                    key={d.date}
                                    className="flex-1 text-center text-[11px] text-tertiary-foreground"
                                >
                                    {i % labelStride === 0 ? (
                                        <span className="inline-block whitespace-nowrap">
                                            {fmtDate(d.date)}
                                        </span>
                                    ) : null}
                                </span>
                            ))}
                        </div>

                        {/* Legend */}
                        {models.length > 0 && (
                            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2">
                                {models.map((m) => (
                                    <span
                                        key={m.model}
                                        onMouseEnter={() => setHoveredModel(m.model)}
                                        onMouseLeave={() => setHoveredModel(null)}
                                        className={cn(
                                            "flex cursor-default items-center gap-1.5 text-xs text-secondary-foreground transition-opacity",
                                            hoveredModel && hoveredModel !== m.model && "opacity-40",
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                "size-2.5 rounded-sm",
                                                colorOf.get(m.model),
                                            )}
                                        />
                                        {prettyModel(m.model)}
                                    </span>
                                ))}
                            </div>
                        )}
                    </>
                )}
            </div>

            {/* Aggregated totals — 90-day window and calendar months */}
            {data?.available && (
                <div className="grid grid-cols-1 divide-y divide-border border-t border-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                    <SummaryCell
                        label={`Last ${data.windowDays} days`}
                        value={fmtUSD(data.totalMicros)}
                        info={`Total AI token cost over the last ${data.windowDays} days.`}
                    />
                    <SummaryCell
                        label={lastMonth ? `Last month · ${monthName(lastMonth)}` : "Last month"}
                        value={fmtUSD(sumMonth(lastMonth))}
                        info={
                            lastMonth
                                ? `Token cost for the previous calendar month (${monthName(lastMonth, true)}).`
                                : "Token cost for the previous calendar month."
                        }
                    />
                    <SummaryCell
                        label={thisMonth ? `This month · ${monthName(thisMonth)}` : "This month"}
                        value={fmtUSD(sumMonth(thisMonth))}
                        info={
                            thisMonth
                                ? `Token cost so far this calendar month (from 1 ${monthName(thisMonth, true)}).`
                                : "Token cost so far this calendar month."
                        }
                    />
                </div>
            )}
        </div>
    );
}
