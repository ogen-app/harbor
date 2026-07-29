"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FunnelSimpleIcon, XIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

// A token-based power-search filter for the recent-activity table, mirroring the
// Tenants filter bar. Every activity field is categorical, so the value stage
// always picks from the options present in the loaded events (no free text).

export type ActivityFieldKey = "category" | "type" | "status" | "source";

// "tenant" is a special scope field: the categorical fields narrow the loaded
// rows client-side, but a tenant token re-scopes the whole feed server-side. It
// only appears when tenantOptions are supplied (the global Activity page).
export type ActivityFilterField = ActivityFieldKey | "tenant";

export interface ActivityFilterToken {
  field: ActivityFilterField;
  operator: "is" | "is not";
  value: string;
  // Display label for tokens whose value is an opaque id (tenant → tenant name).
  label?: string;
}

export type ActivityOptions = Record<ActivityFieldKey, string[]>;

// One selectable tenant for the scope field: value is the id, label the name.
export interface TenantFilterOption {
  id: string;
  name: string;
}

const FIELD_ORDER: ActivityFieldKey[] = ["category", "type", "status", "source"];
const FIELD_LABEL: Record<ActivityFilterField, string> = {
  tenant: "Tenant",
  category: "Category",
  type: "Type",
  status: "Status",
  source: "Source",
};
const OPERATORS = ["is", "is not"] as const;

type Draft = { field: ActivityFilterField; operator?: "is" | "is not" };
type Suggestion = { label: string; apply: () => void };

