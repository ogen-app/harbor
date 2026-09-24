"use client";

import { useEffect, useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AiChemistry02Icon,
  AiCloudIcon,
  CircleCheckBigIcon,
} from "@hugeicons/core-free-icons";
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  CapabilityBadge,
  friendlyModel,
  HeadlinePrice,
  humanize,
  ModelCapabilityBadges,
  PRICE_KINDS,
  usd,
} from "./format";
import type {
  Flow,
  FlowSlot,
  Model,
  SlotAssignment,
  TestResult,
  Tier,
} from "./types";

// Sentinel used for a tier tab whose selection is "inherit the global default"
// (i.e. no override). Distinct from an empty selection.
const INHERIT = "__inherit__";

interface Scope {
  key: string; // "" = global default, otherwise tier id
  label: string;
  tier?: Tier;
}

interface TestState {
  loading: boolean;
  result?: TestResult;
  error?: string;
}

interface SlotModelDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  flow: Flow;
  slot: FlowSlot;
  models: Model[];
  tiers: Tier[];
  assignments: SlotAssignment[];
  onChanged: (message: string) => void;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const detail = (await res.json().catch(() => null)) as {
    error?: string;
  } | null;
  return detail?.error || fallback;
}

// SlotModelDrawer edits the model assignment for one (flow, slot). It presents a
// "Global (default)" tab plus one tab per tier (unless the slot is global-only);
// each tab is a capability-filtered model picker with pricing, capability badges
// and a per-model Verify (golden probe). The footer saves the active scope, or
// applies the pick to every tier at once.
export function SlotModelDrawer(props: SlotModelDrawerProps) {
  return (
    <Drawer open={props.open} onOpenChange={props.onOpenChange}>
      <DrawerContent className="max-w-[min(44rem,calc(100vw-2.5rem))] gap-0 p-0">
        <SlotModelForm {...props} />
      </DrawerContent>
    </Drawer>
  );
}

