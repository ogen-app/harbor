import { cn } from "@/lib/utils";

// Types and small pieces shared by the Lifecycle tab and the tenant's Lifecycle
// card (CON-437). The shapes mirror src/stats/lifecycle.

export type Progress = "signed_up" | "connected" | "generating" | "first_post" | "regular";
export type Health = "active" | "cooling" | "quiet" | "churned";
export type Tone = "failing" | "risk" | "moved" | "info";

export interface Reason {
    kind: string;
    tone: Tone;
    text: string;
}

export interface Milestones {
    signedUp: string;
    connected: string | null;
    generating: string | null;
    firstPost: string | null;
    regular: string | null;
}

export interface LifecycleTenant {
    id: string;
    name: string;
    tier: string;
    groups: { id: string; name: string; color: string }[];
    status: string;
    paying: boolean;
    progress: Progress;
    health: Health;
    milestones: Milestones;
    enteredStageAt: string;
    daysInStage: number;
    lastActivityAt: string | null;
    idleDays: number;
    stuck: boolean;
    publishWeeks: number;
    reasons: Reason[];
    moved: boolean;
    churnedAt: string | null;
}

export const STAGES: { key: Progress; label: string; sub: string }[] = [
    { key: "signed_up", label: "Signed up", sub: "no social yet" },
    { key: "connected", label: "Connected", sub: "no AI generation yet" },
    { key: "generating", label: "Generating", sub: "no published post yet" },
    { key: "first_post", label: "First post", sub: "fewer than 3 weeks posted" },
    { key: "regular", label: "Regular", sub: "posted in 3+ weeks" },
];

// Invited is the step before Signed up: an open tester invite, not a tenant yet.
export const INVITED = { key: "invited", label: "Invited", sub: "invite not redeemed" } as const;

export const stageLabel = (p: Progress | "invited") =>
    p === "invited" ? INVITED.label : (STAGES.find((s) => s.key === p)?.label ?? p);

export const HEALTH_LABEL: Record<Health, string> = {
    active: "Active",
    cooling: "Cooling",
    quiet: "Quiet",
    churned: "Churned",
};

export const BLUE = "#2563EB";
export const RED = "#DC2626";
export const AMBER = "#D97706";
export const GREEN = "#059669";
export const GREY = "#A39E97";

export const TONE_CLASS: Record<Tone, string> = {
    failing: "text-[#B91C1C]",
    risk: "text-[#B45309]",
    moved: "text-[#2563EB]",
    info: "text-secondary-foreground",
};

// HealthDot: shape as well as colour, so the states read without colour too:
// filled green, filled amber, hollow ring, grey.
export function HealthDot({ health, className }: { health: Health; className?: string }) {
    const base = cn("inline-block size-2 shrink-0 rounded-full", className);
    switch (health) {
        case "active":
            return <span aria-hidden className={base} style={{ background: GREEN }} />;
        case "cooling":
            return <span aria-hidden className={base} style={{ background: AMBER }} />;
        case "quiet":
            return <span aria-hidden className={cn(base, "border-[1.5px]")} style={{ borderColor: "#86817A" }} />;
        default:
            return <span aria-hidden className={base} style={{ background: "#C9C4BD" }} />;
    }
}

export function healthText(t: LifecycleTenant): string {
    if (t.health === "active" || t.health === "churned") return HEALTH_LABEL[t.health];
    return `${HEALTH_LABEL[t.health]} ${t.idleDays}d`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-11-26T…" → "26 Nov"; the year is added when it isn't this year's.
export function shortDate(iso: string | null | undefined, now = new Date()): string {
    if (!iso) return "—";
    const d = new Date(iso);
    const base = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
    return d.getUTCFullYear() === now.getUTCFullYear() ? base : `${base} ${d.getUTCFullYear()}`;
}

// "same day", "1 day", "17 days".
export function span(fromIso: string, toIso: string): string {
    const days = Math.max(0, Math.floor((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 86_400_000));
    if (days === 0) return "same day";
    return days === 1 ? "1 day" : `${days} days`;
}

export const fmtDays = (d: number | null | undefined) => (d == null ? "—" : `${d < 10 ? d.toFixed(1) : Math.round(d)}d`);
export const fmtPct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v * 100)}%`);
