"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  PencilEdit02Icon,
  PlusSignSquareIcon,
} from "@hugeicons/core-free-icons";
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FIELD_GRID } from "@/components/platforms/fields";
import { cn } from "@/lib/utils";
import { AudiencePicker } from "./AudiencePicker";
import type { Announcement, AnnouncementInput } from "./types";

type Mode = "create" | "edit";

const FORM_TABS = ["Content", "Audience & schedule"] as const;
type FormTab = (typeof FORM_TABS)[number];

// datetime-local <input> speaks "YYYY-MM-DDThh:mm" in the operator's local zone;
// the API speaks RFC3339 (UTC). These convert both ways so the stored instant
// round-trips through an edit without drifting.
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

interface AnnouncementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: Mode;
  // The announcement being edited (edit mode only).
  announcement?: Announcement;
  onSaved: (title: string, created: boolean) => void;
}

// AnnouncementDialog is the whole-resource create/edit form, presented as a
// right-side drawer (matching PlatformDialog / tier-entitlements). The body lives
// in AnnouncementForm, which Radix mounts fresh each open — so it seeds from the
// current announcement without an effect and resets between opens.
export function AnnouncementDialog({
  open,
  onOpenChange,
  mode,
  announcement,
  onSaved,
}: AnnouncementDialogProps) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-w-[min(46rem,calc(100vw-2.5rem))] gap-0 p-0">
        <AnnouncementForm
          mode={mode}
          announcement={announcement}
          onCancel={() => onOpenChange(false)}
          onSaved={(t, created) => {
            onSaved(t, created);
            onOpenChange(false);
          }}
        />
      </DrawerContent>
    </Drawer>
  );
}

