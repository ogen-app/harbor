"use client";

import { useEffect, useMemo, useState } from "react";
import type { DateRange } from "@/components/ui/date-range-picker";
import { cn } from "@/lib/utils";
import { api, dateLong, monthLabel, monthLong, parseDate, pct, usd } from "./format";
import { AllocationDrawer } from "./AllocationDrawer";
import { EmptyInbox } from "./EmptyInbox";
import { PnlChartCard } from "./PnlChartCard";
import { MonthlySkeleton, MonthlyTable, monthsBetween } from "./PnlTable";
import {
  ErrorLine,
  PendingBanner,
  SkeletonBar,
  SummaryCell,
  TONE_TEXT,
  change,
  pendingSentence,
  type Change,
} from "./shared";
import type { Drill, PnlMonthly, PnlStatus, PnlSummary } from "./types";

// ProfitLossTab is tab 1 (CON-412 mockup 1): month to date against the same
// days of the previous month, the provisional banner while receipts wait in
// Needs attention, and the monthly P&L table. Every amount drills into the
// ledger rows behind it; pending receipts show as "pending" cells and are never
// counted (one aggregation feeds every tab, so figures always agree).
export function ProfitLossTab({
  status,
  range,
  compare,
  version,
  onDrill,
  onReviewAttention,
}: {
  status: PnlStatus | null;
  range: DateRange;
  compare: boolean;
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

  const monthly = useMonthly(range, version);
  const [rulesOpen, setRulesOpen] = useState(false);

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

      {monthly.data && !monthly.error && !isEmpty(monthly.data) && (
        <PnlChartCard monthly={monthly.data} lastMonth={monthly.months[monthly.months.length - 1]} version={version} />
      )}

      <MonthlyCard
        status={status}
        monthly={monthly}
        compare={compare}
        version={version}
        onDrill={onDrill}
        onSharedRules={() => setRulesOpen(true)}
      />

      {monthly.months.length > 0 && (
        <AllocationDrawer
          open={rulesOpen}
          onClose={() => setRulesOpen(false)}
          month={monthly.months[monthly.months.length - 1]}
          from={monthly.months[0]}
          to={monthly.months[monthly.months.length - 1]}
        />
      )}
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

// previousPeriod is the same number of whole months just before the range.
function previousPeriod(months: string[]): { from: string; to: string } {
  const first = parseDate(months[0]);
  const n = months.length;
  const from = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() - n, 1));
  const to = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() - 1, 1));
  return { from: from.toISOString().slice(0, 7), to: to.toISOString().slice(0, 7) };
}

// useMonthly loads the Monthly P&L once for the range. The chart and the table
// both draw this one response, so they always agree.
function useMonthly(range: DateRange, version: number): MonthlyState {
  const months = useMemo(() => monthsBetween(range), [range]);
  const [data, setData] = useState<PnlMonthly | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // The picker never yields an inverted range; an empty one is still not a
    // reason to throw inside an effect.
    if (months.length === 0) return;
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    api<PnlMonthly>(`/api/pnl/monthly?from=${months[0]}&to=${months[months.length - 1]}`, { signal: controller.signal })
      .then((m) => {
        setData(m);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "The P&L could not be loaded");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [months, version]);

  return { months, data, error, loading };
}

interface MonthlyState {
  months: string[];
  data: PnlMonthly | null;
  error: string | null;
  loading: boolean;
}

function isEmpty(data: PnlMonthly): boolean {
  return (
    data.provisional.length === 0 &&
    data.rows.every((r) => r.kind === "margin" || r.cells.every((c) => c.value == null || c.value === 0))
  );
}

function MonthlyCard({
  status,
  monthly,
  compare,
  version,
  onDrill,
  onSharedRules,
}: {
  status: PnlStatus | null;
  monthly: MonthlyState;
  compare: boolean;
  version: number;
  onDrill: (d: Drill) => void;
  onSharedRules: () => void;
}) {
  const { months, data, loading } = monthly;
  const [prev, setPrev] = useState<PnlMonthly | null>(null);
  const [prevError, setPrevError] = useState<string | null>(null);
  const error = monthly.error ?? prevError;

  // Compare loads the same number of months just before the range.
  useEffect(() => {
    if (!compare || months.length === 0) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setPrev(null);
      setPrevError(null);
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }
    const controller = new AbortController();
    const p = previousPeriod(months);
    api<PnlMonthly>(`/api/pnl/monthly?from=${p.from}&to=${p.to}`, { signal: controller.signal })
      .then((m) => {
        setPrev(m);
        setPrevError(null);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setPrev(null);
        setPrevError(`The comparison period could not be loaded: ${e instanceof Error ? e.message : "request failed"}`);
      });
    return () => controller.abort();
  }, [months, compare, version]);

  const empty = data && isEmpty(data);

  return (
    <section className="overflow-hidden rounded-[3px] border border-border bg-primary">
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 className="text-[15px] font-semibold">Monthly P&amp;L</h2>
          <p className="text-[13px] text-secondary-foreground">
            USD. Receipts count on their invoice date, AI usage on the day it happened. Click an amount to see its entries.
          </p>
        </div>
        <button
          type="button"
          onClick={onSharedRules}
          className="text-[13px] font-medium text-[var(--editable)] underline-offset-2 outline-none hover:underline focus-visible:underline"
        >
          Shared cost rules
        </button>
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
