"use client";

import { useId, useState } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { bytesToMB, mbToBytes, formatBytes } from "./bytes";

// Shared form controls for the platform constraint editors. They wrap the app's
// Input/Label primitives so every field in the (large) Add/Edit form stays
// visually consistent and the dialog body reads as data, not markup.

// Field is a labeled wrapper: a Label above the control and an optional dim
// hint below it.
export function Field({
  label,
  htmlFor,
  hint,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-tertiary-foreground">{hint}</p>}
    </div>
  );
}

// Toggle is an accessible on/off switch (role="switch") with a trailing label,
// matching the emerald/neutral status colors used elsewhere.
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex items-center gap-2.5 text-sm",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
          checked ? "bg-emerald-500" : "bg-quaternary",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 size-4 rounded-full bg-white transition-transform",
            checked && "translate-x-4",
          )}
        />
      </button>
      <span className="text-foreground">{label}</span>
    </label>
  );
}

// NumberField edits a non-negative integer. Empty / non-numeric collapses to 0.
export function NumberField({
  label,
  value,
  onChange,
  hint,
  min = 0,
  placeholder,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  hint?: React.ReactNode;
  min?: number;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        value={Number.isFinite(value) ? String(value) : ""}
        placeholder={placeholder}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(Number.isFinite(n) && n >= min ? Math.floor(n) : 0);
        }}
        autoComplete="off"
      />
    </Field>
  );
}

// ByteField edits a size cap. Ogen stores bytes; the operator edits MB, and the
// exact byte value is shown as a hint so the round-trip is transparent.
export function ByteField({
  label,
  bytes,
  onChange,
  extraHint,
}: {
  label: string;
  bytes: number;
  onChange: (nextBytes: number) => void;
  extraHint?: React.ReactNode;
}) {
  const id = useId();
  const mb = bytesToMB(bytes);
  return (
    <Field
      label={label}
      htmlFor={id}
      hint={
        <>
          In megabytes. Stored as {bytes.toLocaleString()} bytes ({formatBytes(bytes)}).
          {extraHint ? <> {extraHint}</> : null}
        </>
      }
    >
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={0}
        step="0.1"
        value={mb !== 0 ? String(Number(mb.toFixed(3))) : "0"}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(n > 0 ? mbToBytes(n) : 0);
        }}
        autoComplete="off"
      />
    </Field>
  );
}

// TagsField edits a comma-separated string list (formats, aspect ratios). It
// keeps its own text buffer so the operator can type commas/spaces freely;
// parsing to a trimmed, de-duped array happens on each change.
export function TagsField({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string[] | null;
  onChange: (next: string[]) => void;
  placeholder?: string;
  hint?: React.ReactNode;
}) {
  const id = useId();
  const [text, setText] = useState(() => (value ?? []).join(", "));
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <Input
        id={id}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = e.target.value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          onChange([...new Set(parsed)]);
        }}
        autoComplete="off"
        spellCheck={false}
      />
    </Field>
  );
}
