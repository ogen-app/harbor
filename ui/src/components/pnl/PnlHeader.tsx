"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { ago, dateLong, instantLabel } from "./format";
import { StateDot } from "./shared";
import type { PnlStatus } from "./types";

// PnlHeader is the page header shown on every tab: how complete the data is
// (AI cost through …, revenue synced …), the receipts inbox address and the time
// of the last receipt (Appendix A.1.2). Stale turns amber, unavailable red, each
// with its reason in words.
export function PnlHeader({ status, error }: { status: PnlStatus | null; error: string | null }) {
  return (
    <header className="flex min-h-20 shrink-0 flex-wrap items-center justify-between gap-x-8 gap-y-2 border-b border-border px-6 py-3">
      <h1 className="font-display text-2xl font-medium">Profit &amp; loss</h1>
      {status ? (
        <div className="flex flex-col items-end gap-1 text-[13px]">
          <div className="flex flex-wrap justify-end gap-x-5 gap-y-1">
            <AiFreshness s={status.aiUsage} />
            <RevenueFreshness s={status.revenue} />
          </div>
          <div className="flex flex-wrap items-center justify-end gap-x-2 text-secondary-foreground">
            <span>Inbox</span>
            {status.receipts.inboxAddress ? (
              <InboxAddress address={status.receipts.inboxAddress} />
            ) : (
              <span className="text-foreground">not set</span>
            )}
            <span aria-hidden>·</span>
            <span>
              {status.receipts.lastReceivedAt
                ? `Last receipt ${instantLabel(status.receipts.lastReceivedAt)}`
                : "No receipts yet"}
            </span>
            {status.receipts.pendingEmails > 0 && (
              <>
                <span aria-hidden>·</span>
                <span className="text-amber-900">{status.receipts.pendingEmails} being read</span>
              </>
            )}
          </div>
        </div>
      ) : error ? (
        <StateDot state="unavailable">Status unavailable: {error}</StateDot>
      ) : (
        <span className="text-[13px] text-secondary-foreground">Checking data freshness…</span>
      )}
    </header>
  );
}

function AiFreshness({ s }: { s: PnlStatus["aiUsage"] }) {
  if (s.state === "unavailable") {
    return (
      <StateDot state="unavailable" title={s.error}>
        AI cost unavailable{s.error ? `: ${s.error}` : ""}
      </StateDot>
    );
  }
  const through = s.throughDate ? dateLong(s.throughDate) : "—";
  return (
    <StateDot state={s.state} title={s.lastRunAt ? `Last run ${instantLabel(s.lastRunAt)}` : undefined}>
      {s.state === "stale"
        ? `AI cost behind: through ${through} (UTC)${s.error ? `, ${s.error}` : ""}`
        : `AI cost through ${through} (UTC)`}
    </StateDot>
  );
}

function RevenueFreshness({ s }: { s: PnlStatus["revenue"] }) {
  const mode = s.testMode ? " · test mode" : "";
  if (s.state === "unavailable") {
    return (
      <StateDot state="unavailable" title={s.error}>
        Revenue unavailable{s.error ? `: ${s.error}` : ""}
      </StateDot>
    );
  }
  if (s.state === "stale") {
    return (
      <StateDot state="stale" title={s.error}>
        Revenue sync failing, last synced {ago(s.lastSyncAt)}
        {mode}
      </StateDot>
    );
  }
  return (
    <StateDot state="ok">
      Revenue synced {ago(s.lastSyncAt)}
      {mode}
    </StateDot>
  );
}

function InboxAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy the inbox address"
      onClick={() => {
        navigator.clipboard
          ?.writeText(address)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {});
      }}
      className="inline-flex items-center gap-1 font-medium text-foreground hover:underline underline-offset-2"
    >
      {address}
      {copied ? (
        <CheckIcon className="size-3.5 text-emerald-700" weight="bold" aria-label="Copied" />
      ) : (
        <CopyIcon className="size-3.5 text-secondary-foreground" aria-hidden />
      )}
    </button>
  );
}
