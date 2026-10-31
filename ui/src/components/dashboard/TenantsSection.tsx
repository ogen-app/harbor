"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Loader } from "@/components/ui/loader";
import { Legend } from "@/components/charts/primitives";
import { vendorColors } from "@/components/charts/colors";
import { usd } from "@/components/pnl/format";
import { useRowKeyboardNav } from "@/lib/useRowKeyboardNav";
import {
    ActiveTenantsDailyChart,
    ActiveTenantsLegend,
    SignupsWeeklyChart,
    type DayActive,
    type WeekCount,
} from "@/components/dashboard/TenantTrendCharts";

// The dashboard's Tenants panel (CON-436): tenants that need the operator
// first, then who just arrived, who went quiet and who costs the most, then two
// small trends. Every tenant is named and links to its page.

interface Headline {
    total: number;
    active: number;
    suspended: number;
    deleted: number;
}
interface Attention {
    tenantId: string;
    name: string;
    tier: string;
    kind: "failed_publish" | "broken_social";
    count: number;
    detail: string;
    platform: string;
    since: string | null;
}
interface Newcomer {
    tenantId: string;
    name: string;
    tier: string;
    createdAt: string;
    hasSocial: boolean;
    firstPostAt: string | null;
}
interface QuietTenant {
    tenantId: string;
    name: string;
    tier: string;
    lastActivityAt: string | null;
    quietSince: string;
}
interface SpendTenant {
    tenantId: string;
    name: string;
    costMicros: number;
    anthropicMicros: number;
    googleMicros: number;
    otherMicros: number;
}
interface Overview {
    checkedAt: string;
    headline: Headline;
    engaged: { active7d: number; of: number };
    // Nil Go slices marshal to null.
    attention: Attention[] | null;
    newcomers: Newcomer[] | null;
    quiet: QuietTenant[] | null;
    signups: WeekCount[] | null;
    dailyActive: DayActive[] | null;
    spend: { available: boolean; totalMicros: number; top: SpendTenant[] | null };
    platform: { stuckJobs: number };
}
interface OverviewResponse {
    available: boolean;
    error?: string;
    overview?: Overview;
}

// How often the overview refreshes in the background.
const REFRESH_MS = 120_000;
const QUIET_ROWS = 4;
const SPEND_ROWS = 3;
const DAY_MS = 86_400_000;
const RED = "#DC2626";
const AMBER = "#D97706";
const GREEN = "#059669";
const GREY = "#A39E97";
const VENDOR = vendorColors(["anthropic", "google"]);

// ── formatters ──────────────────────────────────────────────────────────────

const clock = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

const daysSince = (iso: string, now: number) => Math.max(0, Math.floor((now - new Date(iso).getTime()) / DAY_MS));

// "since 17:02" today, "4 days" before that.
function sinceLabel(iso: string | null, now: number): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (d.toDateString() === new Date(now).toDateString()) return `since ${clock(iso)}`;
    const n = Math.max(1, daysSince(iso, now));
    return n === 1 ? "1 day" : `${n} days`;
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function problemText(a: Attention): { lead: string; detail?: string } {
    if (a.kind === "failed_publish") {
        const posts = `${a.count} ${a.count === 1 ? "post" : "posts"} failing`;
        return { lead: a.platform ? `${posts} on ${a.platform}` : posts, detail: a.detail || undefined };
    }
    const where = a.platform ? capitalize(a.platform) : a.count === 1 ? "A social account" : `${a.count} social accounts`;
    return { lead: `${where} disconnected. Scheduled posts won’t go out.` };
}

// ── small pieces ────────────────────────────────────────────────────────────

