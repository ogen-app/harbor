"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowSquareOutIcon,
  ListChecksIcon,
  WarningIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader } from "@/components/ui/loader";
import { LabelChip } from "@/components/tenants/shared";
import { cn } from "@/lib/utils";
import {
  Chip,
  LEMON_SQUEEZY_PRODUCTS,
  MappingStatusBadge,
  errorText,
  formatMoney,
  intervalLabel,
  trialLabel,
  useTierCatalog,
} from "./format";
import { VariantMapDrawer } from "./VariantMapDrawer";
import type {
  BillingMode,
  BillingSettings,
  BillingSettingsResponse,
  ProviderVariant,
  VariantMapping,
  VariantMappingsResponse,
  VariantSuggestionsResponse,
} from "./types";

// Columns: tier + version · interval · price excl. tax · variant · check · action.
const GRID =
  "grid grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)_minmax(0,0.9fr)_minmax(0,2fr)_minmax(0,2fr)_6rem] items-center gap-3";

// Focus is what the page asked the tab to show: one tier version (after a
// publish) and/or one price's drawer (from the attention list).
export interface MappingFocus {
  versionId?: string;
  priceId?: string;
}

// VariantMappingTab is Billing → Variant mapping (CON-407 §A): every sellable
// tier price and the Lemon Squeezy variant that sells it, in test or live mode,
// with Ogen's check of each pair. Unmapped prices with a suggestion can be
// accepted together; every problem row has one action, which opens the map
// drawer. All checks and messages are Ogen's; nothing here invents a status.
export function VariantMappingTab({
  focus,
  onFocusChange,
}: {
  focus: MappingFocus;
  onFocusChange: (focus: MappingFocus) => void;
}) {
  const tiers = useTierCatalog();
  const [settings, setSettings] = useState<BillingSettings | null>(null);
  const [settingsRead, setSettingsRead] = useState(false);
  const [mode, setMode] = useState<BillingMode>("test");
  // The switch defaults to the mode Ogen runs in (GetBillingSettings.test_mode).
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/billing/settings", { signal: controller.signal })
      .then((r) => (r.ok ? (r.json() as Promise<BillingSettingsResponse>) : null))
      .then((j) => {
        if (j?.available) {
          setSettings(j.settings);
          setMode(j.settings.testMode ? "test" : "live");
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setSettingsRead(true);
      });
    return () => controller.abort();
  }, []);
  const runsTest = settings?.testMode ?? true;

  const [lists, setLists] = useState<Partial<Record<BillingMode, VariantMappingsResponse>>>({});
  const [suggestions, setSuggestions] = useState<Partial<Record<BillingMode, VariantSuggestionsResponse>>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ msg: string; error?: boolean } | null>(null);
  // Per-row refusals from "Accept all suggestions", keyed by price id.
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [bulkReason, setBulkReason] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerRow, setDrawerRow] = useState<VariantMapping | null>(null);

  // Both maps are read so the switch can show each side's coverage; the
  // suggestions are read for the visible mode only.
  const load = useCallback((signal?: AbortSignal) => {
    const get = <T,>(url: string) =>
      fetch(url, { signal }).then(async (r) => {
        if (!r.ok) throw new Error(await errorText(r));
        return r.json() as Promise<T>;
      });
    return Promise.all([
      get<VariantMappingsResponse>("/api/billing/variant-mappings?mode=test"),
      get<VariantMappingsResponse>("/api/billing/variant-mappings?mode=live"),
      get<VariantSuggestionsResponse>("/api/billing/variant-suggestions?mode=test"),
      get<VariantSuggestionsResponse>("/api/billing/variant-suggestions?mode=live"),
    ])
      .then(([test, live, sTest, sLive]) => {
        setLists({ test, live });
        setSuggestions({ test: sTest, live: sLive });
        setLoadError(null);
      })
      .catch((e: unknown) => {
        if (signal?.aborted) return;
        setLoadError(e instanceof Error ? e.message : "Failed to load the variant map.");
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const flash = useCallback((msg: string, isError = false) => {
    setNotice({ msg, error: isError });
    window.setTimeout(() => setNotice(null), 5000);
  }, []);

  const list = lists[mode];
  const allRows = useMemo(() => list?.mappings ?? [], [list]);
  const suggestionFor = useMemo(() => {
    const m = new Map<string, ProviderVariant>();
    for (const s of suggestions[mode]?.suggestions ?? []) m.set(s.tierVersionPriceId, s.variant);
    return m;
  }, [suggestions, mode]);

  const versionRow = focus.versionId
    ? allRows.find((r) => r.tierVersionId === focus.versionId)
    : undefined;
  const rows = useMemo(
    () => (focus.versionId ? allRows.filter((r) => r.tierVersionId === focus.versionId) : allRows),
    [allRows, focus.versionId],
  );
  const pending = rows.filter(
    (r) => !r.variantId && suggestionFor.has(r.tierVersionPriceId),
  );

  // Open the drawer a deep link asked for, once that mode's rows are in.
  useEffect(() => {
    if (!focus.priceId || !list || !settingsRead) return;
    const row = list.mappings.find((r) => r.tierVersionPriceId === focus.priceId);
    if (row) {
      setDrawerRow(row); // eslint-disable-line react-hooks/set-state-in-effect
      setDrawerOpen(true);
    }
    onFocusChange({ versionId: focus.versionId });
  }, [focus.priceId, focus.versionId, list, settingsRead, onFocusChange]);

  const openRow = (row: VariantMapping) => {
    setDrawerRow(row);
    setDrawerOpen(true);
  };

  const switchMode = (m: BillingMode) => {
    setMode(m);
    setConfirming(false);
    setRowErrors({});
  };

  // acceptAll maps every pending suggestion; one refusal never stops the others.
  const acceptAll = async () => {
    const reason = bulkReason.trim();
    if (!reason) return;
    setBulkBusy(true);
    const errors: Record<string, string> = {};
    let done = 0;
    for (const row of pending) {
      const v = suggestionFor.get(row.tierVersionPriceId);
      if (!v) continue;
      try {
        const res = await fetch(
          `/api/billing/variant-mappings/${encodeURIComponent(row.tierVersionPriceId)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode, variantId: v.id, reason }),
          },
        );
        if (!res.ok) throw new Error(await errorText(res));
        done++;
      } catch (e) {
        errors[row.tierVersionPriceId] = e instanceof Error ? e.message : "Refused.";
      }
    }
    setRowErrors(errors);
    setBulkBusy(false);
    setConfirming(false);
    setBulkReason("");
    const refused = Object.keys(errors).length;
    flash(
      refused
        ? `${done} mapped, ${refused} refused — see the rows below.`
        : `${done} price${done === 1 ? "" : "s"} mapped.`,
      refused > 0,
    );
    load();
  };

  const tierColor = (tierId: string) => tiers.find((t) => t.id === tierId)?.color ?? "";
  const sideCount = (m: BillingMode) => {
    const l = lists[m];
    if (!l?.available) return null;
    return { mapped: l.mappings.filter((r) => !!r.variantId).length, total: l.mappings.length };
  };
  const sellCount = rows.filter((r) => r.status === "ok").length;
  const viewingRunningMode = (mode === "test") === runsTest;

  return (
    <div className="space-y-6">
      {/* Mode strip */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl bg-primary px-6 py-4">
        <div role="radiogroup" aria-label="Lemon Squeezy mode" className="inline-flex rounded-md border border-border p-0.5">
          {(["test", "live"] as const).map((m) => {
            const c = sideCount(m);
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => switchMode(m)}
                className={cn(
                  "flex items-center gap-2 rounded-[5px] px-3 py-1.5 text-sm transition-colors cursor-pointer",
                  mode === m
                    ? "bg-secondary font-semibold text-foreground"
                    : "text-tertiary-foreground hover:text-foreground",
                )}
              >
                {m === "test" ? "Test mode" : "Live mode"}
                {c && (
                  <span className="font-mono text-xs tabular-nums" title={`${c.mapped} of ${c.total} prices mapped`}>
                    {c.mapped} / {c.total}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {settings &&
          (viewingRunningMode ? (
            <Chip tone="info" label={runsTest ? "Ogen runs in test mode" : "Ogen runs live"} />
          ) : mode === "live" ? (
            <Chip tone="warn" label="Prepared ahead of the switch to live" />
          ) : (
            <Chip tone="neutral" label="Not used while Ogen runs live" />
          ))}
        <span className="ml-auto text-xs text-tertiary-foreground">
          {settings?.storeId ? `Store ${settings.storeId} · ` : ""}changes reach every replica within 60 s
        </span>
      </div>

      {list?.available && !list.checked && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-6 py-3 text-sm text-amber-900">
          <WarningIcon className="mt-0.5 size-4 shrink-0" />
          {mode === "live" ? (
            <p>
              Set <code className="font-mono">lemonsqueezy_api_key_live</code> in{" "}
              <Link href="/secrets" className="underline underline-offset-2">
                Secrets
              </Link>{" "}
              to check live variants. Live prices can still be mapped; they save
              as <em>Not checked</em>.
            </p>
          ) : (
            <p>
              Lemon Squeezy could not be read, so these checks are missing. Mappings
              still save; they show as <em>Not checked</em>.
            </p>
          )}
        </div>
      )}

      <div className="rounded-xl bg-primary">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-foreground">Prices and variants</h2>
            <p className="mt-1 max-w-2xl text-xs text-tertiary-foreground">
              Each sellable price of a published tier version and the Lemon Squeezy
              variant that sells it. Lemon Squeezy’s API cannot create products, so
              create the variant there first, then map it here.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <a href={LEMON_SQUEEZY_PRODUCTS} target="_blank" rel="noreferrer">
                <ArrowSquareOutIcon className="size-4" />
                Open Lemon Squeezy
              </a>
            </Button>
            {pending.length > 0 && !confirming && (
              <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
                Accept {pending.length} suggestion{pending.length === 1 ? "" : "s"}
              </Button>
            )}
          </div>
        </div>

        {focus.versionId && (
          <div className="flex items-center gap-2 border-b border-border px-6 py-2.5 text-xs text-secondary-foreground">
            Showing {versionRow ? `${versionRow.tierName} v${versionRow.tierVersion}` : "one tier version"} only
            <button
              type="button"
              onClick={() => onFocusChange({})}
              className="inline-flex items-center gap-1 rounded-xs px-1 text-tertiary-foreground hover:text-foreground cursor-pointer"
            >
              <XIcon className="size-3" />
              Show all
            </button>
          </div>
        )}

        {confirming && pending.length > 0 && (
          <form
            className="flex gap-3 border-b border-border bg-secondary/40 px-6 py-4"
            onSubmit={(e) => {
              e.preventDefault();
              acceptAll();
            }}
          >
            <ListChecksIcon className="mt-0.5 size-5 shrink-0 text-tertiary-foreground" />
            <div className="min-w-0 flex-1 space-y-3">
              <div>
                <p className="text-sm font-medium">
                  Map {pending.length} {mode} price{pending.length === 1 ? "" : "s"} to their suggested variants?
                </p>
                <p className="mt-1 text-sm text-secondary-foreground">
                  {pending
                    .map(
                      (r) =>
                        `${r.tierName} v${r.tierVersion} ${intervalLabel(r.interval)} → ${suggestionFor.get(r.tierVersionPriceId)?.id}`,
                    )
                    .join(" · ")}
                  .
                  {rows.length - pending.length > 0 &&
                    ` The other ${rows.length - pending.length} price${rows.length - pending.length === 1 ? "" : "s"} stay as they are.`}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label htmlFor="bulk-reason" className="text-sm text-tertiary-foreground">
                  Reason
                </label>
                <Input
                  id="bulk-reason"
                  value={bulkReason}
                  onChange={(e) => setBulkReason(e.target.value)}
                  placeholder={mode === "live" ? "e.g. live store copied (Copy to Live Mode)" : "e.g. variants created in the test store"}
                  autoComplete="off"
                  autoFocus
                  inputSize="sm"
                  className="max-w-md flex-1"
                />
                <div className="ml-auto flex gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={bulkBusy}>
                    Cancel
                  </Button>
                  <Button type="submit" variant="defaultInverted" size="sm" disabled={!bulkReason.trim() || bulkBusy}>
                    {bulkBusy ? "Mapping…" : `Map ${pending.length} price${pending.length === 1 ? "" : "s"}`}
                  </Button>
                </div>
              </div>
            </div>
          </form>
        )}

        <div className="overflow-x-auto rounded-b-xl">
          {!list && !loadError ? (
            <div className="flex items-center gap-2 p-6 text-sm text-tertiary-foreground">
              <Loader className="size-4" />
              Loading…
            </div>
          ) : loadError ? (
            <p className="p-6 text-sm text-destructive">{loadError}</p>
          ) : !list?.available ? (
            <p className="p-6 text-sm text-tertiary-foreground">
              The billing-admin service is unavailable.
            </p>
          ) : rows.length === 0 ? (
            <p className="p-6 text-sm text-tertiary-foreground">
              No sellable prices. Publish a purchasable tier version with a non-zero
              price, and it shows up here.
            </p>
          ) : (
            <div className="min-w-[60rem] divide-y divide-border">
              <div className={`${GRID} px-6 py-2.5`}>
                <HeaderCell label="Tier" />
                <HeaderCell label="Interval" />
                <HeaderCell label="Price, excl. tax" />
                <HeaderCell label="Lemon Squeezy variant" />
                <HeaderCell label="Check" />
                <span aria-hidden />
              </div>
              {rows.map((r) => (
                <MappingRow
                  key={r.tierVersionPriceId}
                  row={r}
                  color={tierColor(r.tierId)}
                  suggestion={r.variantId ? undefined : suggestionFor.get(r.tierVersionPriceId)}
                  refusal={rowErrors[r.tierVersionPriceId]}
                  onOpen={() => openRow(r)}
                />
              ))}
              <p className="px-6 py-3 text-xs text-tertiary-foreground">
                {sellCount} of {rows.length} price{rows.length === 1 ? "" : "s"} sell
                {mode === "live" && runsTest
                  ? " · nothing changes until the switch to live"
                  : " · unmapped prices show as unavailable on the pricing page"}
              </p>
            </div>
          )}
        </div>
      </div>

      <VariantMapDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        row={drawerRow}
        mode={mode}
        suggestedVariantId={
          drawerRow && !drawerRow.variantId
            ? (suggestionFor.get(drawerRow.tierVersionPriceId)?.id ?? "")
            : ""
        }
        mappings={allRows}
        onSaved={(msg) => {
          if (drawerRow) {
            const id = drawerRow.tierVersionPriceId;
            setRowErrors(({ [id]: _, ...rest }) => rest);
          }
          flash(msg);
          load();
        }}
      />

      {notice && (
        <div
          role={notice.error ? "alert" : "status"}
          className={cn(
            "fixed bottom-6 right-6 z-[200] max-w-sm rounded-md border bg-primary px-4 py-2 text-sm shadow-xl",
            notice.error ? "border-destructive/40 text-destructive" : "border-border text-foreground",
          )}
        >
          {notice.msg}
        </div>
      )}
    </div>
  );
}

function MappingRow({
  row: r,
  color,
  suggestion,
  refusal,
  onOpen,
}: {
  row: VariantMapping;
  color: string;
  suggestion: ProviderVariant | undefined;
  refusal: string | undefined;
  onOpen: () => void;
}) {
  const v = r.variant ?? (suggestion && !r.variantId ? suggestion : null);
  const suggested = !r.variantId && !!suggestion;
  const status = suggested ? "suggested" : r.status;
  const action =
    suggested ? "Accept" : !r.variantId ? "Map…" : r.status === "ok" ? "" : "Change…";

  return (
    <div className={`${GRID} group px-6 py-3.5 text-sm transition-colors hover:bg-secondary/40`}>
      <span className="flex min-w-0 items-center gap-2">
        <LabelChip label={r.tierName || r.tierId} color={color} />
        <span className="text-secondary-foreground">v{r.tierVersion}</span>
        {r.freeTrialTier && (
          <span
            className="whitespace-nowrap text-[11px] text-sky-700"
            title="The free-month tier: its variants must carry a 1-month trial"
          >
            free month
          </span>
        )}
      </span>

      <span className="text-secondary-foreground">{intervalLabel(r.interval)}</span>

      <span className="flex min-w-0 flex-col">
        <span className="font-mono tabular-nums">{formatMoney(r.netMinor, r.currency)}</span>
        {r.countryCode && <span className="text-xs text-tertiary-foreground">{r.countryCode}</span>}
      </span>

      <span className="flex min-w-0 flex-col">
        {v ? (
          <>
            <span
              className={cn(
                "truncate font-medium",
                suggested && "w-fit underline decoration-dotted underline-offset-4 text-secondary-foreground",
              )}
            >
              {v.productName} · {v.name}
            </span>
            <span className="truncate text-xs text-tertiary-foreground">
              #{v.id} · {formatMoney(v.priceMinor, v.currency)} / {v.interval} · {trialLabel(v)}
            </span>
          </>
        ) : r.variantId ? (
          <span className="truncate text-xs text-tertiary-foreground">#{r.variantId}</span>
        ) : (
          <span className="text-tertiary-foreground">—</span>
        )}
      </span>

      <span className="flex min-w-0 flex-col items-start gap-1">
        <MappingStatusBadge status={status} />
        <span className="line-clamp-2 text-xs text-tertiary-foreground">
          {suggested ? "Amount, currency and interval match" : r.status === "ok" ? "" : r.message}
        </span>
        {refusal && (
          <span role="alert" className="text-xs text-destructive">
            Refused: {refusal}
          </span>
        )}
      </span>

      <span className="justify-self-end">
        {action ? (
          <Button variant={suggested ? "outline" : "ghost"} size="sm" onClick={onOpen}>
            {action}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={onOpen}
            className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          >
            Change…
          </Button>
        )}
      </span>
    </div>
  );
}

function HeaderCell({ label }: { label: string }) {
  return (
    <span className="truncate text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
      {label}
    </span>
  );
}
