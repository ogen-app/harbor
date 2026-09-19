"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

// A calendar + time-column picker (shadcn "date & time" style, cf.
// https://time.rdsx.dev) built on the app's Popover + design tokens, with no
// extra dependencies. It edits a single instant in the operator's local zone and
// emits a `Date | null` — null meaning "unset" (the showing-window fields are
// optional, so clearing must stay possible).

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

// Descending hours (12 → 1) and 5-minute steps, matching the reference layout.
const HOURS_12 = Array.from({ length: 12 }, (_, i) => 12 - i);
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);
const MERIDIEMS = ["AM", "PM"] as const;
type Meridiem = (typeof MERIDIEMS)[number];

const pad2 = (n: number) => String(n).padStart(2, "0");
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

function to12h(hours24: number): { hour: number; meridiem: Meridiem } {
  const meridiem: Meridiem = hours24 >= 12 ? "PM" : "AM";
  const hour = hours24 % 12 || 12;
  return { hour, meridiem };
}

// "MM/DD/YYYY hh:mm AA" — the reference's 12-hour display.
function formatDisplay(d: Date): string {
  const { hour, meridiem } = to12h(d.getHours());
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()} ${pad2(hour)}:${pad2(d.getMinutes())} ${meridiem}`;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

// Six weeks of days (42 cells) covering the view month, including the leading
// and trailing days of the neighbouring months so the grid is always full.
function monthGrid(view: Date): Date[] {
  const first = startOfMonth(view);
  const gridStart = new Date(first);
  gridStart.setDate(1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });
}

interface DateTimePickerProps {
  value: Date | null;
  onChange: (value: Date | null) => void;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  "aria-label"?: string;
}

export function DateTimePicker({
  value,
  onChange,
  id,
  placeholder = "MM/DD/YYYY hh:mm aa",
  disabled,
  "aria-label": ariaLabel,
}: DateTimePickerProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<Date>(() =>
    startOfMonth(value ?? new Date()),
  );

  // Re-anchor the calendar to the selected month whenever the picker opens with
  // a value, so editing an existing instant lands on the right month. Done in the
  // open handler (not an effect) to avoid a setState-in-effect cascade.
  const handleOpenChange = (next: boolean) => {
    if (next && value) setView(startOfMonth(value));
    setOpen(next);
  };

  const days = useMemo(() => monthGrid(view), [view]);
  const today = useMemo(() => new Date(), []);

  const sel = value
    ? { ...to12h(value.getHours()), minute: value.getMinutes() }
    : null;

  // The instant to mutate when only one field is touched: the current value, or
  // today at midnight so a first click has a sane date+time.
  const base = (): Date => {
    if (value) return new Date(value);
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  };

  const commitDay = (day: Date) => {
    const next = base();
    next.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
    onChange(next);
  };
  const commitHour = (hour12: number) => {
    const next = base();
    const isPM = next.getHours() >= 12;
    const h24 = (hour12 % 12) + (isPM ? 12 : 0);
    next.setHours(h24);
    onChange(next);
  };
  const commitMinute = (minute: number) => {
    const next = base();
    next.setMinutes(minute);
    onChange(next);
  };
  const commitMeridiem = (m: Meridiem) => {
    const next = base();
    const h = next.getHours();
    if (m === "PM" && h < 12) next.setHours(h + 12);
    if (m === "AM" && h >= 12) next.setHours(h - 12);
    onChange(next);
  };

  return (
    <div className="relative">
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            id={id}
            type="button"
            disabled={disabled}
            aria-label={ariaLabel}
            className={cn(
              "flex h-10 w-full items-center gap-2 rounded-none border-b border-quaternary bg-input px-4 py-1 pr-9",
              "text-left text-[14px] font-medium outline-none transition-[color,border-color] duration-300",
              "focus-visible:border-foreground data-[state=open]:border-foreground",
              "disabled:pointer-events-none disabled:opacity-50",
            )}
          >
            <Icon
              name="calendar"
              className="size-4 shrink-0 stroke-[1.5] text-tertiary-foreground"
            />
            <span
              className={cn(
                "truncate",
                value ? "text-foreground" : "text-tertiary-foreground",
              )}
            >
              {value ? formatDisplay(value) : placeholder}
            </span>
          </button>
        </PopoverTrigger>

        <PopoverContent align="start" className="w-auto p-0">
          <div className="flex divide-x divide-border">
            {/* Calendar */}
            <div className="p-3">
              <div className="mb-2 flex items-center justify-between px-1">
                <button
                  type="button"
                  aria-label="Previous month"
                  onClick={() =>
                    setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))
                  }
                  className="flex size-7 items-center justify-center rounded-md text-secondary-foreground transition-colors hover:bg-secondary"
                >
                  <Icon name="chevron_left" className="size-4" />
                </button>
                <span className="text-sm font-medium text-foreground">
                  {MONTHS[view.getMonth()]} {view.getFullYear()}
                </span>
                <button
                  type="button"
                  aria-label="Next month"
                  onClick={() =>
                    setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))
                  }
                  className="flex size-7 items-center justify-center rounded-md text-secondary-foreground transition-colors hover:bg-secondary"
                >
                  <Icon name="chevron_right" className="size-4" />
                </button>
              </div>

              <div className="grid grid-cols-7">
                {WEEKDAYS.map((w) => (
                  <span
                    key={w}
                    className="flex h-8 items-center justify-center text-xs font-medium text-tertiary-foreground"
                  >
                    {w}
                  </span>
                ))}
                {days.map((day) => {
                  const inMonth = day.getMonth() === view.getMonth();
                  const isSel = value != null && sameDay(day, value);
                  const isToday = sameDay(day, today);
                  return (
                    <button
                      key={day.toISOString()}
                      type="button"
                      onClick={() => commitDay(day)}
                      className={cn(
                        "flex size-9 items-center justify-center rounded-md text-sm transition-colors",
                        isSel
                          ? "bg-primary-foreground font-medium text-primary"
                          : "hover:bg-secondary",
                        !isSel && !inMonth && "text-tertiary-foreground/60",
                        !isSel && inMonth && "text-foreground",
                        !isSel &&
                          isToday &&
                          "ring-1 ring-inset ring-quaternary",
                      )}
                    >
                      {day.getDate()}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Time columns */}
            <div className="flex">
              <TimeColumn
                open={open}
                items={HOURS_12}
                selected={sel?.hour ?? null}
                render={(h) => pad2(h)}
                onSelect={commitHour}
              />
              <TimeColumn
                open={open}
                items={MINUTES}
                selected={sel?.minute ?? null}
                render={(m) => pad2(m)}
                onSelect={commitMinute}
              />
              <TimeColumn
                open={open}
                items={MERIDIEMS}
                selected={sel?.meridiem ?? null}
                render={(m) => m}
                onSelect={commitMeridiem}
              />
            </div>
          </div>

          {/* Footer: clear (the window fields are optional) + done */}
          <div className="flex items-center justify-between border-t border-border px-3 py-2">
            <button
              type="button"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              className="rounded-md px-2 py-1 text-xs font-medium text-tertiary-foreground transition-colors hover:text-foreground"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md bg-primary-foreground px-3 py-1 text-xs font-semibold text-primary transition-colors hover:bg-primary-foreground-elevated"
            >
              Done
            </button>
          </div>
        </PopoverContent>
      </Popover>

      {/* Inline clear affordance (sibling of the trigger, not nested in it). */}
      {value && !disabled && (
        <button
          type="button"
          aria-label="Clear"
          onClick={(e) => {
            e.stopPropagation();
            onChange(null);
          }}
          className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-tertiary-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <Icon name="x_mark" className="size-3.5" />
        </button>
      )}
    </div>
  );
}

// One scrollable time column (hours / minutes / meridiem). It scrolls the
// selected cell into view when the popover opens so the current value is visible
// without hunting.
function TimeColumn<T extends string | number>({
  open,
  items,
  selected,
  render,
  onSelect,
}: {
  open: boolean;
  items: readonly T[];
  selected: T | null;
  render: (item: T) => string;
  onSelect: (item: T) => void;
}) {
  const selectedRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (open && selectedRef.current) {
      selectedRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [open]);

  return (
    <div className="flex max-h-[17.5rem] flex-col gap-1 overflow-y-auto p-2 [scrollbar-width:thin]">
      {items.map((item) => {
        const isSel = item === selected;
        return (
          <button
            key={String(item)}
            ref={isSel ? selectedRef : undefined}
            type="button"
            onClick={() => onSelect(item)}
            className={cn(
              "rounded-md px-3 py-1.5 text-center text-sm tabular-nums transition-colors",
              isSel
                ? "bg-primary-foreground font-medium text-primary"
                : "text-secondary-foreground hover:bg-secondary",
            )}
          >
            {render(item)}
          </button>
        );
      })}
    </div>
  );
}
