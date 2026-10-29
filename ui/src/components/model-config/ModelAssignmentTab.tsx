"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert01Icon,
  ArrowRight01Icon,
  CpuSettingsIcon,
  SquareLock02Icon,
} from "@hugeicons/core-free-icons";
import { Loader } from "@/components/ui/loader";
import { useRowKeyboardNav } from "@/lib/useRowKeyboardNav";
import { cn } from "@/lib/utils";
import {
  CapabilityBadge,
  friendlyModel,
  humanize,
  isSystemFlow,
  PriceHead,
  priceIn,
  priceOut,
  relativeShort,
} from "./format";
import { SlotModelDrawer } from "./SlotModelDrawer";
import type {
  Flow,
  FlowSlot,
  Model,
  ModelConfigResponse,
  SlotAssignment,
  Tier,
} from "./types";

// Column template shared by the header and every row so they stay aligned:
// Flow / slot · Default model · Tier overrides · In · Out · Changed · open
// affordance.
const GRID =
  "grid grid-cols-[minmax(11rem,1.25fr)_minmax(10rem,1.1fr)_minmax(13rem,1.7fr)_5.5rem_5.5rem_4.5rem_1rem] items-center gap-x-4 px-6";

export interface ModelConfigSummary {
  flows: number;
  system: number;
  slots: number;
  overrides: number;
}

interface SlotTarget {
  flow: Flow;
  slot: FlowSlot;
  system: boolean;
}

// One rendered line of the ledger. Only "slot" lines are rows an operator can
// open (and reach with j/k); "group" heads a multi-slot flow and "section"
// opens the System part of the table.
type Line =
  | { kind: "slot"; target: SlotTarget; nested: boolean; last: boolean; nav: number }
  | { kind: "group"; flow: Flow; system: boolean }
  | { kind: "section" };

function buildLines(flows: Flow[]): { lines: Line[]; targets: SlotTarget[] } {
  const lines: Line[] = [];
  const targets: SlotTarget[] = [];
  const push = (list: Flow[], system: boolean) => {
    for (const flow of list) {
      const nested = flow.slots.length > 1;
      if (nested) lines.push({ kind: "group", flow, system });
      flow.slots.forEach((slot, i) => {
        const target = { flow, slot, system };
        lines.push({
          kind: "slot",
          target,
          nested,
          last: i === flow.slots.length - 1,
          nav: targets.length,
        });
        targets.push(target);
      });
    }
  };
  const system = flows.filter(isSystemFlow);
  push(
    flows.filter((f) => !isSystemFlow(f)),
    false,
  );
  if (system.length > 0) {
    lines.push({ kind: "section" });
    push(system, true);
  }
  return { lines, targets };
}

