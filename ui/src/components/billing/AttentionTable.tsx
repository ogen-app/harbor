"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  PauseIcon,
  StackIcon,
} from "@phosphor-icons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { MoreVerticalSquare02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Loader } from "@/components/ui/loader";
import { cn } from "@/lib/utils";
import type { CatalogEntry } from "@/components/tiers-groups/types";
import {
  BillingStatusBadge,
  Chip,
  LEMON_SQUEEZY_DASHBOARD,
  ReasonBadge,
  errorText,
  formatDate,
  lemonSqueezySubscriptionUrl,
  reasonHint,
  tierName,
} from "./format";
import { ReasonDialog, type ReasonRequest } from "./ReasonDialog";
import { MoveTierDialog, useTierVersions } from "./MoveTierDialog";
import type { AttentionItem, AttentionResponse } from "./types";

// Columns: workspace · reason · status · since · renews/ends · tier · actions.
const GRID =
  "grid grid-cols-[minmax(0,1.6fr)_minmax(0,1.8fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,0.8fr)_2.75rem] items-center gap-3";

// AttentionTable lists the workspaces that need an operator billing decision
// (ListBillingAttention): past_due / unpaid / paused, expired in the last 30
// days (incl. never-paid trials and whether their Zernio teardown ran), duplicate
// subscriptions, failed scheduled changes, and webhooks that matched no tenant.
// Ogen takes no action on its own, so each row offers the operator's levers:
// suspend, move tier/version, resync, and the Lemon Squeezy dashboard for
// refunds and cancellations.
export function AttentionTable({
  tiers,
  trialTeardownLive,
}: {
  tiers: CatalogEntry[];
  trialTeardownLive: boolean;
}) {
  const [data, setData] = useState<AttentionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageToken, setPageToken] = useState("");
  const [prevTokens, setPrevTokens] = useState<string[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ msg: string; error?: boolean } | null>(
    null,
  );
  const [request, setRequest] = useState<ReasonRequest | null>(null);
  const [moveTarget, setMoveTarget] = useState<{
    tenantId: string;
    tenantName: string;
  } | null>(null);
  const tierVersions = useTierVersions();

  const load = useCallback((token: string, signal?: AbortSignal) => {
    const qs = token ? `?page_token=${encodeURIComponent(token)}` : "";
    return fetch(`/api/billing/attention${qs}`, { signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(await errorText(r));
        return r.json() as Promise<AttentionResponse>;
      })
      .then((j) => {
        setData(j);
        setLoadError(null);
      })
      .catch((e: unknown) => {
        if (signal?.aborted) return;
        setLoadError(e instanceof Error ? e.message : "Failed to load.");
      })
      .finally(() => {
        if (!signal?.aborted) setLoading(false);
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(pageToken, controller.signal);
    return () => controller.abort();
  }, [load, pageToken]);

  const flash = useCallback((msg: string, isError = false) => {
    setNotice({ msg, error: isError });
    window.setTimeout(() => setNotice(null), 4000);
  }, []);

  const resync = async (item: AttentionItem, key: string) => {
    setBusyKey(key);
    try {
      const res = await fetch(
        `/api/tenants/${encodeURIComponent(item.tenantId)}/billing/resync`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(await errorText(res));
      const j = (await res.json()) as { corrected?: number };
      const n = j.corrected ?? 0;
      flash(
        `${item.tenantName}: ${n === 0 ? "already in step" : `${n} subscription${n === 1 ? "" : "s"} corrected`}.`,
      );
      load(pageToken);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Resync failed.", true);
    } finally {
      setBusyKey(null);
    }
  };

  const askSuspend = (item: AttentionItem) =>
    setRequest({
      title: `Suspend ${item.tenantName}`,
      description:
        "Members are locked out immediately and scheduled posts pause. Published posts stay live. Reactivate from the Tenants page.",
      confirmLabel: "Suspend",
      placeholder: "e.g. non-payment",
      destructive: true,
      run: async (reason) => {
        const res = await fetch(
          `/api/tenants/${encodeURIComponent(item.tenantId)}/status`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "suspended", reason }),
          },
        );
        if (!res.ok && res.status !== 204) throw new Error(await errorText(res));
        flash(`${item.tenantName} suspended.`);
      },
    });

  const goNext = () => {
    if (!data?.nextPageToken) return;
    setPrevTokens((p) => [...p, pageToken]);
    setPageToken(data.nextPageToken);
    setLoading(true);
  };
  const goPrev = () => {
    if (prevTokens.length === 0) return;
    const n = [...prevTokens];
    const t = n.pop() ?? "";
    setPrevTokens(n);
    setPageToken(t);
    setLoading(true);
  };

  const items = data?.items ?? [];
  const hasPrev = prevTokens.length > 0;
  const hasNext = !!data?.nextPageToken;

  return (
    <div className="rounded-xl bg-primary">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">Needs attention</h2>
          <p className="mt-1 max-w-2xl text-xs text-tertiary-foreground">
            Workspaces with a billing problem, newest first. Ogen never changes a
            workspace’s tier or status on its own — suspend, move the tier, or
            resync from here. Refunds and cancellations happen in{" "}
            <a
              href={LEMON_SQUEEZY_DASHBOARD}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Lemon Squeezy
            </a>
            .
          </p>
        </div>
      </div>

      <div className="overflow-x-auto rounded-b-xl">
        {loading ? (
          <div className="flex items-center gap-2 p-6 text-sm text-tertiary-foreground">
            <Loader className="size-4" />
            Loading…
          </div>
        ) : loadError ? (
          <p className="p-6 text-sm text-destructive">{loadError}</p>
        ) : !data?.available ? (
          <p className="p-6 text-sm text-tertiary-foreground">
            The billing-admin service is unavailable.
          </p>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 p-12 text-center">
            <CheckCircleIcon className="size-8 text-emerald-500" />
            <p className="text-sm text-tertiary-foreground">
              Nothing needs attention.
            </p>
          </div>
        ) : (
          <div className="min-w-[56rem] divide-y divide-border">
            <div className={`${GRID} px-6 py-2.5`}>
              <HeaderCell label="Workspace" />
              <HeaderCell label="Reason" />
              <HeaderCell label="Status" />
              <HeaderCell label="Since" />
              <HeaderCell label="Renews / ends" />
              <HeaderCell label="Tier" />
              <span aria-hidden />
            </div>
            {items.map((item, i) => {
              const key = `${item.tenantId}:${item.reason}:${item.subscription?.id ?? item.webhookEvent?.id ?? i}`;
              return (
                <AttentionRow
                  key={key}
                  item={item}
                  tiers={tiers}
                  trialTeardownLive={trialTeardownLive}
                  busy={busyKey === key}
                  onResync={() => resync(item, key)}
                  onSuspend={() => askSuspend(item)}
                  onMove={() =>
                    setMoveTarget({
                      tenantId: item.tenantId,
                      tenantName: item.tenantName,
                    })
                  }
                />
              );
            })}
          </div>
        )}
      </div>

      {data?.available && !loading && !loadError && (hasPrev || hasNext) && (
        <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-3">
          <Button variant="outline" size="sm" onClick={goPrev} disabled={!hasPrev}>
            Previous
          </Button>
          <Button variant="outline" size="sm" onClick={goNext} disabled={!hasNext}>
            Next
          </Button>
        </div>
      )}

      <ReasonDialog request={request} onClose={() => setRequest(null)} />
      <MoveTierDialog
        target={moveTarget}
        groups={tierVersions}
        onClose={() => setMoveTarget(null)}
        onMoved={(msg) => flash(msg)}
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
    </div>
  );
}

