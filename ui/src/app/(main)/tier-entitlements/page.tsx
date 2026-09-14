"use client";

import { Info } from "lucide-react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { StatusLegend } from "@/components/tier-entitlements/legend";
import { TierEntitlementsMatrix } from "@/components/tier-entitlements/TierEntitlementsMatrix";

// Tier entitlements is the operator view of Ogen's versioned tier entitlements
// (CON-243/294/296): the feature × tier-version matrix. The title carries an
// info affordance whose hover card holds the status legend + a short
// description; the matrix fills the remaining page height. Version authoring
// (draft/publish/retire/clone) and tenant assignment arrive in later iterations.
export default function TierEntitlementsPage() {
  return (
    <main className="flex-1 min-h-0 overflow-hidden flex flex-col">
      <header className="h-20 border-b border-border flex items-center gap-2 px-6 shrink-0">
        <h1 className="text-2xl font-display font-medium">Tier entitlements</h1>
        <HoverCard openDelay={80} closeDelay={80}>
          <HoverCardTrigger asChild>
            <button
              type="button"
              aria-label="About the feature-distribution table"
              className="rounded-full p-0.5 text-tertiary-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border"
            >
              <Info className="size-5" />
            </button>
          </HoverCardTrigger>
          <HoverCardContent align="start" className="flex w-96 flex-col gap-3">
            <StatusLegend />
            <p className="text-xs leading-relaxed text-tertiary-foreground">
              Every catalog feature against each tier’s live version. Values come
              from the version’s entitlements; ∞ is unlimited, ✓ an enabled
              capability, — not granted. Read-only for now — authoring and
              assignment arrive next.
            </p>
          </HoverCardContent>
        </HoverCard>
      </header>

      <div className="flex-1 min-h-0 p-6">
        <TierEntitlementsMatrix />
      </div>
    </main>
  );
}
