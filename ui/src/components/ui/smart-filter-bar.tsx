"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { FunnelSimpleIcon, XIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

// SmartFilterBar is the "Field operator value" token filter shared by /tenants
// (TenantsFilterBar) and the /pnl Ledger: a funnel glyph, committed chips with
// ×, a free input that walks field → operator → value through a suggestion
// menu ("Choose a field"), Clear, and the "/" focus hint. It only builds the
// tokens; the caller decides what they match.

export interface SmartFilterField<K extends string = string> {
  key: K;
  label: string;
  type: "text" | "enum" | "number";
  operators: string[];
  // Enum values. When set, the value step picks from these instead of
  // accepting free text.
  options?: string[];
  // How an option reads in the menu (default: verbatim).
  optionLabel?: (value: string) => string;
  // What typed text matches in the value menu: the option's label (default)
  // or its raw value.
  matchOn?: "label" | "value";
  // How a committed value reads inside a chip (default: verbatim).
  displayValue?: (value: string) => string;
  valuePrefix?: string;
  valuePlaceholder?: string;
}

export interface SmartFilterToken<K extends string = string> {
  field: K;
  operator: string;
  value: string;
}

type Draft<K extends string> = { field: SmartFilterField<K>; operator?: string };
type Suggestion = { label: string; apply: () => void };

export function SmartFilterBar<K extends string>({
  fields,
  tokens,
  onTokensChange,
  emptyPlaceholder,
  inputRef: externalRef,
  className,
}: {
  fields: SmartFilterField<K>[];
  tokens: SmartFilterToken<K>[];
  onTokensChange: (t: SmartFilterToken<K>[]) => void;
  // Placeholder while nothing is filtered, e.g. "Filter by name, status…".
  emptyPlaceholder: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  className?: string;
}) {
  const [draft, setDraft] = useState<Draft<K> | null>(null);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [focused, setFocused] = useState(false);
  const ownRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const inputRef = externalRef ?? ownRef;

  // Focus the filter on "/" (unless the user is already typing somewhere).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      const typing =
        el?.tagName === "INPUT" ||
        el?.tagName === "TEXTAREA" ||
        el?.tagName === "SELECT" ||
        el?.isContentEditable;
      if (typing) return;
      e.preventDefault();
      inputRef.current?.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [inputRef]);

  const fieldByKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const chipValue = (t: SmartFilterToken<K>) =>
    fieldByKey.get(t.field)?.displayValue?.(t.value) ?? t.value;
  const chipLabel = (t: SmartFilterToken<K>) => fieldByKey.get(t.field)?.label ?? t.field;

  const stage: "field" | "operator" | "value" = !draft
    ? "field"
    : !draft.operator
      ? "operator"
      : "value";

  function commit(token: SmartFilterToken<K>) {
    onTokensChange([...tokens, token]);
    setDraft(null);
    setText("");
    setActiveIdx(0);
  }

  const suggestions: Suggestion[] = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (stage === "field") {
      return fields
        .filter((f) => f.label.toLowerCase().includes(q))
        .map((f) => ({ label: f.label, apply: () => setDraft({ field: f }) }));
    }
    if (stage === "operator" && draft) {
      return draft.field.operators
        .filter((op) => op.toLowerCase().includes(q))
        .map((op) => ({
          label: op,
          apply: () => setDraft({ ...draft, operator: op }),
        }));
    }
    // value stage
    if (!draft || !draft.operator) return [];
    const f = draft.field;
    const commitValue = (v: string) =>
      v && commit({ field: f.key, operator: draft.operator!, value: v });

    if (f.options && f.options.length) {
      const label = f.optionLabel ?? ((o: string) => o);
      return f.options
        .filter((o) =>
          (f.matchOn === "value" ? o : label(o)).toLowerCase().includes(q),
        )
        .map((o) => ({ label: label(o), apply: () => commitValue(o) }));
    }
    const raw = text.trim();
    if (!raw) return [];
    if (f.type === "number" && Number.isNaN(Number(raw))) return [];
    const shown =
      f.type === "number" ? `${f.valuePrefix ?? ""}${raw}` : `“${raw}”`;
    return [{ label: shown, apply: () => commitValue(raw) }];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, text, draft, fields, tokens]);

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
        : emptyPlaceholder
      : stage === "operator"
        ? "Operator…"
        : draft?.field.options?.length
          ? "Pick a value…"
          : draft?.field.valuePlaceholder
            ? `${draft.field.valuePlaceholder}, Enter to add`
            : "Type a value, Enter to add";

  return (
    <div
      className={cn(
        "relative flex min-h-[42px] flex-wrap items-center gap-1.5 rounded-lg border bg-primary px-2 py-1.5 text-sm transition-colors",
        focused ? "border-secondary-foreground" : "border-border",
        className,
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
            {chipLabel(t)}{" "}
            <span className="text-tertiary-foreground">{t.operator}</span>{" "}
            <b className="font-semibold text-foreground">{chipValue(t)}</b>
          </span>
          <button
            type="button"
            aria-label={`Remove filter ${chipLabel(t)} ${t.operator} ${t.value}`}
            className="inline-flex rounded-full p-0.5 text-tertiary-foreground transition-colors hover:bg-primary hover:text-foreground"
            onClick={() => removeToken(i)}
          >
            <XIcon className="size-3" weight="bold" />
          </button>
        </span>
      ))}

      {draft && (
        <span className="inline-flex items-center gap-1 pl-1 text-xs text-foreground">
          {draft.field.label}
          {draft.operator ? ` ${draft.operator}` : ""}
        </span>
      )}

      <input
        ref={inputRef}
        className="min-w-[120px] flex-1 bg-transparent px-0.5 py-1 outline-none placeholder:text-tertiary-foreground"
        value={text}
        placeholder={placeholder}
        inputMode={draft?.field.type === "number" ? "decimal" : "text"}
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
        aria-label="Add filter"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
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
          id={listboxId}
          role="listbox"
          // z-30 keeps the suggestion menu above the table's sticky header
          // cells (z-20), which sit later in the DOM and would otherwise paint
          // over the dropdown where it overlaps the table.
          className="absolute left-0 top-[calc(100%+6px)] z-30 max-h-64 min-w-[240px] overflow-y-auto rounded-lg border border-border bg-primary p-1 shadow-lg"
        >
          <div className="px-2.5 pb-1.5 pt-1 text-[11px] uppercase tracking-wide text-tertiary-foreground">
            {stage === "field" && "Choose a field"}
            {stage === "operator" &&
              draft &&
              `${draft.field.label} — choose an operator`}
            {stage === "value" &&
              draft &&
              `${draft.field.label} ${draft.operator}…`}
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
