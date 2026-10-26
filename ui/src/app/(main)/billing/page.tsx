"use client";

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { BillingOverview } from "@/components/billing/BillingOverview";
import {
  VariantMappingTab,
  type MappingFocus,
} from "@/components/billing/VariantMappingTab";

// Billing is the operator's oversight of Lemon Squeezy billing (CON-322/327):
// which workspaces need a decision (Ogen never changes a tier or status on its
// own), the free-month offer, and the sandbox→live cutover. Per-workspace detail
// lives in the tenant page's Billing tab. The second tab maps each sellable tier
// price to the Lemon Squeezy variant that sells it (CON-404/407).
//
// Deep links: ?tab=mapping opens the map, &version=<tier version id> filters it
// to one version (after a publish), &price=<price id> opens that price's drawer.
const TABS = [
  { key: "overview", label: "Overview" },
  { key: "mapping", label: "Variant mapping" },
] as const;

const tabId = (i: number) => `billing-tab-${i}`;
const tabPanelId = (i: number) => `billing-tabpanel-${i}`;

export default function BillingPage() {
  const [tab, setTab] = useState(0);
  const [focus, setFocus] = useState<MappingFocus>({});

  // Read the deep link once on mount.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const i = TABS.findIndex((t) => t.key === q.get("tab"));
    /* eslint-disable react-hooks/set-state-in-effect */
    if (i >= 0) setTab(i);
    setFocus({
      versionId: q.get("version") ?? undefined,
      priceId: q.get("price") ?? undefined,
    });
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  // Keep the URL in step so the view can be shared or reloaded.
  useEffect(() => {
    const q = new URLSearchParams();
    if (tab > 0) q.set("tab", TABS[tab].key);
    if (tab > 0 && focus.versionId) q.set("version", focus.versionId);
    const qs = q.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [tab, focus.versionId]);

  // Number keys 1..N jump straight to a tab. Ignored while typing in a field or
  // with a dialog/drawer open, so it never eats a keystroke.
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

  // The attention list's "Price not sellable" rows open that price's drawer.
  const openPrice = useCallback((priceId: string) => {
    setFocus({ priceId });
    setTab(1);
  }, []);

  return (
    <main className="flex-1 overflow-auto flex flex-col">
      <header className="h-20 border-b border-border flex items-center justify-between px-6 shrink-0">
        <h1 className="text-2xl font-display font-medium">Billing</h1>
      </header>

      <div className="p-6 space-y-6">
        <div role="tablist" className="flex gap-6 overflow-x-auto border-b border-border">
          {TABS.map(({ key, label }, i) => (
            <button
              key={key}
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

        <div
          role="tabpanel"
          id={tabPanelId(tab)}
          aria-labelledby={tabId(tab)}
          tabIndex={0}
          className="outline-none"
        >
          {tab === 0 ? (
            <BillingOverview onOpenPrice={openPrice} />
          ) : (
            <VariantMappingTab focus={focus} onFocusChange={setFocus} />
          )}
        </div>
      </div>
    </main>
  );
}
