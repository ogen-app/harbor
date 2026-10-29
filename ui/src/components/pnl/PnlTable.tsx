"use client";

import { Fragment, useMemo } from "react";
import type { DateRange } from "@/components/ui/date-range-picker";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { monthEnd, monthLabel, monthShort, parseDate, pct, todayUTC, usd } from "./format";
import { PendingMark, SkeletonBar, TONE_TEXT, pendingSentence } from "./shared";
import type { Cell, Drill, MonthlyRow } from "./types";

// PnlTable is the month-by-month P&L table shared by /pnl (CON-420) and the
// tenant Profit & loss tab (CON-433): one row per line, one column per month
// plus Total, and optional previous-period columns. Every amount with a drill
// opens its ledger entries; pending receipts show as "pending" cells.

// Sections titles the row groups; a note sits beside the title, and dashed
// sets the group apart (the memo).
export type Sections = Partial<
  Record<MonthlyRow["section"], { title: string; note?: string; dashed?: boolean }>
>;

export const COMPANY_SECTIONS: Sections = {
  revenue: { title: "Revenue" },
  expenses: { title: "Expenses" },
  memo: {
    title: "Memo · prepaid AI credits bought",
    note: "Cash paid upfront. Not an expense: the AI usage rows above are.",
    dashed: true,
  },
};

// monthsBetween lists the "YYYY-MM" months a date range touches.
export function monthsBetween(range: DateRange): string[] {
  const a = parseDate(range.from);
  const b = parseDate(range.to);
  const out: string[] = [];
  for (let d = a; d <= b; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

// Column header: "MAY", or "OCT 1–26" for the month in progress.
export function monthHeader(month: string): string {
  const d = parseDate(month);
  const t = todayUTC();
  const short = monthShort(d).toUpperCase();
  if (month === t.toISOString().slice(0, 7) && monthEnd(month) !== t.toISOString().slice(0, 10)) {
    return `${short} 1–${t.getUTCDate()}`;
  }
  return short;
}

const NUM = "px-4 text-right tabular-nums whitespace-nowrap";

export function MonthlyTable({
  data,
  prev,
  onDrill,
  sections = COMPANY_SECTIONS,
}: {
  data: { months: string[]; rows: MonthlyRow[] };
  prev: { months: string[]; rows: MonthlyRow[] } | null;
  onDrill: (d: Drill) => void;
  sections?: Sections;
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
          const section = row.section !== lastSection ? sections[row.section] : undefined;
          return (
            <Fragment key={row.key}>
              {section?.title && (
                <tr className={cn(section.dashed && "border-t border-dashed border-senary")}>
                  <th
                    scope="rowgroup"
                    colSpan={section.note ? 2 : cols + 2}
                    className="h-11 px-6 pt-3 text-left align-bottom text-[11px] font-medium uppercase tracking-[0.06em] text-secondary-foreground"
                  >
                    {section.title}
                  </th>
                  {section.note && (
                    <td colSpan={cols} className="h-11 px-4 pt-3 align-bottom text-[13px] text-secondary-foreground">
                      {section.note}
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

export function MonthlySkeleton({ months }: { months: string[] }) {
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
