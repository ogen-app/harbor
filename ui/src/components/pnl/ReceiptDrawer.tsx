"use client";

import { useEffect, useState } from "react";
import {
  CheckCircleIcon,
  CheckIcon,
  ClockIcon,
  EnvelopeSimpleIcon,
  ProhibitIcon,
  ReceiptIcon,
  XIcon,
} from "@phosphor-icons/react";
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
import {
  api,
  cash,
  dateLong,
  instantLabel,
  money,
  monthLong,
  monthEnd,
  usd,
} from "./format";
import { ErrorLine, SectionTitle, TONE_TEXT } from "./shared";
import type { Check, Drill, Effect, ReceiptDetail, ReceiptMutation } from "./types";

// ReceiptDrawer shows one receipt (CON-412 mockup 3) on the shared Drawer:
// booking details (invoice date vs service period, and why it counts in that
// month), line items, checks, the original email (sandboxed), extraction
// versions and history. Void confirms inline in the footer and states its
// effect before anything moves, following the Unmap… pattern.

const KIND_LABEL: Record<string, string> = {
  invoice: "invoice",
  receipt: "receipt",
  prepayment: "credit purchase",
  refund: "refund",
  credit_note: "credit note",
  unknown: "document",
};

export function ReceiptDrawer({
  receiptId,
  onClose,
  onChanged,
  onShowInLedger,
  onReviewAttention,
}: {
  receiptId: string | null;
  onClose: () => void;
  onChanged: () => void;
  onShowInLedger: (d: Drill) => void;
  onReviewAttention: () => void;
}) {
  const [detail, setDetail] = useState<ReceiptDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmVoid, setConfirmVoid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [done, setDone] = useState<Effect | null>(null);
  const [showEmail, setShowEmail] = useState(false);

  useEffect(() => {
    if (!receiptId) return;
    const controller = new AbortController();
    /* eslint-disable react-hooks/set-state-in-effect */
    setDetail(null);
    setError(null);
    setConfirmVoid(false);
    setActionError(null);
    setDone(null);
    setShowEmail(false);
    /* eslint-enable react-hooks/set-state-in-effect */
    api<ReceiptDetail>(`/api/pnl/receipts/${encodeURIComponent(receiptId)}`, { signal: controller.signal })
      .then(setDetail)
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "The receipt could not be loaded");
      });
    return () => controller.abort();
  }, [receiptId]);

  const r = detail?.receipt;
  const live = detail?.entries.filter((e) => !e.voidedAt) ?? [];
  const liveSum = live.reduce((s, e) => s + cash(e.direction, e.amountMicros), 0);
  const canVoid = r && (r.status === "parsed" || r.status === "approved");
  const title = r
    ? `${r.vendorName || r.merchantName || "Unknown vendor"} ${KIND_LABEL[r.kind] ?? "document"}${r.invoiceNumber ? ` ${r.invoiceNumber}` : ""}`
    : "Receipt";

  const voidReceipt = async () => {
    if (!r) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await api<ReceiptMutation>(`/api/pnl/receipts/${encodeURIComponent(r.id)}/void`, {
        method: "POST",
        json: {},
      });
      setDone(res.effect);
      setDetail((d) => (d ? { ...d, receipt: res.receipt } : d));
      setConfirmVoid(false);
      onChanged();
      // Refresh entries and history so the drawer shows the void.
      api<ReceiptDetail>(`/api/pnl/receipts/${encodeURIComponent(r.id)}`).then(setDetail).catch(() => {});
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Voiding failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open={!!receiptId} onOpenChange={(o) => !o && onClose()}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle className="flex items-center gap-2">
            <ReceiptIcon className="size-5 shrink-0" />
            <span className="truncate">{title}</span>
          </DrawerTitle>
          <DrawerDescription className="text-[13px] text-secondary-foreground tabular-nums">
            {r
              ? [
                  dateLong(r.issueDate),
                  r.totalMicros != null ? `${money(r.totalMicros, r.currency)} ${r.currency.toUpperCase()}` : null,
                  `${live.length} ledger entr${live.length === 1 ? "y" : "ies"}`,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : " "}
          </DrawerDescription>
        </DrawerHeader>

        <DrawerBody className="space-y-6 text-[13px]">
          {error ? (
            <ErrorLine>{error}</ErrorLine>
          ) : !detail || !r ? (
            <div className="flex items-center gap-2 text-secondary-foreground">
              <Loader className="size-4" />
              Loading the receipt…
            </div>
          ) : (
            <>
              <StatusLine detail={detail} onShowInLedger={onShowInLedger} onReviewAttention={onReviewAttention} />

              {done && (
                <p role="status" className="rounded-[3px] border border-border bg-secondary px-4 py-2.5">
                  {done.summary}
                </p>
              )}

              <section className="space-y-2">
                <SectionTitle>Booking</SectionTitle>
                <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 rounded-[3px] bg-secondary px-4 py-3">
                  <dt className="text-secondary-foreground">Invoice date</dt>
                  <dd className="tabular-nums">{dateLong(r.issueDate)}</dd>
                  <dt className="text-secondary-foreground">Service period</dt>
                  <dd className="tabular-nums">
                    {r.servicePeriodStart || r.servicePeriodEnd
                      ? `${dateLong(r.servicePeriodStart)} – ${dateLong(r.servicePeriodEnd)}`
                      : "Not printed"}
                  </dd>
                  <dt className="text-secondary-foreground">Counts in</dt>
                  <dd>{r.bookedMonth ? `${monthLong(r.bookedMonth)}, by invoice date` : "—"}</dd>
                  <dt className="text-secondary-foreground">Forwarded by</dt>
                  <dd className="truncate">{r.forwardedBy || "—"}</dd>
                  {r.vendorName && (
                    <>
                      <dt className="text-secondary-foreground">Vendor</dt>
                      <dd>{r.vendorName}</dd>
                    </>
                  )}
                </dl>
                {r.bookingReason && <p className="text-secondary-foreground">{r.bookingReason}</p>}
              </section>

              <section className="space-y-2">
                <SectionTitle>Line items</SectionTitle>
                <table className="w-full border-collapse rounded-[3px] border border-border">
                  <tbody>
                    {r.lines.length === 0 && (
                      <tr className="h-9 border-b border-border">
                        <td className="px-4 text-secondary-foreground" colSpan={2}>
                          No line items were printed.
                        </td>
                      </tr>
                    )}
                    {r.lines.map((l, i) => (
                      <tr key={i} className="h-9 border-b border-border">
                        <td className="px-4">{l.description || "—"}</td>
                        <td className="px-4 text-right tabular-nums">
                          {l.amountMicros != null ? money(l.amountMicros, r.currency) : "—"}
                        </td>
                      </tr>
                    ))}
                    <TotalRow label="Subtotal" value={r.subtotalMicros} currency={r.currency} />
                    <TotalRow label="Tax" value={r.taxMicros} currency={r.currency} />
                    <TotalRow label="Total" value={r.totalMicros} currency={r.currency} strong />
                    {r.currency.toUpperCase() !== "USD" && r.totalUsdMicros != null && (
                      <tr className="h-9">
                        <td className="px-4 text-secondary-foreground">
                          In USD{r.fxRate != null ? ` at ${r.fxRate}` : ""}
                        </td>
                        <td className="px-4 text-right tabular-nums">{usd(r.totalUsdMicros)}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </section>

              {r.checks.length > 0 && (
                <section className="space-y-2">
                  <SectionTitle>Checks</SectionTitle>
                  <Checks checks={r.checks} />
                </section>
              )}

              {detail.email && (
                <section className="space-y-2">
                  <SectionTitle>Original email</SectionTitle>
                  <div className="rounded-[3px] border border-border bg-secondary">
                    <div className="flex items-start gap-3 px-4 py-3">
                      <EnvelopeSimpleIcon className="mt-0.5 size-4 shrink-0 text-secondary-foreground" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{detail.email.subject || "(no subject)"}</div>
                        <div className="truncate text-secondary-foreground">
                          {detail.email.forwardedFrom || detail.email.from} · {instantLabel(detail.email.date ?? detail.email.receivedAt)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowEmail((v) => !v)}
                        className="shrink-0 text-[var(--editable)] underline-offset-2 hover:underline"
                      >
                        {showEmail ? "Hide" : "View"}
                      </button>
                    </div>
                    {detail.attachments.length > 0 && (
                      <ul className="space-y-1 border-t border-border px-4 py-2">
                        {detail.attachments.map((a) => (
                          <li key={a.id} className="flex items-center justify-between gap-3">
                            <span className="truncate">{a.filename || "attachment"}</span>
                            {a.stored ? (
                              <a
                                href={`/api/pnl/receipts/${encodeURIComponent(r.id)}/attachments/${encodeURIComponent(a.id)}`}
                                className="shrink-0 text-[var(--editable)] underline-offset-2 hover:underline"
                              >
                                Download · {fileSize(a.sizeBytes)}
                              </a>
                            ) : (
                              <span className="shrink-0 text-secondary-foreground">Too large to keep</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {showEmail && <EmailFrame html={detail.email.htmlBody} text={detail.email.textBody} />}
                  </div>
                </section>
              )}

              {detail.extractions.length > 0 && (
                <section className="space-y-2">
                  <SectionTitle>Readings</SectionTitle>
                  <ul className="space-y-1.5">
                    {detail.extractions.map((x) => (
                      <li key={x.id} className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span>
                          Version {x.version}
                          {x.current && <span className="text-secondary-foreground"> (in use)</span>} ·{" "}
                          {x.modelId}
                        </span>
                        <span className="tabular-nums text-secondary-foreground">
                          {instantLabel(x.createdAt)} · {usd(x.costMicros)}
                        </span>
                        {x.confidenceNotes && (
                          <span className="w-full text-amber-900">Unsure: {x.confidenceNotes}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section className="space-y-2">
                <SectionTitle>History</SectionTitle>
                {detail.history.length === 0 ? (
                  <p className="text-secondary-foreground">No changes yet.</p>
                ) : (
                  <ol className="space-y-1.5">
                    {detail.history.map((h, i) => (
                      <li key={i} className="grid grid-cols-[7rem_1fr] gap-x-3">
                        <span className="tabular-nums text-secondary-foreground">{instantLabel(h.at)}</span>
                        <span>
                          {h.summary}
                          {h.actor && <span className="text-secondary-foreground"> · {h.actor}</span>}
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              {actionError && <ErrorLine>{actionError}</ErrorLine>}
            </>
          )}
        </DrawerBody>

        {r && (
          <DrawerFooter className="justify-between">
            {confirmVoid ? (
              <span className="text-[13px]">
                <span className="block font-medium">
                  Removes {usd(liveSum, "always")} ({live.length} entr{live.length === 1 ? "y" : "ies"}) from{" "}
                  {monthLong(r.bookedMonth)}.
                </span>
                <span className="block text-secondary-foreground">Restorable from the audit log.</span>
              </span>
            ) : (
              <span className="text-xs text-secondary-foreground">
                {r.status === "voided"
                  ? `Voided ${instantLabel(r.voidedAt)}`
                  : r.bookedMonth
                    ? `Counts in ${monthLong(r.bookedMonth)}`
                    : ""}
              </span>
            )}
            <div className="flex items-center gap-2">
              {confirmVoid ? (
                <>
                  <Button type="button" variant="ghost" onClick={() => setConfirmVoid(false)} disabled={busy}>
                    Cancel
                  </Button>
                  <Button type="button" variant="destructiveInverted" onClick={voidReceipt} disabled={busy}>
                    {busy ? "Voiding…" : `Void ${KIND_LABEL[r.kind] ?? "receipt"}`}
                  </Button>
                </>
              ) : (
                <>
                  {canVoid && (
                    <Button type="button" variant="destructive" onClick={() => setConfirmVoid(true)}>
                      Void…
                    </Button>
                  )}
                  <Button type="button" variant="ghost" onClick={onClose}>
                    Close
                  </Button>
                </>
              )}
            </div>
          </DrawerFooter>
        )}
      </DrawerContent>
    </Drawer>
  );
}

function StatusLine({
  detail,
  onShowInLedger,
  onReviewAttention,
}: {
  detail: ReceiptDetail;
  onShowInLedger: (d: Drill) => void;
  onReviewAttention: () => void;
}) {
  const r = detail.receipt;
  const allOk = r.checks.every((c) => c.ok);
  let icon = <CheckCircleIcon className="size-4 shrink-0" weight="bold" />;
  let tone: string = TONE_TEXT.positive;
  let text = allOk ? "Read automatically. All checks passed." : "Booked.";
  if (r.status === "approved") text = r.edited ? "Approved after edits." : "Approved by an operator.";
  if (r.status === "needs_attention") {
    icon = <ClockIcon className="size-4 shrink-0" weight="bold" />;
    tone = TONE_TEXT.pending;
    text = `Needs attention: ${r.attentionDetail || "a check failed"}. Not counted yet.`;
  }
  if (r.status === "rejected") {
    icon = <ProhibitIcon className="size-4 shrink-0" weight="bold" />;
    tone = TONE_TEXT.muted;
    text = `Rejected${r.rejectedReason ? `: ${r.rejectedReason}` : ""}. Not counted.`;
  }
  if (r.status === "voided") {
    icon = <ProhibitIcon className="size-4 shrink-0" weight="bold" />;
    tone = TONE_TEXT.muted;
    text = "Voided. Its entries no longer count.";
  }
  const posted = r.status === "parsed" || r.status === "approved";
  return (
    <div className="flex items-start justify-between gap-3">
      <p className={cn("flex items-start gap-2", tone)}>
        {icon}
        {text}
      </p>
      {posted && r.issueDate ? (
        <button
          type="button"
          onClick={() =>
            onShowInLedger({
              from: `${r.bookedMonth}-01`,
              to: monthEnd(r.bookedMonth),
              vendor: r.vendorId || undefined,
              source: ["receipt"],
            })
          }
          className="shrink-0 text-[var(--editable)] underline-offset-2 hover:underline"
        >
          Show entries in Ledger →
        </button>
      ) : r.status === "needs_attention" || r.status === "rejected" ? (
        <button
          type="button"
          onClick={onReviewAttention}
          className="shrink-0 text-[var(--editable)] underline-offset-2 hover:underline"
        >
          Open Needs attention →
        </button>
      ) : null}
    </div>
  );
}

export function Checks({ checks }: { checks: Check[] }) {
  return (
    <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
      {checks.map((c) => (
        <li key={c.key} className="flex items-start gap-2">
          {c.ok ? (
            <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-emerald-700" weight="bold" aria-label="Passed" />
          ) : (
            <XIcon className="mt-0.5 size-3.5 shrink-0 text-red-700" weight="bold" aria-label="Failed" />
          )}
          <span>
            {c.label}
            {!c.ok && c.detail && <span className="block text-red-800">{c.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function TotalRow({
  label,
  value,
  currency,
  strong,
}: {
  label: string;
  value: number | null;
  currency: string;
  strong?: boolean;
}) {
  return (
    <tr className="h-9 border-b border-border last:border-b-0">
      <td className={cn("px-4", strong ? "font-semibold" : "text-secondary-foreground")}>{label}</td>
      <td className={cn("px-4 text-right tabular-nums", strong && "font-semibold")}>
        {value != null ? money(value, currency) : "—"}
      </td>
    </tr>
  );
}

// EmailFrame renders the stored email in a fully sandboxed iframe: no scripts,
// no same-origin access, no forms, no navigation. A text-only email is shown
// as preformatted text.
export function EmailFrame({ html, text, className }: { html: string; text: string; className?: string }) {
  const doc = html
    ? html
    : `<pre style="font:13px/1.5 system-ui,sans-serif;white-space:pre-wrap;margin:0">${escapeHtml(text || "(empty email)")}</pre>`;
  return (
    <iframe
      title="Original email"
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={doc}
      className={cn("h-96 w-full border-t border-border bg-white", className)}
    />
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
