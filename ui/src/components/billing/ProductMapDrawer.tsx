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
  errorText,
  formatMoney,
  intervalLabel,
  polarProductsUrl,
  priceIn,
  pricesLabel,
  trialLabel,
  type PolarOrg,
} from "./format";
import type {
  BillingMode,
  ProviderProduct,
  ProviderProductsResponse,
  ProductMapping,
} from "./types";

// Fit is how a Polar product relates to the price being mapped. Harbor only
// greys out what can't possibly match; Ogen re-checks on save and its refusal
// is shown as is.
type Fit =
  | { ok: true; current: boolean; suggested: boolean }
  | { ok: false; why: string };

function hasMonthTrial(p: ProviderProduct): boolean {
  return p.hasFreeTrial && p.trialInterval === "month" && (p.trialIntervalCount || 1) === 1;
}

export function productFit(
  row: ProductMapping,
  p: ProviderProduct,
  suggestedId: string,
  mappings: ProductMapping[],
): Fit {
  if (p.archived) return { ok: false, why: "Archived" };
  // A product sells one price row per currency: it is taken only by another
  // row in this row's currency.
  const cur = row.currency.toUpperCase();
  const taken = p.mappedPriceIds
    .filter((id) => id !== row.tierVersionPriceId)
    .map((id) => mappings.find((m) => m.tierVersionPriceId === id))
    .find((m) => m && m.currency.toUpperCase() === cur);
  if (taken) {
    return {
      ok: false,
      why: `Sells ${taken.tierName} v${taken.tierVersion} ${intervalLabel(taken.interval)} in ${cur}`,
    };
  }
  const price = priceIn(p.prices, cur);
  if (!price) return { ok: false, why: `No ${cur} price` };
  if (p.interval !== row.interval || (p.intervalCount || 1) !== 1) {
    return { ok: false, why: "Interval differs" };
  }
  if (price.amountMinor !== row.netMinor) return { ok: false, why: "Price differs" };
  if (row.freeTrialTier && !hasMonthTrial(p)) return { ok: false, why: "No 1-month trial" };
  return {
    ok: true,
    current: p.id === row.productId,
    suggested: p.id === suggestedId,
  };
}

