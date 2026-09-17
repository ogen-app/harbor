"use client";

import { useCallback, useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert01Icon } from "@hugeicons/core-free-icons";
import { Toggle } from "@/components/platforms/fields";
import { Loader } from "@/components/ui/loader";
import { cn } from "@/lib/utils";
import type {
  CatalogEntry,
  EntryListResponse,
} from "@/components/tiers-groups/types";

// AudienceCatalog is the live group/tier catalog the picker selects from — the
// same lists /tiers-and-groups manages (TenantAdminService ListGroups/ListTiers,
// reused per CON-300). available is false when the tenant-admin surface is down.
export interface AudienceCatalog {
  tiers: CatalogEntry[];
  groups: CatalogEntry[];
  loading: boolean;
  available: boolean;
}

// useAudienceCatalog fetches the tier + group catalogs once (in parallel) and is
// shared by the picker (for selection) and the stats drawer (to resolve targeted
// ids to names). Both endpoints degrade softly: a down surface yields empty lists
// flagged unavailable.
export function useAudienceCatalog(): AudienceCatalog {
  const [tiers, setTiers] = useState<CatalogEntry[]>([]);
  const [groups, setGroups] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetch("/api/tiers", { signal: controller.signal }).then(
        (r) => r.json() as Promise<EntryListResponse>,
      ),
      fetch("/api/groups", { signal: controller.signal }).then(
        (r) => r.json() as Promise<EntryListResponse>,
      ),
    ])
      .then(([t, g]) => {
        setTiers(t.entries ?? []);
        setGroups(g.entries ?? []);
        setAvailable((t.available ?? false) && (g.available ?? false));
      })
      .catch(() => {
        if (!controller.signal.aborted) setAvailable(false);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  return { tiers, groups, loading, available };
}

interface AudiencePickerProps {
  targetAll: boolean;
  groupIds: string[];
  tierIds: string[];
  onTargetAllChange: (next: boolean) => void;
  onGroupIdsChange: (next: string[]) => void;
  onTierIdsChange: (next: string[]) => void;
}

// AudiencePicker is the "who sees this" control: an "All tenants" toggle, and —
// when off — multi-selects of tenant groups and tiers (a tenant matches when its
// tier is selected OR any of its groups is). It warns when a non-all announcement
// targets neither (reaches nobody), matching CON-300 AC #5.
export function AudiencePicker({
  targetAll,
  groupIds,
  tierIds,
  onTargetAllChange,
  onGroupIdsChange,
  onTierIdsChange,
}: AudiencePickerProps) {
  const { tiers, groups, loading, available } = useAudienceCatalog();

  const toggleId = useCallback(
    (list: string[], id: string, onChange: (next: string[]) => void) => {
      onChange(
        list.includes(id) ? list.filter((x) => x !== id) : [...list, id],
      );
    },
    [],
  );

  const reachesNobody =
    !targetAll && groupIds.length === 0 && tierIds.length === 0;

  return (
    <div className="grid gap-4">
      <Toggle
        checked={targetAll}
        onChange={onTargetAllChange}
        variant="success"
        label="All tenants"
        description="Show this to every active tenant, ignoring the group and tier selections below."
      />

      {!targetAll && (
        <div className="grid gap-4">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-tertiary-foreground">
              <Loader className="size-3.5 border-[1.5px]" />
              Loading groups and tiers…
            </div>
          ) : !available ? (
            <p className="text-xs text-destructive">
              The tenant-admin service is unavailable, so groups and tiers can’t
              be loaded. Target “All tenants”, or try again once it’s back.
            </p>
          ) : (
            <>
              <ChipGroup
                label="Tiers"
                empty="No tiers in the catalog."
                entries={tiers}
                selected={tierIds}
                onToggle={(id) => toggleId(tierIds, id, onTierIdsChange)}
              />
              <ChipGroup
                label="Groups"
                empty="No groups in the catalog."
                entries={groups}
                selected={groupIds}
                onToggle={(id) => toggleId(groupIds, id, onGroupIdsChange)}
              />
            </>
          )}

          {reachesNobody && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-700"
            >
              <HugeiconsIcon
                icon={Alert01Icon}
                className="mt-px size-4 shrink-0"
              />
              <span>
                This announcement targets no groups and no tiers, so it reaches
                nobody. Pick at least one, or switch to “All tenants”.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ChipGroup renders a labelled set of selectable chips (one per catalog entry),
// toggling the entry's id in/out of the selection.
function ChipGroup({
  label,
  empty,
  entries,
  selected,
  onToggle,
}: {
  label: string;
  empty: string;
  entries: CatalogEntry[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
        {label}
      </span>
      {entries.length === 0 ? (
        <p className="text-xs text-tertiary-foreground">{empty}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {entries.map((e) => {
            const on = selected.includes(e.id);
            return (
              <button
                key={e.id}
                type="button"
                aria-pressed={on}
                onClick={() => onToggle(e.id)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  on
                    ? "border-foreground bg-foreground text-primary"
                    : "border-border text-secondary-foreground hover:border-quaternary hover:bg-secondary/50",
                )}
              >
                {e.color && (
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: e.color }}
                    aria-hidden
                  />
                )}
                {e.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
