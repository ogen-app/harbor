"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DateRangePicker, type DateRange } from "@/components/ui/date-range-picker";
import { cn } from "@/lib/utils";
import {
  api,
  dateLong,
  monthEnd,
  monthLabel,
  monthLong,
  monthShort,
  parseDate,
  pct,
  todayUTC,
  usd,
} from "./format";
import { EmptyInbox } from "./EmptyInbox";
import {
  ErrorLine,
  PendingBanner,
  PendingMark,
  SkeletonBar,
  TONE_TEXT,
  pendingSentence,
} from "./shared";
import type { Cell, Drill, MonthlyRow, PnlMonthly, PnlStatus, PnlSummary } from "./types";

// ProfitLossTab is tab 1 (CON-412 mockup 1): month to date against the same
// days of the previous month, the provisional banner while receipts wait in
// Needs attention, and the monthly P&L table. Every amount drills into the
// ledger rows behind it; pending receipts show as "pending" cells and are never
// counted (one aggregation feeds every tab, so figures always agree).
export function ProfitLossTab({
  status,
  range,
  compare,
  onRangeChange,
  version,
  onDrill,
  onReviewAttention,
}: {
  status: PnlStatus | null;
  range: DateRange;
  compare: boolean;
  onRangeChange: (r: DateRange, compare: boolean) => void;
  version: number;
  onDrill: (d: Drill) => void;
  onReviewAttention: () => void;
}) {
  const [summary, setSummary] = useState<PnlSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<PnlSummary>("/api/pnl/summary", { signal: controller.signal })
      .then((s) => {
        setSummary(s);
        setSummaryError(null);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setSummaryError(e instanceof Error ? e.message : "Summary unavailable");
      });
    return () => controller.abort();
  }, [version]);

  const stale =
    status && (status.aiUsage.state !== "ok" || status.revenue.state !== "ok") ? status : null;

  return (
    <div className="space-y-4">
      {summaryError ? (
        <ErrorLine>The summary could not be loaded: {summaryError}</ErrorLine>
      ) : (
        <SummaryStrip summary={summary} stale={stale} />
      )}

      {summary?.provisional && summary.provisional.count > 0 && (
        <PendingBanner onReview={onReviewAttention} reviewLabel={`Review ${summary.provisional.count} receipt${summary.provisional.count === 1 ? "" : "s"} →`}>
          {monthLong(summary.provisional.month).split(" ")[0]} is provisional.{" "}
          {pendingSentence(summary.provisional.count, summary.provisional.amountMicros)}{" "}
          {summary.provisional.count === 1 ? "is" : "are"} waiting in Needs attention and{" "}
          {summary.provisional.count === 1 ? "isn’t" : "aren’t"} counted yet.
        </PendingBanner>
      )}

      <MonthlyCard
        status={status}
        range={range}
        compare={compare}
        onRangeChange={onRangeChange}
        version={version}
        onDrill={onDrill}
      />
    </div>
  );
}

// ── summary strip ────────────────────────────────────────────────────────────

// SummaryStrip is one white card split into five equal cells: no gaps, no
// dividers, no icons and no bold (Appendix A.4).
function SummaryStrip({ summary, stale }: { summary: PnlSummary | null; stale: PnlStatus | null }) {
  const caption = summary
    ? `${summary.period.label} vs ${summary.compare.label}`
    : "Month to date";
  const asOf =
    stale && stale.aiUsage.throughDate
      ? ` · as of ${dateLong(stale.aiUsage.throughDate)}`
      : "";
  return (
    <section aria-label="Month to date" className="space-y-1.5">
      <p className="text-right text-xs text-secondary-foreground">
        {caption}
        {asOf}
      </p>
      <div className="grid grid-cols-2 rounded-[3px] border border-border bg-primary md:grid-cols-5">
        {summary ? (
          <>
            <NetRevenueCell s={summary} />
            <SummaryCell
              label="Expenses"
              value={usd(summary.expenses.value)}
              tone={TONE_TEXT.negative}
              change={change(summary.expenses.value, summary.expenses.previous, "down", usd(summary.expenses.previous))}
            />
            <ProfitCell s={summary} />
            <MarginCell s={summary} />
            <SummaryCell
              label="Prepaid AI credits"
              value={usd(summary.prepaidCredits.value)}
              tone={TONE_TEXT.pending}
              note="Not in P&L · Anthropic + Google"
            />
          </>
        ) : (
          Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="space-y-3 px-6 py-5">
              <SkeletonBar className="w-24" />
              <SkeletonBar className="h-7 w-32" />
              <SkeletonBar className="w-28" />
            </div>
          ))
        )}
      </div>
    </section>
  );
}

