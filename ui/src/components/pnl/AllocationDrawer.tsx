"use client";

import { useEffect, useMemo, useState } from "react";
import { PercentIcon, WarningIcon } from "@phosphor-icons/react";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ui/loader";
import { cn } from "@/lib/utils";
import { CATEGORY_LABEL, api, instantLabel, monthLabel, monthLong, pct, usd } from "./format";
import { ErrorLine, SectionTitle, TONE_TEXT } from "./shared";
import type {
  AllocationPreview,
  AllocationRule,
  AllocationVendor,
  AllocationView,
  RulesSaved,
} from "./types";

// AllocationDrawer is "Shared cost allocation" (CON-432, CON-413 mockup 4):
// one rule per shared vendor (Railway, Resend, Cloudflare, Zernio, and any
// vendor added later) that splits its monthly bill across tenants. Each card
// shows the bill, the rule, the driver behind it and the previewed tenant's
// share; switching the rule previews instantly (the server sends every rule's
// split). Saving re-splits the months in the page's range only. Allocations
// never touch the ledger, so company totals stay the same.

// Vendor colours shared with the P&L charts (CON-413 revision 2).
const VENDOR_COLOR: Record<string, string> = {
  railway: "#A989C5",
  resend: "#F4CF5A",
  cloudflare: "#EF8C8C",
  zernio: "#7CCFCF",
};

// Lower-case rule names for the Changes list.
const RULE_SHORT: Record<AllocationRule, string> = {
  even: "even split",
  ai_cost: "by AI cost share",
  active_users: "by active users",
  posts: "by posts published",
  emails: "by emails sent",
  none: "not split",
};

const DRIVER_NOUN: Record<string, [string, string]> = {
  active_users: ["active user", "active users"],
  posts: ["post", "posts"],
  emails: ["email", "emails"],
};

const count = (n: number) => n.toLocaleString("en-US");

