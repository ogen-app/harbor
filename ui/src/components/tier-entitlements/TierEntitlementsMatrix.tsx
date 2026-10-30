"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert01Icon,
  Archive02Icon,
  GitBranchPlusIcon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  Search01Icon,
  SquareLock01Icon,
  Tag01Icon,
  Tick02Icon,
  WorkHistoryIcon,
} from "@hugeicons/core-free-icons";
import type { VariantMappingsResponse } from "@/components/billing/types";
import { Loader } from "@/components/ui/loader";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { CellEditor } from "./CellEditor";
import { FeatureStatusChip } from "./legend";
import {
  buildColumns,
  categoryLabel,
  describe,
  diffVersions,
  draftVersion,
  formatMoney,
  groupByCategory,
  headlinePrice,
  inversionFor,
  isInternal,
  liveVersion,
  neighbours,
  notSetFeatures,
  plural,
  rawValue,
  rowDiffers,
  unitLabel,
  type Column,
} from "./model";
import { ReleaseBar } from "./ReleaseBar";
import { RetireVersionDrawer } from "./RetireVersionDrawer";
import { VersionFormDrawer } from "./VersionFormDrawer";
import { VersionHistoryDrawer } from "./VersionHistoryDrawer";
import type {
  EntitlementValue,
  Feature,
  MatrixResponse,
  MatrixTier,
  TierVersion,
} from "./types";

// ── layout ────────────────────────────────────────────────────────────────────
// The Feature column is frozen at the left; one column per tier (its live
// version) and, with drafts shown, each draft right after it. Tiers are set
// apart by a 1.5px rule, versions of one tier by a hairline (CON-321).
const FEATURE_W = 280; // px — frozen
const COL_MIN = 160; // px — tier/version column floor before the table scrolls
const TIER_RULE = "border-l-[1.5px] border-l-[#bdb6aa]";
const VERSION_RULE = "border-l border-l-border";
const BAND_BG = "#F5F4ED";
const DRAFT_WASH = "bg-[#2350d2]/[0.05]";
const INTERNAL_WASH = "bg-[#3c2800]/[0.025]";
const SAVE_DELAY = 400; // ms — autosave debounce for draft cell edits

export interface EntitlementsSummary {
  features: number;
  onSale: number;
  notSet: number;
  drafts: number;
}

type FilterMode = "all" | "differ" | "unset";

const isTyping = (el: EventTarget | null) => {
  const t = el as HTMLElement | null;
  return (
    !!t &&
    (t.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) ||
      !!t.closest?.('[role="combobox"],[role="textbox"],[role="menu"],[role="dialog"]'))
  );
};

async function errorText(res: Response): Promise<string> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  return j?.error || `Request failed (${res.status})`;
}

// CellValue draws one entitlement value in the CON-321 cell vocabulary. Only
// "included" is a glyph; "not set" (absent key, fails open) is amber and
// dotted so it can't be read as "not included".
function CellValue({
  feature,
  value,
  tone,
}: {
  feature: Feature;
  value: EntitlementValue | undefined;
  tone: "live" | "draft" | "internal";
}) {
  const d = describe(feature, value);
  const color =
    tone === "draft"
      ? "text-editable"
      : tone === "internal"
        ? "text-secondary-foreground"
        : "text-foreground";
  switch (d.kind) {
    case "unset":
      return (
        <span className="text-xs font-medium text-amber-700 underline decoration-amber-600 decoration-dotted underline-offset-[3px]">
          not set
        </span>
      );
    case "included":
      return <HugeiconsIcon icon={Tick02Icon} aria-label="Included" className={cn("size-4", color)} />;
    case "excluded":
      return (
        <span aria-label="Not included" className={tone === "draft" ? "text-editable" : "text-secondary-foreground"}>
          —
        </span>
      );
    case "unlimited":
      return (
        <span aria-label="Unlimited" className={cn("text-[15px] leading-none", color)}>
          ∞
        </span>
      );
    default:
      return <span className={cn("font-medium", color)}>{d.text}</span>;
  }
}

