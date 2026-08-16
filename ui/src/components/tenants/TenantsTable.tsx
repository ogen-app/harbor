"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CaretRightIcon,
  CaretUpIcon,
  CaretDownIcon,
  DotsThreeOutlineVerticalIcon,
  ArrowSquareOutIcon,
  StackIcon,
  UsersThreeIcon,
  PulseIcon,
  PauseIcon,
  PlayIcon,
  ArrowCounterClockwiseIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { useRowKeyboardNav } from "@/lib/useRowKeyboardNav";
import { Bar, Dot, InfoIcon } from "@/components/dashboard/primitives";
import { Loader } from "@/components/ui/loader";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  TenantsFilterBar,
  type FilterToken,
} from "@/components/tenants/TenantsFilterBar";
import {
  type Tenant,
  type VendorSpend,
  type ActivityEvent,
  type ActivityState,
  type ClassificationLabel,
  formatDate,
  formatUSD,
  formatBytes,
  spendSegments,
  StatusLabel,
  LabelChip,
  ColorDot,
  DetailRow,
  RecentActivity,
} from "@/components/tenants/shared";

// ── types ─────────────────────────────────────────────────────────────────────

interface TenantsResponse {
  tenants: Tenant[];
  available: boolean;
  spendAvailable?: boolean;
  total?: number;
  statuses?: string[];
  // Classification catalogs (CON-208) — feed the filter options and the row
  // edit menu. Empty when Ogen's classification tables aren't present.
  tiers?: ClassificationLabel[];
  groups?: ClassificationLabel[];
  error?: string;
}

// The tenant lifecycle enum (CON-190). SetTenantStatus drives every transition.
type TenantStatus = "active" | "suspended" | "deleted";

// ── sorting ───────────────────────────────────────────────────────────────────

type SortKey =
  "name" | "createdAt" | "status" | "users" | "spend" | "zernio" | "r2";
type SortDir = "asc" | "desc";

const sortValue = (t: Tenant, key: SortKey): string | number => {
  switch (key) {
    case "name":
      return t.name.toLowerCase();
    case "createdAt":
      return new Date(t.createdAt).getTime();
    case "status":
      return t.status;
    case "users":
      return t.users;
    case "spend":
      return t.spend.totalMicros;
    case "zernio":
      return t.zernioProfiles;
    case "r2":
      return t.r2Bytes;
  }
};

// Sort preference persists across reloads and route changes via localStorage.
type Sort = { key: SortKey; dir: SortDir };
const DEFAULT_SORT: Sort = { key: "createdAt", dir: "asc" };
const SORT_STORAGE_KEY = "harbor.tenants.sort";
const SORT_KEYS: SortKey[] = [
  "name",
  "createdAt",
  "status",
  "users",
  "spend",
  "zernio",
  "r2",
];

function loadSort(): Sort {
  if (typeof window === "undefined") return DEFAULT_SORT;
  try {
    const raw = window.localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw) return DEFAULT_SORT;
    const parsed = JSON.parse(raw) as { key?: unknown; dir?: unknown };
    if (
      SORT_KEYS.includes(parsed.key as SortKey) &&
      (parsed.dir === "asc" || parsed.dir === "desc")
    ) {
      return { key: parsed.key as SortKey, dir: parsed.dir };
    }
  } catch {
    // malformed or unavailable storage — fall back to the default
  }
  return DEFAULT_SORT;
}

// ── layout ────────────────────────────────────────────────────────────────────

// Shared grid template so the header and every row align. Columns:
// chevron · name · registered · status · groups ‖ users · AI spend · Zernio · R2 · actions.
// The four metric columns after the divider are the visually distinctive set.
const GRID =
  "grid grid-cols-[2rem_minmax(150px,1.6fr)_1fr_0.9fr_minmax(120px,1.3fr)_0.7fr_minmax(120px,1.4fr)_0.8fr_0.9fr_2.5rem] items-center gap-4";

const METRIC_START = "border-l border-border pl-4"; // divider before the metric group

// errorText pulls the server's { error } message from a failed response, falling
// back to the status code.
async function errorText(res: Response): Promise<string> {
  const detail = (await res.json().catch(() => null)) as {
    error?: string;
  } | null;
  return detail?.error || `Request failed (${res.status})`;
}

