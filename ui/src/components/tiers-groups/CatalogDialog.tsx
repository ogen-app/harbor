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
import { Input } from "@/components/ui/input";
import { ColorPicker, isValidColor } from "./ColorPicker";
import type { CatalogEntry, KindConfig } from "./types";

type Mode = "create" | "edit";

interface CatalogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: Mode;
  config: KindConfig;
  // The entry being edited (edit mode only).
  entry?: CatalogEntry;
  // Called after a successful write so the parent can refresh the list.
  onSaved: (name: string, created: boolean) => void;
}

// CatalogDialog is the shared add/edit form for a tier or a group, presented as
// a right-side drawer (matching /tier-entitlements). The form body lives in
// CatalogForm, which Radix mounts fresh each time the drawer opens — so its
// state resets from the current entry without an effect (mirrors SecretDialog).
export function CatalogDialog({
  open,
  onOpenChange,
  mode,
  config,
  entry,
  onSaved,
}: CatalogDialogProps) {
  const kindLower = config.singular.toLowerCase();
  const title = mode === "edit" ? `Edit ${kindLower}` : `New ${kindLower}`;
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle className="flex items-center gap-2">
            <HugeiconsIcon
              icon={mode === "edit" ? PencilEdit02Icon : PlusSignSquareIcon}
              className="size-5 text-tertiary-foreground"
            />
            {title}
          </DrawerTitle>
          <DrawerDescription>
            {mode === "edit"
              ? `Update this ${kindLower}’s name, color, or description.`
              : `Add a new ${kindLower} to the catalog.`}
          </DrawerDescription>
        </DrawerHeader>
        <CatalogForm
          mode={mode}
          config={config}
          entry={entry}
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

function CatalogForm({
  mode,
  config,
  entry,
  onCancel,
  onSaved,
}: {
  mode: Mode;
  config: KindConfig;
  entry?: CatalogEntry;
  onCancel: () => void;
  onSaved: (name: string, created: boolean) => void;
}) {
  // Initializers run once per mount; Radix remounts this on each open, so these
  // seed from the current entry with no effect and no stale carryover.
  const [name, setName] = useState(() => entry?.name ?? "");
  const [color, setColor] = useState(() => entry?.color ?? "");
  const [description, setDescription] = useState(() => entry?.description ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kindLower = config.singular.toLowerCase();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Name is required.");
      return;
    }
    if (!isValidColor(color.trim())) {
      setError("Color must be a #RRGGBB hex value, or left empty.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const isCreate = mode === "create";
      const url = isCreate
        ? config.apiBase
        : `${config.apiBase}/${encodeURIComponent(entry!.id)}`;
      const res = await fetch(url, {
        method: isCreate ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmedName,
          color: color.trim(),
          description: description.trim(),
        }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(detail?.error || `Request failed (${res.status})`);
      }
      onSaved(trimmedName, res.status === 201);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : `Failed to save ${kindLower}.`,
      );
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
      <DrawerBody className="space-y-4">
        <div className="grid gap-1.5">
          <Label htmlFor="entry-name">Name</Label>
          <Input
            id="entry-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`e.g. ${config.kind === "tier" ? "Pro" : "Beta testers"}`}
            autoFocus
            autoComplete="off"
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="entry-color">Color</Label>
          <ColorPicker id="entry-color" value={color} onChange={setColor} />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="entry-description">Description</Label>
          <textarea
            id="entry-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            autoComplete="off"
            placeholder="Optional — what this is for"
            className="w-full resize-y rounded-none border-b border-quaternary bg-input px-4 py-2 text-sm text-foreground outline-none focus:border-foreground"
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
          disabled={submitting}
        >
          {submitting
            ? "Saving…"
            : mode === "edit"
              ? "Save changes"
              : `Add ${kindLower}`}
        </Button>
      </DrawerFooter>
    </form>
  );
}
