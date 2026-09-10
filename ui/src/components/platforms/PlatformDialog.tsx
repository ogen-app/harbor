"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Field, Toggle, NumberField, ByteField, TagsField } from "./fields";
import type {
  Platform,
  ImageConstraints,
  VideoConstraints,
  PdfConstraints,
  TextConstraints,
} from "./types";

type Mode = "create" | "edit";

// A post type as edited in the form: slug + display label + whether it's a
// Zernio-publishable type. On submit these fan out into the Platform's
// post_types map and its supported_post_types subset.
interface PostTypeRow {
  slug: string;
  label: string;
  publishable: boolean;
}

// Top-level tabs — one per former column.
const FORM_TABS = ["Identity", "Post types", "Media & text limits"] as const;
type FormTab = (typeof FORM_TABS)[number];

const MEDIA_TABS = ["Image", "Video", "PDF", "Text"] as const;
type MediaTab = (typeof MEDIA_TABS)[number];

const emptyImage = (): ImageConstraints => ({
  maxFileSizeBytes: 0,
  allowedFormats: [],
  animatedGifSupported: false,
  maxAttachmentsPerPost: 0,
});
const emptyVideo = (): VideoConstraints => ({
  maxFileSizeBytes: 0,
  allowedFormats: [],
  maxDurationSeconds: 0,
  minDurationSeconds: 0,
  maxWidth: 0,
  maxHeight: 0,
  allowedAspectRatios: [],
  maxAttachmentsPerPost: 0,
  requiresVideoTitle: false,
});
const emptyPdf = (): PdfConstraints => ({
  maxFileSizeBytes: 0,
  allowedFormats: [],
  maxPages: 0,
  maxAttachmentsPerPost: 0,
});
const emptyText = (): TextConstraints => ({
  maxContentChars: 0,
  maxTitleChars: 0,
  perPostType: {},
});

function toRows(p?: Platform): PostTypeRow[] {
  if (!p?.postTypes) return [];
  const supported = new Set(p.supportedPostTypes ?? []);
  return Object.entries(p.postTypes).map(([slug, label]) => ({
    slug,
    label,
    publishable: supported.has(slug),
  }));
}

interface PlatformDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: Mode;
  // The platform being edited (edit mode only).
  platform?: Platform;
  onSaved: (name: string, created: boolean) => void;
}

