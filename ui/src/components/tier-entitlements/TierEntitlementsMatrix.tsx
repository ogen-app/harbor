"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CheckmarkSquare02Icon,
  GitBranchPlusIcon,
  InfinitySquareIcon,
  MoreHorizontalSquare02Icon,
  PencilEdit02Icon,
  SquareMinusIcon,
} from "@hugeicons/core-free-icons";
import { Loader } from "@/components/ui/loader";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { FEATURE_STATUS } from "./legend";
import { VersionFormDrawer } from "./VersionFormDrawer";
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
  return s;
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

// VersionStatusLabel is the small chip under a version header: draft / retired,
// or Purchasable / Active for a published version.
function VersionStatusLabel({ version }: { version: TierVersion }) {
  const { text, className } =
    version.status === "draft"
      ? { text: "Draft", className: "bg-amber-100 text-amber-800" }
      : version.status === "retired"
        ? { text: "Retired", className: "bg-gray-100 text-gray-600 line-through" }
        : version.purchasable
          ? { text: "Purchasable", className: "bg-[#6B8068]/15 text-[#4d5c48]" }
          : { text: "Active", className: "bg-gray-100 text-gray-600" };
  return (
    <span
      className={cn(
        "w-fit rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide",
        className,
      )}
    >
      {text}
    </span>
  );
}

