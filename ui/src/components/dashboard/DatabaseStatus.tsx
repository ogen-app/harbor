"use client";

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { DatabaseIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/ui/icon";
import {
    Tooltip,
    TooltipTrigger,
    TooltipContent,
} from "@/components/ui/tooltip";

interface Connections {
    active: number;
    idle: number;
    idleInTransaction: number;
    other: number;
    total: number;
    max: number;
}
interface Cache {
    blksHit: number;
    blksRead: number;
    hitRatio: number;
}
interface TxID {
    age: number;
    wraparoundPct: number;
}
interface WAL {
    inRecovery: boolean;
    lsn: string;
    replicas: number;
}
interface TableSize {
    name: string;
    totalBytes: number;
    tableBytes: number;
    indexBytes: number;
    toastBytes: number;
}
interface VacuumStat {
    name: string;
    liveTup: number;
    deadTup: number;
    lastAutovacuum: string | null;
}
interface River {
    available: number;
    running: number;
    retryable: number;
    scheduled: number;
    completed: number;
    discarded: number;
    cancelled: number;
    oldestAvailableSeconds: number | null;
}
interface Stats {
    connections: Connections;
    cache: Cache;
    txid: TxID;
    wal: WAL;
    tables: TableSize[];
    vacuum: VacuumStat[];
    river?: River | null;
}
interface DbStatus {
    key: string;
    label: string;
    kind: string;
    connected: boolean;
    sizeBytes: number;
    error?: string;
    stats?: Stats | null;
}

// How often the status auto-refreshes.
const REFRESH_SECONDS = 30;

// Per-database colour for the storage bar segment and its legend dot.
const SEGMENT = ["bg-chart-1", "bg-chart-2"] as const;

// ── formatters ──────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
    if (!bytes || bytes < 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    const i = Math.min(
        units.length - 1,
        Math.floor(Math.log(bytes) / Math.log(1024)),
    );
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatCompact(n: number): string {
    if (n < 1000) return String(n);
    const units = ["", "K", "M", "B", "T"];
    const i = Math.min(units.length - 1, Math.floor(Math.log10(n) / 3));
    return `${(n / Math.pow(1000, i)).toFixed(1)}${units[i]}`;
}

function formatDuration(secs: number): string {
    if (secs < 60) return `${Math.round(secs)}s`;
    const m = Math.floor(secs / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
}

function formatRelative(iso: string | null): string {
    if (!iso) return "never";
    const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    return `${formatDuration(secs)} ago`;
}

// ── primitives ──────────────────────────────────────────────────────────────

// Loader is a ring spinner that inherits the current text colour, so it stays
// visible on any background (unlike the theme Spinner, which is white).
function Loader({ className }: { className?: string }) {
    return (
        <span
            role="status"
            aria-label="Loading"
            className={cn(
                "inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent",
                className,
            )}
        />
    );
}

// InfoIcon renders a circled "i" that reveals a short description on hover/focus.
function InfoIcon({ text }: { text: string }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span
                    tabIndex={0}
                    className="inline-flex size-3.5 shrink-0 cursor-help items-center justify-center rounded-full border border-current text-[9px] font-semibold leading-none text-tertiary-foreground outline-none"
                >
                    i
                </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-64 border-foreground bg-foreground text-left text-background">
                {text}
            </TooltipContent>
        </Tooltip>
    );
}

function SectionTitle({ title, info }: { title: string; info: string }) {
    return (
        <div className="flex items-center gap-1.5">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
                {title}
            </h4>
            <InfoIcon text={info} />
        </div>
    );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-center justify-between gap-4">
            <span className="text-secondary-foreground">{label}</span>
            <span className="font-medium text-foreground">{children}</span>
        </div>
    );
}

function StatusBadge({ connected }: { connected: boolean }) {
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
                connected
                    ? "bg-emerald-50 text-emerald-700"
                    : "bg-red-50 text-red-700",
            )}
        >
            {connected ? "Connected" : "Disconnected"}
        </span>
    );
}

