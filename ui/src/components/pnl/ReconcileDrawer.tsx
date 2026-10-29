"use client";

import { useEffect, useState } from "react";
import { ScalesIcon } from "@phosphor-icons/react";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ui/loader";
import { cn } from "@/lib/utils";
import { api, dayLabel, instantLabel, microsToInput, monthLong, parseMoney, pct, usd } from "./format";
import { ErrorLine, SectionTitle, TONE_TEXT } from "./shared";
import type { Effect, ReconDetail, ReconRow } from "./creditTypes";

const ACTION_LABEL: Record<string, string> = {
  "reconciliation.accept": "accepted the charge",
  "reconciliation.dismiss": "kept the estimate",
  "reconciliation.manual": "entered the charge",
};

// The automatic check either booked the difference or flagged the month.
function actionLabel(action: string, status: string): string {
  if (action === "reconciliation.auto") {
    return status === "pending_review" ? "flagged it for review (over the threshold)" : "booked the difference (within the threshold)";
  }
  return ACTION_LABEL[action] ?? action;
}

export const SOURCE_NAME: Record<string, string> = {
  admin_api: "Admin API",
  billing_export: "Billing export",
  manual: "Manual",
};

export function diffText(diff: number | null, diffPct: number | null): string {
  if (diff == null) return "—";
  return diffPct == null ? usd(diff, "always") : `${usd(diff, "always")} (${diffPct > 0 ? "+" : ""}${pct(diffPct)})`;
}

