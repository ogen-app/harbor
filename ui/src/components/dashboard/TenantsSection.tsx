"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { CallBellIcon } from "@phosphor-icons/react";
import { Loader } from "@/components/ui/loader";
import { Tile, Bar, Dot, SectionTitle } from "@/components/dashboard/primitives";

interface Headline {
    total: number;
    active: number;
    trialing: number;
    suspended: number;
    churned: number;
}
interface Movement {
    new7d: number;
    new30d: number;
    churned7d: number;
    churned30d: number;
}
interface Activity {
    active7d: number;
    total: number;
}
interface SpendTenant {
    tenantId: string;
    name: string;
    costMicros: number;
}
interface Spend {
    available: boolean;
    periodStart: string | null;
    totalMicros: number;
    top: SpendTenant[];
}
interface Exceptions {
    failedPublishes24h: number;
    brokenSocial: number;
    stuckRiverJobs: number;
}
interface Overview {
    headline: Headline;
    movement: Movement;
    activity: Activity;
    spend: Spend;
    quota: { placeholder: boolean };
    exceptions: Exceptions;
}
interface OverviewResponse {
    available: boolean;
    error?: string;
    overview?: Overview;
}

// ── formatters ──────────────────────────────────────────────────────────────

function formatUSD(micros: number): string {
    const d = micros / 1e6;
    if (d === 0) return "$0.00";
    if (d < 1) return `$${d.toFixed(3)}`;
    if (d < 1000) return `$${d.toFixed(2)}`;
    return `$${(d / 1000).toFixed(1)}k`;
}

const pct = (n: number, total: number) => (total > 0 ? (n / total) * 100 : 0);

// ── small pieces ────────────────────────────────────────────────────────────

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
            <span className="font-medium tabular-nums text-foreground">{value}</span>
        </div>
    );
}

// Donut renders a multi-segment ring from stroke-dashed circles (no chart lib).
function Donut({
    segments,
    size = 88,
    thickness = 13,
}: {
    segments: { value: number; className: string }[];
    size?: number;
    thickness?: number;
}) {
    const total = segments.reduce((sum, s) => sum + s.value, 0);
    const r = (size - thickness) / 2;
    const c = 2 * Math.PI * r;
    let offset = 0;
    return (
        <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            className="-rotate-90"
        >
            <circle
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                strokeWidth={thickness}
                className="stroke-secondary"
            />
            {total > 0 &&
                segments.map((s, i) => {
                    if (s.value <= 0) return null;
                    const dash = (s.value / total) * c;
                    const arc = (
                        <circle
                            key={i}
                            cx={size / 2}
                            cy={size / 2}
                            r={r}
                            fill="none"
                            strokeWidth={thickness}
                            strokeDasharray={`${dash} ${c - dash}`}
                            strokeDashoffset={-offset}
                            className={s.className}
                        />
                    );
                    offset += dash;
                    return arc;
                })}
        </svg>
    );
}

const LIFECYCLE = [
    { key: "active" as const, label: "Active", dot: "bg-emerald-500", stroke: "stroke-emerald-500" },
    { key: "trialing" as const, label: "Trialing", dot: "bg-blue-400", stroke: "stroke-blue-400" },
    { key: "suspended" as const, label: "Suspended", dot: "bg-amber-500", stroke: "stroke-amber-500" },
    { key: "churned" as const, label: "Churned", dot: "bg-red-500", stroke: "stroke-red-500" },
];

function LifecycleTile({ h }: { h: Headline }) {
    return (
        <Tile
            title="Lifecycle"
            info="Total tenants split by lifecycle state. Ogen has no lifecycle states yet, so every tenant counts as active."
        >
            <div className="flex items-center gap-4">
                <div className="relative shrink-0">
                    <Donut
                        segments={LIFECYCLE.map((s) => ({
                            value: h[s.key],
                            className: s.stroke,
                        }))}
                    />
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                        <span className="font-display text-xl font-semibold leading-none tabular-nums">
                            {h.total}
                        </span>
                        <span className="mt-0.5 text-[10px] text-tertiary-foreground">
                            tenants
                        </span>
                    </div>
                </div>
                <div className="flex-1 space-y-1 text-xs text-secondary-foreground">
                    {LIFECYCLE.map((s) => (
                        <LegendRow
                            key={s.key}
                            color={s.dot}
                            label={s.label}
                            value={h[s.key]}
                        />
                    ))}
                </div>
            </div>
        </Tile>
    );
}

function MovementCell({
    window,
    added,
    churned,
}: {
    window: string;
    added: number;
    churned: number;
}) {
    return (
        <div>
            <p className="text-xs text-tertiary-foreground">{window}</p>
            <p className="mt-1 text-lg font-semibold tabular-nums">
                <span className="text-emerald-600">+{added}</span>
                <span className="text-tertiary-foreground"> / </span>
                <span className="text-red-600">−{churned}</span>
            </p>
        </div>
    );
}

function MovementTile({ m }: { m: Movement }) {
    return (
        <Tile
            title="Movement"
            info="New signups vs churns. Absolute numbers on a small tenant base are more honest than percentages."
        >
            <div className="grid grid-cols-2 gap-4">
                <MovementCell window="Last 7 days" added={m.new7d} churned={m.churned7d} />
                <MovementCell window="Last 30 days" added={m.new30d} churned={m.churned30d} />
            </div>
        </Tile>
    );
}