function SlotModelForm({
  onOpenChange,
  flow,
  slot,
  models,
  tiers,
  assignments,
  onChanged,
}: SlotModelDrawerProps) {
  const scopes = useMemo<Scope[]>(() => {
    const s: Scope[] = [{ key: "", label: "Global (default)" }];
    if (!slot.globalOnly) {
      for (const t of tiers) s.push({ key: t.id, label: t.name, tier: t });
    }
    return s;
  }, [slot.globalOnly, tiers]);

  // Selection per scope: a model id, or INHERIT for a tier tab with no override.
  // Seeded once from the current assignments (the drawer is remounted per open).
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const d: Record<string, string> = {};
    const here = (tierId: string) =>
      assignments.find(
        (a) =>
          a.flowKey === flow.key &&
          a.slotKey === slot.key &&
          a.tierId === tierId,
      );
    d[""] = here("")?.modelId ?? "";
    for (const t of tiers) {
      const ov = here(t.id);
      d[t.id] = ov ? ov.modelId : INHERIT;
    }
    return d;
  });

  const [active, setActive] = useState(0);
  const [testByModel, setTestByModel] = useState<Record<string, TestState>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Number keys 1..N switch scope tabs (matches the announcements/secrets
  // drawers). Ignored while a control has focus so it never eats a keystroke.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ||
          el.closest?.('[role="combobox"],[role="textbox"]'))
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= scopes.length) {
        e.preventDefault();
        setActive(n - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scopes.length]);

  const scope = scopes[active] ?? scopes[0];
  const isTier = scope.key !== "";
  const current = draft[scope.key] ?? (isTier ? INHERIT : "");
  const globalModelId = draft[""];

  const slotModels = useMemo(
    () => models.filter((m) => m.capability === slot.capability),
    [models, slot.capability],
  );

  // Group the picker by vendor (Anthropic, then Google), each under a logo'd
  // header. Unknown vendors sort last.
  const groupedModels = useMemo(() => {
    const order = ["anthropic", "gemini"];
    const map = new Map<string, Model[]>();
    for (const m of slotModels) {
      const arr = map.get(m.vendor);
      if (arr) arr.push(m);
      else map.set(m.vendor, [m]);
    }
    return [...map.entries()]
      .sort(([a], [b]) => {
        const ia = order.indexOf(a);
        const ib = order.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      })
      .map(([vendor, list]) => ({ vendor, models: list }));
  }, [slotModels]);

  const select = (modelId: string) =>
    setDraft((d) => ({ ...d, [scope.key]: modelId }));

  const runTest = async (modelId: string) => {
    setTestByModel((t) => ({ ...t, [modelId]: { loading: true } }));
    try {
      const res = await fetch("/api/model-config/test", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          flowKey: flow.key,
          slotKey: slot.key,
          modelId,
        }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, `Failed (${res.status})`));
      const result = (await res.json()) as TestResult;
      setTestByModel((t) => ({ ...t, [modelId]: { loading: false, result } }));
    } catch (err) {
      setTestByModel((t) => ({
        ...t,
        [modelId]: {
          loading: false,
          error: err instanceof Error ? err.message : "Test failed",
        },
      }));
    }
  };

  const scopeLabel = scope.tier ? ` · ${scope.tier.name}` : "";

  const save = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const sel = draft[scope.key];
      let res: Response;
      if (isTier && sel === INHERIT) {
        res = await fetch("/api/model-config/slot/clear", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            tierId: scope.key,
            flowKey: flow.key,
            slotKey: slot.key,
          }),
        });
      } else {
        if (!sel || sel === INHERIT) {
          setError("Pick a model.");
          setSubmitting(false);
          return;
        }
        res = await fetch("/api/model-config/slot", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            tierId: scope.key,
            flowKey: flow.key,
            slotKey: slot.key,
            modelId: sel,
          }),
        });
      }
      if (!res.ok) throw new Error(await errorMessage(res, `Request failed (${res.status})`));
      onChanged(`Updated ${humanize(flow.key)} · ${slot.key}${scopeLabel}`);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
      setSubmitting(false);
    }
  };

  const saveAllTiers = async () => {
    const sel = draft[scope.key];
    if (!sel || sel === INHERIT) {
      setError("Pick a model to apply to all tiers.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/model-config/slot/global-all", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          flowKey: flow.key,
          slotKey: slot.key,
          modelId: sel,
        }),
      });
      if (!res.ok) throw new Error(await errorMessage(res, `Request failed (${res.status})`));
      onChanged(
        `${friendlyModel(sel)} set for all tiers · ${humanize(flow.key)} · ${slot.key}`,
      );
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
      setSubmitting(false);
    }
  };

  const canSaveAll = !slot.globalOnly && !!current && current !== INHERIT;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header (fixed) — pr-12 clears the drawer's close button. */}
      <div className="shrink-0 px-6 pt-6 pr-12">
        <div className="flex items-center gap-2">
          <HugeiconsIcon
            icon={AiCloudIcon}
            className="size-5 text-tertiary-foreground"
          />
          <DrawerTitle className="font-display text-lg font-medium">
            {humanize(flow.key)}{" "}
            <span className="text-tertiary-foreground">/</span>{" "}
            <span className="text-base">{slot.key}</span>
          </DrawerTitle>
          <CapabilityBadge capability={slot.capability} />
        </div>
        <DrawerDescription className="mt-1">
          {slot.description}
          {slot.globalOnly &&
            " This slot is global-only — it can't be overridden per tier."}
        </DrawerDescription>
      </div>

      <div className="mt-4 shrink-0 border-b border-border" />

      {/* Scope tabs (fixed) */}
      {scopes.length > 1 && (
        <div className="shrink-0 px-6 pt-4">
          <div
            role="tablist"
            className="flex gap-6 overflow-x-auto border-b border-border"
          >
            {scopes.map((s, i) => (
              <button
                key={s.key || "__global__"}
                type="button"
                role="tab"
                aria-selected={i === active}
                onClick={() => setActive(i)}
                className={cn(
                  "relative -mb-px flex items-center gap-1.5 border-b-2 py-2.5 text-sm whitespace-nowrap transition-colors outline-none",
                  i === active
                    ? "border-foreground font-semibold text-foreground"
                    : "border-transparent font-medium text-tertiary-foreground hover:text-secondary-foreground",
                )}
              >
                {s.tier && (
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: s.tier.color }}
                  />
                )}
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Scroll body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {/* Per-tier effective-config note */}
        {isTier && (
          <p className="mb-3 text-xs text-tertiary-foreground">
            {current === INHERIT ? (
              <>
                <span className="font-medium text-foreground">
                  {scope.label}
                </span>{" "}
                inherits the global default
                {globalModelId ? (
                  <>
                    {" "}
                    (
                    <span className="text-foreground">
                      {friendlyModel(globalModelId)}
                    </span>
                    )
                  </>
                ) : null}
                . Pick a model below to override it for this tier.
              </>
            ) : (
              <>
                <span className="font-medium text-foreground">
                  {scope.label}
                </span>{" "}
                overrides the global default for this slot.
              </>
            )}
          </p>
        )}

        <div role="radiogroup" className="flex flex-col gap-2">
          {/* Inherit option (tier tabs only) */}
          {isTier && (
            <button
              type="button"
              role="radio"
              aria-checked={current === INHERIT}
              onClick={() => select(INHERIT)}
              className={cn(
                "flex items-center gap-3 rounded-lg border p-4 text-left transition-colors",
                current === INHERIT
                  ? "border-2 border-[#1c7ef6]"
                  : "border-border hover:bg-secondary/30",
              )}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-xs font-semibold text-secondary-foreground">
                ↩
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  Use global default (inherit)
                </div>
                <div className="text-xs">
                  {globalModelId
                    ? `Currently ${friendlyModel(globalModelId)}`
                    : "No global default set"}
                </div>
              </div>
            </button>
          )}

          {groupedModels.map(({ vendor, models: vendorModels }) => (
            <div key={vendor} className="flex flex-col gap-2">
              <VendorHeader vendor={vendor} />
              {vendorModels.map((m) => (
                <ModelOption
                  key={m.id}
                  model={m}
                  chatSlot={slot.capability === "chat"}
                  selected={current === m.id}
                  test={testByModel[m.id]}
                  onSelect={() => select(m.id)}
                  onTest={() => runTest(m.id)}
                />
              ))}
            </div>
          ))}

          {slotModels.length === 0 && (
            <p className="text-sm text-tertiary-foreground">
              No {slot.capability} models are available.
            </p>
          )}
        </div>
      </div>

      {/* Error (fixed, above footer) */}
      {error && (
        <div className="shrink-0 px-6 pt-3">
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        </div>
      )}

      {/* Footer (fixed) */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-6 py-4">
        <div>
          {canSaveAll && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={saveAllTiers}
              disabled={submitting}
            >
              Save and use for all Tiers
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="defaultInverted"
            size="sm"
            className="font-semibold"
            onClick={save}
            disabled={submitting}
          >
            {submitting
              ? "Saving…"
              : isTier
                ? `Save for ${scope.label}`
                : "Save global default"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function vendorLabel(vendor: string): string {
  if (vendor === "anthropic") return "Anthropic";
  if (vendor === "gemini") return "Google";
  return vendor.charAt(0).toUpperCase() + vendor.slice(1);
}

// VendorMark is the brand logo shown before a vendor group's name: the Claude
// (Anthropic) mark, or the Google glyph. Both inherit the current text colour.
function VendorMark({
  vendor,
  className,
}: {
  vendor: string;
  className?: string;
}) {
  if (vendor === "gemini") {
    return <Icon name="google" className={className} />;
  }
  return <Icon name="anthropic" className={className} />;
}

// VendorHeader is the group divider in the model picker.
function VendorHeader({ vendor }: { vendor: string }) {
  return (
    <div className="flex items-center gap-2.5 px-1 pt-1">
      <VendorMark vendor={vendor} className="size-6 text-foreground" />
      <span className="text-lg font-normal">
        {vendorLabel(vendor)}
      </span>
    </div>
  );
}

function ModelOption({
  model,
  chatSlot,
  selected,
  test,
  onSelect,
  onTest,
}: {
  model: Model;
  chatSlot: boolean;
  selected: boolean;
  test?: TestState;
  onSelect: () => void;
  onTest: () => void;
}) {
  // v1: chat slots accept Anthropic models only (CON-308 §4). Non-Anthropic
  // chat models are shown (with pricing) but not selectable.
  const blockedReason =
    chatSlot && model.vendor !== "anthropic" ? "Anthropic only in v1" : null;
  const disabled = !!blockedReason;

  return (
    <div
      className={cn(
        "relative rounded-lg border transition-all duration-200 ease-out",
        selected ? "border-2 border-[#1c7ef6] bg-blue-100/10" : "border-border",
        disabled && "opacity-60",
      )}
    >
      {/* Selected marker — lives in the left gutter the card padding reserves,
          aligned under the vendor name. */}
      {selected && (
        <HugeiconsIcon
          icon={CircleCheckBigIcon}
          className="pointer-events-none absolute left-2.5 top-3.5 size-5 text-[#1c7ef6] duration-200 animate-in fade-in zoom-in-75"
        />
      )}
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        disabled={disabled}
        onClick={onSelect}
        className={cn(
          "flex w-full items-start gap-3 py-3 pr-4 pl-[38px] text-left",
          !disabled && "cursor-pointer",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">
              {friendlyModel(model.id)}
            </span>
            {blockedReason && (
              <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-tertiary-foreground">
                {blockedReason}
              </span>
            )}
          </div>
          <div className="truncate text-[11px] text-tertiary-foreground">
            {model.id}
          </div>
          {/*<div className="mt-1.5">
            <ModelCapabilityBadges model={model} />
          </div>*/}
        </div>
        <div className="shrink-0 text-right mr-4">
          <HeadlinePrice model={model} className="text-sm" />
          <div className="mt-0.5 text-[10px] text-tertiary-foreground">
            prices v{model.priceVersion}
          </div>
        </div>
      </button>

      {/* Selected: Verify (golden probe) with an explainer, then results */}
      {selected && !disabled && (
        <div className="border-t border-border py-3 pr-4 pl-[38px] duration-200 animate-in fade-in slide-in-from-top-1">
          <div className="flex items-start gap-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-3 w-60 shrink-0 justify-start"
              onClick={onTest}
              disabled={test?.loading}
            >
              <HugeiconsIcon icon={AiChemistry02Icon} className="size-4" />
              {test?.loading ? "Testing…" : "Test model compatibility"}
            </Button>
            <p className="w-72 shrink-0 text-[11px] leading-snug text-tertiary-foreground">
              Runs the flow’s golden probe against this model: a static
              capability check, then one real call exercising its tools, schema
              and streaming — reporting pass/fail, latency and a sample.
            </p>
          </div>

          {(test?.result || test?.error) && (
            <div className="mt-2.5 flex flex-wrap items-center gap-3">
              {test?.result && <TestBadge result={test.result} />}
              {test?.error && (
                <span className="text-xs text-destructive">{test.error}</span>
              )}
            </div>
          )}
          {test?.result?.passed && test.result.sample && (
            <p className="mt-2 text-xs text-tertiary-foreground">
              {test.result.sample}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function PriceBreakdown({ model }: { model: Model }) {
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1">
      {PRICE_KINDS.map(({ kind, label }) => {
        const r = model.rates.find((x) => x.kind === kind);
        if (!r) return null;
        return (
          <div key={kind} className="text-xs">
            <span className="text-tertiary-foreground">{label}: </span>
            <span className="tabular-nums text-foreground">
              {usd(r.microsPerMillion)}
              <span className="text-tertiary-foreground"> /1M</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function TestBadge({ result }: { result: TestResult }) {
  if (result.passed) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700">
        <span className="size-1.5 rounded-full bg-emerald-500" />
        Passed · {result.latencyMs}ms
      </span>
    );
  }
  const unmet =
    result.unmetRequirements && result.unmetRequirements.length > 0
      ? ` · needs ${result.unmetRequirements.join(", ")}`
      : "";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive"
      title={result.detail}
    >
      <span className="size-1.5 rounded-full bg-destructive" />
      Failed{unmet}
    </span>
  );
}
