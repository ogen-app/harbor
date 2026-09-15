"use client";

import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Delete02Icon,
  GitBranchPlusIcon,
  InfinitySquareIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { bytesToMB, mbToBytes } from "@/components/platforms/bytes";
import { cn } from "@/lib/utils";
import type { EntitlementValue, Feature, Price, TierVersion } from "./types";

const CATEGORY_LABELS: Record<string, string> = {
  workspace_team: "Workspace & team",
  campaigns_planning: "Campaigns & planning",
  ai_superpowers: "AI superpowers",
  posts_publishing: "Posts & publishing",
  content_bank: "Content bank",
  images_brand: "Images & brand",
  workflow_platform: "Workflow & platform",
};

// A numeric entitlement is a number, null (unlimited), or undefined (not set /
// not granted). Booleans are always true/false.
type NumValue = number | null | undefined;

function groupByCategory(features: Feature[]): [string, Feature[]][] {
  const byCat = new Map<string, Feature[]>();
  for (const f of features) {
    const list = byCat.get(f.category) ?? [];
    list.push(f);
    byCat.set(f.category, list);
  }
  return [...byCat.entries()];
}

// initEntitlements seeds the working map from a base version (the version being
// edited, or the one a new version clones). Missing booleans default to false;
// missing numerics stay undefined (not granted).
function initEntitlements(
  features: Feature[],
  base: TierVersion | null,
): Record<string, EntitlementValue | undefined> {
  const out: Record<string, EntitlementValue | undefined> = {};
  const src = base?.entitlements ?? {};
  for (const f of features) {
    const bv = src[f.key];
    if (f.valueType === "boolean") {
      out[f.key] = typeof bv === "boolean" ? bv : false;
    } else if (bv === null) {
      out[f.key] = null;
    } else if (typeof bv === "number") {
      out[f.key] = bv;
    } else {
      out[f.key] = undefined;
    }
  }
  return out;
}

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
  mode: "create" | "update";
  tierId: string;
  tierName: string;
  // The version being edited (update) or cloned as the starting point (create).
  baseVersion: TierVersion | null;
  // All versions of this tier — used to enforce a single purchasable published
  // version.
  siblingVersions: TierVersion[];
  features: Feature[];
  onSaved: () => void;
}