type Seg = { pct: number; className: string };

function Bar({ segments, className }: { segments: Seg[]; className?: string }) {
    return (
        <div
            className={cn(
                "flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-secondary",
                className,
            )}
        >
            {segments.map((s, i) =>
                s.pct > 0 ? (
                    <div
                        key={i}
                        className={cn("h-full", s.className)}
                        style={{ width: `${Math.min(s.pct, 100)}%` }}
                    />
                ) : null,
            )}
        </div>
    );
}

function Dot({ color, label }: { color: string; label: string }) {
    return (
        <span className="flex items-center gap-1.5">
            <span className={cn("size-2 rounded-full", color)} />
            {label}
        </span>
    );
}

function LegendRow({
    color,
    label,
    value,
}: {
    color: string;
    label: string;
    value: React.ReactNode;
}) {
    return (
        <div className="flex items-center justify-between gap-3">
            <Dot color={color} label={label} />
            <span className="font-medium  text-foreground">{value}</span>
        </div>
    );
}

function Tile({
    title,
    info,
    children,
}: {
    title: string;
    info: string;
    children: React.ReactNode;
}) {
    return (
        <div className="rounded-md border-t-2 border-border p-4">
            <SectionTitle title={title} info={info} />
            <div className="mt-3">{children}</div>
        </div>
    );
}

// ── stat sections ───────────────────────────────────────────────────────────

function ConnectionsTile({ c }: { c: Connections }) {
    const pct = (n: number) => (c.max > 0 ? (n / c.max) * 100 : 0);
    return (
        <Tile
            title="Connections"
            info="Backends in pg_stat_activity by state, against the server's max_connections. Many idle-in-transaction sessions hold locks and block vacuum."
        >
            <p className="font-display text-2xl font-semibold ">
                {c.total}
                <span className="text-base font-normal text-tertiary-foreground">
                    {" "}
                    / {c.max}
                </span>
            </p>
            <Bar
                className="mt-3"
                segments={[
                    { pct: pct(c.active), className: "bg-emerald-500" },
                    { pct: pct(c.idleInTransaction), className: "bg-amber-500" },
                    { pct: pct(c.idle), className: "bg-blue-400" },
                ]}
            />
            <div className="mt-2 space-y-1 text-xs text-secondary-foreground">
                <LegendRow color="bg-emerald-500" label="Active" value={c.active} />
                <LegendRow
                    color="bg-amber-500"
                    label="Idle in txn"
                    value={c.idleInTransaction}
                />
                <LegendRow color="bg-blue-400" label="Idle" value={c.idle} />
            </div>
        </Tile>
    );
}

function CacheTile({ c }: { c: Cache }) {
    const pct = c.hitRatio * 100;
    const tone =
        c.hitRatio >= 0.99
            ? "bg-emerald-500"
            : c.hitRatio >= 0.9
              ? "bg-amber-500"
              : "bg-red-500";
    return (
        <Tile
            title="Cache hit ratio"
            info="Share of block reads served from shared buffers — blks_hit / (blks_hit + blks_read) from pg_stat_database. Sustained low values mean disk I/O pressure."
        >
            <p className="font-display text-2xl font-semibold ">
                {pct.toFixed(2)}%
            </p>
            <Bar className="mt-3" segments={[{ pct, className: tone }]} />
            <p className="mt-2 text-xs  text-secondary-foreground">
                {formatCompact(c.blksHit)} hit · {formatCompact(c.blksRead)} read
            </p>
        </Tile>
    );
}

