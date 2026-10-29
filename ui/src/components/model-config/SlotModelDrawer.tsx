"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
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
  compareModelVersionDesc,
  friendlyModel,
  humanize,
  modelDetail,
  modelFamily,
  PriceHead,
  priceDelta,
  priceIn,
  priceOut,
  rate,
  servesCapability,
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
  // System flows run for Harbor itself: like global-only slots, they have no
  // tier tabs.
  system?: boolean;
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
// "Global (default)" tab plus one tab per tier (unless the slot is global-only
// or the flow is a system flow); each tab is a capability-filtered model picker
// grouped by vendor and model family, with In / Out pricing, the change against
// the current model, and a per-model compatibility test. The footer states the
// consequence of saving before the operator commits it.
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
  system = false,
  models,
  tiers,
  assignments,
  onChanged,
}: SlotModelDrawerProps) {
  const tierTabs = !slot.globalOnly && !system;
  const scopes = useMemo<Scope[]>(() => {
    const s: Scope[] = [{ key: "", label: "Global (default)" }];
    if (tierTabs) {
      for (const t of tiers) s.push({ key: t.id, label: t.name, tier: t });
    }
    return s;
  }, [tierTabs, tiers]);

  // What is saved today per scope: a model id, or INHERIT for a tier with no
  // override.
  const saved = useMemo(() => {
    const here = (tierId: string) =>
      assignments.find(
        (a) =>
          a.flowKey === flow.key &&
          a.slotKey === slot.key &&
          a.tierId === tierId,
      );
    const d: Record<string, string> = { "": here("")?.modelId ?? "" };
    for (const t of tiers) d[t.id] = here(t.id)?.modelId ?? INHERIT;
    return d;
  }, [assignments, flow.key, slot.key, tiers]);

  // Selection per scope, seeded once from what is saved (the drawer is
  // remounted per open).
  const [draft, setDraft] = useState<Record<string, string>>(() => ({ ...saved }));

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
  const savedHere = saved[scope.key] ?? (isTier ? INHERIT : "");
  const globalModelId = draft[""];
  const savedGlobalId = saved[""];

  const modelsById = useMemo(
    () => new Map(models.map((m) => [m.id, m])),
    [models],
  );
  // The model this scope runs on today: its own override, else the global
  // default. Price changes in the picker are shown against it.
  const baselineId =
    savedHere && savedHere !== INHERIT ? savedHere : savedGlobalId;
  const baseline = modelsById.get(baselineId);

  const slotModels = useMemo(
    () => models.filter((m) => servesCapability(m, slot.capability)),
    [models, slot.capability],
  );

  // Group the picker by vendor (Anthropic, then Google; unknown vendors last),
  // then by model family. Families run cheapest first (by the input rate of
  // their newest model); versions within a family run newest first.
  const groupedModels = useMemo(() => {
    const vendorOrder = ["anthropic", "gemini"];
    const byVendor = new Map<string, Map<string, Model[]>>();
    for (const m of slotModels) {
      const families = byVendor.get(m.vendor) ?? new Map<string, Model[]>();
      const fam = modelFamily(m.id);
      families.set(fam, [...(families.get(fam) ?? []), m]);
      byVendor.set(m.vendor, families);
    }
    const inputRate = (m: Model) => rate(m, "input") ?? Number.MAX_SAFE_INTEGER;
    return [...byVendor.entries()]
      .sort(([a], [b]) => {
        const ia = vendorOrder.indexOf(a);
        const ib = vendorOrder.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      })
      .map(([vendor, families]) => ({
        vendor,
        families: [...families.entries()]
          .map(([family, list]) => ({
            family,
            models: [...list].sort((a, b) => compareModelVersionDesc(a.id, b.id)),
          }))
          .sort((a, b) => inputRate(a.models[0]) - inputRate(b.models[0])),
      }));
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

  const title = flow.slots.length > 1 ? `${humanize(flow.key)} · ${humanize(slot.key)}` : humanize(flow.key);
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
      onChanged(`Updated ${title}${scopeLabel}`);
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
      onChanged(`${friendlyModel(sel)} set for all tiers · ${title}`);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
      setSubmitting(false);
    }
  };

  const dirty = current !== savedHere;
  const canSaveAll = tierTabs && !isTier && !!current && current !== INHERIT;

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
            {title}
          </DrawerTitle>
          {slot.capability !== "chat" && (
            <CapabilityBadge capability={slot.capability} />
          )}
        </div>
        <DrawerDescription className="mt-1">
          {flow.slots.length > 1 ? slot.description : flow.description}
          {system
            ? " Runs for Harbor itself, so it has no tier overrides."
            : slot.globalOnly &&
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
            {scopes.map((s, i) => {
              const edited = draft[s.key] !== saved[s.key];
              return (
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
                  {edited && (
                    <span
                      className="size-1.5 rounded-full bg-editable"
                      aria-label="unsaved change"
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Scroll body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {/* Per-tier effective-config note */}
        {isTier && (
          <p className="mb-3 text-xs text-secondary-foreground">
            {savedHere === INHERIT ? (
              <>
                <span className="font-medium text-foreground">
                  {scope.label}
                </span>{" "}
                inherits the global default
                {savedGlobalId ? (
                  <>
                    {" "}
                    (
                    <span className="text-foreground">
                      {friendlyModel(savedGlobalId)}
                    </span>
                    )
                  </>
                ) : null}
                . Pick a model to override it.
              </>
            ) : (
              <>
                <span className="font-medium text-foreground">
                  {scope.label}
                </span>{" "}
                overrides the global default with{" "}
                <span className="text-foreground">
                  {friendlyModel(savedHere)}
                </span>
                .
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
                <div className="text-xs text-secondary-foreground">
                  {globalModelId
                    ? `Currently ${friendlyModel(globalModelId)}`
                    : "No global default set"}
                </div>
              </div>
            </button>
          )}

          {groupedModels.map(({ vendor, families }) => (
            <div key={vendor} className="flex flex-col gap-2">
              <VendorHeader vendor={vendor} />
              {families.map(({ family, models: familyModels }) => (
                <div key={family} className="flex flex-col gap-2">
                  <div className="px-1 pt-1 text-[15px] font-medium text-foreground">
                    {family} family
                  </div>
                  {familyModels.map((m) => (
                    <ModelOption
                      key={m.id}
                      model={m}
                      slotVendors={slot.vendors ?? []}
                      selected={current === m.id}
                      isGlobalDefault={m.id === savedGlobalId}
                      baseline={baseline}
                      test={testByModel[m.id]}
                      onSelect={() => select(m.id)}
                      onTest={() => runTest(m.id)}
                    />
                  ))}
                </div>
              ))}
            </div>
          ))}

          {slotModels.length === 0 && (
            <p className="text-sm text-secondary-foreground">
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

      {/* Footer (fixed): what saving will do, then the actions. */}
      <div className="flex shrink-0 items-center justify-between gap-4 border-t border-border px-6 py-4">
        <Consequence
          dirty={dirty}
          scope={scope}
          from={savedHere}
          to={current}
          globalId={savedGlobalId}
          modelsById={modelsById}
          tierTabs={tierTabs}
        />
        <div className="flex shrink-0 items-center gap-2">
          {canSaveAll && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={saveAllTiers}
              disabled={submitting}
            >
              Save and use for all tiers
            </Button>
          )}
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
            disabled={submitting || !dirty}
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

// Consequence states what saving the active scope will change and for whom, so
// a production-affecting edit is never a blind click.
function Consequence({
  dirty,
  scope,
  from,
  to,
  globalId,
  modelsById,
  tierTabs,
}: {
  dirty: boolean;
  scope: Scope;
  from: string;
  to: string;
  globalId: string;
  modelsById: Map<string, Model>;
  tierTabs: boolean;
}) {
  if (!dirty) {
    return (
      <p className="min-w-0 text-xs text-secondary-foreground">
        No changes yet. Pick a model to see what saving will do.
      </p>
    );
  }
  const name = (id: string) =>
    id === INHERIT
      ? `global default (${friendlyModel(globalId)})`
      : id
        ? friendlyModel(id)
        : "not set";
  // Effective models before and after, for the price change.
  const effective = (id: string) => modelsById.get(id === INHERIT ? globalId : id);
  const before = effective(from);
  const after = effective(to);
  const dIn = after ? priceDelta(after, before, "input") : null;
  const dOut = after ? priceDelta(after, before, "output") : null;
  const who = scope.tier
    ? `every ${scope.tier.name} tenant`
    : tierTabs
      ? "every tier without an override"
      : "every run";
  const priceNote =
    dIn && dOut && dIn.label === dOut.label
      ? ` · in / out ${dIn.label}`
      : [dIn && ` · in ${dIn.label}`, dOut && ` · out ${dOut.label}`]
          .filter(Boolean)
          .join("");

  return (
    <div className="min-w-0 text-[13px]">
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5">
        <span className="text-secondary-foreground">
          {scope.tier ? scope.tier.name : "Global default"}:
        </span>
        <span>{name(from)}</span>
        <span className="text-tertiary-foreground">→</span>
        <span className="font-medium text-editable">{name(to)}</span>
      </div>
      <div className="mt-0.5 text-xs text-secondary-foreground">
        Applies to {who} on its next run{priceNote}
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

// VendorHeader is the group divider in the model picker. It carries the In /
// Out column heads, aligned with the price columns of the options below.
function VendorHeader({ vendor }: { vendor: string }) {
  return (
    <div className="flex items-center gap-2.5 px-1 pt-1">
      <VendorMark vendor={vendor} className="size-6 text-foreground" />
      <span className="flex-1 text-lg font-normal">{vendorLabel(vendor)}</span>
      <div className="mr-8 grid grid-cols-[4.5rem_4.5rem] gap-2 text-[11px] font-medium tracking-wide text-secondary-foreground uppercase">
        <PriceHead kind="input" />
        <PriceHead kind="output" />
      </div>
    </div>
  );
}

function ModelOption({
  model,
  slotVendors,
  selected,
  isGlobalDefault,
  baseline,
  test,
  onSelect,
  onTest,
}: {
  model: Model;
  slotVendors: string[];
  selected: boolean;
  isGlobalDefault: boolean;
  baseline: Model | undefined;
  test?: TestState;
  onSelect: () => void;
  onTest: () => void;
}) {
  // A slot may restrict the vendors that can fill it (in-process chat slots are
  // Anthropic only). Models of other vendors are shown (with pricing) but not
  // selectable.
  const blockedReason =
    slotVendors.length > 0 && !slotVendors.includes(model.vendor)
      ? `${slotVendors.map(vendorLabel).join(" / ")} only`
      : null;
  const disabled = !!blockedReason;
  const dIn = priceDelta(model, baseline, "input");
  const dOut = priceDelta(model, baseline, "output");

  return (
    <div
      className={cn(
        "relative rounded-lg border transition-all duration-200 ease-out",
        selected ? "border-2 border-[#1c7ef6] bg-blue-100/10" : "border-border",
        disabled && "opacity-60",
      )}
    >
      {/* Selected marker — lives in the left gutter the card padding reserves. */}
      {selected && (
        <HugeiconsIcon
          icon={CircleCheckBigIcon}
          className="pointer-events-none absolute top-3.5 left-2.5 size-5 text-[#1c7ef6] duration-200 animate-in fade-in zoom-in-75"
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
            <span className="text-sm font-medium" title={model.id}>
              {friendlyModel(model.id)}
            </span>
            {isGlobalDefault && (
              <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-secondary-foreground">
                Global default
              </span>
            )}
            {blockedReason && (
              <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
                {blockedReason}
              </span>
            )}
          </div>
          <div className="truncate text-[11px] text-secondary-foreground">
            {modelDetail(model)}
          </div>
        </div>
        <div className="mr-4 grid shrink-0 grid-cols-[4.5rem_4.5rem] gap-2 text-right text-sm tabular-nums">
          <PriceCell value={priceIn(model)} delta={dIn} />
          <PriceCell value={priceOut(model)} delta={dOut} />
        </div>
      </button>

      {/* Selected: compatibility test with its explainer, then results */}
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
            <p className="w-72 shrink-0 text-[11px] leading-snug text-secondary-foreground">
              Runs the flow’s golden probe against this model: a static
              capability check, then one real call exercising its tools, schema
              and streaming.
            </p>
          </div>

          {(test?.result || test?.error) && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {test?.result && <TestBadges result={test.result} />}
              {test?.error && (
                <span className="text-xs text-destructive">{test.error}</span>
              )}
            </div>
          )}
          {test?.result?.passed && test.result.sample && (
            <p className="mt-2 text-xs text-secondary-foreground">
              {test.result.sample}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function PriceCell({
  value,
  delta,
}: {
  value: string;
  delta: { label: string; cheaper: boolean } | null;
}) {
  return (
    <div>
      <div className={cn(value === "—" && "text-secondary-foreground")}>
        {value}
      </div>
      {delta && (
        <div
          className={cn(
            "text-[11px] font-medium",
            delta.cheaper ? "text-emerald-700" : "text-destructive",
          )}
        >
          {delta.label}
        </div>
      )}
    </div>
  );
}

// TestBadges splits the probe result into its two steps. A non-empty
// unmetRequirements means the static check failed (the live call never ran);
// otherwise the static check passed and the live probe decided the outcome.
function TestBadges({ result }: { result: TestResult }) {
  const unmet = result.unmetRequirements ?? [];
  if (unmet.length > 0) {
    return (
      <Pill ok={false} title={result.detail}>
        Static check failed · needs {unmet.join(", ")}
      </Pill>
    );
  }
  return (
    <>
      <Pill ok>Static check passed</Pill>
      <Pill ok={result.passed} title={result.detail}>
        {result.passed
          ? `Live probe passed · ${formatLatency(result.latencyMs)}`
          : "Live probe failed"}
      </Pill>
    </>
  );
}

function Pill({
  ok,
  title,
  children,
}: {
  ok: boolean;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        ok
          ? "bg-emerald-500/10 text-emerald-700"
          : "bg-destructive/10 text-destructive",
      )}
      title={title}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          ok ? "bg-emerald-500" : "bg-destructive",
        )}
      />
      {children}
    </span>
  );
}

function formatLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}
