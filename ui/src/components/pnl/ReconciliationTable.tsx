"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { api, monthLabel, usd } from "./format";
import { ErrorLine, SkeletonBar, TONE_TEXT } from "./shared";
import { SOURCE_NAME, diffText } from "./ReconcileDrawer";
import type { Reconciliation, ReconRow } from "./creditTypes";

const LINK = "cursor-pointer font-medium text-[var(--editable)] underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring";

// ReconciliationTable (CON-435) is "Estimated vs charged": per AI vendor per
// month, our token-pipeline estimate against what the vendor billed. A closed
// month within the threshold was reconciled automatically; one over it waits
// for Review. "Flag above" sets the threshold for everyone (audited).
export function ReconciliationTable({
  data,
  error,
  onOpen,
  onChanged,
}: {
  data: Reconciliation | null;
  error: string | null;
  onOpen: (vendorId: string, month: string) => void;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const setThreshold = async (pct: number) => {
    setSaving(true);
    setSaveError(null);
    try {
      await api("/api/pnl/settings", { method: "PUT", json: { driftThresholdPct: pct } });
      onChanged();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "The threshold could not be saved");
    } finally {
      setSaving(false);
    }
  };

  const notConnected = data?.vendors.filter((v) => v.source === "admin_api" && !v.connected && v.hint) ?? [];
  const fetchErrors = data?.vendors.filter((v) => v.error) ?? [];

  return (
    <section className="rounded-[3px] border border-border bg-primary">
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-5 pb-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-[15px] font-semibold">Estimated vs charged</h2>
          <p className="text-[13px] text-secondary-foreground">
            Our AI cost estimate against what the vendor actually billed, per month.
          </p>
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          Flag above
          <select
            value={data?.thresholdPct ?? 5}
            disabled={!data || saving}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="h-8 rounded-[3px] border border-border bg-primary px-2 tabular-nums outline-none focus:border-foreground"
          >
            {(data?.thresholds ?? [1, 2, 5, 10]).map((t) => (
              <option key={t} value={t}>
                {t}%
              </option>
            ))}
          </select>
        </label>
      </div>
      {saveError && (
        <div className="px-6 pb-2">
          <ErrorLine>{saveError}</ErrorLine>
        </div>
      )}

      {error ? (
        <div className="px-6 pb-5">
          <ErrorLine>{error}</ErrorLine>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-[13px] tabular-nums">
            <thead className="border-y border-border text-left text-[11px] uppercase tracking-[0.06em] text-secondary-foreground">
              <tr>
                <th className="px-6 py-2.5 font-medium">Month</th>
                <th className="px-3 py-2.5 font-medium">Vendor</th>
                <th className="px-3 py-2.5 text-right font-medium">Our estimate</th>
                <th className="px-3 py-2.5 text-right font-medium">Vendor charged</th>
                <th className="px-3 py-2.5 text-right font-medium">Difference</th>
                <th className="px-3 py-2.5 font-medium">Source</th>
                <th className="px-6 py-2.5 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {!data
                ? Array.from({ length: 6 }, (_, i) => (
                    <tr key={i} className="border-b border-border">
                      {Array.from({ length: 7 }, (_, j) => (
                        <td key={j} className="px-3 py-3 first:px-6 last:px-6">
                          <SkeletonBar className="w-16" />
                        </td>
                      ))}
                    </tr>
                  ))
                : data.rows.map((r) => (
                    <Row key={`${r.vendorId}-${r.month}`} r={r} pct={data.thresholdPct} onOpen={() => onOpen(r.vendorId, r.month)} />
                  ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="space-y-1.5 px-6 py-4 text-xs text-secondary-foreground">
        {notConnected.map((v) => (
          <p key={v.vendorId} className={TONE_TEXT.pending}>
            {v.name}: {v.hint}
          </p>
        ))}
        {fetchErrors.map((v) => (
          <p key={v.vendorId} className="text-red-800">
            {v.name} charges could not be fetched: {v.error}
          </p>
        ))}
        <p>
          The P&amp;L uses our estimate while a month is open. Once the vendor’s charge for a closed month arrives, a
          difference within the threshold is booked automatically, so the month’s total equals the charge; over it,
          the month waits for review. Reconciliation stays at company level: tenants keep their measured AI cost.
        </p>
      </div>
    </section>
  );
}

function Row({ r, pct, onOpen }: { r: ReconRow; pct: number; onOpen: () => void }) {
  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-secondary/60">
      <td className="px-6 py-2.5 whitespace-nowrap">{monthLabel(r.month)}</td>
      <td className="px-3 py-2.5">{r.vendorName}</td>
      <td className="px-3 py-2.5 text-right">{usd(r.estimateMicros)}</td>
      <td className={cn("px-3 py-2.5 text-right", r.chargedMicros == null && TONE_TEXT.muted)}>
        {r.chargedMicros != null ? usd(r.chargedMicros) : "—"}
      </td>
      <td className={cn("px-3 py-2.5 text-right whitespace-nowrap", r.diffMicros == null ? TONE_TEXT.muted : r.overThreshold && TONE_TEXT.pending)}>
        {diffText(r.diffMicros, r.diffPct)}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap">{SOURCE_NAME[r.source] ?? r.source}</td>
      <td className="px-6 py-2.5 text-right whitespace-nowrap">
        <StatusCell r={r} pct={pct} onOpen={onOpen} />
      </td>
    </tr>
  );
}

function StatusCell({ r, pct, onOpen }: { r: ReconRow; pct: number; onOpen: () => void }) {
  const link = (label: string) => (
    <button type="button" onClick={onOpen} className={LINK}>
      {label}
    </button>
  );
  switch (r.status) {
    case "open":
      return (
        <span className={TONE_TEXT.muted} title={r.chargedToDateMicros != null ? `${usd(r.chargedToDateMicros)} charged so far` : undefined}>
          Month still open
        </span>
      );
    case "not_connected":
      return (
        <span className="inline-flex items-center gap-3">
          <span className={TONE_TEXT.muted}>Not connected</span>
          {link("Enter →")}
        </span>
      );
    case "awaiting":
      return link("Enter amount →");
    case "awaiting_check":
      return <span className={TONE_TEXT.muted}>Checked tonight</span>;
    case "auto_accepted":
      return (
        <span className="inline-flex items-center gap-3">
          <span className="font-medium text-emerald-700">Within {pct}%</span>
          {link("Details")}
        </span>
      );
    case "pending_review":
      return (
        <span className="inline-flex items-center gap-3">
          <span className={cn("font-semibold", TONE_TEXT.pending)}>Over {pct}%</span>
          {link("Review →")}
        </span>
      );
    case "accepted":
      return (
        <span className="inline-flex items-center gap-3">
          <span className="font-medium text-emerald-700">Accepted</span>
          {link("Details")}
        </span>
      );
    case "dismissed":
      return (
        <span className="inline-flex items-center gap-3">
          <span className={TONE_TEXT.muted} title={r.note}>
            Estimate kept
          </span>
          {link("Details")}
        </span>
      );
  }
}
