"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { CheckCircleIcon, ClockIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ui/loader";
import { cn } from "@/lib/utils";
import {
  CATEGORY_LABEL,
  HttpError,
  api,
  dateLong,
  instantLabel,
  microsToInput,
  money,
  monthLabel,
  monthOf,
  parseMoney,
  usd,
} from "./format";
import { Checks, EmailFrame } from "./ReceiptDrawer";
import { ErrorLine, SectionTitle, SkeletonBar, TONE_TEXT } from "./shared";
import type {
  AttentionItem,
  AttentionResponse,
  Check,
  PnlStatus,
  ReceiptDetail,
  ReceiptMutation,
  ReceiptPatch,
  Vendor,
  VendorCategory,
} from "./types";

// AttentionTab is tab 3 (CON-412 mockup 4): receipts that failed a check stay
// out of the P&L and the ledger until an operator approves them. Each row says
// what is wrong and the one next step; the inline editor sits next to the
// original email, and its single primary button names its effect ("Approve
// $118.80 → Oct 2026"). Ignored receipts go to Rejected, kept 30 days with
// Restore. Emails that could not be fetched or read show here too.
export function AttentionTab({
  status,
  version,
  onChanged,
  onOpenReceipt,
}: {
  status: PnlStatus | null;
  version: number;
  onChanged: () => void;
  onOpenReceipt: (id: string) => void;
}) {
  const [data, setData] = useState<AttentionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    api<AttentionResponse>("/api/pnl/attention", { signal: controller.signal })
      .then((j) => {
        setData(j);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Needs attention could not be loaded");
      });
    api<{ vendors: Vendor[] }>("/api/pnl/vendors", { signal: controller.signal })
      .then((j) => setVendors(j.vendors))
      .catch(() => {});
    return () => controller.abort();
  }, [version]);

  const act = async (id: string, url: string, body: unknown, message: (r: unknown) => string) => {
    setBusyId(id);
    setError(null);
    try {
      const res = await api<unknown>(url, { method: "POST", json: body });
      setNotice(message(res));
      if (editing === id) setEditing(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The action failed");
    } finally {
      setBusyId(null);
    }
  };

  const effectMessage = (prefix: string) => (r: unknown) => {
    const m = r as ReceiptMutation;
    return m?.effect?.summary ? `${prefix}: ${m.effect.summary}` : prefix;
  };

  return (
    <div className="space-y-4">
      {notice && (
        <p role="status" className="flex items-center gap-2 text-[13px] text-emerald-800">
          <CheckCircleIcon className="size-4" weight="bold" aria-hidden />
          {notice}
        </p>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}

      <section className="overflow-hidden rounded-[3px] border border-border bg-primary">
        <div className="px-6 py-4">
          <h2 className="text-[15px] font-semibold">Needs attention</h2>
          <p className="text-[13px] text-secondary-foreground">
            These receipts failed a check. They stay out of the P&amp;L and the ledger until you approve them.
          </p>
        </div>
        {!data ? (
          <div className="border-t border-border">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="grid h-16 grid-cols-[9rem_1fr_18rem_14rem] items-center gap-4 border-b border-border px-6">
                <SkeletonBar className="w-20" />
                <SkeletonBar className="w-64" />
                <SkeletonBar className="w-40" />
                <span />
              </div>
            ))}
          </div>
        ) : data.open.length === 0 ? (
          <div className="flex items-center gap-2 border-t border-border px-6 py-8 text-[13px] text-secondary-foreground">
            <CheckCircleIcon className="size-4 text-emerald-700" weight="bold" aria-hidden />
            Nothing needs attention. Every receipt read so far passed its checks
            {status?.receipts.inboxAddress ? ` (forward more to ${status.receipts.inboxAddress})` : ""}.
          </div>
        ) : (
          <div className="border-t border-border">
            <div className="grid h-[34px] grid-cols-[9rem_1fr_18rem_14rem] items-center gap-4 bg-table-header px-6 text-[11px] uppercase tracking-[0.06em] text-secondary-foreground">
              <span>Received</span>
              <span>Receipt</span>
              <span>Problem</span>
              <span className="sr-only">Actions</span>
            </div>
            {data.open.map((item) => (
              <Fragment key={`${item.kind}:${item.id}`}>
                <OpenRow
                  item={item}
                  editing={editing === item.id}
                  busy={busyId === item.id}
                  onEdit={() => setEditing(editing === item.id ? null : item.id)}
                  onRetry={() => act(item.id, `/api/pnl/emails/${encodeURIComponent(item.id)}/retry`, {}, () => `Fetching “${item.subject || "the email"}” again.`)}
                  onIgnoreEmail={() => act(item.id, `/api/pnl/emails/${encodeURIComponent(item.id)}/ignore`, {}, () => `Ignored “${item.subject || "the email"}”.`)}
                />
                {editing === item.id && item.kind === "receipt" && (
                  <AttentionEditor
                    item={item}
                    vendors={vendors}
                    onVendorAdded={(v) => setVendors((vs) => [...vs, v])}
                    onOpenReceipt={onOpenReceipt}
                    onDone={(message) => {
                      setNotice(message);
                      setEditing(null);
                      onChanged();
                    }}
                    onReject={() =>
                      act(item.id, `/api/pnl/receipts/${encodeURIComponent(item.id)}/reject`, { reason: item.reasonLabel }, () => `Moved “${item.subject}” to Rejected. Restore it within 30 days.`)
                    }
                  />
                )}
              </Fragment>
            ))}
          </div>
        )}
      </section>

      {data && data.rejected.length > 0 && (
        <section className="overflow-hidden rounded-[3px] border border-border bg-primary">
          <div className="flex flex-wrap items-baseline gap-x-4 px-6 py-4">
            <h2 className="text-[15px] font-semibold">Rejected</h2>
            <p className="text-[13px] text-secondary-foreground">Not processed. Kept 30 days, then deleted.</p>
          </div>
          {data.rejected.map((item) => (
            <div
              key={item.id}
              className="grid min-h-12 grid-cols-[9rem_1fr_16rem_12rem_7rem] items-center gap-4 border-t border-border px-6 py-2 text-[13px]"
            >
              <span className="tabular-nums text-secondary-foreground">{instantLabel(item.receivedAt)}</span>
              <span className="truncate" title={item.subject}>
                {item.subject || "(no subject)"}
              </span>
              <span className="truncate text-secondary-foreground" title={item.rejectedReason || item.detail}>
                {item.rejectedReason || item.reasonLabel}
              </span>
              <span className="truncate text-secondary-foreground">
                {item.from}
                {item.purgeAt && <span className="block text-xs">Deleted {dateLong(item.purgeAt.slice(0, 10))}</span>}
              </span>
              <span className="text-right">
                {item.kind === "receipt" && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busyId === item.id}
                    onClick={() =>
                      act(item.id, `/api/pnl/receipts/${encodeURIComponent(item.id)}/restore`, {}, effectMessage(`Restored “${item.subject}” to Needs attention`))
                    }
                  >
                    Restore
                  </Button>
                )}
              </span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function OpenRow({
  item,
  editing,
  busy,
  onEdit,
  onRetry,
  onIgnoreEmail,
}: {
  item: AttentionItem;
  editing: boolean;
  busy: boolean;
  onEdit: () => void;
  onRetry: () => void;
  onIgnoreEmail: () => void;
}) {
  return (
    <div
      className={cn(
        "grid min-h-16 grid-cols-[9rem_1fr_18rem_14rem] items-start gap-4 border-b border-border px-6 py-3 text-[13px]",
        editing && "bg-secondary",
      )}
    >
      <span className="pt-0.5 tabular-nums text-secondary-foreground">{instantLabel(item.receivedAt)}</span>
      <div className="min-w-0">
        <div className="truncate font-medium" title={item.subject}>
          {item.subject || "(no subject)"}
        </div>
        <div className="truncate">
          {item.totalMicros != null && (
            <span className="mr-2 font-medium tabular-nums">{money(item.totalMicros, item.currency)}</span>
          )}
          <span className="text-secondary-foreground">{item.from}</span>
        </div>
      </div>
      <div className="min-w-0">
        <div className={cn("flex items-center gap-1.5 font-medium", TONE_TEXT.pending)}>
          {item.kind === "email" ? (
            <WarningCircleIcon className="size-4 shrink-0" weight="bold" aria-hidden />
          ) : (
            <ClockIcon className="size-4 shrink-0" weight="bold" aria-hidden />
          )}
          {item.reasonLabel}
        </div>
        <div className="text-secondary-foreground">{item.detail}</div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {item.kind === "email" ? (
          <>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onRetry}>
              Retry
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onIgnoreEmail}>
              Ignore
            </Button>
          </>
        ) : editing ? (
          <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
            Close editor
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={onEdit}>
            {item.nextStep || "Review"}
          </Button>
        )}
      </div>
    </div>
  );
}

// ── editor ───────────────────────────────────────────────────────────────────

type DraftLine = { description: string; amount: string };
type Draft = {
  vendorId: string;
  invoiceNumber: string;
  issueDate: string;
  currency: string;
  fxRate: string;
  lines: DraftLine[];
  subtotal: string;
  tax: string;
  total: string;
};

function draftFrom(d: ReceiptDetail): Draft {
  const r = d.receipt;
  return {
    vendorId: r.vendorId,
    invoiceNumber: r.invoiceNumber,
    issueDate: r.issueDate ?? "",
    currency: r.currency,
    fxRate: r.fxRate != null ? String(r.fxRate) : "",
    lines: r.lines.map((l) => ({ description: l.description, amount: microsToInput(l.amountMicros) })),
    subtotal: microsToInput(r.subtotalMicros),
    tax: microsToInput(r.taxMicros),
    total: microsToInput(r.totalMicros),
  };
}

// patchFrom returns only the fields the operator changed.
function patchFrom(orig: Draft, d: Draft, receipt: ReceiptDetail["receipt"]): ReceiptPatch {
  const p: ReceiptPatch = {};
  if (d.vendorId !== orig.vendorId) p.vendorId = d.vendorId;
  if (d.invoiceNumber !== orig.invoiceNumber) p.invoiceNumber = d.invoiceNumber.trim();
  if (d.issueDate !== orig.issueDate) p.issueDate = d.issueDate || null;
  if (d.currency !== orig.currency) p.currency = d.currency.trim().toUpperCase();
  if (d.fxRate !== orig.fxRate) p.fxRate = d.fxRate.trim() ? Number(d.fxRate) : null;
  if (d.subtotal !== orig.subtotal) p.subtotalMicros = parseMoney(d.subtotal);
  if (d.tax !== orig.tax) p.taxMicros = parseMoney(d.tax);
  if (d.total !== orig.total) p.totalMicros = parseMoney(d.total);
  if (JSON.stringify(d.lines) !== JSON.stringify(orig.lines)) {
    p.lines = d.lines.map((l, i) => ({
      description: l.description,
      quantityMicros: receipt.lines[i]?.quantityMicros ?? null,
      unitPriceMicros: receipt.lines[i]?.unitPriceMicros ?? null,
      amountMicros: parseMoney(l.amount),
    }));
  }
  return p;
}

// Totals agree within a cent, matching the server's tolerance.
const TOLERANCE = 10_000;

function AttentionEditor({
  item,
  vendors,
  onVendorAdded,
  onOpenReceipt,
  onDone,
  onReject,
}: {
  item: AttentionItem;
  vendors: Vendor[];
  onVendorAdded: (v: Vendor) => void;
  onOpenReceipt: (id: string) => void;
  onDone: (message: string) => void;
  onReject: () => void;
}) {
  const [detail, setDetail] = useState<ReceiptDetail | null>(null);
  const [orig, setOrig] = useState<Draft | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "reextract" | null>(null);
  const [addingVendor, setAddingVendor] = useState(false);

  const load = (d: ReceiptDetail) => {
    const f = draftFrom(d);
    setDetail(d);
    setOrig(f);
    setDraft(f);
    setChecks(d.receipt.checks);
  };

  useEffect(() => {
    const controller = new AbortController();
    api<ReceiptDetail>(`/api/pnl/receipts/${encodeURIComponent(item.id)}`, { signal: controller.signal })
      .then(load)
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "The receipt could not be loaded");
      });
    return () => controller.abort();
  }, [item.id]);

  const calc = useMemo(() => {
    if (!draft) return null;
    const lines = draft.lines.map((l) => parseMoney(l.amount));
    const linesSum = lines.every((v) => v != null) ? lines.reduce<number>((s, v) => s + (v ?? 0), 0) : null;
    const subtotal = parseMoney(draft.subtotal);
    const tax = parseMoney(draft.tax) ?? 0;
    const total = parseMoney(draft.total);
    const linesOk = draft.lines.length === 0 || subtotal == null || (linesSum != null && Math.abs(linesSum - subtotal) <= TOLERANCE);
    // Same rule as the server: with no printed subtotal, the lines stand in.
    const base = subtotal ?? linesSum ?? 0;
    const totalsOk = total != null && Math.abs(base + tax - total) <= TOLERANCE;
    return { linesSum, subtotal, tax, total, linesOk, totalsOk };
  }, [draft]);

  if (error && !detail) {
    return (
      <div className="border-b border-border bg-secondary px-6 py-4">
        <ErrorLine>{error}</ErrorLine>
      </div>
    );
  }
  if (!detail || !draft || !orig || !calc) {
    return (
      <div className="flex items-center gap-2 border-b border-border bg-secondary px-6 py-4 text-[13px] text-secondary-foreground">
        <Loader className="size-4" />
        Loading the receipt…
      </div>
    );
  }

  const r = detail.receipt;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const dirty = JSON.stringify(draft) !== JSON.stringify(orig);
  const foreign = draft.currency.trim().toUpperCase() !== "USD";
  const rate = foreign ? Number(draft.fxRate) : 1;
  const rateOk = !foreign || (draft.fxRate.trim() !== "" && Number.isFinite(rate) && rate > 0);
  const negative = r.kind === "refund" || r.kind === "credit_note";
  const usdTotal = calc.total != null && rateOk ? Math.round(calc.total * rate) * (negative ? -1 : 1) : null;
  const month = draft.issueDate ? monthOf(draft.issueDate) : "";
  const canApprove =
    !busy && !!draft.vendorId && calc.linesOk && calc.totalsOk && rateOk && !!draft.currency.trim() && !!month && usdTotal != null;

  const approve = async () => {
    setBusy("approve");
    setError(null);
    try {
      if (dirty) {
        const res = await api<ReceiptMutation>(`/api/pnl/receipts/${encodeURIComponent(r.id)}`, {
          method: "PATCH",
          json: patchFrom(orig, draft, r),
        });
        setChecks(res.receipt.checks);
      }
      const res = await api<ReceiptMutation>(`/api/pnl/receipts/${encodeURIComponent(r.id)}/approve`, {
        method: "POST",
        json: {},
      });
      onDone(`Approved: ${res.effect.summary}`);
    } catch (e) {
      if (e instanceof HttpError && e.status === 422) {
        const body = e.body as { checks?: Check[] } | null;
        if (body?.checks) setChecks(body.checks);
      }
      setError(e instanceof Error ? e.message : "Approving failed");
    } finally {
      setBusy(null);
    }
  };

  const reextract = async () => {
    setBusy("reextract");
    setError(null);
    try {
      await api<ReceiptMutation>(`/api/pnl/receipts/${encodeURIComponent(r.id)}/reextract`, { method: "POST", json: {} });
      const fresh = await api<ReceiptDetail>(`/api/pnl/receipts/${encodeURIComponent(r.id)}`);
      load(fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Re-extract failed");
    } finally {
      setBusy(null);
    }
  };

  const senderDomain = (detail.email?.forwardedFrom || detail.email?.from || item.from).match(/@([^\s>]+)/)?.[1] ?? "";

  return (
    <div className="border-b border-border bg-secondary px-6 pb-5 pt-1 text-[13px]">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4 rounded-[3px] border border-border bg-primary px-5 py-4">
          <SectionTitle>Extracted</SectionTitle>

          <div className="grid grid-cols-[7rem_1fr] items-center gap-x-4 gap-y-2">
            <label htmlFor={`vendor-${r.id}`} className="text-secondary-foreground">
              Vendor
            </label>
            <div className="flex items-center gap-2">
              <select
                id={`vendor-${r.id}`}
                value={addingVendor ? "__add" : draft.vendorId}
                onChange={(e) => {
                  if (e.target.value === "__add") setAddingVendor(true);
                  else {
                    setAddingVendor(false);
                    set({ vendorId: e.target.value });
                  }
                }}
                className={cn(
                  "h-8 min-w-0 flex-1 rounded-[3px] border bg-primary px-2 outline-none focus:border-foreground",
                  draft.vendorId ? "border-border" : "border-amber-500",
                )}
              >
                <option value="">No vendor matches “{r.merchantName || "the sender"}”</option>
                {vendors
                  .filter((v) => v.category !== "revenue")
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name} · {CATEGORY_LABEL[v.category] ?? v.category}
                    </option>
                  ))}
                <option value="__add">Add a vendor…</option>
              </select>
            </div>
            {addingVendor && (
              <div className="col-span-2">
                <AddVendorForm
                  merchant={r.merchantName}
                  domain={senderDomain}
                  onCancel={() => setAddingVendor(false)}
                  onAdded={(v) => {
                    onVendorAdded(v);
                    setAddingVendor(false);
                    set({ vendorId: v.id });
                  }}
                />
              </div>
            )}

            <label htmlFor={`invoice-${r.id}`} className="text-secondary-foreground">
              Invoice #
            </label>
            <input
              id={`invoice-${r.id}`}
              value={draft.invoiceNumber}
              onChange={(e) => set({ invoiceNumber: e.target.value })}
              className="h-8 rounded-[3px] border border-border bg-primary px-2 outline-none focus:border-foreground"
            />

            <label htmlFor={`date-${r.id}`} className="text-secondary-foreground">
              Invoice date
            </label>
            <input
              id={`date-${r.id}`}
              type="date"
              value={draft.issueDate}
              onChange={(e) => set({ issueDate: e.target.value })}
              className={cn(
                "h-8 w-44 rounded-[3px] border bg-primary px-2 tabular-nums outline-none focus:border-foreground",
                draft.issueDate ? "border-border" : "border-amber-500",
              )}
            />

            <label htmlFor={`currency-${r.id}`} className="text-secondary-foreground">
              Currency
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                id={`currency-${r.id}`}
                value={draft.currency}
                maxLength={3}
                placeholder="USD"
                onChange={(e) => set({ currency: e.target.value.toUpperCase() })}
                className={cn(
                  "h-8 w-16 rounded-[3px] border bg-primary px-2 uppercase outline-none focus:border-foreground",
                  draft.currency.trim() ? "border-border" : "border-amber-500",
                )}
              />
              {!draft.currency.trim() && (
                <button type="button" onClick={() => set({ currency: "USD" })} className="text-[var(--editable)] hover:underline">
                  Use USD
                </button>
              )}
              {foreign && draft.currency.trim() && (
                <>
                  <label htmlFor={`rate-${r.id}`} className="text-secondary-foreground">
                    USD per {draft.currency}
                  </label>
                  <input
                    id={`rate-${r.id}`}
                    value={draft.fxRate}
                    inputMode="decimal"
                    placeholder="rate"
                    onChange={(e) => set({ fxRate: e.target.value })}
                    className={cn(
                      "h-8 w-24 rounded-[3px] border bg-primary px-2 text-right tabular-nums outline-none focus:border-foreground",
                      rateOk ? "border-border" : "border-amber-500",
                    )}
                  />
                  {r.suggestedFxRate != null && String(r.suggestedFxRate) !== draft.fxRate && (
                    <button
                      type="button"
                      onClick={() => set({ fxRate: String(r.suggestedFxRate) })}
                      className="text-[var(--editable)] hover:underline"
                    >
                      Use {r.suggestedFxRate} (last used)
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          <table className="w-full border-collapse">
            <tbody>
              {draft.lines.map((l, i) => (
                <AmountRow
                  key={i}
                  label={l.description || `Line ${i + 1}`}
                  value={l.amount}
                  original={orig.lines[i]?.amount}
                  bad={!calc.linesOk}
                  onChange={(v) => set({ lines: draft.lines.map((x, j) => (j === i ? { ...x, amount: v } : x)) })}
                />
              ))}
              <AmountRow label="Subtotal" value={draft.subtotal} original={orig.subtotal} bad={!calc.linesOk || !calc.totalsOk} onChange={(v) => set({ subtotal: v })} />
              <AmountRow label="Tax" value={draft.tax} original={orig.tax} bad={!calc.totalsOk} onChange={(v) => set({ tax: v })} />
              <AmountRow label="Total" value={draft.total} original={orig.total} bad={!calc.totalsOk} strong onChange={(v) => set({ total: v })} />
            </tbody>
          </table>

          <AddsUp calc={calc} currency={draft.currency} />
        </div>

        <div className="min-w-0 overflow-hidden rounded-[3px] border border-border bg-primary">
          <div className="px-5 pb-2 pt-4">
            <SectionTitle>Original email</SectionTitle>
            <div className="mt-2 truncate font-medium">{detail.email?.subject || item.subject}</div>
            <div className="truncate text-secondary-foreground">
              {detail.email?.forwardedFrom || detail.email?.from || item.from}
            </div>
          </div>
          {detail.email ? (
            <EmailFrame html={detail.email.htmlBody} text={detail.email.textBody} className="h-80" />
          ) : (
            <p className="border-t border-border px-5 py-4 text-secondary-foreground">The email is not stored.</p>
          )}
          {detail.extractions.find((x) => x.current)?.confidenceNotes && (
            <p className="border-t border-border px-5 py-3 text-amber-900">
              The reader was unsure: {detail.extractions.find((x) => x.current)?.confidenceNotes}
            </p>
          )}
        </div>
      </div>

      {checks.length > 0 && (
        <div className="mt-4 space-y-2">
          <SectionTitle>Checks{dirty ? " (as last saved)" : ""}</SectionTitle>
          <Checks checks={checks} />
        </div>
      )}

      {error && (
        <div className="mt-3">
          <ErrorLine>{error}</ErrorLine>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-secondary-foreground">Re-extract replaces your edits with a fresh read of the email.</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenReceipt(r.id)}>
            Details
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onReject} disabled={!!busy}>
            Ignore → Rejected
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={reextract} disabled={!!busy}>
            {busy === "reextract" ? "Reading…" : "Re-extract"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(orig)} disabled={!dirty || !!busy}>
            Discard
          </Button>
          <Button type="button" variant="defaultInverted" size="sm" onClick={approve} disabled={!canApprove}>
            {busy === "approve"
              ? "Approving…"
              : usdTotal != null && month
                ? `Approve ${usd(usdTotal)} → ${monthLabel(month)}`
                : "Approve"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function AmountRow({
  label,
  value,
  original,
  bad,
  strong,
  onChange,
}: {
  label: string;
  value: string;
  original: string | undefined;
  bad: boolean;
  strong?: boolean;
  onChange: (v: string) => void;
}) {
  const changed = original !== undefined && value !== original;
  return (
    <tr className={cn("h-9 border-b border-border last:border-b-0", changed && "bg-red-50")}>
      <td className={cn("pr-3", strong && "font-semibold")}>{label}</td>
      <td className="w-24 text-right tabular-nums">
        {changed && <span className="text-red-700 line-through">{original ? usdLike(original) : "—"}</span>}
      </td>
      <td className="w-32 pl-3 text-right">
        <input
          aria-label={label}
          value={value}
          inputMode="decimal"
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            "h-7 w-28 rounded-[3px] border bg-primary px-2 text-right tabular-nums outline-none focus:border-foreground",
            changed ? "border-foreground" : bad ? "border-amber-500" : "border-transparent hover:border-border",
            strong && "font-semibold",
          )}
        />
      </td>
    </tr>
  );
}

function usdLike(input: string): string {
  const m = parseMoney(input);
  return m == null ? input : (m / 1_000_000).toFixed(2);
}

function AddsUp({
  calc,
  currency,
}: {
  calc: { linesSum: number | null; subtotal: number | null; tax: number; total: number | null; linesOk: boolean; totalsOk: boolean };
  currency: string;
}) {
  const f = (v: number | null) => (v == null ? "—" : money(v, currency));
  if (calc.linesOk && calc.totalsOk) {
    // Without a printed subtotal the line items stand in for it, as on the
    // server; never show the total in the subtotal's place.
    const base = calc.subtotal ?? calc.linesSum ?? 0;
    return (
      <p className={cn("flex items-center gap-1.5", TONE_TEXT.positive)}>
        <CheckCircleIcon className="size-4" weight="bold" aria-hidden />
        Adds up: {f(base)} + {f(calc.tax)} = {f(calc.total)}
      </p>
    );
  }
  return (
    <p className={cn("flex items-center gap-1.5", TONE_TEXT.pending)}>
      <ClockIcon className="size-4" weight="bold" aria-hidden />
      {!calc.linesOk
        ? `Line items ${f(calc.linesSum)} ≠ subtotal ${f(calc.subtotal)}`
        : `Subtotal ${f(calc.subtotal ?? calc.linesSum ?? 0)} + tax ${f(calc.tax)} ≠ total ${f(calc.total)}`}
    </p>
  );
}

const CATEGORIES: VendorCategory[] = ["infra", "email", "domains", "social", "ai"];

function AddVendorForm({
  merchant,
  domain,
  onCancel,
  onAdded,
}: {
  merchant: string;
  domain: string;
  onCancel: () => void;
  onAdded: (v: Vendor) => void;
}) {
  const [name, setName] = useState(merchant.replace(/,?\s*(inc|llc|ltd|corp|corporation)\.?$/i, ""));
  const [category, setCategory] = useState<VendorCategory>("infra");
  const [pattern, setPattern] = useState(merchant);
  const [senderDomain, setSenderDomain] = useState(domain);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ vendor: Vendor }>("/api/pnl/vendors", {
        method: "POST",
        json: { name: name.trim(), category, merchantPattern: pattern.trim(), senderDomain: senderDomain.trim() },
      });
      onAdded(res.vendor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Adding the vendor failed");
    } finally {
      setBusy(false);
    }
  };

  const field = "h-8 rounded-[3px] border border-border bg-primary px-2 outline-none focus:border-foreground";
  return (
    <div className="space-y-3 rounded-[3px] border border-border bg-secondary px-4 py-3">
      <div className="grid grid-cols-[9rem_1fr] items-center gap-x-3 gap-y-2">
        <label className="text-secondary-foreground" htmlFor="vendor-name">
          Name
        </label>
        <input id="vendor-name" className={field} value={name} onChange={(e) => setName(e.target.value)} />
        <label className="text-secondary-foreground" htmlFor="vendor-category">
          Category
        </label>
        <select
          id="vendor-category"
          className={field}
          value={category}
          onChange={(e) => setCategory(e.target.value as VendorCategory)}
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
        <label className="text-secondary-foreground" htmlFor="vendor-pattern">
          Merchant name has
        </label>
        <input id="vendor-pattern" className={field} value={pattern} onChange={(e) => setPattern(e.target.value)} />
        <label className="text-secondary-foreground" htmlFor="vendor-domain">
          Sender domain
        </label>
        <input
          id="vendor-domain"
          className={field}
          value={senderDomain}
          onChange={(e) => setSenderDomain(e.target.value)}
        />
      </div>
      <p className="text-secondary-foreground">Future receipts that match are booked to this vendor automatically.</p>
      {error && <ErrorLine>{error}</ErrorLine>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" variant="defaultInverted" size="sm" onClick={save} disabled={busy || !name.trim()}>
          {busy ? "Adding…" : `Add ${name.trim() || "vendor"}`}
        </Button>
      </div>
    </div>
  );
}
