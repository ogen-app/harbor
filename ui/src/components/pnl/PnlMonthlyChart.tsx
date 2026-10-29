"use client";

import { useMemo } from "react";
import { SERIES, TOOLTIP_TONE, vendorColors } from "@/components/charts/colors";
import { useChartKeyboard, useElementWidth } from "@/components/charts/hooks";
import { ChartTooltip, HaloLabel, Legend, XLabel, YGrid, type LegendItem } from "@/components/charts/primitives";
import { axisUSD, compactUSD, linear, niceScale } from "@/components/charts/scale";
import { monthEnd, monthLabel, monthLong, monthShort, parseDate, todayUTC, usd } from "./format";
import type { PnlMonthly } from "./types";

const MICROS = 1_000_000;

export interface MonthPoint {
  month: string;
  net: number | null; // micros; null while revenue is unavailable
  expenses: number;
  profit: number | null;
  vendors: { id: string; value: number }[]; // non-zero spend only, P&L order
  provisional: boolean;
}

export interface MonthlySeries {
  points: MonthPoint[];
  vendors: { id: string; name: string }[]; // spend somewhere in the range
  revenueAvailable: boolean;
}

// toMonthlySeries reads the chart straight off the Monthly P&L table's rows,
// so every bar and point is the table's own cell: the two can't disagree.
export function toMonthlySeries(m: PnlMonthly): MonthlySeries {
  const row = (key: string) => m.rows.find((r) => r.key === key);
  const net = row("net_revenue");
  const exp = row("total_expenses");
  const profit = row("profit");
  const vendorRows = m.rows.filter(
    (r) => r.section === "expenses" && r.kind === "line" && r.vendorId !== "",
  );
  const spent = vendorRows.filter((r) => r.cells.some((c) => (c.value ?? 0) !== 0));
  const provisional = new Set(m.provisional.map((p) => p.month));
  return {
    revenueAvailable: m.revenueAvailable,
    vendors: spent.map((r) => ({ id: r.vendorId, name: r.label })),
    points: m.months.map((month, i) => ({
      month,
      net: m.revenueAvailable ? net?.cells[i].value ?? 0 : null,
      expenses: exp?.cells[i].value ?? 0,
      profit: m.revenueAvailable ? profit?.cells[i].value ?? 0 : null,
      vendors: spent
        .map((r) => ({ id: r.vendorId, value: r.cells[i].value ?? 0 }))
        .filter((v) => v.value !== 0),
      provisional: provisional.has(month),
    })),
  };
}

// "May", "Oct 1–26" for the month in progress, "Jan '27" where a year starts.
function monthTick(month: string, i: number, spansYears: boolean): string {
  const d = parseDate(month);
  const t = todayUTC();
  const iso = t.toISOString();
  if (month === iso.slice(0, 7) && monthEnd(month) !== iso.slice(0, 10)) {
    return `${monthShort(d)} 1–${t.getUTCDate()}`;
  }
  if (spansYears && (i === 0 || d.getUTCMonth() === 0)) {
    return `${monthShort(d)} ’${String(d.getUTCFullYear()).slice(2)}`;
  }
  return monthShort(d);
}

const H = 380;
const PAD = { top: 28, right: 8, bottom: 58, left: 60 };
const FADED = 0.45;

