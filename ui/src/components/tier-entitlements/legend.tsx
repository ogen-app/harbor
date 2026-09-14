"use client";

import { cn } from "@/lib/utils";

// Delivery status of a FEATURE (the reference's LIVE / FLAG OFF / IN PROGRESS /
// PLANNED legend) — orthogonal to a tier version's draft/active/retired status.
// Shared by the matrix's Status column chips and the page-header legend.
export const FEATURE_STATUS: Record<
  string,
  { label: string; className: string }
> = {
  live: { label: "LIVE", className: "bg-emerald-100 text-emerald-800" },
  in_progress: { label: "IN PROGRESS", className: "bg-sky-100 text-sky-800" },
  flag_off: { label: "FLAG OFF", className: "bg-amber-100 text-amber-800" },
  planned: { label: "PLANNED", className: "bg-gray-100 text-gray-600" },
};

const LEGEND: { key: string; hint: string }[] = [
  { key: "live", hint: "shipped" },
  { key: "flag_off", hint: "waiting on the API" },
  { key: "in_progress", hint: "active branch" },
  { key: "planned", hint: "backlog" },
];

// StatusLegend renders the four delivery-status chips with their meaning —
// shown in the page header, and the key to the Status column dots/chips.
export function StatusLegend({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1.5",
        className,
      )}
    >
      {LEGEND.map(({ key, hint }) => {
        const s = FEATURE_STATUS[key];
        return (
          <span key={key} className="flex items-center gap-1.5 text-xs">
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide",
                s.className,
              )}
            >
              {s.label}
            </span>
            <span className="text-tertiary-foreground">{hint}</span>
          </span>
        );
      })}
    </div>
  );
}
