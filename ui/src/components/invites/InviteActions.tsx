"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { EXPIRY_PRESETS, inviteError } from "./format";
import type { Invite, InviteResponse } from "./types";

// The row/drawer write actions on one invite, each behind its own confirmation:
// Resend (pending or expired; rotates the link, optional new expiry) and Revoke
// (pending only). Both hand the updated invite back so the caller can refresh
// the row in place.

export type InviteAction = { kind: "resend" | "revoke"; invite: Invite };

export function InviteActionDialog({
  action,
  onClose,
  onDone,
}: {
  action: InviteAction | null;
  onClose: () => void;
  onDone: (updated: Invite, msg: string) => void;
}) {
  return (
    <Dialog
      open={!!action}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        {action?.kind === "resend" && (
          <ResendBody invite={action.invite} onClose={onClose} onDone={onDone} />
        )}
        {action?.kind === "revoke" && (
          <RevokeBody invite={action.invite} onClose={onClose} onDone={onDone} />
        )}
      </DialogContent>
    </Dialog>
  );
}

async function post(path: string, body?: unknown): Promise<Invite> {
  const res = await fetch(path, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await inviteError(res)).message);
  return ((await res.json()) as InviteResponse).invite;
}

function ResendBody({
  invite,
  onClose,
  onDone,
}: {
  invite: Invite;
  onClose: () => void;
  onDone: (updated: Invite, msg: string) => void;
}) {
  // 0 = keep the invite's original lifetime.
  const [days, setDays] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const updated = await post(
        `/api/invites/${encodeURIComponent(invite.id)}/resend`,
        days ? { expiresInHours: days * 24 } : undefined,
      );
      onDone(updated, `New invite link sent to ${invite.email}.`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t resend the invite.");
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Resend the invite to {invite.email}?</DialogTitle>
        <DialogDescription>
          Sends a new link; the previous link stops working.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
          Expires in
        </span>
        <div className="flex flex-wrap gap-2">
          <PresetChip on={days === 0} onClick={() => setDays(0)}>
            Original
          </PresetChip>
          {EXPIRY_PRESETS.map((d) => (
            <PresetChip key={d} on={days === d} onClick={() => setDays(d)}>
              {d} days
            </PresetChip>
          ))}
        </div>
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="defaultInverted" onClick={confirm} disabled={busy}>
          {busy ? "Sending…" : "Resend"}
        </Button>
      </DialogFooter>
    </>
  );
}

function RevokeBody({
  invite,
  onClose,
  onDone,
}: {
  invite: Invite;
  onClose: () => void;
  onDone: (updated: Invite, msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const updated = await post(
        `/api/invites/${encodeURIComponent(invite.id)}/revoke`,
      );
      onDone(updated, `Invite for ${invite.email} revoked.`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t revoke the invite.");
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Revoke the invite for {invite.email}?</DialogTitle>
        <DialogDescription>
          The link stops working right away. You can invite this address again
          later.
        </DialogDescription>
      </DialogHeader>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="destructiveInverted" onClick={confirm} disabled={busy}>
          {busy ? "Revoking…" : "Revoke"}
        </Button>
      </DialogFooter>
    </>
  );
}

// PresetChip is the house toggle chip (black when chosen), as in the
// announcements AudiencePicker.
export function PresetChip({
  on,
  onClick,
  disabled,
  title,
  children,
}: {
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        on
          ? "border-foreground bg-foreground text-primary"
          : "border-border text-secondary-foreground hover:border-quaternary hover:bg-secondary/50",
      )}
    >
      {children}
    </button>
  );
}