function TxidTile({ t }: { t: TxID }) {
    const pct = t.wraparoundPct * 100;
    const tone =
        pct < 50 ? "bg-emerald-500" : pct < 80 ? "bg-amber-500" : "bg-red-500";
    return (
        <Tile
            title="Txn ID age"
            info="Age of the oldest unfrozen transaction id — age(datfrozenxid). It approaches wraparound near ~2.1B; autovacuum should keep it low."
        >
            <p className="font-display text-2xl font-semibold ">
                {formatCompact(t.age)}
            </p>
            <Bar
                className="mt-3"
                segments={[{ pct: Math.max(pct, 0.5), className: tone }]}
            />
            <p className="mt-2 text-xs  text-secondary-foreground">
                {pct < 0.01 ? "<0.01" : pct.toFixed(2)}% to wraparound
            </p>
        </Tile>
    );
}

function WalTile({ w }: { w: WAL }) {
    return (
        <Tile
            title="WAL / replication"
            info="Write-ahead-log position and role. LSN is the current WAL location (pg_current_wal_lsn); replicas is connected standbys (pg_stat_replication)."
        >
            <div className="space-y-2 text-sm">
                <Row label="Role">{w.inRecovery ? "Replica" : "Primary"}</Row>
                <Row label="LSN">
                    <span className="font-mono text-xs">{w.lsn || "—"}</span>
                </Row>
                <Row label="Replicas">
                    <span className="">{w.replicas}</span>
                </Row>
            </div>
        </Tile>
    );
}

function TablesPanel({ tables }: { tables: TableSize[] }) {
    const max = Math.max(1, ...tables.map((t) => t.totalBytes));
    return (
        <div className="rounded-md border-t-2 border-border p-4">
            <SectionTitle
                title="Largest tables"
                info="Top relations by pg_total_relation_size, split into heap, indexes and TOAST (out-of-line storage for large column values)."
            />
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-secondary-foreground">
                <Dot color="bg-chart-1" label="Heap" />
                <Dot color="bg-chart-2" label="Index" />
                <Dot color="bg-chart-3" label="TOAST" />
            </div>
            <div className="mt-3 space-y-2.5">
                {tables.length === 0 && (
                    <p className="text-xs text-tertiary-foreground">No tables</p>
                )}
                {tables.map((t) => (
                    <div key={t.name}>
                        <div className="flex items-center justify-between gap-3 text-xs">
                            <span className="truncate font-medium text-foreground">
                                {t.name}
                            </span>
                            <span className="shrink-0  text-secondary-foreground">
                                {formatBytes(t.totalBytes)}
                            </span>
                        </div>
                        <Bar
                            className="mt-1"
                            segments={[
                                { pct: (t.tableBytes / max) * 100, className: "bg-chart-1" },
                                { pct: (t.indexBytes / max) * 100, className: "bg-chart-2" },
                                { pct: (t.toastBytes / max) * 100, className: "bg-chart-3" },
                            ]}
                        />
                    </div>
                ))}
            </div>
        </div>
    );
}

