"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ui/loader";
import { cn } from "@/lib/utils";
import { Chip, errorText } from "@/components/billing/format";
import { ReasonDialog, type ReasonRequest } from "@/components/billing/ReasonDialog";
import {
  MoveTierDialog,
  useTierVersions,
} from "@/components/billing/MoveTierDialog";
import type {
  TenantBilling,
  TenantBillingResponse,
} from "@/components/billing/types";
import { formatDate } from "@/components/invites/format";
import type { Invite, InvitesListResponse } from "@/components/invites/types";
import type { Tenant, UsersState } from "./shared";

// How many member addresses to look up when finding the invite a workspace came
// from (the owner is almost always among the first few).
const INVITE_LOOKUP_LIMIT = 5;

// AccessCard sits atop the tenant's General information (CON-334 §5/5b,
// wireframe 4): whether the workspace is a complimentary tester workspace, who
// invited it and when, and the two levers — Change tier (the existing tier
// version picker, hidden tiers allowed) and End beta access / Make
// complimentary (billing.v1 SetComplimentary, reason required). onChanged lets
// the page refresh its header billing badge.
export function AccessCard({
  tenant: t,
  users,
  onChanged,
}: {
  tenant: Tenant;
  users: UsersState;
  onChanged: () => void;
}) {
  const enc = encodeURIComponent(t.id);
  const [billing, setBilling] = useState<TenantBilling | null>(null);
  const [billingAvailable, setBillingAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [request, setRequest] = useState<ReasonRequest | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [notice, setNotice] = useState<{ msg: string; error?: boolean } | null>(
    null,
  );
  const tierVersions = useTierVersions();

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/tenants/${enc}/billing`, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(await errorText(r));
        return r.json() as Promise<TenantBillingResponse>;
      })
      .then((j) => {
        setBillingAvailable(j.available);
        setBilling(j.available ? j.billing : null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setBillingAvailable(false);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [enc]);

  // Find the invite this workspace was redeemed from: Ogen has no tenant→invite
  // lookup, so search the redeemed invites by the members' addresses and match
  // on redeemed_tenant_id.
  const emails = (users.users ?? [])
    .map((u) => u.email)
    .filter(Boolean)
    .slice(0, INVITE_LOOKUP_LIMIT);
  const emailKey = emails.join(",");
  useEffect(() => {
    if (!emailKey) return;
    const controller = new AbortController();
    Promise.all(
      emailKey.split(",").map((e) =>
        fetch(
          `/api/invites?status=redeemed&q=${encodeURIComponent(e)}&page_size=20`,
          { signal: controller.signal },
        )
          .then((r) => (r.ok ? (r.json() as Promise<InvitesListResponse>) : null))
          .catch(() => null),
      ),
    ).then((pages) => {
      if (controller.signal.aborted) return;
      const hit = pages
        .flatMap((p) => p?.invites ?? [])
        .find((i) => i.redeemedTenantId === t.id);
      setInvite(hit ?? null);
    });
    return () => controller.abort();
  }, [emailKey, t.id]);

  const flash = (msg: string, isError = false) => {
    setNotice({ msg, error: isError });
    window.setTimeout(() => setNotice(null), 4000);
  };

  // Prefer the billing read; fall back to the list summary when billing-admin
  // is unavailable (Ogen reports complimentary there either way).
  const complimentary =
    billing?.complimentary ?? t.billingStatus === "complimentary";

  const askComplimentary = (next: boolean) =>
    setRequest({
      title: next
        ? `Make ${t.name} complimentary?`
        : `End beta access for ${t.name}?`,
      description: next
        ? "The workspace becomes a tester workspace: never billed, and its owner can switch between public tiers without checking out. Use this for someone who already has an account — inviting them fails with account_exists."
        : `${t.name} will need a paid plan on its next request. The owner keeps their data and still gets the free month if one is offered. Their tier stays as it is until they check out.`,
      confirmLabel: next ? "Make complimentary" : "End beta access",
      placeholder: next ? "e.g. design partner" : "e.g. Beta wave 1 ended",
      run: async (reason) => {
        const res = await fetch(`/api/tenants/${enc}/billing/complimentary`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ complimentary: next, reason }),
        });
        if (!res.ok) throw new Error(await errorText(res));
        const j = (await res.json()) as TenantBillingResponse;
        setBilling(j.billing);
        setBillingAvailable(true);
        flash(next ? "Workspace is complimentary." : "Beta access ended.");
        onChanged();
      },
    });

  return (
    <section className="rounded-lg bg-primary">
      <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
          Access
        </h2>
        {loading ? (
          <Loader className="size-3.5 border-[1.5px]" />
        ) : complimentary ? (
          <Chip tone="good" label="Complimentary · tester" />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-6 px-6 py-5">
        <dl className="flex flex-wrap gap-x-12 gap-y-4 text-sm">
          <Fact label="Billing">
            {complimentary
              ? "Complimentary — never billed"
              : billingLabel(billing, billingAvailable)}
          </Fact>
          {invite && (
            <>
              <Fact label="Invited">
                <span className="flex items-baseline gap-3">
                  <span>{formatDate(invite.createdAt)}</span>
                  <Link
                    href={`/invites?invite=${encodeURIComponent(invite.id)}`}
                    className="text-xs font-medium text-foreground underline-offset-2 hover:underline"
                  >
                    View invite
                  </Link>
                </span>
                {invite.createdBy && (
                  <span className="block text-xs text-tertiary-foreground">
                    by {invite.createdBy}
                  </span>
                )}
              </Fact>
              <Fact label="Redeemed">
                {formatDate(invite.redeemedAt)}
                <span className="block text-xs text-tertiary-foreground">
                  by {invite.email}
                </span>
              </Fact>
            </>
          )}
        </dl>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMoveOpen(true)}
            disabled={tierVersions.length === 0}
          >
            Change tier
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => askComplimentary(!complimentary)}
            disabled={loading}
          >
            {complimentary ? "End beta access" : "Make complimentary"}
          </Button>
        </div>
      </div>

      <ReasonDialog request={request} onClose={() => setRequest(null)} />
      <MoveTierDialog
        target={moveOpen ? { tenantId: t.id, tenantName: t.name } : null}
        groups={tierVersions}
        onClose={() => setMoveOpen(false)}
        onMoved={(msg) => {
          flash(msg);
          onChanged();
        }}
      />

      {notice && (
        <div
          role={notice.error ? "alert" : "status"}
          className={cn(
            "fixed bottom-6 right-6 z-[200] max-w-sm rounded-md border bg-primary px-4 py-2 text-sm shadow-xl",
            notice.error
              ? "border-destructive/40 text-destructive"
              : "border-border text-foreground",
          )}
        >
          {notice.msg}
        </div>
      )}
    </section>
  );
}

// billingLabel summarises a non-complimentary workspace's billing in words.
function billingLabel(b: TenantBilling | null, available: boolean): string {
  if (!b) return available ? "—" : "Billing is off";
  if (b.subscriptions.some((s) => !s.invalidatedAt && s.status !== "expired")) {
    return "Paying";
  }
  return b.billingRequired ? "Awaiting checkout" : "Not required";
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
        {label}
      </dt>
      <dd className="mt-1.5 font-medium text-foreground">{children}</dd>
    </div>
  );
}
