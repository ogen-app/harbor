"use client";

import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon, GiftIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ui/loader";
import { ColorDot } from "@/components/tenants/shared";
import { cn } from "@/lib/utils";
import type { CatalogEntry } from "@/components/tiers-groups/types";
import { Chip, errorText, tierName } from "./format";
import { ReasonDialog, type ReasonRequest } from "./ReasonDialog";
import type { FreeTrialTierResponse } from "./types";

// FreeTrialCard manages the marketing "1 month free" offer (CON-322 §5.7): which
// single tier currently carries it (card in Lemon Squeezy → $0 → one month →
// the tier's normal price), switching it, turning it off, and the share link.
// Only tiers whose Lemon Squeezy trial variants exist (eligibleTierIds) are
// offered; Ogen still re-checks and its FailedPrecondition message is shown as is.
export function FreeTrialCard({
  tiers,
  appBaseUrl,
  enabled,
}: {
  tiers: CatalogEntry[];
  appBaseUrl: string;
  // false when billing is off (provider none) or the service is unreachable.
  enabled: boolean;
}) {
  const [data, setData] = useState<FreeTrialTierResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<ReasonRequest | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/billing/free-trial-tier", { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(await errorText(r));
        return r.json() as Promise<FreeTrialTierResponse>;
      })
      .then((j) => {
        setData(j);
        setError(null);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Failed to load the offer.");
      });
    return () => controller.abort();
  }, []);

  const offer = data?.offer;
  const current = offer?.tierId ?? "";
  const eligible = offer?.eligibleTierIds ?? [];

  const askSet = (tierId: string) => {
    const name = tierId ? tierName(tierId, tiers) : "";
    setRequest({
      title: tierId ? `Give ${name} a free month` : "Turn the free-month offer off",
      description: tierId
        ? current
          ? `Replaces ${offer?.tierName || tierName(current, tiers)} — only one tier carries the offer at a time. Applies to new checkouts only.`
          : "Applies to new checkouts only. Public pricing pages pick it up within 5 minutes."
        : "New checkouts pay from day one. People already in their free month keep it.",
      confirmLabel: tierId ? "Set free-month tier" : "Turn offer off",
      placeholder: tierId ? "e.g. spring campaign" : "e.g. campaign over",
      run: async (reason) => {
        const res = await fetch("/api/billing/free-trial-tier", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tierId, reason }),
        });
        if (!res.ok) throw new Error(await errorText(res));
        setData((await res.json()) as FreeTrialTierResponse);
      },
    });
  };

  const shareLink =
    current && appBaseUrl
      ? `${appBaseUrl}/signup?plan=${encodeURIComponent(current)}`
      : "";

  const copy = async () => {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure context): the link stays selectable.
    }
  };

  return (
    <div className="rounded-xl bg-primary">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <GiftIcon className="size-4" />
            Free-month offer
          </h2>
          <p className="mt-1 max-w-xl text-xs text-tertiary-foreground">
            One tier at a time can start with a free month: card in Lemon
            Squeezy, $0 today, then the tier’s normal price. Changes apply to new
            checkouts only — people already in their free month keep it — and
            public pricing pages pick them up within 5 minutes. Each account gets
            one free month in total.
          </p>
        </div>
        {offer && (
          <div className="shrink-0">
            {current ? (
              <Chip
                tone="good"
                label={`${offer.tierName || tierName(current, tiers)} · ${offer.trialDays || 30} days free`}
              />
            ) : (
              <Chip tone="neutral" label="Offer off" />
            )}
          </div>
        )}
      </div>

      <div className="space-y-4 px-6 py-4">
        {!data && !error ? (
          <div className="flex items-center gap-2 text-sm text-tertiary-foreground">
            <Loader className="size-4" />
            Loading…
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : !data?.available || !enabled ? (
          <p className="text-sm text-tertiary-foreground">
            Billing is off or unreachable, so the offer can’t be changed.
          </p>
        ) : (
          <>
            {eligible.length === 0 ? (
              <p className="text-sm text-tertiary-foreground">
                No tier has one-month trial variants in Lemon Squeezy yet. Add a
                trial variant for every price of a tier to make it eligible.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Free-month tier">
                {eligible.map((id) => {
                  const t = tiers.find((x) => x.id === id);
                  const selected = id === current;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => !selected && askSet(id)}
                      className={cn(
                        "inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors",
                        selected
                          ? "border-foreground bg-secondary font-medium text-foreground"
                          : "border-border text-secondary-foreground hover:bg-secondary/60",
                      )}
                    >
                      <ColorDot color={t?.color ?? ""} />
                      {t?.name ?? id}
                      {selected && <CheckIcon weight="bold" className="size-3.5" />}
                    </button>
                  );
                })}
                {current && (
                  <Button variant="ghost" size="sm" onClick={() => askSet("")}>
                    Turn offer off
                  </Button>
                )}
              </div>
            )}

            {current && !eligible.includes(current) && (
              <p className="text-xs text-amber-700">
                The current tier is no longer eligible (its trial variants are
                missing). Pick another tier or turn the offer off.
              </p>
            )}

            {current && (
              <div className="grid gap-1.5">
                <span className="text-[11px] uppercase tracking-wide text-tertiary-foreground">
                  Share link
                </span>
                {shareLink ? (
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-md bg-secondary px-3 py-1.5 font-mono text-xs text-secondary-foreground select-all">
                      {shareLink}
                    </code>
                    <Button variant="outline" size="sm" onClick={copy}>
                      {copied ? (
                        <CheckIcon className="size-4" />
                      ) : (
                        <CopyIcon className="size-4" />
                      )}
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-tertiary-foreground">
                    <code className="font-mono">
                      {"{APP_BASE_URL}"}/signup?plan={current}
                    </code>{" "}
                    — set Harbor’s{" "}
                    <code className="font-mono">OGEN_APP_BASE_URL</code> to get a
                    copyable link.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <ReasonDialog request={request} onClose={() => setRequest(null)} />
    </div>
  );
}
