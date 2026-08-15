"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Loader } from "@/components/ui/loader";
import {
  PlusIcon,
  DotsThreeOutlineVerticalIcon,
  NotePencilIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { CatalogDialog } from "./CatalogDialog";
import type { CatalogEntry, EntryListResponse, KindConfig } from "./types";

// Shared grid template so the header and every row align — columns:
// name · description · updated · actions. Mirrors the /tenants table layout.
const GRID =
  "grid grid-cols-[minmax(160px,1.4fr)_minmax(0,2.4fr)_minmax(120px,0.8fr)_2.5rem] items-center gap-4";

function relativeTime(iso: string): string {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const secs = Math.max(0, (Date.now() - ms) / 1000);
  if (secs < 60) return "just now";
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  const y = Math.floor(mo / 12);
  return `${y} year${y === 1 ? "" : "s"} ago`;
}

// CatalogTab is the shared tier/group manager, styled to match the /tenants
// "All tenants" table: a rounded card with a title/count header bar and a
// grid-based body with divide-y rows and a per-row actions menu. Parameterized
// by KindConfig so Tiers and Groups reuse the same UI. All data is Ogen's — this
// calls Harbor's /api/tiers|/api/groups, which proxy to Ogen's tenant-admin gRPC.
export function CatalogTab({ config }: { config: KindConfig }) {
  const [data, setData] = useState<EntryListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<"create" | "edit">("create");
  const [dialogEntry, setDialogEntry] = useState<CatalogEntry | undefined>(
    undefined,
  );

  const [deleteTarget, setDeleteTarget] = useState<CatalogEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [toast, setToast] = useState<string | null>(null);

  const kindLower = config.singular.toLowerCase();
  const pluralLower = config.plural.toLowerCase();

  // reload re-fetches the list. setState lives in .then/.catch callbacks (async),
  // matching the codebase's fetch-in-effect pattern.
  const reload = useCallback(
    (signal?: AbortSignal) => {
      return fetch(config.apiBase, { signal })
        .then((r) => {
          if (!r.ok) throw new Error(`Request failed (${r.status})`);
          return r.json() as Promise<EntryListResponse>;
        })
        .then((json) => {
          setData(json);
          setLoadError(null);
        })
        .catch((e: unknown) => {
          if (signal?.aborted) return;
          setLoadError(
            e instanceof Error ? e.message : `Failed to load ${pluralLower}.`,
          );
        })
        .finally(() => {
          if (!signal?.aborted) {
            setLoading(false);
            setRefreshing(false);
          }
        });
    },
    [config.apiBase, pluralLower],
  );

  useEffect(() => {
    const controller = new AbortController();
    reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    reload();
  }, [reload]);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3000);
  }, []);

  const entries = data?.entries ?? [];
  const available = data?.available ?? false;

  const openCreate = () => {
    setDialogMode("create");
    setDialogEntry(undefined);
    setDialogOpen(true);
  };
  const openEdit = (entry: CatalogEntry) => {
    setDialogMode("edit");
    setDialogEntry(entry);
    setDialogOpen(true);
  };

  const handleSaved = (name: string, created: boolean) => {
    flash(`${config.singular} “${name}” ${created ? "created" : "updated"}.`);
    refresh();
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(
        `${config.apiBase}/${encodeURIComponent(deleteTarget.id)}`,
        { method: "DELETE" },
      );
      if (!res.ok && res.status !== 204) {
        const detail = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(detail?.error || `Request failed (${res.status})`);
      }
      flash(`${config.singular} “${deleteTarget.name}” deleted.`);
      setDeleteTarget(null);
      refresh();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Failed to delete.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="rounded-xl bg-primary">
      {/* Header bar — title + blurb + count + create, mirroring the tenants
          table (with an explanatory line under the title). */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">
            All {pluralLower}
          </h2>
          <p className="mt-1 max-w-xl text-xs text-tertiary-foreground">
            {config.blurb}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-4">
          {!loading && available && (
            <span className="flex items-center gap-2 text-xs text-tertiary-foreground">
              {refreshing && <Loader className="size-3.5 border-[1.5px]" />}
              {entries.length} total
            </span>
          )}
          <Button size="sm" onClick={openCreate} disabled={loading}>
            <PlusIcon className="size-4" weight="bold" />
            New {kindLower}
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-b-xl">
        {loading ? (
          <SkeletonRows />
        ) : loadError ? (
          <p className="p-6 text-sm text-tertiary-foreground">{loadError}</p>
        ) : !available ? (
          <p className="p-6 text-sm text-tertiary-foreground">
            {config.plural} unavailable — the tenant-admin service isn’t
            reachable. Check that Ogen is running and that Harbor’s{" "}
            <code className="font-mono">OGEN_GRPC_ADDR</code> /{" "}
            <code className="font-mono">OGEN_GRPC_TOKEN</code> are configured.
          </p>
        ) : entries.length === 0 ? (
          <p className="p-6 text-sm text-tertiary-foreground">
            No {pluralLower} yet — create the first one.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {/* header */}
            <div className={`${GRID} px-6 py-2.5`}>
              <HeaderCell label="Name" />
              <HeaderCell label="Description" />
              <HeaderCell label="Updated" />
              <span className="sr-only">Actions</span>
            </div>

            {/* rows */}
            {entries.map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                onEdit={() => openEdit(entry)}
                onDelete={() => {
                  setDeleteError(null);
                  setDeleteTarget(entry);
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Transient success toast */}
      {toast && (
        <div
          role="status"
          className="fixed bottom-6 right-6 z-[200] rounded-md border border-border bg-primary px-4 py-2 text-sm text-foreground shadow-xl"
        >
          {toast}
        </div>
      )}

      {/* Add / edit */}
      <CatalogDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        mode={dialogMode}
        config={config}
        entry={dialogEntry}
        onSaved={handleSaved}
      />

      {/* Delete confirmation */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {kindLower}</DialogTitle>
            <DialogDescription>
              Delete{" "}
              <span className="font-medium text-foreground">
                {deleteTarget?.name}
              </span>
              ?{" "}
              {config.kind === "tier"
                ? "A tier still assigned to a tenant can’t be deleted — reassign those tenants first."
                : "It will be removed from every tenant it was applied to."}
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p className="text-sm text-destructive" role="alert">
              {deleteError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructiveInverted"
              onClick={confirmDelete}
              disabled={deleting}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function HeaderCell({ label }: { label: string }) {
  return (
    <span className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
      {label}
    </span>
  );
}

function EntryRow({
  entry,
  onEdit,
  onDelete,
}: {
  entry: CatalogEntry;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const hasColor = /^#[0-9a-fA-F]{6}$/.test(entry.color);
  return (
    <div
      className={cn(
        `${GRID} px-6 py-3.5 text-sm transition-colors hover:bg-secondary/40`,
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 rounded-full border",
            hasColor ? "border-black/10" : "border-quaternary",
          )}
          style={hasColor ? { backgroundColor: entry.color } : undefined}
        />
        <span className="truncate font-medium text-foreground">
          {entry.name}
        </span>
      </span>
      <span className="truncate text-secondary-foreground">
        {entry.description || (
          <span className="text-tertiary-foreground">—</span>
        )}
      </span>
      <span className="text-secondary-foreground">
        {relativeTime(entry.updatedAt)}
      </span>
      <EntryActions
        name={entry.name}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    </div>
  );
}

// EntryActions is the per-row "⋮" menu, matching the tenants table's ActionsMenu.
function EntryActions({
  name,
  onEdit,
  onDelete,
}: {
  name: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="smIcon"
          aria-label={`Actions for ${name}`}
          className="justify-self-end text-tertiary-foreground data-[state=open]:border-quaternary data-[state=open]:bg-quaternary data-[state=open]:text-primary-foreground"
        >
          <DotsThreeOutlineVerticalIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="end"
        sideOffset={6}
        className="min-w-40 rounded-none border border-border py-1 shadow-xl"
      >
        <DropdownMenuItem className="gap-3 px-4 py-2.5" onClick={onEdit}>
          <NotePencilIcon className="size-4" />
          Edit
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-1 h-px bg-border" />
        <DropdownMenuItem
          variant="destructive"
          className="gap-3 px-4 py-2.5"
          onClick={onDelete}
        >
          <TrashIcon className="size-4" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SkeletonRows() {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className={`${GRID} px-6 py-3.5`}>
          <div className="flex items-center gap-2.5">
            <div className="size-3.5 animate-pulse rounded-full bg-secondary" />
            <div className="h-3 w-24 animate-pulse rounded bg-secondary" />
          </div>
          <div className="h-3 w-48 animate-pulse rounded bg-secondary" />
          <div className="h-3 w-20 animate-pulse rounded bg-secondary" />
          <div className="size-7 animate-pulse rounded bg-secondary justify-self-end" />
        </div>
      ))}
    </div>
  );
}