// ── column headers ────────────────────────────────────────────────────────────

function SortHeader({
  label,
  col,
  sort,
  onSort,
  align = "left",
  className,
  accent,
  info,
}: {
  label: string;
  col: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
  className?: string;
  accent?: boolean;
  info?: string;
}) {
  const active = sort.key === col;
  return (
    <div
      className={cn(
        "flex items-center gap-1.5",
        align === "right" ? "justify-end" : "justify-start",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onSort(col)}
        className={cn(
          "flex items-center gap-1 text-xs font-semibold uppercase tracking-wide transition-colors hover:text-foreground",
          accent ? "text-foreground" : "text-tertiary-foreground",
        )}
      >
        <span>{label}</span>
        {active ? (
          sort.dir === "asc" ? (
            <CaretUpIcon className="size-3" weight="bold" />
          ) : (
            <CaretDownIcon className="size-3" weight="bold" />
          )
        ) : (
          <CaretUpIcon className="size-3 opacity-0" weight="bold" />
        )}
      </button>
      {info && <InfoIcon text={info} />}
    </div>
  );
}

// ── per-row actions menu ──────────────────────────────────────────────────────

// GroupsCell renders a tenant's group chips (up to three) with a "+N" overflow.
function GroupsCell({ groups }: { groups: ClassificationLabel[] }) {
  if (groups.length === 0) {
    return <span className="text-xs text-tertiary-foreground">—</span>;
  }
  const shown = groups.slice(0, 3);
  const extra = groups.length - shown.length;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {shown.map((g) => (
        <LabelChip key={g.id} label={g.name} color={g.color} />
      ))}
      {extra > 0 && (
        <span
          className="rounded-full bg-secondary px-1.5 py-0.5 text-[11px] font-medium leading-none text-tertiary-foreground"
          title={groups.map((g) => g.name).join(", ")}
        >
          +{extra}
        </span>
      )}
    </div>
  );
}

