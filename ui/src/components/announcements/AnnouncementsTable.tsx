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
  NotePencilIcon,
  TrashIcon,
  ChartBarIcon,
  MegaphoneIcon,
  ArchiveIcon,
  PaperPlaneTiltIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  MoreVerticalSquare02Icon,
  MessageDone02Icon,
  MessageEdit02Icon,
  MessageLock01Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { AnnouncementDialog } from "./AnnouncementDialog";
import { AnnouncementStatsDrawer } from "./AnnouncementStatsDrawer";
import { useAudienceCatalog } from "./AudiencePicker";
import { StatusBadge, audienceCount, formatWindow } from "./format";
import type {
  Announcement,
  AnnouncementStatus,
  AnnouncementsListResponse,
} from "./types";

// Shared grid template so the header and every row align — columns:
// title · status · audience · window · clicks · dismissals · actions. Tracks are
// minmax(0,fr) so they always fit the card (no overflow) and text truncates;
// the two count columns are right-aligned.
const GRID =
  "grid grid-cols-[minmax(0,2.4fr)_minmax(0,0.95fr)_minmax(0,1.1fr)_minmax(0,1.5fr)_minmax(0,0.7fr)_minmax(0,0.85fr)_2.75rem] items-center gap-3";

const FILTERS: { label: string; value: AnnouncementStatus | "" }[] = [
  { label: "All", value: "" },
  { label: "Draft", value: "draft" },
  { label: "Published", value: "published" },
  { label: "Archived", value: "archived" },
];

