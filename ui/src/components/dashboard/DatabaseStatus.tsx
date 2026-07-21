"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";

interface DbStatus {
    key: string;
    label: string;
    kind: string;
    connected: boolean;
    sizeBytes: number;
    error?: string;
}

// Per-database colour for the storage bar segment and its legend dot.
const SEGMENT = ["bg-chart-1", "bg-chart-2"] as const;

function formatBytes(bytes: number): string {
    if (!bytes || bytes < 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    const i = Math.min(
        units.length - 1,
        Math.floor(Math.log(bytes) / Math.log(1024)),
    );
    const value = bytes / Math.pow(1024, i);
    return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function Card({
    children,
    className,
}: {
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <div
            className={cn(
                "rounded-lg border border-border bg-primary p-6 shadow-sm",
                className,
            )}
        >
            {children}
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
            <Icon name={connected ? "check" : "x_mark"} className="size-3.5" />
            {connected ? "Connected" : "Disconnected"}
        </span>
    );
}

export function DatabaseStatus() {
    const [data, setData] = useState<DbStatus[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        fetch("/api/status/databases")
            .then((r) => {
                if (!r.ok) throw new Error(`request failed (${r.status})`);
                return r.json();
            })
            .then((j: { databases: DbStatus[] }) => {
                if (active) setData(j.databases);
            })
            .catch((e: unknown) => {
                if (active) setError(e instanceof Error ? e.message : "Failed to load");
            });
        return () => {
            active = false;
        };
    }, []);

    if (error) {
        return (
            <Card>
                <p className="text-sm text-destructive">
                    Failed to load database status: {error}
                </p>
            </Card>
        );
    }

    if (!data) {
        return (
            <Card className="flex items-center justify-center py-12">
                <Spinner />
            </Card>
        );
    }

    const totalBytes = data.reduce(
        (sum, d) => sum + (d.connected ? d.sizeBytes : 0),
        0,
    );

    return (
        <section className="space-y-6">
            {/* Storage overview — total size + stacked per-database bar */}
            <Card>
                <div className="flex flex-wrap items-start justify-between gap-6">
                    <div>
                        <p className="text-sm text-secondary-foreground">
                            Total database storage
                        </p>
                        <p className="mt-1 font-display text-3xl font-semibold tabular-nums">
                            {formatBytes(totalBytes)}
                        </p>
                    </div>
                    <div className="flex flex-col gap-2 rounded-md border border-dashed border-border px-4 py-3">
                        {data.map((d, i) => (
                            <div
                                key={d.key}
                                className="flex items-center justify-between gap-8 text-sm"
                            >
                                <span className="flex items-center gap-2">
                                    <span
                                        className={cn(
                                            "size-2.5 rounded-full",
                                            d.connected ? SEGMENT[i] : "bg-tertiary",
                                        )}
                                    />
                                    {d.label}
                                </span>
                                <span className="font-medium tabular-nums">
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
            </Card>

            {/* Per-database connection detail cards */}
            <div className="grid gap-6 sm:grid-cols-2">
                {data.map((d) => (
                    <Card key={d.key}>
                        <h3 className="font-display text-lg font-semibold">
                            {d.label}
                        </h3>
                        <div className="mt-4 space-y-3 text-sm">
                            <Row label="Status">
                                <StatusBadge connected={d.connected} />
                            </Row>
                            <Row label="Engine">{d.kind}</Row>
                            <Row label="Size">
                                <span className="tabular-nums">
                                    {d.connected ? formatBytes(d.sizeBytes) : "—"}
                                </span>
                            </Row>
                        </div>
                        {!d.connected && d.error && (
                            <p className="mt-3 break-words text-xs text-tertiary-foreground">
                                {d.error}
                            </p>
                        )}
                    </Card>
                ))}
            </div>
        </section>
    );
}
