"use client";

import { useEffect, useMemo, useState } from "react";
import { CaretRightIcon, CaretUpIcon, CaretDownIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Bar, Dot } from "@/components/dashboard/primitives";
import { Loader } from "@/components/ui/loader";

// ── types ─────────────────────────────────────────────────────────────────────

interface VendorSpend {
    anthropicMicros: number;
    googleMicros: number;
    otherMicros: number;
    totalMicros: number;
}
interface Tenant {
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
interface TenantsResponse {
    tenants: Tenant[];
    available: boolean;
    spendAvailable?: boolean;
    error?: string;
}

interface ActivityEvent {
    at: string;
    type: string;
    status: string;
    summary: string;
}
interface ActivityState {
    loading: boolean;
    error?: string;
    events?: ActivityEvent[];
}

// ── formatters ────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
    });
}

function formatDateTime(iso: string): string {
    return new Date(iso).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function formatUSD(micros: number): string {
    const d = micros / 1e6;
    if (d === 0) return "$0.00";
    if (d < 1) return `$${d.toFixed(3)}`;
    if (d < 1000) return `$${d.toFixed(2)}`;
    return `$${(d / 1000).toFixed(1)}k`;
}

function formatBytes(bytes: number): string {
    if (bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(
        Math.floor(Math.log(bytes) / Math.log(1024)),
        units.length - 1,
    );
    const v = bytes / Math.pow(1024, i);
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function spendSegments(s: VendorSpend) {
    const total = s.totalMicros || 1;
    return [
        { pct: (s.anthropicMicros / total) * 100, className: "bg-orange-500" },
        { pct: (s.googleMicros / total) * 100, className: "bg-blue-500" },
        { pct: (s.otherMicros / total) * 100, className: "bg-neutral-400" },
    ];
}

// ── sorting ───────────────────────────────────────────────────────────────────

type SortKey =
    | "name"
    | "createdAt"
    | "status"
    | "users"
    | "spend"
    | "zernio"
    | "r2";
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
// chevron · name · registered · status ‖ users · AI spend · Zernio · R2.
// The last four (metrics) are the visually distinctive set.
const GRID =
    "grid grid-cols-[2rem_minmax(140px,1.6fr)_1fr_0.9fr_0.7fr_minmax(120px,1.4fr)_0.8fr_0.9fr] items-center gap-4";

const METRIC_START = "border-l border-border pl-4"; // divider before the metric group

// ── column headers ────────────────────────────────────────────────────────────

function SortHeader({
    label,
    col,
    sort,
    onSort,
    align = "left",
    className,
    accent,
}: {
    label: string;
    col: SortKey;
    sort: { key: SortKey; dir: SortDir };
    onSort: (k: SortKey) => void;
    align?: "left" | "right";
    className?: string;
    accent?: boolean;
}) {
    const active = sort.key === col;
    return (
        <button
            type="button"
            onClick={() => onSort(col)}
            className={cn(
                "flex items-center gap-1 text-xs font-semibold uppercase tracking-wide transition-colors",
                align === "right" && "justify-end",
                accent ? "text-foreground" : "text-tertiary-foreground",
                "hover:text-foreground",
                className,
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
    );
}

// ── status ────────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
    active: "bg-emerald-500",
    trialing: "bg-blue-400",
    suspended: "bg-amber-500",
    churned: "bg-red-500",
};

function StatusLabel({ status }: { status: string }) {
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

// ── recent activity (expanded panel) ──────────────────────────────────────────

function RecentActivity({ state }: { state: ActivityState | undefined }) {
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

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-tertiary-foreground">{label}</span>
            <span className="text-xs text-foreground">{value}</span>
        </div>
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
        <div className="grid gap-8 bg-secondary/40 px-6 py-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <div className="space-y-2">
                <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
                    Details
                </h4>
                <DetailRow label="Tenant ID" value={<span className="font-mono">{t.id}</span>} />
                <DetailRow label="Slug" value={<span className="font-mono">{t.slug}</span>} />
                <DetailRow label="Registered" value={formatDate(t.createdAt)} />
                <DetailRow label="Users" value={<span className="tabular-nums">{t.users}</span>} />
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
                    value={<span className="tabular-nums">{formatUSD(t.spend.totalMicros)}</span>}
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
        return <span className="text-xs text-tertiary-foreground font-display">$0.00</span>;
    }
    return (
        <div className="min-w-0">
            <span className="text-xs font-display text-foreground">
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
                    <div className="h-3 w-8 animate-pulse rounded bg-secondary justify-self-end" />
                    <div className="h-3 w-full animate-pulse rounded bg-secondary" />
                    <div className="h-3 w-10 animate-pulse rounded bg-secondary justify-self-end" />
                    <div className="h-3 w-12 animate-pulse rounded bg-secondary justify-self-end" />
                </div>
            ))}
        </div>
    );
}

// ── main ──────────────────────────────────────────────────────────────────────

export function TenantsTable() {
    const [data, setData] = useState<TenantsResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [sort, setSort] = useState<Sort>(loadSort);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [activity, setActivity] = useState<Record<string, ActivityState>>({});

    useEffect(() => {
        let active = true;
        fetch("/api/tenants")
            .then((r) => {
                if (!r.ok) throw new Error(`request failed (${r.status})`);
                return r.json();
            })
            .then((j: TenantsResponse) => {
                if (active) setData(j);
            })
            .catch((e: unknown) => {
                if (active) setError(e instanceof Error ? e.message : "Failed to load");
            });
        return () => {
            active = false;
        };
    }, []);

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

    const rows = useMemo(() => {
        if (!data?.tenants) return [];
        const sorted = [...data.tenants].sort((a, b) => {
            const av = sortValue(a, sort.key);
            const bv = sortValue(b, sort.key);
            if (av < bv) return sort.dir === "asc" ? -1 : 1;
            if (av > bv) return sort.dir === "asc" ? 1 : -1;
            return 0;
        });
        return sorted;
    }, [data, sort]);

    const spendAvailable = data?.spendAvailable ?? false;

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
                    .then((j: { activity: ActivityEvent[]; available: boolean; error?: string }) => {
                        setActivity((c) => ({
                            ...c,
                            [t.id]: j.available
                                ? { loading: false, events: j.activity }
                                : { loading: false, error: j.error ?? "unavailable" },
                        }));
                    })
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
        <div className="overflow-hidden rounded-xl bg-primary">
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
                        <span className="text-xs text-tertiary-foreground">
                            {data.tenants.length} total
                        </span>
                    )}
                </div>
            </div>

            {error || (data && !data.available) ? (
                <p className="p-6 text-sm text-tertiary-foreground">
                    Tenants unavailable — {error || data?.error || "Ogen database not reachable"}
                </p>
            ) : !data ? (
                <SkeletonRows />
            ) : data.tenants.length === 0 ? (
                <p className="p-6 text-sm text-tertiary-foreground">No tenants</p>
            ) : (
                <div className="divide-y divide-border">
                    {/* header */}
                    <div className={`${GRID} px-6 py-2.5`}>
                        <span />
                        <SortHeader label="Name" col="name" sort={sort} onSort={onSort} />
                        <SortHeader label="Registered" col="createdAt" sort={sort} onSort={onSort} />
                        <SortHeader label="Status" col="status" sort={sort} onSort={onSort} />
                        <SortHeader
                            label="Users"
                            col="users"
                            sort={sort}
                            onSort={onSort}
                            align="right"
                            accent
                            className={METRIC_START}
                        />
                        <SortHeader label="AI spend" col="spend" sort={sort} onSort={onSort} accent />
                        <SortHeader
                            label="Zernio"
                            col="zernio"
                            sort={sort}
                            onSort={onSort}
                            align="right"
                            accent
                        />
                        <SortHeader
                            label="R2"
                            col="r2"
                            sort={sort}
                            onSort={onSort}
                            align="right"
                            accent
                        />
                    </div>

                    {/* rows */}
                    {rows.map((t) => {
                        const open = expanded.has(t.id);
                        return (
                            <div key={t.id}>
                                <button
                                    type="button"
                                    onClick={() => toggle(t)}
                                    aria-expanded={open}
                                    className={cn(
                                        `${GRID} w-full px-6 py-3.5 text-left text-sm transition-colors hover:bg-secondary/40`,
                                        open && "bg-secondary/40",
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
                                        <span className="block truncate font-medium text-foreground">
                                            {t.name}
                                        </span>
                                        <span className="block truncate font-mono text-xs text-tertiary-foreground">
                                            {t.slug}
                                        </span>
                                    </span>
                                    <span className="text-secondary-foreground">
                                        {formatDate(t.createdAt)}
                                    </span>
                                    
                                    <StatusLabel status={t.status} />

                                    <span className={cn("text-right text-foreground", METRIC_START)}>
                                        {t.users}
                                    </span>
                                    <SpendCell spend={t.spend} available={spendAvailable} />
                                    <span className="text-right font-display text-foreground">
                                        {t.zernioProfiles}
                                    </span>
                                    <span className="text-right tabular-nums text-foreground">
                                        {formatBytes(t.r2Bytes)}
                                    </span>
                                    
                                </button>
                                {open && <ExpandedPanel t={t} activity={activity[t.id]} />}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
