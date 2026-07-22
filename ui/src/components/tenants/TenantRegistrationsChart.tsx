"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { InfoIcon } from "@/components/dashboard/primitives";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";

interface RegDay {
  date: string;
  count: number;
  names: string[];
}
interface RegResponse {
  days: RegDay[];
  available: boolean;
  error?: string;
}

// "2026-06-28" → "Jun 28" (parsed as local midnight to avoid TZ drift).
function fmt(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

const CHART_H = 50; // px — kept short per design

export function TenantRegistrationsChart() {
  const [data, setData] = useState<RegResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/tenants/registrations")
      .then((r) => {
        if (!r.ok) throw new Error(`request failed (${r.status})`);
        return r.json();
      })
      .then((j: RegResponse) => {
        if (active) setData(j);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : "Failed to load");
      });
    return () => {
      active = false;
    };
  }, []);

  const days = data?.days ?? [];
  const max = Math.max(1, ...days.map((d) => d.count));
  const total = days.reduce((s, d) => s + d.count, 0);

  return (
    <div className="rounded-xl bg-primary p-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-1.5">
          <h2 className="text-sm font-medium text-foreground">
            Tenant registrations
          </h2>
          <InfoIcon text="New tenants created per day over the last 60 days, from the Ogen control-plane database." />
        </div>
        {data?.available && (
          <span className="text-xs text-tertiary-foreground">
            {total} in 60 days
          </span>
        )}
      </div>

      {error || (data && !data.available) ? (
        <p className="mt-4 text-sm text-tertiary-foreground">
          Registrations unavailable —{" "}
          {error || data?.error || "Ogen database not reachable"}
        </p>
      ) : !data ? (
        <div
          className="mt-4 animate-pulse rounded bg-secondary"
          style={{ height: CHART_H }}
        />
      ) : (
        <div className="mt-4">
          <div
            className="flex items-end gap-[2px]"
            style={{ height: CHART_H }}
          >
            {days.map((d) =>
              d.count > 0 ? (
                <Tooltip key={d.date}>
                  <TooltipTrigger asChild>
                    <div
                      className="flex-1 cursor-default rounded-sm bg-blue-500 transition-colors hover:bg-blue-400"
                      style={{
                        height: `${Math.max((d.count / max) * CHART_H, 4)}px`,
                      }}
                    />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-56 border-foreground bg-foreground text-left text-background">
                    <p className="font-medium">{fmt(d.date)}</p>
                    <p className="text-background/70">
                      {d.count}{" "}
                      {d.count === 1 ? "registration" : "registrations"}
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {d.names.map((n) => (
                        <li key={n} className="truncate">
                          {n}
                        </li>
                      ))}
                    </ul>
                  </TooltipContent>
                </Tooltip>
              ) : (
                <div
                  key={d.date}
                  title={`${fmt(d.date)} · no registrations`}
                  className="flex-1 rounded-sm bg-secondary"
                  style={{ height: "2px" }}
                />
              ),
            )}
          </div>
          <div className="mt-2 flex justify-between text-[11px] text-tertiary-foreground">
            <span>{days.length ? fmt(days[0].date) : ""}</span>
            <span>{days.length ? fmt(days[days.length - 1].date) : ""}</span>
          </div>
        </div>
      )}
    </div>
  );
}
