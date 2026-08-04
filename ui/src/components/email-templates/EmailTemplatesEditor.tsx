"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Editor from "react-simple-code-editor";
import Prism from "prismjs";
import "prismjs/components/prism-markup";
import "prismjs/themes/prism.css";
import beautify from "js-beautify";
import { BracketsCurlyIcon, CloudArrowUpIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface EmailTemplate {
  key: string;
  subject: string;
  html: string;
  text: string;
  kind: string;
  version: number;
  variables: Record<string, string> | null;
  updatedAt: string;
}

interface TemplatesResponse {
  templates: EmailTemplate[];
  available: boolean;
  error?: string;
}

// Prism markup grammar covers HTML; loaded for its side effect above.
const highlightHtml = (code: string) =>
  Prism.highlight(code, Prism.languages.markup, "markup");

// Same highlighting, but prefix each line with a line-number span. The span is
// absolutely positioned in the editor's left gutter (see the .editor-line-number
// rule in globals.css); with `top:auto` it keeps its own line's vertical
// position. The numbers live only in the highlight layer, so the textarea's
// value — and anything copied from it — stays free of them.
const highlightWithLineNumbers = (code: string) =>
  highlightHtml(code)
    .split("\n")
    .map((line, i) => `<span class="editor-line-number">${i + 1}</span>${line}`)
    .join("\n");

// Pretty-print the Maizzle-compiled HTML: its <body> ships as one inlined blob
// of nested tables, so we indent it into readable markup for the editor. Long
// inline-style attributes stay on their element's line (wrap_line_length 0).
// Falls back to the raw source if formatting ever throws.
function beautifyHtml(src: string): string {
  try {
    return beautify.html(src, {
      indent_size: 2,
      wrap_line_length: 0,
      preserve_newlines: false,
      indent_inner_html: true,
      wrap_attributes: "auto",
      extra_liners: [],
    });
  } catch {
    return src;
  }
}

// relativeTime renders an ISO timestamp as a coarse "… ago" string. Mirrors the
// helper in SecretsTab; guards against empty/malformed input.
function relativeTime(iso: string): string {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "unknown";
  const secs = Math.max(0, (Date.now() - ms) / 1000);
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

// Insertion order for the list mirrors the API's `ORDER BY kind, key`.
const byKindThenKey = (a: EmailTemplate, b: EmailTemplate) =>
  a.kind === b.kind ? a.key.localeCompare(b.key) : a.kind.localeCompare(b.kind);

// Compact per-kind badge for the list: a single letter on a pastel, borderless
// fill (M = marketing/yellow, T = transactional/green).
const KIND_BADGE: Record<string, { letter: string; className: string }> = {
  marketing: { letter: "M", className: "bg-yellow-100 text-yellow-800" },
  transactional: { letter: "T", className: "bg-green-100 text-green-800" },
};

function KindBadge({ kind }: { kind: string }) {
  const badge = KIND_BADGE[kind];
  return (
    <span
      title={kind}
      aria-label={kind}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-[3px] text-[11px] font-semibold",
        badge?.className ?? "bg-secondary text-tertiary-foreground",
      )}
    >
      {badge?.letter ?? kind.charAt(0).toUpperCase()}
    </span>
  );
}

