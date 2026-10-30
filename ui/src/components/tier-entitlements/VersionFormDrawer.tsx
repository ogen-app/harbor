"use client";

import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, Tag01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { Loader } from "@/components/ui/loader";
import type { Price, TierVersion } from "./types";

const selectClass =
  "h-8 rounded-none border-b border-quaternary bg-input px-2 text-[14px] font-medium outline-none focus-visible:border-foreground";

// errorText pulls the server's { error } message from a failed response.
async function errorText(res: Response): Promise<string> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  return j?.error || `Request failed (${res.status})`;
}

interface VersionFormDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tierName: string;
  // The draft whose prices and sale status are edited. Published versions are
  // immutable, so this is always a draft.
  version: TierVersion | null;
  onSaved: () => void;
}

// VersionFormDrawer edits a draft's prices and purchasable flag (CON-294), and
// can delete the draft. Entitlements are edited in the matrix itself and
// publishing happens in the publish review (CON-321), so neither is here; the
// draft's entitlements are sent back unchanged.
export function VersionFormDrawer({
  open,
  onOpenChange,
  tierName,
  version,
  onSaved,
}: VersionFormDrawerProps) {
  const [purchasable, setPurchasable] = useState(false);
  const [prices, setPrices] = useState<Price[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Draft delete (danger zone) — a two-step inline confirm.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  // (Re)seed the form each time it opens — a one-time reset when the drawer is
  // shown, not derived render state.
  useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setConfirmingDelete(false);
    setDeleteBusy(false);
    setDeleteErr(null);
    setPurchasable(version?.purchasable ?? false);
    setPrices(
      version?.prices?.length
        ? version.prices.map((p) => ({ ...p }))
        : [{ currency: "EUR", billingInterval: "month", netMinor: 0, countryCode: "" }],
    );
    setErr(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, version?.id]);

  const setPrice = (i: number, patch: Partial<Price>) => {
    setPrices((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  };
  const addPrice = () =>
    setPrices((prev) => [
      ...prev,
      { currency: "EUR", billingInterval: "month", netMinor: 0, countryCode: "" },
    ]);
  const removePrice = (i: number) =>
    setPrices((prev) => prev.filter((_, idx) => idx !== i));

  async function save() {
    if (!version) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(
        `/api/tier-entitlements/versions/${encodeURIComponent(version.id)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            purchasable,
            entitlements: version.entitlements ?? {},
            prices,
          }),
        },
      );
      if (!r.ok) throw new Error(await errorText(r));
      onOpenChange(false);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }

  // deleteDraft hard-deletes this draft version (Ogen refuses anything published).
  async function deleteDraft() {
    if (!version) return;
    setDeleteBusy(true);
    setDeleteErr(null);
    try {
      const r = await fetch(
        `/api/tier-entitlements/versions/${encodeURIComponent(version.id)}`,
        { method: "DELETE" },
      );
      if (!r.ok && r.status !== 204) throw new Error(await errorText(r));
      onOpenChange(false);
      onSaved();
    } catch (e) {
      setDeleteErr(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setDeleteBusy(false);
    }
  }

  // save() and deleteDraft() both mutate the version, so treat them as one
  // in-flight lock: neither control fires while the other runs.
  const mutationBusy = busy || deleteBusy;
  // Block user-initiated closes (Esc / overlay / ✕) while a mutation is in
  // flight; the success paths call onOpenChange(false) directly and bypass this.
  const handleOpenChange = (next: boolean) => {
    if (!next && mutationBusy) return;
    onOpenChange(next);
  };

  return (
    <Drawer open={open} onOpenChange={handleOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle className="flex items-center gap-2">
            <HugeiconsIcon icon={Tag01Icon} className="size-5 text-secondary-foreground" />
            {tierName} v{version?.version ?? ""} · prices and sale status
          </DrawerTitle>
          <DrawerDescription>
            Changes stay in the draft. They reach the pricing page when you publish it.
          </DrawerDescription>
        </DrawerHeader>

        <DrawerBody className="space-y-6">
          <div className="flex items-center gap-3">
            <Switch
              size="lg"
              variant="success"
              checked={purchasable}
              onChange={setPurchasable}
              label="Purchasable"
            />
            <span className="text-sm font-medium text-foreground">Purchasable</span>
            <span className="text-xs text-secondary-foreground">
              sold on the pricing page once published
            </span>
          </div>

          <section className="space-y-2 border-t border-border pt-6">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-secondary-foreground">
              Prices (net, major units)
            </h3>
            <div className="space-y-2">
              {prices.map((p, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <Input
                    inputSize="sm"
                    className="w-20"
                    aria-label="Currency"
                    value={p.currency}
                    onChange={(e) => setPrice(i, { currency: e.target.value.toUpperCase() })}
                  />
                  <select
                    className={selectClass}
                    aria-label="Billing interval"
                    value={p.billingInterval}
                    onChange={(e) => setPrice(i, { billingInterval: e.target.value })}
                  >
                    <option value="month">month</option>
                    <option value="year">year</option>
                  </select>
                  <Input
                    type="number"
                    inputSize="sm"
                    className="w-28"
                    aria-label="Amount"
                    value={p.netMinor / 100}
                    onChange={(e) =>
                      setPrice(i, { netMinor: Math.round((Number(e.target.value) || 0) * 100) })
                    }
                  />
                  <Input
                    inputSize="sm"
                    className="w-24"
                    placeholder="country"
                    aria-label="Country code"
                    value={p.countryCode}
                    onChange={(e) => setPrice(i, { countryCode: e.target.value.toUpperCase() })}
                  />
                  <Button type="button" variant="ghost" size="sm" onClick={() => removePrice(i)}>
                    Remove
                  </Button>
                </div>
              ))}
            </div>
            <Button type="button" variant="outline" size="sm" onClick={addPrice}>
              Add price
            </Button>
          </section>

          {/* Danger zone — hard-delete the draft (published versions are
              immutable audit artifacts and can't be deleted). */}
          <section className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-destructive">
                Danger zone
              </h3>
              <p className="mt-0.5 text-xs text-secondary-foreground">
                Permanently delete this draft version and its prices. This can’t be undone.
              </p>
            </div>
            {deleteErr && (
              <p className="text-xs text-destructive" role="alert">
                {deleteErr}
              </p>
            )}
            {confirmingDelete ? (
              <div className="flex items-center gap-2">
                <span className="mr-auto text-xs font-medium text-foreground">
                  Delete v{version?.version} for good?
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={deleteBusy}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructiveInverted"
                  size="sm"
                  className="font-semibold"
                  onClick={deleteDraft}
                  disabled={mutationBusy}
                >
                  {deleteBusy && <Loader className="size-3.5 border-[1.5px]" />}
                  Delete version
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={mutationBusy}
                onClick={() => {
                  setDeleteErr(null);
                  setConfirmingDelete(true);
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} className="size-4" />
                Delete version
              </Button>
            )}
          </section>
        </DrawerBody>

        <DrawerFooter>
          {err && <span className="mr-auto text-xs text-destructive">{err}</span>}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => handleOpenChange(false)}
            disabled={mutationBusy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="defaultInverted"
            size="sm"
            className="font-semibold"
            onClick={save}
            disabled={mutationBusy || !version}
          >
            {busy && <Loader className="size-3.5 border-[1.5px]" />}
            Save to draft
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
