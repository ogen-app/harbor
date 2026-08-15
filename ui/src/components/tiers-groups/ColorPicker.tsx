"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react";

// A curated default palette: eight hues, a bold row and a pastel row, matching
// the reference design. Every value is a 6-digit "#RRGGBB" hex — the only form
// Ogen accepts (besides "" = none).
const DEFAULT_COLORS: string[] = [
  // bold
  "#a4262c",
  "#d83b01",
  "#eaa300",
  "#107c10",
  "#038387",
  "#0078d4",
  "#004e8c",
  "#5c2d91",
  // pastel
  "#e6a9ad",
  "#f1b393",
  "#f7e1a0",
  "#a7d8a7",
  "#a3d3d5",
  "#a9d3f2",
  "#9fb6d4",
  "#c6acde",
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function isValidColor(value: string): boolean {
  return value === "" || HEX_RE.test(value);
}

// readableOn returns black or white — whichever reads better on the given hex
// background — so the icon on a swatch stays legible across the palette.
function readableOn(hex: string): string {
  if (!HEX_RE.test(hex)) return "#111827";
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Perceived luminance (sRGB weights).
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#111827" : "#ffffff";
}

interface ColorPickerProps {
  value: string;
  onChange: (value: string) => void;
  id?: string;
}

// ColorPicker mirrors the reference control: a colored square (the palette
// trigger) beside a free-text hex input, with a "Choose from default colors"
// panel of swatches. The value is a "#RRGGBB" hex string or "" (none).
//
// The panel is rendered INLINE (not portaled). Radix's Popover portals to
// <body>, which sits under a modal Dialog's pointer-events lockout, so its
// swatches aren't clickable inside our add/edit dialog — an inline panel avoids
// that entirely and anchors the swatches directly under the trigger.
export function ColorPicker({ value, onChange, id }: ColorPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const valid = isValidColor(value);
  const hasColor = value !== "" && HEX_RE.test(value);

  // Close on outside click / Escape while open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (hex: string) => {
    onChange(hex);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="flex items-center gap-2">
      <div className="relative">
        <button
          type="button"
          aria-label="Choose color"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-md border border-border outline-none transition-shadow",
            "focus-visible:ring-2 focus-visible:ring-ring",
            !hasColor && "bg-secondary",
          )}
          style={hasColor ? { backgroundColor: value } : undefined}
        >
          <ArrowsClockwiseIcon
            className="size-4"
            weight="bold"
            style={{ color: hasColor ? readableOn(value) : "#6b7280" }}
          />
        </button>

        {open && (
          <div className="absolute left-0 top-full z-50 mt-2 w-max rounded-lg border border-border bg-primary p-4 text-sm text-foreground shadow-xl">
            <p className="mb-3 font-medium text-foreground">
              Choose from default colors
            </p>
            <div className="grid grid-cols-8 gap-2">
              {DEFAULT_COLORS.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  aria-label={hex}
                  title={hex}
                  onClick={() => pick(hex)}
                  className={cn(
                    "size-7 rounded-md outline-none transition-transform hover:scale-110",
                    "focus-visible:ring-2 focus-visible:ring-ring",
                    value.toLowerCase() === hex &&
                      "ring-2 ring-foreground ring-offset-2 ring-offset-background",
                  )}
                  style={{ backgroundColor: hex }}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={() => pick("")}
              className="mt-3 text-xs text-tertiary-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              No color
            </button>
          </div>
        )}
      </div>

      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="#RRGGBB"
        spellCheck={false}
        autoComplete="off"
        aria-invalid={!valid}
        className="font-mono"
      />
    </div>
  );
}