// PnlMonthlyChart (CON-431 mockup 1): per month, net revenue beside expenses
// stacked by vendor, with profit as a line on the same axis.
export function PnlMonthlyChart({ data }: { data: PnlMonthly }) {
  const series = useMemo(() => toMonthlySeries(data), [data]);
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const { active, setActive, onKeyDown, onBlur } = useChartKeyboard(series.points.length);

  const colors = useMemo(() => vendorColors(series.vendors.map((v) => v.id)), [series.vendors]);
  const names = useMemo(() => new Map(series.vendors.map((v) => [v.id, v.name])), [series.vendors]);
  const rev = series.revenueAvailable;
  const pts = series.points;

  const legend: LegendItem[] = [
    ...(rev ? [{ label: "Net revenue", color: SERIES.netRevenue }] : []),
    ...series.vendors.map((v) => ({ label: v.name, color: colors.get(v.id)! })),
    ...(rev ? [{ label: "Profit", color: SERIES.profit, kind: "line" as const }] : []),
  ];

  const values = pts.flatMap((p) => [p.net ?? 0, p.expenses, p.profit ?? 0].map((v) => v / MICROS));
  const scale = niceScale(Math.min(...values, 0), Math.max(...values, 0), 6);
  const x0 = PAD.left;
  const x1 = Math.max(x0 + 1, width - PAD.right);
  const y = linear([scale.min, scale.max], [H - PAD.bottom, PAD.top]);
  const yUSD = (micros: number) => y(micros / MICROS);

  const slot = (x1 - x0) / Math.max(1, pts.length);
  const barW = Math.max(4, Math.min(34, slot * 0.2));
  const gap = Math.max(2, barW * 0.2);
  const center = (i: number) => x0 + slot * (i + 0.5);
  const showLabels = slot >= 64;
  const tickEvery = Math.max(1, Math.ceil(56 / slot));
  const spansYears = pts.length > 0 && pts[0].month.slice(0, 4) !== pts[pts.length - 1].month.slice(0, 4);

  const profitPath = rev
    ? pts.map((p, i) => `${i === 0 ? "M" : "L"}${center(i)},${yUSD(p.profit ?? 0)}`).join(" ")
    : "";

  const describe = (p: MonthPoint) => {
    const parts = [monthLabel(p.month)];
    if (p.net != null) parts.push(`net revenue ${usd(p.net)}`);
    parts.push(...p.vendors.map((v) => `${names.get(v.id)} ${usd(v.value)}`));
    parts.push(`expenses ${usd(p.expenses)}`);
    if (p.profit != null) parts.push(`profit ${usd(p.profit, "always")}`);
    if (p.provisional) parts.push("provisional");
    return parts.join(", ");
  };
  const summary = useMemo(() => {
    if (pts.length === 0) return "No months to chart.";
    const range = `${monthLabel(pts[0].month)} to ${monthLabel(pts[pts.length - 1].month)}`;
    if (!rev) return `Expenses by vendor per month, ${range}. Revenue is unavailable.`;
    const byProfit = [...pts].sort((a, b) => (a.profit ?? 0) - (b.profit ?? 0));
    const lo = byProfit[0];
    const hi = byProfit[byProfit.length - 1];
    return `Net revenue and expenses by vendor per month with a profit line, ${range}. Lowest profit ${usd(lo.profit ?? 0, "always")} in ${monthLabel(lo.month)}, highest ${usd(hi.profit ?? 0, "always")} in ${monthLabel(hi.month)}. Use the arrow keys to read each month; the Monthly P&L table below has every figure.`;
  }, [pts, rev]);

  const a = active != null ? pts[active] : null;

  return (
    <div className="space-y-4">
      <Legend items={legend} />
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
          <svg width={width} height={H} className="block select-none" aria-hidden>
            <YGrid scale={scale} y={y} x0={x0} x1={x1} format={axisUSD} />

            {pts.map((p, i) => {
              const c = center(i);
              const netX = rev ? c - gap / 2 - barW : c - barW / 2;
              const expX = rev ? c + gap / 2 : c - barW / 2;
              const faded = active != null && active !== i;
              let acc = 0;
              return (
                <g key={p.month} opacity={faded ? FADED : 1}>
                  {p.net != null && p.net !== 0 && (
                    <rect
                      x={netX}
                      width={barW}
                      y={Math.min(yUSD(0), yUSD(p.net))}
                      height={Math.abs(yUSD(p.net) - yUSD(0))}
                      fill={SERIES.netRevenue}
                    />
                  )}
                  {p.vendors.map((v) => {
                    const from = acc;
                    acc += v.value;
                    return (
                      <rect
                        key={v.id}
                        x={expX}
                        width={barW}
                        y={Math.min(yUSD(from), yUSD(acc))}
                        height={Math.abs(yUSD(acc) - yUSD(from))}
                        fill={colors.get(v.id)}
                        stroke="#FFFFFF"
                        strokeWidth={0.5}
                      />
                    );
                  })}
                  {showLabels && p.net != null && p.net !== 0 && (
                    <HaloLabel x={netX + barW / 2} y={yUSD(Math.max(0, p.net)) - 7} fill="#1C1C1C">
                      {compactUSD(p.net / MICROS)}
                    </HaloLabel>
                  )}
                  {showLabels && p.expenses !== 0 && (
                    <HaloLabel x={expX + barW / 2} y={yUSD(Math.max(0, p.expenses)) - 7} fill="#1C1C1C">
                      {compactUSD(p.expenses / MICROS)}
                    </HaloLabel>
                  )}
                </g>
              );
            })}

            {active != null && (
              <line
                x1={center(active)}
                x2={center(active)}
                y1={PAD.top}
                y2={H - PAD.bottom}
                stroke="#6F6A63"
                strokeDasharray="2 3"
              />
            )}

            {rev && (
              <g>
                <path d={profitPath} fill="none" stroke={SERIES.profit} strokeWidth={2} strokeLinejoin="round" />
                {pts.map((p, i) => (
                  <g key={p.month}>
                    <circle
                      cx={center(i)}
                      cy={yUSD(p.profit ?? 0)}
                      r={active === i ? 5 : 4}
                      fill={SERIES.profit}
                      stroke="#FFFFFF"
                      strokeWidth={1.5}
                    />
                    {(showLabels || active === i) && (
                      <HaloLabel x={center(i)} y={yUSD(p.profit ?? 0) + 20} fill={SERIES.profit} className="text-[12px]">
                        {compactUSD((p.profit ?? 0) / MICROS, true)}
                      </HaloLabel>
                    )}
                  </g>
                ))}
              </g>
            )}

            {pts.map((p, i) => (
              <g key={p.month}>
                {(i % tickEvery === 0 || p.provisional) && (
                  <XLabel x={center(i)} y={H - PAD.bottom + 24}>
                    {monthTick(p.month, i, spansYears)}
                  </XLabel>
                )}
                {p.provisional && (
                  <g transform={`translate(${center(i)}, ${H - PAD.bottom + 44})`}>
                    <circle cx={-38} cy={-4} r={4.5} fill="none" stroke="#8A5A00" strokeWidth={1.3} />
                    <text x={-28} y={0} fill="#8A5A00" className="text-[12px]">
                      provisional
                    </text>
                  </g>
                )}
                <rect
                  x={x0 + slot * i}
                  y={PAD.top}
                  width={slot}
                  height={H - PAD.top - PAD.bottom}
                  fill="transparent"
                  onMouseEnter={() => setActive(i)}
                />
              </g>
            ))}
          </svg>
        )}

        {a && active != null && (
          <ChartTooltip
            x={center(active) + (rev ? gap / 2 + barW : barW / 2)}
            xLeft={center(active) - (rev ? gap / 2 + barW : barW / 2)}
            top={PAD.top}
            width={width}
            title={`${monthLong(a.month)}${a.provisional ? " · provisional" : ""}`}
            rows={[
              ...(a.net != null ? [{ label: "Net revenue", value: usd(a.net), color: SERIES.netRevenue }] : []),
              ...a.vendors.map((v) => ({ label: names.get(v.id) ?? v.id, value: usd(v.value), color: colors.get(v.id) })),
            ]}
            total={
              a.profit != null
                ? {
                    label: "Profit",
                    value: usd(a.profit, "always"),
                    color: a.profit < 0 ? TOOLTIP_TONE.negative : TOOLTIP_TONE.positive,
                  }
                : { label: "Expenses", value: usd(a.expenses) }
            }
          />
        )}
        <p className="sr-only" aria-live="polite">
          {a ? describe(a) : ""}
        </p>
      </div>
    </div>
  );
}
