"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader } from "@/components/ui/loader";
import { cn } from "@/lib/utils";
import type {
  EntitlementValue,
  Feature,
  MatrixResponse,
  MatrixTier,
  Price,
  TierVersion,
} from "./types";

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

// Delivery status of a FEATURE (the reference's LIVE / FLAG OFF / IN PROGRESS /
// PLANNED legend) — orthogonal to a tier version's draft/active/retired status.
const FEATURE_STATUS: Record<string, { label: string; className: string }> = {
  live: { label: "LIVE", className: "bg-emerald-100 text-emerald-800" },
  in_progress: { label: "IN PROGRESS", className: "bg-sky-100 text-sky-800" },
  flag_off: { label: "FLAG OFF", className: "bg-amber-100 text-amber-800" },
  planned: { label: "PLANNED", className: "bg-gray-100 text-gray-600" },
};
const LEGEND: { key: string; hint: string }[] = [
  { key: "live", hint: "shipped" },
  { key: "flag_off", hint: "built, waiting on the API" },
  { key: "in_progress", hint: "active branch" },
  { key: "planned", hint: "backlog" },
];

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

// A rendered entitlement cell: the display text plus whether it's a muted
// placeholder (so "—" reads lighter than a real value).
function cell(
  version: TierVersion | null,
  feature: Feature,
): { text: string; muted: boolean } {
  if (!version) return { text: "—", muted: true };
  // entitlements may be null over the wire (the proto field is optional).
  const entitlements = version.entitlements ?? {};
  if (!Object.prototype.hasOwnProperty.call(entitlements, feature.key)) {
    return { text: "—", muted: true };
  }
  const value: EntitlementValue = entitlements[feature.key];
  if (feature.valueType === "boolean") {
    return value ? { text: "✓", muted: false } : { text: "—", muted: true };
  }
  // numeric (or unknown type): null = unlimited.
  if (value === null || value === undefined) return { text: "∞", muted: false };
  if (typeof value === "boolean")
    return value ? { text: "✓", muted: false } : { text: "—", muted: true };
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
      return {
        label: `v${v.version} draft`,
        className: "text-amber-700",
      };
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

  // Grid: sticky-ish feature column + status column + one column per tier.
  const gridStyle = {
    gridTemplateColumns: `minmax(220px,2.4fr) minmax(104px,auto) repeat(${tiers.length}, minmax(112px,1fr))`,
  } as const;

  return (
    <div className="rounded-xl bg-primary">
      {/* Header bar + legend */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">
            Feature distribution
          </h2>
          <p className="mt-1 max-w-xl text-xs text-tertiary-foreground">
            Every catalog feature against each tier’s live version. Values come
            from the version’s entitlements; ∞ is unlimited, ✓ an enabled
            capability, — not granted. Read-only for now — authoring and
            assignment arrive next.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          {LEGEND.map(({ key, hint }) => {
            const s = FEATURE_STATUS[key];
            return (
              <span key={key} className="flex items-center gap-1.5 text-xs">
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide",
                    s.className,
                  )}
                >
                  {s.label}
                </span>
                <span className="text-tertiary-foreground">{hint}</span>
              </span>
            );
          })}
        </div>
      </div>

      <div className="overflow-x-auto rounded-b-xl">
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
          <div className="min-w-max">
            {/* Column header row: FEATURE · STATUS · one per tier */}
            <div
              className="grid items-end gap-3 border-b border-border px-6 py-3"
              style={gridStyle}
            >
              <span className="text-[11px] font-semibold uppercase tracking-wide text-tertiary-foreground">
                Feature
              </span>
              <span className="text-[11px] font-semibold uppercase tracking-wide text-tertiary-foreground">
                Status
              </span>
              {tiers.map((t) => {
                const v = shownVersion(t);
                const badge = versionBadge(v);
                const price = headlinePrice(v);
                return (
                  <div
                    key={t.tierId}
                    className="flex flex-col items-end gap-0.5 text-right"
                  >
                    <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
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
                <div
                  className="border-b border-border bg-secondary/40 px-6 py-2 text-[11px] font-semibold uppercase tracking-wide text-secondary-foreground"
                >
                  {CATEGORY_LABELS[category] ?? category.replace(/_/g, " ")}
                </div>
                <div className="divide-y divide-border">
                  {feats.map((f) => {
                    const s = FEATURE_STATUS[f.status];
                    return (
                      <div
                        key={f.key}
                        className="grid items-center gap-3 px-6 py-3 text-sm transition-colors hover:bg-secondary/30"
                        style={gridStyle}
                      >
                        {/* Feature name + description */}
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium text-foreground">
                            {f.name}
                          </span>
                          {f.description && (
                            <span className="truncate text-xs text-tertiary-foreground">
                              {f.description}
                            </span>
                          )}
                        </span>

                        {/* Delivery status chip + Linear issue */}
                        <span className="flex flex-col items-start gap-0.5">
                          {s ? (
                            <span
                              className={cn(
                                "rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide",
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
                        </span>

                        {/* One cell per tier */}
                        {tiers.map((t) => {
                          const c = cell(shownVersion(t), f);
                          return (
                            <span
                              key={t.tierId}
                              className={cn(
                                "text-right tabular-nums",
                                c.muted
                                  ? "text-tertiary-foreground"
                                  : "text-foreground",
                              )}
                            >
                              {c.text}
                            </span>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
