"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { InfoIcon } from "@/components/dashboard/primitives";
import {
    Tooltip,
    TooltipTrigger,
    TooltipContent,
} from "@/components/ui/tooltip";

interface PlatformTotal {
    platform: string;
    count: number;
}
interface PublishingDay {
    date: string;
    total: number;
    counts: Record<string, number>;
}
interface PublishingResponse {
    available: boolean;
    windowDays: number;
    total: number;
    platforms: PlatformTotal[];
    days: PublishingDay[];
    error?: string;
}

// Window shown by the chart (also the max the API allows). Mirrors the daily
// token-cost chart it sits beneath.
const WINDOW_DAYS = 90;

// Recognisable brand colours for the common social platforms, keyed by the
// lowercased platform name; anything else falls back to a stable palette shade
// picked by hashing the name (so a platform keeps its colour regardless of which
// others are present). Values are Tailwind bg-* classes.
const PLATFORM_COLOR: Record<string, string> = {
    x: "bg-neutral-800",
    "x (twitter)": "bg-neutral-800",
    twitter: "bg-sky-500",
    instagram: "bg-pink-500",
    facebook: "bg-blue-600",
    linkedin: "bg-sky-700",
    tiktok: "bg-neutral-900",
    youtube: "bg-red-500",
    threads: "bg-neutral-700",
    pinterest: "bg-red-600",
    bluesky: "bg-sky-400",
    mastodon: "bg-violet-600",
};

const PLATFORM_PALETTE: readonly string[] = [
    "bg-blue-500",
    "bg-violet-500",
    "bg-emerald-500",
    "bg-amber-500",
    "bg-rose-500",
    "bg-cyan-500",
    "bg-indigo-500",
    "bg-orange-500",
    "bg-teal-500",
    "bg-fuchsia-500",
];

// hashString folds a platform name into a non-negative 32-bit int (djb2), so a
// palette shade can be picked from the name alone.
function hashString(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = (Math.imul(h, 33) + s.charCodeAt(i)) | 0;
    }
    return h >>> 0;
}

function colorFor(platform: string): string {
    const key = platform.toLowerCase();
    return (
        PLATFORM_COLOR[key] ??
        PLATFORM_PALETTE[hashString(key) % PLATFORM_PALETTE.length]
    );
}

const CHART_H = 240; // px — plot height, excluding axes

// "2026-07-17" → "Jul 17" (parsed as local midnight to avoid TZ drift).
function fmtDate(date: string): string {
    return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
    });
}

// Post counts are whole numbers; compact large totals but keep small ones exact.
function fmtCount(n: number): string {
    if (n < 1000) return `${n}`;
    return `${(n / 1000).toFixed(1)}k`;
}

// pluralise a post count for tooltips / summaries.
function fmtPosts(n: number): string {
    return `${fmtCount(n)} ${n === 1 ? "post" : "posts"}`;
}

// prettyPlatform leaves the (already display-form) platform name as-is, but
// title-cases an all-lowercase key and names the unknown bucket.
function prettyPlatform(name: string): string {
    if (!name || name === "unknown") return "Unknown";
    if (name === name.toLowerCase()) {
        return name.charAt(0).toUpperCase() + name.slice(1);
    }
    return name;
}

// niceCountScale picks a rounded integer y-axis maximum and evenly-spaced integer
// ticks (~4 intervals). Steps are constrained to {1, 2, 5} × 10ⁿ and floored at 1
// so a count axis never shows fractional ticks.
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
    for (let v = 0; v <= niceMax + step / 1000; v += step) {
        ticks.push(Math.round(v));
    }
    return { max: niceMax, ticks };
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

// SummaryCell is one aggregated-total cell in the card footer, mirroring the
// daily token-cost chart's footer.
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
            <p className="mt-2 text-2xl font-medium font-mono text-foreground">
                {value}
            </p>
        </div>
    );
}

