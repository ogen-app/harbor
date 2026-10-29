"use client";

import { useMemo } from "react";
import { vendorColors } from "@/components/charts/colors";
import { useChartKeyboard, useElementWidth } from "@/components/charts/hooks";
import { ChartTooltip, Legend, XLabel, YGrid, type TooltipRow } from "@/components/charts/primitives";
import { axisUSD, linear, niceScale } from "@/components/charts/scale";
import { dateLong, isoDate, monthShort, parseDate, usd } from "./format";
import type { Credits } from "./creditTypes";

const MICROS = 1_000_000;
const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const AMBER = "#8A5A00";
const MUTED = "#6F6A63";
const BOX = { h: 300, top: 18, bottom: 40, left: 60, right: 96 };

function shortDay(date: string): string {
  const d = parseDate(date);
  return `${monthShort(d)} ${d.getUTCDate()}`;
}

function daysBetween(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / DAY_MS);
}

// The chart reaches past today to the end of next month, so the projection
// and a near run-out date show.
function domainEnd(today: string): string {
  const t = parseDate(today);
  return isoDate(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 2, 0)));
}

// CreditBalanceChart (CON-435, chart style revision 2): each AI vendor's daily
// credit balance. It steps up on a top-up (a triangle on the axis marks the
// forwarded receipt) and slopes down with usage; the dashed line projects the
// last 7 days' rate to $0, where a marker gives the run-out date.
export function CreditBalanceChart({ data }: { data: Credits }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const { series, today } = data;
  const days = series.days;
  const n = days.length;
  const { active, setActive, onKeyDown, onBlur } = useChartKeyboard(n);
  const colors = useMemo(() => vendorColors(series.vendors.map((v) => v.vendorId)), [series.vendors]);
  const lines = series.vendors.filter((v) => v.balances.some((b) => b != null));

  const end = domainEnd(today);
  const span = Math.max(1, daysBetween(series.from, end));
  const x0 = BOX.left;
  const x1 = Math.max(x0 + 1, width - BOX.right);
  const xd = (date: string) => x0 + (daysBetween(series.from, date) / span) * (x1 - x0);
  const xi = (i: number) => xd(days[i]);

  const values = lines.flatMap((v) => v.balances.filter((b): b is number => b != null).map((b) => b / MICROS));
  const scale = niceScale(Math.min(0, ...values), Math.max(0, ...values), 4);
  const y = linear([scale.min, scale.max], [BOX.h - BOX.bottom, BOX.top]);
  const yM = (m: number) => y(m / MICROS);

  // A balance path that rises straight up on a top-up day, so the step reads
  // as a purchase rather than a day of negative usage.
  const path = (v: Credits["series"]["vendors"][number]) => {
    const topUpOn = new Map<string, number>();
    for (const t of v.topUps) topUpOn.set(t.date, (topUpOn.get(t.date) ?? 0) + t.amountMicros);
    let d = "";
    let pen = false;
    v.balances.forEach((b, i) => {
      if (b == null) {
        pen = false;
        return;
      }
      const up = topUpOn.get(days[i]);
      if (pen && up) d += ` L${xi(i)},${yM(b - up)}`;
      d += `${pen ? " L" : "M"}${xi(i)},${yM(b)}`;
      pen = true;
    });
    return d;
  };

  // The projection, clipped at the right edge when the run-out is later.
  const projections = lines.flatMap((v) => {
    const p = v.projection;
    if (!p || p.rateMicros <= 0) return [];
    const runOut = p.runOutDate;
    const clipped = runOut > end;
    const endDate = clipped ? end : runOut;
    const endBal = clipped ? p.startMicros - p.rateMicros * daysBetween(p.from, end) : 0;
    return [{ v, p, endDate, endBal: Math.max(0, endBal), clipped }];
  });

  // Only a vendor under its alert gets a "runs out" label; the others keep
  // the marker, so labels never pile up at the edge.
  const below = new Set(data.vendors.filter((v) => v.belowAlert).map((v) => v.vendorId));
  const flaggedOrder = projections.filter((x) => below.has(x.v.vendorId)).map((x) => x.v.vendorId);

  const monthTicks = (() => {
    const out: string[] = [];
    const s = parseDate(series.from);
    for (let m = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + (s.getUTCDate() > 1 ? 1 : 0), 1)); isoDate(m) <= end; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
      out.push(isoDate(m));
    }
    if (daysBetween(out[out.length - 1] ?? series.from, end) > 6) out.push(end);
    return out;
  })();

  // End labels at today, kept apart when two balances end close together.
  const endLabels = (() => {
    const raw = lines
      .map((v) => ({ v, b: v.balances[n - 1] }))
      .filter((e): e is { v: typeof e.v; b: number } => e.b != null)
      .map((e) => ({ ...e, y: yM(e.b) }))
      .sort((a, b) => a.y - b.y);
    for (let i = 1; i < raw.length; i++) if (raw[i].y - raw[i - 1].y < 18) raw[i].y = raw[i - 1].y + 18;
    return raw;
  })();

  const xToday = xd(today);
  const a = active != null ? days[active] : null;
  const aRows: TooltipRow[] = a
    ? [
        ...lines
          .filter((v) => v.balances[active!] != null)
          .map((v) => ({ label: v.name, value: usd(v.balances[active!]!), color: colors.get(v.vendorId) })),
        ...lines.flatMap((v) =>
          v.topUps
            .filter((t) => t.date === a)
            .map((t) => ({ label: `Top-up · ${v.name}`, value: usd(t.amountMicros, "always") })),
        ),
      ]
    : [];

  const summary = lines.length
    ? [
        "Credit balance by vendor over the last 90 days.",
        ...lines.map((v) => {
          const b = v.balances[n - 1];
          const p = v.projection;
          return `${v.name} ${b != null ? usd(b) : "no balance"} today${p ? `, runs out about ${dateLong(p.runOutDate)}` : ""}.`;
        }),
        "Use the arrow keys to read each day.",
      ].join(" ")
    : "No credit balance yet: enter each vendor's opening balance in Alert settings.";

  if (lines.length === 0) {
    return (
      <p className="py-10 text-center text-[13px] text-secondary-foreground">
        No balance to draw yet. Enter each vendor’s opening balance in Alert settings.
      </p>
    );
  }

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
      className="space-y-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
        <Legend
          items={[
            ...lines.map((v) => ({ label: v.name, color: colors.get(v.vendorId)! })),
            { label: "Projection", color: MUTED, kind: "line" as const },
          ]}
        />
        <span className="inline-flex items-center gap-1.5 text-xs text-secondary-foreground">
          <svg width="10" height="9" aria-hidden>
            <path d="M5 0 L10 9 L0 9 Z" fill={MUTED} />
          </svg>
          top-up from a forwarded receipt
        </span>
      </div>

      {width > 0 && (
        <div className="relative">
          <svg width={width} height={BOX.h} className="block select-none" aria-hidden>
            <YGrid scale={scale} y={y} x0={x0} x1={x1} format={axisUSD} />

            {/* Today divider */}
            <line x1={xToday} x2={xToday} y1={BOX.top - 6} y2={BOX.h - BOX.bottom} stroke={MUTED} strokeDasharray="2 3" />
            <text x={xToday} y={BOX.top - 8} textAnchor="middle" fill={MUTED} className="text-[11px] font-medium">
              Today
            </text>

            {projections.map(({ v, p, endDate, endBal }) => (
              <line
                key={`proj-${v.vendorId}`}
                x1={xd(p.from)}
                y1={yM(p.startMicros)}
                x2={xd(endDate)}
                y2={yM(endBal)}
                stroke={colors.get(v.vendorId)}
                strokeWidth={2}
                strokeDasharray="5 4"
              />
            ))}

            {lines.map((v) => (
              <path key={v.vendorId} d={path(v)} fill="none" stroke={colors.get(v.vendorId)} strokeWidth={2.5} strokeLinejoin="round" />
            ))}

            {/* Run-out markers on the $0 line */}
            {projections
              .filter((x) => !x.clipped)
              .map(({ v, endDate }) => {
                const cx = xd(endDate);
                const flip = cx > x1 - 150;
                const flagged = below.has(v.vendorId);
                const i = flaggedOrder.indexOf(v.vendorId);
                return (
                  <g key={`out-${v.vendorId}`}>
                    <circle cx={cx} cy={yM(0)} r={4.5} fill="#FFFFFF" stroke={flagged ? AMBER : colors.get(v.vendorId)} strokeWidth={2} />
                    {flagged && (
                      <text
                        x={cx + (flip ? -8 : 8)}
                        y={yM(0) - 10 - i * 16}
                        textAnchor={flip ? "end" : "start"}
                        fill={AMBER}
                        stroke="#FFFFFF"
                        strokeWidth={3}
                        paintOrder="stroke"
                        className="text-[12px] font-semibold"
                      >
                        {v.name} runs out · {shortDay(endDate)}
                      </text>
                    )}
                  </g>
                );
              })}

            {/* Top-up triangles on the axis */}
            {lines.flatMap((v) =>
              v.topUps.map((t) => {
                const cx = xd(t.date);
                const by = BOX.h - BOX.bottom;
                return <path key={`${v.vendorId}-${t.receiptId}`} d={`M${cx} ${by - 9} L${cx + 5} ${by} L${cx - 5} ${by} Z`} fill={colors.get(v.vendorId)} />;
              }),
            )}

            {active != null && (
              <g>
                <line x1={xi(active)} x2={xi(active)} y1={BOX.top} y2={BOX.h - BOX.bottom} stroke={MUTED} strokeDasharray="2 3" />
                {lines.map((v) =>
                  v.balances[active] != null ? (
                    <circle key={v.vendorId} cx={xi(active)} cy={yM(v.balances[active]!)} r={4} fill={colors.get(v.vendorId)} stroke="#FFFFFF" strokeWidth={1.5} />
                  ) : null,
                )}
              </g>
            )}

            {endLabels.map(({ v, b, y: ly }) => (
              <g key={`end-${v.vendorId}`}>
                <circle cx={xToday} cy={yM(b)} r={4} fill={colors.get(v.vendorId)} />
                <text x={x1 + 10} y={ly} dy="0.32em" fill="#1C1C1C" className="text-[12px] font-semibold tabular-nums">
                  {usd(b)}
                </text>
              </g>
            ))}

            {monthTicks.map((d, i) => (
              <XLabel key={d} x={xd(d)} y={BOX.h - BOX.bottom + 24} anchor={i === 0 ? "start" : d === end ? "end" : "middle"}>
                {shortDay(d)}
              </XLabel>
            ))}

            {days.map((d, i) => {
              const w = (x1 - x0) / span;
              return (
                <rect
                  key={d}
                  x={xi(i) - w / 2}
                  y={BOX.top}
                  width={w}
                  height={BOX.h - BOX.top - BOX.bottom}
                  fill="transparent"
                  onMouseEnter={() => setActive(i)}
                />
              );
            })}
          </svg>
          {a && active != null && aRows.length > 0 && (
            <ChartTooltip
              x={xi(active) + 4}
              xLeft={xi(active) - 4}
              top={BOX.top + 20}
              width={width}
              title={`${WEEKDAYS[parseDate(a).getUTCDay()]}, ${shortDay(a)}`}
              rows={aRows}
            />
          )}
        </div>
      )}

      <p className="sr-only" aria-live="polite">
        {a ? [`${dateLong(a)}`, ...aRows.map((r) => `${r.label} ${r.value}`)].join(", ") : ""}
      </p>
    </div>
  );
}
