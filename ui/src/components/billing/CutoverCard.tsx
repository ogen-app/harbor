"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowSquareOutIcon, RocketLaunchIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { CUTOVER_RUNBOOK_URL, errorText } from "./format";
import type { BillingSettings, CutoverResult, CutoverScope } from "./types";

// The two cutovers InvalidateSubscriptions runs. Each re-gates the
// workspaces it selects (complimentary ones excepted), cancels their open
// scheduled changes and asks their owners to check out again.
const SCOPES: Record<
  CutoverScope,
  { label: string; hint: string; none: string; phrase: string }
> = {
  provider_switch: {
    label: "Provider switch (Lemon Squeezy → Polar)",
    hint: "Invalidates every subscription of a provider other than Polar. Run it once, right after Ogen starts billing with Polar; allowed in sandbox and production.",
    none: "No subscriptions of another provider left — nothing to invalidate.",
    phrase: "invalidate other provider subscriptions",
  },
  mode_cutover: {
    label: "Mode cutover (sandbox → production)",
    hint: "Invalidates every sandbox subscription. Run it once, right after switching Ogen from Polar sandbox to production.",
    none: "No sandbox subscriptions left — nothing to invalidate.",
    phrase: "invalidate sandbox subscriptions",
  },
};

// CutoverCard drives the cutovers: pick the scope, a dry run first lists the
// affected workspaces, then a typed confirmation runs it for real. Ogen refuses
// the mode cutover while it runs in sandbox, so that scope is disabled until
// it reports production.
export function CutoverCard({
  settings,
  enabled,
}: {
  settings: BillingSettings | null;
  enabled: boolean;
}) {
  const [scope, setScope] = useState<CutoverScope>("provider_switch");
  const [dryRun, setDryRun] = useState<CutoverResult | null>(null);
  const [result, setResult] = useState<CutoverResult | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"dry" | "real" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phrase, setPhrase] = useState("");

  const inTestMode = settings?.testMode ?? true;
  const scopeAllowed = (s: CutoverScope) => s !== "mode_cutover" || !inTestMode;
  const disabled = !enabled || !scopeAllowed(scope);
  const current = SCOPES[scope];

  const pick = (s: CutoverScope) => {
    if (s === scope || !scopeAllowed(s)) return;
    setScope(s);
    setDryRun(null);
    setResult(null);
    setPhrase("");
    setError(null);
  };

  const run = async (dry: boolean) => {
    setBusy(dry ? "dry" : "real");
    setError(null);
    try {
      const res = await fetch("/api/billing/cutover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: dry, scope }),
      });
      if (!res.ok) throw new Error(await errorText(res));
      const out = (await res.json()) as CutoverResult;
      if (dry) {
        setDryRun(out);
        setResult(null);
        setPhrase("");
        resolveNames(out.tenantIds);
      } else {
        setResult(out);
        setDryRun(null);
        setPhrase("");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "The cutover request failed.");
    } finally {
      setBusy(null);
    }
  };

  // Resolve tenant ids to names for the dry-run list (best-effort).
  const resolveNames = (ids: string[]) => {
    if (ids.length === 0) return;
    fetch("/api/tenants")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { tenants?: { id: string; name: string }[] } | null) => {
        const m: Record<string, string> = {};
        for (const t of j?.tenants ?? []) m[t.id] = t.name;
        setNames(m);
      })
      .catch(() => {});
  };

  return (
    <div className="rounded-xl bg-primary">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-6 py-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <RocketLaunchIcon className="size-4" />
            Cutover
          </h2>
          <p className="mt-1 max-w-xl text-xs text-tertiary-foreground">
            Invalidates subscriptions that can no longer bill, puts those
            workspaces back behind the checkout gate and asks their owners to
            check out again. Follow the{" "}
            <a
              href={CUTOVER_RUNBOOK_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground"
            >
              cutover runbook
              <ArrowSquareOutIcon className="size-3" />
            </a>
            ; it includes setting <span className="font-mono">polar_access_token</span>{" "}
            and <span className="font-mono">polar_webhook_secret</span> for the new
            mode in{" "}
            <Link href="/secrets" className="underline underline-offset-2 hover:text-foreground">
              Secrets
            </Link>
            .
          </p>
        </div>
      </div>

      <div className="space-y-4 px-6 py-4">
        <div className="grid gap-2" role="radiogroup" aria-label="Cutover scope">
          {(Object.keys(SCOPES) as CutoverScope[]).map((s) => {
            const selected = s === scope;
            const allowed = scopeAllowed(s);
            return (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-disabled={!allowed}
                disabled={!enabled || busy !== null}
                onClick={() => pick(s)}
                className={cn(
                  "rounded-md border px-3 py-2 text-left transition-colors",
                  selected
                    ? "border-foreground bg-secondary"
                    : "border-border hover:bg-secondary/60",
                  !allowed && "cursor-not-allowed opacity-60 hover:bg-transparent",
                )}
              >
                <span className="block text-sm font-medium text-foreground">
                  {SCOPES[s].label}
                </span>
                <span className="mt-0.5 block text-xs text-tertiary-foreground">
                  {allowed
                    ? SCOPES[s].hint
                    : "Ogen is still in Polar sandbox. Switch it to production first — the mode cutover is refused until then."}
                </span>
              </button>
            );
          })}
        </div>

        {!enabled && (
          <p className="text-sm text-tertiary-foreground">Billing is off or unreachable.</p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => run(true)}
            disabled={disabled || busy !== null}
          >
            {busy === "dry" ? "Running dry run…" : "1. Dry run"}
          </Button>
          {dryRun && (
            <span className="text-sm text-secondary-foreground">
              {dryRun.count === 0
                ? current.none
                : `${dryRun.count} workspace${dryRun.count === 1 ? "" : "s"} would be re-gated.`}
            </span>
          )}
        </div>

        {dryRun && dryRun.tenantIds.length > 0 && (
          <>
            <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-md border border-border">
              {dryRun.tenantIds.map((id) => (
                <li key={id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <Link
                    href={`/tenants/${encodeURIComponent(id)}`}
                    className="truncate text-secondary-foreground hover:underline"
                  >
                    {names[id] ?? id}
                  </Link>
                  {names[id] && (
                    <span className="truncate font-mono text-xs text-tertiary-foreground">{id}</span>
                  )}
                </li>
              ))}
            </ul>

            <form
              className="grid max-w-md gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (phrase.trim() === current.phrase) void run(false);
              }}
            >
              <Label htmlFor="cutover-confirm">
                Type <span className="font-mono">{current.phrase}</span> to run it
                for real
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="cutover-confirm"
                  value={phrase}
                  onChange={(e) => setPhrase(e.target.value)}
                  autoComplete="off"
                  disabled={disabled || busy !== null}
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="destructiveInverted"
                  disabled={disabled || busy !== null || phrase.trim() !== current.phrase}
                >
                  {busy === "real" ? "Running…" : "2. Run cutover"}
                </Button>
              </div>
            </form>
          </>
        )}

        {result && (
          <p className="text-sm text-emerald-700" role="status">
            Cutover done: {result.count} workspace{result.count === 1 ? "" : "s"}{" "}
            re-gated and their owners notified.
          </p>
        )}

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