function ActivityTile({ a }: { a: Activity }) {
    const ratio = pct(a.active7d, a.total);
    return (
        <Tile
            title="Activity pulse"
            info="Tenants that published a post or generated content in the last 7 days — real usage, not just logins. Dormant-but-paying tenants are your churn pipeline."
        >
            <p className="font-display text-2xl font-semibold tabular-nums">
                {a.active7d}
                <span className="text-base font-normal text-tertiary-foreground">
                    {" "}
                    / {a.total}
                </span>
            </p>
            <Bar
                className="mt-3"
                segments={[{ pct: ratio, className: "bg-emerald-500" }]}
            />
            <p className="mt-2 text-xs text-secondary-foreground">
                {Math.round(ratio)}% active this week · {a.total - a.active7d} dormant
            </p>
        </Tile>
    );
}

function QuotaTile() {
    return (
        <Tile
            title="Quota pressure"
            info="Tenants at >80% and at 100% of their prepaid allowance — upsell opportunities and support tickets before the emails arrive. Wiring pending (needs allowance vs. usage)."
        >
            <div className="grid grid-cols-2 gap-4">
                <div>
                    <p className="text-xs text-tertiary-foreground">&gt;80%</p>
                    <p className="mt-1 text-2xl font-semibold text-tertiary-foreground">—</p>
                </div>
                <div>
                    <p className="text-xs text-tertiary-foreground">at 100%</p>
                    <p className="mt-1 text-2xl font-semibold text-tertiary-foreground">—</p>
                </div>
            </div>
            <p className="mt-2 text-xs text-tertiary-foreground">Placeholder</p>
        </Tile>
    );
}

function SpendTile({ s }: { s: Spend }) {
    const maxCost = Math.max(1, ...s.top.map((t) => t.costMicros));
    return (
        <Tile
            title="AI spend concentration"
            info="Top tenants by token / image cost this billing period, straight from the Timescale analytics rollups."
        >
            {!s.available ? (
                <p className="text-xs text-tertiary-foreground">
                    Analytics database unavailable
                </p>
            ) : (
                <>
                    <p className="font-display text-2xl font-semibold ">
                        <div className="inline tabular-nums">{formatUSD(s.totalMicros)}</div>
                        <span className="text-sm font-normal text-tertiary-foreground pl-1">
                            {" "}
                            this month
                        </span>
                    </p>
                    <div className="mt-3 space-y-2">
                        {s.top.length === 0 && (
                            <p className="text-xs text-tertiary-foreground">
                                No spend yet this period
                            </p>
                        )}
                        {s.top.map((t) => (
                            <div key={t.tenantId}>
                                <div className="flex items-center justify-between gap-3 text-xs">
                                    <span className="truncate font-medium text-foreground">
                                        {t.name}
                                    </span>
                                    <span className="shrink-0 tabular-nums text-secondary-foreground">
                                        {formatUSD(t.costMicros)}
                                    </span>
                                </div>
                                <Bar
                                    className="mt-1"
                                    segments={[
                                        {
                                            pct: (t.costMicros / maxCost) * 100,
                                            className: "bg-chart-1",
                                        },
                                    ]}
                                />
                            </div>
                        ))}
                    </div>
                </>
            )}
        </Tile>
    );
}

function ExceptionTile({ label, count }: { label: string; count: number }) {
    const alert = count > 0;
    return (
        <div
            className={cn(
                "flex items-center justify-between gap-3 rounded-md px-3 py-2.5",
                alert ? "border-red-200 bg-red-50" : "border-border",
            )}
        >
            <span className="text-xs text-secondary-foreground">{label}</span>
            <span
                className={cn(
                    "text-lg font-semibold tabular-nums",
                    alert ? "text-red-600" : "text-foreground",
                )}
            >
                {count}
            </span>
        </div>
    );
}

function ExceptionStrip({ e }: { e: Exceptions }) {
    return (
        <div className="rounded-md border-t-2 border-border p-4">
            <SectionTitle
                title="Exceptions (24h)"
                info="Counts to triage from a filtered Tenants page (page coming soon): failing Zernio publishes, broken/expired social connections, and stuck background jobs."
            />
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <ExceptionTile label="Failing publishes" count={e.failedPublishes24h} />
                <ExceptionTile label="Broken social connections" count={e.brokenSocial} />
                <ExceptionTile label="Stuck River jobs" count={e.stuckRiverJobs} />
            </div>
        </div>
    );
}

// ── main ────────────────────────────────────────────────────────────────────

export function TenantsSection() {
    const [data, setData] = useState<OverviewResponse | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        fetch("/api/tenants/overview")
            .then((r) => {
                if (!r.ok) throw new Error(`request failed (${r.status})`);
                return r.json();
            })
            .then((j: OverviewResponse) => {
                if (active) setData(j);
            })
            .catch((e: unknown) => {
                if (active) setError(e instanceof Error ? e.message : "Failed to load");
            });
        return () => {
            active = false;
        };
    }, []);

    const o = data?.overview;

    return (
        <div className="overflow-hidden rounded-lg border border-border bg-primary shadow-sm">
            <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-3">
                <h2 className="flex items-center gap-2 text-xl font-medium text-foreground">
                    <CallBellIcon className="size-5" />
                    Tenants
                </h2>
                {o && (
                    <span className="text-xs text-tertiary-foreground">
                        {o.headline.total} total
                    </span>
                )}
            </div>

            {error || (data && !data.available) ? (
                <p className="p-6 text-sm text-tertiary-foreground">
                    Tenants unavailable — {error || data?.error || "Ogen database not reachable"}
                </p>
            ) : !o ? (
                <div className="flex items-center justify-center py-12 text-secondary-foreground">
                    <Loader className="size-6" />
                </div>
            ) : (
                <div className="space-y-4 p-6">
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                        <LifecycleTile h={o.headline} />
                        <MovementTile m={o.movement} />
                        <ActivityTile a={o.activity} />
                        <QuotaTile />
                    </div>
                    <SpendTile s={o.spend} />
                    <ExceptionStrip e={o.exceptions} />
                </div>
            )}
        </div>
    );
}
