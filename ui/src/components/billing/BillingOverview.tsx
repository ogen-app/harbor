"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { Loader } from "@/components/ui/loader";
import { Chip, ModeBadge, errorText, useTierCatalog } from "./format";
import { AttentionTable } from "./AttentionTable";
import { FreeTrialCard } from "./FreeTrialCard";
import { CutoverCard } from "./CutoverCard";
import type { BillingSettingsResponse } from "./types";

// BillingOverview is the /billing page body (CON-327): the provider settings
// strip (test/live mode, whether Lemon Squeezy secrets are configured), the
// attention list, the free-month offer and the go-live cutover.
export function BillingOverview({
  onOpenPrice,
}: {
  // Opens a price's variant-mapping drawer (unmapped_price attention rows).
  onOpenPrice: (priceId: string) => void;
}) {
  const [settings, setSettings] = useState<BillingSettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tiers = useTierCatalog();

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/billing/settings", { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(await errorText(r));
        return r.json() as Promise<BillingSettingsResponse>;
      })
      .then((j) => {
        setSettings(j);
        setError(null);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Failed to load settings.");
      });
    return () => controller.abort();
  }, []);

  const s = settings?.available ? settings.settings : null;
  // The write surfaces need a reachable service with a real provider.
  const enabled = !!s && s.provider !== "none" && s.provider !== "";

  return (
    <div className="space-y-6">
      <SettingsStrip settings={settings} error={error} />
      <AttentionTable
        tiers={tiers}
        trialTeardownLive={s?.trialTeardownLive ?? false}
        testMode={s?.testMode ?? true}
        onOpenPrice={onOpenPrice}
      />
      <div className="grid gap-6 xl:grid-cols-2">
        <FreeTrialCard tiers={tiers} appBaseUrl={settings?.appBaseUrl ?? ""} enabled={enabled} />
        <CutoverCard settings={s} enabled={enabled} />
      </div>
    </div>
  );
}

function SettingsStrip({
  settings,
  error,
}: {
  settings: BillingSettingsResponse | null;
  error: string | null;
}) {
  if (!settings && !error) {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-primary px-6 py-4 text-sm text-tertiary-foreground">
        <Loader className="size-4" />
        Loading billing settings…
      </div>
    );
  }
  if (error) {
    return <p className="rounded-xl bg-primary px-6 py-4 text-sm text-destructive">{error}</p>;
  }
  if (!settings?.available) {
    return (
      <p className="rounded-xl bg-primary px-6 py-4 text-sm text-tertiary-foreground">
        The billing-admin service is unavailable. Check that Ogen is running and
        that Harbor’s <code className="font-mono">OGEN_GRPC_ADDR</code> /{" "}
        <code className="font-mono">OGEN_GRPC_TOKEN</code> are configured.
      </p>
    );
  }
  const s = settings.settings;
  const off = !s.provider || s.provider === "none";
  return (
    <dl className="grid gap-x-8 gap-y-3 rounded-xl bg-primary px-6 py-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
      <Fact label="Provider">
        {off ? (
          <Chip tone="neutral" label="Billing off" />
        ) : (
          <span className="text-secondary-foreground">
            Lemon Squeezy
            {s.storeId && (
              <span className="text-tertiary-foreground"> · store {s.storeId}</span>
            )}
          </span>
        )}
      </Fact>
      <Fact label="Mode">{off ? "—" : <ModeBadge testMode={s.testMode} />}</Fact>
      <Fact label="Secrets">
        {off ? (
          "—"
        ) : s.configured ? (
          <Chip tone="good" label="Configured" />
        ) : (
          <Link href="/secrets" className="hover:underline">
            <Chip tone="bad" label="Missing — set in Secrets" />
          </Link>
        )}
      </Fact>
      <Fact label="Never-paid trial teardown">
        {off ? (
          "—"
        ) : s.trialTeardownLive ? (
          <Chip tone="warn" label="Live — Zernio torn down" />
        ) : (
          <Chip tone="neutral" label="Dry run — only logged" />
        )}
      </Fact>
    </dl>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-tertiary-foreground">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}
