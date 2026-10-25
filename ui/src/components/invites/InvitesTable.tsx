"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Loader } from "@/components/ui/loader";
import {
  EyeIcon,
  MagnifyingGlassIcon,
  PaperPlaneTiltIcon,
  PlusIcon,
  ProhibitIcon,
} from "@phosphor-icons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  MailAdd01Icon,
  MoreVerticalSquare02Icon,
} from "@hugeicons/core-free-icons";
import { LabelChip } from "@/components/tenants/shared";
import { useAudienceCatalog } from "@/components/announcements/AudiencePicker";
import { cn } from "@/lib/utils";
import {
  EmailStatusBadge,
  InviteStatusBadge,
  canResend,
  canRevoke,
  formatDay,
  shortOperator,
} from "./format";
import { InviteActionDialog, type InviteAction } from "./InviteActions";
import { InviteDetailDrawer } from "./InviteDetailDrawer";
import { NewInviteDrawer } from "./NewInviteDrawer";
import type { Invite, InviteStatus, InvitesListResponse } from "./types";

// Shared grid template so the header and every row align — columns:
// email · status · tier · groups · email delivery · invited · expires · sent ·
// workspace · actions. Tracks are minmax(0,fr) so they always fit the card.
const GRID =
  "grid grid-cols-[minmax(0,1.7fr)_minmax(0,0.85fr)_minmax(0,1.05fr)_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.65fr)_minmax(0,0.4fr)_minmax(0,1.15fr)_2.75rem] items-center gap-3";

const FILTERS: { label: string; value: InviteStatus | "" }[] = [
  { label: "All", value: "" },
  { label: "Pending", value: "pending" },
  { label: "Expired", value: "expired" },
  { label: "Redeemed", value: "redeemed" },
  { label: "Revoked", value: "revoked" },
];

