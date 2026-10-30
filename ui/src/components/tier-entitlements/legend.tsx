"use client";

import { cn } from "@/lib/utils";

// Delivery status of a FEATURE — orthogonal to a tier version's
// draft/live/retired status. Live is the norm and gets no chip; only the
// exceptions are marked next to the feature name (CON-321).
const FEATURE_STATUS: Record<string, { label: string; className: string }> = {
  in_progress: { label: "In progress", className: "bg-sky-50 text-sky-800 border-sky-200" },
  flag_off: { label: "Flag off", className: "bg-amber-50 text-amber-800 border-amber-200" },
  planned: { label: "Planned", className: "bg-secondary text-secondary-foreground border-border" },
};

export function FeatureStatusChip({ status }: { status: string }) {
  if (!status || status === "live") return null;
  const s = FEATURE_STATUS[status] ?? {
    label: status.replace(/_/g, " "),
    className: "bg-secondary text-secondary-foreground border-border",
  };
  return (
    <span
      className={cn(
        "rounded-xs border px-1.5 py-px text-[11px] font-medium leading-4 whitespace-nowrap",
        s.className,
      )}
    >
      {s.label}
    </span>
  );
}