export function AllocationDrawer({
  open,
  onClose,
  month,
  from,
  to,
  tenantId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  // Called after rules are saved and the range re-split, so the page refetches.
  onSaved?: () => void;
  // The previewed month and the months a save re-splits, all "YYYY-MM".
  month: string;
  from: string;
  to: string;
  // The tenant to preview; empty previews the one with the largest share.
  tenantId?: string;
}) {
  const [tenant, setTenant] = useState(tenantId ?? "");
  const [view, setView] = useState<AllocationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, AllocationRule>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<RulesSaved | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    /* eslint-disable react-hooks/set-state-in-effect */
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    const q = new URLSearchParams({ month });
    if (tenant) q.set("tenant", tenant);
    api<AllocationView>(`/api/pnl/allocation?${q}`, { signal: controller.signal })
      .then((v) => {
        setView(v);
        setDraft(Object.fromEntries(v.vendors.map((c) => [c.vendorId, c.rule])));
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "The rules could not be loaded");
      });
    return () => controller.abort();
  }, [open, month, tenant, reload]);

  // A fresh open starts from the caller's tenant and forgets the last save.
  useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setTenant(tenantId ?? "");
    setSaved(null);
    setSaveError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, tenantId]);

  const changed = useMemo(
    () => (view ? view.vendors.filter((c) => draft[c.vendorId] && draft[c.vendorId] !== c.rule) : []),
    [view, draft],
  );
  const tenantName =
    view?.tenants.find((t) => t.id === view.tenantId)?.name || view?.tenantId || "No tenant";
  const range = from === to ? monthLong(from) : `${monthLabel(from)} – ${monthLabel(to)}`;

  const save = async () => {
    setBusy(true);
    setSaveError(null);
    try {
      const res = await api<RulesSaved>("/api/pnl/allocation/rules", {
        method: "PUT",
        json: { rules: Object.fromEntries(changed.map((c) => [c.vendorId, draft[c.vendorId]])), from, to },
      });
      setSaved(res);
      setReload((n) => n + 1);
      onSaved?.();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "The rules could not be saved");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle className="flex items-center gap-2">
            <PercentIcon className="size-5 shrink-0" aria-hidden />
            Shared cost allocation
          </DrawerTitle>
          <DrawerDescription className="flex flex-wrap items-center gap-x-1 text-[13px] text-secondary-foreground">
            <span>Applies to every tenant · preview:</span>
            {view && view.tenants.length > 0 ? (
              <select
                aria-label="Tenant to preview"
                value={view.tenantId}
                onChange={(e) => setTenant(e.target.value)}
                className="max-w-[14rem] truncate rounded-[3px] bg-transparent text-foreground underline decoration-border underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {view.tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name || t.id}
                  </option>
                ))}
              </select>
            ) : (
              <span>{view ? "no tenants yet" : "…"}</span>
            )}
            <span>, {monthLong(month)}</span>
          </DrawerDescription>
        </DrawerHeader>

        <DrawerBody className="space-y-4">
          {error ? (
            <ErrorLine>{error}</ErrorLine>
          ) : !view ? (
            <div className="flex justify-center py-10">
              <Loader />
            </div>
          ) : (
            <>
              <p className="text-[13px] text-secondary-foreground">
                Costs that no single tenant causes are split by a rule you pick per vendor. The split only affects
                tenant P&amp;L and margins, never the company total.
              </p>

              {view.vendors.length === 0 ? (
                <p className="text-[13px] text-secondary-foreground">No shared vendors yet.</p>
              ) : (
                view.vendors.map((c) => (
                  <VendorCard
                    key={c.vendorId}
                    card={c}
                    rule={draft[c.vendorId] ?? c.rule}
                    options={view.rules}
                    month={month}
                    tenantName={tenantName}
                    onRule={(r) => setDraft((d) => ({ ...d, [c.vendorId]: r }))}
                  />
                ))
              )}

              <section className="space-y-2 pt-2">
                <SectionTitle>Changes</SectionTitle>
                {view.changes.length === 0 ? (
                  <p className="text-[13px] text-secondary-foreground">The default rules have not been changed.</p>
                ) : (
                  <ul className="space-y-1.5 text-[13px] text-secondary-foreground">
                    {view.changes.map((ch, i) => (
                      <li key={i} className="tabular-nums">
                        {instantLabel(ch.at)} · {ch.actor} ·{" "}
                        {ch.changes
                          .map((x) => {
                            const name = view.vendors.find((v) => v.vendorId === x.vendorId)?.name ?? x.vendorId;
                            return `${name}: ${RULE_SHORT[x.from] ?? x.from} → ${RULE_SHORT[x.to] ?? x.to}`;
                          })
                          .join("; ")}
                        {ch.from && (
                          <span>
                            {" "}
                            · re-split {ch.from === ch.to ? monthLabel(ch.from) : `${monthLabel(ch.from)} – ${monthLabel(ch.to)}`}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </DrawerBody>

        <DrawerFooter className="justify-between">
          <span className="text-[13px]">
            {saveError ? (
              <span className="text-red-800">{saveError}</span>
            ) : saved && changed.length === 0 ? (
              <span className="block font-medium">{saved.summary}</span>
            ) : (
              <>
                <span className="block font-medium">Saving re-splits every month in the range ({range}).</span>
                <span className="block text-secondary-foreground">Company totals stay the same.</span>
              </>
            )}
          </span>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              {saved && changed.length === 0 ? "Close" : "Cancel"}
            </Button>
            <Button type="button" onClick={save} disabled={busy || changed.length === 0}>
              {busy ? "Saving…" : "Save rules"}
            </Button>
          </div>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function VendorCard({
  card,
  rule,
  options,
  month,
  tenantName,
  onRule,
}: {
  card: AllocationVendor;
  rule: AllocationRule;
  options: AllocationView["rules"];
  month: string;
  tenantName: string;
  onRule: (r: AllocationRule) => void;
}) {
  const p = card.previews[rule];
  const id = `rule-${card.vendorId}`;
  const monthOnly = monthLong(month).split(" ")[0];
  return (
    <section className="space-y-3 rounded-[3px] border border-border bg-secondary px-4 py-3.5 text-[13px]">
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <span
            aria-hidden
            className="inline-block size-2.5 shrink-0 self-center"
            style={{ background: VENDOR_COLOR[card.vendorId] ?? "var(--color-quaternary, #bbb)" }}
          />
          <span className="truncate text-sm font-medium">{card.name}</span>
          <span className="text-secondary-foreground">{CATEGORY_LABEL[card.category] ?? card.category}</span>
        </div>
        {card.pending ? (
          <span className={cn("shrink-0", TONE_TEXT.pending)}>Receipt pending</span>
        ) : (
          <span className="shrink-0 tabular-nums text-secondary-foreground">
            {usd(card.billMicros)} in {monthOnly}
          </span>
        )}
      </div>

      <div className="grid grid-cols-[3rem_1fr] items-center gap-x-3">
        <label htmlFor={id} className="text-secondary-foreground">
          Rule
        </label>
        <select
          id={id}
          value={rule}
          onChange={(e) => onRule(e.target.value as AllocationRule)}
          className="h-8 min-w-0 rounded-[3px] border border-border bg-primary px-2 outline-none focus:border-foreground"
        >
          {options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <DriverText preview={p} rule={rule} monthOnly={monthOnly} />
        {rule !== "none" && p?.available && (
          <span className={cn("shrink-0 tabular-nums", card.pending ? TONE_TEXT.pending : "font-medium")}>
            {card.pending ? `${tenantName}: counts once approved` : `${tenantName}: ${usd(p.shareMicros)}`}
          </span>
        )}
      </div>
    </section>
  );
}

// DriverText explains the split, e.g. "27 active tenants → 3.7% each" or
// "214 of 2,810 posts → 7.6%", and flags a fallback or a missing driver.
function DriverText({
  preview: p,
  rule,
  monthOnly,
}: {
  preview: AllocationPreview | undefined;
  rule: AllocationRule;
  monthOnly: string;
}) {
  if (rule === "none") {
    return <span className="text-secondary-foreground">Stays at company level, not in any tenant’s P&amp;L</span>;
  }
  if (!p || !p.available) {
    return <Flag>The data for this rule can’t be read right now; the last split stays</Flag>;
  }
  if (!p.driver) {
    return <Flag>No active tenants in {monthOnly}; stays at company level</Flag>;
  }
  const share = p.driverTotal > 0 ? (p.tenantQuantity / p.driverTotal) * 100 : 0;
  const even = `${count(p.driverTotal)} active tenant${p.driverTotal === 1 ? "" : "s"} → ${pct(100 / p.driverTotal)} each`;
  if (p.fallback) {
    const noun = DRIVER_NOUN[rule]?.[1] ?? (rule === "ai_cost" ? "AI cost" : "usage");
    return <Flag>No {noun} in {monthOnly}, so split evenly: {even}</Flag>;
  }
  let text: string;
  switch (p.driver) {
    case "active_tenants":
      text = even;
      break;
    case "ai_cost":
      text = `${usd(p.tenantQuantity)} of ${usd(p.driverTotal)} AI cost → ${pct(share)}`;
      break;
    default: {
      const [, many] = DRIVER_NOUN[p.driver] ?? ["", ""];
      text = `${count(p.tenantQuantity)} of ${count(p.driverTotal)} ${many} → ${pct(share)}`;
    }
  }
  return <span className="tabular-nums text-secondary-foreground">{text}</span>;
}

function Flag({ children }: { children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", TONE_TEXT.pending)}>
      <WarningIcon className="size-3.5 shrink-0" weight="bold" aria-hidden />
      <span>{children}</span>
    </span>
  );
}
