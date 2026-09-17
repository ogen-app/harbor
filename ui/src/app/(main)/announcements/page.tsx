"use client";

import { AnnouncementsTable } from "@/components/announcements/AnnouncementsTable";

// Announcements is the operator view of Ogen's tenant announcements (CON-230/300)
// — author informational banners, target them at all tenants or specific groups
// and tiers, schedule a showing window, publish/archive them, and read their
// click/dismiss stats. Structurally it mirrors /platforms: a page header + a
// single self-contained table card.
export default function AnnouncementsPage() {
  return (
    <main className="flex-1 overflow-auto flex flex-col">
      <header className="h-20 border-b border-border flex items-center justify-between px-6 shrink-0">
        <h1 className="text-2xl font-display font-medium">Announcements</h1>
      </header>

      <div className="p-6 space-y-6">
        <AnnouncementsTable />
      </div>
    </main>
  );
}
