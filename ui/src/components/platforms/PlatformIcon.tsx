import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  NewTwitterIcon,
  Linkedin01Icon,
  Facebook01Icon,
  InstagramIcon,
  ThreadsIcon,
  YoutubeIcon,
  TiktokIcon,
  PinterestIcon,
  RedditIcon,
  Globe02Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";

// Brand icons keyed by Ogen's Zernio wire slug (the `zernio_id` on each
// platform). Ogen owns the catalog, so an unknown slug is expected (a
// newly-added platform whose brand we don't ship an icon for) and falls back to
// a neutral globe rather than breaking the row. Aliases cover the couple of
// slugs that travel under more than one name (X ↔ twitter).
const PLATFORM_ICONS: Record<string, IconSvgElement> = {
  twitter: NewTwitterIcon,
  x: NewTwitterIcon,
  linkedin: Linkedin01Icon,
  facebook: Facebook01Icon,
  instagram: InstagramIcon,
  threads: ThreadsIcon,
  youtube: YoutubeIcon,
  tiktok: TiktokIcon,
  pinterest: PinterestIcon,
  reddit: RedditIcon,
};

// Each brand's primary color, so the icon reads as the platform at a glance.
// Unknown slugs use the neutral fallback (no entry → inherits currentColor).
const PLATFORM_COLORS: Record<string, string> = {
  twitter: "#000000",
  x: "#000000",
  linkedin: "#0A66C2",
  facebook: "#1877F2",
  instagram: "#E4405F",
  threads: "#000000",
  youtube: "#FF0000",
  tiktok: "#000000",
  pinterest: "#BD081C",
  reddit: "#FF4500",
};

function slugKey(zernioId: string): string {
  return zernioId?.trim().toLowerCase() ?? "";
}

// Object.hasOwn guards the lookups so a slug that collides with an inherited
// Object.prototype key (constructor, toString, valueOf, …) falls back to the
// neutral defaults instead of returning a prototype method.
export function platformIcon(zernioId: string): IconSvgElement {
  const key = slugKey(zernioId);
  return Object.hasOwn(PLATFORM_ICONS, key) ? PLATFORM_ICONS[key] : Globe02Icon;
}

// PlatformIcon renders the brand glyph for a platform's Zernio slug, tinted with
// the brand color. className still controls size / a fallback color for unknown
// slugs (the brand color, when known, wins via inline style).
export function PlatformIcon({
  zernioId,
  className,
}: {
  zernioId: string;
  className?: string;
}) {
  const key = slugKey(zernioId);
  const color = Object.hasOwn(PLATFORM_COLORS, key)
    ? PLATFORM_COLORS[key]
    : undefined;
  return (
    <HugeiconsIcon
      icon={platformIcon(zernioId)}
      className={cn("size-5 shrink-0", className)}
      style={color ? { color } : undefined}
    />
  );
}
