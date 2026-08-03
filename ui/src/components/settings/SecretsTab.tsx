"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { SecretDialog } from "./SecretDialog";
import type { SecretMeta, SecretsListResponse } from "./types";

// A small padlock, matching GitHub's secrets list. The shared Icon set has no
// lock glyph, so it's inlined here rather than expanding the global icon map.
function LockIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className={className}
      stroke="currentColor"
      strokeWidth={1.4}
    >
      <rect x="3" y="7" width="10" height="6.5" rx="1.2" />
      <path d="M5 7V5a3 3 0 0 1 6 0v2" />
    </svg>
  );
}

function relativeTime(iso: string): string {
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return "just now";
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  const y = Math.floor(mo / 12);
  return `${y} year${y === 1 ? "" : "s"} ago`;
}

// SecretsTab is the GitHub-style secrets manager: a table of the allowlisted
// slots (each set or not), with add / rotate / clear actions. All state is
// Ogen's — this only calls Harbor's /api/secrets, which proxies to Ogen's
// gRPC secrets surface. Values are write-only and never displayed.
export function SecretsTab() {
  const [data, setData] = useState<SecretsListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<"create" | "update">("create");
  const [dialogName, setDialogName] = useState<string | undefined>(undefined);

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [toast, setToast] = useState<string | null>(null);

  // reload re-fetches the list. setState lives in .then/.catch callbacks (async),
  // matching the codebase's fetch-in-effect pattern that satisfies the
  // set-state-in-effect lint. Safe to call from handlers and the mount effect.
  const reload = useCallback((signal?: AbortSignal) => {
    return fetch("/api/secrets", { signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        return r.json() as Promise<SecretsListResponse>;
      })
      .then((json) => {
        setData(json);
        setLoadError(null);
      })
      .catch((e: unknown) => {
        if (signal?.aborted) return;
        setLoadError(
          e instanceof Error ? e.message : "Failed to load secrets.",
        );
      })
      .finally(() => {
        if (!signal?.aborted) setLoading(false);
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 3000);
  }, []);

  const secrets = data?.secrets ?? [];
  const unsetNames = secrets.filter((s) => !s.set).map((s) => s.name);
  const allSet = secrets.length > 0 && unsetNames.length === 0;

  const openCreate = (name?: string) => {
    setDialogMode("create");
    setDialogName(name);
    setDialogOpen(true);
  };
  const openUpdate = (name: string) => {
    setDialogMode("update");
    setDialogName(name);
    setDialogOpen(true);
  };

  const handleSaved = (name: string, created: boolean) => {
    flash(`Secret “${name}” ${created ? "added" : "updated"}.`);
    reload();
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(
        `/api/secrets/${encodeURIComponent(deleteTarget)}`,
        { method: "DELETE" },
      );
      if (!res.ok && res.status !== 204) {
        const detail = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(detail?.error || `Request failed (${res.status})`);
      }
      flash(`Secret “${deleteTarget}” removed.`);
      setDeleteTarget(null);
      reload();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Failed to delete.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-display font-medium">Secrets</h2>
          <p className="text-sm text-tertiary-foreground">
            Encrypted credentials Ogen uses for third-party integrations.
            Values are write-only — they can be set or rotated, never read back.
          </p>
        </div>
        <Button
          onClick={() => openCreate()}
          disabled={allSet || !data?.available}
          className="shrink-0"
          title={allSet ? "Every secret is already set" : undefined}
        >
          <Icon name="plus" className="size-3.5" />
          New secret
        </Button>
      </div>

      {/* States */}
      {loading ? (
        <p className="text-sm text-tertiary-foreground">Loading secrets…</p>
      ) : loadError ? (
        <p className="text-sm text-destructive">{loadError}</p>
      ) : !data?.available ? (
        <div className="rounded-lg border border-border p-6 text-sm text-tertiary-foreground">
          The secrets service is unavailable. Check that Ogen is running and
          that Harbor’s <code className="font-mono">OGEN_GRPC_ADDR</code> /{" "}
          <code className="font-mono">OGEN_GRPC_TOKEN</code> are configured.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/40 text-left text-xs text-tertiary-foreground">
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Last updated</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {secrets.map((s) => (
                <SecretRow
                  key={s.name}
                  secret={s}
                  onSet={() => openCreate(s.name)}
                  onEdit={() => openUpdate(s.name)}
                  onDelete={() => {
                    setDeleteError(null);
                    setDeleteTarget(s.name);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Transient success toast */}
      {toast && (
        <div
          role="status"
          className="fixed bottom-6 right-6 z-50 rounded-md border border-border bg-primary px-4 py-2 text-sm text-foreground shadow-xl"
        >
          {toast}
        </div>
      )}

      {/* Add / update */}
      <SecretDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        mode={dialogMode}
        name={dialogName}
        unsetNames={unsetNames}
        onSaved={handleSaved}
      />

      {/* Delete confirmation */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete secret</DialogTitle>
            <DialogDescription>
              Remove{" "}
              <span className="font-mono text-foreground">{deleteTarget}</span>?
              Features that depend on it degrade until it’s set again.
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p className="text-sm text-destructive" role="alert">
              {deleteError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructiveInverted"
              onClick={confirmDelete}
              disabled={deleting}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SecretRow({
  secret,
  onSet,
  onEdit,
  onDelete,
}: {
  secret: SecretMeta;
  onSet: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <tr className="border-b border-border last:border-b-0 hover:bg-secondary/30">
      <td className="px-4 py-3">
        <span className="flex items-center gap-2">
          <LockIcon
            className={
              secret.set
                ? "size-4 text-tertiary-foreground"
                : "size-4 text-quaternary"
            }
          />
          <span
            className={
              secret.set
                ? "font-mono text-foreground"
                : "font-mono text-tertiary-foreground"
            }
          >
            {secret.name}
          </span>
          {secret.set && !secret.decryptable && (
            <span
              className="rounded-sm bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
              title="The current key can’t decrypt this value (KEK mismatch)."
            >
              KEK mismatch
            </span>
          )}
        </span>
      </td>
      <td className="px-4 py-3 text-tertiary-foreground">
        {secret.set ? relativeTime(secret.updatedAt) : "Not set"}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1">
          {secret.set ? (
            <>
              <Button
                variant="ghost"
                size="smIcon"
                aria-label={`Update ${secret.name}`}
                onClick={onEdit}
              >
                <Icon name="edit" className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="smIcon"
                aria-label={`Delete ${secret.name}`}
                onClick={onDelete}
                className="text-tertiary-foreground hover:text-destructive"
              >
                <Icon name="trash_bin" className="size-4" />
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={onSet}>
              Set
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}