// ActionsMenu is the per-row "⋮" menu. "View details" navigates to the tenant
// page; the Tier and Groups submenus edit the tenant's classification — a radio
// list (tier is 1-per-tenant) and a checkbox list (groups are many). Toggles
// write over gRPC via the parent's optimistic handlers. stopPropagation keeps
// the trigger / portaled menu clicks from toggling row expansion (the row is a
// role="button" and portal clicks bubble through the React tree).
function ActionsMenu({
  tenant,
  allTiers,
  allGroups,
  onSetTier,
  onToggleGroup,
  onStatusAction,
}: {
  tenant: Tenant;
  allTiers: ClassificationLabel[];
  allGroups: ClassificationLabel[];
  onSetTier: (tenant: Tenant, tierId: string) => void;
  onToggleGroup: (
    tenant: Tenant,
    group: ClassificationLabel,
    add: boolean,
  ) => void;
  onStatusAction: (tenant: Tenant, target: TenantStatus) => void;
}) {
  const memberIds = new Set((tenant.groups ?? []).map((g) => g.id));
  // The 'default' tenant is suspend/delete-protected server-side (Ogen returns
  // 409); hide those actions for it. Its slug is the stable identifier here.
  const protectedTenant = tenant.slug === "default";
  const status = tenant.status;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="smIcon"
          aria-label="Tenant actions"
          onClick={(e) => e.stopPropagation()}
          className="justify-self-end text-tertiary-foreground data-[state=open]:border-quaternary data-[state=open]:bg-quaternary data-[state=open]:text-primary-foreground"
        >
          <DotsThreeOutlineVerticalIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="end"
        sideOffset={6}
        onClick={(e) => e.stopPropagation()}
        className="min-w-48 rounded-none border border-border py-1 shadow-xl"
      >
        <DropdownMenuItem asChild className="gap-3 px-4 py-2.5">
          <Link href={`/tenants/${encodeURIComponent(tenant.id)}`}>
            <ArrowSquareOutIcon className="size-4" />
            View details
          </Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator className="my-1 h-px bg-border" />

        {/* Lifecycle status (CON-190): suspend / reactivate / soft-delete /
            restore. Which transitions are offered depends on the current status;
            each opens a confirm dialog (suspend also captures a reason). */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gap-3 px-4 py-2.5">
            <PulseIcon className="size-4" />
            Status
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            onClick={(e) => e.stopPropagation()}
            className="min-w-48 rounded-none border border-border py-1 shadow-xl"
          >
            <div className="flex items-center gap-2 px-4 py-2">
              <span className="text-[11px] uppercase tracking-wide text-tertiary-foreground">
                Current
              </span>
              <StatusLabel status={status} reason={tenant.statusReason} />
            </div>
            <DropdownMenuSeparator className="my-1 h-px bg-border" />

            {status !== "active" && (
              <DropdownMenuItem
                onSelect={() => onStatusAction(tenant, "active")}
                className="gap-3 px-4 py-2.5"
              >
                {status === "deleted" ? (
                  <>
                    <ArrowCounterClockwiseIcon className="size-4" />
                    Restore
                  </>
                ) : (
                  <>
                    <PlayIcon className="size-4" />
                    Reactivate
                  </>
                )}
              </DropdownMenuItem>
            )}

            {status === "active" && !protectedTenant && (
              <DropdownMenuItem
                onSelect={() => onStatusAction(tenant, "suspended")}
                className="gap-3 px-4 py-2.5"
              >
                <PauseIcon className="size-4" />
                Suspend…
              </DropdownMenuItem>
            )}

            {status !== "deleted" && !protectedTenant && (
              <DropdownMenuItem
                onSelect={() => onStatusAction(tenant, "deleted")}
                className="gap-3 px-4 py-2.5 text-destructive focus:text-destructive"
              >
                <TrashIcon className="size-4" />
                Delete…
              </DropdownMenuItem>
            )}

            {protectedTenant && status === "active" && (
              <div className="px-4 py-2 text-xs text-tertiary-foreground">
                Protected tenant
              </div>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {(allTiers.length > 0 || allGroups.length > 0) && (
          <DropdownMenuSeparator className="my-1 h-px bg-border" />
        )}

        {allTiers.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-3 px-4 py-2.5">
              <StackIcon className="size-4" />
              Tier
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              onClick={(e) => e.stopPropagation()}
              className="max-h-72 min-w-44 overflow-y-auto rounded-none border border-border py-1 shadow-xl"
            >
              <DropdownMenuRadioGroup
                value={tenant.tier?.id ?? ""}
                onValueChange={(id) => onSetTier(tenant, id)}
              >
                {allTiers.map((t) => (
                  <DropdownMenuRadioItem
                    key={t.id}
                    value={t.id}
                    className="gap-2 pr-3"
                  >
                    <ColorDot color={t.color} />
                    {t.name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}

        {allGroups.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-3 px-4 py-2.5">
              <UsersThreeIcon className="size-4" />
              Groups
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              onClick={(e) => e.stopPropagation()}
              className="max-h-72 min-w-44 overflow-y-auto rounded-none border border-border py-1 shadow-xl"
            >
              {allGroups.map((g) => (
                <DropdownMenuCheckboxItem
                  key={g.id}
                  checked={memberIds.has(g.id)}
                  onCheckedChange={(checked) =>
                    onToggleGroup(tenant, g, checked === true)
                  }
                  onSelect={(e) => e.preventDefault()}
                  className="gap-2"
                >
                  <ColorDot color={g.color} />
                  {g.name}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// StatusDialog confirms a lifecycle transition and, for suspend, captures the
// reason. It renders nothing until an action is requested; the body is mounted
// fresh each open (Radix), so its reason field seeds empty with no effect.
function StatusDialog({
  action,
  onClose,
  onConfirm,
}: {
  action: { tenant: Tenant; target: TenantStatus } | null;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  return (
    <Dialog
      open={!!action}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        {action && (
          <StatusDialogBody
            action={action}
            onCancel={onClose}
            onConfirm={onConfirm}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function StatusDialogBody({
  action,
  onCancel,
  onConfirm,
}: {
  action: { tenant: Tenant; target: TenantStatus };
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const { tenant, target } = action;
  const isSuspend = target === "suspended";
  const isDelete = target === "deleted";
  const isRestore = target === "active" && tenant.status === "deleted";
  const [reason, setReason] = useState("");

  const title = isSuspend
    ? `Suspend ${tenant.name}`
    : isDelete
      ? `Delete ${tenant.name}`
      : isRestore
        ? `Restore ${tenant.name}`
        : `Reactivate ${tenant.name}`;

  const description = isSuspend
    ? "Users are locked out immediately and scheduled posts pause. Published posts stay live. Reversible."
    : isDelete
      ? "The workspace becomes unreachable and its automated work stops. Published posts stay live; data is retained and can be restored later."
      : isRestore
        ? "Re-enables login, resumes scheduled posts, and makes the workspace reachable again."
        : "Re-enables login and resumes the tenant's automated work.";

  const confirmLabel = isSuspend
    ? "Suspend"
    : isDelete
      ? "Delete"
      : isRestore
        ? "Restore"
        : "Reactivate";

  // A suspend must carry a reason; the others don't.
  const canConfirm = !isSuspend || reason.trim().length > 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canConfirm) return;
    onConfirm(reason.trim());
  };

  return (
    <form onSubmit={handleSubmit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>

      {isSuspend && (
        <div className="grid gap-1.5">
          <Label htmlFor="suspend-reason">Reason</Label>
          <Input
            id="suspend-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. non-payment"
            autoFocus
            autoComplete="off"
          />
        </div>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant={isDelete ? "destructiveInverted" : "default"}
          disabled={!canConfirm}
        >
          {confirmLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ExpandedPanel({
  t,
  activity,
}: {
  t: Tenant;
  activity: ActivityState | undefined;
}) {
  return (
    <div className="grid gap-8 bg-secondary border-t px-18 py-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <div className="space-y-2">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
            Details
          </h4>
          <Link
            href={`/tenants/${encodeURIComponent(t.id)}`}
            className="inline-flex items-center gap-1 text-xs font-medium text-foreground hover:underline"
          >
            View full details
            <ArrowSquareOutIcon className="size-3.5" />
          </Link>
        </div>
        <DetailRow
          label="Tenant ID"
          value={<span className="font-mono">{t.id}</span>}
        />
        <DetailRow
          label="Slug"
          value={<span className="font-mono">{t.slug}</span>}
        />
        <DetailRow label="Registered" value={formatDate(t.createdAt)} />
        <DetailRow
          label="Users"
          value={<span className="tabular-nums">{t.users}</span>}
        />
        <DetailRow
          label="Zernio profiles"
          value={<span className="tabular-nums">{t.zernioProfiles}</span>}
        />
        <DetailRow
          label="R2 storage"
          value={<span className="tabular-nums">{formatBytes(t.r2Bytes)}</span>}
        />
        <DetailRow
          label="AI spend (month)"
          value={
            <span className="tabular-nums">
              {formatUSD(t.spend.totalMicros)}
            </span>
          }
        />
      </div>
      <div>
        <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
          Recent activity
        </h4>
        <RecentActivity state={activity} />
      </div>
    </div>
  );
}

// ── metric cells ──────────────────────────────────────────────────────────────

function SpendCell({
  spend,
  available,
}: {
  spend: VendorSpend;
  available: boolean;
}) {
  if (!available) {
    return <span className="text-xs text-tertiary-foreground">—</span>;
  }
  if (spend.totalMicros === 0) {
    return (
      <span className="text-xs text-tertiary-foreground font-mono">
        $0.00
      </span>
    );
  }
  return (
    <div className="min-w-0">
      <span className="text-xs font-mono text-foreground">
        {formatUSD(spend.totalMicros)}
      </span>
      <Bar className="mt-1" segments={spendSegments(spend)} />
    </div>
  );
}

// ── skeleton ──────────────────────────────────────────────────────────────────

function SkeletonRows() {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className={`${GRID} px-6 py-3.5`}>
          <div className="size-4 animate-pulse rounded bg-secondary" />
          <div className="space-y-1.5">
            <div className="h-3 w-28 animate-pulse rounded bg-secondary" />
            <div className="h-2.5 w-16 animate-pulse rounded bg-secondary" />
          </div>
          <div className="h-3 w-20 animate-pulse rounded bg-secondary" />
          <div className="h-3 w-14 animate-pulse rounded bg-secondary" />
          <div className="h-4 w-16 animate-pulse rounded-full bg-secondary" />
          <div className="h-3 w-8 animate-pulse rounded bg-secondary justify-self-end" />
          <div className="h-3 w-full animate-pulse rounded bg-secondary" />
          <div className="h-3 w-10 animate-pulse rounded bg-secondary justify-self-end" />
          <div className="h-3 w-12 animate-pulse rounded bg-secondary justify-self-end" />
          <div className="size-7 animate-pulse rounded bg-secondary justify-self-end" />
        </div>
      ))}
    </div>
  );
}

// ── main ──────────────────────────────────────────────────────────────────────

export function TenantsTable() {
  const [data, setData] = useState<TenantsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [sort, setSort] = useState<Sort>(loadSort);
  const [filters, setFilters] = useState<FilterToken[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activity, setActivity] = useState<Record<string, ActivityState>>({});
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(
    null,
  );
  // The pending lifecycle change awaiting confirmation in the status dialog.
  const [statusAction, setStatusAction] = useState<{
    tenant: Tenant;
    target: TenantStatus;
  } | null>(null);

  // Filtering runs server-side: re-fetch whenever the filter tokens change,
  // passing them as a JSON query param. Previous results stay visible during a
  // refetch (no skeleton flash); an in-flight request is aborted on change.
  useEffect(() => {
    const controller = new AbortController();
    // Show the refetch spinner before the server-side filter query — intentional.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRefreshing(true);
    const qs = filters.length
      ? `?filters=${encodeURIComponent(JSON.stringify(filters))}`
      : "";
    fetch(`/api/tenants${qs}`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`request failed (${r.status})`);
        return r.json();
      })
      .then((j: TenantsResponse) => {
        setData(j);
        setError(null);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Failed to load");
      })
      .finally(() => {
        if (!controller.signal.aborted) setRefreshing(false);
      });
    return () => controller.abort();
  }, [filters]);

  // Persist the sort preference so it survives reloads / route changes.
  useEffect(() => {
    try {
      window.localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sort));
    } catch {
      // storage unavailable (private mode / quota) — preference is best-effort
    }
  }, [sort]);

  const onSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "name" || key === "status" ? "asc" : "desc" },
    );

  // Status options for the filter come from the server (all statuses, not just
  // the current result set). Sorting stays client-side.
  const statusOptions = data?.statuses ?? [];

  const rows = useMemo(() => {
    if (!data?.tenants) return [];
    return [...data.tenants].sort((a, b) => {
      const av = sortValue(a, sort.key);
      const bv = sortValue(b, sort.key);
      if (av < bv) return sort.dir === "asc" ? -1 : 1;
      if (av > bv) return sort.dir === "asc" ? 1 : -1;
      return 0;
    });
  }, [data, sort]);

  const spendAvailable = data?.spendAvailable ?? false;

  // Classification catalogs for the filter options and the row edit menu.
  const allTiers = data?.tiers ?? [];
  const allGroups = data?.groups ?? [];

  const flash = (msg: string, isError = false) => {
    setToast({ msg, error: isError });
    window.setTimeout(() => setToast(null), 3000);
  };

  // mutateTenant patches one tenant in-place in the current result set — used for
  // optimistic tier/group edits so the row (and open menu) update instantly.
  const mutateTenant = (id: string, fn: (t: Tenant) => Tenant) =>
    setData((prev) =>
      prev
        ? { ...prev, tenants: prev.tenants.map((t) => (t.id === id ? fn(t) : t)) }
        : prev,
    );

  // setTier reassigns a tenant's (single) tier via gRPC. Optimistic: apply, then
  // revert on failure.
  const setTier = async (tenant: Tenant, tierId: string) => {
    if (tenant.tier?.id === tierId) return;
    const tier = allTiers.find((t) => t.id === tierId);
    if (!tier) return;
    const previous = tenant.tier ?? null;
    mutateTenant(tenant.id, (t) => ({ ...t, tier }));
    try {
      const res = await fetch(
        `/api/tenants/${encodeURIComponent(tenant.id)}/tier`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tierId }),
        },
      );
      if (!res.ok && res.status !== 204) throw new Error(await errorText(res));
      flash(`${tenant.name}: tier set to ${tier.name}`);
    } catch (e) {
      mutateTenant(tenant.id, (t) => ({ ...t, tier: previous }));
      flash(e instanceof Error ? e.message : "Failed to set tier", true);
    }
  };

  // toggleGroup attaches/detaches a tenant to a group via gRPC (idempotent).
  // Optimistic with revert; the local list stays name-sorted to match the server.
  const toggleGroup = async (
    tenant: Tenant,
    group: ClassificationLabel,
    add: boolean,
  ) => {
    const withGroup = (gs: ClassificationLabel[]) =>
      [...gs.filter((g) => g.id !== group.id), group].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    const withoutGroup = (gs: ClassificationLabel[]) =>
      gs.filter((g) => g.id !== group.id);
    mutateTenant(tenant.id, (t) => ({
      ...t,
      groups: add ? withGroup(t.groups ?? []) : withoutGroup(t.groups ?? []),
    }));
    try {
      const res = await fetch(
        `/api/tenants/${encodeURIComponent(tenant.id)}/groups/${encodeURIComponent(group.id)}`,
        { method: add ? "POST" : "DELETE" },
      );
      if (!res.ok && res.status !== 204) throw new Error(await errorText(res));
    } catch (e) {
      mutateTenant(tenant.id, (t) => ({
        ...t,
        groups: add ? withoutGroup(t.groups ?? []) : withGroup(t.groups ?? []),
      }));
      flash(e instanceof Error ? e.message : "Failed to update groups", true);
    }
  };

  // Per-tenant lifecycle serialization: each changeStatus call claims a
  // monotonically increasing token for the tenant. Only the most recent call may
  // revert or toast on completion, so a stale in-flight failure from a superseded
  // action can't clobber a newer optimistic update.
  const statusSeqRef = useRef<Map<string, number>>(new Map());

  // changeStatus drives a tenant's lifecycle (suspend / reactivate / soft-delete
  // / restore) via the gRPC-backed PUT. Optimistic with revert on failure —
  // e.g. Ogen rejects suspending/deleting the 'default' tenant with 409.
  const changeStatus = async (
    tenant: Tenant,
    target: TenantStatus,
    reason: string,
  ) => {
    const prevStatus = tenant.status;
    const prevReason = tenant.statusReason ?? "";
    const nextReason = target === "suspended" ? reason : "";
    // Past-tense verb for the toast, distinguishing reactivate vs restore.
    const verb =
      target === "suspended"
        ? "suspended"
        : target === "deleted"
          ? "deleted"
          : prevStatus === "deleted"
            ? "restored"
            : "reactivated";
    // Claim this tenant's latest-action token; isCurrent() stays true only while
    // no later status action has superseded this one.
    const token = (statusSeqRef.current.get(tenant.id) ?? 0) + 1;
    statusSeqRef.current.set(tenant.id, token);
    const isCurrent = () => statusSeqRef.current.get(tenant.id) === token;
    mutateTenant(tenant.id, (t) => ({
      ...t,
      status: target,
      statusReason: nextReason,
    }));
    try {
      const res = await fetch(
        `/api/tenants/${encodeURIComponent(tenant.id)}/status`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: target, reason: nextReason }),
        },
      );
      if (!res.ok && res.status !== 204) throw new Error(await errorText(res));
      if (isCurrent()) flash(`${tenant.name} ${verb}`);
    } catch (e) {
      // Only the latest action reverts, so a superseded failure can't undo a
      // newer optimistic update.
      if (isCurrent()) {
        mutateTenant(tenant.id, (t) => ({
          ...t,
          status: prevStatus,
          statusReason: prevReason,
        }));
        flash(e instanceof Error ? e.message : "Failed to change status", true);
      }
    }
  };

  // Keyboard row navigation (page-level, no click needed): j/k or ↓/↑ move the
  // highlighted row, o opens it. A row's "main link" is its tenant detail page.
  const router = useRouter();
  const { activeIndex, setActiveIndex, containerRef } = useRowKeyboardNav({
    count: rows.length,
    onOpen: (i) => {
      const t = rows[i];
      if (t) router.push(`/tenants/${encodeURIComponent(t.id)}`);
    },
  });

  const toggle = (t: Tenant) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(t.id)) {
        next.delete(t.id);
        return next;
      }
      next.add(t.id);
      // Lazy-load recent activity on first expand only.
      setActivity((cur) => {
        if (cur[t.id]) return cur;
        void fetch(`/api/tenants/${encodeURIComponent(t.id)}/activity`)
          .then((r) => {
            if (!r.ok) throw new Error(`request failed (${r.status})`);
            return r.json();
          })
          .then(
            (j: {
              activity: ActivityEvent[];
              available: boolean;
              error?: string;
            }) => {
              setActivity((c) => ({
                ...c,
                [t.id]: j.available
                  ? { loading: false, events: j.activity }
                  : { loading: false, error: j.error ?? "unavailable" },
              }));
            },
          )
          .catch((e: unknown) => {
            setActivity((c) => ({
              ...c,
              [t.id]: {
                loading: false,
                error: e instanceof Error ? e.message : "Failed to load",
              },
            }));
          });
        return { ...cur, [t.id]: { loading: true } };
      });
      return next;
    });
  };

  return (
    <div className="rounded-xl bg-primary">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-6 py-3">
        <h2 className="text-sm font-medium text-foreground">All tenants</h2>
        <div className="flex items-center gap-4">
          {spendAvailable && (
            <div className="flex items-center gap-3 text-[11px] text-tertiary-foreground">
              <Dot color="bg-orange-500" label="Anthropic" />
              <Dot color="bg-blue-500" label="Google" />
              <Dot color="bg-neutral-400" label="Other" />
            </div>
          )}
          {data?.available && (
            <span className="flex items-center gap-2 text-xs text-tertiary-foreground">
              {refreshing && <Loader className="size-3.5 border-[1.5px]" />}
              {filters.length > 0
                ? `${data.tenants.length} of ${data.total ?? data.tenants.length}`
                : `${data.total ?? data.tenants.length} total`}
            </span>
          )}
        </div>
      </div>

      {/* Power search / filter bar — kept outside the overflow-hidden
                results wrapper below so its dropdown can never be clipped. */}
      {data?.available && (data.total ?? 0) > 0 && (
        <div className="border-b border-border px-3 py-3">
          <TenantsFilterBar
            tokens={filters}
            onTokensChange={setFilters}
            statusOptions={statusOptions}
            tierOptions={allTiers.map((t) => t.name)}
            groupOptions={allGroups.map((g) => g.name)}
          />
        </div>
      )}

      <div className="overflow-hidden rounded-b-xl">
        {error || (data && !data.available) ? (
          <p className="p-6 text-sm text-tertiary-foreground">
            Tenants unavailable —{" "}
            {error || data?.error || "Ogen database not reachable"}
          </p>
        ) : !data ? (
          <SkeletonRows />
        ) : (data.total ?? data.tenants.length) === 0 ? (
          <p className="p-6 text-sm text-tertiary-foreground">No tenants</p>
        ) : data.tenants.length === 0 ? (
          <p className="p-6 text-sm text-tertiary-foreground">
            No tenants match the current filters.
          </p>
        ) : (
          <div ref={containerRef} className="divide-y divide-border">
            {/* header */}
            <div className={`${GRID} px-6 py-2.5`}>
              <span />
              <SortHeader label="Name" col="name" sort={sort} onSort={onSort} />
              <SortHeader
                label="Registered"
                col="createdAt"
                sort={sort}
                onSort={onSort}
              />
              <SortHeader
                label="Status"
                col="status"
                sort={sort}
                onSort={onSort}
              />
              <span className="flex items-center text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
                Groups
              </span>
              <SortHeader
                label="Users"
                col="users"
                sort={sort}
                onSort={onSort}
                align="right"
                accent
                className={METRIC_START}
                info="People with a user account in this tenant, from the Ogen control-plane database."
              />
              <SortHeader
                label="AI spend"
                col="spend"
                sort={sort}
                onSort={onSort}
                accent
                info="This tenant's AI model cost for the current billing period, from the Timescale analytics rollups. The bar splits spend by vendor — Anthropic, Google, and Other."
              />
              <SortHeader
                label="Zernio"
                col="zernio"
                sort={sort}
                onSort={onSort}
                align="right"
                accent
                info="Active social profiles this tenant has connected through Zernio."
              />
              <SortHeader
                label="R2"
                col="r2"
                sort={sort}
                onSort={onSort}
                align="right"
                accent
                info="Total size of this tenant's files stored in Cloudflare R2 object storage."
              />
              <span className="sr-only">Actions</span>
            </div>

            {/* rows */}
            {rows.map((t, i) => {
              const open = expanded.has(t.id);
              const isActive = i === activeIndex;
              return (
                <div key={t.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    data-row-index={i}
                    onClick={() => {
                      setActiveIndex(i);
                      toggle(t);
                    }}
                    onKeyDown={(e) => {
                      if (
                        e.target === e.currentTarget &&
                        (e.key === "Enter" || e.key === " ")
                      ) {
                        e.preventDefault();
                        toggle(t);
                      }
                    }}
                    aria-expanded={open}
                    className={cn(
                      `${GRID} w-full cursor-pointer px-6 py-3.5 text-left text-sm transition-colors hover:bg-secondary/40 focus-visible:bg-secondary/40 focus-visible:outline-none`,
                      open && "bg-secondary/40",
                      isActive &&
                        "bg-secondary shadow-[inset_2px_0_0_0_var(--foreground)]",
                    )}
                  >
                    <CaretRightIcon
                      weight="bold"
                      className={cn(
                        "size-4 text-tertiary-foreground transition-transform",
                        open && "rotate-90",
                      )}
                    />
                    <span className="min-w-0">
                      {/* The name links to the tenant detail page; stopPropagation
                          keeps the click from also toggling row expansion. The
                          tier chip sits inline, right of the name. */}
                      <span className="flex min-w-0 items-center gap-2">
                        <Link
                          href={`/tenants/${encodeURIComponent(t.id)}`}
                          onClick={(e) => e.stopPropagation()}
                          className="truncate font-medium text-foreground hover:underline"
                        >
                          {t.name}
                        </Link>
                        {t.tier && (
                          <LabelChip
                            label={t.tier.name}
                            color={t.tier.color}
                            className="shrink-0"
                          />
                        )}
                      </span>
                      <span className="block truncate font-mono text-xs text-tertiary-foreground">
                        {t.slug}
                      </span>
                    </span>
                    <span className="text-secondary-foreground">
                      {formatDate(t.createdAt)}
                    </span>

                    <StatusLabel status={t.status} reason={t.statusReason} />

                    <GroupsCell groups={t.groups ?? []} />

                    <span
                      className={cn("text-right text-foreground font-mono", METRIC_START)}
                    >
                      {t.users}
                    </span>
                    <SpendCell spend={t.spend} available={spendAvailable} />
                    <span className="text-right font-mono text-foreground">
                      {t.zernioProfiles}
                    </span>
                    <span className="text-right font-mono text-foreground">
                      {formatBytes(t.r2Bytes)}
                    </span>
                    <ActionsMenu
                      tenant={t}
                      allTiers={allTiers}
                      allGroups={allGroups}
                      onSetTier={setTier}
                      onToggleGroup={toggleGroup}
                      onStatusAction={(tenant, target) =>
                        setStatusAction({ tenant, target })
                      }
                    />
                  </div>
                  {open && <ExpandedPanel t={t} activity={activity[t.id]} />}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Lifecycle confirm/reason dialog, driven by the row Status submenu. */}
      <StatusDialog
        action={statusAction}
        onClose={() => setStatusAction(null)}
        onConfirm={(reason) => {
          if (statusAction) {
            void changeStatus(statusAction.tenant, statusAction.target, reason);
          }
          setStatusAction(null);
        }}
      />

      {/* Transient feedback for tier/group/status edits. */}
      {toast && (
        <div
          role="status"
          className={cn(
            "fixed bottom-6 right-6 z-[200] rounded-md border bg-primary px-4 py-2 text-sm shadow-xl",
            toast.error
              ? "border-destructive/30 text-destructive"
              : "border-border text-foreground",
          )}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}
