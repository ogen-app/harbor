"use client";

import { BillingOverview } from "@/components/billing/BillingOverview";

// Billing is the operator's oversight of Lemon Squeezy billing (CON-322/327):
// which workspaces need a decision (Ogen never changes a tier or status on its
// own), the free-month offer, and the sandbox→live cutover. Per-workspace detail
// lives in the tenant page's Billing tab.
export default function BillingPage() {
  return (
    <main className="flex-1 overflow-auto flex flex-col">
      <header className="h-20 border-b border-border flex items-center justify-between px-6 shrink-0">
        <h1 className="text-2xl font-display font-medium">Billing</h1>
      </header>

      <div className="p-6 space-y-6">
        <BillingOverview />
      </div>
    </main>
  );
}
