"use client";

import { SignupModeCard } from "@/components/invites/SignupModeCard";

// Signup mode is the operator switch for Ogen's self-registration (CON-333/334):
// invite-only (strangers can't sign up; tester invites are the only way in) or
// open. Tester invites work in both modes. One hero card with the switch, plus
// the workspace cap while invite-only is on.
export default function SignupModePage() {
  return (
    <main className="flex-1 overflow-auto flex flex-col">
      <header className="h-20 border-b border-border flex items-center justify-between px-6 shrink-0">
        <h1 className="text-2xl font-display font-medium">Signup mode</h1>
      </header>

      <div className="p-6 space-y-6">
        <SignupModeCard />
      </div>
    </main>
  );
}
