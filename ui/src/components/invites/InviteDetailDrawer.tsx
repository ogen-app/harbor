"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { Mail01Icon } from "@hugeicons/core-free-icons";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react";
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { LabelChip } from "@/components/tenants/shared";
import { cn } from "@/lib/utils";
import {
  EmailStatusBadge,
  InviteStatusBadge,
  canResend,
  canRevoke,
  formatDateTime,
  humanize,
  inviteError,
  relativeDays,
} from "./format";
import type { Invite, InviteResponse } from "./types";

// InviteDetailDrawer is the slide-over for one invite (CON-334 §4, wireframe
// 2B): every field incl. the personal message and internal note, a timeline
// (created → sent ×N → delivery → redeemed / revoked / waiting), and the
// actions. The body mounts fresh per open and re-reads the invite for its
// freshest state, handing it back so the list row updates too.
export function InviteDetailDrawer({
  invite,
  open,
  onOpenChange,
  tierColor,
  onResend,
  onRevoke,
  onLoaded,
}: {
  invite: Invite | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tierColor: (tierId: string) => string;
  onResend: (inv: Invite) => void;
  onRevoke: (inv: Invite) => void;
  onLoaded: (inv: Invite) => void;
}) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-w-[min(36rem,calc(100vw-2.5rem))] gap-0 p-0">
        {invite && (
          <DetailBody
            key={invite.id}
            invite={invite}
            tierColor={tierColor}
            onResend={onResend}
            onRevoke={onRevoke}
            onLoaded={onLoaded}
          />
        )}
      </DrawerContent>
    </Drawer>
  );
}

