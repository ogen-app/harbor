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
// ratio has unwieldy terms.
export function ratioLabel(width: number, height: number): string | null {
  if (!(width > 0 && height > 0)) return null;
  const g = gcd(width, height);
  const [a, b] = [width / g, height / g];
  if (a <= 21 && b <= 21) return `${a}:${b}`;
  const trim = (n: number) => n.toFixed(2).replace(/\.?0+$/, "");
  return width >= height
    ? `${trim(width / height)}:1`
    : `1:${trim(height / width)}`;
}

// A canvas as typed in the form: both sides empty means no recommendation.
export interface CanvasDraft {
  width: string;
  height: string;
}

export const draftOf = (c?: Canvas): CanvasDraft => ({
  width: c ? String(c.width) : "",
  height: c ? String(c.height) : "",
});

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
  const w = Number(d.width);
  const h = Number(d.height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0)
    return { level: "error", message: "Width and height must be whole numbers above 0." };
  if (w > MAX_CANVAS_SIDE || h > MAX_CANVAS_SIDE)
    return { level: "error", message: `Each side can be at most ${MAX_CANVAS_SIDE} px.` };
  if (VIDEO_POST_TYPES.has(slug) && video) {
    const ratios = video.allowedAspectRatios ?? [];
    const r = ratioLabel(w, h);
    if (ratios.length > 0 && r && !ratios.includes(r))
      return {
        level: "warning",
        message: `${r} is not in this platform's video aspect ratios (${ratios.join(", ")}).`,
      };
    if ((video.maxWidth > 0 && w > video.maxWidth) || (video.maxHeight > 0 && h > video.maxHeight))
      return {
        level: "warning",
        message: `Larger than the video max resolution (${video.maxWidth} × ${video.maxHeight}).`,
      };
  }
  return null;
}

// toCanvas turns a valid, filled draft into a Canvas; anything else is null.
export function toCanvas(d: CanvasDraft): Canvas | null {
  const w = Number(d.width);
  const h = Number(d.height);
  if (d.width.trim() === "" || d.height.trim() === "") return null;
  return Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0
    ? { width: w, height: h }
    : null;
}
