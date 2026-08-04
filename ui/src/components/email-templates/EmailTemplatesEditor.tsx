"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Editor from "react-simple-code-editor";
import Prism from "prismjs";
import "prismjs/components/prism-markup";
import "prismjs/themes/prism.css";
import beautify from "js-beautify";
import { cn } from "@/lib/utils";

interface EmailTemplate {
  key: string;
  subject: string;
  html: string;
  text: string;
  kind: string;
  version: number;
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

export function EmailTemplatesEditor() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // The selected template key lives in the URL (?template=…) so selections are
  // linkable and survive reloads. useSearchParams keeps this reactive.
  const selectedKey = searchParams.get("template");

  const [data, setData] = useState<TemplatesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  const select = (key: string) => {
    router.push(`/email-templates?template=${encodeURIComponent(key)}`);
  };

  return (
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
          <p className="p-4 text-sm text-tertiary-foreground">No templates.</p>
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
                      "w-full border-b border-border px-4 py-3 text-left transition-colors cursor-pointer",
                      active ? "bg-secondary" : "hover:bg-secondary/60",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-sm">
                        {t.key}
                      </span>
                      <span className="shrink-0 rounded-[3px] border border-border px-1.5 py-0.5 text-[10px] uppercase text-tertiary-foreground">
                        {t.kind}
                      </span>
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
          // Keyed by template key so switching remounts the editor with a fresh
          // draft seeded from that template — no reset-in-effect needed.
          <TemplateEditor key={selected.key} template={selected} />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-tertiary-foreground">
            Select a template to edit.
          </div>
        )}
      </section>
    </div>
  );
}

// TemplateEditor holds a local, editable copy of one template's HTML. Saving is
// not wired yet (first iteration); the parent remounts this via `key` when the
// selected template changes, so the draft always starts from the current body.
function TemplateEditor({ template }: { template: EmailTemplate }) {
  const [draft, setDraft] = useState(() => beautifyHtml(template.html));

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
    setAtBottom(Math.ceil(el.scrollHeight - (el.scrollTop + el.clientHeight)) <= 0);
  }, [draft]);

  return (
    <>
      <div className="shrink-0 border-b border-border px-6 pt-3.75 pb-3.5">
        <p className="text-sm font-medium">{template.subject}</p>
        <p className="font-mono text-xs text-tertiary-foreground">
          {template.key} · v{template.version}
        </p>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={(e) => onScroll(e.currentTarget)}
          className="h-full overflow-x-hidden overflow-y-auto"
        >
          <Editor
            value={draft}
            onValueChange={setDraft}
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
