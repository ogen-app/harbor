"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Loader } from "@/components/ui/loader";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CohortGrid, MedianDaysChart, MovementFeed, type Cohort, type Move } from "./LifecycleInsights";
import {
    BLUE,
    fmtDays,
    fmtPct,
    HEALTH_LABEL,
    HealthDot,
    healthText,
    INVITED,
    shortDate,
    STAGES,
    stageLabel,
    TONE_CLASS,
    type Health,
    type LifecycleTenant,
    type Progress,
    type Reason,
} from "./shared";

// The Lifecycle tab on /tenants: every live tenant on its furthest
// onboarding stage, coloured by health, stuck ones first. The funnel strip
// counts who has reached each stage; the board shows where each tenant is now.

// Invited's conversion is the share of invites redeemed; Signed up carries
// viaInvite instead, since organic signups never had an invite.
interface FunnelStep {
    stage: Progress | "invited";
    reached: number;
    conversion: number | null;
    medianDays: number | null;
    viaInvite: number | null;
}
interface InviteChip {
    id: string;
    email: string;
    tier: string;
    status: "pending" | "expired";
    sentAt: string;
    expiresAt: string | null;
    daysInStage: number;
    stuck: boolean;
    reason: Reason;
}
interface Board {
    checkedAt: string;
    sources: { ai: boolean; billing: boolean; invites: boolean; previousSnapshot: string };
    limits: Partial<Record<Progress | "invited", number>>;
    funnel: FunnelStep[];
    invites: InviteChip[];
    tenants: LifecycleTenant[];
    churned: LifecycleTenant[];
    activation: { eligible: number; activatedIn7Days: number; medianDaysToFirst: number | null };
    movement: Move[];
}
interface BoardResponse {
    available: boolean;
    error?: string;
    board?: Board;
}
interface CohortResponse {
    available: boolean;
    report?: { stages: Progress[]; cohorts: Cohort[] };
}

// A board column lists this many chips before folding the rest into the list.
const COLUMN_CHIPS = 8;
const REFRESH_MS = 300_000;

type HealthFilter = "all" | Health;
type View = "board" | "list";