// ModelAssignmentTab is the operator ledger: one row per slot (multi-slot
// flows get a group header), showing the global-default model, which tiers
// override it, In / Out pricing and the last change. System flows (run for
// Harbor itself) close the table as their own section. All editing happens in
// the drawer opened per slot.
export function ModelAssignmentTab({
  onSummary,
}: {
  onSummary?: (s: ModelConfigSummary) => void;
}) {
  const [data, setData] = useState<ModelConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [target, setTarget] = useState<SlotTarget | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const reload = useCallback((signal?: AbortSignal) => {
    return fetch("/api/model-config", { signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        return r.json() as Promise<ModelConfigResponse>;
      })
      .then((d) => {
        setData(d);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if ((err as { name?: string })?.name === "AbortError") return;
        setLoadError(
          err instanceof Error ? err.message : "Failed to load model config.",
        );
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    reload(ctrl.signal);
    return () => ctrl.abort();
  }, [reload]);

  const modelsById = useMemo(
    () => new Map<string, Model>((data?.models ?? []).map((m) => [m.id, m])),
    [data?.models],
  );
  const tiersById = useMemo(
    () => new Map<string, Tier>((data?.tiers ?? []).map((t) => [t.id, t])),
    [data?.tiers],
  );
  const { lines, targets } = useMemo(
    () => buildLines(data?.flows ?? []),
    [data?.flows],
  );
  const assignments = useMemo(() => data?.assignments ?? [], [data?.assignments]);

  useEffect(() => {
    if (!data || !onSummary) return;
    const flowKeys = new Set(data.flows.map((f) => f.key));
    const system = data.flows.filter(isSystemFlow).length;
    onSummary({
      flows: data.flows.length - system,
      system,
      slots: targets.length,
      overrides: data.assignments.filter(
        (a) => a.tierId !== "" && flowKeys.has(a.flowKey),
      ).length,
    });
  }, [data, targets.length, onSummary]);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3000);
  }, []);

  const { activeIndex, setActiveIndex, containerRef } = useRowKeyboardNav({
    count: targets.length,
    onOpen: (i) => {
      const t = targets[i];
      if (t) setTarget(t);
    },
  });

  // Sticky-header edge fades, mirroring the /activity and tier-entitlements
  // tables: the top/bottom gradient strips hide once the scroll region is at
  // that edge. Recomputed whenever the rendered data changes.
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const measure = useCallback((el: HTMLDivElement) => {
    setAtTop(el.scrollTop <= 0);
    setAtBottom(Math.ceil(el.scrollHeight - (el.scrollTop + el.clientHeight)) <= 0);
  }, []);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    measure(el);
    const ro = new ResizeObserver(() => measure(el));
    ro.observe(el);
    return () => ro.disconnect();
  }, [data, measure, containerRef]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center rounded-xl border border-border bg-primary py-20">
        <Loader className="size-5 border-2" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="rounded-xl border border-border bg-primary p-6">
        <p className="text-sm text-destructive" role="alert">
          {loadError}
        </p>
      </div>
    );
  }

  if (data && !data.available) {
    return (
      <div className="rounded-xl border border-border bg-primary p-6">
        <h2 className="text-sm font-medium">Model configuration unavailable</h2>
        <p className="mt-1 text-sm text-secondary-foreground">
          The model-config service isn’t reachable. Model assignments and pricing
          can’t be shown right now.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="relative flex h-full flex-col overflow-hidden rounded-xl border border-border bg-primary">
        <div className="relative min-h-0 flex-1">
          <div
            ref={containerRef}
            onScroll={(e) => measure(e.currentTarget)}
            className="h-full overflow-auto"
          >
            {/* Column header (sticky) */}
            <div
              className={cn(
                GRID,
                "sticky top-0 z-20 h-10 border-b border-border bg-primary text-[11px] font-medium tracking-wide text-secondary-foreground uppercase",
              )}
            >
              <div>Flow</div>
              <div>Default model</div>
              <div>Tier overrides</div>
              <PriceHead kind="input" />
              <PriceHead kind="output" />
              <div>Changed</div>
              <div />
            </div>

            <div onMouseLeave={() => setActiveIndex(-1)}>
              {lines.map((line, i) => {
                if (line.kind === "section") {
                  return (
                    <div
                      key="section"
                      className="-mt-px flex h-10 items-center gap-2.5 border-y border-t-senary border-b-border px-6 text-[13px]"
                    >
                      <HugeiconsIcon
                        icon={CpuSettingsIcon}
                        className="size-4 shrink-0 text-foreground"
                      />
                      <span className="font-semibold">System</span>
                      <span className="text-xs text-secondary-foreground">
                        runs for Harbor itself · not tenant usage · no tier
                        overrides
                      </span>
                    </div>
                  );
                }
                if (line.kind === "group") {
                  return (
                    <div
                      key={`group/${line.flow.key}`}
                      className="flex h-[34px] items-center gap-2 px-6 pt-1 text-[13px]"
                      title={line.flow.description}
                    >
                      {line.system && (
                        <HugeiconsIcon
                          icon={CpuSettingsIcon}
                          className="size-4 shrink-0 text-secondary-foreground"
                        />
                      )}
                      <span className="font-medium">
                        {humanize(line.flow.key)}
                      </span>
                      <span className="text-xs text-secondary-foreground">
                        {line.flow.slots.length} slots
                      </span>
                    </div>
                  );
                }
                return (
                  <SlotRow
                    key={`${line.target.flow.key}/${line.target.slot.key}/${i}`}
                    line={line}
                    assignments={assignments}
                    modelsById={modelsById}
                    tiersById={tiersById}
                    active={activeIndex === line.nav}
                    onHover={() => setActiveIndex(line.nav)}
                    onOpen={() => {
                      setActiveIndex(line.nav);
                      setTarget(line.target);
                    }}
                  />
                );
              })}
            </div>
          </div>

          {/* Top fade — sits just below the 40px sticky header. */}
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-x-0 top-10 z-10 h-8 bg-linear-to-b from-primary to-transparent transition-opacity duration-200",
              atTop ? "opacity-0" : "opacity-100",
            )}
          />
          {/* Bottom fade — the same fade, flipped. */}
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-linear-to-t from-primary to-transparent transition-opacity duration-200",
              atBottom ? "opacity-0" : "opacity-100",
            )}
          />
        </div>
      </div>

      {toast && (
        <div className="fixed right-6 bottom-6 z-[300] rounded-md border border-border bg-foreground px-4 py-2 text-sm text-primary shadow-lg">
          {toast}
        </div>
      )}

      {target && data && (
        <SlotModelDrawer
          open={!!target}
          onOpenChange={(o) => !o && setTarget(null)}
          flow={target.flow}
          slot={target.slot}
          system={target.system}
          models={data.models}
          tiers={data.tiers}
          assignments={assignments}
          onChanged={(msg) => {
            flash(msg);
            void reload();
          }}
        />
      )}
    </>
  );
}

