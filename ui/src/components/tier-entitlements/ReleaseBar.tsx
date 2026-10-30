"use client";

import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ui/loader";
import type { VariantMappingsResponse } from "@/components/billing/types";
import { cn } from "@/lib/utils";
import {
  describe,
  formatMoney,
  headlinePrice,
  inversionFor,
  plural,
  rawValue,
  unitLabel,
  type Change,
} from "./model";
import type { Feature, MatrixTier, TierVersion } from "./types";

async function errorText(res: Response): Promise<string> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  return j?.error || `Request failed (${res.status})`;
}

// mappingState asks the CON-407 variant map whether this version's prices can
// be sold in the mode Ogen runs in. null = billing off or unknown.
async function mappingState(versionId: string): Promise<string | null> {
  try {
    const s = await fetch("/api/billing/settings").then((r) => (r.ok ? r.json() : null));
    if (!s?.available || !s.settings?.provider || s.settings.provider === "none") return null;
    const mode = s.settings.testMode ? "test" : "live";
    const j = (await fetch(`/api/billing/variant-mappings?mode=${mode}`).then((r) =>
      r.ok ? r.json() : null,
    )) as VariantMappingsResponse | null;
    const rows = (j?.mappings ?? []).filter((m) => m.tierVersionId === versionId);
    if (rows.length === 0) return null;
    const bad = rows.filter((m) => m.status !== "ok").length;
    return bad === 0
      ? "Lemon Squeezy variant mapped"
      : `${plural(bad, "price")} not mapped in Lemon Squeezy yet`;
  } catch {
    return null;
  }
}

function Value({ f, v, tone }: { f: Feature; v: Parameters<typeof describe>[1]; tone: "old" | "new" }) {
  const d = describe(f, v);
  return (
    <span
      className={cn(
        "tabular-nums",
        d.kind === "unset"
          ? "text-amber-700"
          : tone === "new"
            ? "font-medium text-editable"
            : "text-secondary-foreground",
      )}
    >
      {d.kind === "excluded" ? "—" : d.text}
    </span>
  );
}

