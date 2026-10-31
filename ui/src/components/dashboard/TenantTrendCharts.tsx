"use client";

import { useChartKeyboard, useElementWidth } from "@/components/charts/hooks";
import { ChartTooltip, HaloLabel, Legend, XLabel, YGrid, type TooltipRow } from "@/components/charts/primitives";
import { linear, niceScale, type Scale } from "@/components/charts/scale";
import { dayLabel, dateLong } from "@/components/pnl/format";

// Small tenant trend charts for the dashboard's Tenants panel (CON-436), in
// the revision-2 chart style (CON-413).

const BLUE = "#509EE3";
const BLUE_TINT = "#E5F0FB";
const GREY = "#A39E97";
const MUTED = "#6F6A63";
const BOX = { h: 168, top: 20, bottom: 30, left: 34, right: 12 };

export interface WeekCount {
    weekStart: string;
    count: number;
}
export interface DayActive {
    date: string;
    active: number;
    live: number;
}

// countScale keeps whole-number ticks on the small counts a young platform has.
function countScale(max: number): Scale {
    if (max <= 4) {
        const top = Math.max(1, max);
        return { min: 0, max: top, ticks: Array.from({ length: top + 1 }, (_, i) => i) };
    }
    return niceScale(0, max, 4);
}

function ChartFrame({
    summary,
    live,
    onKeyDown,
    onBlur,
    onMouseLeave,
    innerRef,
    children,
}: {
    summary: string;
    live: string;
    onKeyDown: (e: React.KeyboardEvent) => void;
    onBlur: () => void;
    onMouseLeave: () => void;
    innerRef: React.RefObject<HTMLDivElement | null>;
    children: React.ReactNode;
}) {
    return (
        <div
            ref={innerRef}
            role="group"
            aria-roledescription="chart"
            aria-label={summary}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
            onMouseLeave={onMouseLeave}
            className="relative outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
            {children}
            <p className="sr-only" aria-live="polite">
                {live}
            </p>
        </div>
    );
}

