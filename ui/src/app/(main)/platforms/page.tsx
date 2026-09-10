"use client";

import { PlatformsTab } from "@/components/platforms/PlatformsTab";

// Platforms is the operator view of Ogen's publishable social-platform catalog
// (CON-292/293). Structurally it mirrors /secrets: a page header + a single
// self-contained table card. Catalog writes (add/edit/enable/delete) and the
// global-limits panel arrive in later iterations.
export default function PlatformsPage() {
  return (
    <main className="flex-1 overflow-auto flex flex-col">
      <header className="h-20 border-b border-border flex items-center justify-between px-6 shrink-0">
        <h1 className="text-2xl font-display font-medium">Platforms</h1>
      </header>

      <div className="p-6 space-y-6">
        {/* PlatformsTab is its own card (like the /tenants table), so it's
            rendered directly without another white-card wrapper. */}
        <PlatformsTab />
      </div>
    </main>
  );
}