// ProductMapDrawer maps one tier price to the Polar product that sells it
// Step 1 is the checklist of what to create
// in the Polar dashboard, built from the price row; step 2 picks the product
// from the organization (ListProviderProducts) with the suggestion preselected.
// A reason is required; a refusal (FailedPrecondition) is Ogen's message, shown
// as is under the choice, and keeps "Map product" disabled until the choice
// changes.
export function ProductMapDrawer({
  open,
  onOpenChange,
  row,
  mode,
  org,
  suggestedProductId,
  mappings,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: ProductMapping | null;
  mode: BillingMode;
  // The Polar organization of this mode, for the dashboard link.
  org: PolarOrg;
  suggestedProductId: string;
  mappings: ProductMapping[];
  onSaved: (message: string) => void;
}) {
  const [products, setProducts] = useState<ProviderProductsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  // Ogen's refusal of a particular product; cleared when the choice changes.
  const [refusal, setRefusal] = useState<{ productId: string; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmUnmap, setConfirmUnmap] = useState(false);

  const load = useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      return fetch(`/api/billing/provider-products?mode=${mode}`, { signal })
        .then(async (r) => {
          if (!r.ok) throw new Error(await errorText(r));
          return r.json() as Promise<ProviderProductsResponse>;
        })
        .then((j) => {
          setProducts(j);
          setLoadError(null);
        })
        .catch((e: unknown) => {
          if (signal?.aborted) return;
          setLoadError(e instanceof Error ? e.message : "Failed to load the Polar products.");
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
    setSelected(suggestedProductId || row.productId);
    setReason("");
    setRefusal(null);
    setError(null);
    setConfirmUnmap(false);
    setProducts(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [open, row, suggestedProductId, load]);

  const options = useMemo(() => {
    if (!row || !products) return [];
    const rank = (f: Fit) => (!f.ok ? 3 : f.suggested ? 0 : f.current ? 1 : 2);
    return products.products
      .map((p) => ({ p, fit: productFit(row, p, suggestedProductId, mappings) }))
      .sort((a, b) => rank(a.fit) - rank(b.fit));
  }, [row, products, suggestedProductId, mappings]);

  if (!row) return null;

  const label = `${row.tierName} v${row.tierVersion} · ${intervalLabel(row.interval)}`;
  const mapped = !!row.productId;
  const needsCreating =
    !mapped || row.status === "product_missing" || row.status === "product_archived";
  const price = formatMoney(row.netMinor, row.currency);
  const per = row.interval === "year" ? "year" : row.interval;
  const reasonOk = reason.trim().length > 0;
  const refused = !!refusal && refusal.productId === selected;
  const canMap =
    !!selected && selected !== row.productId && reasonOk && !busy && !refused;
  const modeName = mode === "test" ? "sandbox" : "production";

  const save = async (productId: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/billing/product-mappings/${encodeURIComponent(row.tierVersionPriceId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode, productId, reason: reason.trim() }),
        },
      );
      if (res.status === 409) {
        const message = await errorText(res);
        if (productId) setRefusal({ productId, message });
        else setError(message);
        return;
      }
      if (!res.ok) throw new Error(await errorText(res));
      onOpenChange(false);
      const name = products?.products.find((p) => p.id === productId)?.name ?? productId;
      onSaved(
        productId
          ? `${label} mapped to ${name} (${modeName}).`
          : `${label} unmapped (${modeName}).`,
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
              <StepTitle>1 · Create in Polar ({modeName})</StepTitle>
              <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2.5 rounded-lg bg-secondary/50 px-4 py-3 text-sm">
                <dt className="text-tertiary-foreground">Product</dt>
                <dd className="font-medium">
                  {row.tierName} {intervalLabel(row.interval).toLowerCase()}
                  <span className="block text-xs font-normal text-tertiary-foreground">
                    One product per interval: monthly and yearly are separate products.
                  </span>
                </dd>
                <dt className="text-tertiary-foreground">Billing</dt>
                <dd className="font-medium">Recurring, every 1 {per}</dd>
                <dt className="text-tertiary-foreground">Price</dt>
                <dd className="font-medium">
                  Fixed price {price} in {row.currency.toUpperCase()}
                  <span className="block text-xs font-normal text-tertiary-foreground">
                    Compared on the amount excluding tax. Add the product’s other
                    currencies to the same product.
                  </span>
                </dd>
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
                <dt className="text-tertiary-foreground">Discounts</dt>
                <dd className="font-medium">None — checkouts never accept discount codes</dd>
              </dl>
              <a
                href={polarProductsUrl(org)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm underline underline-offset-2 hover:text-foreground"
              >
                <ArrowSquareOutIcon className="size-4" />
                Open products in Polar
              </a>
            </section>
          )}

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <StepTitle>{needsCreating ? "2 · " : ""}Choose the product</StepTitle>
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

            {loading && !products ? (
              <div className="flex items-center gap-2 text-sm text-tertiary-foreground">
                <Loader className="size-4" />
                Reading Polar…
              </div>
            ) : loadError ? (
              <p className="text-sm text-destructive">{loadError}</p>
            ) : products && !products.available ? (
              <p className="text-sm text-tertiary-foreground">
                The billing-admin service is unavailable.
              </p>
            ) : products && !products.readable ? (
              // Ogen's FailedPrecondition, as is (e.g. the production token is not
              // set). The mode can still be mapped by id; it saves unchecked.
              <div className="space-y-3">
                <p className="rounded-lg bg-amber-500/10 px-4 py-3 text-sm text-amber-800">
                  {products.message}
                </p>
                <div className="grid gap-1.5">
                  <Label htmlFor="product-id">Polar product id</Label>
                  <Input
                    id="product-id"
                    value={selected}
                    onChange={(e) => {
                      setSelected(e.target.value.trim());
                      setError(null);
                    }}
                    placeholder="Copy it from the product in the Polar dashboard"
                    autoComplete="off"
                    className="font-mono"
                  />
                  <p className="text-xs text-tertiary-foreground">
                    Ogen can’t read this mode’s products, so the mapping saves as{" "}
                    <em>Not checked</em> until it can.
                  </p>
                  {refusal?.productId === selected && (
                    <p role="alert" className="text-sm text-destructive">
                      {refusal.message}
                    </p>
                  )}
                </div>
              </div>
            ) : options.length === 0 ? (
              <p className="text-sm text-tertiary-foreground">
                The {modeName} organization has no recurring products yet. Create
                one in Polar, then Refresh.
              </p>
            ) : (
              <div role="radiogroup" aria-label="Polar product" className="space-y-2">
                {options.map(({ p, fit }) => (
                  <ProductOption
                    key={p.id}
                    product={p}
                    row={row}
                    fit={fit}
                    mappings={mappings}
                    checked={selected === p.id}
                    onSelect={() => {
                      setSelected(p.id);
                      setError(null);
                    }}
                    refusal={refusal?.productId === p.id ? refusal.message : null}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="grid gap-1.5">
            <Label htmlFor="product-reason">Reason</Label>
            <Input
              id="product-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={`e.g. ${row.tierName} ${intervalLabel(row.interval).toLowerCase()} created in the Polar ${modeName}`}
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
                this price as unavailable in {modeName}. Uses the reason above.
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
              {busy && !confirmUnmap ? "Mapping…" : "Map product"}
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

function ProductOption({
  product: p,
  row,
  fit,
  mappings,
  checked,
  onSelect,
  refusal,
}: {
  product: ProviderProduct;
  row: ProductMapping;
  fit: Fit;
  mappings: ProductMapping[];
  checked: boolean;
  onSelect: () => void;
  refusal: string | null;
}) {
  const disabled = !fit.ok;
  const matched = priceIn(p.prices, row.currency);
  // The rows it already sells (one per currency), named when they are known.
  const sells = p.mappedPriceIds.map((id) => {
    const m = mappings.find((x) => x.tierVersionPriceId === id);
    return m ? `${m.tierName} v${m.tierVersion} ${m.currency.toUpperCase()}` : id;
  });
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
          name="polar-product"
          className="mt-1 accent-foreground"
          checked={checked}
          disabled={disabled}
          onChange={onSelect}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-medium">
            <span className="truncate">{p.name}</span>
            {p.archived && <Chip tone="bad" label="Archived" />}
          </span>
          <span className="block text-xs text-tertiary-foreground">
            {matched ? (
              <span className="font-medium text-secondary-foreground">
                {formatMoney(matched.amountMinor, matched.currency)}
              </span>
            ) : (
              <span className="text-red-700">no {row.currency.toUpperCase()} price</span>
            )}{" "}
            / {(p.intervalCount || 1) > 1 ? `${p.intervalCount} ${p.interval}s` : p.interval} ·{" "}
            {trialLabel(p)}
          </span>
          <span className="block truncate text-xs text-tertiary-foreground">
            Prices: {pricesLabel(p.prices)}
          </span>
          {sells.length > 0 && (
            <span className="block truncate text-xs text-tertiary-foreground">
              Sells: {sells.join(" · ")}
            </span>
          )}
          <span className="block truncate font-mono text-[11px] text-tertiary-foreground">{p.id}</span>
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
