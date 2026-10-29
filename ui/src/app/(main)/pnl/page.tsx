"use client";

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { PnlHeader } from "@/components/pnl/PnlHeader";
import { ProfitLossTab } from "@/components/pnl/ProfitLossTab";
import { LedgerTab, drillFromSearch, drillToTokens, type LedgerToken } from "@/components/pnl/LedgerTab";
import { AttentionTab } from "@/components/pnl/AttentionTab";
import { AiCreditsTab } from "@/components/pnl/AiCreditsTab";
import { ReceiptDrawer } from "@/components/pnl/ReceiptDrawer";
import { DateRangePicker, type DateRange } from "@/components/ui/date-range-picker";
import { api, isoDate, todayUTC } from "@/components/pnl/format";
import type { Drill, PnlStatus } from "@/components/pnl/types";

// Profit & loss (CON-412/420): Ogen's money in and out, for operators only.
// Tab 1 is the monthly P&L, tab 2 the ledger every figure drills into, tab 3
// the receipts that failed a check and stay out of the books until approved,
// tab 4 the prepaid AI credits and the estimate-vs-charged reconciliation.
// The header on every tab says how complete the data is.
//
// Deep links: ?tab=ledger|attention|credits opens that tab; ?tab=ledger with
// from/to (and vendor, type, source, tenant) opens the Ledger filtered to a
// drill, as the tenant Profit & loss tab links it.
const TABS = [
  { key: "pnl", label: "Profit & loss" },
  { key: "ledger", label: "Ledger" },
  { key: "attention", label: "Needs attention" },
  { key: "credits", label: "AI credits" },
] as const;

const tabId = (i: number) => `pnl-tab-${i}`;
const tabPanelId = (i: number) => `pnl-tabpanel-${i}`;

// The P&L defaults to the last six whole months up to today; the ledger to
// this month so far.
function defaultPnlRange(): DateRange {
  const t = todayUTC();
  return {
    from: isoDate(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 5, 1))),
    to: isoDate(t),
  };
}
function defaultLedgerRange(): DateRange {
  const t = todayUTC();
  return { from: isoDate(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1))), to: isoDate(t) };
}

const STATUS_POLL_MS = 60_000;

export default function PnlPage() {
  const [tab, setTab] = useState(0);
  const [status, setStatus] = useState<PnlStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  // Bumped after every mutation so all tabs and the header refetch.
  const [version, setVersion] = useState(0);
  const [pnlRange, setPnlRange] = useState<DateRange>(defaultPnlRange);
  const [compare, setCompare] = useState(false);
  const [ledgerRange, setLedgerRange] = useState<DateRange>(defaultLedgerRange);
  const [ledgerTokens, setLedgerTokens] = useState<LedgerToken[]>([]);
  const [receiptId, setReceiptId] = useState<string | null>(null);

  // Read the deep link once on mount.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const i = TABS.findIndex((t) => t.key === q.get("tab"));
    /* eslint-disable react-hooks/set-state-in-effect */
    if (i >= 0) setTab(i);
    const d = TABS[i]?.key === "ledger" ? drillFromSearch(q) : null;
    if (d) {
      setLedgerRange({ from: d.from, to: d.to });
      setLedgerTokens(drillToTokens(d));
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  // Keep the URL in step so the view can be shared or reloaded.
  useEffect(() => {
    const q = new URLSearchParams();
    if (tab > 0) q.set("tab", TABS[tab].key);
    const qs = q.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [tab]);

  // Number keys 1..N jump straight to a tab. Ignored while typing in a field or
  // with a dialog/drawer open, so it never eats a keystroke.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
          target.closest?.('[role="combobox"],[role="textbox"],[role="dialog"]'))
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= TABS.length) {
        e.preventDefault();
        setTab(n - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Status drives the header and the "N pending" tab badge; polled so the
  // freshness line stays honest while the page is open.
  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      api<PnlStatus>("/api/pnl/status", { signal: controller.signal })
        .then((s) => {
          setStatus(s);
          setStatusError(null);
        })
        .catch((e: unknown) => {
          if (controller.signal.aborted) return;
          setStatusError(e instanceof Error ? e.message : "Status unavailable");
        });
    load();
    const timer = window.setInterval(load, STATUS_POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [version]);

  const changed = useCallback(() => setVersion((v) => v + 1), []);

  // A P&L amount opens the ledger filtered to exactly its entries.
  const drill = useCallback((d: Drill) => {
    setLedgerRange({ from: d.from, to: d.to });
    setLedgerTokens(drillToTokens(d));
    setTab(1);
  }, []);

  const openAttention = useCallback(() => setTab(2), []);

  const pending = status?.attention.open ?? 0;

  return (
    <main className="flex flex-1 flex-col overflow-auto">
      <PnlHeader status={status} error={statusError} />

      <div className="space-y-5 p-6">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b border-border">
          <div role="tablist" className="flex gap-6 overflow-x-auto">
            {TABS.map(({ key, label }, i) => (
              <button
                key={key}
                id={tabId(i)}
                type="button"
                role="tab"
                aria-selected={i === tab}
                aria-controls={tabPanelId(i)}
                aria-keyshortcuts={String(i + 1)}
                onClick={() => setTab(i)}
                className={cn(
                  "relative -mb-px flex shrink-0 cursor-pointer items-center gap-2 border-b-2 py-3 text-sm whitespace-nowrap outline-none transition-colors",
                  i === tab
                    ? "border-foreground font-semibold text-foreground"
                    : "border-transparent font-medium text-secondary-foreground hover:text-foreground",
                )}
              >
                {label}
                <span
                  aria-hidden
                  className="inline-flex size-4 items-center justify-center rounded-[3px] border border-border text-[10px] font-normal text-secondary-foreground"
                >
                  {i + 1}
                </span>
                {key === "attention" && pending > 0 && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
                    {pending} pending
                  </span>
                )}
              </button>
            ))}
          </div>
          {tab === 0 && (
            <DateRangePicker
              value={pnlRange}
              compare={compare}
              mode="month"
              onChange={(r, c) => {
                setPnlRange(r);
                setCompare(c);
              }}
              className="mb-2"
            />
          )}
        </div>

        <div
          role="tabpanel"
          id={tabPanelId(tab)}
          aria-labelledby={tabId(tab)}
          tabIndex={-1}
          className="outline-none"
        >
          {tab === 0 && (
            <ProfitLossTab
              status={status}
              range={pnlRange}
              compare={compare}
              version={version}
              onDrill={drill}
              onReviewAttention={openAttention}
            />
          )}
          {tab === 1 && (
            <LedgerTab
              status={status}
              range={ledgerRange}
              onRangeChange={setLedgerRange}
              tokens={ledgerTokens}
              onTokensChange={setLedgerTokens}
              version={version}
              onOpenReceipt={setReceiptId}
              onReviewAttention={openAttention}
            />
          )}
          {tab === 2 && (
            <AttentionTab
              status={status}
              version={version}
              onChanged={changed}
              onOpenReceipt={setReceiptId}
            />
          )}
          {tab === 3 && <AiCreditsTab version={version} onChanged={changed} />}
        </div>
      </div>

      <ReceiptDrawer
        receiptId={receiptId}
        onClose={() => setReceiptId(null)}
        onChanged={changed}
        onShowInLedger={(d) => {
          setReceiptId(null);
          drill(d);
        }}
        onReviewAttention={() => {
          setReceiptId(null);
          openAttention();
        }}
      />
    </main>
  );
}
