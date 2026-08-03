"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { SecretsTab } from "@/components/settings/SecretsTab";

// Tabbed settings. Secrets is the first (and, for now, only) tab; the array is
// the seam for adding more later (Variables, etc.). Mirrors the tenant-detail
// tab pattern: role="tablist" + number-key switching.
const SETTINGS_TABS = ["Secrets"] as const;

const tabId = (i: number) => `settings-tab-${i}`;
const tabPanelId = (i: number) => `settings-tabpanel-${i}`;

export default function SettingsPage() {
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
        <h1 className="text-2xl font-display font-medium">Settings</h1>
      </header>

      <div className="p-6 space-y-6">
        {/* Tabs — hidden while there's only one, but wired for growth. */}
        {SETTINGS_TABS.length > 1 && (
          <div
            role="tablist"
            className="flex gap-6 overflow-x-auto border-b border-border"
          >
            {SETTINGS_TABS.map((label, i) => (
              <button
                key={label}
                id={tabId(i)}
                type="button"
                role="tab"
                aria-selected={i === tab}
                aria-controls={tabPanelId(i)}
                aria-keyshortcuts={String(i + 1)}
                onClick={() => setTab(i)}
                className={cn(
                  "relative -mb-px flex shrink-0 items-center gap-2 border-b-2 py-3 text-sm whitespace-nowrap transition-colors outline-none cursor-pointer",
                  i === tab
                    ? "border-foreground font-semibold text-foreground"
                    : "border-transparent font-medium text-tertiary-foreground hover:text-secondary-foreground",
                )}
              >
                {label}
                <span
                  aria-hidden
                  className="inline-flex size-4 items-center justify-center rounded-[3px] border border-border text-[10px] font-normal text-tertiary-foreground"
                >
                  {i + 1}
                </span>
              </button>
            ))}
          </div>
        )}

        {tab === 0 && (
          <div
            role="tabpanel"
            id={tabPanelId(0)}
            aria-labelledby={tabId(0)}
            tabIndex={0}
          >
            <SecretsTab />
          </div>
        )}
      </div>
    </main>
  );
}