export function ActivityFilterBar({
  tokens,
  onTokensChange,
  options,
  tenantOptions,
}: {
  tokens: ActivityFilterToken[];
  onTokensChange: (t: ActivityFilterToken[]) => void;
  options: ActivityOptions;
  // When provided, adds a "Tenant" scope field to the bar (the global page).
  tenantOptions?: TenantFilterOption[];
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the filter on "/" (unless the user is already typing somewhere).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (
        el?.tagName === "INPUT" ||
        el?.tagName === "TEXTAREA" ||
        el?.tagName === "SELECT" ||
        el?.isContentEditable
      ) {
        return;
      }
      e.preventDefault();
      inputRef.current?.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const stage: "field" | "operator" | "value" = !draft
    ? "field"
    : !draft.operator
      ? "operator"
      : "value";

  function commit(token: ActivityFilterToken) {
    onTokensChange([...tokens, token]);
    setDraft(null);
    setText("");
    setActiveIdx(0);
  }

  const suggestions: Suggestion[] = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (stage === "field") {
      // Offer the tenant scope field only when options exist and no tenant token
      // is set yet — a single tenant scopes the whole feed.
      const hasTenant = tokens.some((t) => t.field === "tenant");
      const fields: ActivityFilterField[] = [
        ...(tenantOptions && tenantOptions.length > 0 && !hasTenant
          ? (["tenant"] as const)
          : []),
        ...FIELD_ORDER,
      ];
      return fields
        .filter((f) => FIELD_LABEL[f].toLowerCase().includes(q))
        .map((f) => ({
          label: FIELD_LABEL[f],
          apply: () => setDraft({ field: f }),
        }));
    }
    if (stage === "operator" && draft) {
      // Tenant is a scope (one value), so only "is"; categorical fields also
      // allow "is not".
      const ops = draft.field === "tenant" ? (["is"] as const) : OPERATORS;
      return ops.filter((op) => op.includes(q)).map((op) => ({
        label: op,
        apply: () => setDraft({ ...draft, operator: op }),
      }));
    }
    if (!draft || !draft.operator) return [];
    const op = draft.operator;
    if (draft.field === "tenant") {
      return (tenantOptions ?? [])
        .filter((t) => t.name.toLowerCase().includes(q))
        .map((t) => ({
          label: t.name,
          apply: () =>
            commit({ field: "tenant", operator: op, value: t.id, label: t.name }),
        }));
    }
    return (options[draft.field] ?? [])
      .filter((o) => o.toLowerCase().includes(q))
      .map((o) => ({
        label: o,
        apply: () => commit({ field: draft.field, operator: op, value: o }),
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, text, draft, options, tenantOptions, tokens]);

  function removeToken(i: number) {
    onTokensChange(tokens.filter((_, idx) => idx !== i));
    inputRef.current?.focus();
  }
  function clearAll() {
    onTokensChange([]);
    setDraft(null);
    setText("");
    inputRef.current?.focus();
  }
  function pick(idx: number) {
    const s = suggestions[idx];
    if (!s) return;
    s.apply();
    setText("");
    setActiveIdx(0);
    setOpen(true);
    inputRef.current?.focus();
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(activeIdx);
    } else if (e.key === "Escape") {
      setOpen(false);
      if (draft) setDraft(null);
    } else if (e.key === "Backspace" && text === "") {
      if (stage === "value" && draft) setDraft({ field: draft.field });
      else if (stage === "operator") setDraft(null);
      else if (tokens.length) removeToken(tokens.length - 1);
    }
  }

  const placeholder =
    stage === "field"
      ? tokens.length
        ? "Add filter…"
        : tenantOptions && tenantOptions.length > 0
          ? "Filter by tenant, category, type, status, source…"
          : "Filter by category, type, status, source…"
      : stage === "operator"
        ? "Operator…"
        : draft?.field === "tenant"
          ? "Pick a tenant…"
          : "Pick a value…";

  return (
    <div
      className={cn(
        "relative flex min-h-[42px] flex-wrap items-center gap-1.5 rounded-lg border bg-primary px-2 py-1.5 text-sm transition-colors",
        focused ? "border-secondary-foreground" : "border-border",
      )}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault();
          inputRef.current?.focus();
        }
      }}
    >
      <FunnelSimpleIcon
        weight="bold"
        className="ml-1 size-4 shrink-0 text-tertiary-foreground"
      />

      {tokens.map((t, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-secondary py-1 pl-2.5 pr-1.5 text-xs leading-none"
        >
          <span className="text-secondary-foreground">
            {FIELD_LABEL[t.field]}{" "}
            <span className="text-tertiary-foreground">{t.operator}</span>{" "}
            <b className="font-semibold text-foreground">{t.label ?? t.value}</b>
          </span>
          <button
            type="button"
            aria-label={`Remove filter ${FIELD_LABEL[t.field]} ${t.operator} ${t.label ?? t.value}`}
            className="inline-flex rounded-full p-0.5 text-tertiary-foreground transition-colors hover:bg-primary hover:text-foreground"
            onClick={() => removeToken(i)}
          >
            <XIcon className="size-3" weight="bold" />
          </button>
        </span>
      ))}

      {draft && (
        <span className="inline-flex items-center gap-1 pl-1 text-xs text-foreground">
          {FIELD_LABEL[draft.field]}
          {draft.operator ? ` ${draft.operator}` : ""}
        </span>
      )}

      <input
        ref={inputRef}
        className="min-w-[120px] flex-1 bg-transparent px-0.5 py-1 outline-none placeholder:text-tertiary-foreground"
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActiveIdx(0);
        }}
        onFocus={() => {
          setFocused(true);
          setOpen(true);
        }}
        onBlur={() => {
          setFocused(false);
          setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={onKeyDown}
        aria-label="Add activity filter"
        role="combobox"
        aria-controls="activity-filter-listbox"
        aria-expanded={open}
      />

      {tokens.length > 0 ? (
        <button
          type="button"
          aria-label="Clear all filters"
          className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-tertiary-foreground transition-colors hover:bg-secondary hover:text-foreground"
          onClick={clearAll}
        >
          <XIcon className="size-3.5" weight="bold" />
          Clear
        </button>
      ) : (
        !focused &&
        !draft && (
          <kbd className="pointer-events-none ml-auto mr-1 select-none rounded border border-border px-1.5 py-0.5 text-[11px] leading-none text-tertiary-foreground">
            /
          </kbd>
        )
      )}

      {open && suggestions.length > 0 && (
        <div
          id="activity-filter-listbox"
          role="listbox"
          className="absolute left-0 top-[calc(100%+6px)] z-50 max-h-64 min-w-[240px] overflow-y-auto rounded-lg border border-border bg-primary p-1 shadow-lg"
        >
          <div className="px-2.5 pb-1.5 pt-1 text-[11px] uppercase tracking-wide text-tertiary-foreground">
            {stage === "field" && "Choose a field"}
            {stage === "operator" &&
              draft &&
              `${FIELD_LABEL[draft.field]} — choose an operator`}
            {stage === "value" &&
              draft &&
              `${FIELD_LABEL[draft.field]} ${draft.operator}…`}
          </div>
          {suggestions.map((s, i) => (
            <div
              key={s.label}
              role="option"
              aria-selected={i === activeIdx}
              className={cn(
                "cursor-pointer rounded-md px-2.5 py-2 text-sm text-foreground",
                i === activeIdx && "bg-secondary",
              )}
              onMouseEnter={() => setActiveIdx(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(i);
              }}
            >
              {s.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
