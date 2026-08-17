// Shared tenant types, formatters, and small presentational bits used by both
// the Tenants table and the per-tenant detail page (/tenants/[id]).

import { cn } from "@/lib/utils";
import { HEX_RE, readableOn } from "@/lib/color";
import { Loader } from "@/components/ui/loader";

// ── types ─────────────────────────────────────────────────────────────────────

export interface VendorSpend {
  anthropicMicros: number;
  googleMicros: number;
  otherMicros: number;
  totalMicros: number;
}

// A tier (1 per tenant) or group (many) classification label. color is an
// optional "#RRGGBB" hex ("" = none). Read from the Ogen DB; edited over gRPC.
export interface ClassificationLabel {
  id: string;
  name: string;
  color: string;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  status: string;
  // Operator note recorded when a tenant is suspended (CON-190); "" otherwise.
  statusReason?: string;
  users: number;
  zernioProfiles: number;
  r2Bytes: number;
  spend: VendorSpend;
  // Classification (CON-208). tier is null when unassigned/unavailable; groups
  // is always an array (possibly empty).
  tier?: ClassificationLabel | null;
  groups?: ClassificationLabel[];
  // Trailing 30-day daily activity-event counts (oldest→newest) for the row
  // sparkline (CON-223). null/undefined when analytics is unavailable; a
  // zero-filled array when the tenant simply had no events.
  activity?: number[] | null;
}

export interface ActivityEvent {
  id: string;
  // The owning tenant. Always populated; used by the global Activity feed to
  // attribute each row and to load its detail (which is tenant-scoped).
  tenantId: string;
  at: string;
  category: string;
  type: string;
  status: string;
  source: string;
}

export interface ActivityDay {
  date: string;
  total: number;
  counts: Record<string, number>;
}

export interface ActivityState {
  loading: boolean;
  error?: string;
  events?: ActivityEvent[];
  series?: ActivityDay[];
  categories?: string[];
  // Whether older events remain past the first page (drives lazy-loading).
  hasMore?: boolean;
}

