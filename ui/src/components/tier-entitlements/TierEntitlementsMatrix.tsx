"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CheckmarkSquare02Icon,
  InfinitySquareIcon,
  SquareMinusIcon,
} from "@hugeicons/core-free-icons";
import { Loader } from "@/components/ui/loader";
import { cn } from "@/lib/utils";
import { FEATURE_STATUS } from "./legend";
import type {
  EntitlementValue,
  Feature,
  MatrixResponse,
  MatrixTier,
  Price,
  TierVersion,
} from "./types";

// ── layout & columns ──────────────────────────────────────────────────────────
// The Feature + Status columns are frozen (sticky) at the left, mirroring the
// /tenants table (contiguous grid tracks — no gap — so the opaque frozen
// backgrounds hide content scrolling underneath; each cell carries its own
// padding). The tier/version columns share the remaining width (minmax floor +
// 1fr) and are separated by full-height vertical rules.
const FEATURE_W = 400; // px — frozen
const STATUS_W = 100; // px — frozen, label chip + Linear issue
const TIER_MIN = 150; // px — tier/version column min-width (floor before scroll)
const EDGE_L = "pl-6"; // card inset on the frozen Feature column
// Soft right-edge shadow on the last frozen column (Status), shown only while
// the table is scrolled, so tier columns read as sliding underneath.
const FROZEN_SHADOW = "shadow-[6px_0_12px_-2px_rgba(0,0,0,0.14)]";
// Pale warm-yellow wash behind the category band rows.
const BAND_BG = "oklch(98% 5% 88deg)";

// Category order + labels from the CON-243 feature catalog (the doc's section
// headers). Unknown categories are appended in first-seen order under a
// title-cased fallback label.
const CATEGORY_ORDER = [
  "workspace_team",
  "campaigns_planning",
  "ai_superpowers",
  "posts_publishing",
  "content_bank",
  "images_brand",
  "workflow_platform",
];
const CATEGORY_LABELS: Record<string, string> = {
  workspace_team: "Workspace & team",
  campaigns_planning: "Campaigns & planning",
  ai_superpowers: "AI superpowers",
  posts_publishing: "Posts & publishing",
  content_bank: "Content bank",
  images_brand: "Images & brand",
  workflow_platform: "Workflow & platform",
};

// shownVersion picks the version a tier column renders: the highest-numbered
// active version (versions arrive newest-first), else the newest of any status
// (so a tier with only a draft still shows). null when a tier has no versions.
function shownVersion(tier: MatrixTier): TierVersion | null {
  const active = tier.versions.find((v) => v.status === "active");
  return active ?? tier.versions[0] ?? null;
}

// headlinePrice is the price shown under a tier column: the default (no
// country) monthly price, falling back to any monthly, then the first price.
function headlinePrice(v: TierVersion | null): Price | null {
  if (!v || v.prices.length === 0) return null;
  const monthly = v.prices.filter((p) => p.billingInterval === "month");
  return (
    monthly.find((p) => !p.countryCode) ?? monthly[0] ?? v.prices[0] ?? null
  );
}

function formatMoney(p: Price): string {
  const major = p.netMinor / 100;
  let s: string;
  try {
    s = new Intl.NumberFormat("en-IE", {
      style: "currency",
      currency: p.currency || "EUR",
      minimumFractionDigits: Number.isInteger(major) ? 0 : 2,
    }).format(major);
  } catch {
    s = `${major} ${p.currency}`;
  }
  const suffix =
    p.billingInterval === "year"
      ? "/yr"
      : p.billingInterval === "month"
        ? "/mo"
        : "";
  return s + suffix;
}

// formatMB humanises a raw byte count as megabytes (e.g. 104857600 → "100 MB",
// 10737418240 → "10,240 MB"). Byte-valued entitlements use the `_bytes` key
// suffix (e.g. media_storage_bytes); operators think in MB.
function formatMB(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  const rounded =
    mb >= 10 || Number.isInteger(mb) ? Math.round(mb) : Math.round(mb * 10) / 10;
  return `${rounded.toLocaleString("en-US")} MB`;
}