// ReleaseBar sits under the matrix while a draft is shown (CON-321 §3): what
// the draft changes and that nothing reaches tenants until it is published.
// "Review and publish…" expands it into the publish review sheet (§4), which
// replaces the authoring drawer's old Draft switch.
export function ReleaseBar({
  tier,
  tiers,
  draft,
  base,
  features,
  changes,
  saving,
  onShowUnset,
  onReviewingChange,
  onDone,
}: {
  tier: MatrixTier;
  tiers: MatrixTier[];
  draft: TierVersion;
  base: TierVersion | null;
  features: Feature[];
  changes: Change[];
  saving: boolean;
  onShowUnset: () => void;
  // Told when the review opens and closes, so the matrix can lock this
  // draft's cells: the diff being approved must be the one that is published.
  onReviewingChange?: (draftId: string, reviewing: boolean) => void;
  onDone: (published?: TierVersion) => void;
}) {
  const [reviewing, setReviewing] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [moveTenants, setMoveTenants] = useState(false);
  const [mapping, setMapping] = useState<string | null>(null);
  const reasonRef = useRef<HTMLInputElement>(null);

  const inversions = changes.filter(
    (c) => inversionFor(tiers, tier.tierId, c.feature, c.to) !== null,
  ).length;
  const stillUnset = features.filter((f) => rawValue(draft, f) === undefined);
  const tenants = base?.liveAssignmentCount ?? 0;
  const label = `${tier.tierName} v${draft.version}`;
  const price = headlinePrice(draft);
  const basePrice = headlinePrice(base);
  const priceText = price ? `${formatMoney(price)}/${price.billingInterval === "year" ? "yr" : "mo"}` : null;

  useEffect(() => {
    if (!reviewing) return;
    let live = true;
    mappingState(draft.id).then((m) => live && setMapping(m));
    requestAnimationFrame(() => reasonRef.current?.focus());
    return () => {
      live = false;
    };
  }, [reviewing, draft.id]);

  useEffect(() => {
    onReviewingChange?.(draft.id, reviewing);
  }, [reviewing, draft.id, onReviewingChange]);
  useEffect(() => () => onReviewingChange?.(draft.id, false), [draft.id, onReviewingChange]);

  // Esc steps back from the review to the draft.
  useEffect(() => {
    if (!reviewing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        setReviewing(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reviewing, busy]);

  async function discard() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/tier-entitlements/versions/${encodeURIComponent(draft.id)}`, {
        method: "DELETE",
      });
      if (!r.ok && r.status !== 204) throw new Error(await errorText(r));
      setConfirmDiscard(false);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Discard failed.");
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    // A pending or in-flight autosave would let Ogen publish a copy that
    // differs from the diff on screen.
    if (saving) {
      setErr("The draft is still saving. Publish once it finishes.");
      return;
    }
    if (!reason.trim()) {
      setErr("Add a reason for this change.");
      reasonRef.current?.focus();
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const supersede = base
        ? {
            versionId: base.id,
            ...(tenants > 0 && (moveTenants ? { reassignToPublished: true } : { force: true })),
          }
        : undefined;
      const r = await fetch(
        `/api/tier-entitlements/versions/${encodeURIComponent(draft.id)}/publish`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ changeReason: reason.trim(), supersede }),
        },
      );
      if (!r.ok) throw new Error(await errorText(r));
      const published = (await r.json()) as TierVersion;
      setReviewing(false);
      onDone(published);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Publish failed.");
    } finally {
      setBusy(false);
    }
  }

  const dot = (
    <span
      aria-hidden
      className="inline-block size-2 shrink-0 rounded-full"
      style={{ backgroundColor: tier.tierColor || "var(--beige-500)" }}
    />
  );

  if (!reviewing) {
    return (
      <div className="flex shrink-0 items-center gap-3 border-t border-border bg-primary px-5 py-2.5 text-[13px]">
        {dot}
        <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2">
          <span className="font-semibold text-foreground">{label}</span>
          <span className="font-medium text-editable">draft</span>
          <span className="text-secondary-foreground">
            {changes.length === 0
              ? `no changes vs ${base ? `v${base.version}` : "the live version"}`
              : `${plural(changes.length, "change")} vs ${base ? `v${base.version}` : "nothing live"}`}
          </span>
          {inversions > 0 && (
            <>
              <span className="text-tertiary-foreground">·</span>
              <span className="font-medium text-amber-700">
                {inversions} out of line with another tier
              </span>
            </>
          )}
          <span className="text-tertiary-foreground">·</span>
          <span className="text-secondary-foreground">
            {saving ? "Saving…" : "nothing changes for tenants until you publish"}
          </span>
        </p>
        {err && <span className="text-xs text-destructive">{err}</span>}
        {confirmDiscard ? (
          <span className="flex items-center gap-2">
            <span className="text-xs font-medium text-foreground">Delete {label} for good?</span>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDiscard(false)} disabled={busy}>
              Keep
            </Button>
            <Button variant="destructiveInverted" size="sm" className="font-semibold" onClick={discard} disabled={busy}>
              {busy && <Loader className="size-3.5 border-[1.5px]" />}
              Discard draft
            </Button>
          </span>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDiscard(true)}>
              Discard draft
            </Button>
            <Button
              variant="defaultInverted"
              size="sm"
              className="font-semibold"
              disabled={saving}
              onClick={() => {
                setErr(null);
                setReviewing(true);
              }}
            >
              Review and publish…
            </Button>
          </>
        )}
      </div>
    );
  }

  return (
    <section
      aria-label={`Publish ${label}`}
      className="flex max-h-[min(560px,70%)] shrink-0 flex-col border-t border-border bg-primary shadow-[0_-12px_32px_rgb(60_40_0/0.08)]"
    >
      <header className="flex items-start gap-3 border-b border-border px-6 py-4">
        <span className="mt-2">{dot}</span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-foreground">Publish {label}</h2>
          <p className="text-[13px] text-secondary-foreground">
            Published versions can’t be edited. To change it later, publish v{draft.version + 1}.
          </p>
        </div>
        <button
          type="button"
          aria-label="Back to draft"
          onClick={() => setReviewing(false)}
          className="inline-flex size-8 cursor-pointer items-center justify-center rounded-sm text-secondary-foreground hover:text-foreground"
        >
          <HugeiconsIcon icon={Cancel01Icon} className="size-4" />
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-2">
        {/* Left: the diff */}
        <div className="flex flex-col gap-6 px-6 py-5 md:border-r md:border-border">
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-secondary-foreground">
              Changes vs {base ? `v${base.version}` : "nothing live"}
            </h3>
            {changes.length === 0 ? (
              <p className="text-[13px] text-secondary-foreground">
                The entitlements match {base ? `v${base.version}` : "an empty version"}.
              </p>
            ) : (
              <ul className="divide-y divide-border border-y border-border">
                {changes.map((c) => {
                  const inv = inversionFor(tiers, tier.tierId, c.feature, c.to);
                  const unit = unitLabel(c.feature);
                  return (
                    <li key={c.feature.key} className="flex items-center gap-3 py-2 text-[13px]">
                      <span className="min-w-0 flex-1">
                        <span className="font-medium text-foreground">{c.feature.name}</span>
                        {unit && <span className="ml-1.5 text-xs text-secondary-foreground">{unit}</span>}
                      </span>
                      <span className="flex items-center gap-2">
                        <Value f={c.feature} v={c.from} tone="old" />
                        <HugeiconsIcon icon={ArrowRight01Icon} className="size-3 text-tertiary-foreground" />
                        <Value f={c.feature} v={c.to} tone="new" />
                      </span>
                      {inv && (
                        <span className="flex w-28 items-center gap-1 text-xs text-amber-700">
                          <HugeiconsIcon icon={Alert01Icon} className="size-3.5 shrink-0" />
                          {inv.tierName} has {describe(c.feature, inv.value).text}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {stillUnset.length > 0 && (
            <div>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-secondary-foreground">
                Still not set
              </h3>
              <p className="text-[13px] text-foreground">
                {stillUnset.map((f) => f.name).join(", ")}.{" "}
                <span className="text-secondary-foreground">
                  {tier.tierName} v{draft.version} tenants get {stillUnset.length === 1 ? "it" : "these"} with no limit.
                </span>
              </p>
              <button
                type="button"
                onClick={() => {
                  setReviewing(false);
                  onShowUnset();
                }}
                className="mt-1.5 cursor-pointer text-[13px] font-medium text-editable hover:underline"
              >
                Set them now
              </button>
            </div>
          )}

          <div>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-secondary-foreground">
              Price
            </h3>
            <p className="text-[13px]">
              <span className="font-medium text-foreground tabular-nums">{priceText ?? "No price"}</span>
              <span className="text-secondary-foreground">
                {" · "}
                {price && basePrice && price.netMinor === basePrice.netMinor && price.currency === basePrice.currency
                  ? "unchanged"
                  : basePrice
                    ? `was ${formatMoney(basePrice)}`
                    : "new"}
                {" · "}
                {plural(draft.prices.length, "price row")}
                {mapping && ` · ${mapping}`}
              </span>
            </p>
          </div>
        </div>

        {/* Right: consequences */}
        <div className="flex flex-col gap-5 px-6 py-5">
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-secondary-foreground">
              What happens
            </h3>
            <ul className="flex flex-col gap-1.5 text-[13px] text-foreground">
              <li className="flex items-center gap-2">
                <HugeiconsIcon icon={ArrowRight01Icon} className="size-3.5 text-secondary-foreground" />
                {draft.purchasable
                  ? `New ${tier.tierName} purchases get v${draft.version}${priceText ? ` at ${priceText}` : ""}.`
                  : `v${draft.version} goes live but is not for sale.`}
              </li>
              {base && (
                <li className="flex items-center gap-2">
                  <HugeiconsIcon icon={ArrowRight01Icon} className="size-3.5 text-secondary-foreground" />
                  v{base.version} stops being sold and is retired.
                </li>
              )}
            </ul>
          </div>

          {base && tenants > 0 && (
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-2 text-[13px] text-foreground">
                <span className="font-semibold">{plural(tenants, "tenant")}</span>{" "}
                {tenants === 1 ? "is" : "are"} on {tier.tierName} v{base.version}. After publishing they
              </legend>
              {[
                {
                  move: false,
                  title: `Stay on v${base.version}`,
                  body: "Keep their current limits. Move them later from the version history.",
                },
                {
                  move: true,
                  title: `Move to v${draft.version} now`,
                  body: changes.length
                    ? `${changes[0].feature.name} and the other changes apply on their next request.`
                    : "Their limits don’t change.",
                },
              ].map((o) => (
                <label key={String(o.move)} className="flex cursor-pointer items-start gap-2.5">
                  <input
                    type="radio"
                    name="tenants"
                    checked={moveTenants === o.move}
                    onChange={() => setMoveTenants(o.move)}
                    className="mt-0.5 size-4 accent-foreground"
                  />
                  <span>
                    <span className="block text-[13px] font-medium text-foreground">{o.title}</span>
                    <span className="block text-xs text-secondary-foreground">{o.body}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}

          <label className="flex flex-col gap-1.5">
            <span className="text-[13px]">
              <span className="font-medium text-foreground">Reason for this change</span>
              <span className="ml-2 text-xs text-secondary-foreground">
                required · saved in the version history
              </span>
            </span>
            <input
              ref={reasonRef}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  publish();
                }
              }}
              placeholder="e.g. Agencies on Pro hit the account cap"
              className="h-9 rounded-xs border border-foreground/80 bg-primary px-3 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
            />
          </label>
        </div>
      </div>

      <footer className="flex flex-wrap items-center gap-3 border-t border-border px-6 py-3">
        <p className="mr-auto text-xs text-secondary-foreground">
          {draft.purchasable ? `New purchases get v${draft.version}` : `v${draft.version} goes live`}
          {base && tenants > 0 &&
            (moveTenants
              ? ` · ${plural(tenants, "tenant")} move from v${base.version}`
              : ` · ${tenants} stay on v${base.version}`)}
        </p>
        {err && <span className="text-xs text-destructive">{err}</span>}
        <Button variant="ghost" size="sm" onClick={() => setReviewing(false)} disabled={busy}>
          Back to draft
        </Button>
        <Button variant="defaultInverted" size="sm" className="font-semibold" onClick={publish} disabled={busy || saving}>
          {(busy || saving) && <Loader className="size-3.5 border-[1.5px]" />}
          {saving ? "Saving draft…" : `Publish ${label}`}
        </Button>
      </footer>
    </section>
  );
}
