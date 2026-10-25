"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CatalogEntry,
  EntryListResponse,
} from "@/components/tiers-groups/types";
import type { MatrixResponse } from "@/components/tier-entitlements/types";

// An invitable tier: any tier whose latest published (active) version exists —
// purchasable or not (CON-333 §6.4 "any tier"). A tier with no active version is
// listed but not offered (Ogen would refuse it with tier_not_active).
export interface InviteTier {
  id: string;
  name: string;
  color: string;
  active: boolean; // has a published version
  purchasable: boolean; // that version is sold; false = hidden ("Not sold")
}

export interface InviteCatalog {
  tiers: InviteTier[];
  groups: CatalogEntry[];
  loading: boolean;
  available: boolean;
  // createGroup adds a group (CreateGroup) and appends it to the catalog.
  createGroup: (name: string) => Promise<CatalogEntry>;
}

// useInviteCatalog loads the tier catalog with its versions (one
// /api/tier-entitlements read — no per-tier fan-out) and the group catalog.
export function useInviteCatalog(): InviteCatalog {
  const [tiers, setTiers] = useState<InviteTier[]>([]);
  const [groups, setGroups] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetch("/api/tier-entitlements", { signal: controller.signal }).then(
        (r) => r.json() as Promise<MatrixResponse>,
      ),
      fetch("/api/groups", { signal: controller.signal }).then(
        (r) => r.json() as Promise<EntryListResponse>,
      ),
    ])
      .then(([m, g]) => {
        setTiers(
          (m.tiers ?? []).map((t) => {
            // The live version is the (single) active one.
            const v = (t.versions ?? []).find((x) => x.status === "active");
            return {
              id: t.tierId,
              name: t.tierName,
              color: t.tierColor,
              active: !!v,
              purchasable: v?.purchasable ?? false,
            };
          }),
        );
        setGroups(g.entries ?? []);
        setAvailable((m.available ?? false) && (g.available ?? false));
      })
      .catch(() => {
        if (!controller.signal.aborted) setAvailable(false);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  // createGroup is single-flight per (trimmed, case-insensitive) name, so a
  // double-click on a cohort preset or a repeated Enter in "New group" can't
  // create the same group twice.
  const inflight = useRef(new Map<string, Promise<CatalogEntry>>());
  const createGroup = useCallback((name: string) => {
    const key = name.trim().toLowerCase();
    const pending = inflight.current.get(key);
    if (pending) return pending;
    const p = postGroup(name.trim(), (entry) =>
      setGroups((gs) => [...gs, entry]),
    ).finally(() => inflight.current.delete(key));
    inflight.current.set(key, p);
    return p;
  }, []);

  return { tiers, groups, loading, available, createGroup };
}

// postGroup creates a group (CreateGroup) and hands the entry to onCreated.
async function postGroup(
  name: string,
  onCreated: (entry: CatalogEntry) => void,
): Promise<CatalogEntry> {
  const res = await fetch("/api/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, color: "", description: "" }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error || `Couldn’t create the group (${res.status})`);
  }
  const entry = (await res.json()) as CatalogEntry;
  onCreated(entry);
  return entry;
}
