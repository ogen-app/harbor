"use client";

import { ClockIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { DIRECTION_LABEL, usd } from "./format";
import type { Direction, SyncState } from "./types";

// Shared bits of the /pnl tabs (CON-420). Colour carries meaning only
// (Appendix A.3): green = revenue/profit/favourable, red = expenses/loss/
// destructive, blue = margin/links, amber = pending/provisional/prepaid, and
// every coloured state also has a glyph or a word.

// Text colours that clear 4.5:1 on white and on the beige page.
export const TONE_TEXT = {
  positive: "text-emerald-700",
  negative: "text-red-700",
  margin: "text-[var(--editable)]",
  pending: "text-amber-800",
  muted: "text-secondary-foreground",
} as const;

// TypePill is the one type pill per ledger row. Only revenue and refund are
// coloured; fee, tax, expense and prepayment stay neutral.
export function TypePill({ direction }: { direction: Direction }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs leading-4 whitespace-nowrap",
        direction === "revenue"
          ? "bg-emerald-500/10 text-emerald-800"
          : direction === "refund"
            ? "bg-red-500/10 text-red-800"
            : "bg-quaternary text-foreground",
      )}
    >
      {DIRECTION_LABEL[direction]}
    </span>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[3px] border border-border bg-primary px-1 text-[11px] leading-none text-secondary-foreground">
      {children}
    </kbd>
  );
}

export function KeyHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-secondary-foreground">
      <span className="inline-flex gap-0.5">
        {keys.map((k) => (
          <Kbd key={k}>{k}</Kbd>
        ))}
      </span>
      {label}
    </span>
  );
}

// SectionTitle: 11–12px uppercase with slight tracking.
export function SectionTitle({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h3
      className={cn(
        "text-[11px] font-medium uppercase tracking-[0.06em] text-secondary-foreground",
        className,
      )}
    >
      {children}
    </h3>
  );
}

// PendingBanner is the full amber-tinted strip with a clock glyph (never a side
// stripe): the count and amount pending, and a link to Needs attention.
export function PendingBanner({
  children,
  onReview,
  reviewLabel,
}: {
  children: React.ReactNode;
  onReview?: () => void;
  reviewLabel?: string;
}) {
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-[3px] border border-amber-300 bg-amber-50 px-4 py-2.5 text-[13px] text-amber-950"
    >
      <ClockIcon className="size-4 shrink-0 text-amber-800" weight="bold" aria-hidden />
      <span className="min-w-0 flex-1">{children}</span>
      {onReview && (
        <button
          type="button"
          onClick={onReview}
          className="shrink-0 text-[13px] font-medium text-amber-900 underline-offset-2 hover:underline"
        >
          {reviewLabel ?? "Review →"}
        </button>
      )}
    </div>
  );
}

export function pendingSentence(count: number, amountMicros: number): string {
  return `${count} receipt${count === 1 ? "" : "s"} (${usd(amountMicros)})`;
}

// PendingMark is the amber clock + "pending" used in table cells.
export function PendingMark({ label = "pending" }: { label?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1", TONE_TEXT.pending)}>
      <ClockIcon className="size-3.5" weight="bold" aria-hidden />
      {label}
    </span>
  );
}

const STATE_DOT: Record<SyncState, string> = {
  ok: "bg-emerald-600",
  stale: "bg-amber-500",
  unavailable: "bg-red-600",
};

// StateDot pairs a coloured dot with its words (the dot alone is never the
// signal).
export function StateDot({
  state,
  children,
  title,
}: {
  state: SyncState;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5",
        state === "ok" ? "text-foreground" : state === "stale" ? "text-amber-900" : "text-red-800",
      )}
    >
      <span className={cn("size-2 shrink-0 rounded-full", STATE_DOT[state])} aria-hidden />
      {children}
    </span>
  );
}

// SkeletonBar is a loading placeholder bar; callers size it to keep the
// column widths of the real content.
export function SkeletonBar({ className }: { className?: string }) {
  return <span className={cn("block h-3 animate-pulse rounded-[2px] bg-quaternary", className)} />;
}

export function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="text-[13px] text-red-800">
      {children}
    </p>
  );
}
