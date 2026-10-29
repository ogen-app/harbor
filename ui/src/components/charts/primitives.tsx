"use client";

import { cn } from "@/lib/utils";
import type { Scale } from "./scale";

// Building blocks for the revision-2 chart style (CON-413): square corners,
// dashed hairline grid with a solid $0 baseline, white-outlined value labels,
// round legend dots and an inverted tooltip.

const GRID = "#E6E3DE";
const BASELINE = "#C9C4BD";
const AXIS_TEXT = "#6F6A63";

// YGrid draws the horizontal gridlines and their labels on the left.
export function YGrid({
  scale,
  y,
  x0,
  x1,
  format,
}: {
  scale: Scale;
  y: (v: number) => number;
  x0: number;
  x1: number;
  format: (v: number) => string;
}) {
  return (
    <g aria-hidden>
      {scale.ticks.map((t) => (
        <g key={t}>
          <line
            x1={x0}
            x2={x1}
            y1={Math.round(y(t)) + 0.5}
            y2={Math.round(y(t)) + 0.5}
            stroke={t === 0 ? BASELINE : GRID}
            strokeDasharray={t === 0 ? undefined : "4 4"}
          />
          <text
            x={x0 - 10}
            y={y(t)}
            dy="0.32em"
            textAnchor="end"
            fill={AXIS_TEXT}
            className="text-[12px] tabular-nums"
          >
            {format(t)}
          </text>
        </g>
      ))}
    </g>
  );
}

// XLabel is one category label under the plot.
export function XLabel({ x, y, children, anchor = "middle" }: { x: number; y: number; children: React.ReactNode; anchor?: "start" | "middle" | "end" }) {
  return (
    <text x={x} y={y} textAnchor={anchor} fill={AXIS_TEXT} className="text-[12px] tabular-nums">
      {children}
    </text>
  );
}

// HaloLabel is a value label with a white outline, readable over bars and
// gridlines alike.
export function HaloLabel({
  x,
  y,
  fill,
  children,
  anchor = "middle",
  className,
}: {
  x: number;
  y: number;
  fill: string;
  children: React.ReactNode;
  anchor?: "start" | "middle" | "end";
  className?: string;
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      fill={fill}
      stroke="#FFFFFF"
      strokeWidth={3}
      strokeLinejoin="round"
      paintOrder="stroke"
      className={cn("text-[11px] font-semibold tabular-nums", className)}
    >
      {children}
    </text>
  );
}

export interface LegendItem {
  label: string;
  color: string;
  kind?: "dot" | "line" | "square";
}

export function Legend({ items, className }: { items: LegendItem[]; className?: string }) {
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-foreground", className)}>
      {items.map((it) => (
        <li key={it.label} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className={cn(
              "shrink-0",
              it.kind === "line" ? "h-0.5 w-3.5" : it.kind === "square" ? "size-2.5" : "size-2 rounded-full",
            )}
            style={{ background: it.color }}
          />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

export interface TooltipRow {
  label: string;
  value: string;
  color?: string;
}

// ChartTooltip is the inverted, square tooltip. It sits right of x (the right
// edge of the hovered column) and, when it would leave the chart, flips to end
// at xLeft (the column's left edge), so it never covers the column it explains.
export function ChartTooltip({
  x,
  xLeft = x,
  top,
  width,
  title,
  rows,
  total,
}: {
  x: number;
  xLeft?: number;
  top: number;
  width: number;
  title: string;
  rows: TooltipRow[];
  total?: TooltipRow;
}) {
  const W = 228;
  const flip = x + 12 + W > width;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-10 bg-[#1C1C1C] px-3.5 py-3 text-[13px] text-[#F4F3F1] shadow-lg"
      style={{ top, width: W, left: flip ? Math.max(0, xLeft - 12 - W) : x + 12 }}
    >
      <p className="mb-2 font-semibold">{title}</p>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-2">
            {r.color && <span className="size-2 shrink-0 rounded-full" style={{ background: r.color }} />}
            <span className="min-w-0 flex-1 truncate">{r.label}</span>
            <span className="tabular-nums">{r.value}</span>
          </li>
        ))}
      </ul>
      {total && (
        <p className="mt-2.5 flex items-center justify-between border-t border-[#3C3935] pt-2.5 font-semibold">
          <span>{total.label}</span>
          <span className="tabular-nums" style={{ color: total.color }}>
            {total.value}
          </span>
        </p>
      )}
    </div>
  );
}
