import { cn } from "@/lib/utils";
import type { CatalogEntry } from "@/components/tiers-groups/types";
import type { Announcement, AnnouncementStatus } from "./types";

// Shared presentation helpers for the announcements surfaces (table, stats
// drawer), so the status colours and the audience/window summaries read the same
// everywhere.

const STATUS_STYLES: Record<
  AnnouncementStatus,
  { dot: string; chip: string; label: string }
> = {
  draft: {
    dot: "bg-neutral-400",
    chip: "bg-neutral-400/15 text-tertiary-foreground",
    label: "Draft",
  },
  published: {
    dot: "bg-emerald-500",
    chip: "bg-emerald-500/10 text-emerald-700",
    label: "Published",
  },
  archived: {
    dot: "bg-amber-500",
    chip: "bg-amber-500/10 text-amber-700",
    label: "Archived",
  },
};

// StatusBadge is the color-coded lifecycle label: neutral draft, emerald
// published, amber archived.
export function StatusBadge({ status }: { status: AnnouncementStatus }) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.draft;
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        s.chip,
      )}
    >
      <span className={cn("size-1.5 rounded-full", s.dot)} />
      {s.label}
    </span>
  );
}

// audienceSummary renders the targeting as prose: "All tenants", or the selected
// tier/group names (falling back to counts when the catalog can't resolve a
// name), or "Nobody" for an empty non-all target.
export function audienceSummary(
  a: Announcement,
  tiers: CatalogEntry[],
  groups: CatalogEntry[],
): string {
  if (a.targetAll) return "All tenants";
  const tierIds = a.targetTierIds ?? [];
  const groupIds = a.targetGroupIds ?? [];
  if (tierIds.length === 0 && groupIds.length === 0) return "Nobody";

  const names = (ids: string[], catalog: CatalogEntry[]): string[] => {
    const byId = new Map(catalog.map((e) => [e.id, e.name]));
    return ids.map((id) => byId.get(id) ?? id);
  };
  const parts: string[] = [];
  if (tierIds.length) parts.push(...names(tierIds, tiers));
  if (groupIds.length) parts.push(...names(groupIds, groups));
  return parts.join(", ");
}

// audienceCount is the compact list-cell form: "All tenants", "2 tiers · 1
// group", or "Nobody".
export function audienceCount(a: Announcement): string {
  if (a.targetAll) return "All tenants";
  const t = a.targetTierIds?.length ?? 0;
  const g = a.targetGroupIds?.length ?? 0;
  if (t === 0 && g === 0) return "Nobody";
  const parts: string[] = [];
  if (t) parts.push(`${t} tier${t === 1 ? "" : "s"}`);
  if (g) parts.push(`${g} group${g === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

// safeHref returns the URL only when it parses and uses an http(s) scheme —
// otherwise undefined, so callers never render a `javascript:`/`data:` URI into
// an href (a stored-XSS sink, since CTA/image URLs are operator-authored). Ogen
// and the form validate too; this is the last line of defense at the render site.
export function safeHref(u: string): string | undefined {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function fmt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// formatWindow renders the showing window: "Always" (no bounds), "Until <end>",
// "From <start>", or "<start> → <end>".
export function formatWindow(
  startsAt: string | null,
  endsAt: string | null,
): string {
  if (!startsAt && !endsAt) return "Always";
  if (startsAt && !endsAt) return `From ${fmt(startsAt)}`;
  if (!startsAt && endsAt) return `Until ${fmt(endsAt)}`;
  return `${fmt(startsAt!)} → ${fmt(endsAt!)}`;
}
