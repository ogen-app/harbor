"use client";

import { useMemo, useState } from "react";
import { CaretDownIcon } from "@phosphor-icons/react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

// DateRangePicker picks an inclusive range of UTC calendar days (CON-420): a
// trigger reading "May 1, 2026 - Oct 26, 2026", and a popover with a Compare
// toggle, typed start and end dates, two months side by side with a range band,
// presets on the right and Cancel / Update. Nothing changes until Update.
//
// mode="month" is for month-column reports: Update widens the range to whole
// UTC months (the end capped at today), and the footer says how many month
// columns that gives. All dates are "YYYY-MM-DD" strings in UTC.

export interface DateRange {
  from: string;
  to: string;
}

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const SHORT = MONTHS.map((m) => m.slice(0, 3));

const DAY_MS = 86_400_000;

function parse(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function today(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}
function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}
function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function monthEnd(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}
function minDate(a: Date, b: Date): Date {
  return a < b ? a : b;
}
function days(from: string, to: string): number {
  return Math.round((parse(to).getTime() - parse(from).getTime()) / DAY_MS) + 1;
}
function monthCount(from: string, to: string): number {
  const a = parse(from);
  const b = parse(to);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() + 1;
}

// "May 1, 2026"
export function formatRangeDay(isoDay: string): string {
  const d = parse(isoDay);
  return `${SHORT[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// "May 1 – Oct 26, 2026", or with both years when they differ.
export function formatRangeShort(r: DateRange): string {
  const a = parse(r.from);
  const b = parse(r.to);
  const left =
    a.getUTCFullYear() === b.getUTCFullYear()
      ? `${SHORT[a.getUTCMonth()]} ${a.getUTCDate()}`
      : formatRangeDay(r.from);
  return `${left} – ${formatRangeDay(r.to)}`;
}

// "05/01/2026"
function typed(isoDay: string): string {
  const d = parse(isoDay);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
}
function parseTyped(text: string): string | null {
  const m = text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/) ?? text.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = text.includes("/") ? [m[3], m[1], m[2]] : [m[1], m[2], m[3]];
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (date.getUTCMonth() !== Number(mo) - 1) return null;
  return iso(date);
}

// widenToMonths snaps a range to whole UTC months, the end capped at today. A
// range wholly in the future would then start after it ends, so the start is
// clamped to the end's month and the result is never inverted.
export function widenToMonths(r: DateRange): DateRange {
  const to = minDate(monthEnd(parse(r.to)), today());
  const from = minDate(monthStart(parse(r.from)), monthStart(to));
  return { from: iso(from), to: iso(to) };
}

type Preset = { label: string; range: () => DateRange };

function presets(allTimeFrom?: string): Preset[] {
  const t = today();
  const back = (months: number): DateRange => ({
    from: iso(addMonths(t, -(months - 1))),
    to: iso(t),
  });
  const list: Preset[] = [
    { label: "Last 30 days", range: () => ({ from: iso(new Date(t.getTime() - 29 * DAY_MS)), to: iso(t) }) },
    { label: "This month", range: () => ({ from: iso(monthStart(t)), to: iso(t) }) },
    {
      label: "Last month",
      range: () => {
        const s = addMonths(t, -1);
        return { from: iso(s), to: iso(monthEnd(s)) };
      },
    },
    { label: "Last 3 months", range: () => back(3) },
    { label: "Last 6 months", range: () => back(6) },
    { label: "Year to date", range: () => ({ from: `${t.getUTCFullYear()}-01-01`, to: iso(t) }) },
    { label: "Last 12 months", range: () => back(12) },
  ];
  if (allTimeFrom) list.push({ label: "All time", range: () => ({ from: allTimeFrom, to: iso(t) }) });
  return list;
}

export function DateRangePicker({
  value,
  onChange,
  mode = "day",
  compare,
  allTimeFrom,
  className,
}: {
  value: DateRange;
  // compare is only passed back when the Compare toggle is shown.
  onChange: (range: DateRange, compare: boolean) => void;
  mode?: "day" | "month";
  // Shows the Compare toggle (compare with the period just before). Omit to
  // hide it where nothing would use it.
  compare?: boolean;
  // The earliest data date; enables the "All time" preset.
  allTimeFrom?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange>(value);
  const [pickingEnd, setPickingEnd] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [cmp, setCmp] = useState(!!compare);
  const [view, setView] = useState<Date>(() => addMonths(parse(value.to), -1));
  const [fromText, setFromText] = useState(typed(value.from));
  const [toText, setToText] = useState(typed(value.to));
  const presetList = useMemo(() => presets(allTimeFrom), [allTimeFrom]);

  const setRange = (r: DateRange) => {
    const ordered = r.from <= r.to ? r : { from: r.to, to: r.from };
    setDraft(ordered);
    setFromText(typed(ordered.from));
    setToText(typed(ordered.to));
  };

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setDraft(value);
      setFromText(typed(value.from));
      setToText(typed(value.to));
      setCmp(!!compare);
      setPickingEnd(false);
      setView(addMonths(parse(value.to), -1));
    }
    setOpen(next);
  };

  const pickDay = (day: string) => {
    if (!pickingEnd) {
      setRange({ from: day, to: day });
      setPickingEnd(true);
    } else {
      setRange({ from: draft.from, to: day });
      setPickingEnd(false);
    }
  };

  const applied = mode === "month" ? widenToMonths(draft) : draft;
  const activePreset = presetList.find((p) => {
    const r = p.range();
    const pr = mode === "month" ? widenToMonths(r) : r;
    return pr.from === applied.from && pr.to === applied.to;
  });

  // The band while choosing the end: from the anchor to the hovered day.
  const band: DateRange =
    pickingEnd && hover
      ? hover < draft.from
        ? { from: hover, to: draft.from }
        : { from: draft.from, to: hover }
      : draft;

  const commitTyped = (which: "from" | "to", text: string) => {
    const d = parseTyped(text);
    if (!d) {
      // Put back the last valid date rather than keep an unreadable one.
      if (which === "from") setFromText(typed(draft.from));
      else setToText(typed(draft.to));
      return;
    }
    setRange(which === "from" ? { from: d, to: draft.to } : { from: draft.from, to: d });
    setView(addMonths(parse(d), which === "from" ? 0 : -1));
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-9 items-center gap-2 rounded-md border border-border bg-primary px-3 text-[13px] text-foreground outline-none transition-colors hover:bg-secondary focus-visible:border-foreground data-[state=open]:border-foreground",
            className,
          )}
        >
          <Icon name="calendar" className="size-4 shrink-0 stroke-[1.5] text-secondary-foreground" />
          <span className="tabular-nums">
            {formatRangeDay(value.from)} - {formatRangeDay(value.to)}
          </span>
          {compare && <span className="text-secondary-foreground">· compared</span>}
          <CaretDownIcon className="size-3.5 text-secondary-foreground" weight="bold" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-0">
        <div className="flex">
          <div className="p-4">
            <div className="mb-3 flex items-center gap-3">
              {compare !== undefined && (
                <label className="mr-2 inline-flex items-center gap-2 text-[13px] text-foreground">
                  <Switch checked={cmp} onChange={setCmp} label="Compare with the previous period" />
                  Compare
                </label>
              )}
              <input
                aria-label="Start date"
                value={fromText}
                onChange={(e) => setFromText(e.target.value)}
                onBlur={(e) => commitTyped("from", e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && commitTyped("from", e.currentTarget.value)}
                placeholder="MM/DD/YYYY"
                className="h-8 w-28 rounded-md border border-border bg-primary px-2 text-[13px] tabular-nums outline-none focus:border-foreground"
              />
              <span className="text-secondary-foreground">–</span>
              <input
                aria-label="End date"
                value={toText}
                onChange={(e) => setToText(e.target.value)}
                onBlur={(e) => commitTyped("to", e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && commitTyped("to", e.currentTarget.value)}
                placeholder="MM/DD/YYYY"
                className="h-8 w-28 rounded-md border border-border bg-primary px-2 text-[13px] tabular-nums outline-none focus:border-foreground"
              />
            </div>
            <div className="flex gap-6">
              <MonthGrid
                view={view}
                band={band}
                onPick={pickDay}
                onHover={setHover}
                nav={
                  <NavButton label="Previous month" icon="chevron_left" onClick={() => setView(addMonths(view, -1))} />
                }
              />
              <MonthGrid
                view={addMonths(view, 1)}
                band={band}
                onPick={pickDay}
                onHover={setHover}
                nav={<NavButton label="Next month" icon="chevron_right" onClick={() => setView(addMonths(view, 1))} />}
                navRight
              />
            </div>
          </div>
          <div className="flex w-44 flex-col border-l border-border p-2">
            {presetList.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  const r = p.range();
                  setRange(r);
                  setPickingEnd(false);
                  setView(addMonths(parse(r.to), -1));
                }}
                className={cn(
                  "rounded-md px-2.5 py-2 text-left text-[13px] transition-colors",
                  activePreset?.label === p.label
                    ? "bg-secondary font-medium text-foreground"
                    : "text-foreground hover:bg-secondary",
                )}
              >
                {p.label}
              </button>
            ))}
            {mode === "month" && (
              <p className="mt-auto px-2.5 pt-3 text-xs text-secondary-foreground">
                Months are whole UTC months.
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-border px-4 py-3">
          <span className="text-xs text-secondary-foreground tabular-nums">
            {formatRangeShort(applied)} · {days(applied.from, applied.to)} days
            {mode === "month" &&
              ` · the table shows ${monthCount(applied.from, applied.to)} month column${monthCount(applied.from, applied.to) === 1 ? "" : "s"}`}
            {cmp && ` · compared with the ${days(applied.from, applied.to)} days before`}
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="defaultInverted"
              size="sm"
              onClick={() => {
                onChange(applied, cmp);
                setOpen(false);
              }}
            >
              Update
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function NavButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: "chevron_left" | "chevron_right";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-md text-secondary-foreground transition-colors hover:bg-secondary"
    >
      <Icon name={icon} className="size-4" />
    </button>
  );
}

function MonthGrid({
  view,
  band,
  onPick,
  onHover,
  nav,
  navRight,
}: {
  view: Date;
  band: DateRange;
  onPick: (day: string) => void;
  onHover: (day: string | null) => void;
  nav: React.ReactNode;
  navRight?: boolean;
}) {
  const first = monthStart(view);
  const lead = first.getUTCDay();
  const cells = Array.from({ length: 42 }, (_, i) => new Date(first.getTime() + (i - lead) * DAY_MS));
  const todayIso = iso(today());
  return (
    <div className="w-[15.75rem]" onMouseLeave={() => onHover(null)}>
      <div className="mb-2 flex h-7 items-center justify-between">
        {!navRight ? nav : <span className="size-7" />}
        <span className="text-[13px] font-medium text-foreground">
          {MONTHS[view.getUTCMonth()]} {view.getUTCFullYear()}
        </span>
        {navRight ? nav : <span className="size-7" />}
      </div>
      <div className="grid grid-cols-7">
        {WEEKDAYS.map((w) => (
          <span
            key={w}
            className="flex h-8 items-center justify-center text-xs text-secondary-foreground"
          >
            {w}
          </span>
        ))}
        {cells.map((d) => {
          const day = iso(d);
          const inMonth = d.getUTCMonth() === view.getUTCMonth();
          if (!inMonth) return <span key={day} className="h-9" />;
          const inBand = day >= band.from && day <= band.to;
          const edge = day === band.from || day === band.to;
          return (
            <button
              key={day}
              type="button"
              aria-label={formatRangeDay(day)}
              aria-pressed={edge}
              onClick={() => onPick(day)}
              onMouseEnter={() => onHover(day)}
              className={cn(
                "flex h-9 items-center justify-center text-[13px] tabular-nums transition-colors",
                edge
                  ? "rounded-md bg-primary-foreground font-medium text-primary"
                  : inBand
                    ? "bg-quaternary text-foreground"
                    : "rounded-md text-foreground hover:bg-secondary",
                !edge && day === todayIso && "ring-1 ring-inset ring-quaternary",
              )}
            >
              {d.getUTCDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
