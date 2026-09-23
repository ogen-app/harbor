"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  CheckmarkSquare02Icon,
  MinusSignSquareIcon,
  Alert01Icon,
  AiGenerateIcon,
  ArrowMoveDownRightIcon,
} from "@hugeicons/core-free-icons";
import { Loader } from "@/components/ui/loader";
import { cn } from "@/lib/utils";
import { CapabilityBadge, friendlyModel, headlinePrice, humanize } from "./format";
import { SlotModelDrawer } from "./SlotModelDrawer";
import type {
  Flow,
  FlowSlot,
  Model,
  ModelConfigResponse,
  SlotAssignment,
} from "./types";

// Column template shared by the header and every slot row so they stay aligned:
// Slot · Description · Model · Pricing · Capability · Global-only · (edit).
const GRID =
  "grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)_minmax(0,1.6fr)_minmax(0,1.1fr)_5.5rem_6rem_2.5rem] items-center gap-3";

interface DrawerTarget {
  flow: Flow;
  slot: FlowSlot;
}

// ModelAssignmentTab is the operator table: flow band rows with slot sub-rows,
// each showing the global-default model, whether tiers diverge, the slot's
// capability, the global-only flag, and headline pricing. All editing (per-tier
// overrides, model pick, verify) happens in the drawer opened per slot.
export function ModelAssignmentTab() {
  const [data, setData] = useState<ModelConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [target, setTarget] = useState<DrawerTarget | null>(null);
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

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3000);
  }, []);

  // Sticky-header edge fades, mirroring the /activity and tier-entitlements
  // tables: the top/bottom gradient strips hide once the scroll region is at
  // that edge. Recomputed whenever the rendered data changes.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const onScroll = (el: HTMLDivElement) => {
    setAtTop(el.scrollTop <= 0);
    setAtBottom(Math.ceil(el.scrollHeight - (el.scrollTop + el.clientHeight)) <= 0);
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAtTop(el.scrollTop <= 0);
    setAtBottom(Math.ceil(el.scrollHeight - (el.scrollTop + el.clientHeight)) <= 0);
  }, [data]);

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-border bg-primary py-20">
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
        <p className="mt-1 text-sm text-tertiary-foreground">
          The model-config service isn’t reachable. Model assignments and pricing
          can’t be shown right now.
        </p>
      </div>
    );
  }

  const flows = data?.flows ?? [];
  const assignments = data?.assignments ?? [];

  return (
    <>
      <div className="relative flex h-full flex-col overflow-hidden rounded-xl border border-border bg-primary">
        {/* Card intro (fixed) */}
        <div className="border-b border-border px-6 py-4">
          <p className="text-sm text-tertiary-foreground">
            Each generation flow declares one or more model slots. The table shows
            the <span className="font-medium text-foreground">global default</span>{" "}
            for every slot; open a slot to set per-tier overrides, compare pricing,
            and verify a model.
          </p>
        </div>

        {/* Scroll region — sticky column header + top/bottom edge fades. */}
        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            onScroll={(e) => onScroll(e.currentTarget)}
            className="h-full overflow-auto"
          >
            {/* Column header (sticky) */}
            <div
              className={cn(
                GRID,
                "sticky top-0 z-20 h-10 border-b border-border bg-primary pr-6 pl-[55px] text-[11px] font-medium uppercase tracking-wide text-tertiary-foreground",
              )}
            >
              <div>Slot</div>
              <div>Description</div>
              <div>Model</div>
              <div>Pricing / 1M</div>
              <div>Capability</div>
              <div className="text-center">Global-only</div>
              <div />
            </div>

            {/* Flow groups */}
            <div>
              {flows.map((flow, i) => (
                <div
                  key={flow.key}
                  className={cn(i > 0 && "border-t border-border py-4")}
                >
                  <FlowBand flow={flow} />
                  {flow.slots.map((slot) => (
                    <SlotRow
                      key={`${flow.key}/${slot.key}`}
                      flow={flow}
                      slot={slot}
                      assignments={assignments}
                      modelsById={modelsById}
                      onEdit={() => setTarget({ flow, slot })}
                    />
                  ))}
                </div>
              ))}
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
        <div className="fixed bottom-6 right-6 z-[300] rounded-md border border-border bg-foreground px-4 py-2 text-sm text-primary shadow-lg">
          {toast}
        </div>
      )}

      {target && data && (
        <SlotModelDrawer
          open={!!target}
          onOpenChange={(o) => !o && setTarget(null)}
          flow={target.flow}
          slot={target.slot}
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

function FlowBand({ flow }: { flow: Flow }) {
  return (
    <div className="flex items-center gap-2 bg-secondary/40 px-6 py-2">
      <HugeiconsIcon
        icon={AiGenerateIcon}
        className="size-6 shrink-0 text-secondary-foreground"
      />
      <span className="font-display text-sm font-medium">
        {humanize(flow.key)}
      </span>
      <span className="truncate text-xs text-tertiary-foreground">
        {flow.description}
      </span>
    </div>
  );
}

function SlotRow({
  flow,
  slot,
  assignments,
  modelsById,
  onEdit,
}: {
  flow: Flow;
  slot: FlowSlot;
  assignments: SlotAssignment[];
  modelsById: Map<string, Model>;
  onEdit: () => void;
}) {
  const all = assignments.filter(
    (a) => a.flowKey === flow.key && a.slotKey === slot.key,
  );
  const def = all.find((a) => a.tierId === "");
  const overrides = all.filter((a) => a.tierId !== "");
  const defModel = def ? modelsById.get(def.modelId) : undefined;
  const defDrift = !!def && !modelsById.has(def.modelId);
  const overrideDrift = overrides.some((a) => !modelsById.has(a.modelId));

  return (
    <button
      type="button"
      onClick={onEdit}
      className={cn(
        GRID,
        "group w-full py-1 pr-6 pl-[55px] text-left transition-colors last:border-b-0 cursor-pointer",
      )}
    >
      {/* Slot */}
      <div className="flex min-w-0 items-center gap-1.5">
        <HugeiconsIcon
          icon={ArrowMoveDownRightIcon}
          className="size-5.25 shrink-0 text-tertiary-foreground group-hover:text-blue-600"
        />
        <span className="truncate pl-[6px] text-sm text-foreground group-hover:text-blue-600">
          {slot.key}
        </span>
      </div>

      {/* Description */}
      <div className="min-w-0 truncate text-xs text-tertiary-foreground group-hover:text-blue-600">
        {slot.description}
      </div>

      {/* Default model + variance / drift */}
      <div className="min-w-0">
        {def ? (
          <div
            className={cn(
              "truncate text-sm",
              defDrift
                ? "text-amber-700"
                : "text-foreground group-hover:text-blue-600",
            )}
            title={def.modelId}
          >
            {defDrift && (
              <HugeiconsIcon
                icon={Alert01Icon}
                className="mr-1 inline size-3.5 align-[-2px]"
              />
            )}
            {friendlyModel(def.modelId)}
          </div>
        ) : (
          <div className="text-sm text-tertiary-foreground">— not set</div>
        )}
        <div className="mt-0.5 flex items-center gap-1.5">
          {overrides.length > 0 && (
            <span
              className={cn(
                "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                overrideDrift
                  ? "bg-amber-500/10 text-amber-700"
                  : "bg-secondary text-secondary-foreground",
              )}
            >
              {overrides.length} tier override
              {overrides.length === 1 ? "" : "s"}
            </span>
          )}
          {defDrift && (
            <span className="text-[10px] font-medium text-amber-700">
              retired — re-pick
            </span>
          )}
        </div>
      </div>

      {/* Pricing */}
      <div className="truncate text-sm tabular-nums text-secondary-foreground group-hover:text-blue-600">
        {defModel ? headlinePrice(defModel) : "—"}
      </div>

      {/* Capability */}
      <div>
        <CapabilityBadge capability={slot.capability} />
      </div>

      {/* Global-only */}
      <div className="flex justify-center">
        <HugeiconsIcon
          icon={slot.globalOnly ? CheckmarkSquare02Icon : MinusSignSquareIcon}
          className={cn(
            "size-5",
            slot.globalOnly ? "text-emerald-600" : "text-gray-300",
          )}
          aria-label={slot.globalOnly ? "Global-only" : "Not global-only"}
        />
      </div>

      {/* Edit affordance */}
      <div className="flex justify-end" />
    </button>
  );
}