function AttentionRow({
  item,
  tiers,
  trialTeardownLive,
  busy,
  onResync,
  onSuspend,
  onMove,
}: {
  item: AttentionItem;
  tiers: CatalogEntry[];
  trialTeardownLive: boolean;
  busy: boolean;
  onResync: () => void;
  onSuspend: () => void;
  onMove: () => void;
}) {
  const s = item.subscription;
  const w = item.webhookEvent;
  const hasTenant = !!item.tenantId;
  const ends = s?.endsAt ?? null;
  const renews = s?.renewsAt ?? null;

  return (
    <div
      className={cn(
        `${GRID} px-6 py-3.5 text-sm transition-colors hover:bg-secondary/40`,
        busy && "opacity-60",
      )}
    >
      {/* Workspace — or, for a webhook with no tenant, the event itself. */}
      <span className="flex min-w-0 flex-col">
        {hasTenant ? (
          <Link
            href={`/tenants/${encodeURIComponent(item.tenantId)}?tab=billing`}
            className="truncate font-medium text-foreground hover:underline"
          >
            {item.tenantName || item.tenantId}
          </Link>
        ) : (
          <span className="truncate font-medium text-foreground">
            {w?.eventName || "Webhook"}
          </span>
        )}
        {!hasTenant && w && (
          <span className="truncate font-mono text-xs text-tertiary-foreground">
            object {w.providerObjectId || "—"}
            {w.error ? ` · ${w.error}` : ""}
          </span>
        )}
      </span>

      <span className="flex min-w-0 flex-col items-start gap-1">
        <ReasonBadge reason={item.reason} />
        {item.reason === "expired_never_paid" ? (
          <TeardownNote status={item.teardownStatus} live={trialTeardownLive} />
        ) : (
          <span className="line-clamp-1 text-xs text-tertiary-foreground">
            {reasonHint(item.reason)}
          </span>
        )}
      </span>

      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        {s ? (
          <>
            <BillingStatusBadge status={s.status} />
            {s.testMode && <Chip tone="warn" label="Test" />}
          </>
        ) : w ? (
          <Chip tone="bad" label={w.outcome || "unmatched"} />
        ) : (
          <span className="text-tertiary-foreground">—</span>
        )}
      </span>

      <span className="text-xs tabular-nums text-secondary-foreground">
        {formatDate(item.since)}
      </span>

      <span className="text-xs tabular-nums text-secondary-foreground">
        {ends ? `Ends ${formatDate(ends)}` : renews ? `Renews ${formatDate(renews)}` : "—"}
      </span>

      <span className="truncate text-secondary-foreground">
        {s ? tierName(s.tierId, tiers) : "—"}
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="smIcon"
            disabled={busy}
            aria-label={`Actions for ${item.tenantName || "webhook"}`}
            className="h-9 w-9 justify-self-end text-tertiary-foreground data-[state=open]:border-quaternary data-[state=open]:bg-quaternary data-[state=open]:text-primary-foreground"
          >
            <HugeiconsIcon icon={MoreVerticalSquare02Icon} className="size-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" sideOffset={6} className="min-w-56">
          {hasTenant && (
            <>
              <DropdownMenuItem asChild>
                <Link href={`/tenants/${encodeURIComponent(item.tenantId)}?tab=billing`}>
                  <ArrowSquareOutIcon className="size-4" />
                  Open workspace
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onResync}>
                <ArrowsClockwiseIcon className="size-4" />
                Resync from Lemon Squeezy
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onMove}>
                <StackIcon className="size-4" />
                Move tier / version…
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={onSuspend}>
                <PauseIcon className="size-4" />
                Suspend…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem asChild>
            <a
              href={lemonSqueezySubscriptionUrl(s?.providerSubscriptionId ?? "")}
              target="_blank"
              rel="noreferrer"
            >
              <ArrowSquareOutIcon className="size-4" />
              {s ? "Open in Lemon Squeezy" : "Lemon Squeezy dashboard"}
            </a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// TeardownNote says whether a never-paid trial's Zernio teardown actually ran
// (enqueued) or was only logged because BILLING_TRIAL_TEARDOWN_LIVE is off.
function TeardownNote({ status, live }: { status: string; live: boolean }) {
  if (status === "enqueued") {
    return <span className="text-xs text-red-700">Zernio teardown enqueued</span>;
  }
  if (status === "dry_run") {
    return (
      <span className="text-xs text-amber-700">Zernio teardown only logged (dry run)</span>
    );
  }
  return (
    <span className="text-xs text-tertiary-foreground">
      {live ? "Zernio teardown pending" : "No teardown — dry run is on"}
    </span>
  );
}

function HeaderCell({ label }: { label: string }) {
  return (
    <span className="truncate text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
      {label}
    </span>
  );
}
