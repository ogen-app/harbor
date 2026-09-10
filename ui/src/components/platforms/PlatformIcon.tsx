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

export function platformIcon(zernioId: string): IconSvgElement {
  return PLATFORM_ICONS[zernioId?.trim().toLowerCase()] ?? Globe02Icon;
}

// PlatformIcon renders the brand glyph for a platform's Zernio slug, dimming
// when the platform is disabled so muted rows read as inactive.
export function PlatformIcon({
  zernioId,
  className,
}: {
  zernioId: string;
  className?: string;
}) {
  return (
    <HugeiconsIcon
      icon={platformIcon(zernioId)}
      className={cn("size-5 shrink-0", className)}
    />
  );
}
