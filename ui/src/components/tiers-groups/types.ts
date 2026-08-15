// Shape of GET /api/tiers and /api/groups. Mirrors the Go handler's
// entryListResponse + ogentenants.Entry. Tiers and Groups share the same shape
// in Ogen's proto (id/name/color/description/timestamps), so one type and one
// set of CRUD components serve both surfaces.
export interface CatalogEntry {
  id: string;
  name: string;
  // Optional "#RRGGBB" hex, or "" for none. Ogen rejects any other form.
  color: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface EntryListResponse {
  // false when Ogen's tenant-admin gRPC surface is unconfigured/unreachable —
  // the tab renders a soft "unavailable" state rather than an error.
  available: boolean;
  entries: CatalogEntry[];
}

export type EntryKind = "tier" | "group";

// KindConfig parameterizes the shared table/dialog for one surface. apiBase is
// the REST prefix; the id is appended for update/delete.
export interface KindConfig {
  kind: EntryKind;
  apiBase: string;
  singular: string;
  plural: string;
  // One-line explainer shown above the table.
  blurb: string;
}

export const TIER_CONFIG: KindConfig = {
  kind: "tier",
  apiBase: "/api/tiers",
  singular: "Tier",
  plural: "Tiers",
  blurb:
    "Tiers classify tenants by plan or level — each tenant has exactly one. The built-in “default” tier can’t be deleted, and a tier in use must be reassigned before it can be removed.",
};

export const GROUP_CONFIG: KindConfig = {
  kind: "group",
  apiBase: "/api/groups",
  singular: "Group",
  plural: "Groups",
  blurb:
    "Groups are free-form labels for tenants — a tenant can belong to any number of them. Deleting a group removes it from every tenant it was applied to.",
};
