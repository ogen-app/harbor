"use client";

import { ModelAssignmentTab } from "@/components/model-config/ModelAssignmentTab";

// Model assignment is the operator view of Ogen's per-flow / per-tier model
// configuration with pricing (CON-309, the UI counterpart to CON-308's
// ModelConfigAdminService). Structurally it mirrors /platforms: a page header +
// a single self-contained table card, with all editing in a right-side drawer.
export default function ModelAssignmentPage() {
  return (
    <main className="flex-1 min-h-0 overflow-hidden flex flex-col">
      <header className="h-20 border-b border-border flex items-center justify-between px-6 shrink-0">
        <h1 className="text-2xl font-display font-medium">Model assignment</h1>
      </header>

      <div className="flex-1 min-h-0 p-6">
        <ModelAssignmentTab />
      </div>
    </main>
  );
}