function SlotRow({
  line,
  assignments,
  modelsById,
  tiersById,
  active,
  onHover,
  onOpen,
}: {
  line: Extract<Line, { kind: "slot" }>;
  assignments: SlotAssignment[];
  modelsById: Map<string, Model>;
  tiersById: Map<string, Tier>;
  active: boolean;
  onHover: () => void;
  onOpen: () => void;
}) {
  const { flow, slot, system } = line.target;
  const all = assignments.filter(
    (a) => a.flowKey === flow.key && a.slotKey === slot.key,
  );
  const def = all.find((a) => a.tierId === "");
  const overrides = all.filter((a) => a.tierId !== "");
  const defModel = def ? modelsById.get(def.modelId) : undefined;
  const defRetired = !!def && !defModel;

  // The slot's last change is the most recent across its global default and
  // any tier overrides.
  const lastUpdated = all.reduce<string>((latest, a) => {
    if (!a.updatedAt) return latest;
    return !latest || new Date(a.updatedAt) > new Date(latest)
      ? a.updatedAt
      : latest;
  }, "");

  const name = line.nested ? humanize(slot.key) : humanize(flow.key);

  return (
    <button
      type="button"
      data-row-index={line.nav}
      onClick={onOpen}
      onMouseEnter={onHover}
      title={line.nested ? slot.description : flow.description}
      className={cn(
        GRID,
        "relative w-full cursor-pointer text-left text-[13px] transition-colors duration-100 outline-none",
        line.nested ? "h-[38px]" : "h-11",
        (!line.nested || line.last) && "border-b border-border",
        active && "bg-table-row-hover",
      )}
    >
      {/* Tree line joining a sub-row to its group header (out of grid flow). */}
      {line.nested && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute top-0 left-[30px] w-2.5 border-l border-quinary",
            line.last ? "h-1/2" : "h-full",
            "after:absolute after:top-full after:left-0 after:h-px after:w-2.5 after:bg-quinary",
            !line.last && "after:top-1/2",
          )}
        />
      )}

      {/* Flow / slot */}
      <div className={cn("flex min-w-0 items-center gap-2", line.nested && "pl-5")}>
        {system && !line.nested && (
          <HugeiconsIcon
            icon={CpuSettingsIcon}
            className="size-4 shrink-0 text-secondary-foreground"
          />
        )}
        <span className={cn("truncate", !line.nested && "font-medium")}>
          {name}
        </span>
        {slot.globalOnly && !system && (
          <HugeiconsIcon
            icon={SquareLock02Icon}
            className="size-4 shrink-0 text-secondary-foreground"
            aria-label="Global only"
          />
        )}
      </div>

      {/* Default model (+ capability when it isn't chat) */}
      <div className="flex min-w-0 items-center gap-2">
        {!def ? (
          <span className="text-secondary-foreground">Not set</span>
        ) : defRetired ? (
          <span
            className="flex min-w-0 items-center gap-1.5 text-amber-700"
            title={`${def.modelId} is no longer in the catalog`}
          >
            <HugeiconsIcon icon={Alert01Icon} className="size-3.5 shrink-0" />
            <span className="truncate">{friendlyModel(def.modelId)}</span>
            <span className="shrink-0 text-xs font-medium">retired</span>
          </span>
        ) : (
          <span className="truncate" title={def.modelId}>
            {friendlyModel(def.modelId)}
          </span>
        )}
        {slot.capability !== "chat" && (
          <span className="shrink-0">
            <CapabilityBadge capability={slot.capability} />
          </span>
        )}
      </div>

      {/* Tier overrides */}
      <div className="min-w-0">
        <OverridesCell
          overrides={overrides}
          globalOnly={slot.globalOnly}
          system={system}
          modelsById={modelsById}
          tiersById={tiersById}
        />
      </div>

      {/* Pricing (USD per 1M tokens) */}
      <div className="text-right tabular-nums">{priceIn(defModel)}</div>
      <div
        className={cn(
          "text-right tabular-nums",
          priceOut(defModel) === "—" && "text-secondary-foreground",
        )}
      >
        {priceOut(defModel)}
      </div>

      {/* Changed */}
      <div
        className="text-xs text-secondary-foreground tabular-nums"
        title={lastUpdated ? new Date(lastUpdated).toLocaleString() : undefined}
      >
        {lastUpdated ? relativeShort(lastUpdated) : "—"}
      </div>

      {/* Open affordance */}
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        className={cn(
          "size-4 text-secondary-foreground transition-opacity duration-100",
          active ? "opacity-100" : "opacity-0",
        )}
      />
    </button>
  );
}

