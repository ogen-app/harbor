"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Loader } from "@/components/ui/loader";
import {
    AMBER,
    GREEN,
    HEALTH_LABEL,
    HealthDot,
    healthText,
    shortDate,
    span,
    STAGES,
    TONE_CLASS,
    type Health,
    type LifecycleTenant,
    type Progress,
} from "./shared";

// The tenant's Lifecycle card in General information (CON-437): the milestones
// it reached and how long each step took, then its health over time from the
// daily snapshots.

interface HealthSpan {
    from: string;
    to: string;
    health: Health;
}
interface Response {
    available: boolean;
    error?: string;
    lifecycle?: {
        checkedAt: string;
        tenant: LifecycleTenant;
        limits: Partial<Record<Progress, number>>;
        healthBand: HealthSpan[];
    };
}

const BAND: Record<Health, string> = {
    active: `${GREEN}59`,
    cooling: `${AMBER}80`,
    quiet: "#C9C4BD",
    churned: "#E6E3DE",
};

const DAY_MS = 86_400_000;

function HealthBand({ spans }: { spans: HealthSpan[] }) {
    if (spans.length === 0) {
        return <p className="text-xs text-tertiary-foreground">Health history starts with the first daily snapshot.</p>;
    }
    const start = new Date(spans[0].from).getTime();
    const end = new Date(spans[spans.length - 1].to).getTime() + DAY_MS;
    const total = Math.max(DAY_MS, end - start);
    return (
        <div>
            <div className="flex h-4 w-full overflow-hidden" role="img" aria-label={spans.map((s) => `${HEALTH_LABEL[s.health]} ${shortDate(s.from)} to ${shortDate(s.to)}`).join(", ")}>
                {spans.map((s) => {
                    const w = ((new Date(s.to).getTime() + DAY_MS - new Date(s.from).getTime()) / total) * 100;
                    return (
                        <div
                            key={s.from}
                            title={`${HEALTH_LABEL[s.health]}: ${shortDate(s.from)} – ${shortDate(s.to)}`}
                            className="h-full"
                            style={{ width: `${w}%`, background: BAND[s.health] }}
                        />
                    );
                })}
            </div>
            <div className="mt-1.5 flex justify-between text-xs tabular-nums text-tertiary-foreground">
                <span>{shortDate(spans[0].from)}</span>
                <span>{shortDate(spans[spans.length - 1].to)}</span>
            </div>
        </div>
    );
}

export function TenantLifecycleCard({ tenantId }: { tenantId: string }) {
    const [data, setData] = useState<Response | null>(null);

    useEffect(() => {
        let alive = true;
        fetch(`/api/tenants/${encodeURIComponent(tenantId)}/lifecycle`)
            .then((r) => (r.ok ? (r.json() as Promise<Response>) : { available: false, error: `request failed (${r.status})` }))
            .then((j) => alive && setData(j))
            .catch((e: unknown) => alive && setData({ available: false, error: e instanceof Error ? e.message : "Failed to load" }));
        return () => {
            alive = false;
        };
    }, [tenantId]);

    const l = data?.lifecycle;
    const t = l?.tenant;

    return (
        <div className="rounded-lg bg-primary p-6">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">Lifecycle</h2>
                {t && (
                    <>
                        <span className="text-[13px] text-secondary-foreground">
                            {STAGES.find((s) => s.key === t.progress)?.label} for {t.daysInStage} {t.daysInStage === 1 ? "day" : "days"}
                            {t.stuck && <span className="font-medium text-[#B91C1C]"> · stuck</span>}
                        </span>
                        <span className="ml-auto inline-flex items-center gap-2 text-[13px]">
                            <HealthDot health={t.health} />
                            <span className="text-foreground">{healthText(t)}</span>
                            {t.reasons[0] && t.reasons[0].kind !== "stage" && (
                                <span className={TONE_CLASS[t.reasons[0].tone]}>· {t.reasons[0].text}</span>
                            )}
                        </span>
                    </>
                )}
            </div>

            {!data ? (
                <div className="flex justify-center py-8 text-secondary-foreground">
                    <Loader className="size-5" />
                </div>
            ) : !t ? (
                <p className="pt-4 text-sm text-tertiary-foreground">Lifecycle unavailable{data.error ? `: ${data.error}` : ""}</p>
            ) : (
                <>
                    <ol className="mt-6 grid grid-cols-2 gap-y-5 sm:grid-cols-5">
                        {STAGES.map((s, i) => {
                            const at = s.key === "signed_up" ? t.milestones.signedUp : t.milestones[keyOf(s.key)];
                            const prevAt = previousReached(t, i);
                            const reached = at != null;
                            return (
                                <li key={s.key} className="relative min-w-0 pr-3">
                                    <div className="flex items-center">
                                        <span
                                            aria-hidden
                                            className={cn("size-2.5 shrink-0 rounded-full", reached ? "bg-foreground" : "border-[1.5px] border-[#C9C4BD]")}
                                        />
                                        {i < STAGES.length - 1 && (
                                            <span aria-hidden className={cn("ml-1 h-px flex-1", reached ? "bg-foreground" : "bg-border")} />
                                        )}
                                    </div>
                                    <div className={cn("mt-2 text-[13px] font-medium", reached ? "text-foreground" : "text-tertiary-foreground")}>
                                        {s.label}
                                    </div>
                                    <div className="text-xs tabular-nums text-secondary-foreground">
                                        {reached ? shortDate(at) : "not yet"}
                                    </div>
                                    {reached && prevAt && i > 0 && (
                                        <div className="text-xs text-tertiary-foreground">took {span(prevAt, at)}</div>
                                    )}
                                </li>
                            );
                        })}
                    </ol>

                    <div className="mt-6 space-y-2">
                        <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-secondary-foreground">Health</h3>
                        <HealthBand spans={l.healthBand} />
                    </div>
                </>
            )}
        </div>
    );
}

function keyOf(p: Exclude<Progress, "signed_up">): "connected" | "generating" | "firstPost" | "regular" {
    return p === "first_post" ? "firstPost" : p;
}

// previousReached is the latest milestone before stage i that the tenant
// reached, so "took" measures from where it actually was.
function previousReached(t: LifecycleTenant, i: number): string | null {
    for (let j = i - 1; j >= 0; j--) {
        const k = STAGES[j].key;
        const at = k === "signed_up" ? t.milestones.signedUp : t.milestones[keyOf(k)];
        if (at) return at;
    }
    return null;
}
