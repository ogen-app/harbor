"use client";

import { cn } from "@/lib/utils";
import { pct, usd } from "@/components/pnl/format";
import type { Tenant } from "@/components/tenants/shared";

// Revenue and Margin cells for the Tenants table (CON-434). Both read the row's
// month-to-date figures from the Harbor ledger; while revenue is unavailable
// they show "—" with the reason on hover.

// marginTone colour-codes a margin: below 0 red, below 10% amber, else green.
function marginTone(m: number): { text: string; bar: string } {
  if (m < 0) return { text: "text-red-700", bar: "bg-red-600" };
  if (m < 10) return { text: "text-amber-700", bar: "bg-amber-500" };
  return { text: "text-emerald-700", bar: "bg-emerald-600" };
}

// noMarginHint says why a tenant has no margin.
function noMarginHint(t: Tenant): string {
  if (t.revenueMicros == null) {
    return t.billingStatus === "on_trial"
      ? "trial, no revenue yet"
      : "no revenue yet";
  }
  return "no net revenue";
}

function Unavailable({ reason }: { reason?: string }) {
  return (
    <span
      className="text-xs text-tertiary-foreground"
      title={reason || "Revenue is unavailable"}
    >
      —
    </span>
  );
}

export function RevenueCell({
  tenant,
  available,
  reason,
}: {
  tenant: Tenant;
  available: boolean;
  reason?: string;
}) {
  if (!available) return <Unavailable reason={reason} />;
  if (tenant.revenueMicros == null) {
    return <span className="text-xs text-tertiary-foreground">—</span>;
  }
  return (
    <span className="tabular-nums text-foreground">
      {usd(tenant.revenueMicros)}
    </span>
  );
}

// MarginCell is a 0–100% bar with square ends (a negative margin gets a red
// marker at the left), then the percentage over the signed contribution.
export function MarginCell({
  tenant,
  available,
  reason,
}: {
  tenant: Tenant;
  available: boolean;
  reason?: string;
}) {
  if (!available) return <Unavailable reason={reason} />;
  const m = tenant.marginPct;
  if (m == null) {
    return (
      <span className="flex min-w-0 flex-col">
        <span className="text-xs text-tertiary-foreground">—</span>
        <span className="truncate text-xs text-tertiary-foreground">
          {noMarginHint(tenant)}
        </span>
      </span>
    );
  }
  const tone = marginTone(m);
  const fill = Math.min(100, Math.max(0, m));
  return (
    <span className="flex w-full min-w-0 items-center gap-3">
      <span
        aria-hidden
        className="relative h-1.5 min-w-10 flex-1 bg-secondary"
      >
        {m < 0 ? (
          <span className={cn("absolute inset-y-0 left-0 w-1.5", tone.bar)} />
        ) : (
          <span
            className={cn("absolute inset-y-0 left-0", tone.bar)}
            style={{ width: `${fill}%` }}
          />
        )}
      </span>
      <span className="flex shrink-0 flex-col items-end tabular-nums">
        <span className={cn("font-medium", tone.text)}>{pct(m)}</span>
        {tenant.contributionMicros != null && (
          <span className="text-xs text-tertiary-foreground">
            {usd(tenant.contributionMicros, "always")}
          </span>
        )}
      </span>
    </span>
  );
}
