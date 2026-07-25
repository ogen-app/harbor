"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
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

// Per-model colour, assigned by the model's rank in the (cost-desc) legend so
// the biggest spender is blue, matching the inspiration. Cycles for >8 models.
const PALETTE = [
    "bg-blue-500",
    "bg-orange-500",
    "bg-emerald-500",
    "bg-violet-500",
    "bg-amber-500",
    "bg-rose-500",
    "bg-cyan-500",
    "bg-fuchsia-500",
] as const;

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

// fmtUSD renders a spend value for tooltips/legend, keeping small amounts legible.
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

export function DailyTokenCostChart() {
    const [data, setData] = useState<DailyCostResponse | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        fetch("/api/analytics/daily-cost")
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
    }, []);

    const days = data?.days ?? [];
    const models = data?.models ?? [];
    const colorOf = new Map(models.map((m, i) => [m.model, PALETTE[i % PALETTE.length]]));

    const maxDayUSD = Math.max(0, ...days.map((d) => d.totalMicros / 1e6));
    const { max: axisMax, ticks } = niceScale(maxDayUSD);
    const axisMaxMicros = axisMax * 1e6;

    // Label roughly seven x-axis ticks, evenly spaced across the window.
    const labelStride = Math.max(1, Math.ceil(days.length / 7));

    return (
        <div className="rounded-xl bg-primary p-6">
            {/* Header */}
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h2 className="text-sm font-medium text-foreground">
                        Daily token cost
                    </h2>
                    <p className="mt-0.5 text-xs text-tertiary-foreground">
                        Summed AI token cost per day, split by model.
                    </p>
                </div>
                {data?.available && (
                    <span className="shrink-0 text-xs text-tertiary-foreground">
                        {fmtUSD(data.totalMicros)} in {data.windowDays}d
                    </span>
                )}
            </div>

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
                            <div className="absolute inset-0 flex items-end gap-[3px]">
                                {days.map((d) => {
                                    if (d.totalMicros <= 0) {
                                        return (
                                            <div
                                                key={d.date}
                                                className="flex-1"
                                                title={`${fmtDate(d.date)} · no spend`}
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
                                                <div className="flex h-full flex-1 cursor-default flex-col-reverse justify-start gap-[2px]">
                                                    {segs.map((s) => (
                                                        <div
                                                            key={s.model}
                                                            className={cn(
                                                                "w-full rounded-sm transition-opacity hover:opacity-80",
                                                                colorOf.get(s.model),
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
                                                            className="flex items-center justify-between gap-4"
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
                    <div className="ml-14 mt-2 flex gap-[3px]">
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
                                    className="flex items-center gap-1.5 text-xs text-secondary-foreground"
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
    );
}