// InvitesTable is the tester-invite history + author surface (CON-334 §3,
// wireframe 2), styled like AnnouncementsTable. It fetches keyset pages from
// /api/invites (status tab + email search), and drives the lifecycle: new
// invite (single or bulk drawer), the detail drawer, and Resend / Revoke behind
// confirmations, refreshing the row in place. All state is Ogen's.
export function InvitesTable() {
  const [data, setData] = useState<InvitesListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [statusFilter, setStatusFilter] = useState<InviteStatus | "">("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [pageToken, setPageToken] = useState("");
  const [prevTokens, setPrevTokens] = useState<string[]>([]);

  const [newOpen, setNewOpen] = useState(false);
  const [detail, setDetail] = useState<Invite | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [action, setAction] = useState<InviteAction | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Catalog for tier/group colours (invites carry names, not colours, for tiers).
  const { tiers } = useAudienceCatalog();
  const tierColor = (id: string) => tiers.find((t) => t.id === id)?.color ?? "";

  const reload = useCallback(
    (status: string, q: string, token: string, signal?: AbortSignal) => {
      const qs = new URLSearchParams();
      if (status) qs.set("status", status);
      if (q) qs.set("q", q);
      if (token) qs.set("page_token", token);
      const suffix = qs.toString() ? `?${qs}` : "";
      return fetch(`/api/invites${suffix}`, { signal })
        .then((r) => {
          if (!r.ok) throw new Error(`Request failed (${r.status})`);
          return r.json() as Promise<InvitesListResponse>;
        })
        .then((json) => {
          setData(json);
          setLoadError(null);
        })
        .catch((e: unknown) => {
          if (signal?.aborted) return;
          setLoadError(
            e instanceof Error ? e.message : "Failed to load invites.",
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

  // refreshCtl cancels an in-flight refresh() when a newer one starts or the
  // filter/search/page changes, so a late response can't overwrite the rows
  // of the active view.
  const refreshCtl = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    reload(statusFilter, query, pageToken, controller.signal);
    return () => {
      controller.abort();
      refreshCtl.current?.abort();
    };
  }, [reload, statusFilter, query, pageToken]);

  // Debounce the search box into the query that drives the fetch; a new query
  // starts again from the first page.
  useEffect(() => {
    const q = search.trim();
    if (q === query) return;
    const t = window.setTimeout(() => {
      setQuery(q);
      setPageToken("");
      setPrevTokens([]);
      setRefreshing(true);
    }, 300);
    return () => window.clearTimeout(t);
  }, [search, query]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    refreshCtl.current?.abort();
    const c = new AbortController();
    refreshCtl.current = c;
    reload(statusFilter, query, pageToken, c.signal);
  }, [reload, statusFilter, query, pageToken]);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  const changeFilter = useCallback(
    (value: InviteStatus | "") => {
      // Re-selecting the active tab on the first page changes nothing, so the
      // reload effect wouldn't run and skeleton rows would strand. Bail.
      if (value === statusFilter && pageToken === "") return;
      setStatusFilter(value);
      setPageToken("");
      setPrevTokens([]);
      setLoading(true);
    },
    [statusFilter, pageToken],
  );

  // Number keys 1..N jump straight to a status tab (mirrors /announcements).
  // Ignored while typing in a field, and while a drawer/dialog is open.
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

  // replaceRow swaps an updated invite into the current page (and the open
  // drawer), so a resend/revoke shows its new state without a refetch.
  const replaceRow = useCallback((updated: Invite) => {
    setData((d) =>
      d
        ? {
            ...d,
            invites: d.invites.map((i) => (i.id === updated.id ? updated : i)),
          }
        : d,
    );
    setDetail((cur) => (cur && cur.id === updated.id ? updated : cur));
  }, []);

  const openDetail = (inv: Invite) => {
    setDetail(inv);
    setDetailOpen(true);
  };

  // ?invite=<id> deep-links the detail drawer (the tenant Access card's "View
  // invite"). Read on the client after mount — the page is a static export.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("invite");
    if (!id) return;
    const controller = new AbortController();
    fetch(`/api/invites/${encodeURIComponent(id)}`, {
      signal: controller.signal,
    })
      .then((r) => (r.ok ? (r.json() as Promise<{ invite: Invite }>) : null))
      .then((j) => {
        if (!j) return;
        setDetail(j.invite);
        setDetailOpen(true);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const available = data?.available ?? false;
  const invites = data?.invites ?? [];
  const hasPrev = prevTokens.length > 0;
  const hasNext = !!data?.nextPageToken;
  const filtering = !!statusFilter || !!query;

  return (
    <div className="rounded-xl bg-primary">
      {/* Header bar */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">All invites</h2>
          <p className="mt-1 max-w-xl text-xs text-tertiary-foreground">
            Complimentary access for alpha and beta testers. Each invite creates
            a new workspace that is never billed. Invites work whether signup is
            open or invite-only.
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
            onClick={() => setNewOpen(true)}
            disabled={loading || !available}
          >
            <PlusIcon className="size-4" weight="bold" />
            New invite
          </Button>
        </div>
      </div>

      {/* Status tabs + email search */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 border-b border-border px-6">
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
        <label className="flex w-64 items-center gap-2 border-b border-quaternary bg-input px-3 py-1.5 focus-within:border-foreground">
          <MagnifyingGlassIcon className="size-4 shrink-0 text-tertiary-foreground" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search email"
            aria-label="Search invites by email"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-tertiary-foreground"
          />
        </label>
      </div>

      <div className="overflow-hidden rounded-b-xl">
        {loading ? (
          <SkeletonRows />
        ) : loadError ? (
          <p className="p-6 text-sm text-destructive">{loadError}</p>
        ) : !available ? (
          <p className="p-6 text-sm text-tertiary-foreground">
            The tenant-invite service is unavailable. Check that Ogen is running
            and that Harbor’s <code className="font-mono">OGEN_GRPC_ADDR</code>{" "}
            / <code className="font-mono">OGEN_GRPC_TOKEN</code> are configured.
          </p>
        ) : invites.length === 0 ? (
          <div className="flex flex-col items-center gap-3 p-12 text-center">
            <HugeiconsIcon
              icon={MailAdd01Icon}
              className="size-8 text-quaternary"
            />
            <p className="text-sm text-tertiary-foreground">
              {query
                ? `No invites match “${query}”.`
                : statusFilter
                  ? `No ${statusFilter} invites.`
                  : "No invites yet."}
            </p>
            {!filtering && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setNewOpen(true)}
              >
                <PlusIcon className="size-4" weight="bold" />
                New invite
              </Button>
            )}
          </div>
        ) : (
          <div className="divide-y divide-border">
            <div className={`${GRID} px-6 py-2.5`}>
              <HeaderCell label="Email" />
              <HeaderCell label="Status" />
              <HeaderCell label="Tier" />
              <HeaderCell label="Groups" />
              <HeaderCell label="Delivery" />
              <HeaderCell label="Invited" />
              <HeaderCell label="Expires" />
              <HeaderCell label="Sent" />
              <HeaderCell label="Workspace" />
              <span aria-hidden />
            </div>

            {invites.map((inv) => (
              <div
                key={inv.id}
                className={`${GRID} group px-6 py-3.5 text-sm transition-colors hover:bg-secondary/40`}
              >
                <button
                  type="button"
                  onClick={() => openDetail(inv)}
                  className="min-w-0 cursor-pointer truncate text-left font-medium text-foreground"
                  title={inv.email}
                >
                  {inv.email}
                </button>

                <InviteStatusBadge status={inv.status} />

                <span className="min-w-0">
                  {inv.tierName ? (
                    <LabelChip
                      label={inv.tierName}
                      color={tierColor(inv.tierId)}
                    />
                  ) : (
                    <span className="text-tertiary-foreground">—</span>
                  )}
                </span>

                <span className="flex min-w-0 flex-wrap gap-1">
                  {inv.groups.length === 0 ? (
                    <span className="text-tertiary-foreground">—</span>
                  ) : (
                    inv.groups.map((g) => (
                      <LabelChip key={g.id} label={g.name} color={g.color} />
                    ))
                  )}
                </span>

                <EmailStatusBadge status={inv.emailStatus} />

                <span className="truncate text-xs text-secondary-foreground">
                  {formatDay(inv.createdAt)} · {shortOperator(inv.createdBy)}
                </span>

                <span className="truncate text-xs text-secondary-foreground">
                  {inv.status === "pending" || inv.status === "expired"
                    ? formatDay(inv.expiresAt)
                    : "—"}
                </span>

                <span className="tabular-nums text-secondary-foreground">
                  {inv.sentCount}
                </span>

                <WorkspaceCell invite={inv} />

                <RowActions
                  invite={inv}
                  onView={() => openDetail(inv)}
                  onResend={() => setAction({ kind: "resend", invite: inv })}
                  onRevoke={() => setAction({ kind: "revoke", invite: inv })}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pagination (keyset) */}
      {available && !loading && !loadError && (hasPrev || hasNext) && (
        <div className="flex items-center justify-between gap-2 border-t border-border px-6 py-3">
          <span className="text-xs text-tertiary-foreground">
            Showing {invites.length}
          </span>
          <div className="flex items-center gap-2">
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
        </div>
      )}

      {toast && (
        <div
          role="status"
          className="fixed bottom-6 right-6 z-[200] max-w-sm rounded-md border border-border bg-primary px-4 py-2 text-sm text-foreground shadow-xl"
        >
          {toast}
        </div>
      )}

      <NewInviteDrawer
        open={newOpen}
        onOpenChange={setNewOpen}
        onSent={(msg) => {
          if (msg) flash(msg);
          refresh();
        }}
      />

      <InviteDetailDrawer
        invite={detail}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        tierColor={tierColor}
        onResend={(inv) => setAction({ kind: "resend", invite: inv })}
        onRevoke={(inv) => setAction({ kind: "revoke", invite: inv })}
        onLoaded={replaceRow}
      />

      <InviteActionDialog
        action={action}
        onClose={() => setAction(null)}
        onDone={(updated, msg) => {
          replaceRow(updated);
          flash(msg);
        }}
      />
    </div>
  );
}

// WorkspaceCell links a redeemed invite to the workspace it became, and says
// whether that workspace is still complimentary.
function WorkspaceCell({ invite: inv }: { invite: Invite }) {
  if (!inv.redeemedTenantId) {
    return <span className="text-tertiary-foreground">—</span>;
  }
  return (
    <span className="flex min-w-0 flex-col">
      <Link
        href={`/tenants/${encodeURIComponent(inv.redeemedTenantId)}`}
        className="truncate text-foreground hover:underline"
      >
        {inv.redeemedTenantName || inv.redeemedTenantId}
      </Link>
      <span className="truncate text-xs text-tertiary-foreground">
        {inv.redeemedTenantComplimentary ? "Complimentary" : "Comp ended"}
      </span>
    </span>
  );
}

function HeaderCell({ label }: { label: string }) {
  return (
    <span className="truncate text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
      {label}
    </span>
  );
}

function RowActions({
  invite,
  onView,
  onResend,
  onRevoke,
}: {
  invite: Invite;
  onView: () => void;
  onResend: () => void;
  onRevoke: () => void;
}) {
  const resend = canResend(invite.status);
  const revoke = canRevoke(invite.status);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="smIcon"
          aria-label={`Actions for ${invite.email}`}
          className="h-9 w-9 justify-self-end text-tertiary-foreground data-[state=open]:border-quaternary data-[state=open]:bg-quaternary data-[state=open]:text-primary-foreground"
        >
          <HugeiconsIcon icon={MoreVerticalSquare02Icon} className="size-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="end"
        sideOffset={6}
        className="min-w-44"
      >
        <DropdownMenuItem onClick={onView}>
          <EyeIcon className="size-4" />
          View details
        </DropdownMenuItem>
        {resend && (
          <DropdownMenuItem onClick={onResend}>
            <PaperPlaneTiltIcon className="size-4" />
            Resend…
          </DropdownMenuItem>
        )}
        {revoke && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onRevoke}>
              <ProhibitIcon className="size-4" />
              Revoke
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
          <div className="h-3 w-40 animate-pulse rounded bg-secondary" />
          <div className="h-4 w-16 animate-pulse rounded-full bg-secondary" />
          <div className="h-4 w-12 animate-pulse rounded bg-secondary" />
          <div className="h-4 w-14 animate-pulse rounded bg-secondary" />
          <div className="h-4 w-16 animate-pulse rounded-full bg-secondary" />
          <div className="h-3 w-20 animate-pulse rounded bg-secondary" />
          <div className="h-3 w-10 animate-pulse rounded bg-secondary" />
          <div className="h-3 w-4 animate-pulse rounded bg-secondary" />
          <div className="h-3 w-16 animate-pulse rounded bg-secondary" />
          <div className="size-6 animate-pulse justify-self-end rounded bg-secondary" />
        </div>
      ))}
    </div>
  );
}
