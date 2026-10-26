"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  LinkSimpleIcon,
} from "@phosphor-icons/react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader } from "@/components/ui/loader";
import { cn } from "@/lib/utils";
import {
  Chip,
  LEMON_SQUEEZY_PRODUCTS,
  errorText,
  formatMoney,
  intervalLabel,
  trialLabel,
} from "./format";
import type {
  BillingMode,
  ProviderVariant,
  ProviderVariantsResponse,
  VariantMapping,
} from "./types";

// Fit is how a store variant relates to the price being mapped. Harbor only
// greys out what can't possibly match; Ogen re-checks on save and its refusal
// is shown as is.
type Fit =
  | { ok: true; current: boolean; suggested: boolean }
  | { ok: false; why: string };

function hasMonthTrial(v: ProviderVariant): boolean {
  return v.hasFreeTrial && v.trialInterval === "month" && (v.trialIntervalCount || 1) === 1;
}

export function variantFit(
  row: VariantMapping,
  v: ProviderVariant,
  suggestedId: string,
  mappings: VariantMapping[],
): Fit {
  if (v.mappedPriceId && v.mappedPriceId !== row.tierVersionPriceId) {
    const other = mappings.find((m) => m.tierVersionPriceId === v.mappedPriceId);
    return {
      ok: false,
      why: other
        ? `Mapped to ${other.tierName} v${other.tierVersion} ${intervalLabel(other.interval)}`
        : "Sells another price",
    };
  }
  if (v.currency.toUpperCase() !== row.currency.toUpperCase()) {
    return { ok: false, why: "Currency differs" };
  }
  if (v.interval !== row.interval) return { ok: false, why: "Interval differs" };
  if (v.priceMinor !== row.netMinor) return { ok: false, why: "Price differs" };
  if (row.freeTrialTier && !hasMonthTrial(v)) return { ok: false, why: "No 1-month trial" };
  return {
    ok: true,
    current: v.id === row.variantId,
    suggested: v.id === suggestedId,
  };
}