// A rendered entitlement cell: the display text plus whether it's a muted
// placeholder (so "—" reads lighter than a real value).
function cell(
  version: TierVersion | null,
  feature: Feature,
): { text: string; muted: boolean; icon?: "infinity" | "check" | "minus" } {
  // "not granted" / not applicable renders as a muted square-minus icon.
  const notGranted = { text: "", muted: true, icon: "minus" as const };
  if (!version) return notGranted;
  // entitlements may be null over the wire (the proto field is optional).
  const entitlements = version.entitlements ?? {};
  if (!Object.prototype.hasOwnProperty.call(entitlements, feature.key)) {
    return notGranted;
  }
  const value: EntitlementValue = entitlements[feature.key];
  if (feature.valueType === "boolean") {
    return value ? { text: "", muted: false, icon: "check" } : notGranted;
  }
  // numeric (or unknown type): null = unlimited (rendered as an infinity icon).
  if (value === null || value === undefined)
    return { text: "", muted: false, icon: "infinity" };
  if (typeof value === "boolean")
    return value ? { text: "", muted: false, icon: "check" } : notGranted;
  // Byte-valued numerics (media_storage_bytes, …) render humanised in MB.
  if (feature.key.endsWith("_bytes") && typeof value === "number") {
    return { text: formatMB(value), muted: false };
  }
  return { text: String(value), muted: false };
}

// Tier version status → a small badge next to the version number.
function versionBadge(v: TierVersion | null): {
  label: string;
  className: string;
} | null {
  if (!v) return null;
  switch (v.status) {
    case "active":
      return { label: `v${v.version}`, className: "text-tertiary-foreground" };
    case "draft":
      return { label: `v${v.version} draft`, className: "text-amber-700" };
    case "retired":
      return {
        label: `v${v.version} retired`,
        className: "text-gray-500 line-through",
      };
    default:
      return { label: `v${v.version}`, className: "text-tertiary-foreground" };
  }
}

// groupByCategory returns [category, features[]] in CATEGORY_ORDER, with any
// unknown categories appended in first-seen order.
function groupByCategory(features: Feature[]): [string, Feature[]][] {
  const byCat = new Map<string, Feature[]>();
  for (const f of features) {
    const list = byCat.get(f.category) ?? [];
    list.push(f);
    byCat.set(f.category, list);
  }
  const seen = new Set<string>();
  const out: [string, Feature[]][] = [];
  for (const c of CATEGORY_ORDER) {
    if (byCat.has(c)) {
      out.push([c, byCat.get(c)!]);
      seen.add(c);
    }
  }
  for (const [c, list] of byCat) {
    if (!seen.has(c)) out.push([c, list]);
  }
  return out;
}

