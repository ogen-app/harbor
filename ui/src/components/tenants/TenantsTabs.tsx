"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { TenantsTable } from "@/components/tenants/TenantsTable";
import { TenantRegistrationsChart } from "@/components/tenants/TenantRegistrationsChart";
import { LifecycleView } from "@/components/tenants/lifecycle/LifecycleView";

// The /tenants tabs: the table, and the Lifecycle board. Deep link:
// ?tab=lifecycle.
const TABS = [
    { key: "all", label: "All tenants" },
    { key: "lifecycle", label: "Lifecycle" },
] as const;

const tabId = (i: number) => `tenants-tab-${i}`;
const tabPanelId = (i: number) => `tenants-tabpanel-${i}`;

export function TenantsTabs() {
    const [tab, setTab] = useState(0);

    // Read the deep link once on mount.
    useEffect(() => {
        const i = TABS.findIndex((t) => t.key === new URLSearchParams(window.location.search).get("tab"));
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (i >= 0) setTab(i);
    }, []);

    // Keep the URL in step so the view can be shared or reloaded.
    useEffect(() => {
        const q = new URLSearchParams(window.location.search);
        if (tab > 0) q.set("tab", TABS[tab].key);
        else q.delete("tab");
        const qs = q.toString();
        window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
    }, [tab]);

    // Number keys 1..N jump straight to a tab, except while typing or with a
    // dialog open.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (
                target &&
                (target.isContentEditable ||
                    /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
                    target.closest?.('[role="combobox"],[role="textbox"],[role="dialog"],[role="menu"]'))
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
        <div className="space-y-6">
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

            <div role="tabpanel" id={tabPanelId(tab)} aria-labelledby={tabId(tab)} className="space-y-6">
                {tab === 0 ? (
                    <>
                        <TenantRegistrationsChart />
                        <TenantsTable />
                    </>
                ) : (
                    <LifecycleView />
                )}
            </div>
        </div>
    );
}
