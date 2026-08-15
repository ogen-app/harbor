// Shared color helpers for the tier/group classification chips and the color
// picker. Kept in one place so the hex validation and contrast logic don't drift
// between shared.tsx (chips) and ColorPicker.tsx (the picker).

// A 6-digit "#RRGGBB" hex — the only color form Ogen accepts (besides "" = none).
export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: string): boolean {
  return HEX_RE.test(value);
}

// readableOn returns black or white — whichever reads better on the given hex
// background — so text/icons on a swatch stay legible across the palette.
export function readableOn(hex: string): string {
  if (!HEX_RE.test(hex)) return "#111827";
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Perceived luminance (sRGB weights).
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#111827" : "#ffffff";
}
