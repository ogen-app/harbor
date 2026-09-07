"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { InfoIcon, Bar, Dot } from "@/components/dashboard/primitives";
import { Loader } from "@/components/ui/loader";

// One tenant's current-period AI cost, split by model-family vendor. Mirrors the
// overview endpoint's spend.top rows.
interface SpendTenant {
    tenantId: string;
    name: string;
    costMicros: number;
    anthropicMicros: number;
    googleMicros: number;
    otherMicros: number;
}
interface Spend {
    available: boolean;
    totalMicros: number;
    // null when the analytics DB is unavailable (a nil Go slice marshals to null).
    top: SpendTenant[] | null;
}
interface OverviewResponse {
    available: boolean;
    error?: string;
    overview?: { spend: Spend };
}

function formatUSD(micros: number): string {
    const d = micros / 1e6;
    if (d === 0) return "$0.00";
    if (d < 1) return `$${d.toFixed(3)}`;
    if (d < 1000) return `$${d.toFixed(2)}`;
    return `$${(d / 1000).toFixed(1)}k`;
}

// SpendConcentrationCard is the "AI spend concentration" panel: top tenants by
// token/image cost this billing period, each bar split by vendor. Lifted out of
// the Tenants section so it can sit glued beneath the Daily token cost chart on
// the home dashboard; it fetches the same overview endpoint independently.
// `className` lets the caller strip the card's own rounding for that glued block.
export function SpendConcentrationCard({ className }: { className?: string }) {
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
                if (active)
                    setError(e instanceof Error ? e.message : "Failed to load");
            });
        return () => {
            active = false;
        };
    }, []);

    const spend = data?.overview?.spend;
    const top = spend?.top ?? [];
    const maxCost = Math.max(1, ...top.map((t) => t.costMicros));
    const hasOther = top.some((t) => t.otherMicros > 0);

    return (
        <div className={cn("overflow-hidden rounded-lg bg-primary", className)}>
            <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-3">
                <div className="flex items-center gap-1.5">
                    <h2 className="text-sm font-medium text-foreground">
                        AI spend concentration
                    </h2>
                    <InfoIcon text="Top tenants by token / image cost this billing period, straight from the Timescale analytics rollups." />
                </div>
                {spend?.available && (
                    <span className="text-xs text-tertiary-foreground">
                        <span className="font-mono">{formatUSD(spend.totalMicros)}</span>{" "}
                        this month
                    </span>
                )}
            </div>

            <div className="p-6">
                {error || (data && !data.available) ? (
                    <p className="text-sm text-tertiary-foreground">
                        Spend unavailable — {error || data?.error || "analytics database not reachable"}
                    </p>
                ) : !spend ? (
                    <div className="flex items-center justify-center py-6 text-secondary-foreground">
                        <Loader className="size-5" />
                    </div>
                ) : !spend.available ? (
                    <p className="text-sm text-tertiary-foreground">
                        Analytics database unavailable
                    </p>
                ) : (
                    <>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-secondary-foreground">
                            <Dot color="bg-orange-500" label="Anthropic" />
                            <Dot color="bg-blue-500" label="Google" />
                            {hasOther && <Dot color="bg-neutral-400" label="Other" />}
                        </div>
                        <div className="mt-4 space-y-2.5">
                            {top.length === 0 && (
                                <p className="text-xs text-tertiary-foreground">
                                    No spend yet this period
                                </p>
                            )}
                            {top.map((t) => (
                                <div key={t.tenantId}>
                                    <div className="flex items-center justify-between gap-3 text-xs">
                                        <span className="truncate font-medium text-foreground">
                                            {t.name}
                                        </span>
                                        <span className="shrink-0 font-mono text-secondary-foreground">
                                            {formatUSD(t.costMicros)}
                                        </span>
                                    </div>
                                    <Bar
                                        className="mt-1"
                                        segments={[
                                            {
                                                pct: (t.anthropicMicros / maxCost) * 100,
                                                className: "bg-orange-500",
                                            },
                                            {
                                                pct: (t.googleMicros / maxCost) * 100,
                                                className: "bg-blue-500",
                                            },
                                            {
                                                pct: (t.otherMicros / maxCost) * 100,
                                                className: "bg-neutral-400",
                                            },
                                        ]}
                                    />
                                </div>
                            ))}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