// VersionFormDrawer authors a tier version (CON-294): create a new draft
// (optionally seeded from the current version) or replace a draft's body. It
// edits the purchasable flag, the price rows, and one entitlement value per
// catalog feature. Published versions are immutable — "update" only applies to
// drafts.
export function VersionFormDrawer({
  open,
  onOpenChange,
  mode,
  tierId,
  tierName,
  baseVersion,
  siblingVersions,
  features,
  onSaved,
}: VersionFormDrawerProps) {
  const [purchasable, setPurchasable] = useState(false);
  // Draft vs published: on when the version stays a draft; off publishes it
  // (draft → active) on save, which needs a change reason.
  const [draft, setDraft] = useState(true);
  const [changeReason, setChangeReason] = useState("");
  const [prices, setPrices] = useState<Price[]>([]);
  const [ent, setEnt] = useState<Record<string, EntitlementValue | undefined>>(
    {},
  );
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
    setPurchasable(baseVersion?.purchasable ?? false);
    setPrices(
      baseVersion?.prices?.length
        ? baseVersion.prices.map((p) => ({ ...p }))
        : [
            {
              currency: "EUR",
              billingInterval: "month",
              netMinor: 0,
              countryCode: "",
            },
          ],
    );
    setEnt(initEntitlements(features, baseVersion));
    setDraft(true);
    setChangeReason("");
    setErr(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, baseVersion?.id]);

  const isDraft = baseVersion?.status === "draft";
  const blockedUpdate = mode === "update" && !isDraft;

  const setNum = (key: string, raw: string, isBytes: boolean) => {
    setEnt((prev) => {
      const next = { ...prev };
      if (raw.trim() === "") {
        next[key] = undefined;
      } else {
        const n = Number(raw);
        next[key] = Number.isFinite(n) ? (isBytes ? mbToBytes(n) : n) : undefined;
      }
      return next;
    });
  };
  const setUnlimited = (key: string, on: boolean) => {
    setEnt((prev) => ({ ...prev, [key]: on ? null : undefined }));
  };
  const setBool = (key: string, v: boolean) => {
    setEnt((prev) => ({ ...prev, [key]: v }));
  };

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
    // Only one non-draft (published) version of a tier may be purchasable.
    if (!draft && purchasable) {
      const conflict = siblingVersions.find(
        (v) =>
          v.id !== baseVersion?.id &&
          v.status !== "draft" &&
          v.purchasable,
      );
      if (conflict) {
        setErr(
          `This tier already has a purchasable published version (v${conflict.version}). Retire it before publishing another as purchasable.`,
        );
        return;
      }
    }
    if (!draft && !changeReason.trim()) {
      setErr("A change reason is required to publish a version.");
      return;
    }

    setBusy(true);
    setErr(null);
    // Drop "not set" numerics; keep booleans and explicit numbers/unlimited.
    const entitlements: Record<string, EntitlementValue> = {};
    for (const [k, v] of Object.entries(ent)) {
      if (v !== undefined) entitlements[k] = v;
    }
    const body = { purchasable, entitlements, prices };
    try {
      // 1. Create or replace the draft body.
      let versionId = baseVersion?.id ?? "";
      if (mode === "create") {
        const r = await fetch(
          `/api/tier-entitlements/tiers/${encodeURIComponent(tierId)}/versions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        if (!r.ok) throw new Error(await errorText(r));
        const created = (await r.json()) as { id: string };
        versionId = created.id;
      } else {
        const r = await fetch(
          `/api/tier-entitlements/versions/${encodeURIComponent(versionId)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        if (!r.ok) throw new Error(await errorText(r));
      }
      // 2. Publish (draft → active) when Draft is off.
      if (!draft) {
        const pr = await fetch(
          `/api/tier-entitlements/versions/${encodeURIComponent(versionId)}/publish`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ changeReason }),
          },
        );
        if (!pr.ok) throw new Error(await errorText(pr));
      }
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
    if (!baseVersion) return;
    setDeleteBusy(true);
    setDeleteErr(null);
    try {
      const r = await fetch(
        `/api/tier-entitlements/versions/${encodeURIComponent(baseVersion.id)}`,
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

  const title =
    mode === "create"
      ? `New ${tierName} version`
      : `Edit ${tierName} v${baseVersion?.version ?? ""}`;
  const description =
    mode === "create"
      ? baseVersion
        ? `Creates a new draft, seeded from v${baseVersion.version}. Edit the values, then publish it later.`
        : "Creates a new draft version for this tier."
      : "Replaces this draft's prices and entitlements. Only drafts can be edited.";

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle className="flex items-center gap-2">
            <HugeiconsIcon
              icon={mode === "create" ? GitBranchPlusIcon : PencilEdit02Icon}
              className="size-5 text-tertiary-foreground"
            />
            {title}
          </DrawerTitle>
          <DrawerDescription>{description}</DrawerDescription>
        </DrawerHeader>

        <DrawerBody className="space-y-6">
          {blockedUpdate && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
              This version is <span className="font-medium">{baseVersion?.status}</span>{" "}
              and immutable — create a new version instead.
            </p>
          )}

          {/* Meta */}
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <Switch
                size="lg"
                variant="success"
                checked={purchasable}
                onChange={setPurchasable}
                label="Purchasable"
              />
              <span className="text-sm font-medium text-foreground">
                Purchasable
              </span>
              <span className="text-xs text-tertiary-foreground">
                buyable now on the pricing page
              </span>
            </div>
            <div className="flex items-center gap-3">
              <Switch
                size="lg"
                variant="warning"
                checked={draft}
                onChange={setDraft}
                label="Draft"
              />
              <span className="text-sm font-medium text-foreground">Draft</span>
              <span className="text-xs text-tertiary-foreground">
                {draft ? "kept editable, not live" : "published (active) on save"}
              </span>
            </div>
            {!draft && (
              <div className="space-y-1">
                <Label className="text-xs text-tertiary-foreground">
                  Change reason (required to publish)
                </Label>
                <Input
                  inputSize="sm"
                  value={changeReason}
                  onChange={(e) => setChangeReason(e.target.value)}
                  placeholder="e.g. Q3 price update"
                />
              </div>
            )}
          </div>

          {/* Prices */}
          <section className="space-y-2 border-t-[3px] border-border pt-6">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
              Prices (net, minor units)
            </h3>
            <div className="space-y-2">
              {prices.map((p, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <Input
                    inputSize="sm"
                    className="w-20"
                    aria-label="Currency"
                    value={p.currency}
                    onChange={(e) =>
                      setPrice(i, { currency: e.target.value.toUpperCase() })
                    }
                  />
                  <select
                    className={selectClass}
                    aria-label="Billing interval"
                    value={p.billingInterval}
                    onChange={(e) =>
                      setPrice(i, { billingInterval: e.target.value })
                    }
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
                      setPrice(i, {
                        netMinor: Math.round((Number(e.target.value) || 0) * 100),
                      })
                    }
                  />
                  <Input
                    inputSize="sm"
                    className="w-24"
                    placeholder="country"
                    aria-label="Country code"
                    value={p.countryCode}
                    onChange={(e) =>
                      setPrice(i, { countryCode: e.target.value.toUpperCase() })
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removePrice(i)}
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
            <Button type="button" variant="outline" size="sm" onClick={addPrice}>
              Add price
            </Button>
          </section>

          {/* Entitlements */}
          <section className="space-y-4 border-t-[3px] border-border pt-6">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
              Entitlements
            </h3>
            {groupByCategory(features).map(([category, feats], gi) => (
              <div
                key={category}
                className={cn(
                  "space-y-2",
                  // A 3px rule sets each group apart from the previous one.
                  gi > 0 && "border-t-[3px] border-border pt-4",
                )}
              >
                <p className="text-[11px] font-semibold uppercase tracking-wide text-secondary-foreground">
                  {CATEGORY_LABELS[category] ?? category.replace(/_/g, " ")}
                </p>
                {feats.map((f) => (
                  <div
                    key={f.key}
                    className="flex items-center justify-between gap-3 border-b border-border/60 pb-2 last:border-b-0 last:pb-0"
                  >
                    <Label className="min-w-0 flex-1 text-sm font-normal text-foreground">
                      {f.name}
                    </Label>
                    {f.valueType === "boolean" ? (
                      <Switch
                        checked={ent[f.key] === true}
                        onChange={(v) => setBool(f.key, v)}
                        label={f.name}
                      />
                    ) : (
                      <NumericField
                        value={ent[f.key] as NumValue}
                        isBytes={f.key.endsWith("_bytes")}
                        onNum={(raw, isBytes) => setNum(f.key, raw, isBytes)}
                        onUnlimited={(on) => setUnlimited(f.key, on)}
                      />
                    )}
                  </div>
                ))}
              </div>
            ))}
          </section>

          {/* Danger zone — hard-delete a draft (published versions are immutable
              audit artifacts and can't be deleted). Only shown when editing a
              draft. */}
          {mode === "update" && isDraft && (
            <section className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-destructive">
                  Danger zone
                </h3>
                <p className="mt-0.5 text-xs text-tertiary-foreground">
                  Permanently delete this draft version and its prices. This
                  can’t be undone.
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
                    Delete v{baseVersion?.version} for good?
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
                    disabled={deleteBusy}
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
          )}
        </DrawerBody>

        <DrawerFooter>
          {err && <span className="mr-auto text-xs text-destructive">{err}</span>}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="defaultInverted"
            size="sm"
            className="font-semibold"
            onClick={save}
            disabled={busy || blockedUpdate}
          >
            {busy && <Loader className="size-3.5 border-[1.5px]" />}
            {mode === "create"
              ? draft
                ? "Create draft"
                : "Create & publish"
              : draft
                ? "Save changes"
                : "Save & publish"}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function NumericField({
  value,
  isBytes,
  onNum,
  onUnlimited,
}: {
  value: NumValue;
  isBytes: boolean;
  onNum: (raw: string, isBytes: boolean) => void;
  onUnlimited: (on: boolean) => void;
}) {
  const unlimited = value === null;
  const display =
    typeof value === "number" ? (isBytes ? bytesToMB(value) : value) : "";
  return (
    <div className="flex shrink-0 items-center gap-2">
      <Input
        type="number"
        inputSize="sm"
        className="w-20"
        placeholder="—"
        disabled={unlimited}
        value={unlimited ? "" : display}
        onChange={(e) => onNum(e.target.value, isBytes)}
      />
      {isBytes && <span className="text-xs text-tertiary-foreground">MB</span>}
      <span className="text-xs font-medium text-tertiary-foreground">OR</span>
      <span className="flex items-center gap-1.5">
        <Switch checked={unlimited} onChange={onUnlimited} label="Unlimited" />
        <HugeiconsIcon
          icon={InfinitySquareIcon}
          className="size-5 text-gray-600"
          aria-label="Unlimited"
        />
      </span>
    </div>
  );
}