function DetailBody({
  invite: inv,
  tierColor,
  onResend,
  onRevoke,
  onLoaded,
}: {
  invite: Invite;
  tierColor: (tierId: string) => string;
  onResend: (inv: Invite) => void;
  onRevoke: (inv: Invite) => void;
  onLoaded: (inv: Invite) => void;
}) {
  const [error, setError] = useState<string | null>(null);

  // Re-read once per open: the row may be stale (a delivery event landed, the
  // invite was redeemed meanwhile).
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/invites/${encodeURIComponent(inv.id)}`, {
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await inviteError(r)).message);
        return r.json() as Promise<InviteResponse>;
      })
      .then((j) => onLoaded(j.invite))
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Failed to load the invite.");
      });
    return () => controller.abort();
    // onLoaded is a stable callback from the table; re-run only per invite.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inv.id]);

  const headline =
    inv.status === "pending"
      ? `Expires ${formatDateTime(inv.expiresAt)} — ${relativeDays(inv.expiresAt)}.`
      : inv.status === "expired"
        ? `Expired ${formatDateTime(inv.expiresAt)}. Resend to issue a new link.`
        : inv.status === "redeemed"
          ? `Redeemed ${formatDateTime(inv.redeemedAt)}.`
          : `Revoked ${formatDateTime(inv.revokedAt)}.`;

  return (
    <>
      <div className="shrink-0 px-6 pt-6 pr-12">
        <DrawerTitle className="flex min-w-0 items-center gap-2">
          <HugeiconsIcon
            icon={Mail01Icon}
            className="size-5 shrink-0 text-tertiary-foreground"
          />
          <span className="truncate">{inv.email}</span>
          <InviteStatusBadge status={inv.status} />
        </DrawerTitle>
        <DrawerDescription className="mt-1">{headline}</DrawerDescription>
      </div>

      <div className="mt-4 shrink-0 border-b border-border" />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <p className="px-6 pt-4 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 px-6 py-5 text-sm">
          <Fact label="Tier">
            {inv.tierName ? (
              <span className="flex flex-wrap items-center gap-1.5">
                <LabelChip label={inv.tierName} color={tierColor(inv.tierId)} />
                {!inv.tierPurchasable && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-tertiary-foreground">
                    Not sold
                  </span>
                )}
              </span>
            ) : (
              "Deleted tier"
            )}
          </Fact>
          <Fact label="Groups">
            {inv.groups.length === 0 ? (
              "—"
            ) : (
              <span className="flex flex-wrap gap-1">
                {inv.groups.map((g) => (
                  <LabelChip key={g.id} label={g.name} color={g.color} />
                ))}
              </span>
            )}
          </Fact>
          <Fact label="Invited by">{inv.createdBy || "—"}</Fact>
          <Fact label="Created">{formatDateTime(inv.createdAt)}</Fact>
          <Fact label="Sent">
            {inv.sentCount} time{inv.sentCount === 1 ? "" : "s"}
            {inv.lastSentAt && ` · last ${formatDateTime(inv.lastSentAt)}`}
          </Fact>
          <Fact label="Email delivery">
            <EmailStatusBadge status={inv.emailStatus} />
          </Fact>
          {inv.redeemedTenantId && (
            <Fact label="Workspace" wide>
              <Link
                href={`/tenants/${encodeURIComponent(inv.redeemedTenantId)}`}
                className="text-foreground hover:underline"
              >
                {inv.redeemedTenantName || inv.redeemedTenantId}
              </Link>
              <span className="text-tertiary-foreground">
                {" "}
                ·{" "}
                {inv.redeemedTenantComplimentary
                  ? "still complimentary"
                  : "beta access ended"}
              </span>
            </Fact>
          )}
          <Fact label="Personal message" wide>
            {inv.message ? (
              <span className="whitespace-pre-wrap">“{inv.message}”</span>
            ) : (
              <span className="text-tertiary-foreground">None</span>
            )}
          </Fact>
          <Fact label="Internal note" wide>
            {inv.note ? (
              <span className="whitespace-pre-wrap">{inv.note}</span>
            ) : (
              <span className="text-tertiary-foreground">None</span>
            )}
          </Fact>
        </dl>

        <div className="border-t border-border px-6 py-5">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
            Timeline
          </h3>
          <Timeline invite={inv} />
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-6 py-4">
        {inv.redeemedTenantId ? (
          <Button
            asChild
            variant="defaultInverted"
            size="sm"
            className="font-semibold"
          >
            <Link href={`/tenants/${encodeURIComponent(inv.redeemedTenantId)}`}>
              Open workspace
            </Link>
          </Button>
        ) : (
          <>
            {canRevoke(inv.status) && (
              <Button
                variant="outline"
                size="sm"
                className="text-destructive"
                onClick={() => onRevoke(inv)}
              >
                Revoke
              </Button>
            )}
            {canResend(inv.status) && (
              <Button
                variant="defaultInverted"
                size="sm"
                className="font-semibold"
                onClick={() => onResend(inv)}
              >
                <PaperPlaneTiltIcon className="size-4" />
                Resend
              </Button>
            )}
          </>
        )}
      </div>
    </>
  );
}

type Step = { label: ReactNode; at: string | null; future?: boolean };

// steps builds the invite's history from its fields, oldest first with the
// still-to-happen step last. Ogen keeps counts and the latest instants, not
// every send, so a resend reads as one "Resent" step.
function steps(inv: Invite): Step[] {
  const out: Step[] = [
    {
      label: `Created${inv.createdBy ? ` by ${inv.createdBy}` : ""}`,
      at: inv.createdAt,
    },
  ];
  if (inv.sentCount > 1) {
    out.push({
      label: `Resent ×${inv.sentCount - 1} — new link, old one stopped working`,
      at: inv.lastSentAt,
    });
  } else if (inv.sentCount === 1) {
    out.push({ label: "Sent", at: inv.lastSentAt ?? inv.createdAt });
  }
  if (inv.emailStatus && inv.emailStatus !== "sent") {
    out.push({
      label: `Email ${humanize(inv.emailStatus).toLowerCase()}`,
      at: inv.emailLastEventAt,
    });
  }
  switch (inv.status) {
    case "redeemed":
      out.push({
        label: (
          <>
            Redeemed
            {inv.redeemedTenantName && <> — {inv.redeemedTenantName} created</>}
          </>
        ),
        at: inv.redeemedAt,
      });
      break;
    case "revoked":
      out.push({ label: "Revoked", at: inv.revokedAt });
      break;
    case "expired":
      out.push({ label: "Expired without a signup", at: inv.expiresAt });
      break;
    case "pending":
      out.push({
        label: `Waiting for ${inv.email.split("@")[0]} to sign up`,
        at: inv.expiresAt,
        future: true,
      });
      break;
  }
  const at = (s: Step) =>
    s.future ? Infinity : s.at ? new Date(s.at).getTime() : 0;
  return out.sort((a, b) => at(a) - at(b));
}

function Timeline({ invite }: { invite: Invite }) {
  return (
    <ol className="grid gap-3">
      {steps(invite).map((s, i) => (
        <li key={i} className="flex items-center gap-3 text-sm">
          <span
            aria-hidden
            className={cn(
              "size-2.5 shrink-0 rounded-full",
              s.future
                ? "border-[1.5px] border-dashed border-tertiary-foreground"
                : "bg-foreground",
            )}
          />
          <span
            className={cn(
              "min-w-0 flex-1",
              s.future ? "text-tertiary-foreground" : "text-foreground",
            )}
          >
            {s.label}
          </span>
          <span className="shrink-0 font-mono text-xs tabular-nums text-tertiary-foreground">
            {s.future ? `until ${formatDateTime(s.at)}` : formatDateTime(s.at)}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Fact({
  label,
  wide,
  children,
}: {
  label: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("min-w-0", wide && "col-span-2")}>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-tertiary-foreground">
        {label}
      </dt>
      <dd className="mt-1 text-secondary-foreground">{children}</dd>
    </div>
  );
}