function Label({ children, count, tone }: { children: React.ReactNode; count?: number; tone?: "alert" | "positive" }) {
    return (
        <h3 className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-secondary-foreground">
            {children}
            {count != null && (
                <span
                    className={cn(
                        "text-xs font-semibold tabular-nums tracking-normal",
                        tone === "alert" && "rounded-[1px] bg-[#DC2626] px-1.5 text-white",
                        tone === "positive" && "text-[#059669]",
                        !tone && "text-foreground",
                    )}
                >
                    {tone === "positive" ? `+${count}` : count}
                </span>
            )}
        </h3>
    );
}

// Glyph shape, not just colour, separates failing (filled) from degraded (ring).
function ProblemGlyph({ kind }: { kind: Attention["kind"] }) {
    return kind === "failed_publish" ? (
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: RED }} />
    ) : (
        <span aria-hidden className="size-2 shrink-0 rounded-full border-2" style={{ borderColor: AMBER }} />
    );
}

function TenantLink({ id, name, className }: { id: string; name: string; className?: string }) {
    return (
        <Link href={`/tenants/${id}`} className={cn("truncate font-medium text-foreground hover:underline", className)}>
            {name}
        </Link>
    );
}

function Tier({ name }: { name: string }) {
    return <span className="shrink-0 text-xs text-secondary-foreground">{name || "—"}</span>;
}

// Bar is a flat horizontal bar with its value right after the end.
function Bar({ segments, max, value }: { segments: { value: number; color: string }[]; max: number; value: string }) {
    const total = segments.reduce((s, x) => s + x.value, 0);
    const pct = max > 0 ? (total / max) * 100 : 0;
    return (
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <div className="flex h-3.5 shrink-0" style={{ width: `calc(${pct.toFixed(2)}% * 0.78)`, minWidth: total > 0 ? 2 : 0 }}>
                {segments.map((s, i) =>
                    s.value > 0 ? <span key={i} className="h-full" style={{ flexGrow: s.value, background: s.color }} /> : null,
                )}
            </div>
            <span className="shrink-0 text-xs font-semibold tabular-nums text-foreground">{value}</span>
        </div>
    );
}

// ── sections ────────────────────────────────────────────────────────────────

function NeedsAttention({ items, checkedAt, now }: { items: Attention[]; checkedAt: string; now: number }) {
    const router = useRouter();
    const { activeIndex, setActiveIndex, containerRef } = useRowKeyboardNav({
        count: items.length,
        onOpen: (i) => router.push(`/tenants/${items[i].tenantId}`),
    });

    if (items.length === 0) {
        return (
            <section className="px-6 py-4">
                <Label>Needs attention</Label>
                <p className="mt-3 flex items-center gap-2.5 text-[13px]">
                    <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden>
                        <path d="M1 6.5 L5 10.5 L13 1.5" fill="none" stroke={GREEN} strokeWidth="2" />
                    </svg>
                    <span className="font-medium text-foreground">Nothing needs you.</span>
                    <span className="text-secondary-foreground">
                        Checked publishes (24h) and social connections at {clock(checkedAt)}.
                    </span>
                </p>
            </section>
        );
    }

    return (
        <section className="px-6 py-4">
            <div className="flex items-center justify-between gap-4">
                <Label count={items.length} tone="alert">
                    Needs attention
                </Label>
                <span className="hidden text-xs text-tertiary-foreground sm:inline">j / k to move · ↵ to open</span>
            </div>
            <div ref={containerRef} role="list" className="-mx-3 mt-2">
                {items.map((a, i) => {
                    const { lead, detail } = problemText(a);
                    return (
                        <div
                            key={`${a.tenantId}-${a.kind}`}
                            role="listitem"
                            data-row-index={i}
                            onMouseEnter={() => setActiveIndex(i)}
                            className={cn(
                                "flex items-center gap-3 border-b border-border px-3 py-2 text-[13px] last:border-b-0",
                                activeIndex === i && "bg-secondary",
                            )}
                        >
                            <ProblemGlyph kind={a.kind} />
                            <TenantLink id={a.tenantId} name={a.name} className="w-32 shrink-0" />
                            <span className="w-12 shrink-0">
                                <Tier name={a.tier} />
                            </span>
                            <span className="min-w-0 flex-1 truncate">
                                <span className={a.kind === "failed_publish" ? "text-[#B91C1C]" : "text-foreground"}>{lead}</span>
                                {detail && <span className="text-secondary-foreground">: “{detail}”</span>}
                            </span>
                            <span className="shrink-0 text-xs tabular-nums text-tertiary-foreground">{sinceLabel(a.since, now)}</span>
                            <Link
                                href={`/tenants/${a.tenantId}`}
                                className={cn(
                                    "shrink-0 text-[13px] hover:underline",
                                    activeIndex === i ? "text-editable" : "text-secondary-foreground",
                                )}
                            >
                                Open →
                            </Link>
                        </div>
                    );
                })}
            </div>
        </section>
    );
}

