"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { useChartKeyboard, useElementWidth } from "@/components/charts/hooks";
import { ChartTooltip, HaloLabel, XLabel, YGrid } from "@/components/charts/primitives";
import { linear, niceScale, type Scale } from "@/components/charts/scale";
import { dayLabel } from "@/components/pnl/format";
import { fmtDays, fmtPct, HEALTH_LABEL, stageLabel, type Health, type Progress } from "./shared";

// The three panels under the board (CON-437): what moved since the previous
// snapshot, median days to a first post by signup week, and the signup cohort
// grid. Charts follow the revision-2 style (CON-413).

export interface Move {
    tenantId: string;
    name: string;
    fromProgress: Progress | "";
    toProgress: Progress;
    fromHealth: Health | "";
    toHealth: Health;
    direction: "up" | "down" | "new";
}

export interface Cohort {
    weekStart: string;
    signups: number;
    // One share per stage after Signed up; null while it's too early to tell.
    reached: (number | null)[];
    medianDaysToFirst: number | null;
}

const BLUE = "#509EE3";
const BLUE_TINT = "#E5F0FB";

function moveText(m: Move): string {
    if (m.direction === "new") return "New signup";
    if (m.fromProgress && m.fromProgress !== m.toProgress) return `${stageLabel(m.fromProgress)} → ${stageLabel(m.toProgress)}`;
    if (m.toHealth === "churned") return "Suspended or deleted";
    return `${HEALTH_LABEL[m.fromHealth || "active"]} → ${HEALTH_LABEL[m.toHealth]}`;
}

