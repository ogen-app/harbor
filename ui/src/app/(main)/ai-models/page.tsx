"use client";

import { useState } from "react";
import { AiGenerativeIcon } from "@hugeicons/core-free-icons";
import {
  ModelAssignmentTab,
  type ModelConfigSummary,
} from "@/components/model-config/ModelAssignmentTab";
import {
  HelpButton,
  HelpPanel,
  useHelpPanel,
} from "@/components/ui/help-panel";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Model assignment is the operator view of Ogen's per-flow / per-tier model
// configuration with pricing (CON-309, the UI counterpart to CON-308's
// ModelConfigAdminService). A page header with a one-line summary and the help
// trigger, then a single full-width ledger; all editing happens in a
// right-side drawer, and the page explanation lives in the help panel (CON-320).
export default function ModelAssignmentPage() {
  const [summary, setSummary] = useState<ModelConfigSummary | null>(null);
  const { open: helpOpen, setOpen: setHelpOpen, triggerRef: helpTriggerRef } =
    useHelpPanel();

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-20 shrink-0 items-center justify-between gap-6 border-b border-border px-6">
        <h1 className="font-display text-2xl font-medium">AI models</h1>
        <div className="flex items-center gap-4">
          {summary && (
            <p className="flex items-center gap-2 text-[13px] text-secondary-foreground">
              <span>{plural(summary.flows, "flow")}</span>
              {summary.system > 0 && (
                <>
                  <span className="text-tertiary-foreground">·</span>
                  <span>{summary.system} system</span>
                </>
              )}
              <span className="text-tertiary-foreground">·</span>
              <span>{plural(summary.slots, "slot")}</span>
              <span className="text-tertiary-foreground">·</span>
              <span
                className={
                  summary.overrides > 0 ? "font-medium text-editable" : undefined
                }
              >
                {plural(summary.overrides, "tier override")}
              </span>
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
          <ModelAssignmentTab onSummary={setSummary} />
        </div>
      </div>

      <HelpPanel
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        triggerRef={helpTriggerRef}
        icon={AiGenerativeIcon}
        title="AI models"
        lead="Every generation flow runs on the model you pick here. Saved changes apply on the next run, with no deploy."
        items={[
          {
            title: "Global default",
            body: "Every tier uses the slot's default model.",
          },
          {
            title: "Tier overrides",
            body: "Swap the model for one tier. Shown in blue.",
          },
          {
            title: "Global-only slots",
            body: "Embeddings use one model for every tenant.",
          },
          {
            title: "System flows",
            body: "Run for Harbor itself, not tenants. No tiers.",
          },
          {
            title: "Prices",
            body: "USD per 1M tokens, from the current price list.",
          },
        ]}
        shortcuts={[
          { keys: ["j", "k"], label: "Move between rows" },
          { keys: ["↵"], label: "Open the selected flow" },
          { keys: ["1", "–", "4"], label: "Switch tier tab in the editor" },
          { keys: ["?"], label: "Show or hide this help" },
          { keys: ["Esc"], label: "Close the panel or the editor" },
        ]}
      />
    </main>
  );
}