// PublishingStatsChart renders per-platform publishing throughput per day across
// all tenants — the count twin of DailyTokenCostChart, sitting beneath it on the
// home dashboard. Sourced from the Ogen control-plane posts (published-post
// counts), not the analytics spend pool.
export function PublishingStatsChart() {
    const [data, setData] = useState<PublishingResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    // Platform highlighted by hovering a bar segment, tooltip row, or legend
    // entry; all of that platform's segments stay lit while the rest dim.
    const [hovered, setHovered] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        fetch(`/api/tenants/daily-publishes?days=${WINDOW_DAYS}`)
            .then((r) => {
                if (!r.ok) throw new Error(`request failed (${r.status})`);
                return r.json();
            })
            .then((j: PublishingResponse) => {
                if (active) setData(j);
            })
            .catch((e: unknown) => {
                if (active)
                    setError(e instanceof Error ? e.message : "Failed to load");
            });
        return () => {
            active = false;
        };
    }, []);

    const days = data?.days ?? [];
    const platforms = data?.platforms ?? [];

    const maxDay = Math.max(0, ...days.map((d) => d.total));
    const { max: axisMax, ticks } = niceCountScale(maxDay);

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
            .reduce((s, d) => s + d.total, 0);

    return (
        <div className="overflow-hidden rounded-lg bg-primary">
            <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-3">
                <h2 className="flex items-center gap-2 text-xl font-medium text-foreground font-display">
                    Daily publishing
                </h2>
                {data?.available && (
                    <span className="shrink-0 text-xs text-tertiary-foreground">
                        Last {data.windowDays} days
                    </span>
                )}
            </div>

            <div className="p-6">
                <p className="text-xs text-tertiary-foreground">
                    Posts published per day, split by platform.
                </p>

                {error || (data && !data.available) ? (
                    <p className="mt-4 text-sm text-tertiary-foreground">
                        Publishing stats unavailable —{" "}
                        {error || data?.error || "Ogen database not reachable"}
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
                                        {t}
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
                                        if (d.total <= 0) {
                                            return (
                                                <div
                                                    key={d.date}
                                                    className="flex-1"
                                                    title={`${fmtDate(d.date)} · no posts`}
                                                    aria-label={`${fmtDate(d.date)} · no posts`}
                                                />
                                            );
                                        }
                                        // Segments ordered by legend rank (largest at the
                                        // bottom), each sized against the shared axis max.
                                        const segs = platforms
                                            .map((p) => ({
                                                platform: p.platform,
                                                count: d.counts[p.platform] ?? 0,
                                            }))
                                            .filter((s) => s.count > 0);
                                        return (
                                            <Tooltip key={d.date}>
                                                <TooltipTrigger asChild>
                                                    <div
                                                        tabIndex={0}
                                                        aria-label={`${fmtDate(d.date)} · ${fmtPosts(d.total)}`}
                                                        className="flex h-full flex-1 cursor-default flex-col-reverse justify-start gap-[2px]"
                                                    >
                                                        {segs.map((s) => (
                                                            <div
                                                                key={s.platform}
                                                                onMouseEnter={() => setHovered(s.platform)}
                                                                onMouseLeave={() => setHovered(null)}
                                                                className={cn(
                                                                    "w-full rounded-sm transition-opacity",
                                                                    colorFor(s.platform),
                                                                    hovered && hovered !== s.platform
                                                                        ? "opacity-20"
                                                                        : "opacity-100",
                                                                )}
                                                                style={{
                                                                    height: `${Math.max(
                                                                        (s.count / axisMax) * CHART_H,
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
                                                        {fmtPosts(d.total)}
                                                    </p>
                                                    <ul className="mt-1.5 space-y-1">
                                                        {segs.map((s) => (
                                                            <li
                                                                key={s.platform}
                                                                onMouseEnter={() => setHovered(s.platform)}
                                                                onMouseLeave={() => setHovered(null)}
                                                                className={cn(
                                                                    "flex items-center justify-between gap-4 transition-opacity",
                                                                    hovered && hovered !== s.platform && "opacity-40",
                                                                )}
                                                            >
                                                                <span className="flex items-center gap-1.5">
                                                                    <span
                                                                        className={cn(
                                                                            "size-2 rounded-full",
                                                                            colorFor(s.platform),
                                                                        )}
                                                                    />
                                                                    {prettyPlatform(s.platform)}
                                                                </span>
                                                                <span className="font-medium">
                                                                    {fmtCount(s.count)}
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
                        {platforms.length > 0 ? (
                            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2">
                                {platforms.map((p) => (
                                    <span
                                        key={p.platform}
                                        onMouseEnter={() => setHovered(p.platform)}
                                        onMouseLeave={() => setHovered(null)}
                                        className={cn(
                                            "flex cursor-default items-center gap-1.5 text-xs text-secondary-foreground transition-opacity",
                                            hovered && hovered !== p.platform && "opacity-40",
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                "size-2.5 rounded-sm",
                                                colorFor(p.platform),
                                            )}
                                        />
                                        {prettyPlatform(p.platform)}
                                    </span>
                                ))}
                            </div>
                        ) : (
                            <p className="mt-4 text-xs text-tertiary-foreground">
                                No posts published in the last {data.windowDays} days.
                            </p>
                        )}
                    </>
                )}
            </div>

            {/* Aggregated totals — 90-day window and calendar months */}
            {data?.available && (
                <div className="grid grid-cols-1 divide-y divide-border border-t border-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                    <SummaryCell
                        label={`Last ${data.windowDays} days`}
                        value={fmtCount(data.total)}
                        info={`Total posts published over the last ${data.windowDays} days.`}
                    />
                    <SummaryCell
                        label={lastMonth ? `Last month · ${monthName(lastMonth)}` : "Last month"}
                        value={fmtCount(sumMonth(lastMonth))}
                        info={
                            lastMonth
                                ? `Posts published in the previous calendar month (${monthName(lastMonth, true)}).`
                                : "Posts published in the previous calendar month."
                        }
                    />
                    <SummaryCell
                        label={thisMonth ? `This month · ${monthName(thisMonth)}` : "This month"}
                        value={fmtCount(sumMonth(thisMonth))}
                        info={
                            thisMonth
                                ? `Posts published so far this calendar month (from 1 ${monthName(thisMonth, true)}).`
                                : "Posts published so far this calendar month."
                        }
                    />
                </div>
            )}
        </div>
    );
}