export interface TenantUser {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

export interface UsersState {
  loading: boolean;
  error?: string;
  users?: TenantUser[];
}

export interface ZernioAccount {
  id: string;
  platform: string;
  username: string;
  isActive: boolean;
  createdAt: string | null;
  totalPosts: number;
  scheduledPosts: number;
  publishedPosts: number;
  failedPosts: number;
  lastPostAt: string | null;
}

export interface ZernioState {
  loading: boolean;
  error?: string;
  accounts?: ZernioAccount[];
}

// ── formatters ────────────────────────────────────────────────────────────────

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatUSD(micros: number): string {
  const d = micros / 1e6;
  if (d === 0) return "$0.00";
  if (d < 1) return `$${d.toFixed(3)}`;
  if (d < 1000) return `$${d.toFixed(2)}`;
  return `$${(d / 1000).toFixed(1)}k`;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const v = bytes / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// ── status ────────────────────────────────────────────────────────────────────

// The tenant lifecycle enum (CON-190): active (green), suspended (amber),
// deleted (grey). Unknown values fall back to neutral.
export const STATUS_COLOR: Record<string, string> = {
  active: "bg-emerald-500",
  suspended: "bg-amber-500",
  deleted: "bg-neutral-400",
};

// StatusLabel is the dot + status name. When a reason is given (a suspended
// tenant's status_reason), it surfaces as a hover title so operators can see
// why without opening the row.
export function StatusLabel({
  status,
  reason,
}: {
  status: string;
  reason?: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs"
      title={reason || undefined}
    >
      <span
        className={cn(
          "size-2 rounded-full",
          STATUS_COLOR[status] ?? "bg-neutral-400",
        )}
      />
      <span className="capitalize text-secondary-foreground">{status}</span>
    </span>
  );
}

// ── classification chips (tiers & groups) ──────────────────────────────────────

// ColorDot is the small round swatch used in the tier/group edit menus.
export function ColorDot({ color }: { color: string }) {
  const has = HEX_RE.test(color);
  return (
    <span
      aria-hidden
      className={cn(
        "size-2.5 shrink-0 rounded-full border",
        has ? "border-black/10" : "border-quaternary",
      )}
      style={has ? { backgroundColor: color } : undefined}
    />
  );
}

// LabelChip is the all-rounded, color-branded pill for a tier or group. A valid
// hex fills the chip (with a readable text color); no color falls back to a
// neutral chip.
export function LabelChip({
  label,
  color,
  className,
}: {
  label: string;
  color: string;
  className?: string;
}) {
  const styled = HEX_RE.test(color);
  return (
    <span
      className={cn(
        "inline-flex max-w-40 items-center truncate rounded-lg px-1.5 py-1 text-[11px] font-semibold leading-none whitespace-nowrap",
        !styled && "bg-secondary text-secondary-foreground",
        className,
      )}
      style={styled ? { backgroundColor: color, color: readableOn(color) } : undefined}
      title={label}
    >
      {label}
    </span>
  );
}

// ── activity sparkline ──────────────────────────────────────────────────────────

// splinePath builds a smooth Catmull-Rom (tension 1/6) cubic-Bézier path through
// the points — the spline the activity sparkline draws. Endpoints duplicate their
// neighbour so the curve stays anchored at the first/last sample.
function splinePath(pts: [number, number][]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0][0]},${pts[0][1]}`;
  const d = [`M ${pts[0][0]},${pts[0][1]}`];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d.push(`C ${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${p2[1]}`);
  }
  return d.join(" ");
}

// Sparkline draws a tenant's recent daily-activity counts as a compact green
// spline. An all-zero series still renders a flat baseline (so the column reads
// as "no activity" rather than empty). The viewBox is unitless and stretched to
// fill the cell; non-scaling strokes keep the line an even width when stretched.
export function Sparkline({
  data,
  className,
}: {
  data: number[];
  className?: string;
}) {
  const W = 100;
  const H = 28;
  const PAD = 3; // vertical breathing room so peaks/baseline aren't clipped
  const n = data.length;
  const max = Math.max(1, ...data);
  const stepX = n > 1 ? W / (n - 1) : 0;
  const pts: [number, number][] = data.map((v, i) => [
    i * stepX,
    H - PAD - (v / max) * (H - PAD * 2),
  ]);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={cn("h-7 w-full text-emerald-500", className)}
      aria-hidden
    >
      <path
        d={splinePath(pts)}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

// ── detail bits ───────────────────────────────────────────────────────────────

export function DetailRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-tertiary-foreground">{label}</span>
      <span className="text-xs text-foreground">{value}</span>
    </div>
  );
}

// RecentActivity renders a tenant's recent activity feed (the /activity
// endpoint, sourced from tenant_activity_events), with soft loading / error / empty
// states. Used by the Tenants-table expanded row.
export function RecentActivity({ state }: { state: ActivityState | undefined }) {
  if (!state || state.loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-tertiary-foreground">
        <Loader className="size-3.5 border-[1.5px]" />
        Loading activity…
      </div>
    );
  }
  if (state.error) {
    return (
      <p className="text-xs text-tertiary-foreground">
        Activity unavailable — {state.error}
      </p>
    );
  }
  if (!state.events || state.events.length === 0) {
    return <p className="text-xs text-tertiary-foreground">No recent activity</p>;
  }
  return (
    <ul className="space-y-3">
      {state.events.map((e, i) => (
        <li key={i} className="flex gap-2.5 text-xs">
          <span className="mt-1 size-1.5 shrink-0 rounded-full bg-emerald-500" />
          <div className="min-w-0">
            <p className="tabular-nums text-tertiary-foreground">
              {formatDateTime(e.at)}
            </p>
            <p className="text-foreground">
              {e.type}
              {e.category && (
                <span className="text-tertiary-foreground"> · {e.category}</span>
              )}
            </p>
            {e.status && (
              <p className="text-tertiary-foreground">
                status: <span className="font-mono">{e.status}</span>
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
