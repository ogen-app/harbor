"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { DateRangePicker, type DateRange } from "@/components/ui/date-range-picker";
import { cn } from "@/lib/utils";
import { api, isoDate, money, pct, todayUTC, usd } from "@/components/pnl/format";
import { drillHref } from "@/components/pnl/LedgerTab";
import { MonthlySkeleton, MonthlyTable, monthsBetween, type Sections } from "@/components/pnl/PnlTable";
import { ErrorLine, SkeletonBar, SummaryCell, TONE_TEXT } from "@/components/pnl/shared";
import type { Drill, TenantPnl, TenantPlan } from "@/components/pnl/types";
import type { Tenant } from "./shared";

// TenantPnlTab is the tenant detail page's Profit & loss tab (CON-433): does
// this tenant make money? Net revenue minus the AI cost it was measured to use,
// from the same ledger as /pnl filtered to the tenant, so the figures add up to
// the company P&L. Shared vendor bills join once they are split across tenants
// (CON-432); until then the contribution covers AI cost only. Amounts open
// their entries in the /pnl Ledger.

const SECTIONS: Sections = {
  revenue: { title: "Revenue" },
  direct: { title: "Direct costs", note: "Used by this tenant, measured" },
  shared: { title: "Shared costs", note: "Allocated by rule, estimates" },
};

// The last six whole months up to today, as on /pnl.
function defaultRange(): DateRange {
  const t = todayUTC();
  return {
    from: isoDate(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 5, 1))),
    to: isoDate(t),
  };
}

export function TenantPnlTab({ tenant }: { tenant: Tenant }) {
  const router = useRouter();
  const [range, setRange] = useState<DateRange>(defaultRange);
  const [data, setData] = useState<TenantPnl | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const months = useMemo(() => monthsBetween(range), [range]);

  useEffect(() => {
    if (months.length === 0) return;
    const controller = new AbortController();
    const q = new URLSearchParams({ from: months[0], to: months[months.length - 1] });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    api<TenantPnl>(`/api/tenants/${encodeURIComponent(tenant.id)}/pnl?${q}`, { signal: controller.signal })
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "The P&L could not be loaded");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [tenant.id, months]);

  const drill = useCallback((d: Drill) => router.push(drillHref(d)), [router]);

  const trial = data?.plan?.status === "on_trial" || tenant.billingStatus === "on_trial";

  return (
    <div className="space-y-4">
      {error ? (
        <ErrorLine>The tenant P&amp;L could not be loaded: {error}</ErrorLine>
      ) : (
        <SummaryStrip data={data} tenant={tenant} trial={trial} />
      )}

      <section className="overflow-hidden rounded-[3px] border border-border bg-primary">
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
            <h2 className="text-[15px] font-semibold">Tenant P&amp;L</h2>
            <p className="text-[13px] text-secondary-foreground">
              USD. Payments and AI usage booked to this tenant. Click an amount to see its entries in the Ledger.
            </p>
          </div>
          <DateRangePicker value={range} mode="month" onChange={(r) => setRange(r)} />
        </div>

        {error ? null : !data ? (
          <MonthlySkeleton months={months} />
        ) : (
          <div className={cn("overflow-x-auto border-t border-border transition-opacity", loading && "opacity-60")}>
            <MonthlyTable data={data} prev={null} onDrill={drill} sections={SECTIONS} />
          </div>
        )}

        {data && (
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t border-border px-6 py-3 text-xs text-secondary-foreground">
            <span>
              {data.sharedConfigured
                ? "Allocated amounts add up to each vendor’s real bill across all tenants. The company P&L doesn’t change."
                : "Shared vendor bills (Railway, Resend, Cloudflare, Zernio) aren’t split across tenants yet, so the contribution covers AI cost only."}
            </span>
            {!data.revenueAvailable && <span>Revenue unavailable: {data.revenueError}</span>}
          </div>
        )}
      </section>
    </div>
  );
}

// ── summary strip ────────────────────────────────────────────────────────────