// VariantMapDrawer maps one tier price to the Lemon Squeezy variant that sells
// it (CON-407 §B). Step 1 is the checklist of what to create in the Lemon
// Squeezy dashboard, built from the price row; step 2 picks the variant from the
// store (ListProviderVariants) with the suggestion preselected. A reason is
// required; a refusal (FailedPrecondition) is Ogen's message, shown as is under
// the choice, and keeps "Map variant" disabled until the choice changes.
export function VariantMapDrawer({
  open,
  onOpenChange,
  row,
  mode,
  suggestedVariantId,
  mappings,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: VariantMapping | null;
  mode: BillingMode;
  suggestedVariantId: string;
  mappings: VariantMapping[];
  onSaved: (message: string) => void;
}) {
  const [variants, setVariants] = useState<ProviderVariantsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  // Ogen's refusal of a particular variant; cleared when the choice changes.
  const [refusal, setRefusal] = useState<{ variantId: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmUnmap, setConfirmUnmap] = useState(false);

  const load = useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      return fetch(`/api/billing/provider-variants?mode=${mode}`, { signal })
        .then(async (r) => {
          if (!r.ok) throw new Error(await errorText(r));
          return r.json() as Promise<ProviderVariantsResponse>;
        })
        .then((j) => {
          setVariants(j);
          setLoadError(null);
        })
        .catch((e: unknown) => {
          if (signal?.aborted) return;
          setLoadError(e instanceof Error ? e.message : "Failed to load the store’s variants.");
        })
        .finally(() => {
          if (!signal?.aborted) setLoading(false);
        });
    },
    [mode],
  );

  // Reset and (re)load each time the drawer opens on a price.
  useEffect(() => {
    if (!open || !row) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setSelected(suggestedVariantId || row.variantId);
    setReason("");
    setRefusal(null);
    setError(null);
    setConfirmUnmap(false);
    setVariants(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [open, row, suggestedVariantId, load]);

  const options = useMemo(() => {
    if (!row || !variants) return [];
    const rank = (f: Fit) => (!f.ok ? 3 : f.suggested ? 0 : f.current ? 1 : 2);
    return variants.variants
      .map((v) => ({ v, fit: variantFit(row, v, suggestedVariantId, mappings) }))
      .sort((a, b) => rank(a.fit) - rank(b.fit));
  }, [row, variants, suggestedVariantId, mappings]);

  if (!row) return null;

  const label = `${row.tierName} v${row.tierVersion} · ${intervalLabel(row.interval)}`;
  const mapped = !!row.variantId;
  const needsCreating = !mapped || row.status === "variant_missing";
  const price = formatMoney(row.netMinor, row.currency);
  const per = row.interval === "year" ? "year" : row.interval;
  const reasonOk = reason.trim().length > 0;
  const refused = !!refusal && refusal.variantId === selected;
  const canMap =
    !!selected && selected !== row.variantId && reasonOk && !busy && !refused;

  const save = async (variantId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/billing/variant-mappings/${encodeURIComponent(row.tierVersionPriceId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode, variantId, reason: reason.trim() }),
        },
      );
      if (res.status === 409) {
        const message = await errorText(res);
        if (variantId) setRefusal({ variantId, message });
        else setError(message);
        return;
      }
      if (!res.ok) throw new Error(await errorText(res));
      onOpenChange(false);
      onSaved(
        variantId
          ? `${label} mapped to variant ${variantId} (${mode}).`
          : `${label} unmapped (${mode}).`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Saving the mapping failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle className="flex items-center gap-2">
            <LinkSimpleIcon className="size-5" />
            {mapped ? "Change" : "Map"} {label}
          </DrawerTitle>
          <DrawerDescription className="font-mono text-xs text-tertiary-foreground">
            {row.tierVersionPriceId} · {price} / {per} · excl. tax
            {row.countryCode ? ` · ${row.countryCode}` : ""}
          </DrawerDescription>
        </DrawerHeader>

        <DrawerBody className="space-y-6">
          {needsCreating && (
            <section className="space-y-3">
              <StepTitle>
                1 · Create in Lemon Squeezy ({mode === "test" ? "test mode" : "live mode"})
              </StepTitle>
              <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2.5 rounded-lg bg-secondary/50 px-4 py-3 text-sm">
                <dt className="text-tertiary-foreground">Product</dt>
                <dd className="font-medium">{row.tierName}</dd>
                <dt className="text-tertiary-foreground">Variant</dt>
                <dd className="font-medium">{intervalLabel(row.interval)}</dd>
                <dt className="text-tertiary-foreground">Price</dt>
                <dd className="font-medium">{price}, excluding tax</dd>
                <dt className="text-tertiary-foreground">Billing</dt>
                <dd className="font-medium">Subscription, every 1 {per}</dd>
                {row.countryCode && (
                  <>
                    <dt className="text-tertiary-foreground">Country</dt>
                    <dd className="font-medium">{row.countryCode}</dd>
                  </>
                )}
                <dt className="text-tertiary-foreground">Free trial</dt>
                <dd className="font-medium">
                  {row.freeTrialTier
                    ? `1 month — ${row.tierName} is the free-month tier`
                    : `None — ${row.tierName} is not the free-month tier`}
                </dd>
              </dl>
              <a
                href={LEMON_SQUEEZY_PRODUCTS}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm underline underline-offset-2 hover:text-foreground"
              >
                <ArrowSquareOutIcon className="size-4" />
                Open products in Lemon Squeezy
              </a>
            </section>
          )}

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <StepTitle>{needsCreating ? "2 · " : ""}Choose the variant</StepTitle>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => load()}
                disabled={loading}
              >
                <ArrowsClockwiseIcon className="size-4" />
                Refresh
              </Button>
            </div>

            {loading && !variants ? (
              <div className="flex items-center gap-2 text-sm text-tertiary-foreground">
                <Loader className="size-4" />
                Reading the store…
              </div>
            ) : loadError ? (
              <p className="text-sm text-destructive">{loadError}</p>
            ) : variants && !variants.available ? (
              <p className="text-sm text-tertiary-foreground">
                The billing-admin service is unavailable.
              </p>
            ) : variants && !variants.readable ? (
              // Ogen's FailedPrecondition, as is (e.g. the live key is not set).
              <p className="rounded-lg bg-amber-500/10 px-4 py-3 text-sm text-amber-800">
                {variants.message}
              </p>
            ) : options.length === 0 ? (
              <p className="text-sm text-tertiary-foreground">
                The {mode} store has no subscription variants yet. Create one in
                Lemon Squeezy, then Refresh.
              </p>
            ) : (
              <div role="radiogroup" aria-label="Lemon Squeezy variant" className="space-y-2">
                {options.map(({ v, fit }) => (
                  <VariantOption
                    key={v.id}
                    variant={v}
                    fit={fit}
                    checked={selected === v.id}
                    onSelect={() => {
                      setSelected(v.id);
                      setError(null);
                    }}
                    refusal={refusal?.variantId === v.id ? refusal.message : null}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="grid gap-1.5">
            <Label htmlFor="variant-reason">Reason</Label>
            <Input
              id="variant-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={`e.g. ${row.tierName} ${intervalLabel(row.interval).toLowerCase()} created in the ${mode} store`}
              autoComplete="off"
            />
            <p className="text-xs text-tertiary-foreground">
              Required. Kept on the mapping and logged by Ogen.
            </p>
          </section>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          {mapped && confirmUnmap && (
            <div className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
              <p>
                Unmap {label}? Until it is mapped again, the pricing page shows
                this price as unavailable in {mode} mode. Uses the reason above.
              </p>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmUnmap(false)}
                  disabled={busy}
                >
                  Keep it
                </Button>
                <Button
                  type="button"
                  variant="destructiveInverted"
                  size="sm"
                  disabled={!reasonOk || busy}
                  onClick={() => save("")}
                >
                  {busy ? "Unmapping…" : "Unmap"}
                </Button>
              </div>
            </div>
          )}
        </DrawerBody>

        <DrawerFooter className="justify-between">
          <span className="text-xs text-tertiary-foreground">
            Live on every replica within 60 s
          </span>
          <div className="flex items-center gap-2">
            {mapped && !confirmUnmap && (
              <Button
                type="button"
                variant="destructive"
                onClick={() => setConfirmUnmap(true)}
                disabled={busy}
              >
                Unmap…
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="defaultInverted"
              disabled={!canMap}
              onClick={() => save(selected)}
            >
              {busy && !confirmUnmap ? "Mapping…" : "Map variant"}
            </Button>
          </div>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function StepTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
      {children}
    </h3>
  );
}

function VariantOption({
  variant: v,
  fit,
  checked,
  onSelect,
  refusal,
}: {
  variant: ProviderVariant;
  fit: Fit;
  checked: boolean;
  onSelect: () => void;
  refusal: string | null;
}) {
  const disabled = !fit.ok;
  return (
    <div
      className={cn(
        "rounded-lg border transition-colors",
        refusal
          ? "border-destructive/50"
          : checked
            ? "border-foreground"
            : "border-border",
        disabled && "opacity-60",
      )}
    >
      <label
        className={cn(
          "flex items-start gap-3 px-4 py-3",
          disabled ? "cursor-not-allowed" : "cursor-pointer hover:bg-secondary/40",
        )}
      >
        <input
          type="radio"
          name="lemon-squeezy-variant"
          className="mt-1 accent-foreground"
          checked={checked}
          disabled={disabled}
          onChange={onSelect}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">
            {v.productName} · {v.name}{" "}
            <span className="font-normal text-tertiary-foreground">#{v.id}</span>
          </span>
          <span className="block text-xs text-tertiary-foreground">
            {formatMoney(v.priceMinor, v.currency)} / {v.interval} · {v.currency.toUpperCase()} ·{" "}
            {trialLabel(v)}
            {v.status && v.status !== "published" ? ` · ${v.status}` : ""}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1 text-right text-xs">
          {fit.ok ? (
            fit.suggested ? (
              <>
                <Chip tone="info" label="Suggested" />
                <span className="text-tertiary-foreground">Amount, currency and interval match</span>
              </>
            ) : fit.current ? (
              <Chip tone="neutral" label="Current" />
            ) : (
              <span className="text-emerald-700">Matches</span>
            )
          ) : (
            <span className="text-red-700">{fit.why}</span>
          )}
        </span>
      </label>
      {refusal && (
        <div role="alert" className="border-t border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
          <p className="text-foreground">{refusal}</p>
          <p className="mt-1 text-xs text-destructive">Refused by Ogen</p>
        </div>
      )}
    </div>
  );
}
