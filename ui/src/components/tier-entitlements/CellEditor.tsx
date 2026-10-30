"use client";

import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert01Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import {
  describe,
  isBytes,
  unitLabel,
  type Inversion,
} from "./model";
import type { EntitlementValue, Feature } from "./types";

const MB = 1024 * 1024;

type Mode = "limit" | "unlimited" | "excluded" | "included" | "unset";

function modeOf(f: Feature, v: EntitlementValue | undefined): Mode {
  if (v === undefined) return "unset";
  if (f.valueType === "boolean" || typeof v === "boolean")
    return v ? "included" : "excluded";
  if (v === null) return "unlimited";
  return v === 0 ? "excluded" : "limit";
}

// Segment is one option of the editor's segmented control.
function Segment({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "h-6 flex-1 cursor-pointer rounded-xs px-2 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-editable/50",
        active
          ? "border border-border bg-primary font-medium text-foreground shadow-xs"
          : "text-secondary-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

// CellEditor is the body of the popover anchored to a draft cell (CON-321 §3).
// Every change is reported immediately; the matrix autosaves the draft, which
// is safe because a draft reaches no tenant. Enter closes, Esc reverts the cell
// to the value it had when the editor opened.
export function CellEditor({
  feature,
  tierName,
  versionLabel,
  value,
  baseValue,
  baseLabel,
  neighbours,
  inversion,
  onChange,
  onClose,
}: {
  feature: Feature;
  tierName: string;
  versionLabel: string;
  value: EntitlementValue | undefined;
  baseValue: EntitlementValue | undefined;
  baseLabel: string | null;
  neighbours: { tierName: string; value: EntitlementValue | undefined }[];
  inversion: Inversion | null;
  onChange: (v: EntitlementValue | undefined) => void;
  onClose: () => void;
}) {
  const bytes = isBytes(feature);
  const boolean = feature.valueType === "boolean";
  const mode = modeOf(feature, value);
  const initial = useRef(value);
  const inputRef = useRef<HTMLInputElement>(null);

  // The number field keeps its own text so a half-typed value ("1.") isn't
  // normalised away; it re-syncs when the value changes from outside.
  const toText = (v: EntitlementValue | undefined) =>
    typeof v === "number" && v !== 0
      ? String(bytes ? Math.round((v / MB) * 10) / 10 : v)
      : "";
  const [text, setText] = useState(() => toText(value));
  const lastValue = useRef(value);
  useEffect(() => {
    if (lastValue.current !== value) {
      lastValue.current = value;
      setText(toText(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    if (mode === "limit") inputRef.current?.focus();
    // Focus the number once, when the editor opens on a limit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setLimit = (raw: string) => {
    setText(raw);
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n) || n <= 0) return;
    const next = bytes ? Math.round(n * MB) : Math.round(n);
    lastValue.current = next;
    onChange(next);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onChange(initial.current);
      onClose();
    }
  };

  const show = (v: EntitlementValue | undefined) => describe(feature, v).text;
  const unit = bytes ? "MB" : unitLabel(feature) || "";

  return (
    <div className="flex flex-col gap-3" onKeyDown={onKeyDown}>
      <p className="text-[13px]">
        <span className="font-medium text-foreground">{feature.name}</span>
        <span className="text-secondary-foreground">
          {" "}
          · {tierName} {versionLabel}
        </span>
      </p>

      <div className="flex gap-0.5 rounded-xs border border-border bg-secondary p-0.5">
        {boolean ? (
          <>
            <Segment active={mode === "included"} onClick={() => onChange(true)}>
              Included
            </Segment>
            <Segment active={mode === "excluded"} onClick={() => onChange(false)}>
              Not included
            </Segment>
          </>
        ) : (
          <>
            <Segment
              active={mode === "limit"}
              onClick={() => {
                setLimit(text || "1");
                requestAnimationFrame(() => inputRef.current?.select());
              }}
            >
              Limit
            </Segment>
            <Segment active={mode === "unlimited"} onClick={() => onChange(null)}>
              Unlimited
            </Segment>
            <Segment active={mode === "excluded"} onClick={() => onChange(0)}>
              Not included
            </Segment>
          </>
        )}
      </div>

      {!boolean && mode === "limit" && (
        <div className="flex items-center gap-3">
          <input
            ref={inputRef}
            type="number"
            min={1}
            inputMode="numeric"
            aria-label={`${feature.name} limit`}
            value={text}
            onChange={(e) => setLimit(e.target.value)}
            className="h-8 w-32 rounded-xs border border-editable bg-primary px-2.5 text-sm font-medium text-editable tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-editable/30"
          />
          {unit && <span className="text-[13px] text-secondary-foreground">{unit}</span>}
        </div>
      )}

      {mode === "unset" && (
        <p className="text-xs text-amber-700">
          Not set on this version, so tenants get it with no limit. Pick a value
          to set it.
        </p>
      )}

      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-secondary-foreground">
        {baseLabel && (
          <span>
            Was {show(baseValue)} in {baseLabel}
          </span>
        )}
        {neighbours.map((n) => (
          <span
            key={n.tierName}
            className={cn(
              "before:mr-1.5 before:text-tertiary-foreground before:content-['·'] first:before:content-none",
              inversion?.tierName === n.tierName && "font-medium text-amber-700",
            )}
          >
            {n.tierName} {show(n.value)}
          </span>
        ))}
      </p>

      {inversion && (
        <p className="flex items-center gap-1.5 text-xs text-amber-700">
          <HugeiconsIcon icon={Alert01Icon} className="size-3.5 shrink-0" />
          {inversion.direction === "above"
            ? `${tierName} would get more than ${inversion.tierName}.`
            : `${inversion.tierName} would get more than ${tierName}.`}
        </p>
      )}

      <div className="flex flex-col gap-1 border-t border-border pt-2.5 text-xs text-secondary-foreground">
        <span>Saved to the draft as you edit</span>
        <span className="flex items-center justify-between">
          <span>↵ done · Esc undo</span>
          {mode !== "unset" && (
            <button
              type="button"
              title="Remove the value. Tenants then get this feature with no limit."
              onClick={() => onChange(undefined)}
              className="cursor-pointer underline-offset-2 hover:text-foreground hover:underline"
            >
              Clear value
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
