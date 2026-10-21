"use client";

import { useEffect, useState } from "react";
import { CheckIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ColorDot } from "@/components/tenants/shared";
import { cn } from "@/lib/utils";
import { errorText } from "./format";

// A published tier version an operator may move a workspace to, grouped by tier
// (from /api/tier-entitlements, like the Tenants table's Version picker).
export type TierVersionGroup = {
  tierId: string;
  tierName: string;
  tierColor: string;
  versions: { id: string; version: number; status: string }[];
};

// useTierVersions loads the tier versions once; degrades to [] if unavailable.
export function useTierVersions(): TierVersionGroup[] {
  const [groups, setGroups] = useState<TierVersionGroup[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/tier-entitlements", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          j: {
            available?: boolean;
            tiers?: {
              tierId: string;
              tierName: string;
              tierColor: string;
              versions?: { id: string; version: number; status: string }[];
            }[];
          } | null,
        ) => {
          if (!j?.available) return;
          setGroups(
            (j.tiers ?? [])
              .map((t) => ({
                tierId: t.tierId,
                tierName: t.tierName,
                tierColor: t.tierColor,
                // Only versions a tenant can be assigned to (not drafts).
                versions: [...(t.versions ?? [])]
                  .filter((v) => v.status !== "draft")
                  .sort((a, b) => a.version - b.version),
              }))
              .filter((t) => t.versions.length > 0),
          );
        },
      )
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return groups;
}

// Assignment reasons Ogen records for a manual move. Dunning moves are usually
// downgrades, so that is the default.
const REASONS = [
  { value: "downgrade", label: "Downgrade" },
  { value: "upgrade", label: "Upgrade" },
] as const;

// MoveTierDialog moves a workspace to a specific tier version
// (PlanAdminService.SetTenantTierVersion) — the operator's lever when a
// subscription lapses, since Ogen never moves the tier on its own.
export function MoveTierDialog({
  target,
  groups,
  onClose,
  onMoved,
}: {
  target: { tenantId: string; tenantName: string } | null;
  groups: TierVersionGroup[];
  onClose: () => void;
  onMoved: (msg: string) => void;
}) {
  return (
    <Dialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        {target && (
          <MoveTierBody
            target={target}
            groups={groups}
            onClose={onClose}
            onMoved={onMoved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function MoveTierBody({
  target,
  groups,
  onClose,
  onMoved,
}: {
  target: { tenantId: string; tenantName: string };
  groups: TierVersionGroup[];
  onClose: () => void;
  onMoved: (msg: string) => void;
}) {
  const [versionId, setVersionId] = useState("");
  const [reason, setReason] = useState<string>("downgrade");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!versionId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/tier-entitlements/tenants/${encodeURIComponent(target.tenantId)}/version`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tierVersionId: versionId, reason }),
        },
      );
      if (!res.ok && res.status !== 204) throw new Error(await errorText(res));
      const g = groups.find((x) => x.versions.some((v) => v.id === versionId));
      const v = g?.versions.find((x) => x.id === versionId);
      onMoved(
        `${target.tenantName}: moved to ${g?.tierName ?? "tier"} v${v?.version ?? "?"}`,
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to move the tier.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Move {target.tenantName}</DialogTitle>
        <DialogDescription>
          Pins the workspace to a tier version. This does not touch the Lemon
          Squeezy subscription — cancel or refund it there if needed.
        </DialogDescription>
      </DialogHeader>

      {groups.length === 0 ? (
        <p className="text-sm text-tertiary-foreground">
          No tier versions are available. Check the Tier entitlements page.
        </p>
      ) : (
        <div className="grid max-h-72 gap-1 overflow-y-auto" role="radiogroup">
          {groups.map((g) => (
            <div key={g.tierId} className="grid gap-0.5">
              <div className="flex items-center gap-2 px-2 pt-2 text-xs font-medium text-tertiary-foreground">
                <ColorDot color={g.tierColor} />
                {g.tierName}
              </div>
              {g.versions.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  role="radio"
                  aria-checked={versionId === v.id}
                  onClick={() => setVersionId(v.id)}
                  className={cn(
                    "flex items-center justify-between rounded-md px-3 py-1.5 pl-7 text-left text-sm transition-colors",
                    versionId === v.id
                      ? "bg-secondary text-foreground"
                      : "text-secondary-foreground hover:bg-secondary/60",
                  )}
                >
                  <span>
                    v{v.version}
                    {v.status !== "active" && (
                      <span className="text-tertiary-foreground"> · {v.status}</span>
                    )}
                  </span>
                  {versionId === v.id && (
                    <CheckIcon weight="bold" className="size-3.5" />
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-1.5">
        <Label>Reason</Label>
        <div className="flex gap-2" role="radiogroup">
          {REASONS.map((r) => (
            <Button
              key={r.value}
              type="button"
              size="sm"
              variant="outline"
              role="radio"
              aria-checked={reason === r.value}
              data-active={reason === r.value}
              onClick={() => setReason(r.value)}
            >
              {r.label}
            </Button>
          ))}
        </div>
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="defaultInverted"
          disabled={!versionId || busy}
        >
          {busy ? "Moving…" : "Move workspace"}
        </Button>
      </DialogFooter>
    </form>
  );
}
