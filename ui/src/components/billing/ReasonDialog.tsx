"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface ReasonRequest {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  placeholder?: string;
  destructive?: boolean;
  // run performs the action; a thrown Error's message is shown inline and the
  // dialog stays open so the operator can retry or cancel.
  run: (reason: string) => Promise<void>;
}

// ReasonDialog confirms a billing action that Ogen records with a mandatory
// reason (comp/exempt, free-month tier, suspend, tier move). It renders nothing
// until a request is set; the body mounts fresh each open, so the field seeds
// empty without an effect.
export function ReasonDialog({
  request,
  onClose,
}: {
  request: ReasonRequest | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={!!request}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        {request && <ReasonDialogBody request={request} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function ReasonDialogBody({
  request,
  onClose,
}: {
  request: ReasonRequest;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canConfirm = reason.trim().length > 0 && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canConfirm) return;
    setBusy(true);
    setError(null);
    try {
      await request.run(reason.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The action failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{request.title}</DialogTitle>
        <DialogDescription asChild>
          <div>{request.description}</div>
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-1.5">
        <Label htmlFor="billing-reason">Reason</Label>
        <Input
          id="billing-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={request.placeholder ?? "Recorded in the tenant's activity"}
          autoFocus
          autoComplete="off"
        />
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
          variant={request.destructive ? "destructiveInverted" : "defaultInverted"}
          disabled={!canConfirm}
        >
          {busy ? "Working…" : request.confirmLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
