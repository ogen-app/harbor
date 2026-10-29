"use client";

import { useMemo } from "react";
import { SERIES, vendorColors } from "@/components/charts/colors";
import { useChartKeyboard, useElementWidth } from "@/components/charts/hooks";
import { ChartTooltip, Legend, XLabel, YGrid } from "@/components/charts/primitives";
import { axisUSD, linear, niceScale } from "@/components/charts/scale";
import { monthShort, parseDate, pct, usd } from "./format";
import type { PnlDaily } from "./types";

const MICROS = 1_000_000;
const FADED = 0.45;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// "Oct 1" (no zero padding, unlike the ledger's dayLabel).
function shortDay(date: string): string {
  const d = parseDate(date);
  return `${monthShort(d)} ${d.getUTCDate()}`;
}

// Day ticks: weekly from the 1st, plus the last day unless a weekly tick is
// too close to it.
function tickDays(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i += 7) if (n - 1 - i >= 3 || i === n - 1) out.push(i);
  if (out[out.length - 1] !== n - 1) out.push(n - 1);
  return out;
}

const TOP = { h: 300, top: 16, bottom: 34, left: 60, right: 200 };
const BOT = { h: 260, top: 12, bottom: 34, left: 60, right: 8 };

// PnlDailyChart (CON-431 mockup 2): the month's running totals with profit as
// the gap between them, and the daily AI cost that drives the expense line.
export function PnlDailyChart({ data }: { data: PnlDaily }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const days = data.days;
  const n = days.length;
  const { active, setActive, onKeyDown, onBlur } = useChartKeyboard(n);
  const rev = data.revenueAvailable;

  const ai = useMemo(() => data.vendors.filter((v) => v.isAiPipeline), [data.vendors]);
  const colors = useMemo(() => vendorColors(data.vendors.map((v) => v.id)), [data.vendors]);
  const names = useMemo(() => new Map(data.vendors.map((v) => [v.id, v.name])), [data.vendors]);

  const { cumRev, cumExp, aiDay } = useMemo(() => {
    let r = 0;
    let e = 0;
    const cumRev: number[] = [];
    const cumExp: number[] = [];
    const aiDay: number[] = [];
    for (const d of days) {
      r += d.netRevenue ?? 0;
      e += d.expenses;
      cumRev.push(r);
      cumExp.push(e);
      aiDay.push(ai.reduce((s, v) => s + (d.expensesByVendor[v.id] ?? 0), 0));
    }
    return { cumRev, cumExp, aiDay };
  }, [days, ai]);

  const receipts = useMemo(
    () => days.flatMap((d) => d.receipts.map((r) => ({ ...r, date: d.date }))),
    [days],
  );
  const aiTotal = aiDay.reduce((s, v) => s + v, 0);
  const topAI = ai
    .map((v) => ({ v, sum: days.reduce((s, d) => s + (d.expensesByVendor[v.id] ?? 0), 0) }))
    .sort((a, b) => b.sum - a.sum)[0];

  // ── running totals ──
  const tx0 = TOP.left;
  const tx1 = Math.max(tx0 + 1, width - TOP.right);
  const xs = (i: number) => (n > 1 ? tx0 + (i * (tx1 - tx0)) / (n - 1) : (tx0 + tx1) / 2);
  const topVals = [...(rev ? cumRev : []), ...cumExp].map((v) => v / MICROS);
  const topScale = niceScale(Math.min(0, ...topVals), Math.max(0, ...topVals), 5);
  const ty = linear([topScale.min, topScale.max], [TOP.h - TOP.bottom, TOP.top]);
  const tyUSD = (m: number) => ty(m / MICROS);
  const line = (vals: number[]) => vals.map((v, i) => `${i === 0 ? "M" : "L"}${xs(i)},${tyUSD(v)}`).join(" ");
  const area = (vals: number[]) =>
    n === 0 ? "" : `${line(vals)} L${xs(n - 1)},${tyUSD(0)} L${xs(0)},${tyUSD(0)} Z`;

  // ── daily AI cost ──
  const bx0 = BOT.left;
  const bx1 = Math.max(bx0 + 1, width - BOT.right);
  const slot = (bx1 - bx0) / Math.max(1, n);
  const barW = Math.max(2, slot * 0.78);
  const bc = (i: number) => bx0 + slot * (i + 0.5);
  const botScale = niceScale(0, Math.max(0, ...aiDay.map((v) => v / MICROS)), 3);
  const by = linear([botScale.min, botScale.max], [BOT.h - BOT.bottom, BOT.top]);
  const byUSD = (m: number) => by(m / MICROS);

  const ticks = tickDays(n);
  const last = n - 1;

  // End labels: keep the two totals apart when the lines end close together.
  const endLabels = (() => {
    if (n === 0) return null;
    const yr = tyUSD(cumRev[last]);
    const ye = tyUSD(cumExp[last]);
    if (!rev) return { yr, ye, yrL: yr, yeL: ye };
    const top = Math.min(yr, ye);
    const bottom = Math.max(yr, ye);
    const mid = (top + bottom) / 2;
    const gap = 76;
    const [tL, bL] = bottom - top >= gap ? [top, bottom] : [mid - gap / 2, mid + gap / 2];
    return yr <= ye ? { yr, ye, yrL: tL, yeL: bL } : { yr, ye, yrL: bL, yeL: tL };
  })();

  const summary =
    n === 0
      ? `Nothing booked yet in ${data.period.label}.`
      : [
          `Daily burn for ${data.period.label}:`,
          rev ? `net revenue ${usd(data.totals.netRevenue ?? 0)} and` : "",
          `expenses ${usd(data.totals.expenses)} to date.`,
          rev && data.totals.profit != null
            ? `Profit ${usd(data.totals.profit, "always")} against ${usd(data.previous.profit ?? 0, "always")} for ${data.compare.label}.`
            : "Revenue is unavailable.",
          ai.length ? `AI cost averaged ${usd(aiTotal / n)} a day.` : "",
          "Use the arrow keys to read each day.",
        ]
          .filter(Boolean)
          .join(" ");

  const a = active != null ? days[active] : null;
  const aTitle = a ? `${WEEKDAYS[parseDate(a.date).getUTCDay()]}, ${shortDay(a.date)}` : "";

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
      className="space-y-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Legend
        items={[
          ...(rev ? [{ label: "Net revenue, running total", color: SERIES.netRevenue, kind: "square" as const }] : []),
          { label: "Expenses, running total", color: SERIES.expenses, kind: "square" as const },
        ]}
      />

      {width > 0 && n > 0 && (
        <svg width={width} height={TOP.h} className="block select-none" aria-hidden>
          <YGrid scale={topScale} y={ty} x0={tx0} x1={tx1} format={axisUSD} />
          {/* Opaque tints: expenses cover revenue, so only the profit gap shows green. */}
          {rev && <path d={area(cumRev)} fill={SERIES.netRevenueTint} />}
          <path d={area(cumExp)} fill={SERIES.expensesTint} />
          {rev && <path d={line(cumRev)} fill="none" stroke={SERIES.netRevenue} strokeWidth={2.5} strokeLinejoin="round" />}
          <path d={line(cumExp)} fill="none" stroke={SERIES.expenses} strokeWidth={2.5} strokeLinejoin="round" />

          {active != null && (
            <g>
              <line x1={xs(active)} x2={xs(active)} y1={TOP.top} y2={TOP.h - TOP.bottom} stroke="#6F6A63" strokeDasharray="2 3" />
              {rev && <circle cx={xs(active)} cy={tyUSD(cumRev[active])} r={4} fill={SERIES.netRevenue} stroke="#FFFFFF" strokeWidth={1.5} />}
              <circle cx={xs(active)} cy={tyUSD(cumExp[active])} r={4} fill={SERIES.expenses} stroke="#FFFFFF" strokeWidth={1.5} />
            </g>
          )}

          {endLabels && (
            <g className="tabular-nums">
              {rev && (
                <>
                  <circle cx={xs(last)} cy={endLabels.yr} r={4} fill={SERIES.netRevenue} />
                  <text x={xs(last) + 14} y={endLabels.yrL} dy="0.32em" fill="#1C1C1C" className="text-[13px] font-semibold">
                    {usd(cumRev[last])}
                  </text>
                </>
              )}
              <circle cx={xs(last)} cy={endLabels.ye} r={4} fill={SERIES.expenses} />
              <text x={xs(last) + 14} y={endLabels.yeL} dy="0.32em" fill="#1C1C1C" className="text-[13px] font-semibold">
                {usd(cumExp[last])}
              </text>
              {rev && data.totals.profit != null && (
                <>
                  <line
                    x1={xs(last) + 6}
                    x2={xs(last) + 6}
                    y1={Math.min(endLabels.yrL, endLabels.yeL) + 12}
                    y2={Math.max(endLabels.yrL, endLabels.yeL) - 12}
                    stroke={SERIES.profit}
                    strokeWidth={1.5}
                  />
                  <text
                    x={xs(last) + 14}
                    y={(endLabels.yrL + endLabels.yeL) / 2 - 7}
                    dy="0.32em"
                    fill={SERIES.profit}
                    className="text-[13px] font-semibold"
                  >
                    Profit {usd(data.totals.profit, "always")}
                  </text>
                  {data.previous.profit != null && (
                    <text
                      x={xs(last) + 14}
                      y={(endLabels.yrL + endLabels.yeL) / 2 + 12}
                      dy="0.32em"
                      fill="#6F6A63"
                      className="text-[12px]"
                    >
                      {data.compare.label}: {usd(data.previous.profit, "always")}
                    </text>
                  )}
                </>
              )}
            </g>
          )}

          {ticks.map((i) => (
            <XLabel key={i} x={xs(i)} y={TOP.h - TOP.bottom + 24}>
              {shortDay(days[i].date)}
            </XLabel>
          ))}
          {days.map((d, i) => (
            <rect
              key={d.date}
              x={n > 1 ? xs(i) - (tx1 - tx0) / (n - 1) / 2 : tx0}
              y={TOP.top}
              width={n > 1 ? (tx1 - tx0) / (n - 1) : tx1 - tx0}
              height={TOP.h - TOP.top - TOP.bottom}
              fill="transparent"
              onMouseEnter={() => setActive(i)}
            />
          ))}
        </svg>
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 pt-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
          <h3 className="text-[15px] font-semibold">Daily AI cost</h3>
          <Legend items={ai.map((v) => ({ label: v.name, color: colors.get(v.id)! }))} />
        </div>
        {receipts.length > 0 && (
          <p className="text-[13px] text-secondary-foreground">
            Receipts land on their invoice day:{" "}
            {receipts
              .slice(0, 4)
              .map((r) => `${names.get(r.vendorId) ?? r.vendorId} ${shortDay(r.date)} (${usd(r.amountMicros)})`)
              .join(", ")}
            {receipts.length > 4 && `, and ${receipts.length - 4} more`}
          </p>
        )}
      </div>

      {ai.length === 0 ? (
        <p className="py-6 text-[13px] text-secondary-foreground">No AI usage booked in {data.period.label}.</p>
      ) : (
        width > 0 && (
          <div className="relative">
            <svg width={width} height={BOT.h} className="block select-none" aria-hidden>
              <YGrid scale={botScale} y={by} x0={bx0} x1={bx1} format={axisUSD} />
              {days.map((d, i) => {
                let acc = 0;
                return (
                  <g key={d.date} opacity={active != null && active !== i ? FADED : 1}>
                    {ai.map((v) => {
                      const val = d.expensesByVendor[v.id] ?? 0;
                      if (val === 0) return null;
                      const from = acc;
                      acc += val;
                      return (
                        <rect
                          key={v.id}
                          x={bc(i) - barW / 2}
                          width={barW}
                          y={Math.min(byUSD(from), byUSD(acc))}
                          height={Math.abs(byUSD(acc) - byUSD(from))}
                          fill={colors.get(v.id)}
                        />
                      );
                    })}
                  </g>
                );
              })}
              {ticks.map((i) => (
                <XLabel key={i} x={bc(i)} y={BOT.h - BOT.bottom + 24}>
                  {shortDay(days[i].date)}
                </XLabel>
              ))}
              {days.map((d, i) => (
                <rect
                  key={d.date}
                  x={bx0 + slot * i}
                  y={BOT.top}
                  width={slot}
                  height={BOT.h - BOT.top - BOT.bottom}
                  fill="transparent"
                  onMouseEnter={() => setActive(i)}
                />
              ))}
            </svg>
            {a && active != null && (
              <ChartTooltip
                x={bc(active) + barW / 2}
                xLeft={bc(active) - barW / 2}
                top={BOT.top}
                width={width}
                title={aTitle}
                rows={ai
                  .filter((v) => (a.expensesByVendor[v.id] ?? 0) !== 0)
                  .map((v) => ({ label: v.name, value: usd(a.expensesByVendor[v.id]), color: colors.get(v.id) }))}
                total={{ label: "AI cost", value: usd(aiDay[active]) }}
              />
            )}
          </div>
        )
      )}

      {ai.length > 0 && n > 0 && (
        <p className="text-right text-[13px] text-secondary-foreground">
          Average {usd(aiTotal / n)} a day
          {topAI && aiTotal > 0 && ` · ${topAI.v.name} ${pct((topAI.sum / aiTotal) * 100, 0)}`}
        </p>
      )}

      <p className="sr-only" aria-live="polite">
        {a
          ? [
              aTitle,
              rev ? `net revenue to date ${usd(cumRev[active!])}` : "",
              `expenses to date ${usd(cumExp[active!])}`,
              `AI cost ${usd(aiDay[active!])}`,
              ...a.receipts.map((r) => `receipt ${names.get(r.vendorId) ?? r.vendorId} ${usd(r.amountMicros)}`),
            ]
              .filter(Boolean)
              .join(", ")
          : ""}
      </p>
    </div>
  );
}

