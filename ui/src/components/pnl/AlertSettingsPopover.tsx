"use client";

import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api, isoDate, microsToInput, parseMoney, todayUTC } from "./format";
import type { CreditVendor } from "./creditTypes";

interface Draft {
  alertDays: string;
  opening: string;
  openingDate: string;
}

function draftOf(v: CreditVendor): Draft {
  return {
    alertDays: String(v.alertDays),
    opening: microsToInput(v.openingBalanceMicros),
    openingDate: v.openingDate ?? "",
  };
}

// AlertSettingsPopover (CON-435) sets, per AI vendor, how many days of runway
// trigger the low-balance alert (default 30) and the opening balance the
// balance starts from: credit bought before Harbor, read once from the
// vendor's console. Every save is audited.
export function AlertSettingsPopover({
  vendors,
  onSaved,
  className,
  label = "Alert settings",
}: {
  vendors: CreditVendor[];
  onSaved: () => void;
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);

  // Drafts start from the server's values when the popover opens, and only
  // then: the refetch after a save must not wipe another vendor's unsaved
  // edits or the "Saved" note.
  const onOpenChange = (next: boolean) => {
    if (next) {
      setDrafts(Object.fromEntries(vendors.map((v) => [v.vendorId, draftOf(v)])));
      setErrors({});
      setSaved(null);
    }
    setOpen(next);
  };

  const set = (id: string, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));

  const save = async (v: CreditVendor) => {
    const d = drafts[v.vendorId];
    if (!d) return;
    const days = Number(d.alertDays);
    const body: Record<string, unknown> = {};
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      setErrors((e) => ({ ...e, [v.vendorId]: "Alert days are a whole number from 1 to 365" }));
      return;
    }
    body.alertDays = days;
    const opening = parseMoney(d.opening);
    if (d.opening.trim() !== "" || d.openingDate !== "") {
      if (opening == null || opening < 0 || !d.openingDate) {
        setErrors((e) => ({ ...e, [v.vendorId]: "Enter the opening balance and the date it was read" }));
        return;
      }
      body.openingBalanceMicros = opening;
      body.openingDate = d.openingDate;
    }
    setBusy(v.vendorId);
    setErrors((e) => ({ ...e, [v.vendorId]: "" }));
    try {
      await api(`/api/pnl/credits/accounts/${v.vendorId}`, { method: "PUT", json: body });
      setSaved(v.vendorId);
      onSaved();
    } catch (e) {
      setErrors((x) => ({ ...x, [v.vendorId]: e instanceof Error ? e.message : "Could not save" }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "shrink-0 cursor-pointer text-[13px] font-semibold text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[22rem] space-y-4 rounded-[3px] p-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Alert settings</h3>
          <p className="text-xs text-secondary-foreground">
            Warn when a vendor’s credit lasts fewer days than this. The opening balance is the credit you had before
            Harbor tracked top-ups.
          </p>
        </div>
        {vendors.map((v) => {
          const d = drafts[v.vendorId];
          if (!d) return null;
          const id = (k: string) => `credit-${v.vendorId}-${k}`;
          return (
            <section key={v.vendorId} className="space-y-2 border-t border-border pt-3 text-[13px]">
              <div className="flex items-center justify-between">
                <span className="font-medium">{v.name}</span>
                {saved === v.vendorId && <span className="text-xs text-emerald-700">Saved</span>}
              </div>
              <div className="grid grid-cols-[1fr_7rem] items-center gap-x-3 gap-y-2">
                <label htmlFor={id("days")} className="text-secondary-foreground">
                  Alert below (days)
                </label>
                <input
                  id={id("days")}
                  inputMode="numeric"
                  value={d.alertDays}
                  onChange={(e) => set(v.vendorId, { alertDays: e.target.value })}
                  className="h-8 rounded-[3px] border border-border bg-primary px-2 text-right tabular-nums outline-none focus:border-foreground"
                />
                <label htmlFor={id("opening")} className="text-secondary-foreground">
                  Opening balance ($)
                </label>
                <input
                  id={id("opening")}
                  inputMode="decimal"
                  placeholder="0.00"
                  value={d.opening}
                  onChange={(e) => set(v.vendorId, { opening: e.target.value })}
                  className="h-8 rounded-[3px] border border-border bg-primary px-2 text-right tabular-nums outline-none focus:border-foreground"
                />
                <label htmlFor={id("date")} className="text-secondary-foreground">
                  Read on
                </label>
                <input
                  id={id("date")}
                  type="date"
                  max={isoDate(todayUTC())}
                  value={d.openingDate}
                  onChange={(e) => set(v.vendorId, { openingDate: e.target.value })}
                  className="h-8 rounded-[3px] border border-border bg-primary px-2 tabular-nums outline-none focus:border-foreground"
                />
              </div>
              {errors[v.vendorId] && (
                <p role="alert" className="text-xs text-red-800">
                  {errors[v.vendorId]}
                </p>
              )}
              <div className="flex justify-end">
                <Button type="button" size="sm" onClick={() => save(v)} disabled={busy != null}>
                  {busy === v.vendorId ? "Saving…" : `Save ${v.name}`}
                </Button>
              </div>
            </section>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
