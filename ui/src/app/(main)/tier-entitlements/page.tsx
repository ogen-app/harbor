"use client";

import { StatusLegend } from "@/components/tier-entitlements/legend";
import { TierEntitlementsMatrix } from "@/components/tier-entitlements/TierEntitlementsMatrix";

// Tier entitlements is the operator view of Ogen's versioned tier entitlements
// (CON-243/294/296): the feature × tier-version matrix. The page header carries
// the title plus the status legend and a short description; the matrix card
// below is the table itself. Version authoring (draft/publish/retire/clone) and
// tenant assignment arrive in later iterations.
export default function TierEntitlementsPage() {
  return (
    <main className="flex-1 overflow-auto flex flex-col">
      <header className="min-h-20 border-b border-border flex flex-wrap items-center justify-between gap-x-8 gap-y-3 px-6 py-4 shrink-0">
        <h1 className="text-2xl font-display font-medium">Tier entitlements</h1>
        <div className="flex min-w-0 flex-col items-start gap-1.5">
          <StatusLegend />
          <p className="max-w-3xl text-xs text-tertiary-foreground">
            Every catalog feature against each tier’s live version. Values come
            from the version’s entitlements; ∞ is unlimited, ✓ an enabled
            capability, — not granted. Read-only for now — authoring and
            assignment arrive next.
          </p>
        </div>
      </header>

      <div className="p-6 space-y-6">
        <TierEntitlementsMatrix />
      </div>
    </main>
  );
}