export function MovementFeed({ moves, previous }: { moves: Move[]; previous: string }) {
    return (
        <div className="space-y-3 px-6 py-4">
            <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-[13px] font-semibold text-foreground">Since {previous ? dayLabel(previous) : "yesterday"}</h3>
                <span className="text-xs tabular-nums text-tertiary-foreground">
                    {moves.length} {moves.length === 1 ? "change" : "changes"}
                </span>
            </div>
            {!previous ? (
                <p className="py-6 text-[13px] text-secondary-foreground">
                    Movement shows from the second daily snapshot on.
                </p>
            ) : moves.length === 0 ? (
                <p className="py-6 text-[13px] text-secondary-foreground">Nobody changed stage or health.</p>
            ) : (
                <ul className="divide-y divide-border">
                    {moves.map((m) => (
                        <li key={m.tenantId} className="py-2">
                            <Link href={`/tenants/${m.tenantId}`} className="block truncate text-[13px] font-medium text-foreground hover:underline">
                                {m.name}
                            </Link>
                            <span
                                className={cn(
                                    "text-xs",
                                    m.direction === "down" ? "text-[#B45309]" : "text-[#2563EB]",
                                )}
                            >
                                {m.direction === "up" ? "↑ " : m.direction === "down" ? "↓ " : "+ "}
                                {moveText(m)}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

const BOX = { h: 184, top: 20, bottom: 30, left: 34, right: 12 };

function daysScale(max: number): Scale {
    if (max <= 8) return { min: 0, max: 8, ticks: [0, 2, 4, 6, 8] };
    return niceScale(0, max, 4);
}

// MedianDaysChart: median days from signup to a first post, by signup week.
// Weeks nobody in has posted yet leave a gap.
export function MedianDaysChart({ cohorts }: { cohorts: Cohort[] }) {
    const [ref, width] = useElementWidth<HTMLDivElement>();
    const n = cohorts.length;
    const { active, setActive, onKeyDown, onBlur } = useChartKeyboard(n);
    const vals = cohorts.map((c) => c.medianDaysToFirst);
    const scale = daysScale(Math.max(0, ...vals.map((v) => v ?? 0)));
    const y = linear([scale.min, scale.max], [BOX.h - BOX.bottom, BOX.top]);
    const x0 = BOX.left;
    const x1 = Math.max(x0 + 1, width - BOX.right);
    const band = (x1 - x0) / Math.max(1, n);
    const cx = (i: number) => x0 + band * i + band / 2;

    // Split the line at gaps so a missing week never reads as a slope.
    const runs: { i: number; v: number }[][] = [];
    vals.forEach((v, i) => {
        if (v == null) return;
        const last = runs[runs.length - 1];
        if (last && last[last.length - 1].i === i - 1) last.push({ i, v });
        else runs.push([{ i, v }]);
    });
    const path = (run: { i: number; v: number }[]) => run.map((p, k) => `${k ? "L" : "M"}${cx(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");

    const a = active != null ? cohorts[active] : null;
    const known = vals.filter((v): v is number => v != null);
    const summary = known.length
        ? `Median days from signup to a first post, by signup week, over the last ${n} weeks. Latest known: ${fmtDays(known[known.length - 1])}. Use the arrow keys to read each week.`
        : "No tenant has published a first post in these weeks yet.";

    return (
        <div
            ref={ref}
            role="group"
            aria-roledescription="chart"
            aria-label={summary}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
            onMouseLeave={() => setActive(null)}
            className="relative outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
            {width > 0 && (
                <svg width={width} height={BOX.h} className="block select-none" aria-hidden>
                    <YGrid scale={scale} y={y} x0={x0} x1={x1} format={(v) => `${v}d`} />
                    {runs.map((run) =>
                        run.length > 1 ? (
                            <path
                                key={`a${run[0].i}`}
                                d={`${path(run)} L${cx(run[run.length - 1].i)},${y(0)} L${cx(run[0].i)},${y(0)} Z`}
                                fill={BLUE_TINT}
                            />
                        ) : null,
                    )}
                    {runs.map((run) => (
                        <path key={`l${run[0].i}`} d={path(run)} fill="none" stroke={BLUE} strokeWidth={1.75} strokeLinejoin="round" />
                    ))}
                    {cohorts.map((c, i) => (
                        <g key={c.weekStart}>
                            {active === i && (
                                <rect x={x0 + band * i} y={BOX.top} width={band} height={BOX.h - BOX.top - BOX.bottom} fill="#F4F3F1" opacity={0.6} />
                            )}
                            {c.medianDaysToFirst != null ? (
                                <>
                                    <circle cx={cx(i)} cy={y(c.medianDaysToFirst)} r={3} fill={BLUE} stroke="#FFFFFF" strokeWidth={1.5} />
                                    <HaloLabel x={cx(i)} y={y(c.medianDaysToFirst) - 9} fill="#1C1C1C">
                                        {fmtDays(c.medianDaysToFirst)}
                                    </HaloLabel>
                                </>
                            ) : (
                                c.signups > 0 && (
                                    <text x={cx(i)} y={y(0) - 8} textAnchor="middle" fill="#A39E97" className="text-[11px]">
                                        —
                                    </text>
                                )
                            )}
                            {(i % 2 === 0 || i === n - 1) && (
                                <XLabel x={cx(i)} y={BOX.h - 8}>
                                    {dayLabel(c.weekStart)}
                                </XLabel>
                            )}
                            <rect
                                x={x0 + band * i}
                                y={BOX.top}
                                width={band}
                                height={BOX.h - BOX.top - BOX.bottom}
                                fill="transparent"
                                onMouseEnter={() => setActive(i)}
                            />
                        </g>
                    ))}
                </svg>
            )}
            {a && active != null && (
                <ChartTooltip
                    x={cx(active) + band / 2}
                    xLeft={cx(active) - band / 2}
                    top={BOX.top}
                    width={width}
                    title={`Signed up week of ${dayLabel(a.weekStart)}`}
                    rows={[
                        { label: "Signups", value: String(a.signups) },
                        { label: "Median to first post", value: fmtDays(a.medianDaysToFirst), color: BLUE },
                    ]}
                />
            )}
        </div>
    );
}

// CohortGrid: per signup week, the share that reached each stage. Shade
// follows the share; "—" marks a week too young to tell.
export function CohortGrid({ cohorts, stages }: { cohorts: Cohort[]; stages: Progress[] }) {
    const rows = cohorts.filter((c) => c.signups > 0);
    if (rows.length === 0) {
        return <p className="py-6 text-[13px] text-secondary-foreground">No signups in the last {cohorts.length} weeks.</p>;
    }
    return (
        <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-1 text-xs">
                <thead>
                    <tr>
                        <th className="text-left font-normal text-tertiary-foreground">Week</th>
                        <th className="pr-2 text-right font-normal text-tertiary-foreground">n</th>
                        {stages.map((s) => (
                            <th key={s} className="font-normal text-tertiary-foreground">
                                {stageLabel(s)}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((c) => (
                        <tr key={c.weekStart}>
                            <td className="whitespace-nowrap pr-2 text-foreground">{dayLabel(c.weekStart)}</td>
                            <td className="pr-2 text-right tabular-nums text-tertiary-foreground">{c.signups}</td>
                            {c.reached.map((v, j) =>
                                v == null ? (
                                    <td
                                        key={j}
                                        title="Too early to tell"
                                        className="h-8 min-w-12 border border-dashed border-border text-center text-tertiary-foreground"
                                    >
                                        —
                                    </td>
                                ) : (
                                    <td
                                        key={j}
                                        className={cn("h-8 min-w-12 text-center font-medium tabular-nums", v >= 0.6 ? "text-white" : "text-foreground")}
                                        style={{ background: `rgba(80, 158, 227, ${(0.08 + 0.82 * v).toFixed(2)})` }}
                                    >
                                        {fmtPct(v)}
                                    </td>
                                ),
                            )}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