interface Filters {
    tier: string;
    group: string;
    health: HealthFilter;
    stuckOnly: boolean;
    stage: Progress | null;
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

// ── filter bar ──────────────────────────────────────────────────────────────

function FilterMenu({
    label,
    value,
    options,
    onChange,
}: {
    label: string;
    value: string;
    options: { value: string; label: string }[];
    onChange: (v: string) => void;
}) {
    const current = options.find((o) => o.value === value)?.label ?? "All";
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className={cn(
                        "inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-[13px] transition-colors hover:bg-secondary",
                        value !== "all" ? "bg-secondary font-medium text-foreground" : "text-secondary-foreground",
                    )}
                >
                    {label}: {current}
                    <ChevronDown className="size-3.5" aria-hidden />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-44">
                <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
                    {options.map((o) => (
                        <DropdownMenuRadioItem key={o.value} value={o.value}>
                            {o.label}
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

// ── funnel strip ────────────────────────────────────────────────────────────

function FunnelStrip({ funnel }: { funnel: FunnelStep[] }) {
    // Organic signups can outnumber invites, so scale to the largest step.
    const top = Math.max(1, ...funnel.map((f) => f.reached));
    return (
        <div className="px-6 py-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-secondary-foreground">Reached · all time</h3>
                <span className="text-xs text-tertiary-foreground">conversion from the previous stage · median time to reach it</span>
            </div>
            <ol className={cn("grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3", funnel.length > 5 ? "lg:grid-cols-6" : "lg:grid-cols-5")}>
                {funnel.map((f) => (
                    <li key={f.stage} className="min-w-0">
                        <div className="text-xs text-secondary-foreground">{stageLabel(f.stage)}</div>
                        <div className="mt-1 flex items-baseline gap-2">
                            <span className="text-[22px] font-semibold tabular-nums leading-none text-foreground">{f.reached}</span>
                            {f.viaInvite != null ? (
                                <span className="text-xs tabular-nums text-tertiary-foreground">{f.viaInvite} via invite</span>
                            ) : (
                                f.conversion != null && (
                                    <span className="text-xs tabular-nums">
                                        <span className="font-medium text-foreground">{fmtPct(f.conversion)}</span>
                                        {f.stage === "invited" && <span className="text-tertiary-foreground"> redeemed</span>}
                                        {f.medianDays != null && <span className="text-tertiary-foreground"> · {fmtDays(f.medianDays)}</span>}
                                    </span>
                                )
                            )}
                        </div>
                        <div className="mt-2 h-1.5 bg-[#E6E3DE]">
                            <div className="h-full" style={{ width: `${(f.reached / top) * 100}%`, background: "#509EE3" }} />
                        </div>
                    </li>
                ))}
            </ol>
        </div>
    );
}

// ── board ───────────────────────────────────────────────────────────────────

function Chip({ t }: { t: LifecycleTenant }) {
    const reason = t.reasons[0];
    return (
        <Link
            href={`/tenants/${t.id}`}
            className="relative block rounded-[3px] border border-border bg-primary px-3 py-2 transition-colors hover:border-[#C9C4BD] hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={t.reasons.map((r) => r.text).join(" · ")}
        >
            <div className="flex items-center gap-2">
                <HealthDot health={t.health} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{t.name}</span>
                <span className="shrink-0 text-[11px] text-secondary-foreground">{t.tier || "—"}</span>
            </div>
            <div className="mt-1 flex items-baseline gap-2 text-xs">
                <span className={cn("min-w-0 flex-1 truncate", reason && TONE_CLASS[reason.tone])}>{reason?.text}</span>
                <span className={cn("shrink-0 tabular-nums", t.stuck ? "font-semibold text-[#B91C1C]" : "text-tertiary-foreground")}>
                    {t.daysInStage}d
                </span>
            </div>
            {t.moved && (
                <span
                    aria-label="Changed since the previous snapshot"
                    className="absolute -right-1 -top-1 size-2 rounded-full ring-2 ring-primary"
                    style={{ background: BLUE }}
                />
            )}
            <span className="sr-only">
                {`${healthText(t)}, ${t.daysInStage} days in stage${t.stuck ? ", stuck" : ""}`}
            </span>
        </Link>
    );
}

// InviteCard is an open invite in the Invited column; it opens the invite's
// drawer on /invites.
function InviteCard({ inv }: { inv: InviteChip }) {
    return (
        <Link
            href={`/invites?invite=${encodeURIComponent(inv.id)}`}
            className="block rounded-[3px] border border-dashed border-[#C9C4BD] bg-primary px-3 py-2 transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={`${inv.email} · sent ${shortDate(inv.sentAt)}`}
        >
            <div className="flex items-center gap-2">
                <span aria-hidden className="size-2 shrink-0 rounded-full border-[1.5px] border-dashed" style={{ borderColor: "#86817A" }} />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{inv.email}</span>
                <span className="shrink-0 text-[11px] text-secondary-foreground">{inv.tier || "—"}</span>
            </div>
            <div className="mt-1 flex items-baseline gap-2 text-xs">
                <span className={cn("min-w-0 flex-1 truncate", TONE_CLASS[inv.reason.tone])}>{inv.reason.text}</span>
                <span className={cn("shrink-0 tabular-nums", inv.stuck ? "font-semibold text-[#B91C1C]" : "text-tertiary-foreground")}>
                    {inv.daysInStage}d
                </span>
            </div>
            {inv.stuck && <span className="sr-only">, stuck</span>}
        </Link>
    );
}

function ColumnHeader({
    label,
    sub,
    count,
    stuck,
    limit,
    share,
}: {
    label: string;
    sub: string;
    count: number;
    stuck: number;
    limit: number | undefined;
    share: number;
}) {
    return (
        <>
            <div className="flex items-center gap-2">
                <h3 className="text-[13px] font-semibold text-foreground">{label}</h3>
                {stuck > 0 && (
                    <span className="rounded-[2px] bg-[#FEF2F2] px-1.5 text-[11px] font-medium tabular-nums text-[#B91C1C]">
                        {stuck} stuck
                    </span>
                )}
                <span className="ml-auto text-[13px] font-semibold tabular-nums text-foreground">{count}</span>
            </div>
            <p className="text-[11px] text-secondary-foreground">{sub}</p>
            <p className="text-[11px] text-tertiary-foreground">{limit ? `stuck after ${limit}d` : "health is the signal"}</p>
            <div className="mt-2 h-1 bg-[#E6E3DE]">
                <div className="h-full" style={{ width: `${share * 100}%`, background: "#509EE3" }} />
            </div>
        </>
    );
}

function MoreButton({ n, onClick }: { n: number; onClick: () => void }) {
    return (
        <button type="button" onClick={onClick} className="w-full py-1.5 text-left text-xs font-medium text-foreground hover:underline">
            +{n} more
        </button>
    );
}

function BoardView({
    tenants,
    invites,
    limits,
    total,
    onShowStage,
}: {
    tenants: LifecycleTenant[];
    // Null when invites can't be read: the Invited column says so instead of
    // reading as empty.
    invites: InviteChip[] | null;
    limits: Board["limits"];
    total: number;
    onShowStage: (p: Progress) => void;
}) {
    const share = (n: number) => (total ? n / total : 0);
    return (
        <div className="overflow-x-auto px-6 py-4">
            <div className="grid min-w-[1040px] grid-cols-6 gap-3">
                <section aria-label={INVITED.label} className="min-w-0">
                    <ColumnHeader
                        label={INVITED.label}
                        sub={INVITED.sub}
                        count={invites?.length ?? 0}
                        stuck={invites?.filter((i) => i.stuck).length ?? 0}
                        limit={limits.invited}
                        share={share(invites?.length ?? 0)}
                    />
                    <div className="mt-3 space-y-2">
                        {invites == null ? (
                            <p className="py-2 text-xs text-tertiary-foreground">Invites unavailable</p>
                        ) : invites.length === 0 ? (
                            <p className="py-2 text-xs text-tertiary-foreground">No open invites</p>
                        ) : (
                            invites.slice(0, COLUMN_CHIPS).map((inv) => <InviteCard key={inv.id} inv={inv} />)
                        )}
                        {invites && invites.length > COLUMN_CHIPS && (
                            <Link href="/invites" className="block py-1.5 text-xs font-medium text-foreground hover:underline">
                                +{invites.length - COLUMN_CHIPS} more on Invites
                            </Link>
                        )}
                    </div>
                </section>
                {STAGES.map((s) => {
                    const col = tenants.filter((t) => t.progress === s.key);
                    return (
                        <section key={s.key} aria-label={s.label} className="min-w-0">
                            <ColumnHeader
                                label={s.label}
                                sub={s.sub}
                                count={col.length}
                                stuck={col.filter((t) => t.stuck).length}
                                limit={limits[s.key]}
                                share={share(col.length)}
                            />
                            <div className="mt-3 space-y-2">
                                {col.length === 0 && <p className="py-2 text-xs text-tertiary-foreground">Nobody here</p>}
                                {col.slice(0, COLUMN_CHIPS).map((t) => (
                                    <Chip key={t.id} t={t} />
                                ))}
                                {col.length > COLUMN_CHIPS && <MoreButton n={col.length - COLUMN_CHIPS} onClick={() => onShowStage(s.key)} />}
                            </div>
                        </section>
                    );
                })}
            </div>
        </div>
    );
}

// ── list ────────────────────────────────────────────────────────────────────

function ListView({ tenants }: { tenants: LifecycleTenant[] }) {
    if (tenants.length === 0) {
        return <p className="px-6 py-10 text-center text-[13px] text-secondary-foreground">No tenants match these filters.</p>;
    }
    return (
        <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-[13px]">
                <thead>
                    <tr className="border-b border-border text-left text-[11px] font-medium uppercase tracking-[0.08em] text-secondary-foreground">
                        <th className="px-6 py-2.5 font-medium">Tenant</th>
                        <th className="px-3 py-2.5 font-medium">Tier</th>
                        <th className="px-3 py-2.5 font-medium">Stage</th>
                        <th className="px-3 py-2.5 font-medium">In stage</th>
                        <th className="px-3 py-2.5 font-medium">Health</th>
                        <th className="px-3 py-2.5 pr-6 font-medium">Reason</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border">
                    {tenants.map((t) => (
                        <tr key={t.id} className="hover:bg-secondary">
                            <td className="px-6 py-2">
                                <Link href={`/tenants/${t.id}`} className="font-medium text-foreground hover:underline">
                                    {t.name}
                                </Link>
                                {t.moved && <span aria-label="moved" className="ml-2 inline-block size-1.5 rounded-full align-middle" style={{ background: BLUE }} />}
                            </td>
                            <td className="px-3 py-2 text-secondary-foreground">{t.tier || "—"}</td>
                            <td className="px-3 py-2 font-medium text-foreground">{stageLabel(t.progress)}</td>
                            <td className={cn("px-3 py-2 tabular-nums", t.stuck ? "text-[#B91C1C]" : "text-foreground")}>
                                {t.stuck ? (
                                    <>
                                        <span className="font-semibold">{t.daysInStage}d</span> · stuck
                                    </>
                                ) : (
                                    `${t.daysInStage}d`
                                )}
                            </td>
                            <td className="px-3 py-2">
                                <span className="inline-flex items-center gap-2">
                                    <HealthDot health={t.health} />
                                    {healthText(t)}
                                </span>
                            </td>
                            <td className={cn("px-3 py-2 pr-6", t.reasons[0] && TONE_CLASS[t.reasons[0].tone])}>{t.reasons[0]?.text}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

// ── churned lane ────────────────────────────────────────────────────────────

function ChurnedLane({ tenants }: { tenants: LifecycleTenant[] }) {
    return (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3">
            <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-secondary-foreground">
                Churned · 90 days <span className="ml-1 font-semibold tracking-normal text-foreground">{tenants.length}</span>
            </h3>
            {tenants.length === 0 ? (
                <span className="text-xs text-tertiary-foreground">Nobody left</span>
            ) : (
                tenants.map((t) => (
                    <Link
                        key={t.id}
                        href={`/tenants/${t.id}`}
                        className="inline-flex items-center gap-2 rounded-[3px] border border-border bg-secondary px-2.5 py-1 text-xs hover:border-[#C9C4BD]"
                    >
                        <HealthDot health="churned" />
                        <span className="font-medium text-secondary-foreground">{t.name}</span>
                        <span className="text-tertiary-foreground">
                            {t.reasons[0]?.text}
                            {t.churnedAt ? ` · ${shortDate(t.churnedAt)}` : ""}
                        </span>
                    </Link>
                ))
            )}
        </div>
    );
}

// CohortPanel shows a cohort panel's loading, unavailable and stale states:
// after a failed refresh the last report stays, marked as not current.
function CohortPanel({
    report,
    error,
    children,
}: {
    report: CohortResponse["report"] | null;
    error: string | null;
    children: (r: NonNullable<CohortResponse["report"]>) => React.ReactNode;
}) {
    if (!report) {
        return error ? (
            <p className="py-6 text-[13px] text-secondary-foreground">Cohorts unavailable: {error}</p>
        ) : (
            <Loader className="size-4" />
        );
    }
    return (
        <>
            {error && <p className="text-xs text-destructive">Refresh failed; showing the last loaded cohorts.</p>}
            {children(report)}
        </>
    );
}

// ── main ────────────────────────────────────────────────────────────────────

export function LifecycleView() {
    const [data, setData] = useState<Board | null>(null);
    const [cohorts, setCohorts] = useState<CohortResponse["report"] | null>(null);
    // The cohort panels load on their own; a failure there leaves the board.
    const [cohortError, setCohortError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [view, setView] = useState<View>("board");
    const [filters, setFilters] = useState<Filters>({ tier: "all", group: "all", health: "all", stuckOnly: false, stage: null });

    const loadBoard = useCallback(async () => {
        try {
            const r = await fetch("/api/tenants/lifecycle");
            if (!r.ok) throw new Error(`request failed (${r.status})`);
            const j = (await r.json()) as BoardResponse;
            if (!j.board) throw new Error(j.error || "Ogen database not reachable");
            setData(j.board);
            setError(null);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : "Failed to load");
        }
    }, []);

    const loadCohorts = useCallback(async () => {
        try {
            const r = await fetch("/api/tenants/lifecycle/cohorts");
            if (!r.ok) throw new Error(`request failed (${r.status})`);
            const j = (await r.json()) as CohortResponse;
            if (!j.report) throw new Error("Ogen database not reachable");
            setCohorts(j.report);
            setCohortError(null);
        } catch (e: unknown) {
            setCohortError(e instanceof Error ? e.message : "Failed to load");
        }
    }, []);

    const load = useCallback(async () => {
        setRefreshing(true);
        await Promise.allSettled([loadBoard(), loadCohorts()]);
        setRefreshing(false);
    }, [loadBoard, loadCohorts]);

    useEffect(() => {
        // load() flips `refreshing` before the async fetch — intentional.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void load();
        const id = setInterval(() => void load(), REFRESH_MS);
        return () => clearInterval(id);
    }, [load]);

    const tiers = useMemo(
        () => [...new Set((data?.tenants ?? []).map((t) => t.tier).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
        [data],
    );
    const groups = useMemo(() => {
        const m = new Map<string, string>();
        for (const t of data?.tenants ?? []) for (const g of t.groups) m.set(g.id, g.name);
        return [...m].sort((a, b) => a[1].localeCompare(b[1]));
    }, [data]);

    const visible = useMemo(
        () =>
            (data?.tenants ?? []).filter(
                (t) =>
                    (filters.tier === "all" || t.tier === filters.tier) &&
                    (filters.group === "all" || t.groups.some((g) => g.id === filters.group)) &&
                    (filters.health === "all" || t.health === filters.health) &&
                    (!filters.stuckOnly || t.stuck) &&
                    (view === "board" || !filters.stage || t.progress === filters.stage),
            ),
        [data, filters, view],
    );

    // Invites have a tier but no group or health, so those filters hide them.
    const visibleInvites = useMemo(() => {
        if (!data?.sources.invites) return null;
        if (filters.group !== "all" || filters.health !== "all") return [];
        return (data.invites ?? []).filter(
            (i) => (filters.tier === "all" || i.tier === filters.tier) && (!filters.stuckOnly || i.stuck),
        );
    }, [data, filters]);

    if (!data) {
        return (
            <div className="rounded-lg bg-primary">
                {error ? (
                    <p className="p-6 text-sm text-tertiary-foreground">Lifecycle unavailable: {error}</p>
                ) : (
                    <div className="flex items-center justify-center py-16 text-secondary-foreground">
                        <Loader className="size-6" />
                    </div>
                )}
            </div>
        );
    }

    const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
    const a = data.activation;
    const stuckTotal = data.tenants.filter((t) => t.stuck).length + (data.invites ?? []).filter((i) => i.stuck).length;

    return (
        <div className="space-y-6">
            <div className="overflow-hidden rounded-lg bg-primary">
                <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-3">
                    <FilterMenu
                        label="Tier"
                        value={filters.tier}
                        options={[{ value: "all", label: "All" }, ...tiers.map((t) => ({ value: t, label: t }))]}
                        onChange={(v) => set({ tier: v })}
                    />
                    <FilterMenu
                        label="Group"
                        value={filters.group}
                        options={[{ value: "all", label: "All" }, ...groups.map(([id, name]) => ({ value: id, label: name }))]}
                        onChange={(v) => set({ group: v })}
                    />
                    <FilterMenu
                        label="Health"
                        value={filters.health}
                        options={[
                            { value: "all", label: "All" },
                            ...(["active", "cooling", "quiet"] as const).map((h) => ({ value: h, label: HEALTH_LABEL[h] })),
                        ]}
                        onChange={(v) => set({ health: v as HealthFilter })}
                    />
                    <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-border px-3 text-[13px] text-secondary-foreground hover:bg-secondary">
                        <input
                            id="lifecycle-stuck-only"
                            type="checkbox"
                            checked={filters.stuckOnly}
                            onChange={(e) => set({ stuckOnly: e.target.checked })}
                            className="size-3.5 accent-[#DC2626]"
                        />
                        Stuck only
                        <span className="tabular-nums text-tertiary-foreground">{stuckTotal}</span>
                    </label>
                    {view === "list" && filters.stage && (
                        <button
                            type="button"
                            onClick={() => set({ stage: null })}
                            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-secondary px-3 text-[13px] font-medium text-foreground"
                        >
                            Stage: {stageLabel(filters.stage)} ✕
                        </button>
                    )}
                    <div className="ml-auto flex items-center gap-4">
                        {error && <span className="text-xs text-destructive">Refresh failed</span>}
                        <button
                            type="button"
                            onClick={() => void load()}
                            disabled={refreshing}
                            title="Refresh now"
                            className="inline-flex items-center gap-1.5 text-xs text-tertiary-foreground transition-colors hover:text-foreground"
                        >
                            {refreshing && <Loader className="size-3 border-[1.5px]" />}
                            Updated {clock(data.checkedAt)}
                        </button>
                        <div role="radiogroup" aria-label="View" className="inline-flex rounded-md border border-border p-0.5">
                            {(["board", "list"] as const).map((v) => (
                                <button
                                    key={v}
                                    type="button"
                                    role="radio"
                                    aria-checked={view === v}
                                    onClick={() => setView(v)}
                                    className={cn(
                                        "rounded-[4px] px-3 py-1 text-xs capitalize",
                                        view === v ? "bg-secondary font-medium text-foreground" : "text-secondary-foreground hover:text-foreground",
                                    )}
                                >
                                    {v}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                <FunnelStrip funnel={data.funnel} />

                <div className="border-t border-border">
                    {view === "board" ? (
                        <BoardView
                            tenants={visible}
                            invites={visibleInvites}
                            limits={data.limits}
                            total={data.tenants.length + (data.invites?.length ?? 0)}
                            onShowStage={(p) => {
                                set({ stage: p });
                                setView("list");
                            }}
                        />
                    ) : (
                        <ListView tenants={visible} />
                    )}
                </div>

                <div className="border-t border-border">
                    <ChurnedLane tenants={data.churned} />
                </div>

                <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border px-6 py-3 text-[13px]">
                    <span className="text-foreground">
                        {a.eligible > 0 ? (
                            <>
                                <span className="font-semibold tabular-nums">
                                    {a.activatedIn7Days} of {a.eligible}
                                </span>{" "}
                                tenants who signed up 7–30 days ago reached a first post within 7 days
                            </>
                        ) : (
                            "No tenants signed up 7–30 days ago"
                        )}
                        {a.medianDaysToFirst != null && (
                            <span className="text-secondary-foreground">
                                {" "}
                                · median time to first post <span className="font-semibold text-foreground">{fmtDays(a.medianDaysToFirst)}</span>
                            </span>
                        )}
                    </span>
                    <span className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-secondary-foreground">
                        {(["active", "cooling", "quiet"] as const).map((h) => (
                            <span key={h} className="inline-flex items-center gap-1.5">
                                <HealthDot health={h} />
                                {h === "active" ? "Active" : h === "cooling" ? "Cooling 7–14d" : "Quiet 14d+"}
                            </span>
                        ))}
                        <span className="inline-flex items-center gap-1.5">
                            <span aria-hidden className="size-2 rounded-full" style={{ background: BLUE }} />
                            moved since the previous snapshot
                        </span>
                    </span>
                </div>
                {(!data.sources.ai || !data.sources.billing) && (
                    <p className="border-t border-border px-6 py-2 text-xs text-tertiary-foreground">
                        {!data.sources.ai && "AI usage is unavailable, so nobody reaches Generating and AI activity doesn’t count toward health. "}
                        {!data.sources.billing && "Billing is unavailable, so paying and past-due reasons are missing."}
                    </p>
                )}
            </div>

            <div className="grid overflow-hidden rounded-lg bg-primary lg:grid-cols-3 lg:divide-x lg:divide-border max-lg:divide-y max-lg:divide-border">
                <MovementFeed moves={data.movement} previous={data.sources.previousSnapshot} />
                <div className="space-y-3 px-6 py-4">
                    <div>
                        <h3 className="text-[13px] font-semibold text-foreground">Median days to first post</h3>
                        <p className="text-xs text-secondary-foreground">by signup week</p>
                    </div>
                    <CohortPanel report={cohorts} error={cohortError}>
                        {(r) => <MedianDaysChart cohorts={r.cohorts} />}
                    </CohortPanel>
                </div>
                <div className="space-y-3 px-6 py-4">
                    <div>
                        <h3 className="text-[13px] font-semibold text-foreground">Signup cohorts</h3>
                        <p className="text-xs text-secondary-foreground">share that reached each stage</p>
                    </div>
                    <CohortPanel report={cohorts} error={cohortError}>
                        {(r) => <CohortGrid cohorts={r.cohorts} stages={r.stages} />}
                    </CohortPanel>
                </div>
            </div>
        </div>
    );
}