type Change = { arrow: "↑" | "↓" | ""; text: string; favourable: boolean | null; vs: string };

// change describes value against previous: the arrow, the relative change and
// whether it is good news (`good` says which direction is favourable).
function change(value: number, previous: number, good: "up" | "down", vs: string): Change {
  if (previous === 0) {
    return { arrow: value > 0 ? "↑" : value < 0 ? "↓" : "", text: value === 0 ? "no change" : "new", favourable: null, vs };
  }
  const delta = (value - previous) / Math.abs(previous);
  const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "";
  const favourable = delta === 0 ? null : (delta > 0) === (good === "up");
  return { arrow, text: `${Math.abs(delta * 100).toFixed(1)}%`, favourable, vs };
}

function SummaryCell({
  label,
  value,
  tone,
  change: c,
  note,
}: {
  label: string;
  value: string;
  tone: string;
  change?: Change | null;
  note?: string;
}) {
  return (
    <div className="min-w-0 px-6 py-5">
      <div className="text-[13px] text-secondary-foreground">{label}</div>
      <div className={cn("mt-1.5 truncate text-[28px] leading-9 font-normal tabular-nums", tone)}>{value}</div>
      <div className="mt-1.5 truncate text-xs tabular-nums">
        {c ? (
          <>
            <span
              className={cn(
                c.favourable === null
                  ? TONE_TEXT.muted
                  : c.favourable
                    ? TONE_TEXT.positive
                    : TONE_TEXT.negative,
              )}
            >
              {c.arrow && `${c.arrow} `}
              {c.text}
            </span>
            <span className="text-secondary-foreground"> vs {c.vs}</span>
          </>
        ) : (
          <span className="text-secondary-foreground">{note ?? " "}</span>
        )}
      </div>
    </div>
  );
}

function NetRevenueCell({ s }: { s: PnlSummary }) {
  const { value, previous } = s.netRevenue;
  if (value == null) {
    return <SummaryCell label="Net revenue" value="unavailable" tone={TONE_TEXT.muted} note="Payments could not be read" />;
  }
  return (
    <SummaryCell
      label="Net revenue"
      value={usd(value)}
      tone={value < 0 ? TONE_TEXT.negative : TONE_TEXT.positive}
      change={previous == null ? null : change(value, previous, "up", usd(previous))}
      note="No earlier period to compare"
    />
  );
}

function ProfitCell({ s }: { s: PnlSummary }) {
  const { value, previous } = s.profit;
  if (value == null) {
    return <SummaryCell label="Profit" value="unavailable" tone={TONE_TEXT.muted} note="Needs revenue" />;
  }
  return (
    <SummaryCell
      label={value < 0 ? "Loss" : "Profit"}
      value={usd(value, "always")}
      tone={value < 0 ? TONE_TEXT.negative : TONE_TEXT.positive}
      change={previous == null ? null : change(value, previous, "up", usd(previous, "always"))}
      note="No earlier period to compare"
    />
  );
}

function MarginCell({ s }: { s: PnlSummary }) {
  const { value, previous } = s.marginPct;
  if (value == null) {
    return <SummaryCell label="Margin" value="—" tone={TONE_TEXT.muted} note="No net revenue yet" />;
  }
  let c: Change | null = null;
  if (previous != null) {
    const d = value - previous;
    c = {
      arrow: d > 0 ? "↑" : d < 0 ? "↓" : "",
      text: `${Math.abs(d).toFixed(1)} pts`,
      favourable: d === 0 ? null : d > 0,
      vs: pct(previous),
    };
  }
  return <SummaryCell label="Margin" value={pct(value)} tone={TONE_TEXT.margin} change={c} note="No earlier period to compare" />;
}

// ── monthly table ────────────────────────────────────────────────────────────

const SECTION_TITLE: Record<MonthlyRow["section"], string> = {
  revenue: "Revenue",
  expenses: "Expenses",
  profit: "",
  memo: "Memo · prepaid AI credits bought",
};

