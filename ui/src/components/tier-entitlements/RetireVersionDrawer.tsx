"use client";

import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Archive02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Loader } from "@/components/ui/loader";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import type {
  AssignmentsResponse,
  TierVersion,
  VersionAssignment,
} from "./types";

const selectClass =
  "h-8 rounded-none border-b border-quaternary bg-input px-2 text-[14px] font-medium outline-none focus-visible:border-foreground";

// errorText pulls the server's { error } message from a failed response.
async function errorText(res: Response): Promise<string> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  return j?.error || `Request failed (${res.status})`;
}

interface RetireVersionDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // The active version being retired.
  version: TierVersion | null;
  // All versions of this tier — the reassignment targets are the OTHER active ones.
  siblingVersions: TierVersion[];
  tierName: string;
  onDone: () => void;
}

// RetireVersionDrawer runs CON-297's guarded retire. A version with no live
// assignments retires directly. When tenants are still on it, Ogen refuses and
// names them; the operator then either migrates them onto another active version
// (reassign, atomic with the retire) or force-retires to grandfather them onto
// the now-retired version. The two paths are mutually exclusive.
export function RetireVersionDrawer({
  open,
  onOpenChange,
  version,
  siblingVersions,
  tierName,
  onDone,
}: RetireVersionDrawerProps) {
  const [assignments, setAssignments] = useState<VersionAssignment[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingAssignments, setLoadingAssignments] = useState(false);
  const [reassignTo, setReassignTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const activeTargets = (siblingVersions ?? [])
    .filter((v) => v.status === "active" && v.id !== version?.id)
    .sort((a, b) => a.version - b.version);
  const hasAssignments = (version?.liveAssignmentCount ?? 0) > 0;

  // (Re)seed on open; fetch the blocking tenants when any remain. Radix mounts
  // the content fresh each open, but state is component-scoped so reset here.
  useEffect(() => {
    if (!open || !version) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setErr(null);
    setBusy(false);
    setAssignments([]);
    setTotal(version.liveAssignmentCount);
    setReassignTo(activeTargets[0]?.id ?? "");
    /* eslint-enable react-hooks/set-state-in-effect */
    if (version.liveAssignmentCount <= 0) return;
    const controller = new AbortController();
    setLoadingAssignments(true);
    fetch(
      `/api/tier-entitlements/versions/${encodeURIComponent(version.id)}/assignments?limit=100`,
      { signal: controller.signal },
    )
      .then((r) =>
        r.ok
          ? (r.json() as Promise<AssignmentsResponse>)
          : Promise.reject(new Error(String(r.status))),
      )
      .then((j) => {
        // On a soft-fail (upstream down) keep the count from the version prop.
        if (j.available === false) return;
        setAssignments(j.assignments ?? []);
        setTotal(j.total);
      })
      .catch(() => {
        /* best-effort: the count still drives the flow */
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingAssignments(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, version?.id]);

  async function retire(body: { force?: boolean; reassignToVersionId?: string }) {
    if (!version) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(
        `/api/tier-entitlements/versions/${encodeURIComponent(version.id)}/retire`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!r.ok) throw new Error(await errorText(r));
      onOpenChange(false);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Retire failed.");
    } finally {
      setBusy(false);
    }
  }

  // Block user-initiated closes (Esc / overlay / ✕) while the retire is in
  // flight; the success path calls onOpenChange(false) directly and bypasses this.
  const handleOpenChange = (next: boolean) => {
    if (!next && busy) return;
    onOpenChange(next);
  };

  return (
    <Drawer open={open} onOpenChange={handleOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle className="flex items-center gap-2">
            <HugeiconsIcon
              icon={Archive02Icon}
              className="size-5 text-tertiary-foreground"
            />
            Retire {tierName} v{version?.version ?? ""}
          </DrawerTitle>
          <DrawerDescription>
            Retiring stops new assignments to this version. Published versions
            remain as immutable audit history.
          </DrawerDescription>
        </DrawerHeader>

        <DrawerBody className="space-y-5">
          {!hasAssignments ? (
            <p className="text-sm text-secondary-foreground">
              No tenants are currently on this version — it can be retired
              directly.
            </p>
          ) : (
            <>
              <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-400/10 p-4">
                <p className="text-sm font-medium text-foreground">
                  {total} {total === 1 ? "tenant is" : "tenants are"} still on
                  this version
                </p>
                <p className="text-xs text-tertiary-foreground">
                  Retiring is blocked until they’re handled — either migrate them
                  onto another active version, or force-retire to grandfather
                  them onto the retired version.
                </p>
                {loadingAssignments ? (
                  <div className="flex items-center gap-2 text-xs text-tertiary-foreground">
                    <Loader className="size-3.5 border-[1.5px]" />
                    Loading tenants…
                  </div>
                ) : assignments.length > 0 ? (
                  <ul className="max-h-40 space-y-1 overflow-y-auto text-xs text-secondary-foreground">
                    {assignments.map((a) => (
                      <li key={a.tenantId} className="truncate">
                        {a.tenantName || a.tenantId}
                      </li>
                    ))}
                    {total > assignments.length && (
                      <li className="text-tertiary-foreground">
                        +{total - assignments.length} more…
                      </li>
                    )}
                  </ul>
                ) : null}
              </div>

              {/* Reassign path — migrate the blocking tenants onto another
                  active version, then retire (atomic in Ogen). */}
              <div className="space-y-2">
                <Label className="text-xs text-tertiary-foreground">
                  Reassign tenants to another active version
                </Label>
                {activeTargets.length > 0 ? (
                  <div className="flex items-center gap-2">
                    <select
                      className={selectClass}
                      value={reassignTo}
                      onChange={(e) => setReassignTo(e.target.value)}
                      aria-label="Reassign target version"
                      disabled={busy}
                    >
                      {activeTargets.map((v) => (
                        <option key={v.id} value={v.id}>
                          v{v.version}
                        </option>
                      ))}
                    </select>
                    <Button
                      type="button"
                      variant="defaultInverted"
                      size="sm"
                      className="font-semibold"
                      disabled={busy || !reassignTo}
                      onClick={() =>
                        retire({ reassignToVersionId: reassignTo })
                      }
                    >
                      {busy && <Loader className="size-3.5 border-[1.5px]" />}
                      Reassign &amp; retire
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-tertiary-foreground">
                    No other active version to reassign to — publish one first,
                    or force-retire.
                  </p>
                )}
              </div>
            </>
          )}

          {err && (
            <p className="text-sm text-destructive" role="alert">
              {err}
            </p>
          )}
        </DrawerBody>

        <DrawerFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => handleOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructiveInverted"
            size="sm"
            className="font-semibold"
            disabled={busy}
            onClick={() => retire(hasAssignments ? { force: true } : {})}
          >
            {busy && <Loader className="size-3.5 border-[1.5px]" />}
            {hasAssignments ? "Force retire" : "Retire version"}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
