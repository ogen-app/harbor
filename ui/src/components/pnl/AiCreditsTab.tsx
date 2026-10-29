"use client";

import { useCallback, useEffect, useState } from "react";
import { WarningIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { AlertSettingsPopover } from "./AlertSettingsPopover";
import { CreditBalanceChart } from "./CreditBalanceChart";
import { ReconcileDrawer } from "./ReconcileDrawer";
import { ReconciliationTable } from "./ReconciliationTable";
import { api, dateLong, parseDate, monthShort, usd } from "./format";
import { ErrorLine, SkeletonBar, TONE_TEXT } from "./shared";
import type { CreditVendor, Credits, Reconciliation } from "./creditTypes";

// "Nov 25" (no zero padding).
function shortDay(date: string): string {
  const d = parseDate(date);
  return `${monthShort(d)} ${d.getUTCDate()}`;
}

// AiCreditsTab (CON-435) is tab 4 of /pnl. Anthropic and Google are paid with
// prepaid credit: a forwarded top-up receipt adds to the balance and AI usage
// from the token pipeline draws it down. It answers "how long until we run
// out?" (balance, runway, the low-balance banner and the chart) and "is our
// estimate right?" (Estimated vs charged).
export function AiCreditsTab({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [credits, setCredits] = useState<Credits | null>(null);
  const [creditsError, setCreditsError] = useState<string | null>(null);
  const [recon, setRecon] = useState<Reconciliation | null>(null);
  const [reconError, setReconError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [review, setReview] = useState<{ vendorId: string; month: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<Credits>("/api/pnl/credits", { signal: controller.signal })
      .then((c) => {
        setCredits(c);
        setCreditsError(null);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setCreditsError(e instanceof Error ? e.message : "Credits could not be loaded");
      });
    api<Reconciliation>("/api/pnl/reconciliation", { signal: controller.signal })
      .then((r) => {
        setRecon(r);
        setReconError(null);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setReconError(e instanceof Error ? e.message : "The reconciliation could not be loaded");
      });
    return () => controller.abort();
  }, [version, reload]);

  // Settings and reviews change the books, so the other tabs refetch too.
  const changed = useCallback(() => {
    setReload((n) => n + 1);
    onChanged();
  }, [onChanged]);

  const vendors = credits?.vendors ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
        <p className="text-xs text-secondary-foreground">Balance = top-ups from receipts − AI usage from the pipeline</p>
        {credits && <AlertSettingsPopover vendors={vendors} onSaved={changed} className="text-xs" />}
      </div>

      {creditsError ? (
        <ErrorLine>{creditsError}</ErrorLine>
      ) : (
        <section
          aria-label="Credit balances"
          className="grid grid-cols-2 rounded-[3px] border border-border bg-primary md:grid-cols-4"
        >
          {credits
            ? vendors.flatMap((v) => [
                <BalanceCell key={`${v.vendorId}-b`} v={v} vendors={vendors} onSaved={changed} />,
                <RunwayCell key={`${v.vendorId}-r`} v={v} />,
              ])
            : Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="space-y-3 px-6 py-5">
                  <SkeletonBar className="w-24" />
                  <SkeletonBar className="h-7 w-32" />
                  <SkeletonBar className="w-28" />
                </div>
              ))}
        </section>
      )}

      {credits && credits.alerts.length > 0 && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-[3px] border border-amber-300 bg-amber-50 px-4 py-2.5 text-[13px] text-amber-950"
        >
          <WarningIcon className="mt-0.5 size-4 shrink-0 text-amber-800" weight="bold" aria-hidden />
          <span className="min-w-0 flex-1 space-y-0.5">
            {credits.alerts.map((a) => (
              <span key={a.vendorId} className="block">
                {a.message}
              </span>
            ))}
          </span>
          <AlertSettingsPopover vendors={vendors} onSaved={changed} className="text-amber-950" />
        </div>
      )}

      <section className="rounded-[3px] border border-border bg-primary px-6 py-5">
        <div className="mb-4 space-y-1">
          <h2 className="text-[15px] font-semibold">Credit balance</h2>
          <p className="text-[13px] text-secondary-foreground">
            Steps up on top-ups, slopes down with usage. The dashed line is the projection at the last 7 days’ rate.
          </p>
        </div>
        {creditsError ? null : credits ? (
          <CreditBalanceChart data={credits} />
        ) : (
          <SkeletonBar className="h-[300px] w-full" />
        )}
      </section>

      <ReconciliationTable
        data={recon}
        error={reconError}
        onOpen={(vendorId, month) => setReview({ vendorId, month })}
        onChanged={changed}
      />

      <ReconcileDrawer target={review} onClose={() => setReview(null)} onChanged={changed} />
    </div>
  );
}

function Cell({
  label,
  value,
  tone,
  children,
}: {
  label: string;
  value: string;
  tone?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 px-6 py-5">
      <div className="text-[13px] text-secondary-foreground">{label}</div>
      <div className={cn("mt-1.5 truncate text-[28px] leading-9 font-normal tabular-nums", tone)}>{value}</div>
      <div className="mt-1.5 truncate text-xs tabular-nums text-secondary-foreground">{children}</div>
    </div>
  );
}

function BalanceCell({ v, vendors, onSaved }: { v: CreditVendor; vendors: CreditVendor[]; onSaved: () => void }) {
  if (!v.configured || v.balanceMicros == null) {
    return (
      <Cell label={`${v.name} balance`} value="—">
        <AlertSettingsPopover vendors={vendors} onSaved={onSaved} label="Set the opening balance" className="text-xs font-medium text-[var(--editable)]" />
      </Cell>
    );
  }
  const low = v.belowAlert;
  return (
    <Cell label={`${v.name} balance`} value={usd(v.balanceMicros)} tone={low ? TONE_TEXT.pending : undefined}>
      {low ? (
        <span className={TONE_TEXT.pending}>Below your {v.alertDays}-day alert</span>
      ) : v.lastTopUp ? (
        `Last top-up ${shortDay(v.lastTopUp.date)}, ${usd(v.lastTopUp.amountMicros)}`
      ) : (
        `Opening balance on ${dateLong(v.openingDate)}`
      )}
    </Cell>
  );
}

function RunwayCell({ v }: { v: CreditVendor }) {
  if (!v.configured) {
    return <Cell label={`${v.name} runway`} value="—">Needs an opening balance</Cell>;
  }
  if (v.runwayDays == null || v.dailyRateMicros == null || !v.runOutDate) {
    return <Cell label={`${v.name} runway`} value="—">No usage in the last 7 days</Cell>;
  }
  const value = v.runwayDays === 0 ? "Out of credit" : `${v.runwayDays} day${v.runwayDays === 1 ? "" : "s"}`;
  return (
    <Cell label={`${v.name} runway`} value={value} tone={v.belowAlert ? TONE_TEXT.pending : undefined}>
      About {shortDay(v.runOutDate)} · {usd(v.dailyRateMicros)} a day
    </Cell>
  );
}