function monthsBetween(range: DateRange): string[] {
  const a = parseDate(range.from);
  const b = parseDate(range.to);
  const out: string[] = [];
  for (let d = a; d <= b; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

// previousPeriod is the same number of whole months just before the range.
function previousPeriod(months: string[]): { from: string; to: string } {
  const first = parseDate(months[0]);
  const n = months.length;
  const from = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() - n, 1));
  const to = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() - 1, 1));
  return { from: from.toISOString().slice(0, 7), to: to.toISOString().slice(0, 7) };
}

function MonthlyCard({
  status,
  range,
  compare,
  onRangeChange,
  version,
  onDrill,
}: {
  status: PnlStatus | null;
  range: DateRange;
  compare: boolean;
  onRangeChange: (r: DateRange, compare: boolean) => void;
  version: number;
  onDrill: (d: Drill) => void;
}) {
  const [data, setData] = useState<PnlMonthly | null>(null);
  const [prev, setPrev] = useState<PnlMonthly | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const months = useMemo(() => monthsBetween(range), [range]);

  useEffect(() => {
    // The picker never yields an inverted range; an empty one is still not a
    // reason to throw inside an effect.
    if (months.length === 0) return;
    const controller = new AbortController();
    const from = months[0];
    const to = months[months.length - 1];
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    if (!compare) setPrev(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    const main = api<PnlMonthly>(`/api/pnl/monthly?from=${from}&to=${to}`, { signal: controller.signal });
    const p = previousPeriod(months);
    const before = compare
      ? api<PnlMonthly>(`/api/pnl/monthly?from=${p.from}&to=${p.to}`, { signal: controller.signal })
      : Promise.resolve(null);
    Promise.all([main, before])
      .then(([m, b]) => {
        setData(m);
        setPrev(b);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "The P&L could not be loaded");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [months, compare, version]);

  const empty =
    data &&
    data.provisional.length === 0 &&
    data.rows.every((r) => r.kind === "margin" || r.cells.every((c) => c.value == null || c.value === 0));

  return (
    <section className="overflow-hidden rounded-[3px] border border-border bg-primary">
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 className="text-[15px] font-semibold">Monthly P&amp;L</h2>
          <p className="text-[13px] text-secondary-foreground">
            USD. Receipts count on their invoice date, AI usage on the day it happened. Click an amount to see its entries.
          </p>
        </div>
        <DateRangePicker
          value={range}
          compare={compare}
          mode="month"
          onChange={onRangeChange}
        />
      </div>

      {error ? (
        <div className="border-t border-border px-6 py-5">
          <ErrorLine>{error}</ErrorLine>
        </div>
      ) : !data || (loading && !data) ? (
        <MonthlySkeleton months={months} />
      ) : empty ? (
        <div className="border-t border-border">
          <EmptyInbox status={status} title={`Nothing booked for ${monthLabel(months[0])} – ${monthLabel(months[months.length - 1])} yet`} />
        </div>
      ) : (
        <div className={cn("overflow-x-auto border-t border-border transition-opacity", loading && "opacity-60")}>
          <MonthlyTable data={data} prev={prev} onDrill={onDrill} />
        </div>
      )}
    </section>
  );
}

// Column header: "MAY", or "OCT 1–26" for the month in progress.
function monthHeader(month: string): string {
  const d = parseDate(month);
  const t = todayUTC();
  const short = monthShort(d).toUpperCase();
  if (month === t.toISOString().slice(0, 7) && monthEnd(month) !== t.toISOString().slice(0, 10)) {
    return `${short} 1–${t.getUTCDate()}`;
  }
  return short;
}

const NUM = "px-4 text-right tabular-nums whitespace-nowrap";

function MonthlyTable({
  data,
  prev,
  onDrill,
}: {
  data: PnlMonthly;
  prev: PnlMonthly | null;
  onDrill: (d: Drill) => void;
}) {
  const prevTotals = useMemo(() => {
    const m = new Map<string, Cell>();
    prev?.rows.forEach((r) => m.set(r.key, r.total));
    return m;
  }, [prev]);
  const cols = data.months.length + 1 + (prev ? 2 : 0);

  return (
    <table className="w-full min-w-max border-collapse text-[13px]">
      <thead>
        <tr className="h-[34px] bg-table-header text-[11px] uppercase tracking-[0.06em] text-secondary-foreground">
          <th scope="col" className="w-56 px-6 text-left font-medium">
            <span className="sr-only">Line</span>
          </th>
          <th scope="col" className="w-36 px-4 text-left font-medium">
            <span className="sr-only">Source</span>
          </th>
          {data.months.map((m) => (
            <th key={m} scope="col" className={cn(NUM, "min-w-28 font-medium")}>
              {monthHeader(m)}
            </th>
          ))}
          <th scope="col" className={cn(NUM, "min-w-28 font-medium")}>
            Total
          </th>
          {prev && (
            <>
              <th scope="col" className={cn(NUM, "min-w-28 font-medium")}>
                Previous {prev.months.length} mo
              </th>
              <th scope="col" className={cn(NUM, "min-w-24 pr-6 font-medium")}>
                Change
              </th>
            </>
          )}
        </tr>
      </thead>
      <tbody>
        {data.rows.map((row, i) => {
          const lastSection = data.rows[i - 1]?.section ?? "";
          const header = row.section !== lastSection && SECTION_TITLE[row.section];
          const memoStart = row.section === "memo" && lastSection !== "memo";
          return (
            <Fragment key={row.key}>
              {header && (
                <tr className={cn(memoStart && "border-t border-dashed border-senary")}>
                  <th
                    scope="rowgroup"
                    colSpan={memoStart ? 2 : cols + 2}
                    className="h-11 px-6 pt-3 text-left align-bottom text-[11px] font-medium uppercase tracking-[0.06em] text-secondary-foreground"
                  >
                    {header}
                  </th>
                  {memoStart && (
                    <td colSpan={cols} className="h-11 px-4 pt-3 align-bottom text-[13px] text-secondary-foreground">
                      Cash paid upfront. Not an expense: the AI usage rows above are.
                    </td>
                  )}
                </tr>
              )}
              <MonthlyRowView row={row} months={data.months} prevTotal={prev ? prevTotals.get(row.key) ?? null : undefined} onDrill={onDrill} />
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function MonthlyRowView({
  row,
  months,
  prevTotal,
  onDrill,
}: {
  row: MonthlyRow;
  months: string[];
  prevTotal: Cell | null | undefined;
  onDrill: (d: Drill) => void;
}) {
  const isProfit = row.section === "profit" && row.kind === "total";
  const isTotal = row.kind === "total";
  const deducted = row.key === "fees" || row.key === "refunds" || row.key === "tax";
  return (
    <tr
      className={cn(
        "border-t border-border",
        isProfit ? "h-12 bg-secondary text-[15px]" : "h-9",
        row.kind === "margin" && "text-secondary-foreground",
      )}
    >
      <th
        scope="row"
        className={cn(
          "px-6 text-left font-normal whitespace-nowrap",
          deducted && "pl-10",
          isTotal && "font-semibold",
        )}
      >
        {row.label}
      </th>
      <td className="px-4 text-left whitespace-nowrap text-secondary-foreground">{row.sourceLabel}</td>
      {row.cells.map((cell, i) => (
        <MonthCell key={months[i]} row={row} cell={cell} month={months[i]} onDrill={onDrill} />
      ))}
      <MonthCell row={row} cell={row.total} month="" onDrill={onDrill} />
      {prevTotal !== undefined && (
        <>
          <td className={NUM}>{prevTotal ? <Figure row={row} cell={prevTotal} /> : "—"}</td>
          <td className={cn(NUM, "pr-6")}>
            <ChangeFigure row={row} now={row.total} before={prevTotal} />
          </td>
        </>
      )}
    </tr>
  );
}

// Figure formats one cell's value for its row kind.
function Figure({ row, cell }: { row: MonthlyRow; cell: Cell }) {
  if (cell.unavailable) return <span className="text-secondary-foreground">unavailable</span>;
  if (cell.value == null) return <span className="text-secondary-foreground">—</span>;
  if (row.kind === "margin") return <>{pct(cell.value)}</>;
  if (row.section === "profit") {
    return (
      <span className={cn("font-semibold", cell.value < 0 ? TONE_TEXT.negative : TONE_TEXT.positive)}>
        {usd(cell.value, "always")}
      </span>
    );
  }
  return <span className={cn(row.kind === "total" && "font-semibold")}>{usd(cell.value)}</span>;
}

function ChangeFigure({ row, now, before }: { row: MonthlyRow; now: Cell; before: Cell | null }) {
  if (!before || now.value == null || before.value == null || now.unavailable || before.unavailable) {
    return <span className="text-secondary-foreground">—</span>;
  }
  const d = now.value - before.value;
  if (d === 0) return <span className="text-secondary-foreground">no change</span>;
  const arrow = d > 0 ? "↑" : "↓";
  const text = row.kind === "margin" ? `${Math.abs(d).toFixed(1)} pts` : usd(Math.abs(d));
  return (
    <span className="text-foreground">
      {arrow} {text}
    </span>
  );
}

// provenanceLine: "30 daily rows · 4 models · 27 tenants".
function provenanceLine(cell: Cell, row: MonthlyRow): string {
  const p = cell.provenance;
  const parts: string[] = [];
  if (p.receipts) parts.push(`${p.receipts} receipt${p.receipts === 1 ? "" : "s"}`);
  if (p.payments) parts.push(`${p.payments} payment${p.payments === 1 ? "" : "s"}`);
  if (!p.receipts && !p.payments && p.rows) {
    parts.push(`${p.rows} ${row.sourceLabel === "AI usage" ? "daily " : ""}row${p.rows === 1 ? "" : "s"}`);
  }
  if (p.models) parts.push(`${p.models} model${p.models === 1 ? "" : "s"}`);
  if (p.tenants) parts.push(`${p.tenants} tenant${p.tenants === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function MonthCell({
  row,
  cell,
  month,
  onDrill,
}: {
  row: MonthlyRow;
  cell: Cell;
  month: string;
  onDrill: (d: Drill) => void;
}) {
  const drill = cell.drill;
  const pending = cell.pending && cell.pending.count > 0 ? cell.pending : null;
  const when = month ? monthLabel(month) : "Total";

  const body =
    cell.value == null && pending && !cell.unavailable ? (
      <PendingMark />
    ) : (
      <span className="inline-flex items-center justify-end gap-1.5">
        {pending && <PendingMark label="" />}
        <Figure row={row} cell={cell} />
      </span>
    );

  const pendingNote = pending
    ? `${pendingSentence(pending.count, pending.amountMicros)} pending in Needs attention, not counted`
    : "";

  if (!drill || cell.value == null || cell.unavailable) {
    return (
      <td className={cn(NUM, row.section === "profit" && "text-[15px]")}>
        {pending ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="outline-none focus-visible:underline">
                {body}
              </span>
            </TooltipTrigger>
            <TooltipContent className="bg-foreground text-primary">{pendingNote}</TooltipContent>
          </Tooltip>
        ) : (
          body
        )}
      </td>
    );
  }

  const prov = provenanceLine(cell, row);
  const value = row.kind === "margin" ? pct(cell.value) : usd(cell.value, row.section === "profit" ? "always" : "auto");
  return (
    <td className={cn("p-0", row.section === "profit" && "text-[15px]")}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => onDrill(drill)}
            aria-label={`${row.label}, ${when}: ${value}. Open its entries in the ledger`}
            className={cn(
              NUM,
              "flex h-9 w-full cursor-pointer items-center justify-end outline-none",
              "hover:bg-table-row-hover focus-visible:outline-[1.5px] focus-visible:-outline-offset-[1.5px] focus-visible:outline-foreground",
              row.section === "profit" && "h-12",
            )}
          >
            {body}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="border-0 bg-foreground px-3 py-2 text-primary">
          <div className="font-semibold">
            {row.label} · {when} · {value}
          </div>
          {prov && <div>{prov}</div>}
          {pendingNote && <div>{pendingNote}</div>}
          <div className="text-primary/80">Enter to open in Ledger</div>
        </TooltipContent>
      </Tooltip>
    </td>
  );
}

function MonthlySkeleton({ months }: { months: string[] }) {
  return (
    <div className="overflow-x-auto border-t border-border" aria-busy>
      <table className="w-full min-w-max border-collapse text-[13px]">
        <thead>
          <tr className="h-[34px] bg-table-header text-[11px] uppercase tracking-[0.06em] text-secondary-foreground">
            <th className="w-56 px-6" />
            <th className="w-36 px-4" />
            {months.map((m) => (
              <th key={m} className={cn(NUM, "min-w-28 font-medium")}>
                {monthHeader(m)}
              </th>
            ))}
            <th className={cn(NUM, "min-w-28 font-medium")}>Total</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 10 }, (_, r) => (
            <tr key={r} className="h-9 border-t border-border">
              <td className="px-6">
                <SkeletonBar className="w-32" />
              </td>
              <td className="px-4">
                <SkeletonBar className="w-16" />
              </td>
              {[...months, "total"].map((m) => (
                <td key={m} className="px-4">
                  <SkeletonBar className="ml-auto w-16" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