function OverridesCell({
  overrides,
  globalOnly,
  system,
  modelsById,
  tiersById,
}: {
  overrides: SlotAssignment[];
  globalOnly: boolean;
  system: boolean;
  modelsById: Map<string, Model>;
  tiersById: Map<string, Tier>;
}) {
  if (system) {
    return <span className="text-secondary-foreground">Not tier-based</span>;
  }
  if (globalOnly) {
    return <span className="text-secondary-foreground">Global only</span>;
  }
  if (overrides.length === 0) {
    return <span className="text-tertiary-foreground">—</span>;
  }
  const tierName = (id: string) => tiersById.get(id)?.name ?? id;
  const tierColor = (id: string) => tiersById.get(id)?.color ?? "currentColor";

  if (overrides.length === 1) {
    const o = overrides[0];
    const retired = !modelsById.has(o.modelId);
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: tierColor(o.tierId) }}
        />
        <span className="shrink-0 text-secondary-foreground">
          {tierName(o.tierId)}
        </span>
        <span className="shrink-0 text-tertiary-foreground">→</span>
        <span
          className={cn(
            "truncate font-medium",
            retired ? "text-amber-700" : "text-editable",
          )}
          title={o.modelId}
        >
          {friendlyModel(o.modelId)}
        </span>
      </span>
    );
  }

  const anyRetired = overrides.some((o) => !modelsById.has(o.modelId));
  return (
    <span
      className="flex min-w-0 items-center gap-2"
      title={overrides
        .map((o) => `${tierName(o.tierId)} → ${friendlyModel(o.modelId)}`)
        .join("\n")}
    >
      <span className="flex shrink-0 items-center">
        {overrides.map((o, i) => (
          <span
            key={o.tierId}
            className={cn(
              "size-2.5 rounded-full ring-[1.5px] ring-primary",
              i > 0 && "-ml-1",
            )}
            style={{ backgroundColor: tierColor(o.tierId) }}
          />
        ))}
      </span>
      <span
        className={cn(
          "shrink-0 font-medium",
          anyRetired ? "text-amber-700" : "text-editable",
        )}
      >
        {overrides.length} tiers
      </span>
      <span className="truncate text-secondary-foreground">
        {overrides.map((o) => tierName(o.tierId)).join(", ")}
      </span>
    </span>
  );
}
