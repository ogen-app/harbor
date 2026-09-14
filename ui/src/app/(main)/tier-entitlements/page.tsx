"use client";

import { TierEntitlementsMatrix } from "@/components/tier-entitlements/TierEntitlementsMatrix";

// Tier entitlements is the operator view of Ogen's versioned tier entitlements
// (CON-243/294/296): the feature × tier-version matrix. Structurally it mirrors
// /platforms — a page header + a single self-contained table card. Version
// authoring (draft/publish/retire/clone) and tenant assignment arrive in later
// iterations.
export default function TierEntitlementsPage() {
  return (
    <main className="flex-1 overflow-auto flex flex-col">
      <header className="h-20 border-b border-border flex items-center justify-between px-6 shrink-0">
        <h1 className="text-2xl font-display font-medium">Tier entitlements</h1>
      </header>

      <div className="p-6 space-y-6">
        <TierEntitlementsMatrix />
      </div>
    </main>
  );
}