// ReconcileDrawer (CON-435) is one vendor-month of Estimated vs charged. It
// shows our daily estimate next to the vendor's daily charge, and both by
// model when the vendor's report breaks them down. A month over the threshold
// is decided here: Accept posts charged − estimate to the books, Keep estimate
// dismisses it with a reason. Charges a vendor can't report (Google, or
// Anthropic without an Admin key) are entered here. Every action is audited.
export function ReconcileDrawer({
  target,
  onClose,
  onChanged,
}: {
  target: { vendorId: string; month: string } | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<ReconDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [effect, setEffect] = useState<Effect | null>(null);
  const [reason, setReason] = useState("");
  const [dismissing, setDismissing] = useState(false);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!target) return;
    const controller = new AbortController();
    /* eslint-disable react-hooks/set-state-in-effect */
    setDetail(null);
    setError(null);
    setEffect(null);
    setActionError(null);
    setReason("");
    setDismissing(false);
    /* eslint-enable react-hooks/set-state-in-effect */
    api<ReconDetail>(`/api/pnl/reconciliation/${target.vendorId}/${target.month}`, { signal: controller.signal })
      .then((d) => {
        setDetail(d);
        setAmount(microsToInput(d.row.chargedMicros ?? d.row.chargedToDateMicros));
        setNote(d.row.source === "manual" ? d.row.note : "");
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "The month could not be loaded");
      });
    return () => controller.abort();
  }, [target]);

  const act = async (action: "accept" | "dismiss" | "manual", json?: unknown) => {
    if (!target) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await api<{ effect: Effect; detail: ReconDetail }>(
        `/api/pnl/reconciliation/${target.vendorId}/${target.month}/${action}`,
        { method: "POST", json: json ?? {} },
      );
      setDetail(res.detail);
      setEffect(res.effect);
      setDismissing(false);
      onChanged();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "The action failed");
    } finally {
      setBusy(false);
    }
  };

  const row = detail?.row;
  const canEnter = row && row.status !== "open" && (row.source === "manual" || row.status === "not_connected");
  const reviewable = row?.status === "pending_review";
  const dismissable = row && ["pending_review", "accepted", "auto_accepted"].includes(row.status);

  return (
    <Drawer open={target != null} onOpenChange={(o) => !o && onClose()}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle className="flex items-center gap-2">
            <ScalesIcon className="size-5 shrink-0" aria-hidden />
            {row ? `${row.vendorName}, ${monthLong(row.month)}` : "Estimated vs charged"}
          </DrawerTitle>
          <DrawerDescription className="text-[13px] text-secondary-foreground">
            Our estimate from the token pipeline against what the vendor billed.
          </DrawerDescription>
        </DrawerHeader>

        <DrawerBody className="space-y-5">
          {error ? (
            <ErrorLine>{error}</ErrorLine>
          ) : !detail || !row ? (
            <div className="flex justify-center py-10">
              <Loader />
            </div>
          ) : (
            <>
              <dl className="grid grid-cols-3 gap-3 rounded-[3px] border border-border bg-secondary px-4 py-3 text-[13px]">
                <Figure label="Our estimate" value={usd(row.estimateMicros)} />
                <Figure
                  label={row.status === "open" ? "Charged so far" : "Vendor charged"}
                  value={
                    row.chargedMicros != null
                      ? usd(row.chargedMicros)
                      : row.chargedToDateMicros != null
                        ? usd(row.chargedToDateMicros)
                        : "—"
                  }
                  note={SOURCE_NAME[row.source]}
                />
                <Figure
                  label="Difference"
                  value={diffText(row.diffMicros, row.diffPct)}
                  tone={row.overThreshold ? TONE_TEXT.pending : undefined}
                  note={row.diffMicros != null ? (row.overThreshold ? `Over ${detail.thresholdPct}%` : `Within ${detail.thresholdPct}%`) : undefined}
                />
              </dl>

              <StatusLine row={row} />

              {canEnter && (
                <section className="space-y-2">
                  <SectionTitle>Charged amount</SectionTitle>
                  <p className="text-[13px] text-secondary-foreground">
                    {row.vendorId === "google"
                      ? "From the Cloud Billing console: the month's Gemini / AI Studio cost, in USD."
                      : "From the vendor's billing console, in USD."}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="sr-only" htmlFor="recon-amount">
                      Charged amount in USD
                    </label>
                    <input
                      id="recon-amount"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      className="h-8 w-32 rounded-[3px] border border-border bg-primary px-2 text-right text-[13px] tabular-nums outline-none focus:border-foreground"
                    />
                    <label className="sr-only" htmlFor="recon-note">
                      Note
                    </label>
                    <input
                      id="recon-note"
                      placeholder="Note (optional)"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      className="h-8 min-w-0 flex-1 rounded-[3px] border border-border bg-primary px-2 text-[13px] outline-none focus:border-foreground"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy || parseMoney(amount) == null}
                      onClick={() => act("manual", { chargedMicros: parseMoney(amount), note })}
                    >
                      Save charge
                    </Button>
                  </div>
                </section>
              )}

              <section className="space-y-2">
                <SectionTitle>By day</SectionTitle>
                <div className="max-h-72 overflow-auto rounded-[3px] border border-border">
                  <table className="w-full text-[13px] tabular-nums">
                    <thead className="sticky top-0 bg-secondary text-left text-[11px] uppercase tracking-[0.06em] text-secondary-foreground">
                      <tr>
                        <th className="px-3 py-2 font-medium">Day</th>
                        <th className="px-3 py-2 text-right font-medium">Estimate</th>
                        <th className="px-3 py-2 text-right font-medium">Charged</th>
                        <th className="px-3 py-2 text-right font-medium">Difference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.days.map((d) => {
                        const diff = d.chargedMicros != null ? d.chargedMicros - d.estimateMicros : null;
                        return (
                          <tr key={d.date} className="border-t border-border">
                            <td className="px-3 py-1.5">{dayLabel(d.date)}</td>
                            <td className="px-3 py-1.5 text-right">{usd(d.estimateMicros)}</td>
                            <td className="px-3 py-1.5 text-right">{d.chargedMicros != null ? usd(d.chargedMicros) : "—"}</td>
                            <td className={cn("px-3 py-1.5 text-right", diff == null && TONE_TEXT.muted)}>
                              {diff != null ? usd(diff, "always") : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {!detail.hasBreakdown && (
                  <p className="text-xs text-secondary-foreground">
                    The vendor&apos;s charge has no daily breakdown{row.source === "manual" ? " (entered by hand)" : ""}.
                  </p>
                )}
              </section>

              {detail.models.length > 0 && (
                <section className="space-y-2">
                  <SectionTitle>By model</SectionTitle>
                  <table className="w-full text-[13px] tabular-nums">
                    <tbody>
                      {detail.models.map((m) => (
                        <tr key={m.model} className="border-t border-border first:border-t-0">
                          <td className="py-1.5 pr-3">{m.model || "Other"}</td>
                          <td className="py-1.5 text-right text-secondary-foreground">est. {usd(m.estimateMicros)}</td>
                          <td className="w-28 py-1.5 text-right">{m.chargedMicros != null ? usd(m.chargedMicros) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}

              <section className="space-y-2">
                <SectionTitle>History</SectionTitle>
                {detail.audit.length === 0 ? (
                  <p className="text-[13px] text-secondary-foreground">Nothing has happened to this month yet.</p>
                ) : (
                  <ul className="space-y-1.5 text-[13px] text-secondary-foreground">
                    {detail.audit.map((a, i) => (
                      <li key={i} className="tabular-nums">
                        {instantLabel(a.at)} · {a.actor === "system" ? "Harbor" : a.actor} {actionLabel(a.action, a.status)}
                        {a.note && <span>: “{a.note}”</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {dismissing && (
                <section className="space-y-2">
                  <label htmlFor="recon-reason" className="block text-[13px] font-medium">
                    Why keep the estimate?
                  </label>
                  <textarea
                    id="recon-reason"
                    rows={2}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. The charge includes another product's usage"
                    className="w-full rounded-[3px] border border-border bg-primary px-2 py-1.5 text-[13px] outline-none focus:border-foreground"
                  />
                </section>
              )}
            </>
          )}
        </DrawerBody>

        <DrawerFooter className="justify-between">
          <span className="min-w-0 text-[13px]">
            {actionError ? (
              <span className="text-red-800">{actionError}</span>
            ) : effect ? (
              <span className="font-medium">{effect.summary}</span>
            ) : reviewable && row ? (
              <span className="text-secondary-foreground">
                Accept books {usd((row.chargedMicros ?? 0) - row.estimateMicros, "always")} on the last day of {monthLong(row.month)}.
              </span>
            ) : null}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            {dismissing ? (
              <>
                <Button type="button" variant="ghost" onClick={() => setDismissing(false)} disabled={busy}>
                  Back
                </Button>
                <Button type="button" onClick={() => act("dismiss", { reason })} disabled={busy || reason.trim() === ""}>
                  {busy ? "Saving…" : "Keep estimate"}
                </Button>
              </>
            ) : (
              <>
                {dismissable && (
                  <Button type="button" variant="ghost" onClick={() => setDismissing(true)} disabled={busy}>
                    Keep estimate
                  </Button>
                )}
                {reviewable ? (
                  <Button type="button" onClick={() => act("accept")} disabled={busy}>
                    {busy ? "Accepting…" : "Accept"}
                  </Button>
                ) : (
                  <Button type="button" variant="outline" onClick={onClose}>
                    Close
                  </Button>
                )}
              </>
            )}
          </div>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function Figure({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-secondary-foreground">{label}</dt>
      <dd className={cn("mt-1 truncate text-base tabular-nums", tone)}>{value}</dd>
      {note && <dd className="mt-0.5 text-xs text-secondary-foreground">{note}</dd>}
    </div>
  );
}

function StatusLine({ row }: { row: ReconRow }) {
  const text: Record<string, string> = {
    open: "The month is still open: the P&L uses our estimate until it closes.",
    not_connected: "Anthropic isn't connected. Enter the charge below, or set the Admin key in Secrets.",
    awaiting: "No charge yet. Enter it below to reconcile the month.",
    awaiting_check: "The charge arrived; it is checked with the next daily run.",
    auto_accepted: "Within the threshold, so the charge replaced the estimate automatically.",
    pending_review: "Over the threshold. Accept the charge, or keep the estimate and say why.",
    accepted: `Accepted by ${row.reviewedBy || "an operator"}: the charge replaced the estimate.`,
    dismissed: `Estimate kept by ${row.reviewedBy || "an operator"}${row.note ? `: “${row.note}”` : ""}.`,
  };
  const adj =
    row.adjustmentMicros != null ? ` Reconciliation entry: ${usd(row.adjustmentMicros, "always")}.` : "";
  return (
    <p className={cn("text-[13px]", row.status === "pending_review" ? TONE_TEXT.pending : "text-secondary-foreground")}>
      {text[row.status] ?? ""}
      {adj}
    </p>
  );
}
