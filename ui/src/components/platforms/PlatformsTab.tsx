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
  DotsSixVerticalIcon,
  NotePencilIcon,
  TrashIcon,
  SlidersHorizontalIcon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { PlatformIcon } from "./PlatformIcon";
import { PlatformDialog } from "./PlatformDialog";
import { GlobalLimitsDialog } from "./GlobalLimitsDialog";
import { Toggle } from "./fields";
import type { Platform, PlatformsListResponse } from "./types";

// Shared grid template so the header and every row align — columns:
// drag · platform · slug · post types · accounts · scheduled · status · actions.
const GRID =
  "grid grid-cols-[1.75rem_minmax(170px,2fr)_minmax(100px,1fr)_5rem_5rem_5rem_7.5rem_2.25rem] items-center gap-3";

function bySortOrder(a: Platform, b: Platform): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.name.localeCompare(b.name);
}

function postTypeCount(p: Platform): number {
  return Object.keys(p.postTypes ?? {}).length;
}

// PlatformsTab is the social-platform catalog manager, styled to match the
// /secrets + /tenants "All X" table. It fetches include_disabled=true so
// disabled platforms show (muted) and can be toggled on. Supports add/edit
// (whole-resource form), enable/disable (usage-aware confirm), delete (with
// force), the global-limits panel, and drag-to-reorder (persisted as sort_order
// via whole-resource updates). All state is Ogen's, via /api/platforms.
export function PlatformsTab() {
  const [data, setData] = useState<PlatformsListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [savingOrder, setSavingOrder] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<"create" | "edit">("create");
  const [dialogPlatform, setDialogPlatform] = useState<Platform | undefined>(
    undefined,
  );
  const [limitsOpen, setLimitsOpen] = useState(false);

  const [enableTarget, setEnableTarget] = useState<{
    platform: Platform;
    next: boolean;
  } | null>(null);
  const [enableBusy, setEnableBusy] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<Platform | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteBlocked, setDeleteBlocked] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const [toast, setToast] = useState<string | null>(null);

  const reload = useCallback((signal?: AbortSignal) => {
    return fetch("/api/platforms", { signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        return r.json() as Promise<PlatformsListResponse>;
      })
      .then((json) => {
        setData(json);
        setLoadError(null);
      })
      .catch((e: unknown) => {
        if (signal?.aborted) return;
        setLoadError(
          e instanceof Error ? e.message : "Failed to load platforms.",
        );
      })
      .finally(() => {
        if (!signal?.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      });
  }, []);

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

  const available = data?.available ?? false;
  const platforms = [...(data?.platforms ?? [])].sort(bySortOrder);
  const enabledCount = platforms.filter((p) => p.enabled).length;

  const openCreate = () => {
    setDialogMode("create");
    setDialogPlatform(undefined);
    setDialogOpen(true);
  };
  const openEdit = (p: Platform) => {
    setDialogMode("edit");
    setDialogPlatform(p);
    setDialogOpen(true);
  };

  const handleSaved = (name: string, created: boolean) => {
    flash(`Platform “${name}” ${created ? "created" : "updated"}.`);
    refresh();
  };

  // ── enable / disable ──────────────────────────────────────────────────────
  const confirmEnable = async () => {
    if (!enableTarget) return;
    setEnableBusy(true);
    setEnableError(null);
    try {
      const res = await fetch(
        `/api/platforms/${encodeURIComponent(enableTarget.platform.id)}/enabled`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: enableTarget.next }),
        },
      );
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(detail?.error || `Request failed (${res.status})`);
      }
      flash(
        `Platform “${enableTarget.platform.name}” ${enableTarget.next ? "enabled" : "disabled"}.`,
      );
      setEnableTarget(null);
      refresh();
    } catch (e) {
      setEnableError(e instanceof Error ? e.message : "Failed to update.");
    } finally {
      setEnableBusy(false);
    }
  };

  // ── delete ────────────────────────────────────────────────────────────────
  const openDelete = (p: Platform) => {
    setDeleteError(null);
    setDeleteBlocked(false);
    setDeleteTarget(p);
  };
  const confirmDelete = async (force: boolean) => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const res = await fetch(
        `/api/platforms/${encodeURIComponent(deleteTarget.id)}${force ? "?force=true" : ""}`,
        { method: "DELETE" },
      );
      if (res.ok || res.status === 204) {
        flash(`Platform “${deleteTarget.name}” deleted.`);
        setDeleteTarget(null);
        refresh();
        return;
      }
      const detail = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      const msg = detail?.error || `Request failed (${res.status})`;
      // 409 FailedPrecondition (in use) without force → offer force.
      if (res.status === 409 && !force) {
        setDeleteBlocked(true);
        setDeleteError(msg);
      } else {
        setDeleteError(msg);
      }
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Failed to delete.");
    } finally {
      setDeleteBusy(false);
    }
  };

  // ── reorder ───────────────────────────────────────────────────────────────
  // On drop, splice the dragged row into the target slot, renumber sort_order
  // densely, optimistically reflect it, then persist each changed platform with
  // a whole-resource update (Ogen has no partial update / reorder RPC).
  const persistReorder = useCallback(
    async (source: number, target: number) => {
      if (source === target) return;
      const current = [...(data?.platforms ?? [])].sort(bySortOrder);
      const next = [...current];
      const [moved] = next.splice(source, 1);
      next.splice(target, 0, moved);

      const updates: Platform[] = [];
      const renumbered = next.map((p, i) => {
        if (p.sortOrder !== i) updates.push({ ...p, sortOrder: i });
        return { ...p, sortOrder: i };
      });
      if (updates.length === 0) return;

      setData((d) => (d ? { ...d, platforms: renumbered } : d));
      setSavingOrder(true);
      try {
        const results = await Promise.all(
          updates.map((p) =>
            fetch(`/api/platforms/${encodeURIComponent(p.id)}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(p),
            }),
          ),
        );
        if (results.some((r) => !r.ok)) {
          flash("Couldn’t save the new order — reverting.");
        }
      } catch {
        flash("Couldn’t save the new order — reverting.");
      } finally {
        setSavingOrder(false);
        refresh(); // resync to server truth either way
      }
    },
    [data, flash, refresh],
  );

  const handleDrop = (target: number) => {
    const source = dragIndex;
    setDragIndex(null);
    setOverIndex(null);
    if (source !== null) void persistReorder(source, target);
  };

  return (
    <div className="rounded-xl bg-primary">
      {/* Header bar */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">All platforms</h2>
          <p className="mt-1 max-w-xl text-xs text-tertiary-foreground">
            The social platforms Ogen can publish to, with their per-platform
            media and text limits. Disabled platforms are shown muted. Drag the
            handle to reorder.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {!loading && available && (
            <span className="flex items-center gap-2 text-xs text-tertiary-foreground">
              {(refreshing || savingOrder) && (
                <Loader className="size-3.5 border-[1.5px]" />
              )}
              {savingOrder ? "Saving order…" : `${enabledCount} of ${platforms.length} enabled`}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLimitsOpen(true)}
            disabled={loading || !available}
          >
            <SlidersHorizontalIcon className="size-4" />
            Global limits
          </Button>
          <Button size="sm" onClick={openCreate} disabled={loading || !available}>
            <PlusIcon className="size-4" weight="bold" />
            Add platform
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-b-xl">
        {loading ? (
          <SkeletonRows />
        ) : loadError ? (
          <p className="p-6 text-sm text-destructive">{loadError}</p>
        ) : !available ? (
          <p className="p-6 text-sm text-tertiary-foreground">
            The platform-admin service is unavailable. Check that Ogen is running
            and that Harbor’s <code className="font-mono">OGEN_GRPC_ADDR</code> /{" "}
            <code className="font-mono">OGEN_GRPC_TOKEN</code> are configured.
          </p>
        ) : platforms.length === 0 ? (
          <p className="p-6 text-sm text-tertiary-foreground">
            No platforms in the catalog yet — add the first one.
          </p>
        ) : (
          <div className="divide-y divide-border">
            <div className={`${GRID} px-6 py-2.5`}>
              <span className="sr-only">Reorder</span>
              <HeaderCell label="Platform" />
              <HeaderCell label="Zernio slug" />
              <HeaderCell label="Post types" />
              <HeaderCell label="Accounts" />
              <HeaderCell label="Scheduled" />
              <HeaderCell label="Status" />
              <span className="sr-only">Actions</span>
            </div>

            {platforms.map((p, i) => (
              <PlatformRow
                key={p.id || p.zernioId}
                platform={p}
                index={i}
                isOver={overIndex === i && dragIndex !== null && dragIndex !== i}
                onDragStartHandle={(e) => {
                  setDragIndex(i);
                  const row = (e.currentTarget as HTMLElement).closest(
                    "[data-platform-row]",
                  );
                  if (row) e.dataTransfer.setDragImage(row as Element, 12, 12);
                  e.dataTransfer.effectAllowed = "move";
                  // Firefox won't start a drag unless some data is set.
                  e.dataTransfer.setData("text/plain", platforms[i].id);
                }}
                onDragOver={(e) => {
                  if (dragIndex === null) return;
                  e.preventDefault();
                  setOverIndex(i);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDrop(i);
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setOverIndex(null);
                }}
                onToggle={() =>
                  setEnableTarget({ platform: p, next: !p.enabled })
                }
                onEdit={() => openEdit(p)}
                onDelete={() => openDelete(p)}
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
      <PlatformDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        mode={dialogMode}
        platform={dialogPlatform}
        onSaved={handleSaved}
      />

      {/* Global limits */}
      <GlobalLimitsDialog
        open={limitsOpen}
        onOpenChange={setLimitsOpen}
        onSaved={() => flash("Global limits saved.")}
      />

      {/* Enable / disable confirmation */}
      <Dialog
        open={enableTarget !== null}
        onOpenChange={(o) => {
          if (!o) {
            setEnableTarget(null);
            setEnableError(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          {enableTarget && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {enableTarget.next ? "Enable" : "Disable"}{" "}
                  {enableTarget.platform.name}?
                </DialogTitle>
                <DialogDescription>
                  {enableTarget.next
                    ? "New accounts can connect and it appears in the tenant composer."
                    : "Soft-disable: existing scheduled posts still run, but new connects are blocked and it drops from the tenant composer."}
                </DialogDescription>
              </DialogHeader>
              <UsageSummary platform={enableTarget.platform} />
              {enableError && (
                <p className="text-sm text-destructive" role="alert">
                  {enableError}
                </p>
              )}
              <DialogFooter>
                <Button
                  variant="ghost"
                  onClick={() => setEnableTarget(null)}
                  disabled={enableBusy}
                >
                  Cancel
                </Button>
                <Button onClick={confirmEnable} disabled={enableBusy}>
                  {enableBusy
                    ? "Saving…"
                    : enableTarget.next
                      ? "Enable"
                      : "Disable"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation (with force on in-use) */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          {deleteTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Delete {deleteTarget.name}?</DialogTitle>
                <DialogDescription>
                  {deleteBlocked
                    ? "This platform is in use. Force-deleting removes it anyway — connected accounts and scheduled posts are affected. Consider disabling it instead."
                    : "This removes the platform from the catalog. If it’s in use you’ll be offered a force option."}
                </DialogDescription>
              </DialogHeader>
              <UsageSummary platform={deleteTarget} />
              {deleteError && (
                <p className="text-sm text-destructive" role="alert">
                  {deleteError}
                </p>
              )}
              <DialogFooter>
                <Button
                  variant="ghost"
                  onClick={() => setDeleteTarget(null)}
                  disabled={deleteBusy}
                >
                  Cancel
                </Button>
                {deleteBlocked ? (
                  <Button
                    variant="destructiveInverted"
                    onClick={() => confirmDelete(true)}
                    disabled={deleteBusy}
                  >
                    {deleteBusy ? "Deleting…" : "Force delete"}
                  </Button>
                ) : (
                  <Button
                    variant="destructiveInverted"
                    onClick={() => confirmDelete(false)}
                    disabled={deleteBusy}
                  >
                    {deleteBusy ? "Deleting…" : "Delete"}
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
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

// UsageSummary shows the connected-accounts / scheduled-posts footprint that
// drives the enable/disable and delete guards.
function UsageSummary({ platform }: { platform: Platform }) {
  return (
    <div className="flex gap-6 rounded-md border border-border bg-secondary/30 px-4 py-3 text-sm">
      <div>
        <div className="text-lg font-medium tabular-nums text-foreground">
          {platform.usage.connectedAccounts}
        </div>
        <div className="text-xs text-tertiary-foreground">
          connected accounts
        </div>
      </div>
      <div>
        <div className="text-lg font-medium tabular-nums text-foreground">
          {platform.usage.scheduledPosts}
        </div>
        <div className="text-xs text-tertiary-foreground">scheduled posts</div>
      </div>
    </div>
  );
}

function PlatformRow({
  platform,
  index,
  isOver,
  onDragStartHandle,
  onDragOver,
  onDrop,
  onDragEnd,
  onToggle,
  onEdit,
  onDelete,
}: {
  platform: Platform;
  index: number;
  isOver: boolean;
  onDragStartHandle: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const types = postTypeCount(platform);
  const typeLabels = Object.values(platform.postTypes ?? {}).join(", ");
  return (
    <div
      data-platform-row
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={cn(
        `${GRID} px-6 py-3.5 text-sm transition-colors hover:bg-secondary/40`,
        !platform.enabled && "opacity-55",
        isOver && "border-t-2 border-foreground",
      )}
    >
      {/* Drag handle (the drag source) */}
      <button
        type="button"
        draggable
        onDragStart={onDragStartHandle}
        aria-label={`Drag to reorder ${platform.name}`}
        className="flex cursor-grab items-center justify-center text-quaternary hover:text-secondary-foreground active:cursor-grabbing"
      >
        <DotsSixVerticalIcon className="size-4" />
      </button>

      {/* Platform name + brand icon */}
      <span className="flex min-w-0 items-center gap-2.5">
        <PlatformIcon
          zernioId={platform.zernioId}
          className="text-secondary-foreground"
        />
        <span className="truncate font-medium text-foreground">
          {platform.name}
        </span>
      </span>

      {/* Zernio slug */}
      <span className="truncate font-mono text-xs text-secondary-foreground">
        {platform.zernioId || <span className="text-tertiary-foreground">—</span>}
      </span>

      {/* Post-type count (labels on hover) */}
      <span
        className="text-secondary-foreground tabular-nums"
        title={typeLabels || undefined}
      >
        {types}
      </span>

      {/* Connected accounts */}
      <span className="text-secondary-foreground tabular-nums">
        {platform.usage.connectedAccounts}
      </span>

      {/* Scheduled posts */}
      <span className="text-secondary-foreground tabular-nums">
        {platform.usage.scheduledPosts}
      </span>

      {/* Enabled toggle → opens the usage-aware confirm dialog */}
      <Toggle
        checked={platform.enabled}
        onChange={onToggle}
        label={platform.enabled ? "Enabled" : "Disabled"}
      />

      {/* Actions */}
      <PlatformActions name={platform.name} onEdit={onEdit} onDelete={onDelete} />
    </div>
  );
}

function PlatformActions({
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
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className={`${GRID} px-6 py-3.5`}>
          <div className="size-4 animate-pulse rounded bg-secondary" />
          <div className="flex items-center gap-2.5">
            <div className="size-5 animate-pulse rounded bg-secondary" />
            <div className="h-3 w-28 animate-pulse rounded bg-secondary" />
          </div>
          <div className="h-3 w-20 animate-pulse rounded bg-secondary" />
          <div className="h-3 w-8 animate-pulse rounded bg-secondary" />
          <div className="h-3 w-8 animate-pulse rounded bg-secondary" />
          <div className="h-3 w-8 animate-pulse rounded bg-secondary" />
          <div className="h-4 w-20 animate-pulse rounded bg-secondary" />
          <div className="size-6 animate-pulse rounded bg-secondary justify-self-end" />
        </div>
      ))}
    </div>
  );
}
