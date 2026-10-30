// Pure view-model for the tier-entitlements ledger (CON-321): which version of
// each tier is shown, in what order, and how a single entitlement value reads.
// No React here, so the matrix, the cell editor and the publish review all
// derive the same answers from the same /api/tier-entitlements payload.

import type {
  EntitlementValue,
  Feature,
  MatrixTier,
  Price,
  TierVersion,
} from "./types";

// ── categories ───────────────────────────────────────────────────────────────

// Category order + labels from the CON-243 feature catalog. Unknown categories
// are appended in first-seen order under a de-snaked fallback label.
const CATEGORY_ORDER = [
  "workspace_team",
  "campaigns_planning",
  "ai_superpowers",
  "posts_publishing",
  "content_bank",
  "images_brand",
  "workflow_platform",
];
export const CATEGORY_LABELS: Record<string, string> = {
  workspace_team: "Workspace & team",
  campaigns_planning: "Campaigns & planning",
  ai_superpowers: "AI superpowers",
  posts_publishing: "Posts & publishing",
  content_bank: "Content bank",
  images_brand: "Images & brand",
  workflow_platform: "Workflow & platform",
};

export const categoryLabel = (c: string) =>
  CATEGORY_LABELS[c] ?? c.replace(/_/g, " ");

export function groupByCategory(features: Feature[]): [string, Feature[]][] {
  const byCat = new Map<string, Feature[]>();
  for (const f of features) {
    const list = byCat.get(f.category) ?? [];
    list.push(f);
    byCat.set(f.category, list);
  }
  const ordered = CATEGORY_ORDER.filter((c) => byCat.has(c));
  const rest = [...byCat.keys()].filter((c) => !CATEGORY_ORDER.includes(c));
  return [...ordered, ...rest].map((c) => [c, byCat.get(c)!]);
}

// ── units ────────────────────────────────────────────────────────────────────

// Byte- and multiplier-valued numerics are still told apart by key suffix; the
// catalog has no unit field yet (CON-321 follow-up).
export const isBytes = (f: Feature) => f.key.endsWith("_bytes");
export const isMultiplier = (f: Feature) => f.key.endsWith("_multiplier");

// unitLabel is the muted suffix after a feature's name: its reset period, or
// "multiplier". Standing limits (a plain cap) have none.
export function unitLabel(f: Feature): string {
  if (f.valueType === "boolean") return "";
  if (isMultiplier(f)) return "multiplier";
  switch (f.reset) {
    case "monthly":
      return "per month";
    case "per_post":
      return "per post";
    case "total":
      return "lifetime";
    default:
      return "";
  }
}

// formatBytes humanises a byte count: 104857600 → "100 MB", 1073741824 →
// "1 GB", 10737418240 → "10 GB".
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  }
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

// ── cells ────────────────────────────────────────────────────────────────────

// The five states a cell can be in. "unset" is an absent key: Ogen's limiter
// fails OPEN on it (no limit, gate enabled), so it must never look like
// "excluded".
export type CellKind = "count" | "unlimited" | "included" | "excluded" | "unset";

export interface CellView {
  kind: CellKind;
  text: string;
}

// The raw value of a feature on a version; undefined means the key is absent.
export function rawValue(
  v: TierVersion | null,
  f: Feature,
): EntitlementValue | undefined {
  const ent = v?.entitlements ?? {};
  return Object.prototype.hasOwnProperty.call(ent, f.key)
    ? ent[f.key]
    : undefined;
}

export function describe(
  f: Feature,
  value: EntitlementValue | undefined,
): CellView {
  if (value === undefined) return { kind: "unset", text: "not set" };
  if (f.valueType === "boolean" || typeof value === "boolean") {
    return value
      ? { kind: "included", text: "Included" }
      : { kind: "excluded", text: "Not included" };
  }
  if (value === null) return { kind: "unlimited", text: "∞" };
  if (value === 0) return { kind: "excluded", text: "Not included" };
  if (isBytes(f)) return { kind: "count", text: formatBytes(value) };
  if (isMultiplier(f)) return { kind: "count", text: `×${value}` };
  return { kind: "count", text: value.toLocaleString("en-US") };
}

// generosity orders values so tiers can be compared: more is more generous.
// Unset returns null (open, but not a decision anyone made) and is never
// compared.
function generosity(
  f: Feature,
  value: EntitlementValue | undefined,
): number | null {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === null) return Number.POSITIVE_INFINITY;
  return f.valueType === "boolean" ? (value ? 1 : 0) : value;
}

export const sameValue = (
  a: EntitlementValue | undefined,
  b: EntitlementValue | undefined,
) => a === b;

// ── versions & columns ───────────────────────────────────────────────────────

// liveVersion is the tier's version in force for new purchases: its active
// purchasable version, else its newest active one.
export function liveVersion(t: MatrixTier): TierVersion | null {
  const active = t.versions.filter((v) => v.status === "active");
  return (
    active.find((v) => v.purchasable) ??
    [...active].sort((a, b) => b.version - a.version)[0] ??
    null
  );
}

export function draftVersion(t: MatrixTier): TierVersion | null {
  return (
    t.versions
      .filter((v) => v.status === "draft")
      .sort((a, b) => b.version - a.version)[0] ?? null
  );
}

// headlinePrice is the price shown in a tier header: the default (no country)
// monthly price, falling back to any monthly, then the first price.
export function headlinePrice(v: TierVersion | null): Price | null {
  if (!v || v.prices.length === 0) return null;
  const monthly = v.prices.filter((p) => p.billingInterval === "month");
  return (
    monthly.find((p) => !p.countryCode) ?? monthly[0] ?? v.prices[0] ?? null
  );
}

