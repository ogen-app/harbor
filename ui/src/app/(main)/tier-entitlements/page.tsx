"use client";

import { useState } from "react";
import { LicenseIcon } from "@hugeicons/core-free-icons";
import {
  TierEntitlementsMatrix,
  type EntitlementsSummary,
} from "@/components/tier-entitlements/TierEntitlementsMatrix";
import { plural } from "@/components/tier-entitlements/model";
import {
  HelpButton,
  HelpPanel,
  useHelpPanel,
} from "@/components/ui/help-panel";

// Tier entitlements is the operator view of Ogen's versioned tier entitlements
// (CON-243/294/296, redesigned in CON-321): a page header with a one-line
// summary and the help trigger, then the ledger of tiers in price order with
// drafts staged in place. The page explanation lives in the help panel.
export default function TierEntitlementsPage() {
  const [summary, setSummary] = useState<EntitlementsSummary | null>(null);
  const { open: helpOpen, setOpen: setHelpOpen, triggerRef: helpTriggerRef } =
    useHelpPanel();

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-20 shrink-0 items-center justify-between gap-6 border-b border-border px-6">
        <h1 className="font-display text-2xl font-medium">Tier entitlements</h1>
        <div className="flex items-center gap-4">
          {summary && (
            <p className="flex items-center gap-2 text-[13px] text-secondary-foreground">
              <span>{plural(summary.features, "feature")}</span>
              <span className="text-tertiary-foreground">·</span>
              <span>{plural(summary.onSale, "tier")} on sale</span>
              {summary.drafts > 0 && (
                <>
                  <span className="text-tertiary-foreground">·</span>
                  <span className="font-medium text-editable">{plural(summary.drafts, "draft")}</span>
                </>
              )}
              {summary.notSet > 0 && (
                <>
                  <span className="text-tertiary-foreground">·</span>
                  <span className="font-medium text-amber-700">{summary.notSet} not set</span>
                </>
              )}
            </p>
          )}
          <HelpButton
            ref={helpTriggerRef}
            open={helpOpen}
            onToggle={() => setHelpOpen((o) => !o)}
          />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 p-6">
        <div className="h-full min-w-0 flex-1">
          <TierEntitlementsMatrix onSummary={setSummary} />
        </div>
      </div>

      <HelpPanel
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        triggerRef={helpTriggerRef}
        icon={LicenseIcon}
        title="Tier entitlements"
        lead="What each tier includes. Published versions never change: edits go into a draft, and tenants stay on their version until you move them."
        items={[
          {
            title: "Live and draft",
            body: "Live is what new purchases get, and it is locked. Drafts are safe to edit: nothing reaches tenants until you publish.",
          },
          {
            title: "Not set",
            body: "A missing value means no limit. Ogen fails open, so set a value or tenants get the feature free.",
          },
          {
            title: "Internal tier",
            body: "Default holds workspaces created before pricing. It is not sold and is left out of tier comparisons.",
          },
          {
            title: "Periods",
            body: "Per month resets monthly, per post applies to each post, and lifetime never resets.",
          },
        ]}
        shortcuts={[
          { keys: ["j", "k"], label: "move between rows" },
          { keys: ["h", "l"], label: "move between tiers" },
          { keys: ["↵"], label: "edit the cell (draft)" },
          { keys: ["/"], label: "filter features" },
          { keys: ["d"], label: "show or hide drafts" },
          { keys: ["?"], label: "show or hide this help" },
        ]}
      />
    </main>
  );
}
