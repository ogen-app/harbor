"use client";

import { cn } from "@/lib/utils";
import {
    Tooltip,
    TooltipTrigger,
    TooltipContent,
} from "@/components/ui/tooltip";

// InfoIcon renders a circled "i" that reveals a short description on hover/focus.
export function InfoIcon({ text }: { text: string }) {
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

export function SectionTitle({ title, info }: { title: string; info?: string }) {
    return (
        <div className="flex items-center gap-1.5">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
                {title}
            </h4>
            {info && <InfoIcon text={info} />}
        </div>
    );
}

export function Tile({
    title,
    info,
    className,
    children,
}: {
    title: string;
    info?: string;
    className?: string;
    children: React.ReactNode;
}) {
    return (
        <div className={cn("rounded-md border-t-2 border-border p-4", className)}>
            <SectionTitle title={title} info={info} />
            <div className="mt-3">{children}</div>
        </div>
    );
}

export type Seg = { pct: number; className: string };

export function Bar({
    segments,
    className,
}: {
    segments: Seg[];
    className?: string;
}) {
    return (
        <div
            className={cn(
                "flex h-2 w-full gap-0.5 overflow-hidden bg-secondary",
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

export function Dot({
    color,
    label,
}: {
    color: string;
    label: React.ReactNode;
}) {
    return (
        <span className="flex items-center gap-1.5">
            <span className={cn("size-2 rounded-full", color)} />
            {label}
        </span>
    );
}
