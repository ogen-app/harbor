"use client";

import { useCallback, useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { SlidersHorizontalIcon } from "@hugeicons/core-free-icons";
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
import { Loader } from "@/components/ui/loader";
import { ByteField, NumberField, FIELD_GRID } from "./fields";
import type { GlobalLimits, GlobalLimitsResponse } from "./types";

interface GlobalLimitsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

// GlobalLimitsDialog reads and writes the five cross-platform ceilings in a
// right-side drawer (matching /tier-entitlements). Radix only mounts the content
// while open, so LimitsBody fetches on open; the form remounts (keyed on the
// loaded values) so its fields seed without an effect.
export function GlobalLimitsDialog({
  open,
  onOpenChange,
  onSaved,
}: GlobalLimitsDialogProps) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle className="flex items-center gap-2">
            <HugeiconsIcon
              icon={SlidersHorizontalIcon}
              className="size-5 text-tertiary-foreground"
            />
            Global limits
          </DrawerTitle>
          <DrawerDescription>
            Cross-platform ceilings. A per-platform file-size limit can’t exceed
            the matching ceiling here.
          </DrawerDescription>
        </DrawerHeader>

        {open && (
          <LimitsBody
            onCancel={() => onOpenChange(false)}
            onSaved={() => {
              onSaved();
              onOpenChange(false);
            }}
          />
        )}
      </DrawerContent>
    </Drawer>
  );
}

function LimitsBody({
  onCancel,
  onSaved,
}: {
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [limits, setLimits] = useState<GlobalLimits | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    return fetch("/api/platforms/global-limits", { signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        return r.json() as Promise<GlobalLimitsResponse>;
      })
      .then((json) => {
        if (!json.available) {
          setError("The platform-admin service is unavailable.");
          return;
        }
        setLimits(json.limits);
        setError(null);
      })
      .catch((e: unknown) => {
        if (signal?.aborted) return;
        setError(e instanceof Error ? e.message : "Failed to load limits.");
      })
      .finally(() => {
        if (!signal?.aborted) setLoading(false);
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (loading) {
    return (
      <DrawerBody>
        <div className="flex items-center gap-2 py-8 text-sm text-tertiary-foreground">
          <Loader className="size-4 border-[1.5px]" />
          Loading limits…
        </div>
      </DrawerBody>
    );
  }
  if (error || !limits) {
    return (
      <>
        <DrawerBody>
          <p className="py-6 text-sm text-destructive" role="alert">
            {error ?? "Limits unavailable."}
          </p>
        </DrawerBody>
        <DrawerFooter>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Close
          </Button>
        </DrawerFooter>
      </>
    );
  }

  return <LimitsForm initial={limits} onCancel={onCancel} onSaved={onSaved} />;
}

function LimitsForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial: GlobalLimits;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [maxImageUploadBytes, setImage] = useState(initial.maxImageUploadBytes);
  const [maxPdfUploadBytes, setPdf] = useState(initial.maxPdfUploadBytes);
  const [maxVideoUploadBytes, setVideo] = useState(initial.maxVideoUploadBytes);
  const [maxAltTextChars, setAlt] = useState(initial.maxAltTextChars);
  const [maxThreadSegments, setThread] = useState(initial.maxThreadSegments);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const body: GlobalLimits = {
        maxImageUploadBytes,
        maxPdfUploadBytes,
        maxVideoUploadBytes,
        maxAltTextChars,
        maxThreadSegments,
      };
      const res = await fetch("/api/platforms/global-limits", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(detail?.error || `Request failed (${res.status})`);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save limits.");
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
      <DrawerBody>
        <div className={FIELD_GRID}>
          <ByteField
            label="Max image upload"
            bytes={maxImageUploadBytes}
            onChange={setImage}
          />
          <ByteField
            label="Max PDF upload"
            bytes={maxPdfUploadBytes}
            onChange={setPdf}
          />
          <ByteField
            label="Max video upload"
            bytes={maxVideoUploadBytes}
            onChange={setVideo}
          />
          <NumberField
            label="Max alt-text characters"
            value={maxAltTextChars}
            onChange={setAlt}
          />
          <NumberField
            label="Max thread segments"
            value={maxThreadSegments}
            onChange={setThread}
          />
        </div>

        {error && (
          <p className="mt-4 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </DrawerBody>

      {/* Same button treatment as the platform Add/Edit form (ghost Cancel +
          inverted, semibold save). */}
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
          {submitting ? "Saving…" : "Save limits"}
        </Button>
      </DrawerFooter>
    </form>
  );
}
