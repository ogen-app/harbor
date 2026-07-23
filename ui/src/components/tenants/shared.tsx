// Shared tenant types, formatters, and small presentational bits used by both
// the Tenants table and the per-tenant detail page (/tenants/[id]).

import { cn } from "@/lib/utils";
import { Loader } from "@/components/ui/loader";

// ── types ─────────────────────────────────────────────────────────────────────

export interface VendorSpend {
  anthropicMicros: number;
  googleMicros: number;
  otherMicros: number;
  totalMicros: number;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  status: string;
  users: number;
  zernioProfiles: number;
  r2Bytes: number;
  spend: VendorSpend;
}

export interface ActivityEvent {
  at: string;
  type: string;
  status: string;
  summary: string;
}

export interface ActivityDay {
  date: string;
  count: number;
}

export interface ActivityState {
  loading: boolean;
  error?: string;
  events?: ActivityEvent[];
  series?: ActivityDay[];
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

export function spendSegments(s: VendorSpend) {
  const total = s.totalMicros || 1;
  return [
    { pct: (s.anthropicMicros / total) * 100, className: "bg-orange-500" },
    { pct: (s.googleMicros / total) * 100, className: "bg-blue-500" },
    { pct: (s.otherMicros / total) * 100, className: "bg-neutral-400" },
  ];
}

// ── status ────────────────────────────────────────────────────────────────────

export const STATUS_COLOR: Record<string, string> = {
  active: "bg-emerald-500",
  trialing: "bg-blue-400",
  suspended: "bg-amber-500",
  churned: "bg-red-500",
};

export function StatusLabel({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
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

// RecentActivity renders a tenant's recent post_logs feed (the /activity
// endpoint), with soft loading / error / empty states.
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
            <p className="text-foreground">{e.summary || e.type}</p>
            {e.status && (
              <p className="text-tertiary-foreground">
                {e.type} → <span className="font-mono">{e.status}</span>
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
