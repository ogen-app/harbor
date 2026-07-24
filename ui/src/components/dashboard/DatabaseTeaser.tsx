"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { DatabaseIcon, ArrowRightIcon } from "@phosphor-icons/react";
import { Loader } from "@/components/ui/loader";
import { Button } from "@/components/ui/button";
import { Dot } from "@/components/dashboard/primitives";
import {
    type DbStatus,
    formatBytes,
    StatusBadge,
    SEGMENT,
} from "@/components/dashboard/DatabaseStatus";

// How often the teaser auto-refreshes — matches the full dashboard.
const REFRESH_SECONDS = 120;

// DatabaseTeaser is the compact "/" glance widget: total storage, per-database
// size and connection state, plus a link through to the full /databases page.
export function DatabaseTeaser() {
    const [data, setData] = useState<DbStatus[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [countdown, setCountdown] = useState(REFRESH_SECONDS);

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
        // load() flips `refreshing` before the async fetch — intentional.
        // eslint-disable-next-line react-hooks/set-state-in-effect
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
        // eslint-disable-next-line react-hooks/set-state-in-effect -- load() flips `refreshing`
        if (countdown === 0) void load();
    }, [countdown, load]);

    const totalBytes =
        data?.reduce((sum, d) => sum + (d.connected ? d.sizeBytes : 0), 0) ?? 0;

    return (
        <div className="overflow-hidden rounded-lg bg-primary">
            {/* Header + link to details */}
            <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-3">
                <div className="flex items-center gap-3">
                    <h2 className="flex items-center gap-2 text-xl font-medium text-foreground font-display">
                        <DatabaseIcon className="size-6" weight="bold" />
                        Databases
                    </h2>
                    <Button asChild variant="default" size="sm" className="gap-1.5">
                        <Link href="/databases">
                            Go to details
                            <ArrowRightIcon className="size-4" weight="bold" />
                        </Link>
                    </Button>
                </div>
                <div className="flex items-center gap-4">
                    {data && (
                        <span className="text-xs text-tertiary-foreground">
                            {formatBytes(totalBytes)} total
                        </span>
                    )}
                    {error && data && (
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
                            <span className="leading-none">Refreshes in {countdown}s</span>
                        )}
                    </button>
                </div>
            </div>

            {!data ? (
                error ? (
                    <p className="p-6 text-sm text-tertiary-foreground">
                        Databases unavailable — {error}
                    </p>
                ) : (
                    <div className="flex items-center justify-center py-12 text-secondary-foreground">
                        <Loader className="size-6" />
                    </div>
                )
            ) : (
                <div className="p-6">
                    <div className="flex flex-wrap items-start justify-between gap-6">
                        <div>
                            <p className="text-sm text-secondary-foreground">
                                Total database storage
                            </p>
                            <p className="mt-1 font-display text-2xl font-semibold">
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
                                        color={
                                            d.connected
                                                ? SEGMENT[i % SEGMENT.length]
                                                : "bg-tertiary"
                                        }
                                        label={d.label}
                                    />
                                    <div className="flex items-center gap-3">
                                        <StatusBadge connected={d.connected} />
                                        <span className="w-16 text-right font-medium">
                                            {d.connected ? formatBytes(d.sizeBytes) : "—"}
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                    <div className="mt-5 flex h-2 w-full gap-0.5 overflow-hidden bg-secondary">
                        {data.map((d, i) => {
                            const pct =
                                totalBytes > 0 && d.connected
                                    ? (d.sizeBytes / totalBytes) * 100
                                    : 0;
                            if (pct <= 0) return null;
                            return (
                                <div
                                    key={d.key}
                                    className={cn("h-full", SEGMENT[i % SEGMENT.length])}
                                    style={{ width: `${pct}%` }}
                                />
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
