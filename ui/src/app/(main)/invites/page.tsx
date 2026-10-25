"use client";

import { InvitesTable } from "@/components/invites/InvitesTable";

// Invites is the operator view of Ogen's complimentary tester invites
// (CON-333/334): invite alpha/beta testers onto any tier with a published
// version, track each invite's delivery and the workspace it became, and resend
// or revoke. Structurally it mirrors /announcements: a page header + a single
// self-contained table card.
export default function InvitesPage() {
  return (
    <main className="flex-1 overflow-auto flex flex-col">
      <header className="h-20 border-b border-border flex items-center justify-between px-6 shrink-0">
        <h1 className="text-2xl font-display font-medium">Invites</h1>
      </header>

      <div className="p-6 space-y-6">
        <InvitesTable />
      </div>
    </main>
  );
}