// TierEntitlementsMatrix is the operator view of CON-243 versioned tier
// entitlements, redesigned in CON-321: a ladder of tiers in price order, the
// not-set (fail-open) state called out, drafts staged in place with inline
// editing, and publishing through a review that names its effect. All state is
// Ogen's, via /api/tier-entitlements.
export function TierEntitlementsMatrix({
  onSummary,
}: {
  onSummary?: (s: EntitlementsSummary) => void;
}) {
  const [data, setData] = useState<MatrixResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [withDrafts, setWithDrafts] = useState(false);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<FilterMode>("all");
  const filterRef = useRef<HTMLInputElement>(null);

  // Keyboard focus: a row index into the visible features and a column index.
  const [active, setActive] = useState<{ row: number; col: number } | null>(null);
  // The open popover: the draft cell editor, or the "start a draft" offer on a
  // locked cell. Keyed by feature + version (or tier for the offer).
  const [editing, setEditing] = useState<{ feature: string; version: string } | null>(null);
  const [offer, setOffer] = useState<{ feature: string; tier: string } | null>(null);

  // Drawers: prices/sale status of a draft, guarded retire, version history.
  const [pricesFor, setPricesFor] = useState<{ tier: MatrixTier; version: TierVersion } | null>(null);
  const [pricesOpen, setPricesOpen] = useState(false);
  const [retireFor, setRetireFor] = useState<{ tier: MatrixTier; version: TierVersion } | null>(null);
  const [retireOpen, setRetireOpen] = useState(false);
  const [historyFor, setHistoryFor] = useState<MatrixTier | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);

  // ── data ──────────────────────────────────────────────────────────────────
  const reload = useCallback((signal?: AbortSignal) => {
    return fetch("/api/tier-entitlements", { signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        return r.json() as Promise<MatrixResponse>;
      })
      .then((json) => {
        // entitlements may be null over the wire (the proto field is optional).
        for (const t of json.tiers ?? []) {
          for (const v of t.versions) v.entitlements = v.entitlements ?? {};
        }
        setData(json);
        setLoadError(null);
      })
      .catch((e: unknown) => {
        if (signal?.aborted) return;
        setLoadError(e instanceof Error ? e.message : "Failed to load tier entitlements.");
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

  const features = useMemo(() => data?.features ?? [], [data]);
  const tiers = useMemo(() => data?.tiers ?? [], [data]);
  const draftCount = tiers.filter((t) => draftVersion(t)).length;
  const columns = useMemo(() => buildColumns(tiers, withDrafts), [tiers, withDrafts]);
  const notSet = useMemo(() => notSetFeatures(features, buildColumns(tiers, false)), [features, tiers]);

  useEffect(() => {
    if (!data?.available) return;
    onSummary?.({
      features: features.length,
      onSale: tiers.filter((t) => liveVersion(t)?.purchasable).length,
      notSet: notSet.length,
      drafts: draftCount,
    });
  }, [data, features.length, tiers, notSet.length, draftCount, onSummary]);

  // ── autosave of draft edits ────────────────────────────────────────────────
  // Edits land in local state at once and are PUT to Ogen after a short pause.
  // The latest state is read through a ref so a timer never saves stale data.
  const dataRef = useRef(data);
  useEffect(() => {
    dataRef.current = data;
  });
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const saveDraft = useCallback(async (versionId: string) => {
    const v = dataRef.current?.tiers.flatMap((t) => t.versions).find((x) => x.id === versionId);
    if (!v) return;
    setSaving((s) => new Set(s).add(versionId));
    try {
      const r = await fetch(`/api/tier-entitlements/versions/${encodeURIComponent(versionId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purchasable: v.purchasable, entitlements: v.entitlements ?? {}, prices: v.prices }),
      });
      if (!r.ok) throw new Error(await errorText(r));
      setSaveErr(null);
    } catch (e) {
      setSaveErr(e instanceof Error ? `Couldn’t save the draft: ${e.message}` : "Couldn’t save the draft.");
      reload();
    } finally {
      // Another edit may have been queued while this save ran; it keeps the
      // version marked as saving until its own save finishes.
      if (!timers.current.has(versionId)) {
        setSaving((s) => {
          const n = new Set(s);
          n.delete(versionId);
          return n;
        });
      }
    }
  }, [reload]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  const setDraftValue = (versionId: string, key: string, value: EntitlementValue | undefined) => {
    setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        tiers: prev.tiers.map((t) => ({
          ...t,
          versions: t.versions.map((v) => {
            if (v.id !== versionId) return v;
            const ent = { ...(v.entitlements ?? {}) };
            if (value === undefined) delete ent[key];
            else ent[key] = value;
            return { ...v, entitlements: ent };
          }),
        })),
      };
    });
    setSaving((s) => (s.has(versionId) ? s : new Set(s).add(versionId)));
    const prevTimer = timers.current.get(versionId);
    if (prevTimer) clearTimeout(prevTimer);
    timers.current.set(
      versionId,
      setTimeout(() => {
        timers.current.delete(versionId);
        saveDraft(versionId);
      }, SAVE_DELAY),
    );
  };

  // ── actions ─────────────────────────────────────────────────────────────────
  // startDraft clones the tier's live version into a new draft. The body is
  // copied verbatim, so a key absent on the live version stays absent (not
  // set) rather than turning into "not included".
  const startDraft = async (t: MatrixTier) => {
    const live = liveVersion(t);
    setActionErr(null);
    try {
      const r = await fetch(`/api/tier-entitlements/tiers/${encodeURIComponent(t.tierId)}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          purchasable: live?.purchasable ?? true,
          entitlements: live?.entitlements ?? {},
          prices: live?.prices ?? [],
        }),
      });
      if (!r.ok) throw new Error(await errorText(r));
      setWithDrafts(true);
      setOffer(null);
      await reload();
    } catch (e) {
      setActionErr(e instanceof Error ? `Couldn’t start a draft: ${e.message}` : "Couldn’t start a draft.");
    }
  };

  // After a publish: the version's prices that Lemon Squeezy can't sell yet in
  // the mode Ogen runs in (CON-407 §C). Publishing never waits for this.
  const [unsold, setUnsold] = useState<{ versionId: string; label: string; count: number } | null>(null);
  const checkMapping = useCallback(async (versionId: string) => {
    try {
      const s = await fetch("/api/billing/settings").then((r) => (r.ok ? r.json() : null));
      if (!s?.available || !s.settings?.provider || s.settings.provider === "none") return;
      const m = s.settings.testMode ? "test" : "live";
      const j = (await fetch(`/api/billing/variant-mappings?mode=${m}`).then((r) =>
        r.ok ? r.json() : null,
      )) as VariantMappingsResponse | null;
      const bad = (j?.mappings ?? []).filter((x) => x.tierVersionId === versionId && x.status !== "ok");
      if (bad.length > 0) {
        setUnsold({ versionId, label: `${bad[0].tierName} v${bad[0].tierVersion}`, count: bad.length });
      }
    } catch {
      // Billing is optional here: a failed check just shows no link.
    }
  }, []);

  // ── visible rows ────────────────────────────────────────────────────────────
  const notSetKeys = useMemo(() => new Set(notSet.map((f) => f.key)), [notSet]);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groupByCategory(features)
      .map(([cat, feats]) => [
        cat,
        feats.filter(
          (f) =>
            (!q || f.name.toLowerCase().includes(q) || f.description.toLowerCase().includes(q)) &&
            (mode === "all" ||
              (mode === "differ" && rowDiffers(f, columns)) ||
              (mode === "unset" && columns.some((c) => c.version && rawValue(c.version, f) === undefined))),
        ),
      ] as [string, Feature[]])
      .filter(([, feats]) => feats.length > 0);
  }, [features, query, mode, columns]);
  const rows = useMemo(() => groups.flatMap(([, feats]) => feats), [groups]);

  // Changes per draft column, for the header count, the dots and the bar.
  const changesByVersion = useMemo(() => {
    const m = new Map<string, ReturnType<typeof diffVersions>>();
    for (const c of columns) {
      if (c.kind === "draft" && c.version) m.set(c.version.id, diffVersions(features, c.version, c.base));
    }
    return m;
  }, [columns, features]);

  // ── keyboard ────────────────────────────────────────────────────────────────
  // j/k rows, h/l columns, ↵ edits a draft cell (or offers a draft on a locked
  // one), / filters, d toggles drafts. "?" belongs to the page's help panel.
  const latest = useRef({ rows, columns, active, editing, offer });
  useEffect(() => {
    latest.current = { rows, columns, active, editing, offer };
  });
  const openCell = useCallback((row: number, col: number) => {
    const { rows, columns } = latest.current;
    const f = rows[row];
    const c = columns[col];
    if (!f || !c) return;
    if (c.kind === "draft" && c.version) setEditing({ feature: f.key, version: c.version.id });
    else if (!draftVersion(c.tier)) setOffer({ feature: f.key, tier: c.tier.tierId });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const { rows, columns, active, editing, offer } = latest.current;
      if (editing || offer) return; // the popover owns the keyboard
      const nR = rows.length;
      const nC = columns.length;
      const cur = active ?? { row: -1, col: 0 };
      const move = (row: number, col: number) => {
        e.preventDefault();
        setActive({ row: Math.max(0, Math.min(row, nR - 1)), col: Math.max(0, Math.min(col, nC - 1)) });
      };
      switch (e.key) {
        case "j":
        case "ArrowDown":
          if (nR) move(cur.row + 1, cur.col);
          break;
        case "k":
        case "ArrowUp":
          if (nR) move(cur.row - 1, cur.col);
          break;
        case "l":
        case "ArrowRight":
          if (nR) move(Math.max(cur.row, 0), cur.col + 1);
          break;
        case "h":
        case "ArrowLeft":
          if (nR) move(Math.max(cur.row, 0), cur.col - 1);
          break;
        case "Enter":
        case "o":
          if ((e.target as HTMLElement | null)?.closest?.("button,a[href]")) return;
          if (active && active.row >= 0) {
            e.preventDefault();
            openCell(active.row, active.col);
          }
          break;
        case "/":
          e.preventDefault();
          filterRef.current?.focus();
          break;
        case "d":
          e.preventDefault();
          setWithDrafts((w) => !w);
          break;
        case "Escape":
          setActive(null);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openCell]);

  // Keep the active cell in view.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-row-index="${active.row}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // ── scroll edge faders ──────────────────────────────────────────────────────
  const [scrolled, setScrolled] = useState(false);
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const measure = (el: HTMLDivElement) => {
    setScrolled(el.scrollLeft > 0);
    setAtTop(el.scrollTop <= 0);
    setAtBottom(Math.ceil(el.scrollHeight - (el.scrollTop + el.clientHeight)) <= 0);
  };
  useEffect(() => {
    if (scrollRef.current) measure(scrollRef.current);
  }, [data, rows.length, withDrafts]);

  // ── render ──────────────────────────────────────────────────────────────────
  const available = data?.available ?? false;
  const gridTemplate = `${FEATURE_W}px repeat(${columns.length}, minmax(${COL_MIN}px, 1fr))`;
  const tableMinWidth = FEATURE_W + columns.length * COL_MIN;
  const ruleFor = (i: number) =>
    i === 0 || columns[i].tier.tierId !== columns[i - 1].tier.tierId ? TIER_RULE : VERSION_RULE;
  const washFor = (c: Column) =>
    c.kind === "draft" ? DRAFT_WASH : c.kind === "internal" ? INTERNAL_WASH : "";
  const frozenShadow = scrolled ? "shadow-[6px_0_12px_-4px_rgb(60_40_0/0.12)]" : "";

  // One merged header cell per run of columns of the same tier.
  const tierGroups: { tier: MatrixTier; start: number; span: number }[] = [];
  columns.forEach((c, i) => {
    const last = tierGroups[tierGroups.length - 1];
    if (last && last.tier.tierId === c.tier.tierId) last.span += 1;
    else tierGroups.push({ tier: c.tier, start: i, span: 1 });
  });

  const draftColumns = columns.filter((c) => c.kind === "draft" && c.version);

  let body: ReactNode;
  if (loading) {
    body = (
      <div className="flex items-center gap-2 p-6 text-sm text-secondary-foreground">
        <Loader className="size-3.5 border-[1.5px]" />
        Loading…
      </div>
    );
  } else if (loadError) {
    body = <p className="p-6 text-sm text-destructive">{loadError}</p>;
  } else if (!available) {
    body = (
      <p className="p-6 text-sm text-secondary-foreground">
        The tier-entitlement service is unavailable. Check that Ogen is running and that Harbor’s{" "}
        <code>OGEN_GRPC_ADDR</code> / <code>OGEN_GRPC_TOKEN</code> are configured.
      </p>
    );
  } else if (features.length === 0 || columns.length === 0) {
    body = <p className="p-6 text-sm text-secondary-foreground">No feature catalog or tiers to show yet.</p>;
  } else {
    body = (
      <div className="w-full" style={{ minWidth: tableMinWidth }}>
        {/* Sticky two-line header: row A merged per tier, row B per version. */}
        <div className="sticky top-0 z-30 bg-primary">
          <div
            className="grid w-full border-b border-[#d6d1c8]"
            style={{ gridTemplateColumns: gridTemplate, gridTemplateRows: "32px 30px" }}
          >
            <div
              className={cn(
                "sticky left-0 z-20 row-span-2 flex items-center border-r-[1.5px] border-r-[#bdb6aa] bg-primary pl-6",
                frozenShadow,
              )}
              style={{ gridRow: "1 / span 2" }}
            >
              <span className="text-xs font-semibold uppercase tracking-wide text-secondary-foreground">
                Feature
              </span>
            </div>
            {tierGroups.map((g) => (
              <TierHeader
                key={g.tier.tierId}
                tier={g.tier}
                gridColumn={`${g.start + 2} / span ${g.span}`}
                first={g.start === 0}
                withDrafts={withDrafts}
                onStartDraft={() => startDraft(g.tier)}
                onShowDraft={() => setWithDrafts(true)}
                onPrices={(v) => {
                  setPricesFor({ tier: g.tier, version: v });
                  setPricesOpen(true);
                }}
                onHistory={() => {
                  setHistoryFor(g.tier);
                  setHistoryOpen(true);
                }}
                onRetire={(v) => {
                  setRetireFor({ tier: g.tier, version: v });
                  setRetireOpen(true);
                }}
              />
            ))}
            {columns.map((c, i) => (
              <VersionHeader
                key={`${c.tier.tierId}-${c.version?.id ?? "none"}`}
                column={c}
                changes={c.version ? (changesByVersion.get(c.version.id)?.length ?? 0) : 0}
                className={cn(ruleFor(i), i > 0 && columns[i - 1].tier.tierId === c.tier.tierId && "border-t border-t-border", washFor(c))}
                style={{ gridColumn: i + 2, gridRow: 2 }}
              />
            ))}
          </div>
          {/* Top fader: tracks the header's height, hidden at the very top. */}
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-x-0 top-full z-10 h-8 bg-linear-to-b from-primary to-transparent transition-opacity duration-200",
              atTop ? "opacity-0" : "opacity-100",
            )}
          />
        </div>

        {groups.map(([category, feats]) => (
          <Fragment key={category}>
            {/* Category band: full width, tinted, no column dividers. */}
            <div className="flex h-[30px] items-center border-b border-border" style={{ backgroundColor: BAND_BG }}>
              <span className="sticky left-0 flex items-center gap-2 pl-6 text-xs font-semibold uppercase tracking-wide text-[#5f5a54]">
                {categoryLabel(category)}
                <span className="font-medium text-secondary-foreground">{feats.length}</span>
              </span>
            </div>
            {feats.map((f) => {
              const rowIndex = rows.indexOf(f);
              const rowActive = active?.row === rowIndex;
              const unit = unitLabel(f);
              return (
                <div
                  key={f.key}
                  data-row-index={rowIndex}
                  className={cn(
                    "group grid w-full border-b border-border text-[13px] transition-colors hover:bg-secondary",
                    rowActive && "bg-secondary",
                  )}
                  style={{ gridTemplateColumns: gridTemplate }}
                >
                  <div
                    className={cn(
                      "sticky left-0 z-10 flex min-w-0 items-center gap-2 border-r-[1.5px] border-r-[#bdb6aa] bg-primary py-2.5 pr-3 pl-6 transition-colors group-hover:bg-secondary",
                      rowActive && "bg-secondary",
                      frozenShadow,
                    )}
                    title={f.description || undefined}
                  >
                    <span className="truncate font-medium text-foreground">{f.name}</span>
                    {unit && <span className="shrink-0 text-xs text-secondary-foreground">{unit}</span>}
                    {notSetKeys.has(f.key) && mode !== "unset" && (
                      <HugeiconsIcon icon={Alert01Icon} aria-label="Not set on any tier" className="size-3.5 shrink-0 text-amber-700" />
                    )}
                    <FeatureStatusChip status={f.status} />
                  </div>
                  {columns.map((c, ci) => (
                    <MatrixCell
                      key={`${c.tier.tierId}-${c.version?.id ?? "none"}`}
                      feature={f}
                      column={c}
                      tiers={tiers}
                      className={cn(ruleFor(ci), washFor(c))}
                      focused={rowActive && active?.col === ci}
                      editing={!!c.version && editing?.feature === f.key && editing.version === c.version.id}
                      offering={offer?.feature === f.key && offer.tier === c.tier.tierId && c.kind !== "draft"}
                      onOpen={() => {
                        setActive({ row: rowIndex, col: ci });
                        openCell(rowIndex, ci);
                      }}
                      onClose={() => {
                        setEditing(null);
                        setOffer(null);
                      }}
                      onChange={(v) => c.version && setDraftValue(c.version.id, f.key, v)}
                      onStartDraft={() => startDraft(c.tier)}
                    />
                  ))}
                </div>
              );
            })}
          </Fragment>
        ))}
        {rows.length === 0 && (
          <p className="px-6 py-8 text-[13px] text-secondary-foreground">
            No features match.{" "}
            <button
              type="button"
              className="cursor-pointer font-medium text-foreground underline-offset-2 hover:underline"
              onClick={() => {
                setQuery("");
                setMode("all");
              }}
            >
              Show all
            </button>
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* Toolbar: filter, only-differ toggle, Live / With drafts switch. */}
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <label className="flex h-8 w-60 items-center gap-2 rounded-xs border border-border bg-primary px-2.5 focus-within:border-foreground/40">
          <HugeiconsIcon icon={Search01Icon} className="size-3.5 text-secondary-foreground" />
          <input
            ref={filterRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                e.currentTarget.blur();
              }
            }}
            placeholder="Filter features"
            aria-label="Filter features"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-secondary-foreground"
          />
          <kbd className="rounded-xs border border-border bg-secondary px-1 text-[11px] text-secondary-foreground">/</kbd>
        </label>
        <button
          type="button"
          role="switch"
          aria-checked={mode === "differ"}
          onClick={() => setMode((m) => (m === "differ" ? "all" : "differ"))}
          className="flex h-8 cursor-pointer items-center gap-2 rounded-xs border border-border bg-primary px-3 text-[13px] text-secondary-foreground hover:text-foreground"
        >
          <span
            aria-hidden
            className={cn(
              "relative h-3 w-[22px] rounded-full transition-colors",
              mode === "differ" ? "bg-foreground" : "bg-border",
            )}
          >
            <span
              className={cn(
                "absolute top-[1.5px] size-[9px] rounded-full bg-primary transition-transform",
                mode === "differ" ? "translate-x-[11.5px]" : "translate-x-[1.5px]",
              )}
            />
          </span>
          Only rows that differ
        </button>
        {mode === "unset" && (
          <button
            type="button"
            onClick={() => setMode("all")}
            className="h-8 cursor-pointer rounded-xs border border-amber-300 bg-amber-50 px-3 text-[13px] font-medium text-amber-800"
          >
            Showing not-set rows · Show all
          </button>
        )}
        <div role="radiogroup" aria-label="Versions shown" className="ml-auto flex h-8 rounded-xs border border-border bg-primary p-0.5">
          {[
            { on: false, label: "Live" },
            { on: true, label: "With drafts" },
          ].map((o) => (
            <button
              key={o.label}
              type="button"
              role="radio"
              aria-checked={withDrafts === o.on}
              onClick={() => setWithDrafts(o.on)}
              className={cn(
                "flex cursor-pointer items-center gap-1.5 rounded-xs px-3 text-[13px] transition-colors",
                withDrafts === o.on ? "bg-secondary font-medium text-foreground" : "text-secondary-foreground hover:text-foreground",
              )}
            >
              {o.label}
              {o.on && draftCount > 0 && <span className="font-medium text-editable">{draftCount}</span>}
            </button>
          ))}
        </div>
      </div>

      {notSet.length > 0 && mode !== "unset" && (
        <div role="status" className="flex shrink-0 items-center gap-2.5 rounded-xs border border-amber-200 bg-amber-50/70 px-3.5 py-2 text-[13px]">
          <HugeiconsIcon icon={Alert01Icon} className="size-4 shrink-0 text-amber-700" />
          <p className="min-w-0 flex-1">
            <span className="font-medium text-foreground">
              {plural(notSet.length, "feature")} {notSet.length === 1 ? "is" : "are"} not set on any tier.
            </span>{" "}
            <span className="text-secondary-foreground">
              Ogen treats a missing value as no limit, so every tenant gets {notSet.length === 1 ? "it" : "them"} free.
            </span>
          </p>
          <button
            type="button"
            onClick={() => setMode("unset")}
            className="shrink-0 cursor-pointer font-medium text-foreground underline-offset-2 hover:underline"
          >
            Show {notSet.length === 1 ? "it" : "them"}
          </button>
        </div>
      )}

      {(unsold || actionErr || saveErr) && (
        <div role="status" className="flex shrink-0 items-center gap-3 rounded-xs border border-amber-200 bg-amber-50/70 px-3.5 py-2 text-[13px] text-amber-900">
          <span className="min-w-0 flex-1">
            {actionErr ?? saveErr ??
              (unsold &&
                `${unsold.label} is published, but ${unsold.count} of its price${unsold.count === 1 ? " is" : "s are"} not sellable yet in Lemon Squeezy.`)}
          </span>
          {unsold && !actionErr && !saveErr && (
            <Link
              href={`/billing?tab=mapping&version=${encodeURIComponent(unsold.versionId)}`}
              className="shrink-0 font-medium underline underline-offset-2"
            >
              Map to Lemon Squeezy
            </Link>
          )}
          <button
            type="button"
            onClick={() => {
              setUnsold(null);
              setActionErr(null);
              setSaveErr(null);
            }}
            aria-label="Dismiss"
            className="shrink-0 cursor-pointer text-amber-900/70 hover:text-amber-900"
          >
            ×
          </button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-xs border border-border bg-primary">
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-auto"
            onScroll={(e) => measure(e.currentTarget)}
          >
            {body}
          </div>
          {/* Bottom fader, hidden once scrolled to the end. */}
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 z-20 h-8 bg-linear-to-t from-primary to-transparent transition-opacity duration-200",
              atBottom ? "opacity-0" : "opacity-100",
            )}
          />
        </div>

        {draftColumns.map((c) => (
          <ReleaseBar
            key={c.version!.id}
            tier={c.tier}
            tiers={tiers}
            draft={c.version!}
            base={c.base}
            features={features}
            changes={changesByVersion.get(c.version!.id) ?? []}
            saving={saving.has(c.version!.id)}
            onShowUnset={() => setMode("unset")}
            onDone={(published) => {
              reload();
              if (published) checkMapping(published.id);
            }}
          />
        ))}
      </div>

      <VersionFormDrawer
        open={pricesOpen}
        onOpenChange={setPricesOpen}
        tierName={pricesFor?.tier.tierName ?? ""}
        version={pricesFor?.version ?? null}
        onSaved={() => reload()}
      />
      <RetireVersionDrawer
        open={retireOpen}
        onOpenChange={setRetireOpen}
        version={retireFor?.version ?? null}
        siblingVersions={retireFor?.tier.versions ?? []}
        tierName={retireFor?.tier.tierName ?? ""}
        onDone={() => reload()}
      />
      <VersionHistoryDrawer
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        tier={historyFor ? (tiers.find((t) => t.tierId === historyFor.tierId) ?? historyFor) : null}
        onEditPrices={(v) => {
          setHistoryOpen(false);
          if (historyFor) setPricesFor({ tier: historyFor, version: v });
          setPricesOpen(true);
        }}
        onRetire={(v) => {
          setHistoryOpen(false);
          if (historyFor) setRetireFor({ tier: historyFor, version: v });
          setRetireOpen(true);
        }}
      />
    </div>
  );
}

