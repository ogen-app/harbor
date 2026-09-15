"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  PencilEdit02Icon,
  PlusSignSquareIcon,
} from "@hugeicons/core-free-icons";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

type Mode = "create" | "update";

interface SecretDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: Mode;
  // In update mode: the secret being rotated. In create mode: a preselected
  // name (from a row's "Set" action), or undefined to show the name dropdown.
  name?: string;
  // Allowlisted names not yet stored — the dropdown options in create mode.
  unsetNames?: string[];
  // Called after a successful write so the parent can refresh the list.
  onSaved: (name: string, created: boolean) => void;
}

// SecretDialog is the add/rotate form, modeled on GitHub's "New / Update
// secret" screen, presented as a right-side drawer (matching /tier-entitlements):
// the value is a textarea and is never pre-filled (GET never returns plaintext).
// The form body lives in SecretForm, which Radix mounts fresh each time the
// drawer opens — so its state resets without an effect.
export function SecretDialog({
  open,
  onOpenChange,
  mode,
  name,
  unsetNames = [],
  onSaved,
}: SecretDialogProps) {
  const title = mode === "update" ? "Update secret" : "New secret";
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle className="flex items-center gap-2">
            <HugeiconsIcon
              icon={mode === "update" ? PencilEdit02Icon : PlusSignSquareIcon}
              className="size-5 text-tertiary-foreground"
            />
            {title}
          </DrawerTitle>
          <DrawerDescription>
            The value is encrypted by Ogen and never shown again. Rotating takes
            effect immediately — no restart.
          </DrawerDescription>
        </DrawerHeader>
        <SecretForm
          mode={mode}
          name={name}
          unsetNames={unsetNames}
          onCancel={() => onOpenChange(false)}
          onSaved={(n, created) => {
            onSaved(n, created);
            onOpenChange(false);
          }}
        />
      </DrawerContent>
    </Drawer>
  );
}

function SecretForm({
  mode,
  name,
  unsetNames,
  onCancel,
  onSaved,
}: {
  mode: Mode;
  name?: string;
  unsetNames: string[];
  onCancel: () => void;
  onSaved: (name: string, created: boolean) => void;
}) {
  // useState initializers run once on mount; since Radix remounts this on each
  // open, that's the reset — no effect, no stale value carried between opens.
  const [selectedName, setSelectedName] = useState(
    () => name ?? unsetNames[0] ?? "",
  );
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveName = mode === "update" ? name : (name ?? selectedName);
  const nameFixed = mode === "update" || !!name;
  // The name is an editable <select> (labelable) only in create mode with
  // unset names; otherwise it's static text, which a <label for> can't target.
  const showSelect = !nameFixed && unsetNames.length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!effectiveName) {
      setError("Choose a secret to set.");
      return;
    }
    if (!value.trim()) {
      setError("Value cannot be empty.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/secrets/${encodeURIComponent(effectiveName)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value }),
        },
      );
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(detail?.error || `Request failed (${res.status})`);
      }
      onSaved(effectiveName, res.status === 201);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save secret.");
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
      <DrawerBody className="space-y-4">
        <div className="grid gap-1.5">
          <Label
            id="secret-name-label"
            htmlFor={showSelect ? "secret-name" : undefined}
          >
            Name
          </Label>
          {nameFixed ? (
            <div
              aria-labelledby="secret-name-label"
              className="font-mono text-sm text-foreground"
            >
              {effectiveName}
            </div>
          ) : showSelect ? (
            <select
              id="secret-name"
              value={selectedName}
              onChange={(e) => setSelectedName(e.target.value)}
              className="w-full rounded-none border-b border-quaternary bg-input px-4 py-2 font-mono text-sm text-foreground outline-none focus:border-foreground"
            >
              {unsetNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-sm text-tertiary-foreground">
              Every secret is already set — edit one from the list instead.
            </p>
          )}
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="secret-value">Value</Label>
          <textarea
            id="secret-value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={5}
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste the secret value"
            className="w-full resize-y rounded-none border-b border-quaternary bg-input px-4 py-2 font-mono text-sm text-foreground outline-none focus:border-foreground"
          />
        </div>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </DrawerBody>

      <DrawerFooter>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="defaultInverted"
          size="sm"
          className="font-semibold"
          disabled={submitting || (!nameFixed && unsetNames.length === 0)}
        >
          {submitting
            ? "Saving…"
            : mode === "update"
              ? "Update secret"
              : "Add secret"}
        </Button>
      </DrawerFooter>
    </form>
  );
}
