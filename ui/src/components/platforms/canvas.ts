import type { Canvas, VideoConstraints } from "./types";

// Post types whose publish rule takes an image or a video, so a canvas can be
// set for them. Mirrors Ogen's postTypeRules (src/domain/platforms/
// post_types.go, TakesArtwork); Ogen rejects a canvas on any other slug.
export const ARTWORK_POST_TYPES = new Set([
  "image-post",
  "carousel",
  "video",
  "reel",
  "short",
  "story",
]);

// Post types that take only video; their canvas is checked against the
// platform's video limits.
const VIDEO_POST_TYPES = new Set(["video", "reel", "short"]);

// Ogen's ceiling for each side (MaxCanvasSide).
export const MAX_CANVAS_SIDE = 8192;

export const CANVAS_PRESETS: { canvas: Canvas; label: string }[] = [
  { canvas: { width: 1080, height: 1080 }, label: "Square" },
  { canvas: { width: 1080, height: 1350 }, label: "Portrait" },
  { canvas: { width: 1080, height: 1920 }, label: "Vertical" },
  { canvas: { width: 1920, height: 1080 }, label: "Landscape" },
  { canvas: { width: 1200, height: 627 }, label: "Link image" },
  { canvas: { width: 1000, height: 1500 }, label: "Pin" },
];

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

// ratioLabel names a size's aspect ratio the way the video limits spell them
// ("4:5", "9:16"), falling back to a decimal ("1.91:1") when the reduced
// ratio has unwieldy terms. It is for display only; aspectRatioAllowed does
// the matching.
export function ratioLabel(width: number, height: number): string | null {
  if (!(width > 0 && height > 0)) return null;
  const g = gcd(width, height);
  const [a, b] = [width / g, height / g];
  if (a <= 21 && b <= 21) return `${a}:${b}`;
  // Number() drops trailing zeros: 1.90 -> "1.9", 1.00 -> "1".
  const trim = (n: number) => String(Number(n.toFixed(2)));
  return width >= height
    ? `${trim(width / height)}:1`
    : `1:${trim(height / width)}`;
}

// aspectRatioAllowed reports whether width×height is within 2% of one of the
// allowed "a:b" ratios. It mirrors Ogen's publish gate (aspectRatioAllowed in
// src/domain/platforms/validate.go), so the hint fires exactly when a video
// at this size would be rejected.
export function aspectRatioAllowed(
  width: number,
  height: number,
  allowed: string[],
): boolean {
  const tolerance = 0.02;
  const actual = width / height;
  return allowed.some((r) => {
    const [a, b] = r.split(":").map((s) => Number(s.trim()));
    if (!(Number.isInteger(a) && Number.isInteger(b) && a > 0 && b > 0))
      return false;
    const want = a / b;
    return Math.abs(actual - want) / want <= tolerance;
  });
}

// A canvas as typed in the form: both sides empty means no recommendation.
// The text is kept as typed, so a pasted "-100" or "192.5" is reported rather
// than quietly turned into a different size.
export interface CanvasDraft {
  width: string;
  height: string;
}

export const draftOf = (c?: Canvas): CanvasDraft => ({
  width: c ? String(c.width) : "",
  height: c ? String(c.height) : "",
});

// parseSide returns a side typed as plain digits, or null for anything else
// (a sign, a decimal point, an exponent, other characters).
function parseSide(s: string): number | null {
  const t = s.trim();
  return /^\d+$/.test(t) ? Number(t) : null;
}

const dimLabel = (v: number) => (v > 0 ? String(v) : "∞");

export type CanvasIssue = { level: "error" | "warning"; message: string };

// checkCanvas returns what's wrong with a draft, if anything. Errors are the
// ones Ogen rejects with InvalidArgument and block Save; a warning is advice.
export function checkCanvas(
  slug: string,
  d: CanvasDraft,
  video: VideoConstraints | null,
): CanvasIssue | null {
  const hasW = d.width.trim() !== "";
  const hasH = d.height.trim() !== "";
  if (hasW !== hasH)
    return { level: "error", message: "Enter both width and height, or clear both." };
  if (!hasW) return null;
  const w = parseSide(d.width);
  const h = parseSide(d.height);
  if (w === null || h === null || w <= 0 || h <= 0)
    return { level: "error", message: "Width and height must be whole numbers above 0." };
  if (w > MAX_CANVAS_SIDE || h > MAX_CANVAS_SIDE)
    return { level: "error", message: `Each side can be at most ${MAX_CANVAS_SIDE} px.` };
  if (VIDEO_POST_TYPES.has(slug) && video) {
    const ratios = video.allowedAspectRatios ?? [];
    if (ratios.length > 0 && !aspectRatioAllowed(w, h, ratios))
      return {
        level: "warning",
        message: `${ratioLabel(w, h)} is not in this platform's video aspect ratios (${ratios.join(", ")}).`,
      };
    if ((video.maxWidth > 0 && w > video.maxWidth) || (video.maxHeight > 0 && h > video.maxHeight))
      return {
        level: "warning",
        message: `Larger than the video max resolution (${dimLabel(video.maxWidth)} × ${dimLabel(video.maxHeight)}).`,
      };
  }
  return null;
}

// toCanvas turns a valid, filled draft into a Canvas; anything else is null.
export function toCanvas(d: CanvasDraft): Canvas | null {
  const w = parseSide(d.width);
  const h = parseSide(d.height);
  return w !== null && h !== null && w > 0 && h > 0
    ? { width: w, height: h }
    : null;
}