// planLine reads "Pro plan, $49.00 a month", or the tier alone when billing
// could not say what the tenant pays.
function planLine(plan: TenantPlan | null, tenant: Tenant): string {
  if (plan) {
    const per = plan.interval === "year" ? "a year" : plan.interval === "month" ? "a month" : plan.interval;
    return `${plan.tierName} plan, ${money(plan.netMinor * 10_000, plan.currency)} ${per}`.trim();
  }
  return tenant.tier ? `${tenant.tier.name} plan` : "No plan";
}

// SummaryStrip is this month to date for the tenant, styled like /pnl's: one
// card, five cells, no icons, no bold.
function SummaryStrip({ data, tenant, trial }: { data: TenantPnl | null; tenant: Tenant; trial: boolean }) {
  const s = data?.summary;
  return (
    <section aria-label="Month to date" className="space-y-1.5">
      <p className="text-right text-xs text-secondary-foreground">
        {s ? `${s.period.label} · this tenant only` : "Month to date · this tenant only"}
        {data?.testMode ? " · test mode" : ""}
      </p>
      <div className="grid grid-cols-2 rounded-[3px] border border-border bg-primary md:grid-cols-5">
        {data && s ? (
          <>
            <NetRevenueCell data={data} tenant={tenant} trial={trial} />
            <SummaryCell
              label="Direct AI cost"
              value={usd(s.directAi.value ?? 0)}
              tone={TONE_TEXT.negative}
              note={s.directAiBy.map((v) => `${v.name} ${usd(v.amountMicros)}`).join(" · ") || "No AI usage"}
            />
            <SummaryCell
              label="Shared costs"
              value={data.sharedConfigured && s.sharedCosts.value != null ? usd(s.sharedCosts.value) : "—"}
              tone={data.sharedConfigured ? TONE_TEXT.negative : TONE_TEXT.muted}
              note={data.sharedConfigured ? "Allocated" : "Not split to tenants yet"}
            />
            <ContributionCell data={data} />
            <SummaryCell
              label="Margin"
              value={s.marginPct.value == null ? "—" : pct(s.marginPct.value)}
              tone={s.marginPct.value == null ? TONE_TEXT.muted : TONE_TEXT.margin}
              note={s.allTenantsMarginPct == null ? "No tenant revenue yet" : `All tenants: ${pct(s.allTenantsMarginPct)}`}
            />
          </>
        ) : (
          Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="space-y-3 px-6 py-5">
              <SkeletonBar className="w-24" />
              <SkeletonBar className="h-7 w-32" />
              <SkeletonBar className="w-28" />
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function NetRevenueCell({ data, tenant, trial }: { data: TenantPnl; tenant: Tenant; trial: boolean }) {
  const { netRevenue, hasRevenue } = data.summary;
  if (!data.revenueAvailable || netRevenue.value == null) {
    return <SummaryCell label="Net revenue" value="unavailable" tone={TONE_TEXT.muted} note="Payments could not be read" />;
  }
  if (!hasRevenue) {
    return (
      <SummaryCell
        label="Net revenue"
        value="—"
        tone={TONE_TEXT.muted}
        note={trial ? "Trial, no revenue yet" : `No payments yet · ${planLine(data.plan, tenant)}`}
      />
    );
  }
  return (
    <SummaryCell
      label="Net revenue"
      value={usd(netRevenue.value)}
      tone={netRevenue.value < 0 ? TONE_TEXT.negative : TONE_TEXT.positive}
      note={planLine(data.plan, tenant)}
    />
  );
}

function ContributionCell({ data }: { data: TenantPnl }) {
  const v = data.summary.contribution.value;
  if (!data.revenueAvailable || v == null) {
    return <SummaryCell label="Contribution" value="unavailable" tone={TONE_TEXT.muted} note="Needs revenue" />;
  }
  return (
    <SummaryCell
      label="Contribution"
      value={usd(v, "always")}
      tone={v < 0 ? TONE_TEXT.negative : TONE_TEXT.positive}
      note={data.sharedConfigured ? "Revenue minus both costs" : "Revenue minus AI cost"}
    />
  );
}