// TierEntitlementsMatrix is the operator view of CON-243 versioned tier
// entitlements: catalog features as rows (grouped by category), each commercial
// tier's shown version as a column, and the resolved entitlement values as
// cells. Read-only in this iteration — authoring (draft/publish/retire) and
// assignment land next. All state is Ogen's, via /api/tier-entitlements.
export function TierEntitlementsMatrix() {
  const [data, setData] = useState<MatrixResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // True once the table is scrolled off its left edge — reveals the frozen
  // columns' right-edge shadow.
  const [scrolled, setScrolled] = useState(false);

  const reload = useCallback((signal?: AbortSignal) => {
    return fetch("/api/tier-entitlements", { signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        return r.json() as Promise<MatrixResponse>;
      })
      .then((json) => {
        setData(json);
        setLoadError(null);
      })
      .catch((e: unknown) => {
        if (signal?.aborted) return;
        setLoadError(
          e instanceof Error ? e.message : "Failed to load tier entitlements.",
        );
      })
      .finally(() => {
        if (!signal?.aborted) setLoading(false);
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  const available = data?.available ?? false;
  const features = data?.features ?? [];

  // Tier columns, ordered cheapest-first by the shown version's headline monthly
  // price (Trial → Pro → Max); tiers without a price sort last.
  const tiers = useMemo(() => {
    const cols = [...(data?.tiers ?? [])];
    cols.sort((a, b) => {
      const pa = headlinePrice(shownVersion(a));
      const pb = headlinePrice(shownVersion(b));
      const va = pa ? pa.netMinor : Number.POSITIVE_INFINITY;
      const vb = pb ? pb.netMinor : Number.POSITIVE_INFINITY;
      if (va !== vb) return va - vb;
      return a.tierName.localeCompare(b.tierName);
    });
    return cols;
  }, [data]);

  const grouped = useMemo(
    () => groupByCategory(data?.features ?? []),
    [data],
  );

  // Contiguous tracks: Feature (frozen) · Status (frozen) · the tier columns
  // sharing the remaining width (minmax floor + 1fr). Fixed frozen widths keep
  // the pin offset deterministic; tableMinWidth is the floor before the table
  // scrolls sideways (and keeps row backgrounds spanning the full width).
  const gridTemplate = `${FEATURE_W}px ${STATUS_W}px repeat(${tiers.length}, minmax(${TIER_MIN}px, 1fr))`;
  const tableMinWidth = FEATURE_W + STATUS_W + tiers.length * TIER_MIN;

  return (
    <div className="flex h-full flex-col rounded-xl bg-primary">
      {/* The scroll region fills the card height (both axes scroll): the frozen
          Feature/Status block stays pinned horizontally (with a right-edge
          shadow while scrolled), and the column-header row stays pinned
          vertically (sticky top). */}
      <div
        className="min-h-0 flex-1 overflow-auto rounded-xl"
        onScroll={(e) => setScrolled(e.currentTarget.scrollLeft > 0)}
      >
        {loading ? (
          <div className="flex items-center gap-2 p-6 text-sm text-tertiary-foreground">
            <Loader className="size-3.5 border-[1.5px]" />
            Loading…
          </div>
        ) : loadError ? (
          <p className="p-6 text-sm text-destructive">{loadError}</p>
        ) : !available ? (
          <p className="p-6 text-sm text-tertiary-foreground">
            The tier-entitlement service is unavailable. Check that Ogen is
            running and that Harbor’s{" "}
            <code className="font-mono">OGEN_GRPC_ADDR</code> /{" "}
            <code className="font-mono">OGEN_GRPC_TOKEN</code> are configured.
          </p>
        ) : features.length === 0 || tiers.length === 0 ? (
          <p className="p-6 text-sm text-tertiary-foreground">
            No feature catalog or tiers to show yet.
          </p>
        ) : (
          <div className="w-full" style={{ minWidth: tableMinWidth }}>
            {/* Column header row — sticky at the top of the scroll region. Its
                own bg-primary keeps the (transparent) tier header cells opaque
                so body rows pass cleanly underneath. */}
            <div
              className="sticky top-0 z-30 grid w-full border-b border-border bg-primary"
              style={{ gridTemplateColumns: gridTemplate }}
            >
              <div
                className={cn(
                  "sticky left-0 z-20 flex items-end bg-primary py-2.5",
                  EDGE_L,
                )}
              >
                <span className="text-[11px] font-semibold uppercase tracking-wide text-tertiary-foreground">
                  Feature
                </span>
              </div>
              <div
                className={cn(
                  "sticky z-20 flex items-end bg-primary px-2 py-2.5",
                  scrolled && FROZEN_SHADOW,
                )}
                style={{ left: FEATURE_W }}
              >
                <span className="text-[11px] font-semibold uppercase tracking-wide text-tertiary-foreground">
                  Status
                </span>
              </div>
              {tiers.map((t) => {
                const v = shownVersion(t);
                const badge = versionBadge(v);
                const price = headlinePrice(v);
                return (
                  <div
                    key={t.tierId}
                    className="flex flex-col items-start justify-end gap-0.5 border-l border-border px-3 py-2.5 text-left"
                  >
                    <span className="flex items-center gap-1 text-sm font-semibold text-foreground">
                      {t.tierColor && (
                        <span
                          aria-hidden
                          className="size-2 rounded-full"
                          style={{ backgroundColor: t.tierColor }}
                        />
                      )}
                      {t.tierName}
                    </span>
                    {badge && (
                      <span className={cn("text-[11px]", badge.className)}>
                        {badge.label}
                      </span>
                    )}
                    <span className="text-xs tabular-nums text-secondary-foreground">
                      {price ? formatMoney(price) : "—"}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Category bands + feature rows */}
            {grouped.map(([category, feats]) => (
              <div key={category}>
                {/* Band row: a pale-yellow strip; the label spans the two frozen
                    columns and stays pinned, and the vertical rules continue
                    through the empty tier cells. */}
                <div
                  className="grid w-full border-b border-border"
                  style={{ gridTemplateColumns: gridTemplate }}
                >
                  <div
                    className={cn(
                      "sticky left-0 z-10 flex items-center py-2 text-[11px] font-semibold uppercase tracking-wide text-secondary-foreground",
                      EDGE_L,
                      scrolled && FROZEN_SHADOW,
                    )}
                    style={{
                      gridColumn: "1 / span 2",
                      backgroundColor: BAND_BG,
                    }}
                  >
                    {CATEGORY_LABELS[category] ?? category.replace(/_/g, " ")}
                  </div>
                  {tiers.map((t) => (
                    <div
                      key={t.tierId}
                      className="border-l border-border"
                      style={{ backgroundColor: BAND_BG }}
                    />
                  ))}
                </div>

                {feats.map((f) => {
                  const s = FEATURE_STATUS[f.status];
                  return (
                    <div
                      key={f.key}
                      className="group grid w-full border-b border-border text-sm"
                      style={{ gridTemplateColumns: gridTemplate }}
                    >
                      {/* Feature name + description (frozen) */}
                      <div
                        className={cn(
                          "sticky left-0 z-10 flex min-w-0 flex-col justify-center bg-primary py-3 transition-colors group-hover:bg-secondary",
                          EDGE_L,
                          "pr-3",
                        )}
                      >
                        <span className="font-medium text-foreground">
                          {f.name}
                        </span>
                        {f.description && (
                          <span className="text-xs leading-snug text-tertiary-foreground">
                            {f.description}
                          </span>
                        )}
                      </div>

                      {/* Status chip + Linear issue (frozen) */}
                      <div
                        className={cn(
                          "sticky z-10 flex flex-col justify-center gap-0.5 bg-primary px-2 py-3 transition-colors group-hover:bg-secondary",
                          scrolled && FROZEN_SHADOW,
                        )}
                        style={{ left: FEATURE_W }}
                      >
                        {s ? (
                          <span
                            className={cn(
                              "w-fit rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide",
                              s.className,
                            )}
                          >
                            {s.label}
                          </span>
                        ) : (
                          <span className="text-xs text-tertiary-foreground">
                            {f.status || "—"}
                          </span>
                        )}
                        {f.linearIssue && (
                          <span className="font-mono text-[10px] text-tertiary-foreground">
                            {f.linearIssue}
                          </span>
                        )}
                      </div>

                      {/* One cell per tier */}
                      {tiers.map((t) => {
                        const c = cell(shownVersion(t), f);
                        return (
                          <div
                            key={t.tierId}
                            className={cn(
                              "flex items-center justify-center border-l border-border px-2 py-3 text-center tabular-nums transition-colors group-hover:bg-secondary",
                              c.muted
                                ? "text-tertiary-foreground"
                                : "text-foreground",
                            )}
                          >
                            {c.icon === "infinity" ? (
                              <HugeiconsIcon
                                icon={InfinitySquareIcon}
                                className="size-5 text-gray-600"
                                aria-label="Unlimited"
                              />
                            ) : c.icon === "check" ? (
                              <HugeiconsIcon
                                icon={CheckmarkSquare02Icon}
                                className="size-5 text-gray-600"
                                aria-label="Included"
                              />
                            ) : c.icon === "minus" ? (
                              <HugeiconsIcon
                                icon={SquareMinusIcon}
                                className="size-5 text-gray-300"
                                aria-label="Not granted"
                              />
                            ) : (
                              c.text
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