// VariablesList renders a template's documented placeholders — name (an inverted
// monospace label) plus its explanation — inside the variables popover. The map
// lives in the Ogen email_templates.variables jsonb column.
function VariablesList({
  variables,
}: {
  variables: Record<string, string> | null;
}) {
  const entries = Object.entries(variables ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-tertiary-foreground">
        Available variables
      </p>
      {entries.length === 0 ? (
        <p className="text-xs text-tertiary-foreground">
          No variables documented for this template.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {entries.map(([name, desc]) => (
            <li key={name} className="space-y-1 pb-2">
              <code className="inline-block rounded-xs bg-foreground px-1.5 py-0.5 font-mono text-xs text-background">
                {name}
              </code>
              <p className="text-xs leading-snug text-tertiary-foreground">
                {desc}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The two template kinds the create dialog offers (default transactional).
// Marketing mail honours unsubscribes; transactional is essential and does not.
const TEMPLATE_KINDS = [
  {
    value: "transactional",
    label: "Transactional",
    hint: "Essential mail tied to a user action (welcome, password reset).",
  },
  {
    value: "marketing",
    label: "Marketing",
    hint: "Promotional / lifecycle mail; honours unsubscribes.",
  },
] as const;

type TemplateKind = (typeof TEMPLATE_KINDS)[number]["value"];

export function EmailTemplatesEditor() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // The selected template key lives in the URL (?template=…) so selections are
  // linkable and survive reloads. useSearchParams keeps this reactive.
  const selectedKey = searchParams.get("template");

  const [data, setData] = useState<TemplatesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const reload = useCallback((signal?: AbortSignal) => {
    return fetch("/api/email-templates", { signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Request failed (${r.status})`);
        return r.json() as Promise<TemplatesResponse>;
      })
      .then((json) => {
        setData(json);
        setLoadError(null);
      })
      .catch((e: unknown) => {
        if (signal?.aborted) return;
        setLoadError(
          e instanceof Error ? e.message : "Failed to load templates.",
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

  const templates = data?.templates ?? [];
  const selected = templates.find((t) => t.key === selectedKey) ?? null;

  // TemplateEditor reports its unsaved-edits state here (ref only — no re-render)
  // so switching templates can warn before discarding an in-progress edit.
  const dirtyRef = useRef(false);
  const handleDirtyChange = useCallback((d: boolean) => {
    dirtyRef.current = d;
  }, []);

  const select = useCallback(
    (key: string) => {
      if (
        key !== selectedKey &&
        dirtyRef.current &&
        !window.confirm("Discard unsaved changes to this template?")
      ) {
        return;
      }
      router.push(`/email-templates?template=${encodeURIComponent(key)}`);
    },
    [router, selectedKey],
  );

  // Patch one template in place after a save so the list subject + meta refresh
  // without a refetch.
  const applyUpdate = useCallback((updated: EmailTemplate) => {
    setData((prev) =>
      prev
        ? {
            ...prev,
            templates: prev.templates.map((t) =>
              t.key === updated.key ? updated : t,
            ),
          }
        : prev,
    );
  }, []);

  // After a create, drop the new row into the list (kept in the API's order)
  // and open it for editing.
  const handleCreated = useCallback(
    (created: EmailTemplate) => {
      setData((prev) =>
        prev
          ? {
              ...prev,
              templates: [
                ...prev.templates.filter((t) => t.key !== created.key),
                created,
              ].sort(byKindThenKey),
            }
          : prev,
      );
      setCreateOpen(false);
      select(created.key);
    },
    [select],
  );

  return (
    <>
      <header className="flex h-20 shrink-0 items-center justify-between border-b border-border px-6">
        <h1 className="text-2xl font-display font-medium">Email templates</h1>
        <Button onClick={() => setCreateOpen(true)} disabled={!data?.available}>
          <Icon name="plus" className="size-5.5" />
          New template
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col p-6">
        <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg bg-primary">
          {/* Left panel: template list (20%) */}
          <aside className="w-1/5 min-w-56 shrink-0 overflow-y-auto border-r border-border">
            {loading ? (
              <p className="p-4 text-sm text-tertiary-foreground">Loading…</p>
            ) : loadError ? (
              <p className="p-4 text-sm text-destructive">{loadError}</p>
            ) : !data?.available ? (
              <p className="p-4 text-sm text-tertiary-foreground">
                {data?.error ?? "Service unavailable."}
              </p>
            ) : templates.length === 0 ? (
              <p className="p-4 text-sm text-tertiary-foreground">
                No templates.
              </p>
            ) : (
              <ul>
                {templates.map((t) => {
                  const active = t.key === selectedKey;
                  return (
                    <li key={t.key}>
                      <button
                        type="button"
                        onClick={() => select(t.key)}
                        className={cn(
                          "w-full cursor-pointer border-b border-border px-4 py-3 text-left transition-colors",
                          active ? "bg-secondary" : "hover:bg-secondary/60",
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-mono text-sm">
                            {t.key}
                          </span>
                          <KindBadge kind={t.kind} />
                        </div>
                        <p className="mt-1 truncate text-xs text-tertiary-foreground">
                          {t.subject}
                        </p>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>

          {/* Right panel: editor for the selected template */}
          <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {selected ? (
              // Keyed by template key so switching remounts the editor with a
              // fresh draft seeded from that template — no reset-in-effect.
              <TemplateEditor
                key={selected.key}
                template={selected}
                onSaved={applyUpdate}
                onDirtyChange={handleDirtyChange}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center p-6 text-sm text-tertiary-foreground">
                Select a template to edit.
              </div>
            )}
          </section>
        </div>
      </div>

      <NewTemplateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
      />
    </>
  );
}

// TemplateEditor holds a local, editable copy of one template's subject and HTML
// body. Save writes both back via PUT; the parent remounts this via `key` when
// the selected template changes, so state always starts from the current row.
function TemplateEditor({
  template,
  onSaved,
  onDirtyChange,
}: {
  template: EmailTemplate;
  onSaved: (t: EmailTemplate) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const initialHtml = useMemo(() => beautifyHtml(template.html), [template.html]);

  const [subject, setSubject] = useState(template.subject);
  const [draft, setDraft] = useState(initialHtml);
  // Baseline of what's persisted, for dirty detection; advances on each save.
  const [savedSubject, setSavedSubject] = useState(template.subject);
  const [savedHtml, setSavedHtml] = useState(initialHtml);
  const [meta, setMeta] = useState({
    version: template.version,
    updatedAt: template.updatedAt,
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const dirty = subject !== savedSubject || draft !== savedHtml;

  // Report dirty state up so the parent can guard navigation. Sets a ref (not
  // state), so this is a plain effect with no cascading render.
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const save = async () => {
    if (!dirty || saving || subject.trim() === "") return;
    setSaving(true);
    setSaveError(null);
    try {
      const r = await fetch(
        `/api/email-templates/${encodeURIComponent(template.key)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subject: subject.trim(), html: draft }),
        },
      );
      if (!r.ok) {
        const detail = (await r.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(detail?.error || `Request failed (${r.status})`);
      }
      const updated = (await r.json()) as EmailTemplate;
      setSubject(updated.subject);
      setSavedSubject(updated.subject);
      setSavedHtml(draft);
      setMeta({ version: updated.version, updatedAt: updated.updatedAt });
      onSaved(updated);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  // Scroll-fade strips at the editor's top/bottom edges, mirroring the activity
  // table: each fades in only when there is content scrolled past that edge.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const onScroll = (el: HTMLDivElement) => {
    setAtTop(el.scrollTop <= 0);
    const remaining = el.scrollHeight - (el.scrollTop + el.clientHeight);
    setAtBottom(Math.ceil(remaining) <= 0);
  };
  // Recompute after mount and whenever the body changes height — edits grow/
  // shrink it, and a template switch reseeds the draft.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAtTop(el.scrollTop <= 0);
    setAtBottom(
      Math.ceil(el.scrollHeight - (el.scrollTop + el.clientHeight)) <= 0,
    );
  }, [draft]);

  return (
    <>
      <div className="flex shrink-0 items-center gap-4 border-b border-border px-6 pt-2.5 pb-2.75">
        <div className="min-w-0 flex-1">
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            aria-label="Email subject"
            placeholder="Email subject"
            className="-mx-1.5 w-full rounded-xs bg-transparent px-1.5 py-0.5 text-sm font-medium text-foreground outline-none placeholder:text-tertiary-foreground focus:bg-secondary/50"
          />
          <p className="mt-0.5 text-xs text-tertiary-foreground">
            {template.key} · v{meta.version} · edited{" "}
            {relativeTime(meta.updatedAt)}
          </p>
        </div>
        {saveError && (
          <span className="shrink-0 text-xs text-destructive" role="alert">
            {saveError}
          </span>
        )}
        <div className="flex shrink-0 items-center gap-1.5">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label="Template variables"
              >
                <BracketsCurlyIcon className="size-4" /> Variables
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="max-h-96 w-80 overflow-y-auto"
            >
              <VariablesList variables={template.variables} />
            </PopoverContent>
          </Popover>
          <Button
            size="sm"
            variant="defaultInverted"
            onClick={() => void save()}
            disabled={!dirty || saving || subject.trim() === ""}
          >
            <CloudArrowUpIcon className="size-4" />
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <label htmlFor="template-html" className="sr-only">
          Email HTML body
        </label>
        <div
          ref={scrollRef}
          onScroll={(e) => onScroll(e.currentTarget)}
          className="h-full overflow-x-hidden overflow-y-auto"
        >
          <Editor
            value={draft}
            onValueChange={setDraft}
            textareaId="template-html"
            highlight={highlightWithLineNumbers}
            // Gutter set two ways so it can't regress: the library writes
            // paddingLeft inline from this prop, and .code-editor-body enforces
            // it in CSS (see globals.css). Both apply to the <pre> and the
            // overlaid <textarea>, keeping the caret aligned with the code.
            padding={{ top: 16, right: 16, bottom: 16, left: 48 }}
            preClassName="code-editor-body"
            textareaClassName="code-editor-body focus:outline-none"
            className="code-editor min-h-full font-mono text-[13px] leading-relaxed"
            style={{ fontFamily: "var(--font-plex-mono), monospace" }}
          />
        </div>
        {/* Top fade — appears once scrolled down from the top. */}
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 z-10 h-20 bg-linear-to-b from-primary to-transparent transition-opacity duration-200",
            atTop ? "opacity-0" : "opacity-100",
          )}
        />
        {/* Bottom fade — the same, flipped. */}
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 z-10 h-20 bg-linear-to-t from-primary to-transparent transition-opacity duration-200",
            atBottom ? "opacity-0" : "opacity-100",
          )}
        />
      </div>
    </>
  );
}

// NewTemplateDialog collects an id + title and POSTs a new template. On success
// it hands the created row to the parent, which inserts it into the list and
// opens it for editing.
function NewTemplateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (t: EmailTemplate) => void;
}) {
  const [key, setKey] = useState("");
  const [subject, setSubject] = useState("");
  const [kind, setKind] = useState<TemplateKind>("transactional");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form on close (event, not effect) so each open starts clean.
  const handleOpenChange = (o: boolean) => {
    if (!o) {
      setKey("");
      setSubject("");
      setKind("transactional");
      setError(null);
    }
    onOpenChange(o);
  };

  const canSubmit =
    key.trim() !== "" && subject.trim() !== "" && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch("/api/email-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: key.trim(), subject: subject.trim(), kind }),
      });
      if (!r.ok) {
        const detail = (await r.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(detail?.error || `Request failed (${r.status})`);
      }
      const created = (await r.json()) as EmailTemplate;
      setKey("");
      setSubject("");
      setKind("transactional");
      onCreated(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create template.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New email template</DialogTitle>
          <DialogDescription>
            Pick a stable id and a title — you can edit the content next.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="space-y-4"
        >
          <div className="space-y-1.5">
            <Label htmlFor="new-template-key">Template id</Label>
            <Input
              id="new-template-key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="welcome_back"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
            <p className="text-xs text-tertiary-foreground">
              Lowercase letters, digits and underscores.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-template-subject">Title (email subject)</Label>
            <Input
              id="new-template-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Welcome back to Ogen"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Type</Label>
            <div
              role="radiogroup"
              aria-label="Template type"
              className="flex flex-col gap-2 pt-0.5"
            >
              {TEMPLATE_KINDS.map((k) => (
                <label
                  key={k.value}
                  className="flex cursor-pointer items-start gap-2.5"
                >
                  <input
                    type="radio"
                    name="new-template-kind"
                    value={k.value}
                    checked={kind === k.value}
                    onChange={() => setKind(k.value)}
                    className="mt-0.5 size-4 shrink-0 accent-foreground"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">
                      {k.label}
                    </span>
                    <span className="block text-xs text-tertiary-foreground">
                      {k.hint}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