// SignupsWeeklyChart: tenant signups per ISO week, the current week last.
export function SignupsWeeklyChart({ weeks }: { weeks: WeekCount[] }) {
    const [ref, width] = useElementWidth<HTMLDivElement>();
    const n = weeks.length;
    const { active, setActive, onKeyDown, onBlur } = useChartKeyboard(n);
    const total = weeks.reduce((s, w) => s + w.count, 0);

    const scale = countScale(Math.max(0, ...weeks.map((w) => w.count)));
    const y = linear([scale.min, scale.max], [BOX.h - BOX.bottom, BOX.top]);
    const x0 = BOX.left;
    const x1 = Math.max(x0 + 1, width - BOX.right);
    const band = (x1 - x0) / Math.max(1, n);
    const bw = Math.max(4, Math.round(band * 0.6));
    const cx = (i: number) => x0 + band * i + band / 2;
    const label = (i: number) => (i === n - 1 ? "This week" : dayLabel(weeks[i].weekStart));

    const a = active != null ? weeks[active] : null;
    const summary = `Tenant signups per week over the last ${n} weeks: ${total} in total, ${weeks[n - 1]?.count ?? 0} this week. Use the arrow keys to read each week.`;

    return (
        <ChartFrame
            innerRef={ref}
            summary={summary}
            live={a ? `Week of ${dateLong(a.weekStart)}: ${a.count} signups` : ""}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
            onMouseLeave={() => setActive(null)}
        >
            {width > 0 && (
                <svg width={width} height={BOX.h} className="block select-none" aria-hidden>
                    <YGrid scale={scale} y={y} x0={x0} x1={x1} format={String} />
                    {weeks.map((w, i) => (
                        <g key={w.weekStart}>
                            {active === i && (
                                <rect x={x0 + band * i} y={BOX.top} width={band} height={BOX.h - BOX.top - BOX.bottom} fill="#F4F3F1" />
                            )}
                            {w.count > 0 && (
                                <>
                                    <rect x={cx(i) - bw / 2} y={y(w.count)} width={bw} height={y(0) - y(w.count)} fill={BLUE} />
                                    <HaloLabel x={cx(i)} y={y(w.count) - 6} fill="#1C1C1C">
                                        {w.count}
                                    </HaloLabel>
                                </>
                            )}
                            {(i % 4 === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= 3) && (
                                <XLabel x={cx(i)} y={BOX.h - 8} anchor={i === n - 1 ? "end" : i === 0 ? "start" : "middle"}>
                                    {label(i)}
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
                    title={active === n - 1 ? "This week" : `Week of ${dayLabel(a.weekStart)}`}
                    rows={[{ label: "Signups", value: String(a.count), color: BLUE }]}
                />
            )}
        </ChartFrame>
    );
}

// ActiveTenantsLegend sits in the chart's heading row.
export function ActiveTenantsLegend() {
    return (
        <Legend
            items={[
                { label: "Active", color: BLUE },
                { label: "Live tenants", color: GREY, kind: "line" },
            ]}
        />
    );
}

// ActiveTenantsDailyChart: tenants with real activity each day, against the
// tenants that existed that day.
export function ActiveTenantsDailyChart({ days }: { days: DayActive[] }) {
    const [ref, width] = useElementWidth<HTMLDivElement>();
    const n = days.length;
    const { active, setActive, onKeyDown, onBlur } = useChartKeyboard(n);

    const scale = countScale(Math.max(0, ...days.map((d) => Math.max(d.active, d.live))));
    const y = linear([scale.min, scale.max], [BOX.h - BOX.bottom, BOX.top]);
    const x0 = BOX.left;
    const x1 = Math.max(x0 + 1, width - BOX.right);
    const x = (i: number) => x0 + (n > 1 ? (i / (n - 1)) * (x1 - x0) : 0);

    const line = (pick: (d: DayActive) => number) =>
        days.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(pick(d)).toFixed(1)}`).join(" ");
    const activeLine = line((d) => d.active);
    const area = n ? `${activeLine} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z` : "";
    // Live tenants as a step line, so a signup reads as a step, not a slope.
    const liveLine = days
        .map((d, i) => (i ? `H${x(i).toFixed(1)} V${y(d.live).toFixed(1)}` : `M${x(0)},${y(d.live)}`))
        .join(" ");

    const ticks = n ? [0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1] : [];
    const last = days[n - 1];
    const a = active != null ? days[active] : null;
    const rows: TooltipRow[] = a
        ? [
              { label: "Active tenants", value: String(a.active), color: BLUE },
              { label: "Live tenants", value: String(a.live), color: GREY },
          ]
        : [];
    const summary = last
        ? `Tenants with activity per day over the last ${n} days. Today ${last.active} of ${last.live} live tenants. Use the arrow keys to read each day.`
        : "No activity data.";

    return (
        <ChartFrame
            innerRef={ref}
            summary={summary}
            live={a ? `${dateLong(a.date)}: ${a.active} active of ${a.live} live` : ""}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
            onMouseLeave={() => setActive(null)}
        >
            {width > 0 && n > 0 && (
                <svg width={width} height={BOX.h} className="block select-none" aria-hidden>
                    <YGrid scale={scale} y={y} x0={x0} x1={x1} format={String} />
                    <path d={area} fill={BLUE_TINT} />
                    <path d={liveLine} fill="none" stroke={GREY} strokeWidth={1.5} strokeDasharray="2 3" />
                    <path d={activeLine} fill="none" stroke={BLUE} strokeWidth={1.75} strokeLinejoin="round" />
                    {active != null && (
                        <g>
                            <line x1={x(active)} x2={x(active)} y1={BOX.top} y2={y(0)} stroke={MUTED} strokeDasharray="2 3" />
                            <circle cx={x(active)} cy={y(days[active].active)} r={4} fill={BLUE} stroke="#FFFFFF" strokeWidth={1.5} />
                        </g>
                    )}
                    <circle cx={x(n - 1)} cy={y(last.active)} r={3.5} fill={BLUE} stroke="#FFFFFF" strokeWidth={1.5} />
                    <HaloLabel x={x(n - 1) - 6} y={y(last.active) - 8} fill={BLUE} anchor="end">
                        {`${last.active} today`}
                    </HaloLabel>
                    {ticks.map((i, k) => (
                        <XLabel key={i} x={x(i)} y={BOX.h - 8} anchor={k === 0 ? "start" : k === ticks.length - 1 ? "end" : "middle"}>
                            {dayLabel(days[i].date)}
                        </XLabel>
                    ))}
                    {days.map((d, i) => {
                        const w = (x1 - x0) / Math.max(1, n - 1);
                        return (
                            <rect
                                key={d.date}
                                x={x(i) - w / 2}
                                y={BOX.top}
                                width={w}
                                height={BOX.h - BOX.top - BOX.bottom}
                                fill="transparent"
                                onMouseEnter={() => setActive(i)}
                            />
                        );
                    })}
                </svg>
            )}
            {a && active != null && (
                <ChartTooltip x={x(active) + 4} xLeft={x(active) - 4} top={BOX.top} width={width} title={dateLong(a.date)} rows={rows} />
            )}
        </ChartFrame>
    );
}
