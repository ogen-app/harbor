"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { CatalogTab } from "@/components/tiers-groups/CatalogTab";
import { TIER_CONFIG, GROUP_CONFIG } from "@/components/tiers-groups/types";

// Tiers is the default tab; Groups second. Mirrors the tenant-detail tab
// pattern: role="tablist" + number-key switching + a dim keyboard hint.
const TABS = [
  { label: "Tiers", config: TIER_CONFIG },
  { label: "Groups", config: GROUP_CONFIG },
] as const;

const tabId = (i: number) => `tg-tab-${i}`;
const tabPanelId = (i: number) => `tg-tabpanel-${i}`;

export default function TiersAndGroupsPage() {
  const [tab, setTab] = useState(0);

  // Number keys 1..N jump straight to a tab. Ignored while typing in a field so
  // it never eats a keystroke.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
          target.closest?.('[role="combobox"],[role="textbox"],[role="dialog"]'))
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= TABS.length) {
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
        <h1 className="text-2xl font-display font-medium">Tiers and Groups</h1>
      </header>

      <div className="p-6 space-y-6">
        {/* Tabs */}
        <div
          role="tablist"
          className="flex gap-6 overflow-x-auto border-b border-border"
        >
          {TABS.map(({ label }, i) => (
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

        {/* Panels — the shared table is its own card (like the /tenants table),
            so the panel is a plain a11y wrapper, not another white card. */}
        {TABS.map(({ label, config }, i) =>
          i === tab ? (
            <div
              key={label}
              role="tabpanel"
              id={tabPanelId(i)}
              aria-labelledby={tabId(i)}
              tabIndex={0}
              className="outline-none"
            >
              <CatalogTab config={config} />
            </div>
          ) : null,
        )}
      </div>
    </main>
  );
}