// AnnouncementsTable is the announcement history + author surface, styled to
// match the /platforms + /tenants "All X" table. It fetches a keyset page from
// /api/announcements (status filter + pagination), shows per-row click/dismiss
// counts, and drives the whole lifecycle: create/edit (drawer), publish/archive
// (SetStatus), draft-only delete (guarded), and a slide-over stats view. All
// state is Ogen's.
export function AnnouncementsTable() {
  const [data, setData] = useState<AnnouncementsListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [statusFilter, setStatusFilter] = useState<AnnouncementStatus | "">("");
  const [pageToken, setPageToken] = useState("");
  const [prevTokens, setPrevTokens] = useState<string[]>([]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<"create" | "edit">("create");
  const [dialogTarget, setDialogTarget] = useState<Announcement | undefined>(
    undefined,
  );

  const [statsId, setStatsId] = useState<string | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Announcement | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Catalog for resolving targeted tier/group ids to names in the stats drawer.
  const { tiers, groups } = useAudienceCatalog();

  const reload = useCallback(
    (status: string, token: string, signal?: AbortSignal) => {
      const qs = new URLSearchParams();
      if (status) qs.set("status", status);
      if (token) qs.set("page_token", token);
      const suffix = qs.toString() ? `?${qs}` : "";
      return fetch(`/api/announcements${suffix}`, { signal })
        .then((r) => {
          if (!r.ok) throw new Error(`Request failed (${r.status})`);
          return r.json() as Promise<AnnouncementsListResponse>;
        })
        .then((json) => {
          setData(json);
          setLoadError(null);
        })
        .catch((e: unknown) => {
          if (signal?.aborted) return;
          setLoadError(
            e instanceof Error ? e.message : "Failed to load announcements.",
          );
        })
        .finally(() => {
          if (!signal?.aborted) {
            setLoading(false);
            setRefreshing(false);
          }
        });
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    reload(statusFilter, pageToken, controller.signal);
    return () => controller.abort();
  }, [reload, statusFilter, pageToken]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    reload(statusFilter, pageToken);
  }, [reload, statusFilter, pageToken]);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3000);
  }, []);

  const changeFilter = useCallback((value: AnnouncementStatus | "") => {
    setStatusFilter(value);
    setPageToken("");
    setPrevTokens([]);
    setLoading(true);
  }, []);

  // Number keys 1..N jump straight to a status tab (mirrors /secrets and the
  // tenant-detail tabs). Ignored while typing in a field, and while a modal
  // drawer/dialog is open — the create/edit drawer has its own tab switching.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
          target.closest?.('[role="combobox"],[role="textbox"]'))
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= FILTERS.length) {
        e.preventDefault();
        changeFilter(FILTERS[n - 1].value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [changeFilter]);

  const goNext = () => {
    const next = data?.nextPageToken;
    if (!next) return;
    setPrevTokens((p) => [...p, pageToken]);
    setPageToken(next);
    setLoading(true);
  };
  const goPrev = () => {
    if (prevTokens.length === 0) return;
    const n = [...prevTokens];
    const t = n.pop() ?? "";
    setPrevTokens(n);
    setPageToken(t);
    setLoading(true);
  };

  const available = data?.available ?? false;
  const items = data?.items ?? [];
  const hasPrev = prevTokens.length > 0;
  const hasNext = !!data?.nextPageToken;

  // ── create / edit ─────────────────────────────────────────────────────────
  const openCreate = () => {
    setDialogMode("create");
    setDialogTarget(undefined);
    setDialogOpen(true);
  };
  const openEdit = (a: Announcement) => {
    setDialogMode("edit");
    setDialogTarget(a);
    setDialogOpen(true);
  };
  const handleSaved = (title: string, created: boolean) => {
    flash(`Announcement “${title}” ${created ? "created" : "updated"}.`);
    refresh();
  };

  // ── stats ───────────────────────────────────────────────────────────────
  const openStats = (a: Announcement) => {
    setStatsId(a.id);
    setStatsOpen(true);
  };

  // ── lifecycle (publish / archive) ─────────────────────────────────────────
  const setStatus = async (a: Announcement, status: AnnouncementStatus) => {
    setBusyId(a.id);
    setActionError(null);
    try {
      const res = await fetch(
        `/api/announcements/${encodeURIComponent(a.id)}/status`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        },
      );
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(detail?.error || `Request failed (${res.status})`);
      }
      const verb = status === "published" ? "published" : "archived";
      flash(`Announcement “${a.title}” ${verb}.`);
      refresh();
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : "Couldn’t change the status.",
      );
    } finally {
      setBusyId(null);
    }
  };

  // ── delete (draft only; guarded server-side) ──────────────────────────────
  const openDelete = (a: Announcement) => {
    setDeleteError(null);
    setDeleteTarget(a);
  };
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const res = await fetch(
        `/api/announcements/${encodeURIComponent(deleteTarget.id)}`,
        { method: "DELETE" },
      );
      if (res.ok || res.status === 204) {
        flash(`Announcement “${deleteTarget.title}” deleted.`);
        setDeleteTarget(null);
        refresh();
        return;
      }
      const detail = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      // 409 FailedPrecondition: only drafts can be deleted — Ogen's message
      // tells the operator to archive instead.
      setDeleteError(detail?.error || `Request failed (${res.status})`);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Failed to delete.");
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="rounded-xl bg-primary">
      {/* Header bar */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">
            All announcements
          </h2>
          <p className="mt-1 max-w-xl text-xs text-tertiary-foreground">
            Informational banners shown to targeted tenants. Create a draft,
            target it at all tenants or specific groups and tiers, schedule a
            showing window, then publish. Click and dismiss counts are per unique
            user.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {!loading && available && refreshing && (
            <Loader className="size-3.5 border-[1.5px]" />
          )}
          <Button
            variant="defaultInverted"
            size="sm"
            className="font-semibold"
            onClick={openCreate}
            disabled={loading || !available}
          >
            <PlusIcon className="size-4" weight="bold" />
            New announcement
          </Button>
        </div>
      </div>

      {/* Status filter */}
      <div className="flex items-center gap-6 border-b border-border px-6">
        <div role="tablist" className="flex gap-6">
          {FILTERS.map((f) => (
            <button
              key={f.label}
              type="button"
              role="tab"
              aria-selected={f.value === statusFilter}
              onClick={() => changeFilter(f.value)}
              className={cn(
                "relative -mb-px border-b-2 py-2.5 text-sm whitespace-nowrap transition-colors outline-none",
                f.value === statusFilter
                  ? "border-foreground font-semibold text-foreground"
                  : "border-transparent font-medium text-tertiary-foreground hover:text-secondary-foreground",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-b-xl">
        {loading ? (
          <SkeletonRows />
        ) : loadError ? (
          <p className="p-6 text-sm text-destructive">{loadError}</p>
        ) : !available ? (
          <p className="p-6 text-sm text-tertiary-foreground">
            The announcement-admin service is unavailable. Check that Ogen is
            running and that Harbor’s{" "}
            <code className="font-mono">OGEN_GRPC_ADDR</code> /{" "}
            <code className="font-mono">OGEN_GRPC_TOKEN</code> are configured.
          </p>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 p-12 text-center">
            <MegaphoneIcon className="size-8 text-quaternary" />
            <p className="text-sm text-tertiary-foreground">
              {statusFilter
                ? `No ${statusFilter} announcements.`
                : "No announcements yet."}
            </p>
            {!statusFilter && (
              <Button variant="outline" size="sm" onClick={openCreate}>
                <PlusIcon className="size-4" weight="bold" />
                New announcement
              </Button>
            )}
          </div>
        ) : (
          <div className="divide-y divide-border">
            <div className={`${GRID} px-6 py-2.5`}>
              <HeaderCell label="Announcement" />
              <HeaderCell label="Status" />
              <HeaderCell label="Audience" />
              <HeaderCell label="Window" />
              <HeaderCell label="Clicks" align="right" />
              <HeaderCell label="Dismissals" align="right" />
              <span aria-hidden />
            </div>

            {items.map(({ announcement: a, stats }) => (
              <div
                key={a.id}
                className={cn(
                  `${GRID} group px-6 py-3.5 text-sm transition-colors hover:bg-secondary/40`,
                  busyId === a.id && "opacity-60",
                )}
              >
                {/* Status glyph + title (+ dim body preview) */}
                <button
                  type="button"
                  onClick={() => openStats(a)}
                  className="flex min-w-0 cursor-pointer items-center gap-2.5 text-left"
                >
                  <StatusGlyph status={a.status} />
                  <span className="flex min-w-0 flex-col items-start">
                    <span className="truncate font-medium text-foreground">
                      {a.title || (
                        <span className="text-tertiary-foreground">
                          Untitled
                        </span>
                      )}
                    </span>
                    {a.body && (
                      <span className="mt-0.5 line-clamp-1 text-xs text-tertiary-foreground">
                        {a.body}
                      </span>
                    )}
                  </span>
                </button>

                <StatusBadge status={a.status} />

                <span className="truncate text-secondary-foreground">
                  {audienceCount(a)}
                </span>

                <span className="truncate text-xs text-secondary-foreground">
                  {formatWindow(a.startsAt, a.endsAt)}
                </span>

                <span className="text-right tabular-nums text-secondary-foreground">
                  {stats.uniqueUsersClicked.toLocaleString()}
                </span>
                <span className="text-right tabular-nums text-secondary-foreground">
                  {stats.uniqueUsersDismissed.toLocaleString()}
                </span>

                <RowActions
                  a={a}
                  busy={busyId === a.id}
                  onView={() => openStats(a)}
                  onEdit={() => openEdit(a)}
                  onPublish={() => setStatus(a, "published")}
                  onArchive={() => setStatus(a, "archived")}
                  onDelete={() => openDelete(a)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pagination */}
      {available && !loading && !loadError && (hasPrev || hasNext) && (
        <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-3">
          <Button
            variant="outline"
            size="sm"
            onClick={goPrev}
            disabled={!hasPrev}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={goNext}
            disabled={!hasNext}
          >
            Next
          </Button>
        </div>
      )}

      {/* Transient success toast */}
      {toast && (
        <div
          role="status"
          className="fixed bottom-6 right-6 z-[200] rounded-md border border-border bg-primary px-4 py-2 text-sm text-foreground shadow-xl"
        >
          {toast}
        </div>
      )}

      {/* Action error toast (publish/archive failures) */}
      {actionError && (
        <div
          role="alert"
          className="fixed bottom-6 right-6 z-[200] flex max-w-sm items-center gap-3 rounded-md border border-destructive/40 bg-primary px-4 py-2 text-sm text-destructive shadow-xl"
        >
          <span className="min-w-0">{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="shrink-0 text-tertiary-foreground hover:text-foreground"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Create / edit */}
      <AnnouncementDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        mode={dialogMode}
        announcement={dialogTarget}
        onSaved={handleSaved}
      />

      {/* Stats slide-over */}
      <AnnouncementStatsDrawer
        announcementId={statsId}
        open={statsOpen}
        onOpenChange={setStatsOpen}
        tiers={tiers}
        groups={groups}
      />

      {/* Delete confirmation (drafts only; 409 surfaces the archive-instead hint) */}
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
                <DialogTitle>Delete “{deleteTarget.title}”?</DialogTitle>
                <DialogDescription>
                  This permanently deletes the draft. Published or archived
                  announcements are kept for history — archive instead of
                  deleting them.
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
                  disabled={deleteBusy}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructiveInverted"
                  onClick={confirmDelete}
                  disabled={deleteBusy}
                >
                  {deleteBusy ? "Deleting…" : "Delete draft"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Per-status lifecycle glyph shown at the head of each row, tinted to match the
// StatusBadge colours (neutral draft, emerald published, amber archived).
const STATUS_GLYPH: Record<
  AnnouncementStatus,
  { icon: typeof MessageDone02Icon; className: string }
> = {
  draft: { icon: MessageEdit02Icon, className: "text-tertiary-foreground" },
  published: { icon: MessageDone02Icon, className: "text-emerald-600" },
  archived: { icon: MessageLock01Icon, className: "text-amber-600" },
};

function StatusGlyph({ status }: { status: AnnouncementStatus }) {
  const g = STATUS_GLYPH[status] ?? STATUS_GLYPH.draft;
  return (
    <HugeiconsIcon
      icon={g.icon}
      className={cn("size-5 shrink-0", g.className)}
      aria-hidden
    />
  );
}

function HeaderCell({
  label,
  align = "left",
}: {
  label: string;
  align?: "left" | "right";
}) {
  return (
    <span
      className={cn(
        "truncate text-xs font-semibold uppercase tracking-wide text-tertiary-foreground",
        align === "right" && "text-right",
      )}
    >
      {label}
    </span>
  );
}

function RowActions({
  a,
  busy,
  onView,
  onEdit,
  onPublish,
  onArchive,
  onDelete,
}: {
  a: Announcement;
  busy: boolean;
  onView: () => void;
  onEdit: () => void;
  onPublish: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="smIcon"
          disabled={busy}
          aria-label={`Actions for ${a.title}`}
          className="h-9 w-9 justify-self-end text-tertiary-foreground data-[state=open]:border-quaternary data-[state=open]:bg-quaternary data-[state=open]:text-primary-foreground"
        >
          <HugeiconsIcon icon={MoreVerticalSquare02Icon} className="size-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="end"
        sideOffset={6}
        className="min-w-48"
      >
        <DropdownMenuItem onClick={onView}>
          <ChartBarIcon className="size-4" />
          View stats
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onEdit}>
          <NotePencilIcon className="size-4" />
          Edit
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {a.status !== "published" && (
          <DropdownMenuItem onClick={onPublish}>
            <PaperPlaneTiltIcon className="size-4" />
            {a.status === "archived" ? "Re-publish" : "Publish"}
          </DropdownMenuItem>
        )}
        {a.status !== "archived" && (
          <DropdownMenuItem onClick={onArchive}>
            <ArchiveIcon className="size-4" />
            Archive
          </DropdownMenuItem>
        )}
        {a.status === "draft" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <TrashIcon className="size-4" />
              Delete draft
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SkeletonRows() {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className={`${GRID} px-6 py-3.5`}>
          <div className="flex flex-col gap-1.5">
            <div className="h-3 w-40 animate-pulse rounded bg-secondary" />
            <div className="h-2.5 w-56 animate-pulse rounded bg-secondary" />
          </div>
          <div className="h-4 w-20 animate-pulse rounded-full bg-secondary" />
          <div className="h-3 w-20 animate-pulse rounded bg-secondary" />
          <div className="h-3 w-28 animate-pulse rounded bg-secondary" />
          <div className="h-3 w-6 animate-pulse justify-self-end rounded bg-secondary" />
          <div className="h-3 w-6 animate-pulse justify-self-end rounded bg-secondary" />
          <div className="size-6 animate-pulse justify-self-end rounded bg-secondary" />
        </div>
      ))}
    </div>
  );
}