function VacuumPanel({ vacuum }: { vacuum: VacuumStat[] }) {
    return (
        <div className="rounded-md border-t-2 border-border p-4">
            <SectionTitle
                title="Bloat & vacuum"
                info="Dead vs live tuples per table (pg_stat_user_tables) and the last autovacuum. High dead ratios mean bloat that needs vacuuming."
            />
            <div className="mt-3 space-y-2.5">
                {vacuum.length === 0 && (
                    <p className="text-xs text-tertiary-foreground">No user tables</p>
                )}
                {vacuum.map((v) => {
                    const total = v.liveTup + v.deadTup;
                    const deadPct = total > 0 ? (v.deadTup / total) * 100 : 0;
                    const tone =
                        deadPct >= 50
                            ? "text-red-600"
                            : deadPct >= 20
                              ? "text-amber-600"
                              : "text-secondary-foreground";
                    return (
                        <div
                            key={v.name}
                            className="flex items-center justify-between gap-3 text-xs"
                        >
                            <span className="truncate font-medium text-foreground">
                                {v.name}
                            </span>
                            <span className="flex shrink-0 items-center gap-3 ">
                                <span className={tone}>
                                    {formatCompact(v.deadTup)} dead ({deadPct.toFixed(0)}%)
                                </span>
                                <span className="text-tertiary-foreground">
                                    {formatRelative(v.lastAutovacuum)}
                                </span>
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function RiverPanel({ river }: { river: River }) {
    const states: [string, number][] = [
        ["Available", river.available],
        ["Running", river.running],
        ["Retryable", river.retryable],
        ["Scheduled", river.scheduled],
        ["Completed", river.completed],
        ["Discarded", river.discarded],
        ["Cancelled", river.cancelled],
    ];
    return (
        <div className="rounded-md border-t-2 border-border p-4">
            <SectionTitle
                title="River queue"
                info="Background-job counts from the river_job table by state, plus how long the oldest available job has been waiting to run."
            />
            <div className="mt-3 flex flex-wrap gap-2">
                {states.map(([label, n]) => (
                    <span
                        key={label}
                        className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs"
                    >
                        <span className="text-secondary-foreground">{label}</span>
                        <span className="font-semibold  text-foreground">
                            {n}
                        </span>
                    </span>
                ))}
            </div>
            <p className="mt-3 text-xs text-secondary-foreground">
                Oldest available:{" "}
                <span className="font-medium text-foreground">
                    {river.oldestAvailableSeconds != null
                        ? formatDuration(river.oldestAvailableSeconds)
                        : "none waiting"}
                </span>
            </p>
        </div>
    );
}

// DbBlock renders one database's summary row and all its stat sections.
function DbBlock({ d }: { d: DbStatus }) {
    if (!d.connected || !d.stats) {
        return (
            <>
                <StatusBadge connected={d.connected} />
                <p className="mt-4 wrap-break-word text-xs text-tertiary-foreground">
                    {d.error || "No statistics available"}
                </p>
            </>
        );
    }
    return (
        <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                <StatusBadge connected={d.connected} />
                <span className="text-secondary-foreground">{d.kind}</span>
                <span className=" text-secondary-foreground">
                    {formatBytes(d.sizeBytes)}
                </span>
            </div>

            <div className="mt-5 space-y-5">
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <ConnectionsTile c={d.stats.connections} />
                    <CacheTile c={d.stats.cache} />
                    <TxidTile t={d.stats.txid} />
                    <WalTile w={d.stats.wal} />
                </div>
                <div className="grid gap-5 lg:grid-cols-2">
                    <TablesPanel tables={d.stats.tables} />
                    <VacuumPanel vacuum={d.stats.vacuum} />
                </div>
                {d.stats.river && <RiverPanel river={d.stats.river} />}
            </div>
        </>
    );
}

// ── main ────────────────────────────────────────────────────────────────────

export function DatabaseStatus() {
    const [data, setData] = useState<DbStatus[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [countdown, setCountdown] = useState(REFRESH_SECONDS);
    const [active, setActive] = useState(0);

    const load = useCallback(async () => {
        setRefreshing(true);
        setCountdown(REFRESH_SECONDS); // reset immediately so the timer doesn't re-fire
        try {
            const r = await fetch("/api/status/databases");
            if (!r.ok) throw new Error(`request failed (${r.status})`);
            const j = (await r.json()) as { databases: DbStatus[] };
            setData(j.databases);
            setError(null);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : "Failed to load");
        } finally {
            setRefreshing(false);
        }
    }, []);

    // Initial load.
    useEffect(() => {
        void load();
    }, [load]);

    // 1s ticker for the countdown.
    useEffect(() => {
        const id = setInterval(
            () => setCountdown((c) => (c > 0 ? c - 1 : 0)),
            1000,
        );
        return () => clearInterval(id);
    }, []);

    // Auto-refresh when the countdown elapses (load() resets it).
    useEffect(() => {
        if (countdown === 0) void load();
    }, [countdown, load]);

    if (!data) {
        return (
            <div className="rounded-lg bg-primary">
                {error ? (
                    <p className="p-6 text-sm text-destructive">
                        Failed to load database status: {error}
                    </p>
                ) : (
                    <div className="flex items-center justify-center py-12 text-secondary-foreground">
                        <Loader className="size-6" />
                    </div>
                )}
            </div>
        );
    }

    const totalBytes = data.reduce(
        (sum, d) => sum + (d.connected ? d.sizeBytes : 0),
        0,
    );

    return (
        <div className="overflow-hidden rounded-lg bg-primary">
            {/* Header + auto-refresh control */}
            <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-3">
                <h2 className="flex items-center gap-2 text-xl font-medium text-foreground font-display">
                    <DatabaseIcon className="size-6" weight="bold" />
                    Databases
                </h2>
                <div className="flex items-center gap-3">
                    {error && (
                        <span className="text-xs text-destructive">Refresh failed</span>
                    )}
                    <button
                        type="button"
                        onClick={() => void load()}
                        disabled={refreshing}
                        aria-label="Refresh now"
                        className="inline-flex items-center gap-1.5 text-xs text-tertiary-foreground transition-colors hover:text-foreground"
                    >
                        {refreshing ? (
                            <>
                                <Loader className="size-3.5 border-[1.5px]" />
                                <span className="leading-none">Refreshing…</span>
                            </>
                        ) : (
                            <>
                                {/*<Icon name="change" className="size-3.5" />*/}
                                <span className="leading-none">
                                    Refreshes in {countdown}s
                                </span>
                            </>
                        )}
                    </button>
                </div>
            </div>

            {/* Storage overview — total size + stacked per-database bar */}
            <div className="p-6">
                <div className="flex flex-wrap items-start justify-between gap-6">
                    <div>
                        <p className="text-sm text-secondary-foreground">
                            Total database storage
                        </p>
                        <p className="mt-1 font-display text-2xl font-semibold ">
                            {formatBytes(totalBytes)}
                        </p>
                    </div>
                    <div className="flex flex-col gap-2 rounded-lg bg-background px-4 py-3">
                        {data.map((d, i) => (
                            <div
                                key={d.key}
                                className="flex items-center justify-between gap-8 text-sm"
                            >
                                <Dot
                                    color={d.connected ? SEGMENT[i] : "bg-tertiary"}
                                    label={d.label}
                                />
                                <span className="font-medium ">
                                    {d.connected ? formatBytes(d.sizeBytes) : "—"}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
                <div className="mt-5 flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-secondary">
                    {data.map((d, i) => {
                        const pct =
                            totalBytes > 0 && d.connected
                                ? (d.sizeBytes / totalBytes) * 100
                                : 0;
                        if (pct <= 0) return null;
                        return (
                            <div
                                key={d.key}
                                className={cn("h-full", SEGMENT[i])}
                                style={{ width: `${pct}%` }}
                            />
                        );
                    })}
                </div>
            </div>

            {/* Per-database stats — tabbed */}
            <div className="border-t border-border">
                <div
                    role="tablist"
                    className="flex gap-6 overflow-x-auto border-b border-border px-6"
                >
                    {data.map((d, i) => (
                        <button
                            key={d.key}
                            type="button"
                            role="tab"
                            aria-selected={i === active}
                            onClick={() => setActive(i)}
                            className={cn(
                                "relative -mb-px shrink-0 border-b-4 py-3 text-sm whitespace-nowrap transition-colors outline-none cursor-pointer",
                                i === active
                                    ? "border-foreground font-semibold text-foreground"
                                    : "border-transparent font-medium text-tertiary-foreground hover:text-secondary-foreground",
                            )}
                        >
                            {d.label}
                        </button>
                    ))}
                </div>
                <div className="p-6">
                    {data[active] && <DbBlock d={data[active]} />}
                </div>
            </div>
        </div>
    );
}