// TierHeader is row A of the header: one merged cell per tier with its colour
// dot, name, headline price and the ⋯ menu.
function TierHeader({
  tier,
  gridColumn,
  first,
  withDrafts,
  onStartDraft,
  onShowDraft,
  onPrices,
  onHistory,
  onRetire,
}: {
  tier: MatrixTier;
  gridColumn: string;
  first: boolean;
  withDrafts: boolean;
  onStartDraft: () => void;
  onShowDraft: () => void;
  onPrices: (v: TierVersion) => void;
  onHistory: () => void;
  onRetire: (v: TierVersion) => void;
}) {
  const live = liveVersion(tier);
  const draft = draftVersion(tier);
  const internal = isInternal(tier);
  const price = headlinePrice(live ?? draft);
  const nextVersion = Math.max(0, ...tier.versions.map((v) => v.version)) + 1;
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 pr-1 pl-3",
        first ? "" : TIER_RULE,
        internal && INTERNAL_WASH,
      )}
      style={{ gridColumn, gridRow: 1 }}
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: tier.tierColor || "var(--beige-500)" }}
      />
      <span className={cn("min-w-8 truncate text-[13px] font-semibold", internal ? "shrink-0 text-secondary-foreground" : "text-foreground")}>
        {tier.tierName}
      </span>
      {internal && (
        <span className="truncate rounded-xs border border-[#d6d1c8] bg-primary px-1 text-[11px] font-medium leading-4 text-secondary-foreground">
          Internal
        </span>
      )}
      <span className="ml-auto shrink-0 text-[13px] tabular-nums">
        {price && !internal && (
          <>
            <span className="font-semibold text-foreground">{formatMoney(price)}</span>
            <span className="text-xs text-secondary-foreground">/{price.billingInterval === "year" ? "yr" : "mo"}</span>
          </>
        )}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${tier.tierName} actions`}
            className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-xs text-secondary-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-editable/50 data-[state=open]:bg-secondary data-[state=open]:text-foreground"
          >
            <HugeiconsIcon icon={MoreHorizontalIcon} className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          {draft ? (
            <>
              {!withDrafts && (
                <DropdownMenuItem onClick={onShowDraft}>
                  <HugeiconsIcon icon={PencilEdit02Icon} className="size-4" />
                  Show v{draft.version} draft
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => onPrices(draft)}>
                <HugeiconsIcon icon={Tag01Icon} className="size-4" />
                v{draft.version} prices and sale status…
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem onClick={onStartDraft}>
              <HugeiconsIcon icon={GitBranchPlusIcon} className="size-4" />
              {live ? `Start v${nextVersion} draft from v${live.version}` : `Start v${nextVersion} draft`}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={onHistory}>
            <HugeiconsIcon icon={WorkHistoryIcon} className="size-4" />
            Version history
            <span className="ml-auto text-xs text-secondary-foreground">{tier.versions.length}</span>
          </DropdownMenuItem>
          {live && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => onRetire(live)}>
                <HugeiconsIcon icon={Archive02Icon} className="size-4" />
                Retire v{live.version}…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// VersionHeader is row B: per version, a lock (published, read-only) or a pen
// (the editable draft), the version state and its tenants or change count.
function VersionHeader({
  column,
  changes,
  className,
  style,
}: {
  column: Column;
  changes: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const v = column.version;
  const draft = column.kind === "draft";
  return (
    <div className={cn("flex min-w-0 items-center gap-1.5 px-3 text-xs whitespace-nowrap", className)} style={style}>
      <HugeiconsIcon
        icon={draft ? PencilEdit02Icon : SquareLock01Icon}
        aria-label={draft ? "Editable draft" : "Published, read-only"}
        className={cn("size-3.5 shrink-0", draft ? "text-editable" : "text-secondary-foreground")}
      />
      {!v ? (
        <span className="text-secondary-foreground">no live version</span>
      ) : (
        <>
          <span className="text-secondary-foreground">v{v.version}</span>
          <span
            className={cn(
              "font-medium",
              draft ? "text-editable" : column.kind === "internal" ? "text-secondary-foreground" : "text-emerald-700",
            )}
          >
            {draft ? "draft" : column.kind === "internal" ? "not sold" : "live"}
          </span>
          <span className={cn("ml-auto truncate tabular-nums", draft ? "text-editable" : "text-secondary-foreground")}>
            {draft ? plural(changes, "change") : plural(v.liveAssignmentCount, "tenant")}
          </span>
        </>
      )}
    </div>
  );
}

// MatrixCell is one value. Draft cells are buttons that open the anchored
// editor; published cells are read-only and, when the tier has no draft yet,
// offer to start one.
function MatrixCell({
  feature,
  column,
  tiers,
  className,
  focused,
  editing,
  offering,
  onOpen,
  onClose,
  onChange,
  onStartDraft,
}: {
  feature: Feature;
  column: Column;
  tiers: MatrixTier[];
  className: string;
  focused: boolean;
  editing: boolean;
  offering: boolean;
  onOpen: () => void;
  onClose: () => void;
  onChange: (v: EntitlementValue | undefined) => void;
  onStartDraft: () => void;
}) {
  const v = column.version;
  const value = rawValue(v, feature);
  const draft = column.kind === "draft";

  if (!v) {
    return <div className={cn("px-4 py-2.5", className)} />;
  }

  const content = (
    <span className="flex w-full items-center justify-end gap-1.5 tabular-nums">
      {draft && !sameAsBase(column, feature) && (
        <span aria-label="Changed" className="mr-auto size-1.5 rounded-full bg-editable" />
      )}
      {draft && inversionFor(tiers, column.tier.tierId, feature, value) && (
        <HugeiconsIcon
          icon={Alert01Icon}
          aria-label="Out of line with another tier"
          className={cn("size-3.5 text-amber-700", sameAsBase(column, feature) && "mr-auto")}
        />
      )}
      <span className={cn(draft && !sameAsBase(column, feature) && "[&>span]:font-semibold")}>
        <CellValue feature={feature} value={value} tone={draft ? "draft" : column.kind === "internal" ? "internal" : "live"} />
      </span>
    </span>
  );

  if (draft) {
    const base = column.base;
    return (
      <Popover open={editing} onOpenChange={(o) => (o ? onOpen() : onClose())}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`${feature.name}, ${column.tier.tierName} v${v.version}: ${describe(feature, value).text}. Edit`}
            className={cn(
              "flex cursor-pointer items-center px-4 py-2.5 outline-none hover:inset-ring-1 hover:inset-ring-editable focus-visible:inset-ring-1 focus-visible:inset-ring-editable",
              (focused || editing) && "inset-ring-1 inset-ring-editable",
              className,
            )}
          >
            {content}
          </button>
        </PopoverTrigger>
        <PopoverContent side="right" align="start" className="w-80 rounded-xs p-4">
          <CellEditor
            feature={feature}
            tierName={column.tier.tierName}
            versionLabel={`v${v.version}`}
            value={value}
            baseValue={rawValue(base, feature)}
            baseLabel={base ? `v${base.version}` : null}
            neighbours={neighbours(tiers, column.tier.tierId, feature)}
            inversion={inversionFor(tiers, column.tier.tierId, feature, value)}
            onChange={onChange}
            onClose={onClose}
          />
        </PopoverContent>
      </Popover>
    );
  }

  const locked = (
    <div
      className={cn(
        "flex items-center px-4 py-2.5",
        focused && "inset-ring-1 inset-ring-foreground/30",
        className,
      )}
    >
      {content}
    </div>
  );
  if (!offering) return locked;
  return (
    <Popover open onOpenChange={(o) => !o && onClose()}>
      <PopoverTrigger asChild>{locked}</PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-64 rounded-xs p-3">
        <p className="text-xs text-secondary-foreground">
          v{v.version} is published and can’t change.
        </p>
        <button
          type="button"
          autoFocus
          onClick={onStartDraft}
          className="mt-2 flex w-full cursor-pointer items-center gap-2 rounded-xs bg-foreground px-3 py-1.5 text-[13px] font-medium text-primary hover:bg-foreground/90"
        >
          <HugeiconsIcon icon={GitBranchPlusIcon} className="size-4" />
          Start v{Math.max(...column.tier.versions.map((x) => x.version)) + 1} draft from v{v.version}
        </button>
      </PopoverContent>
    </Popover>
  );
}

function sameAsBase(column: Column, f: Feature): boolean {
  return rawValue(column.version, f) === rawValue(column.base, f);
}
