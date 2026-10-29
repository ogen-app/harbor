"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { api, monthLong } from "./format";
import { PnlDailyChart } from "./PnlDailyChart";
import { PnlMonthlyChart } from "./PnlMonthlyChart";
import { ErrorLine, SkeletonBar } from "./shared";
import type { PnlDaily, PnlMonthly } from "./types";

type View = "monthly" | "daily";
const VIEWS: { key: View; label: string }[] = [
  { key: "monthly", label: "Monthly" },
  { key: "daily", label: "Daily" },
];
const STORAGE_KEY = "harbor.pnl.chartView";

function storedView(): View {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "daily" ? "daily" : "monthly";
  } catch {
    return "monthly";
  }
}

// PnlChartCard (CON-431) sits between the summary strip and the Monthly P&L
// table. Monthly draws the table's own response, so the two always agree;
// Daily reads the last month of the range. Each viewer's choice is kept.
export function PnlChartCard({
  monthly,
  lastMonth,
  version,
}: {
  monthly: PnlMonthly;
  lastMonth: string;
  version: number;
}) {
  const [view, setView] = useState<View>("monthly");
  useEffect(() => {
    // localStorage only exists in the browser, so read it after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setView(storedView());
  }, []);
  const choose = (v: View) => {
    setView(v);
    try {
      window.localStorage.setItem(STORAGE_KEY, v);
    } catch {
      // Private mode or blocked storage: the choice just isn't remembered.
    }
  };

  const [daily, setDaily] = useState<PnlDaily | null>(null);
  const [dailyError, setDailyError] = useState<string | null>(null);
  useEffect(() => {
    if (view !== "daily") return;
    const controller = new AbortController();
    api<PnlDaily>(`/api/pnl/daily?month=${lastMonth}`, { signal: controller.signal })
      .then((d) => {
        setDaily(d);
        setDailyError(null);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setDailyError(e instanceof Error ? e.message : "The daily view could not be loaded");
      });
    return () => controller.abort();
  }, [view, lastMonth, version]);
  const dailyReady = daily && daily.month === lastMonth ? daily : null;

  const revenueAvailable = view === "monthly" ? monthly.revenueAvailable : dailyReady?.revenueAvailable ?? true;
  const revenueError = view === "monthly" ? monthly.revenueError : dailyReady?.revenueError ?? "";

  return (
    <section className="rounded-[3px] border border-border bg-primary px-6 py-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-[15px] font-semibold">
            {view === "monthly"
              ? "Revenue, expenses and profit"
              : `Daily burn · ${dailyReady?.period.label ?? monthLong(lastMonth).split(" ")[0]}`}
          </h2>
          <p className="text-[13px] text-secondary-foreground">
            {view === "monthly"
              ? "Net revenue next to expenses stacked by vendor. The line is profit. One axis, USD."
              : "Two charts, one axis each: running totals on top, the daily AI cost that drives them below."}
          </p>
        </div>
        <ViewSwitch value={view} onChange={choose} />
      </div>

      {!revenueAvailable && (
        <p className="mb-4 text-[13px] text-secondary-foreground">
          Revenue unavailable: {revenueError || "payments have not been synced yet"}. Expenses are shown; profit is hidden until revenue syncs.
        </p>
      )}

      {view === "monthly" ? (
        <PnlMonthlyChart data={monthly} />
      ) : dailyError ? (
        <ErrorLine>{dailyError}</ErrorLine>
      ) : dailyReady ? (
        <PnlDailyChart data={dailyReady} />
      ) : (
        <div className="space-y-3 py-2" aria-busy>
          <SkeletonBar className="h-[300px] w-full" />
          <SkeletonBar className="h-[260px] w-full" />
        </div>
      )}
    </section>
  );
}

// ViewSwitch is a two-option segmented control (a radio group: ←/→ move).
function ViewSwitch({ value, onChange }: { value: View; onChange: (v: View) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = (i + (e.key === "ArrowRight" ? 1 : VIEWS.length - 1)) % VIEWS.length;
    onChange(VIEWS[next].key);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label="Chart period" className="flex shrink-0 rounded-[3px] border border-border bg-secondary p-0.5">
      {VIEWS.map((v, i) => {
        const on = v.key === value;
        return (
          <button
            key={v.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(v.key)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "cursor-pointer rounded-[2px] px-4 py-1.5 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              on ? "border border-border bg-primary font-medium text-foreground" : "border border-transparent text-secondary-foreground hover:text-foreground",
            )}
          >
            {v.label}
          </button>
        );
      })}
    </div>
  );
}