// PlatformDialog is the whole-resource Add/Edit form. The body lives in
// PlatformForm, which Radix mounts fresh each open — so it seeds from the
// current platform without an effect and resets between opens (mirrors
// CatalogDialog/SecretDialog). It's a wide (~50vw) tabbed dialog: one tab per
// area (identity+guidance / post types / media & text limits).
export function PlatformDialog({
  open,
  onOpenChange,
  mode,
  platform,
  onSaved,
}: PlatformDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[50vw] max-w-none min-w-[640px]">
        <PlatformForm
          mode={mode}
          platform={platform}
          onCancel={() => onOpenChange(false)}
          onSaved={(n, created) => {
            onSaved(n, created);
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function PlatformForm({
  mode,
  platform,
  onCancel,
  onSaved,
}: {
  mode: Mode;
  platform?: Platform;
  onCancel: () => void;
  onSaved: (name: string, created: boolean) => void;
}) {
  // Identity — name + zernioId are immutable once created (identity tied to the
  // Zernio wire), so they're disabled on edit and simply round-trip unchanged.
  const [name, setName] = useState(() => platform?.name ?? "");
  const [zernioId, setZernioId] = useState(() => platform?.zernioId ?? "");
  const [connectSupported, setConnectSupported] = useState(
    () => platform?.connectSupported ?? false,
  );
  // On Add, enabled defaults OFF (Ogen creates platforms disabled — the flow is
  // add → verify the slug connects → toggle on). On Edit it reflects the stored
  // value.
  const [enabled, setEnabled] = useState(() => platform?.enabled ?? false);
  const [sortOrder, setSortOrder] = useState(() => platform?.sortOrder ?? 0);

  // Guidance (AI prose)
  const [cadence, setCadence] = useState(() => platform?.cadence ?? "");
  const [constraintsProse, setConstraintsProse] = useState(
    () => platform?.constraints ?? "",
  );

  // Post types
  const [postTypes, setPostTypes] = useState<PostTypeRow[]>(() =>
    toRows(platform),
  );

  // Media/text constraints (materialized so every tab has fields; a platform
  // with no such block starts from zeros).
  const [image, setImage] = useState<ImageConstraints>(
    () => platform?.imageConstraints ?? emptyImage(),
  );
  const [video, setVideo] = useState<VideoConstraints>(
    () => platform?.videoConstraints ?? emptyVideo(),
  );
  const [pdf, setPdf] = useState<PdfConstraints>(
    () => platform?.pdfConstraints ?? emptyPdf(),
  );
  const [text, setText] = useState<TextConstraints>(
    () => platform?.textConstraints ?? emptyText(),
  );

  const [formTab, setFormTab] = useState<FormTab>("Identity");
  const [mediaTab, setMediaTab] = useState<MediaTab>("Image");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const identityLocked = mode === "edit";

  const setPostType = (i: number, patch: Partial<PostTypeRow>) =>
    setPostTypes((rows) =>
      rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)),
    );
  const addPostType = () =>
    setPostTypes((rows) => [
      ...rows,
      { slug: "", label: "", publishable: false },
    ]);
  const removePostType = (i: number) =>
    setPostTypes((rows) => rows.filter((_, idx) => idx !== i));

  const setPerPostType = (slug: string, chars: number) =>
    setText((t) => ({
      ...t,
      perPostType: { ...(t.perPostType ?? {}), [slug]: chars },
    }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedSlug = zernioId.trim();
    if (!trimmedName) {
      setError("Display name is required.");
      setFormTab("Identity");
      return;
    }
    if (!trimmedSlug) {
      setError("Zernio slug is required.");
      setFormTab("Identity");
      return;
    }

    // Fan the post-type rows back into the map + publishable subset, dropping
    // blank slugs. Last write wins on a duplicate slug.
    const validRows = postTypes.filter((r) => r.slug.trim());
    const postTypesMap: Record<string, string> = {};
    const supported: string[] = [];
    for (const r of validRows) {
      const slug = r.slug.trim();
      postTypesMap[slug] = r.label.trim() || slug;
      if (r.publishable) supported.push(slug);
    }
    const slugSet = new Set(Object.keys(postTypesMap));

    // per_post_type overrides only for current post types with a non-zero value
    // (Ogen rejects an override whose slug isn't a post type).
    const perPostType: Record<string, number> = {};
    for (const [slug, chars] of Object.entries(text.perPostType ?? {})) {
      if (slugSet.has(slug) && chars > 0) perPostType[slug] = chars;
    }

    const body: Platform = {
      id: platform?.id ?? "",
      name: trimmedName,
      zernioId: trimmedSlug,
      enabled,
      connectSupported,
      cadence: cadence.trim(),
      constraints: constraintsProse.trim(),
      postTypes: postTypesMap,
      supportedPostTypes: supported,
      sortOrder,
      imageConstraints: image,
      videoConstraints: video,
      pdfConstraints: pdf,
      textConstraints: { ...text, perPostType },
      // Read-only server fields; ignored on write but required by the type.
      usage: platform?.usage ?? { connectedAccounts: 0, scheduledPosts: 0 },
      createdAt: platform?.createdAt ?? "",
      updatedAt: platform?.updatedAt ?? "",
    };

    setSubmitting(true);
    setError(null);
    try {
      const isCreate = mode === "create";
      const url = isCreate
        ? "/api/platforms"
        : `/api/platforms/${encodeURIComponent(platform!.id)}`;
      const res = await fetch(url, {
        method: isCreate ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(detail?.error || `Request failed (${res.status})`);
      }
      onSaved(trimmedName, res.status === 201);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save platform.");
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="grid gap-5">
      <DialogHeader>
        <DialogTitle>
          {mode === "edit" ? "Edit platform" : "New platform"}
        </DialogTitle>
        <DialogDescription>
          {mode === "edit"
            ? "Update this platform’s post types, media/text limits, guidance, and enabled state."
            : "Add a platform. It starts disabled — verify the Zernio slug connects, then enable it from the list."}
        </DialogDescription>
      </DialogHeader>

      {/* Pale full-bleed divider under the description. */}
      <div className="-mx-6 border-b border-border" />

      {/* Top-level tabs (one per area) */}
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

      {/* ── Tab: Identity & guidance ─────────────────────────────── */}
      {formTab === "Identity" && (
        <div className="grid gap-5">
          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Display name"
              htmlFor="pf-name"
              hint={identityLocked ? "Set at creation — can’t be changed." : undefined}
            >
              <Input
                id="pf-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. LinkedIn"
                autoComplete="off"
                disabled={identityLocked}
              />
            </Field>
            <Field
              label="Zernio slug"
              htmlFor="pf-slug"
              hint={
                identityLocked
                  ? "Set at creation — can’t be changed."
                  : "The Zernio wire id (e.g. linkedin, twitter)."
              }
            >
              <Input
                id="pf-slug"
                value={zernioId}
                onChange={(e) => setZernioId(e.target.value)}
                placeholder="e.g. linkedin"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                disabled={identityLocked}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <NumberField
              label="Sort order"
              value={sortOrder}
              onChange={setSortOrder}
              hint="Lower sorts first. Drag rows in the list to reorder too."
            />
            <div className="flex flex-col justify-end gap-3 pb-1">
              <Toggle
                checked={connectSupported}
                onChange={setConnectSupported}
                label="Connect supported"
              />
              <Toggle checked={enabled} onChange={setEnabled} label="Enabled" />
            </div>
          </div>

          <Section
            title="Guidance"
            subtitle="Prose hints used by AI content generation."
          >
            <Field label="Cadence" htmlFor="pf-cadence">
              <textarea
                id="pf-cadence"
                value={cadence}
                onChange={(e) => setCadence(e.target.value)}
                rows={2}
                placeholder="e.g. 3–5 posts per week, mornings"
                className="w-full resize-y rounded-none border-b border-quaternary bg-input px-4 py-2 text-sm text-foreground outline-none focus:border-foreground"
              />
            </Field>
            <Field label="Constraints" htmlFor="pf-constraints">
              <textarea
                id="pf-constraints"
                value={constraintsProse}
                onChange={(e) => setConstraintsProse(e.target.value)}
                rows={2}
                placeholder="e.g. Keep it professional; no hashtags"
                className="w-full resize-y rounded-none border-b border-quaternary bg-input px-4 py-2 text-sm text-foreground outline-none focus:border-foreground"
              />
            </Field>
          </Section>
        </div>
      )}

      {/* ── Tab: Post types ──────────────────────────────────────── */}
      {formTab === "Post types" && (
        <Section
          title="Post types"
          subtitle="Slug → label. Mark the Zernio-publishable ones."
        >
          <div className="grid gap-2">
            {postTypes.length === 0 && (
              <p className="text-xs text-tertiary-foreground">
                No post types yet.
              </p>
            )}
            {postTypes.map((row, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  aria-label={`Post type ${i + 1} slug`}
                  value={row.slug}
                  onChange={(e) => setPostType(i, { slug: e.target.value })}
                  placeholder="slug"
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Input
                  aria-label={`Post type ${i + 1} label`}
                  value={row.label}
                  onChange={(e) => setPostType(i, { label: e.target.value })}
                  placeholder="Label"
                  autoComplete="off"
                />
                <label className="flex shrink-0 items-center gap-1.5 text-xs text-secondary-foreground">
                  <input
                    type="checkbox"
                    checked={row.publishable}
                    onChange={(e) =>
                      setPostType(i, { publishable: e.target.checked })
                    }
                    className="size-4 accent-emerald-600"
                  />
                  Publishable
                </label>
                <button
                  type="button"
                  onClick={() => removePostType(i)}
                  aria-label={`Remove post type ${i + 1}`}
                  className="shrink-0 rounded-xs p-1.5 text-tertiary-foreground transition-colors hover:bg-secondary hover:text-destructive"
                >
                  <TrashIcon className="size-4" />
                </button>
              </div>
            ))}
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addPostType}
              >
                <PlusIcon className="size-4" weight="bold" />
                Add post type
              </Button>
            </div>
          </div>
        </Section>
      )}

      {/* ── Tab: Media & text limits ─────────────────────────────── */}
      {formTab === "Media & text limits" && (
        <div className="grid gap-3">
          <div role="tablist" className="flex gap-6 border-b border-border">
            {MEDIA_TABS.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={t === mediaTab}
                onClick={() => setMediaTab(t)}
                className={cn(
                  "relative -mb-px border-b-2 py-2 text-sm whitespace-nowrap transition-colors outline-none",
                  t === mediaTab
                    ? "border-foreground font-semibold text-foreground"
                    : "border-transparent font-medium text-tertiary-foreground hover:text-secondary-foreground",
                )}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="pt-1">
            {mediaTab === "Image" && (
              <div className="grid grid-cols-2 gap-4">
                <ByteField
                  label="Max file size"
                  bytes={image.maxFileSizeBytes}
                  onChange={(b) =>
                    setImage((c) => ({ ...c, maxFileSizeBytes: b }))
                  }
                  extraHint="Can't exceed the global image ceiling."
                />
                <NumberField
                  label="Max attachments per post"
                  value={image.maxAttachmentsPerPost}
                  onChange={(n) =>
                    setImage((c) => ({ ...c, maxAttachmentsPerPost: n }))
                  }
                />
                <TagsField
                  label="Allowed formats"
                  value={image.allowedFormats}
                  onChange={(f) => setImage((c) => ({ ...c, allowedFormats: f }))}
                  placeholder="jpeg, png, webp, gif"
                  hint="Comma-separated."
                />
                <div className="flex items-end pb-1">
                  <Toggle
                    checked={image.animatedGifSupported}
                    onChange={(v) =>
                      setImage((c) => ({ ...c, animatedGifSupported: v }))
                    }
                    label="Animated GIF supported"
                  />
                </div>
              </div>
            )}

            {mediaTab === "Video" && (
              <div className="grid grid-cols-2 gap-4">
                <ByteField
                  label="Max file size"
                  bytes={video.maxFileSizeBytes}
                  onChange={(b) =>
                    setVideo((c) => ({ ...c, maxFileSizeBytes: b }))
                  }
                  extraHint="Can't exceed the global video ceiling."
                />
                <TagsField
                  label="Allowed formats"
                  value={video.allowedFormats}
                  onChange={(f) => setVideo((c) => ({ ...c, allowedFormats: f }))}
                  placeholder="mp4, mov, webm"
                  hint="Comma-separated."
                />
                <NumberField
                  label="Min duration (seconds)"
                  value={video.minDurationSeconds}
                  onChange={(n) =>
                    setVideo((c) => ({ ...c, minDurationSeconds: n }))
                  }
                />
                <NumberField
                  label="Max duration (seconds)"
                  value={video.maxDurationSeconds}
                  onChange={(n) =>
                    setVideo((c) => ({ ...c, maxDurationSeconds: n }))
                  }
                />
                <NumberField
                  label="Max width (px)"
                  value={video.maxWidth}
                  onChange={(n) => setVideo((c) => ({ ...c, maxWidth: n }))}
                />
                <NumberField
                  label="Max height (px)"
                  value={video.maxHeight}
                  onChange={(n) => setVideo((c) => ({ ...c, maxHeight: n }))}
                />
                <TagsField
                  label="Allowed aspect ratios"
                  value={video.allowedAspectRatios}
                  onChange={(r) =>
                    setVideo((c) => ({ ...c, allowedAspectRatios: r }))
                  }
                  placeholder="16:9, 9:16, 1:1, 4:5"
                  hint="Comma-separated."
                />
                <NumberField
                  label="Max attachments per post"
                  value={video.maxAttachmentsPerPost}
                  onChange={(n) =>
                    setVideo((c) => ({ ...c, maxAttachmentsPerPost: n }))
                  }
                />
                <div className="flex items-end pb-1">
                  <Toggle
                    checked={video.requiresVideoTitle}
                    onChange={(v) =>
                      setVideo((c) => ({ ...c, requiresVideoTitle: v }))
                    }
                    label="Requires video title"
                  />
                </div>
              </div>
            )}

            {mediaTab === "PDF" && (
              <div className="grid grid-cols-2 gap-4">
                <ByteField
                  label="Max file size"
                  bytes={pdf.maxFileSizeBytes}
                  onChange={(b) => setPdf((c) => ({ ...c, maxFileSizeBytes: b }))}
                  extraHint="Can't exceed the global PDF ceiling."
                />
                <NumberField
                  label="Max pages"
                  value={pdf.maxPages}
                  onChange={(n) => setPdf((c) => ({ ...c, maxPages: n }))}
                />
                <TagsField
                  label="Allowed formats"
                  value={pdf.allowedFormats}
                  onChange={(f) => setPdf((c) => ({ ...c, allowedFormats: f }))}
                  placeholder="pdf"
                  hint="Comma-separated."
                />
                <NumberField
                  label="Max attachments per post"
                  value={pdf.maxAttachmentsPerPost}
                  onChange={(n) =>
                    setPdf((c) => ({ ...c, maxAttachmentsPerPost: n }))
                  }
                />
              </div>
            )}

            {mediaTab === "Text" && (
              <div className="grid gap-4">
                <div className="grid grid-cols-2 gap-4">
                  <NumberField
                    label="Max content characters"
                    value={text.maxContentChars}
                    onChange={(n) =>
                      setText((c) => ({ ...c, maxContentChars: n }))
                    }
                  />
                  <NumberField
                    label="Max title characters"
                    value={text.maxTitleChars}
                    onChange={(n) => setText((c) => ({ ...c, maxTitleChars: n }))}
                  />
                </div>
                <div className="grid gap-2">
                  <Label>Per-post-type character overrides</Label>
                  {postTypes.filter((r) => r.slug.trim()).length === 0 ? (
                    <p className="text-xs text-tertiary-foreground">
                      Add post types in the Post types tab to set per-type
                      character limits.
                    </p>
                  ) : (
                    <div className="grid gap-2">
                      {postTypes
                        .filter((r) => r.slug.trim())
                        .map((r) => {
                          const slug = r.slug.trim();
                          return (
                            <div
                              key={slug}
                              className="flex items-center justify-between gap-3"
                            >
                              <span className="min-w-0 truncate text-sm text-secondary-foreground">
                                {r.label.trim() || slug}{" "}
                                <span className="font-mono text-xs text-tertiary-foreground">
                                  {slug}
                                </span>
                              </span>
                              <Input
                                type="number"
                                inputMode="numeric"
                                min={0}
                                aria-label={`Character override for ${slug}`}
                                value={String(text.perPostType?.[slug] ?? 0)}
                                onChange={(e) => {
                                  const n = Number(e.target.value);
                                  setPerPostType(
                                    slug,
                                    Number.isFinite(n) && n > 0
                                      ? Math.floor(n)
                                      : 0,
                                  );
                                }}
                                className="max-w-32"
                              />
                            </div>
                          );
                        })}
                      <p className="text-xs text-tertiary-foreground">
                        0 means no override — the max content limit applies.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="defaultInverted"
          className="font-semibold"
          disabled={submitting}
        >
          {submitting
            ? "Saving…"
            : mode === "edit"
              ? "Save changes"
              : "Add platform"}
        </Button>
      </DialogFooter>
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
