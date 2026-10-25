import { cn } from "@/lib/utils";
import type { InviteErrorBody, InviteStatus } from "./types";

// Shared presentation helpers for the invites surfaces (list, detail drawer, new
// invite drawer, tenant Access card), so statuses and errors read the same
// everywhere.

type Tone = "good" | "warn" | "bad" | "neutral" | "info";

const TONE: Record<Tone, { dot: string; chip: string }> = {
  good: { dot: "bg-emerald-500", chip: "bg-emerald-500/10 text-emerald-700" },
  warn: { dot: "bg-amber-500", chip: "bg-amber-500/10 text-amber-700" },
  bad: { dot: "bg-red-500", chip: "bg-red-500/10 text-red-700" },
  info: { dot: "bg-sky-500", chip: "bg-sky-500/10 text-sky-700" },
  neutral: {
    dot: "bg-neutral-400",
    chip: "bg-neutral-400/15 text-tertiary-foreground",
  },
};

// Pill is the house status pill: a tinted chip with a leading dot.
export function Pill({
  tone,
  label,
  className,
}: {
  tone: Tone;
  label: string;
  className?: string;
}) {
  const t = TONE[tone];
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        t.chip,
        className,
      )}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", t.dot)} />
      {label}
    </span>
  );
}

const STATUS: Record<InviteStatus, { tone: Tone; label: string }> = {
  pending: { tone: "info", label: "Pending" },
  redeemed: { tone: "good", label: "Redeemed" },
  expired: { tone: "warn", label: "Expired" },
  revoked: { tone: "neutral", label: "Revoked" },
};

// InviteStatusBadge: pending sky, redeemed emerald, expired amber, revoked
// neutral (wireframe 2).
export function InviteStatusBadge({ status }: { status: InviteStatus }) {
  const s = STATUS[status] ?? { tone: "neutral" as Tone, label: status };
  return <Pill tone={s.tone} label={s.label} />;
}

// Email delivery: good outcomes green, bounces/complaints/failures red, skipped
// sends (suppressed, disabled) amber, a plain send neutral.
const EMAIL_STATUS: Record<string, { tone: Tone; label: string }> = {
  sent: { tone: "neutral", label: "Sent" },
  delivered: { tone: "good", label: "Delivered" },
  opened: { tone: "good", label: "Opened" },
  clicked: { tone: "good", label: "Clicked" },
  delivery_delayed: { tone: "warn", label: "Delayed" },
  bounced: { tone: "bad", label: "Bounced" },
  complained: { tone: "bad", label: "Complained" },
  failed: { tone: "bad", label: "Failed" },
  skipped_suppressed: { tone: "warn", label: "Suppressed" },
  skipped_disabled: { tone: "warn", label: "Skipped" },
};

export function EmailStatusBadge({ status }: { status: string }) {
  if (!status) {
    return <span className="text-xs text-tertiary-foreground">Queued</span>;
  }
  const s = EMAIL_STATUS[status] ?? {
    tone: status.startsWith("skipped") ? ("warn" as Tone) : ("neutral" as Tone),
    label: humanize(status),
  };
  return <Pill tone={s.tone} label={s.label} />;
}

// humanize turns a snake_case token into "Sentence case".
export function humanize(s: string): string {
  if (!s) return "";
  const words = s.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function formatDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// relativeDays renders "in 14 days" / "2 days ago" / "today" for an instant.
export function relativeDays(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.round((d.getTime() - Date.now()) / 86_400_000);
  if (days === 0) return "today";
  if (days > 0) return `in ${days} day${days === 1 ? "" : "s"}`;
  return `${-days} day${days === -1 ? "" : "s"} ago`;
}

// shortOperator trims an operator email to its local part for dense table cells
// ("serhii@getogen.com" → "serhii").
export function shortOperator(email: string): string {
  return email.split("@")[0] || email;
}

// Resend is offered on pending and expired invites, revoke on pending only.
export const canResend = (s: InviteStatus) => s === "pending" || s === "expired";
export const canRevoke = (s: InviteStatus) => s === "pending";

// The guidance shown for Ogen's FailedPrecondition sub-reasons (CON-334 §6).
export const ERROR_GUIDANCE: Record<string, string> = {
  account_exists:
    "This email already has an Ogen account. Open their workspace and use Make complimentary + set tier instead.",
  tier_not_active:
    "This tier has no published version — publish one in Plans first.",
};

// inviteError turns a failed response into the operator-facing message: the
// guidance for a known sub-reason, otherwise Ogen's own message.
export async function inviteError(
  res: Response,
): Promise<{ message: string; code?: string }> {
  const body = (await res.json().catch(() => null)) as InviteErrorBody | null;
  if (body?.code && ERROR_GUIDANCE[body.code]) {
    return { message: ERROR_GUIDANCE[body.code], code: body.code };
  }
  if (res.status === 404) {
    return { message: "This invite no longer exists." };
  }
  if (res.status === 502) {
    return {
      message:
        "Harbor couldn’t authenticate to Ogen — check OGEN_GRPC_TOKEN in Harbor’s config.",
    };
  }
  return {
    message: body?.error || `Request failed (${res.status})`,
    code: body?.code,
  };
}

// The expiry presets (CON-334 §2): 3 / 7 / 14 (default) / 30 days.
export const EXPIRY_PRESETS = [3, 7, 14, 30] as const;
export const DEFAULT_EXPIRY_DAYS = 14;

// A minimal, permissive address check for the bulk list (Ogen validates for
// real); it only weeds out obvious non-addresses before fan-out.
export function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