// Onboarding: signed up → connected social → first post.
function OnboardingTrack({ n }: { n: Newcomer }) {
    const steps = [true, n.hasSocial, n.firstPostAt != null];
    const status = n.firstPostAt ? "publishing" : n.hasSocial ? "no post yet" : "no social yet";
    return (
        <span className="flex items-center gap-2" aria-label={`Onboarding: ${status}`}>
            <span aria-hidden className="flex items-center">
                {steps.map((done, i) => (
                    <span key={i} className="flex items-center">
                        {i > 0 && <span className={cn("h-px w-2.5", done ? "bg-foreground" : "bg-border")} />}
                        <span
                            className={cn("size-2 rounded-full", done ? (i === 2 ? "" : "bg-foreground") : "border-[1.5px] border-[#C9C4BD]")}
                            style={done && i === 2 ? { background: GREEN } : undefined}
                        />
                    </span>
                ))}
            </span>
            <span className="text-xs text-secondary-foreground">{status}</span>
        </span>
    );
}

function NewColumn({ items, now }: { items: Newcomer[]; now: number }) {
    return (
        <div className="space-y-3 px-6 py-4">
            <Label count={items.length} tone="positive">
                New · 30 days
            </Label>
            {items.length === 0 ? (
                <p className="text-[13px] text-secondary-foreground">No signups in the last 30 days.</p>
            ) : (
                <ul className="space-y-2.5">
                    {items.map((n) => (
                        <li key={n.tenantId} className="flex items-center gap-3 text-[13px]">
                            <TenantLink id={n.tenantId} name={n.name} className="min-w-0 flex-1" />
                            <span className="w-8 shrink-0 text-right text-xs tabular-nums text-tertiary-foreground">
                                {daysSince(n.createdAt, now)}d
                            </span>
                            <span className="w-32 shrink-0">
                                <OnboardingTrack n={n} />
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

function QuietColumn({ items, now }: { items: QuietTenant[]; now: number }) {
    const shown = items.slice(0, QUIET_ROWS);
    const max = Math.max(0, ...shown.map((q) => daysSince(q.quietSince, now)));
    return (
        <div className="space-y-3 px-6 py-4">
            <Label count={items.length}>Gone quiet</Label>
            {items.length === 0 ? (
                <p className="text-[13px] text-secondary-foreground">Every active tenant did something this week.</p>
            ) : (
                <>
                    <ul className="space-y-2.5">
                        {shown.map((q) => {
                            const d = daysSince(q.quietSince, now);
                            return (
                                <li key={q.tenantId} className="flex items-center gap-3 text-[13px]">
                                    <TenantLink id={q.tenantId} name={q.name} className="w-28 shrink-0" />
                                    <span className="w-10 shrink-0">
                                        <Tier name={q.tier} />
                                    </span>
                                    <Bar segments={[{ value: d, color: GREY }]} max={max} value={`${d}d`} />
                                </li>
                            );
                        })}
                    </ul>
                    <p className="text-xs text-tertiary-foreground">
                        {items.length > QUIET_ROWS && `+${items.length - QUIET_ROWS} more · `}days since last post or asset
                    </p>
                </>
            )}
        </div>
    );
}

function SpendColumn({ spend }: { spend: Overview["spend"] }) {
    const top = spend.top ?? [];
    const shown = top.slice(0, SPEND_ROWS);
    const rest = spend.totalMicros - shown.reduce((s, t) => s + t.costMicros, 0);
    const max = Math.max(0, ...shown.map((t) => t.costMicros), rest);
    const leader = top[0];
    const share = leader && spend.totalMicros > 0 ? Math.round((leader.costMicros / spend.totalMicros) * 100) : 0;
    const month = new Date().toLocaleString("en-US", { month: "short" });

    return (
        <div className="space-y-3 px-6 py-4">
            <div className="flex items-center justify-between gap-3">
                <Label>AI spend · {month}</Label>
                {spend.available && (
                    <Legend
                        className="gap-x-3 text-xs"
                        items={[
                            { label: "Anthropic", color: VENDOR.get("anthropic")! },
                            { label: "Google", color: VENDOR.get("google")! },
                        ]}
                    />
                )}
            </div>
            {!spend.available ? (
                <p className="text-[13px] text-secondary-foreground">Spend unavailable: analytics database not reachable.</p>
            ) : top.length === 0 ? (
                <p className="text-[13px] text-secondary-foreground">No AI spend this month yet.</p>
            ) : (
                <>
                    <ul className="space-y-2.5">
                        {shown.map((t) => (
                            <li key={t.tenantId} className="flex items-center gap-3 text-[13px]">
                                <TenantLink id={t.tenantId} name={t.name} className="w-28 shrink-0" />
                                <Bar
                                    max={max}
                                    value={usd(t.costMicros)}
                                    segments={[
                                        { value: t.anthropicMicros, color: VENDOR.get("anthropic")! },
                                        { value: t.googleMicros, color: VENDOR.get("google")! },
                                        { value: t.otherMicros, color: GREY },
                                    ]}
                                />
                            </li>
                        ))}
                        {rest > 0 && (
                            <li className="flex items-center gap-3 text-[13px]">
                                <span className="w-28 shrink-0 text-secondary-foreground">Everyone else</span>
                                <Bar max={max} value={usd(rest)} segments={[{ value: rest, color: "#D6D1CA" }]} />
                            </li>
                        )}
                    </ul>
                    <p className="text-xs text-tertiary-foreground">
                        {usd(spend.totalMicros)} total
                        {share >= 40 && ` · ${share}% from ${leader.name}`}
                    </p>
                </>
            )}
        </div>
    );
}

function HeaderSummary({ o }: { o: Overview }) {
    const h = o.headline;
    const parts: React.ReactNode[] = [];
    const num = (n: number) => <span className="font-semibold tabular-nums text-foreground">{n}</span>;
    parts.push(<>{num(h.active)} active</>);
    if (h.suspended) parts.push(<>{num(h.suspended)} suspended</>);
    if (h.deleted) parts.push(<>{num(h.deleted)} deleted</>);
    parts.push(
        <>
            {num(o.engaged.active7d)} of {o.engaged.of} active this week
        </>,
    );
    return (
        <p className="text-[13px] text-secondary-foreground">
            {parts.map((p, i) => (
                <span key={i}>
                    {i > 0 && " · "}
                    {p}
                </span>
            ))}
        </p>
    );
}

// ── main ────────────────────────────────────────────────────────────────────

export function TenantsSection() {
    const [data, setData] = useState<OverviewResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);

    const load = useCallback(async () => {
        setRefreshing(true);
        try {
            const r = await fetch("/api/tenants/overview");
            if (!r.ok) throw new Error(`request failed (${r.status})`);
            setData((await r.json()) as OverviewResponse);
            setError(null);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : "Failed to load");
        } finally {
            setRefreshing(false);
        }
    }, []);

    useEffect(() => {
        // load() flips `refreshing` before the async fetch — intentional.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void load();
        const id = setInterval(() => void load(), REFRESH_MS);
        return () => clearInterval(id);
    }, [load]);

    const o = data?.overview;
    const now = o ? new Date(o.checkedAt).getTime() : 0;

    return (
        <div className="overflow-hidden rounded-lg bg-primary">
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b border-border px-6 py-3">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
                    <h2 className="font-display text-xl font-medium text-foreground">Tenants</h2>
                    {o && <HeaderSummary o={o} />}
                </div>
                <div className="flex items-center gap-5">
                    {error && o && <span className="text-xs text-destructive">Refresh failed</span>}
                    {o && (
                        <button
                            type="button"
                            onClick={() => void load()}
                            disabled={refreshing}
                            title="Refresh now"
                            className="inline-flex items-center gap-1.5 text-xs text-tertiary-foreground transition-colors hover:text-foreground"
                        >
                            {refreshing && <Loader className="size-3 border-[1.5px]" />}
                            Updated {clock(o.checkedAt)}
                        </button>
                    )}
                    <Link href="/tenants" className="text-[13px] font-medium text-foreground hover:underline">
                        All tenants →
                    </Link>
                </div>
            </div>

            {!o ? (
                data && !data.available ? (
                    <p className="p-6 text-sm text-tertiary-foreground">
                        Tenants unavailable: {data.error || "Ogen database not reachable"}
                    </p>
                ) : error ? (
                    <p className="p-6 text-sm text-tertiary-foreground">Tenants unavailable: {error}</p>
                ) : (
                    <div className="flex items-center justify-center py-12 text-secondary-foreground">
                        <Loader className="size-6" />
                    </div>
                )
            ) : (
                <>
                    <NeedsAttention items={o.attention ?? []} checkedAt={o.checkedAt} now={now} />

                    <div className="grid border-t border-border lg:grid-cols-3 lg:divide-x lg:divide-border max-lg:divide-y max-lg:divide-border">
                        <NewColumn items={o.newcomers ?? []} now={now} />
                        <QuietColumn items={o.quiet ?? []} now={now} />
                        <SpendColumn spend={o.spend} />
                    </div>

                    <div className="grid border-t border-border lg:grid-cols-2 lg:divide-x lg:divide-border max-lg:divide-y max-lg:divide-border">
                        <div className="space-y-3 px-6 py-4">
                            <div className="flex items-center justify-between gap-3">
                                <h3 className="text-[13px] font-semibold text-foreground">Signups per week</h3>
                                <span className="text-xs tabular-nums text-tertiary-foreground">
                                    {(o.signups ?? []).reduce((s, w) => s + w.count, 0)} in {(o.signups ?? []).length} weeks
                                </span>
                            </div>
                            <SignupsWeeklyChart weeks={o.signups ?? []} />
                        </div>
                        <div className="space-y-3 px-6 py-4">
                            <div className="flex items-center justify-between gap-3">
                                <h3 className="text-[13px] font-semibold text-foreground">Active tenants per day</h3>
                                <ActiveTenantsLegend />
                            </div>
                            <ActiveTenantsDailyChart days={o.dailyActive ?? []} />
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-border px-6 py-3 text-[13px]">
                        <span className="inline-flex items-center gap-2">
                            <span
                                aria-hidden
                                className="size-2 rounded-full"
                                style={{ background: o.platform.stuckJobs > 0 ? RED : GREEN }}
                            />
                            <span className={o.platform.stuckJobs > 0 ? "text-[#B91C1C]" : "text-foreground"}>
                                {o.platform.stuckJobs} stuck background {o.platform.stuckJobs === 1 ? "job" : "jobs"}
                            </span>
                        </span>
                    </div>
                </>
            )}
        </div>
    );
}
