"use client";

import { useId, useState } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { bytesToMB, mbToBytes, formatBytes } from "./bytes";

// Shared form controls for the platform constraint editors. They wrap the app's
// Input/Label primitives so every field in the (large) Add/Edit form stays
// visually consistent and the dialog body reads as data, not markup.

// Two-column field grid shared by the platform editors (Add/Edit form and the
// Global limits dialog). items-start so a field with a hint doesn't stretch its
// hint-less neighbour's rows — that stretching pushed inputs out of alignment
// (the "jumping" bug). gap-y is generous since rows have uneven heights.
export const FIELD_GRID = "grid grid-cols-2 items-start gap-x-4 gap-y-5";

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

// Toggle pairs the shared Switch (the /tier-entitlements form switcher) with a
// trailing label — and an optional description line stacked under it (switch
// aligns to the top). `variant` picks the on-colour: default (dark) mirrors the
// per-feature entitlement switches; "success" fills #6B8068 green.
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
  variant = "default",
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: React.ReactNode;
  disabled?: boolean;
  variant?: "default" | "success" | "warning";
}) {
  return (
    <div
      className={cn(
        "flex gap-2.5 text-sm",
        description ? "items-start" : "items-center",
        disabled && "opacity-50",
      )}
    >
      <Switch
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        label={label}
        variant={variant}
      />
      {description ? (
        <span className="min-w-0">
          <span className="block font-medium text-foreground">{label}</span>
          <span className="mt-0.5 block text-xs text-tertiary-foreground">
            {description}
          </span>
        </span>
      ) : (
        <span className="text-foreground">{label}</span>
      )}
    </div>
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
