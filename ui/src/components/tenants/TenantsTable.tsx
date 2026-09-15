"use client";

import {
  Fragment,
  type ComponentProps,
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  SquareSplitHorizontalIcon,
  CaretUpIcon,
  CaretDownIcon,
  CheckIcon,
  DotsSixVerticalIcon,
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
import { InfoIcon } from "@/components/dashboard/primitives";
import { Loader } from "@/components/ui/loader";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
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
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  TenantsFilterBar,
  type FilterToken,
} from "@/components/tenants/TenantsFilterBar";
import {
  type Tenant,
  type VendorSpend,
  type ClassificationLabel,
  formatDate,
  formatUSD,
  formatBytes,
  StatusLabel,
  LabelChip,
  ColorDot,
  Sparkline,
} from "@/components/tenants/shared";

// ── types ─────────────────────────────────────────────────────────────────────

interface TenantsResponse {
  tenants: Tenant[];
  available: boolean;
  spendAvailable?: boolean;
  // Whether the analytics activity hypertable was reachable — gates the
  // Activity sparkline column (CON-223).
  activityAvailable?: boolean;
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
  | "name"
  | "tier"
  | "createdAt"
  | "status"
  | "activity"
  | "users"
  | "spend"
  | "zernio"
  | "r2";
type SortDir = "asc" | "desc";

const sortValue = (t: Tenant, key: SortKey): string | number => {
  switch (key) {
    case "name":
      return t.name.toLowerCase();
    case "tier":
      return t.tier?.name.toLowerCase() ?? "";
    case "createdAt":
      return new Date(t.createdAt).getTime();
    case "status":
      return t.status;
    case "activity":
      return (t.activity ?? []).reduce((sum, n) => sum + n, 0);
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
  "tier",
  "createdAt",
  "status",
  "activity",
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

// ── layout & columns ────────────────────────────────────────────────────────────

// Every cell (header + body) carries its own padding rather than the grid using
// a `gap` (contiguous tracks let the frozen Name/Tier columns hide scrolling
// content cleanly — a gap leaves a see-through sliver) and its own *vertical*
// padding rather than the row (so each cell fills the full row height and the
// frozen backgrounds cover the whole cell). All columns are left-aligned.
const CELL_X = "px-3";
const ROW_PY = "py-3.5"; // body cell vertical padding
const HEAD_PY = "py-2.5"; // header cell vertical padding
// Card inset on the outer edges — on the (sticky) Name cell and the last cell.
const EDGE_L = "pl-6";
const EDGE_R = "pr-6";

// The two frozen columns are pinned during horizontal scroll and stay a fixed
// width so the pin offsets are deterministic: Tier sits exactly NAME_TRACK from
// the left. Their widths also feed the table's computed min-width.
const NAME_MIN = 12; // rem
const TIER_MIN = 8; // rem
const NAME_TRACK = `${NAME_MIN}rem`;
const TIER_TRACK = `${TIER_MIN}rem`;
// Literal (not a template) so Tailwind's JIT can see the class; keep == NAME_MIN.
const TIER_LEFT = "left-[12rem]";
// A soft right-edge shadow on the last frozen column, shown only while the table
// is scrolled, so content clearly reads as sliding underneath Name/Tier.
const FROZEN_SHADOW = "shadow-[6px_0_12px_-2px_rgba(0,0,0,0.18)]";

// Heatmap wash for the numeric columns (AI spend, Users, Zernio, R2): a green
// tint whose alpha scales with the cell's value relative to that column's max
// across the visible rows. All values are non-negative, so it's green-only and zero stays
// white (no wash). sqrt spreads the low end so a single large outlier doesn't
// flatten every other cell to near-white. A muted, slightly warm green with a
// gentle max alpha keeps the wash soft rather than a vivid emerald block.
const HEAT_RGB = "88, 166, 116"; // soft muted green
const HEAT_MAX_ALPHA = 0.38;
function heatStyle(value: number, max: number): CSSProperties | undefined {
  if (value <= 0 || max <= 0) return undefined;
  const t = Math.min(1, Math.sqrt(value / max));
  return {
    backgroundColor: `rgba(${HEAT_RGB}, ${(t * HEAT_MAX_ALPHA).toFixed(3)})`,
  };
}

// Toggleable, reorderable columns in default order (left→right). Name and Tier
// are static, always-on, frozen columns (rendered separately); the row actions
// menu is the always-on tail. Comfortable fixed widths give the columns air and
// make the table scroll horizontally rather than squish.
type ColumnKey =
  | "registered"
  | "status"
  | "groups"
  | "activity"
  | "users"
  | "spend"
  | "zernio"
  | "r2";

const COLUMN_KEYS: ColumnKey[] = [
  "registered",
  "status",
  "groups",
  "activity",
  "users",
  "spend",
  "zernio",
  "r2",
];

const COLUMN_LABEL: Record<ColumnKey, string> = {
  registered: "Registered",
  status: "Status",
  groups: "Groups",
  activity: "Activity",
  users: "Users",
  spend: "AI spend",
  zernio: "Zernio",
  r2: "R2",
};

const ACTIONS_MIN = 3.75; // rem — action button + right card inset
const ACTIONS_TRACK = `${ACTIONS_MIN}rem`;

// Content columns grow to fill the table width (1fr) but never shrink below a
// comfortable min. COLUMN_MIN (rem) also feeds the table's computed min-width so
// the row backgrounds still span the full width once the table has to scroll.
const COLUMN_MIN: Record<ColumnKey, number> = {
  registered: 9,
  status: 8,
  groups: 13,
  activity: 9,
  users: 7,
  spend: 8,
  zernio: 7,
  r2: 7,
};
const COLUMN_TRACK: Record<ColumnKey, string> = {
  registered: "minmax(9rem, 1fr)",
  status: "minmax(8rem, 1fr)",
  groups: "minmax(13rem, 1fr)",
  activity: "minmax(9rem, 1fr)",
  users: "minmax(7rem, 1fr)",
  spend: "minmax(8rem, 1fr)",
  zernio: "minmax(7rem, 1fr)",
  r2: "minmax(7rem, 1fr)",
};

// A column's persisted preference. Its position in the array is its display
// order (drag-to-reorder), and `visible` toggles it. Order and visibility
// persist together so both survive reloads / route changes.
interface ColumnPref {
  key: ColumnKey;
  visible: boolean;
}

const DEFAULT_COLUMN_PREFS: ColumnPref[] = COLUMN_KEYS.map((key) => ({
  key,
  visible: true,
}));

const COLUMN_PREFS_STORAGE_KEY = "harbor.tenants.columnPrefs";

// loadColumnPrefs reads the stored order + visibility, tolerating stale shapes:
// unknown/duplicate keys are dropped and any column missing from storage (e.g. a
// newly added one) is appended visible, so the set always covers COLUMN_KEYS.
function loadColumnPrefs(): ColumnPref[] {
  if (typeof window === "undefined") return DEFAULT_COLUMN_PREFS;
  try {
    const raw = window.localStorage.getItem(COLUMN_PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_COLUMN_PREFS;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_COLUMN_PREFS;
    const valid = new Set<ColumnKey>(COLUMN_KEYS);
    const seen = new Set<ColumnKey>();
    const prefs: ColumnPref[] = [];
    for (const entry of parsed) {
      const key = (entry as { key?: unknown })?.key;
      if (typeof key !== "string" || !valid.has(key as ColumnKey)) continue;
      if (seen.has(key as ColumnKey)) continue;
      seen.add(key as ColumnKey);
      prefs.push({
        key: key as ColumnKey,
        visible: (entry as { visible?: unknown })?.visible !== false,
      });
    }
    for (const key of COLUMN_KEYS) {
      if (!seen.has(key)) prefs.push({ key, visible: true });
    }
    return prefs;
  } catch {
    return DEFAULT_COLUMN_PREFS;
  }
}

// ColumnSwitch is a small accessible on/off toggle (no external dependency),
// styled to the app tokens: black track when on, beige when off, white knob with
// a check when on.
// Thin alias kept so the ColumnSelector call sites read the same; the switch
// itself is the shared ui/switch component.
function ColumnSwitch(props: ComponentProps<typeof Switch>) {
  return <Switch {...props} />;
}

// ColumnSelector is the "Edit columns" popover: a drag-to-reorder list of the
// table columns, each with an on/off switch. Order + visibility persist via the
// parent. At least one column must stay visible, so the last-on switch is locked.
// A Popover (not a menu) is used so native drag-and-drop isn't fighting the
// menu's keyboard/pointer semantics.
function ColumnSelector({
  prefs,
  onChange,
}: {
  prefs: ColumnPref[];
  onChange: (next: ColumnPref[]) => void;
}) {
  const [dragKey, setDragKey] = useState<ColumnKey | null>(null);
  const visibleCount = prefs.filter((p) => p.visible).length;

  const setVisible = (key: ColumnKey, visible: boolean) =>
    onChange(prefs.map((p) => (p.key === key ? { ...p, visible } : p)));

  // Move `from` into `to`'s slot. Driven by drag-enter (fires once per row
  // entered) rather than drag-over, so the list reorders live without the
  // per-frame thrash a drag-over handler would cause.
  const move = (from: ColumnKey, to: ColumnKey) => {
    if (from === to) return;
    const fromIdx = prefs.findIndex((p) => p.key === from);
    const toIdx = prefs.findIndex((p) => p.key === to);
    if (fromIdx === -1 || toIdx === -1) return;
    const next = [...prefs];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    onChange(next);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Choose columns"
          className="h-[42px] shrink-0 gap-2 text-tertiary-foreground"
        >
          <SquareSplitHorizontalIcon className="size-4" />
          <span className="hidden sm:inline">Columns</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-64 p-2">
        <div className="px-1.5 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-wide text-tertiary-foreground">
          Edit columns
        </div>
        <div className="space-y-1">
          {prefs.map((p) => {
            const locked = p.visible && visibleCount === 1;
            return (
              <div
                key={p.key}
                draggable
                onDragStart={(e) => {
                  setDragKey(p.key);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnter={() => dragKey && move(dragKey, p.key)}
                onDragOver={(e) => e.preventDefault()}
                onDragEnd={() => setDragKey(null)}
                className={cn(
                  "flex items-center gap-2 rounded-md bg-secondary py-2 pl-1.5 pr-2.5 transition-opacity",
                  dragKey === p.key && "opacity-40",
                )}
              >
                <DotsSixVerticalIcon
                  weight="bold"
                  className="size-4 shrink-0 cursor-grab text-tertiary-foreground active:cursor-grabbing"
                />
                <span className="flex-1 truncate text-sm text-foreground">
                  {COLUMN_LABEL[p.key]}
                </span>
                <ColumnSwitch
                  checked={p.visible}
                  disabled={locked}
                  onChange={(v) => setVisible(p.key, v)}
                  label={`Toggle ${COLUMN_LABEL[p.key]} column`}
                />
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

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
// One authorable tier version, and the versions grouped under their tier — used
// by the row menu's "Version" picker (SetTenantTierVersion). Fetched from
// /api/tier-entitlements.
type TierVersionOption = { id: string; version: number; status: string };
type TierVersionGroup = {
  tierId: string;
  tierName: string;
  tierColor: string;
  versions: TierVersionOption[];
};

function ActionsMenu({
  tenant,
  allTiers,
  allGroups,
  tierVersions,
  onSetTier,
  onSetTierVersion,
  onToggleGroup,
  onStatusAction,
}: {
  tenant: Tenant;
  allTiers: ClassificationLabel[];
  allGroups: ClassificationLabel[];
  tierVersions: TierVersionGroup[];
  onSetTier: (tenant: Tenant, tierId: string) => void;
  onSetTierVersion: (
    tenant: Tenant,
    tierId: string,
    version: TierVersionOption,
  ) => void;
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
        className="min-w-52"
      >
        <DropdownMenuItem asChild>
          <Link href={`/tenants/${encodeURIComponent(tenant.id)}`}>
            <ArrowSquareOutIcon className="size-4" />
            View details
          </Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {/* Lifecycle status (CON-190): suspend / reactivate / soft-delete /
            restore. Which transitions are offered depends on the current status;
            each opens a confirm dialog (suspend also captures a reason). */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <PulseIcon className="size-4" />
            Status
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            onClick={(e) => e.stopPropagation()}
            className="min-w-52"
          >
            <div className="flex items-center gap-2 px-3 py-2">
              <span className="text-[11px] uppercase tracking-wide text-tertiary-foreground">
                Current
              </span>
              <StatusLabel status={status} reason={tenant.statusReason} />
            </div>
            <DropdownMenuSeparator />

            {status !== "active" && (
              <DropdownMenuItem
                onSelect={() => onStatusAction(tenant, "active")}
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
              >
                <PauseIcon className="size-4" />
                Suspend…
              </DropdownMenuItem>
            )}

            {status !== "deleted" && !protectedTenant && (
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => onStatusAction(tenant, "deleted")}
              >
                <TrashIcon className="size-4" />
                Delete…
              </DropdownMenuItem>
            )}

            {protectedTenant && status === "active" && (
              <div className="px-3 py-2 text-xs text-tertiary-foreground">
                Protected tenant
              </div>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {(allTiers.length > 0 || allGroups.length > 0) && (
          <DropdownMenuSeparator />
        )}

        {/* Tier / Version: pick a tier (coarse, SetTenantTier) or one of its
            specific versions (SetTenantTierVersion). Both write tenants.tier_id,
            so the tier pointer updates either way. The current tier is checked. */}
        {allTiers.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <StackIcon className="size-4" />
              Tier / Version
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              onClick={(e) => e.stopPropagation()}
              className="max-h-80 min-w-56 overflow-y-auto"
            >
              {allTiers.map((t) => {
                const versions =
                  tierVersions.find((tv) => tv.tierId === t.id)?.versions ?? [];
                const onTier = tenant.tier?.id === t.id;
                // The tier row is checked only when the tenant is on this tier
                // with NO versioned assignment; otherwise the exact version is.
                const tierChecked = onTier && !tenant.tierVersion;
                return (
                  <Fragment key={t.id}>
                    <DropdownMenuItem
                      onSelect={() => onSetTier(tenant, t.id)}
                      className="font-medium"
                    >
                      <ColorDot color={t.color} />
                      <span className="flex-1 truncate">{t.name}</span>
                      {tierChecked && (
                        <CheckIcon
                          weight="bold"
                          className="size-3.5 shrink-0 text-foreground"
                        />
                      )}
                    </DropdownMenuItem>
                    {versions.map((v) => {
                      const versionChecked =
                        onTier && tenant.tierVersion?.version === v.version;
                      return (
                        <DropdownMenuItem
                          key={v.id}
                          onSelect={() => onSetTierVersion(tenant, t.id, v)}
                          className="pl-8 text-secondary-foreground"
                        >
                          <span className="flex-1">
                            v{v.version}
                            {v.status !== "active" && (
                              <span className="text-tertiary-foreground">
                                {" · "}
                                {v.status}
                              </span>
                            )}
                          </span>
                          {versionChecked && (
                            <CheckIcon
                              weight="bold"
                              className="size-3.5 shrink-0 text-foreground"
                            />
                          )}
                        </DropdownMenuItem>
                      );
                    })}
                  </Fragment>
                );
              })}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}

        {allGroups.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <UsersThreeIcon className="size-4" />
              Groups
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              onClick={(e) => e.stopPropagation()}
              className="max-h-72 min-w-52 overflow-y-auto"
            >
              {allGroups.map((g) => (
                <DropdownMenuCheckboxItem
                  key={g.id}
                  checked={memberIds.has(g.id)}
                  onCheckedChange={(checked) =>
                    onToggleGroup(tenant, g, checked === true)
                  }
                  onSelect={(e) => e.preventDefault()}
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

// ── metric cells ──────────────────────────────────────────────────────────────

// SpendCell shows the tenant's current-period AI spend as a left-aligned mono
// figure (CON-223 dropped the per-vendor bar — numbers only).
function SpendCell({
  spend,
  available,
}: {
  spend: VendorSpend;
  available: boolean;
}) {
  if (!available) {
    return <span className="font-mono text-xs text-tertiary-foreground">—</span>;
  }
  if (spend.totalMicros === 0) {
    return (
      <span className="font-mono text-xs text-tertiary-foreground">$0.00</span>
    );
  }
  return (
    <span className="font-mono text-foreground">
      {formatUSD(spend.totalMicros)}
    </span>
  );
}

// SparkCell renders a tenant's 30-day activity sparkline, or a dash when
// analytics is unavailable or there's no series. A hover title surfaces the
// month's action total.
function SparkCell({
  data,
  available,
}: {
  data?: number[] | null;
  available: boolean;
}) {
  if (!available || !data || data.length === 0) {
    return <span className="text-xs text-tertiary-foreground">—</span>;
  }
  const total = data.reduce((sum, n) => sum + n, 0);
  return (
    <span
      className="block min-w-0"
      title={`${total} action${total === 1 ? "" : "s"} in the last 30 days`}
    >
      <Sparkline data={data} />
    </span>
  );
}

// ── skeleton ──────────────────────────────────────────────────────────────────

function SkeletonRows({
  gridTemplate,
  cols,
}: {
  gridTemplate: string;
  cols: number;
}) {
  return (
    <div className="w-full divide-y divide-border">
      {Array.from({ length: 6 }).map((_, r) => (
        <div
          key={r}
          className="grid items-center"
          style={{ gridTemplateColumns: gridTemplate }}
        >
          {Array.from({ length: cols }).map((_unused, c) => (
            <div key={c} className={cn(CELL_X, ROW_PY, "min-w-0")}>
              <div className="h-3 w-full max-w-24 animate-pulse rounded bg-secondary" />
            </div>
          ))}
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
  // Preferences start as the server-rendered defaults and are hydrated from
  // localStorage in a mount effect below. Reading storage in the initializer
  // would diverge from the SSR markup (window is undefined on the server) and
  // trip a hydration mismatch whenever a saved preference isn't the default.
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [filters, setFilters] = useState<FilterToken[]>([]);
  const [columnPrefs, setColumnPrefs] =
    useState<ColumnPref[]>(DEFAULT_COLUMN_PREFS);
  // Gates the persistence effects so the initial defaults don't overwrite the
  // stored preferences before the mount effect has loaded them.
  const [prefsHydrated, setPrefsHydrated] = useState(false);
  // True once the table is scrolled off its left edge — shows the frozen-column
  // edge shadow only while content is actually sliding under Name/Tier.
  const [scrolled, setScrolled] = useState(false);
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(
    null,
  );
  // Authorable tier versions for the row menu's Version picker.
  const [tierVersions, setTierVersions] = useState<TierVersionGroup[]>([]);
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

  // The authorable tier versions (for the row menu's Version picker). Loaded
  // once from the tier-entitlements matrix; degrades silently if unavailable.
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/tier-entitlements", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          j: {
            available?: boolean;
            tiers?: {
              tierId: string;
              tierName: string;
              tierColor: string;
              versions?: { id: string; version: number; status: string }[];
            }[];
          } | null,
        ) => {
          if (!j?.available) return;
          const groups = (j.tiers ?? [])
            .map((t) => ({
              tierId: t.tierId,
              tierName: t.tierName,
              tierColor: t.tierColor,
              versions: [...(t.versions ?? [])]
                .sort((a, b) => a.version - b.version)
                .map((v) => ({
                  id: v.id,
                  version: v.version,
                  status: v.status,
                })),
            }))
            .filter((t) => t.versions.length > 0);
          setTierVersions(groups);
        },
      )
      .catch(() => {});
    return () => controller.abort();
  }, []);

  // Load the persisted preferences once on the client, after hydration, so the
  // first render still matches the server (defaults) and no mismatch is logged.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSort(loadSort());
    setColumnPrefs(loadColumnPrefs());
    setPrefsHydrated(true);
  }, []);

  // Persist the sort preference so it survives reloads / route changes. Held
  // back until the stored value has been loaded (see prefsHydrated above).
  useEffect(() => {
    if (!prefsHydrated) return;
    try {
      window.localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sort));
    } catch {
      // storage unavailable (private mode / quota) — preference is best-effort
    }
  }, [sort, prefsHydrated]);

  // Persist the column order + visibility choice the same way.
  useEffect(() => {
    if (!prefsHydrated) return;
    try {
      window.localStorage.setItem(
        COLUMN_PREFS_STORAGE_KEY,
        JSON.stringify(columnPrefs),
      );
    } catch {
      // storage unavailable — best-effort
    }
  }, [columnPrefs, prefsHydrated]);

  // The persisted order (filtered to visible) drives the grid template. The two
  // frozen columns (Name, Tier) lead; the toggleable middle set follows in its
  // saved order; the actions menu is the tail.
  const orderedColumns = columnPrefs.filter((p) => p.visible).map((p) => p.key);
  const gridTemplate = [
    NAME_TRACK,
    TIER_TRACK,
    ...orderedColumns.map((k) => COLUMN_TRACK[k]),
    ACTIONS_TRACK,
  ].join(" ");
  // The content columns are 1fr so they fill the table on wide screens; this
  // min-width (sum of every visible column's min) keeps the row backgrounds
  // spanning the full width once the table is narrow enough to scroll.
  const tableMinWidth = `${
    NAME_MIN +
    TIER_MIN +
    ACTIONS_MIN +
    orderedColumns.reduce((sum, k) => sum + COLUMN_MIN[k], 0)
  }rem`;

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

  // Column maxima for the numeric heatmap (AI spend / Users / Zernio / R2), over
  // the current result set so the shading reflects what's on screen.
  const heatMax = useMemo(() => {
    let spend = 0;
    let users = 0;
    let zernio = 0;
    let r2 = 0;
    for (const t of rows) {
      if (t.spend.totalMicros > spend) spend = t.spend.totalMicros;
      if (t.users > users) users = t.users;
      if (t.zernioProfiles > zernio) zernio = t.zernioProfiles;
      if (t.r2Bytes > r2) r2 = t.r2Bytes;
    }
    return { spend, users, zernio, r2 };
  }, [rows]);

  const spendAvailable = data?.spendAvailable ?? false;
  const activityAvailable = data?.activityAvailable ?? false;

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
    // Only skip when the tenant is ALREADY in the plain-tier state: this tier
    // and no pinned version. A tenant on a *version* of this same tier still
    // needs the request so picking the plain tier drops the version pin.
    if (tenant.tier?.id === tierId && !tenant.tierVersion) return;
    const tier = allTiers.find((t) => t.id === tierId);
    if (!tier) return;
    const previous = tenant.tier ?? null;
    const previousVersion = tenant.tierVersion ?? null;
    // Selecting a plain tier drops any pinned version — reflect both optimistically
    // (Ogen's SetTenantTier reassigns the coarse tier), and restore both on failure.
    mutateTenant(tenant.id, (t) => ({ ...t, tier, tierVersion: null }));
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
      mutateTenant(tenant.id, (t) => ({
        ...t,
        tier: previous,
        tierVersion: previousVersion,
      }));
      flash(e instanceof Error ? e.message : "Failed to set tier", true);
    }
  };

  // setTierVersion pins a tenant to a specific tier version
  // (SetTenantTierVersion). Optimistic on the denormalised tier (the assignment
  // updates tenants.tier_id in the same transaction); reverts on failure.
  const setTierVersion = async (
    tenant: Tenant,
    tierId: string,
    version: TierVersionOption,
  ) => {
    const tier = allTiers.find((t) => t.id === tierId);
    const prevTier = tenant.tier ?? null;
    const prevVersion = tenant.tierVersion ?? null;
    // Optimistic: reflect both the tier chip and the version (the Tier column +
    // the menu checkmark) immediately; revert on failure.
    mutateTenant(tenant.id, (t) => ({
      ...t,
      tier: tier ?? t.tier,
      tierVersion: { version: version.version, status: version.status },
    }));
    try {
      const res = await fetch(
        `/api/tier-entitlements/tenants/${encodeURIComponent(tenant.id)}/version`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          // A manual operator assignment; "upgrade" is a valid audit reason.
          body: JSON.stringify({ tierVersionId: version.id, reason: "upgrade" }),
        },
      );
      if (!res.ok && res.status !== 204) throw new Error(await errorText(res));
      flash(
        `${tenant.name}: set to ${tier?.name ?? "tier"} v${version.version}`,
      );
    } catch (e) {
      mutateTenant(tenant.id, (t) => ({
        ...t,
        tier: prevTier,
        tierVersion: prevVersion,
      }));
      flash(e instanceof Error ? e.message : "Failed to set version", true);
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

  // Clicking a row navigates to the tenant detail page (CON-223 removed the
  // inline expand — that detail lives on dedicated pages now).
  const openTenant = (t: Tenant) =>
    router.push(`/tenants/${encodeURIComponent(t.id)}`);

  // Per-column header / cell renderers, so both the header row and the body rows
  // map over the (reorderable) visible-column list from one source of truth. Each
  // returns a padded, left-aligned grid item (CELL_X); numeric columns keep a
  // mono figure but are no longer right-aligned.
  const headerFor = (key: ColumnKey) => {
    const inner = (() => {
      switch (key) {
        case "registered":
          return (
            <SortHeader label="Registered" col="createdAt" sort={sort} onSort={onSort} />
          );
        case "status":
          return <SortHeader label="Status" col="status" sort={sort} onSort={onSort} />;
        case "groups":
          return (
            <span className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
              Groups
            </span>
          );
        case "activity":
          return (
            <SortHeader
              label="Activity"
              col="activity"
              sort={sort}
              onSort={onSort}
              info="Daily tenant actions over the last 30 days, from the analytics activity events. Higher, spikier lines mean more recent activity."
            />
          );
        case "users":
          return (
            <SortHeader
              label="Users"
              col="users"
              sort={sort}
              onSort={onSort}
              info="People with a user account in this tenant, from the Ogen control-plane database."
            />
          );
        case "spend":
          return (
            <SortHeader
              label="AI spend"
              col="spend"
              sort={sort}
              onSort={onSort}
              info="This tenant's AI model cost for the current billing period, from the Timescale analytics rollups."
            />
          );
        case "zernio":
          return (
            <SortHeader
              label="Zernio"
              col="zernio"
              sort={sort}
              onSort={onSort}
              info="Active social profiles this tenant has connected through Zernio."
            />
          );
        case "r2":
          return (
            <SortHeader
              label="R2"
              col="r2"
              sort={sort}
              onSort={onSort}
              info="Total size of this tenant's files stored in Cloudflare R2 object storage."
            />
          );
      }
    })();
    return (
      <div key={key} className={cn(CELL_X, HEAD_PY, "flex min-w-0 items-center")}>
        {inner}
      </div>
    );
  };

  const cellFor = (key: ColumnKey, t: Tenant) => {
    // AI spend / Users / Zernio / R2 get a green heatmap wash keyed to the
    // column max.
    let heat: CSSProperties | undefined;
    const inner = (() => {
      switch (key) {
        case "registered":
          return (
            <span className="truncate text-secondary-foreground">
              {formatDate(t.createdAt)}
            </span>
          );
        case "status":
          return <StatusLabel status={t.status} reason={t.statusReason} />;
        case "groups":
          return <GroupsCell groups={t.groups ?? []} />;
        case "activity":
          return <SparkCell data={t.activity} available={activityAvailable} />;
        case "users":
          heat = heatStyle(t.users, heatMax.users);
          return <span className="font-mono text-foreground">{t.users}</span>;
        case "spend":
          if (spendAvailable) heat = heatStyle(t.spend.totalMicros, heatMax.spend);
          return <SpendCell spend={t.spend} available={spendAvailable} />;
        case "zernio":
          heat = heatStyle(t.zernioProfiles, heatMax.zernio);
          return (
            <span className="font-mono text-foreground">{t.zernioProfiles}</span>
          );
        case "r2":
          heat = heatStyle(t.r2Bytes, heatMax.r2);
          return (
            <span className="font-mono text-foreground">
              {formatBytes(t.r2Bytes)}
            </span>
          );
      }
    })();
    return (
      <div
        key={key}
        className={cn(CELL_X, ROW_PY, "flex min-w-0 items-center")}
        style={heat}
      >
        {inner}
      </div>
    );
  };

  return (
    <div className="rounded-xl bg-primary">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-6 py-3">
        <h2 className="text-sm font-medium text-foreground">All tenants</h2>
        {data?.available && (
          <span className="flex items-center gap-2 text-xs text-tertiary-foreground">
            {refreshing && <Loader className="size-3.5 border-[1.5px]" />}
            {filters.length > 0
              ? `${data.tenants.length} of ${data.total ?? data.tenants.length}`
              : `${data.total ?? data.tenants.length} total`}
          </span>
        )}
      </div>

      {/* Power search / filter bar + column selector, in one row — kept outside
          the horizontally-scrolling results wrapper below so the filter dropdown
          and the column menu can never be clipped. */}
      {data?.available && (data.total ?? 0) > 0 && (
        <div className="flex items-start gap-2 border-b border-border px-3 py-3">
          <div className="min-w-0 flex-1">
            <TenantsFilterBar
              tokens={filters}
              onTokensChange={setFilters}
              statusOptions={statusOptions}
              tierOptions={allTiers.map((t) => t.name)}
              groupOptions={allGroups.map((g) => g.name)}
            />
          </div>
          <ColumnSelector prefs={columnPrefs} onChange={setColumnPrefs} />
        </div>
      )}

      {/* overflow-x-auto lets the table scroll sideways when its columns are
          wider than the viewport; the frozen Name/Tier block stays pinned, and
          its right-edge shadow shows only while the content is scrolled. */}
      <div
        className="overflow-x-auto rounded-b-xl"
        onScroll={(e) => setScrolled(e.currentTarget.scrollLeft > 0)}
      >
        {error || (data && !data.available) ? (
          <p className="p-6 text-sm text-tertiary-foreground">
            Tenants unavailable —{" "}
            {error || data?.error || "Ogen database not reachable"}
          </p>
        ) : !data ? (
          <SkeletonRows
            gridTemplate={gridTemplate}
            cols={orderedColumns.length + 3}
          />
        ) : (data.total ?? data.tenants.length) === 0 ? (
          <p className="p-6 text-sm text-tertiary-foreground">No tenants</p>
        ) : data.tenants.length === 0 ? (
          <p className="p-6 text-sm text-tertiary-foreground">
            No tenants match the current filters.
          </p>
        ) : (
          // w-full fills the card so the content columns (1fr) spread to the
          // full width; minWidth keeps the row backgrounds spanning everything
          // once the viewport is narrow enough that the table has to scroll.
          <div
            ref={containerRef}
            className="w-full divide-y divide-border"
            style={{ minWidth: tableMinWidth }}
          >
            {/* header — Name and Tier are frozen (sticky) at the left. Cells
                stretch to the full row height (grid default) so the frozen
                backgrounds + shadow cover the whole cell, not just the text. */}
            <div
              className="grid w-full"
              style={{ gridTemplateColumns: gridTemplate }}
            >
              <div
                className={cn(
                  "sticky left-0 z-20 flex min-w-0 items-center bg-primary",
                  EDGE_L,
                  "pr-3",
                  HEAD_PY,
                )}
              >
                <SortHeader label="Name" col="name" sort={sort} onSort={onSort} />
              </div>
              <div
                className={cn(
                  "sticky z-20 flex min-w-0 items-center bg-primary",
                  TIER_LEFT,
                  CELL_X,
                  HEAD_PY,
                  scrolled && FROZEN_SHADOW,
                )}
              >
                <SortHeader label="Tier" col="tier" sort={sort} onSort={onSort} />
              </div>
              {orderedColumns.map((k) => headerFor(k))}
              <span className="sr-only">Actions</span>
            </div>

            {/* rows */}
            {rows.map((t, i) => {
              const isActive = i === activeIndex;
              return (
                <div
                  key={t.id}
                  role="button"
                  tabIndex={0}
                  data-row-index={i}
                  onClick={() => {
                    setActiveIndex(i);
                    openTenant(t);
                  }}
                  onKeyDown={(e) => {
                    if (
                      e.target === e.currentTarget &&
                      (e.key === "Enter" || e.key === " ")
                    ) {
                      e.preventDefault();
                      openTenant(t);
                    }
                  }}
                  className={cn(
                    "group grid w-full cursor-pointer text-left text-sm transition-colors hover:bg-secondary focus-visible:bg-secondary focus-visible:outline-none",
                    isActive && "bg-secondary",
                  )}
                  style={{ gridTemplateColumns: gridTemplate }}
                >
                  {/* Name + Tier are frozen (sticky) at the left; their opaque bg
                      fills the whole cell (flex, full row height) so scrolled
                      content passes cleanly under, and tracks the row state via
                      group-hover. The Name link stops propagation so it doesn't
                      double up with the row's navigation (both open the detail). */}
                  <div
                    className={cn(
                      "sticky left-0 z-10 flex min-w-0 flex-col justify-center bg-primary transition-colors group-hover:bg-secondary group-focus-visible:bg-secondary",
                      EDGE_L,
                      "pr-3",
                      ROW_PY,
                      isActive &&
                        "bg-secondary shadow-[inset_2px_0_0_0_var(--foreground)]",
                    )}
                  >
                    <Link
                      href={`/tenants/${encodeURIComponent(t.id)}`}
                      onClick={(e) => e.stopPropagation()}
                      className="block truncate font-medium text-foreground hover:underline"
                    >
                      {t.name}
                    </Link>
                    <span className="block truncate font-mono text-xs text-tertiary-foreground">
                      {t.slug}
                    </span>
                  </div>

                  <div
                    className={cn(
                      "sticky z-10 flex min-w-0 items-center bg-primary transition-colors group-hover:bg-secondary group-focus-visible:bg-secondary",
                      TIER_LEFT,
                      CELL_X,
                      ROW_PY,
                      isActive && "bg-secondary",
                      scrolled && FROZEN_SHADOW,
                    )}
                  >
                    {t.tier ? (
                      <span className="flex min-w-0 items-center gap-1.5">
                        <LabelChip label={t.tier.name} color={t.tier.color} />
                        {t.tierVersion && (
                          <span className="shrink-0 text-xs tabular-nums text-tertiary-foreground">
                            v{t.tierVersion.version}
                            {t.tierVersion.status !== "active" &&
                              ` / ${t.tierVersion.status}`}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-xs text-tertiary-foreground">—</span>
                    )}
                  </div>

                  {orderedColumns.map((k) => cellFor(k, t))}

                  <div
                    className={cn("flex items-center justify-end", EDGE_R, ROW_PY)}
                  >
                    <ActionsMenu
                      tenant={t}
                      allTiers={allTiers}
                      allGroups={allGroups}
                      tierVersions={tierVersions}
                      onSetTier={setTier}
                      onSetTierVersion={setTierVersion}
                      onToggleGroup={toggleGroup}
                      onStatusAction={(tenant, target) =>
                        setStatusAction({ tenant, target })
                      }
                    />
                  </div>
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