// VersionInfoPill is the segmented pill under a version header: the headline
// price (mono, #6B8068) and the number of tenants assigned, split by a divider.
function VersionInfoPill({
  price,
  tenants,
}: {
  price: Price | null;
  tenants: number;
}) {
  return (
    <span className="inline-flex items-center rounded-full bg-secondary text-[11px] font-medium">
      <span className="px-2 py-0.5 font-mono text-base font-semibold text-[#6B8068]">
        {price ? formatMoney(price) : "—"}
      </span>
      <span aria-hidden className="h-3.5 w-px bg-border" />
      <span className="px-2 py-0.5 tabular-nums text-secondary-foreground">
        {tenants} {tenants === 1 ? "tenant" : "tenants"}
      </span>
    </span>
  );
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
  // Vertical scroll position → the top/bottom fade strips (hidden at the edges),
  // mirroring the /activity table.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const onScroll = (el: HTMLDivElement) => {
    setScrolled(el.scrollLeft > 0);
    setAtTop(el.scrollTop <= 0);
    setAtBottom(
      Math.ceil(el.scrollHeight - (el.scrollTop + el.clientHeight)) <= 0,
    );
  };

  // Version authoring drawer (create / update). The data is kept while the
  // drawer animates closed (drawerOpen drives visibility separately).
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawer, setDrawer] = useState<{
    mode: "create" | "update";
    tier: MatrixTier;
    version: TierVersion | null;
  } | null>(null);
  const openDrawer = (
    mode: "create" | "update",
    tier: MatrixTier,
    version: TierVersion | null,
  ) => {
    setDrawer({ mode, tier, version });
    setDrawerOpen(true);
  };

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

  // Recompute the fade strips once the table has rendered (and whenever the
  // data changes its height), so a non-scrolled overflowing table still shows
  // the bottom fade.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAtTop(el.scrollTop <= 0);
    setAtBottom(
      Math.ceil(el.scrollHeight - (el.scrollTop + el.clientHeight)) <= 0,
    );
  }, [data]);

  const available = data?.available ?? false;
  const features = data?.features ?? [];

  // One column per tier VERSION — every version of every tier is shown. Tiers
  // are ordered by name; within a tier, versions ascend (v1 … vN). A tier with
  // no versions still gets a placeholder column so it can be authored.
  const columns = useMemo(() => {
    const tiers = [...(data?.tiers ?? [])].sort((a, b) =>
      a.tierName.localeCompare(b.tierName),
    );
    return tiers.flatMap((t) =>
      t.versions.length === 0
        ? [{ tier: t, version: null as TierVersion | null }]
        : [...t.versions]
            .sort((a, b) => a.version - b.version)
            .map((v) => ({ tier: t, version: v as TierVersion | null })),
    );
  }, [data]);

  const grouped = useMemo(
    () => groupByCategory(data?.features ?? []),
    [data],
  );

  // Consecutive columns of one tier form a group with a single merged header.
  const tierGroups = useMemo(() => {
    const groups: { tier: MatrixTier; start: number; span: number }[] = [];
    for (let i = 0; i < columns.length; i++) {
      const last = groups[groups.length - 1];
      if (last && last.tier.tierId === columns[i].tier.tierId) last.span += 1;
      else groups.push({ tier: columns[i].tier, start: i, span: 1 });
    }
    return groups;
  }, [columns]);
  // A tier boundary is the Status→first-version edge (i === 0) or a tier→tier
  // edge — drawn with a 3px rule down the whole table. Header/band cells have no
  // rule between same-tier versions; feature-row cells keep the 1px divider.
  const tierBoundary = (i: number) =>
    i === 0 || columns[i].tier.tierId !== columns[i - 1].tier.tierId;
  const groupBorder = (i: number) =>
    tierBoundary(i) ? "border-l-[3px] border-border" : "";
  const cellBorder = (i: number) =>
    tierBoundary(i) ? "border-l-[3px] border-border" : "border-l border-border";

  // Contiguous tracks: Feature (frozen) · Status (frozen) · the tier columns
  // sharing the remaining width (minmax floor + 1fr). Fixed frozen widths keep
  // the pin offset deterministic; tableMinWidth is the floor before the table
  // scrolls sideways (and keeps row backgrounds spanning the full width).
  const gridTemplate = `${FEATURE_W}px ${STATUS_W}px repeat(${columns.length}, minmax(${TIER_MIN}px, 1fr))`;
  const tableMinWidth = FEATURE_W + STATUS_W + columns.length * TIER_MIN;

  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded-xl bg-primary">
      {/* The scroll region fills the card height (both axes scroll): the frozen
          Feature/Status block stays pinned horizontally (with a right-edge
          shadow while scrolled), and the column-header row stays pinned
          vertically (sticky top). */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto"
        onScroll={(e) => onScroll(e.currentTarget)}
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
        ) : features.length === 0 || columns.length === 0 ? (
          <p className="p-6 text-sm text-tertiary-foreground">
            No feature catalog or tiers to show yet.
          </p>
        ) : (
          <div className="w-full" style={{ minWidth: tableMinWidth }}>
            {/* Column header row — sticky at the top of the scroll region. Its
                own bg-primary keeps the (transparent) tier header cells opaque
                so body rows pass cleanly underneath. */}
            <div className="sticky top-0 z-30 bg-primary">
              {/* Sub-row A — one merged header per tier, spanning its version
                  columns; a 3px rule separates tiers. */}
              <div
                className="grid w-full"
                style={{ gridTemplateColumns: gridTemplate }}
              >
                <div
                  className={cn(
                    "sticky left-0 z-20 flex items-end bg-primary pt-2.5 pb-1",
                    EDGE_L,
                  )}
                >
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-tertiary-foreground">
                    Feature
                  </span>
                </div>
                <div
                  className={cn(
                    "sticky z-20 flex items-end bg-primary px-2 pt-2.5 pb-1",
                    scrolled && FROZEN_SHADOW,
                  )}
                  style={{ left: FEATURE_W }}
                >
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-tertiary-foreground">
                    Status
                  </span>
                </div>
                {tierGroups.map((g) => (
                  <div
                    key={g.tier.tierId}
                    className="flex items-center gap-1.5 border-l-[3px] border-border px-3 pt-2.5 pb-1 text-sm font-semibold text-foreground"
                    style={{ gridColumn: `${g.start + 3} / span ${g.span}` }}
                  >
                    {g.tier.tierColor && (
                      <span
                        aria-hidden
                        className="size-2 rounded-full"
                        style={{ backgroundColor: g.tier.tierColor }}
                      />
                    )}
                    {g.tier.tierName}
                  </div>
                ))}
              </div>

              {/* Sub-row B — per-version price, pill and actions. */}
              <div
                className="grid w-full border-b border-border"
                style={{ gridTemplateColumns: gridTemplate }}
              >
                <div className={cn("sticky left-0 z-20 bg-primary", EDGE_L)} />
                <div
                  className={cn(
                    "sticky z-20 bg-primary px-2",
                    scrolled && FROZEN_SHADOW,
                  )}
                  style={{ left: FEATURE_W }}
                />
                {columns.map(({ tier: t, version: v }, ci) => {
                  const price = headlinePrice(v);
                  return (
                    <div
                      key={v?.id ?? `${t.tierId}-empty-${ci}`}
                      className={cn(
                        "flex flex-col items-start gap-1.5 px-3 pb-2.5 pt-1 text-left",
                        groupBorder(ci),
                      )}
                    >
                      {/* version name + status on one line */}
                      <div className="flex w-full items-center gap-1.5">
                        <span className="text-sm font-semibold text-foreground">
                          {v ? `v${v.version}` : "—"}
                        </span>
                        {v && <VersionStatusLabel version={v} />}
                      </div>
                      {/* price + tenants info pill */}
                      {v && (
                        <VersionInfoPill
                          price={price}
                          tenants={v.liveAssignmentCount}
                        />
                      )}
                      {/* actions button, pinned to the bottom of the cell */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label={`${t.tierName} version actions`}
                            className="mt-auto flex cursor-pointer items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] font-medium text-tertiary-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground data-[state=open]:bg-secondary data-[state=open]:text-foreground"
                          >
                            <HugeiconsIcon
                              icon={MoreHorizontalSquare02Icon}
                              className="size-3.5"
                            />
                            Actions
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="min-w-44">
                          <DropdownMenuItem
                            onClick={() => openDrawer("create", t, v)}
                          >
                            <HugeiconsIcon
                              icon={GitBranchPlusIcon}
                              className="size-4"
                            />
                            Create new version
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={!v || v.status !== "draft"}
                            onClick={() => openDrawer("update", t, v)}
                          >
                            <HugeiconsIcon
                              icon={PencilEdit02Icon}
                              className="size-4"
                            />
                            Update this version
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  );
                })}
              </div>

              {/* Top fade — sits just below the sticky header (tracks its
                  height) and hides at the very top. Its bolder top border keeps
                  the header/first-row divider visible above the fade. */}
              <div
                aria-hidden
                className={cn(
                  "pointer-events-none absolute inset-x-0 top-full z-10 h-8 border-t border-border bg-linear-to-b from-primary to-transparent transition-opacity duration-200",
                  atTop ? "opacity-0" : "opacity-100",
                )}
              />
            </div>

            {/* Category bands + feature rows */}
            {grouped.map(([category, feats]) => (
              <div key={category}>
                {/* Band row: a continuous pale-yellow strip (no vertical rules).
                    The label spans the two frozen columns and stays pinned. */}
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
                  {columns.map(({ tier: t, version: v }, ci) => (
                    <div
                      key={v?.id ?? `${t.tierId}-empty-${ci}`}
                      className={groupBorder(ci)}
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

                      {/* One cell per tier version */}
                      {columns.map(({ tier: t, version: v }, ci) => {
                        const c = cell(v, f);
                        return (
                          <div
                            key={v?.id ?? `${t.tierId}-empty-${ci}`}
                            className={cn(
                              "flex items-center justify-center px-2 py-3 text-center tabular-nums transition-colors group-hover:bg-secondary",
                              cellBorder(ci),
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

      {/* Bottom fade — white-to-transparent, hidden once scrolled to the end
          (mirrors the /activity table). The top fade lives under the sticky
          header row so it tracks the header's height. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 z-20 h-8 bg-linear-to-t from-primary to-transparent transition-opacity duration-200",
          atBottom ? "opacity-0" : "opacity-100",
        )}
      />

      {/* Version authoring drawer (create / update this version). */}
      <VersionFormDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        mode={drawer?.mode ?? "create"}
        tierId={drawer?.tier.tierId ?? ""}
        tierName={drawer?.tier.tierName ?? ""}
        baseVersion={drawer?.version ?? null}
        siblingVersions={drawer?.tier.versions ?? []}
        features={features}
        onSaved={() => reload()}
      />
    </div>
  );
}
