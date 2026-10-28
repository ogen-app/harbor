"use client";

import { EnvelopeSimpleIcon } from "@phosphor-icons/react";
import type { PnlStatus } from "./types";

// EmptyInbox is the empty state for the P&L and the ledger (Appendix A.5): it
// teaches where the numbers come from, starting with the receipts inbox.
export function EmptyInbox({ status, title }: { status: PnlStatus | null; title: string }) {
  const address = status?.receipts.inboxAddress;
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <EnvelopeSimpleIcon className="size-6 text-secondary-foreground" aria-hidden />
      <h3 className="text-[15px] font-medium">{title}</h3>
      <div className="max-w-lg space-y-1.5 text-[13px] text-secondary-foreground">
        <p>
          {address ? (
            <>
              Forward vendor receipts (Resend, Railway, Cloudflare, Zernio) to{" "}
              <span className="font-medium text-foreground">{address}</span>. Each one lands here within a
              minute.
            </>
          ) : (
            <>Vendor receipts arrive through the receipts inbox, which has no address configured yet.</>
          )}
        </p>
        <p>AI usage is added every day from the token-cost data, and payments sync every 15 minutes.</p>
        {status && !status.receipts.everReceived && <p>No receipt has been forwarded yet.</p>}
      </div>
    </div>
  );
}