function AnnouncementForm({
  mode,
  announcement,
  onCancel,
  onSaved,
}: {
  mode: Mode;
  announcement?: Announcement;
  onCancel: () => void;
  onSaved: (title: string, created: boolean) => void;
}) {
  const [title, setTitle] = useState(() => announcement?.title ?? "");
  const [body, setBody] = useState(() => announcement?.body ?? "");
  const [imageUrl, setImageUrl] = useState(() => announcement?.imageUrl ?? "");
  const [imageAlt, setImageAlt] = useState(() => announcement?.imageAlt ?? "");
  const [ctaLabel, setCtaLabel] = useState(() => announcement?.ctaLabel ?? "");
  const [ctaUrl, setCtaUrl] = useState(() => announcement?.ctaUrl ?? "");

  const [targetAll, setTargetAll] = useState(
    () => announcement?.targetAll ?? false,
  );
  const [tierIds, setTierIds] = useState<string[]>(
    () => announcement?.targetTierIds ?? [],
  );
  const [groupIds, setGroupIds] = useState<string[]>(
    () => announcement?.targetGroupIds ?? [],
  );

  const [starts, setStarts] = useState(() =>
    toLocalInput(announcement?.startsAt ?? null),
  );
  const [ends, setEnds] = useState(() =>
    toLocalInput(announcement?.endsAt ?? null),
  );

  const [formTab, setFormTab] = useState<FormTab>("Content");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Title is required.");
      setFormTab("Content");
      return;
    }
    if (!body.trim()) {
      setError("Body is required.");
      setFormTab("Content");
      return;
    }
    // CTA is both-or-neither: a label needs a url and vice versa.
    const hasLabel = ctaLabel.trim() !== "";
    const hasUrl = ctaUrl.trim() !== "";
    if (hasLabel !== hasUrl) {
      setError("A call-to-action needs both a label and a URL, or neither.");
      setFormTab("Content");
      return;
    }
    if (!targetAll && tierIds.length === 0 && groupIds.length === 0) {
      setError(
        "Pick at least one group or tier, or target “All tenants” — this reaches nobody.",
      );
      setFormTab("Audience & schedule");
      return;
    }
    const startsAt = fromLocalInput(starts);
    const endsAt = fromLocalInput(ends);
    if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
      setError("The end of the showing window must be after its start.");
      setFormTab("Audience & schedule");
      return;
    }

    const input: AnnouncementInput = {
      title: trimmedTitle,
      body: body.trim(),
      imageUrl: imageUrl.trim(),
      imageAlt: imageAlt.trim(),
      ctaLabel: ctaLabel.trim(),
      ctaUrl: ctaUrl.trim(),
      targetAll,
      targetGroupIds: targetAll ? [] : groupIds,
      targetTierIds: targetAll ? [] : tierIds,
      startsAt,
      endsAt,
    };

    setSubmitting(true);
    setError(null);
    try {
      const isCreate = mode === "create";
      const url = isCreate
        ? "/api/announcements"
        : `/api/announcements/${encodeURIComponent(announcement!.id)}`;
      const res = await fetch(url, {
        method: isCreate ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(detail?.error || `Request failed (${res.status})`);
      }
      onSaved(trimmedTitle, res.status === 201);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save announcement.",
      );
      setSubmitting(false);
    }
  };

  const title_ =
    mode === "edit"
      ? `Edit ${announcement?.title?.trim() || "announcement"}`
      : "New announcement";

  return (
    <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
      {/* Header (fixed) — pr-12 clears the drawer's close button. */}
      <div className="shrink-0 px-6 pt-6 pr-12">
        <DrawerTitle className="flex items-center gap-2">
          <HugeiconsIcon
            icon={mode === "edit" ? PencilEdit02Icon : PlusSignSquareIcon}
            className="size-5 text-tertiary-foreground"
          />
          {title_}
        </DrawerTitle>
        <DrawerDescription className="mt-1">
          {mode === "edit"
            ? "Update this announcement’s content, audience and showing window. Publishing is a separate action from the list."
            : "Compose an announcement. It’s saved as a draft — target and schedule it here, then publish it from the list."}
        </DrawerDescription>
      </div>

      <div className="mt-4 shrink-0 border-b border-border" />

      {/* Tabs (fixed) */}
      <div className="shrink-0 px-6 pt-4">
        <div role="tablist" className="flex gap-6 border-b border-border">
          {FORM_TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={t === formTab}
              onClick={() => setFormTab(t)}
              className={cn(
                "relative -mb-px border-b-2 py-2.5 text-sm whitespace-nowrap transition-colors outline-none",
                t === formTab
                  ? "border-foreground font-semibold text-foreground"
                  : "border-transparent font-medium text-tertiary-foreground hover:text-secondary-foreground",
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Scrollable body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {formTab === "Content" && (
          <div className="grid gap-5">
            <Field label="Title" htmlFor="an-title">
              <Input
                id="an-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Scheduled maintenance this Sunday"
                autoComplete="off"
              />
            </Field>

            <Field label="Body" htmlFor="an-body">
              <textarea
                id="an-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={5}
                placeholder="What you want every targeted tenant to see."
                className="w-full resize-y rounded-none border-b border-quaternary bg-input px-4 py-2 text-sm text-foreground outline-none focus:border-foreground"
              />
            </Field>

            <Section
              title="Image"
              subtitle="Optional. Supply a hosted https image URL and its alt text."
            >
              <div className={FIELD_GRID}>
                <Field
                  label="Image URL"
                  htmlFor="an-img-url"
                  hint="Absolute https URL. Leave blank for a text-only announcement."
                >
                  <Input
                    id="an-img-url"
                    value={imageUrl}
                    onChange={(e) => setImageUrl(e.target.value)}
                    placeholder="https://cdn.example.com/banner.png"
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                </Field>
                <Field
                  label="Alt text"
                  htmlFor="an-img-alt"
                  hint="Describes the image for screen readers."
                >
                  <Input
                    id="an-img-alt"
                    value={imageAlt}
                    onChange={(e) => setImageAlt(e.target.value)}
                    placeholder="e.g. Maintenance window banner"
                    autoComplete="off"
                  />
                </Field>
              </div>
            </Section>

            <Section
              title="Call to action"
              subtitle="Optional. A label + URL, or neither — an announcement with no CTA is info/dismiss only."
            >
              <div className={FIELD_GRID}>
                <Field label="CTA label" htmlFor="an-cta-label">
                  <Input
                    id="an-cta-label"
                    value={ctaLabel}
                    onChange={(e) => setCtaLabel(e.target.value)}
                    placeholder="e.g. Learn more"
                    autoComplete="off"
                  />
                </Field>
                <Field label="CTA URL" htmlFor="an-cta-url">
                  <Input
                    id="an-cta-url"
                    value={ctaUrl}
                    onChange={(e) => setCtaUrl(e.target.value)}
                    placeholder="https://example.com/status"
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                </Field>
              </div>
            </Section>
          </div>
        )}

        {formTab === "Audience & schedule" && (
          <div className="grid gap-6">
            <Section
              title="Audience"
              subtitle="Who sees this. A tenant matches when its tier OR any of its groups is selected."
            >
              <AudiencePicker
                targetAll={targetAll}
                groupIds={groupIds}
                tierIds={tierIds}
                onTargetAllChange={setTargetAll}
                onGroupIdsChange={setGroupIds}
                onTierIdsChange={setTierIds}
              />
            </Section>

            <Section
              title="Showing window"
              subtitle="Optional. When published, it shows from the start (or immediately) until the end (or indefinitely)."
            >
              <div className={FIELD_GRID}>
                <Field
                  label="Starts at"
                  htmlFor="an-starts"
                  hint="Leave blank to go live as soon as it’s published."
                >
                  <Input
                    id="an-starts"
                    type="datetime-local"
                    value={starts}
                    onChange={(e) => setStarts(e.target.value)}
                  />
                </Field>
                <Field
                  label="Ends at"
                  htmlFor="an-ends"
                  hint="Leave blank for no expiry."
                >
                  <Input
                    id="an-ends"
                    type="datetime-local"
                    value={ends}
                    onChange={(e) => setEnds(e.target.value)}
                  />
                </Field>
              </div>
            </Section>
          </div>
        )}
      </div>

      {/* Error (fixed, above footer) */}
      {error && (
        <div className="shrink-0 px-6 pt-3">
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        </div>
      )}

      {/* Footer (fixed) */}
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-6 py-4">
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
              : "Create draft"}
        </Button>
      </div>
    </form>
  );
}

// Section is a titled group within a tab, with a small heading.
function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-3">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
          {title}
        </h3>
        {subtitle && (
          <p className="mt-0.5 text-xs text-tertiary-foreground">{subtitle}</p>
        )}
      </div>
      {children}
    </section>
  );
}
