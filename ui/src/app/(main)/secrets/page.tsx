"use client";

import { useEffect, useState, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { SecretsTab } from "@/components/settings/SecretsTab";

// Tabbed settings. Secrets is the first (and, for now, only) tab; the array is
// the seam for adding more later (Variables, etc.). Mirrors the tenant-detail
// tab pattern: role="tablist" + number-key switching.
const SETTINGS_TABS = ["Secrets"] as const;

const tabId = (i: number) => `settings-tab-${i}`;
const tabPanelId = (i: number) => `settings-tabpanel-${i}`;

// Tab-panel ARIA wiring is applied only when the tablist actually renders
// (>1 tab). With a single tab there is no tab button to point at, so
// aria-labelledby would dangle — fall back to a plain container instead.
const panelProps = (i: number): HTMLAttributes<HTMLDivElement> =>
  SETTINGS_TABS.length > 1
    ? { role: "tabpanel", id: tabPanelId(i), "aria-labelledby": tabId(i), tabIndex: 0 }
    : {};

export default function SecretsPage() {
  const [tab, setTab] = useState(0);

  // Number keys 1..N jump straight to a tab (page-level, no focus needed).
  // Ignored while typing in a field so it never eats a keystroke.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
          target.closest?.('[role="combobox"],[role="textbox"]'))
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= SETTINGS_TABS.length) {
        e.preventDefault();
        setTab(n - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <main className="flex-1 overflow-auto flex flex-col">
      <header className="h-20 border-b border-border flex items-center justify-between px-6 shrink-0">
        <h1 className="text-2xl font-display font-medium">Secrets</h1>
      </header>

      <div className="p-6 space-y-6">
        {/* White card wrapping the content, matching the /databases page. */}
        <div className="overflow-hidden rounded-lg bg-primary p-6">
          <SecretsTab />
        </div>
      </div>
    </main>
  );
}