export function formatMoney(p: Price): string {
  const major = p.netMinor / 100;
  try {
    return new Intl.NumberFormat("en-IE", {
      style: "currency",
      currency: p.currency || "EUR",
      minimumFractionDigits: Number.isInteger(major) ? 0 : 2,
    }).format(major);
  } catch {
    return `${major} ${p.currency}`;
  }
}

// An internal tier is live but not sold and has no price — today the Default
// tier, which grandfathers workspaces created before pricing. It sits last,
// muted, and is left out of inversion checks.
export function isInternal(t: MatrixTier): boolean {
  const live = liveVersion(t);
  return !!live && !live.purchasable && headlinePrice(live) === null;
}

// orderTiers puts tiers on a ladder: cheapest headline price first (the live
// version's, else the draft's), unpriced tiers by name after them, and
// internal tiers last.
export function orderTiers(tiers: MatrixTier[]): MatrixTier[] {
  const priceOf = (t: MatrixTier) =>
    headlinePrice(liveVersion(t) ?? draftVersion(t))?.netMinor ??
    Number.POSITIVE_INFINITY;
  return [...tiers].sort(
    (a, b) =>
      Number(isInternal(a)) - Number(isInternal(b)) ||
      priceOf(a) - priceOf(b) ||
      a.tierName.localeCompare(b.tierName),
  );
}

export type ColumnKind = "live" | "draft" | "internal" | "none";

export interface Column {
  tier: MatrixTier;
  version: TierVersion | null;
  kind: ColumnKind;
  // The version a draft column is compared against (its tier's live version).
  base: TierVersion | null;
}

// buildColumns lays out one column per tier (its live version) and, with
// drafts shown, each tier's draft right after it. A tier with no live version
// keeps a placeholder column in the live view so the ladder doesn't shift.
export function buildColumns(tiers: MatrixTier[], withDrafts: boolean): Column[] {
  const out: Column[] = [];
  for (const t of orderTiers(tiers)) {
    const live = liveVersion(t);
    const draft = withDrafts ? draftVersion(t) : null;
    if (live || !draft) {
      out.push({
        tier: t,
        version: live,
        kind: !live ? "none" : isInternal(t) ? "internal" : "live",
        base: null,
      });
    }
    if (draft) out.push({ tier: t, version: draft, kind: "draft", base: live });
  }
  return out;
}

// ── drafts ───────────────────────────────────────────────────────────────────

export interface Change {
  feature: Feature;
  from: EntitlementValue | undefined;
  to: EntitlementValue | undefined;
}

// diffVersions lists the features whose value differs between a draft and the
// version it will replace (all set values when there is none).
export function diffVersions(
  features: Feature[],
  draft: TierVersion,
  base: TierVersion | null,
): Change[] {
  return features
    .map((f) => ({ feature: f, from: rawValue(base, f), to: rawValue(draft, f) }))
    .filter((c) => !sameValue(c.from, c.to));
}

export interface Inversion {
  // The neighbouring tier the draft value is out of line with.
  tierName: string;
  value: EntitlementValue | undefined;
  // "above": the draft gives more than a higher tier; "below": a lower tier
  // gives more than the draft.
  direction: "above" | "below";
}

// inversionFor checks a draft value against the live values of the sold tiers
// directly below and above its tier on the ladder. Internal tiers and unset
// values are never compared.
export function inversionFor(
  tiers: MatrixTier[],
  tierId: string,
  f: Feature,
  value: EntitlementValue | undefined,
): Inversion | null {
  const ladder = orderTiers(tiers).filter((t) => !isInternal(t));
  const i = ladder.findIndex((t) => t.tierId === tierId);
  const mine = generosity(f, value);
  if (i < 0 || mine === null) return null;
  const higher = ladder[i + 1];
  if (higher) {
    const hv = rawValue(liveVersion(higher), f);
    const g = generosity(f, hv);
    if (g !== null && mine > g) {
      return { tierName: higher.tierName, value: hv, direction: "above" };
    }
  }
  const lower = ladder[i - 1];
  if (lower) {
    const lv = rawValue(liveVersion(lower), f);
    const g = generosity(f, lv);
    if (g !== null && g > mine) {
      return { tierName: lower.tierName, value: lv, direction: "below" };
    }
  }
  return null;
}

// neighbours lists the other tiers' live values for a feature, in ladder
// order, for the cell editor's context line.
export function neighbours(
  tiers: MatrixTier[],
  tierId: string,
  f: Feature,
): { tierName: string; value: EntitlementValue | undefined }[] {
  return orderTiers(tiers)
    .filter((t) => t.tierId !== tierId && !isInternal(t))
    .map((t) => ({ tierName: t.tierName, value: rawValue(liveVersion(t), f) }))
    .filter((n) => n.value !== undefined);
}

// ── page-level facts ─────────────────────────────────────────────────────────

// notSetFeatures lists features absent from every shown live version.
export function notSetFeatures(features: Feature[], columns: Column[]): Feature[] {
  const live = columns.filter((c) => c.kind === "live" || c.kind === "internal");
  if (live.length === 0) return [];
  return features.filter((f) =>
    live.every((c) => rawValue(c.version, f) === undefined),
  );
}

// rowDiffers reports whether a feature's value varies across the shown sold
// columns (the "Only rows that differ" filter).
export function rowDiffers(f: Feature, columns: Column[]): boolean {
  const vals = columns
    .filter((c) => c.kind === "live" || c.kind === "draft")
    .map((c) => rawValue(c.version, f));
  return vals.some((v) => !sameValue(v, vals[0]));
}

export const plural = (n: number, word: string) =>
  `${n} ${word}${n === 1 ? "" : "s"}`;
