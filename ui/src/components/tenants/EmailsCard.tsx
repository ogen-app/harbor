"use client";

// The /tenants/[id] "Emails" tab (CON-192): a filterable, keyset-paginated list
// of a tenant's sent emails, each opening a drawer with the rendered body (live
// from Resend), full recipient/header metadata, and the persisted
// delivery/open/click timeline. All data comes from Ogen's EmailAdminService
// (CON-298) via /api/tenants/:id/emails; Harbor has no Resend key of its own.

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { InfoIcon } from "@/components/dashboard/primitives";
import { Loader } from "@/components/ui/loader";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/components/tenants/shared";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerBody,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";

// ── types (mirror src/repository/ogenemail JSON) ────────────────────────────

interface EmailSummary {
  id: string;
  tenantId: string;
  toEmail: string;
  templateId: string;
  kind: string; // transactional | marketing
  status: string;
  lastEvent: string;
  lastEventAt: string | null;
  opensCount: number;
  clicksCount: number;
  error: string;
  createdAt: string;
}

interface EmailEvent {
  type: string;
  occurredAt: string;
}

// EmailSummary fields are flattened inline on the detail (the Go handler embeds
// the summary), so EmailDetail extends it.
interface EmailDetail extends EmailSummary {
  bodyAvailable: boolean;
  subject: string;
  html: string;
  text: string;
  from: string;
  replyTo: string;
  cc: string[];
  bcc: string[];
  events: EmailEvent[];
}

interface EmailsListResponse {
  available: boolean;
  emails: EmailSummary[];
  nextCursor: string;
}

interface EmailDetailResponse {
  available: boolean;
  email?: EmailDetail;
}

// ── presentation helpers ─────────────────────────────────────────────────────

const PAGE_SIZE = 25;

// Status → badge classes. Green for good delivery, blue/violet for engagement,
// red/amber for negative outcomes, muted grey for pending/skipped. Unknown falls
// back to neutral.
const STATUS_STYLE: Record<string, string> = {
  queued: "bg-secondary text-tertiary-foreground",
  sent: "bg-emerald-500/15 text-emerald-600",
  delivered: "bg-emerald-500/15 text-emerald-600",
  opened: "bg-blue-500/15 text-blue-600",
  clicked: "bg-violet-500/15 text-violet-600",
  bounced: "bg-red-500/15 text-red-600",
  failed: "bg-red-500/15 text-red-600",
  complained: "bg-amber-500/15 text-amber-700",
  skipped_suppressed: "bg-secondary text-tertiary-foreground",
  skipped_disabled: "bg-secondary text-tertiary-foreground",
};

// The status chips offered in the filter bar (multi-select, any-of). A curated
// set of the interesting states — the server accepts any status regardless.
const STATUS_FILTERS = [
  "sent",
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "failed",
] as const;

// humanize turns a snake_case enum ("skipped_suppressed", "delivery_delayed")
// into a readable label ("Skipped suppressed", "Delivery delayed").
function humanize(s: string): string {
  if (!s) return "—";
  const spaced = s.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        STATUS_STYLE[status] ?? "bg-secondary text-secondary-foreground",
      )}
    >
      {humanize(status)}
    </span>
  );
}

function KindChip({ kind }: { kind: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium capitalize",
        kind === "marketing"
          ? "bg-blue-500/10 text-blue-600"
          : "bg-secondary text-secondary-foreground",
      )}
    >
      {kind || "—"}
    </span>
  );
}

const TH =
  "border-b border-border px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-tertiary-foreground first:pl-6 last:pr-6";
const TD = "px-3 py-2.5 align-middle first:pl-6 last:pr-6";

// ── list ─────────────────────────────────────────────────────────────────────

function EmailRow({
  email,
  onOpen,
}: {
  email: EmailSummary;
  onOpen: (e: EmailSummary) => void;
}) {
  const engaged = email.opensCount > 0 || email.clicksCount > 0;
  return (
    <tr
      tabIndex={0}
      role="button"
      aria-label={`Open email to ${email.toEmail}`}
      onClick={() => onOpen(email)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(email);
        }
      }}
      className="cursor-pointer outline-none transition-colors hover:bg-secondary/40 focus-visible:bg-secondary/40"
    >
      <td className={cn(TD, "max-w-[16rem]")}>
        <span className="block truncate font-medium text-foreground">
          {email.toEmail || "—"}
        </span>
      </td>
      <td className={cn(TD, "text-secondary-foreground")}>
        <span className="block max-w-[12rem] truncate" title={email.templateId}>
          {humanize(email.templateId)}
        </span>
      </td>
      <td className={TD}>
        <KindChip kind={email.kind} />
      </td>
      <td className={TD}>
        <StatusBadge status={email.status} />
      </td>
      <td
        className={cn(
          TD,
          "tabular-nums",
          engaged ? "text-foreground" : "text-tertiary-foreground",
        )}
        title={`${email.opensCount} opens · ${email.clicksCount} clicks`}
      >
        {engaged ? `${email.opensCount} · ${email.clicksCount}` : "—"}
      </td>
      <td className={cn(TD, "whitespace-nowrap tabular-nums text-tertiary-foreground")}>
        {formatDateTime(email.createdAt)}
      </td>
    </tr>
  );
}

// ── detail drawer ──────────────────────────────────────────────────────────

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <dt className="w-24 shrink-0 text-xs text-tertiary-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-xs text-foreground">
        {value}
      </dd>
    </div>
  );
}

function Timeline({ events }: { events: EmailEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="text-xs text-tertiary-foreground">
        No delivery events recorded yet.
      </p>
    );
  }
  return (
    <ul className="space-y-3">
      {events.map((e, i) => (
        <li key={i} className="flex gap-2.5 text-xs">
          <span className="mt-1 size-1.5 shrink-0 rounded-full bg-emerald-500" />
          <div className="min-w-0">
            <p className="font-medium text-foreground">{humanize(e.type)}</p>
            <p className="tabular-nums text-tertiary-foreground">
              {formatDateTime(e.occurredAt)}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function EmailBody({ detail }: { detail: EmailDetail }) {
  // Prefer HTML; offer a Text toggle only when both are present. Default to
  // whichever exists.
  const hasHtml = detail.html.trim() !== "";
  const hasText = detail.text.trim() !== "";
  const [view, setView] = useState<"html" | "text">(hasHtml ? "html" : "text");

  if (!detail.bodyAvailable || (!hasHtml && !hasText)) {
    return (
      <p className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-xs text-tertiary-foreground">
        Body unavailable — it could not be fetched from Resend (the message may
        have aged out of retention, or the Resend key is unset).
      </p>
    );
  }

  return (
    <div>
      {hasHtml && hasText && (
        <div className="mb-2 inline-flex rounded-md border border-border p-0.5 text-xs">
          {(["html", "text"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn(
                "rounded-[5px] px-2 py-0.5 font-medium uppercase transition-colors",
                view === v
                  ? "bg-secondary text-foreground"
                  : "text-tertiary-foreground hover:text-foreground",
              )}
            >
              {v}
            </button>
          ))}
        </div>
      )}
      {view === "html" && hasHtml ? (
        // Sandboxed with no allow-scripts / allow-same-origin: arbitrary email
        // HTML renders but can neither run script nor reach Harbor's origin.
        <iframe
          title="Email HTML body"
          sandbox=""
          srcDoc={detail.html}
          className="h-[28rem] w-full rounded-md border border-border bg-white"
        />
      ) : (
        <pre className="max-h-[28rem] overflow-auto rounded-md border border-border bg-secondary/30 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-foreground">
          {detail.text || "—"}
        </pre>
      )}
    </div>
  );
}

function EmailDetailView({ detail }: { detail: EmailDetail }) {
  return (
    <div className="space-y-6">
      <dl className="space-y-2">
        <MetaRow label="To" value={detail.toEmail || "—"} />
        {detail.from && <MetaRow label="From" value={detail.from} />}
        {detail.replyTo && <MetaRow label="Reply-To" value={detail.replyTo} />}
        {detail.cc.length > 0 && <MetaRow label="Cc" value={detail.cc.join(", ")} />}
        {detail.bcc.length > 0 && (
          <MetaRow label="Bcc" value={detail.bcc.join(", ")} />
        )}
        <MetaRow
          label="Template"
          value={
            <span className="font-mono">{detail.templateId || "—"}</span>
          }
        />
        <MetaRow label="Type" value={<KindChip kind={detail.kind} />} />
        <MetaRow label="Status" value={<StatusBadge status={detail.status} />} />
        <MetaRow
          label="Engagement"
          value={`${detail.opensCount} opens · ${detail.clicksCount} clicks`}
        />
        <MetaRow label="Created" value={formatDateTime(detail.createdAt)} />
        {detail.error && (
          <MetaRow
            label="Error"
            value={<span className="text-red-600">{detail.error}</span>}
          />
        )}
      </dl>

      <div>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
          Timeline
        </h3>
        <Timeline events={detail.events} />
      </div>

      <div>
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
          Body
        </h3>
        <EmailBody detail={detail} />
      </div>
    </div>
  );
}

// ── segmented / chip filter controls ─────────────────────────────────────────

function KindFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const opts: { key: string; label: string }[] = [
    { key: "", label: "All" },
    { key: "transactional", label: "Transactional" },
    { key: "marketing", label: "Marketing" },
  ];
  return (
    <div className="inline-flex rounded-md border border-border p-0.5 text-xs">
      {opts.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          aria-pressed={value === o.key}
          className={cn(
            "rounded-[5px] px-2.5 py-1 font-medium transition-colors",
            value === o.key
              ? "bg-secondary text-foreground"
              : "text-tertiary-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function StatusFilter({
  selected,
  onToggle,
}: {
  selected: string[];
  onToggle: (status: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {STATUS_FILTERS.map((s) => {
        const on = selected.includes(s);
        return (
          <button
            key={s}
            type="button"
            onClick={() => onToggle(s)}
            aria-pressed={on}
            className={cn(
              "rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize transition-colors",
              on
                ? "border-foreground bg-foreground text-background"
                : "border-border text-tertiary-foreground hover:text-foreground",
            )}
          >
            {s}
          </button>
        );
      })}
    </div>
  );
}

// ── card ─────────────────────────────────────────────────────────────────────

export function EmailsCard({ tenantId }: { tenantId: string }) {
  const enc = encodeURIComponent(tenantId);

  // Filters.
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [kind, setKind] = useState("");
  const [statuses, setStatuses] = useState<string[]>([]);

  // List.
  const [rows, setRows] = useState<EmailSummary[]>([]);
  const [cursor, setCursor] = useState(""); // next-page token; "" = no more
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);

  // Detail drawer.
  const [selected, setSelected] = useState<EmailSummary | null>(null);
  const [detail, setDetail] = useState<EmailDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Debounce the recipient search so each keystroke doesn't refetch.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const statusKey = statuses.join(",");

  const buildURL = useCallback(
    (cur: string) => {
      const p = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (cur) p.set("cursor", cur);
      if (kind) p.set("kind", kind);
      if (statusKey) p.set("status", statusKey);
      if (debouncedQuery) p.set("q", debouncedQuery);
      return `/api/tenants/${enc}/emails?${p.toString()}`;
    },
    [enc, kind, statusKey, debouncedQuery],
  );

  // First page — reruns whenever a filter changes. A request counter drops any
  // response a newer filter has superseded.
  const reqId = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const id = ++reqId.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    fetch(buildURL(""), { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`request failed (${r.status})`);
        return r.json();
      })
      .then((j: EmailsListResponse) => {
        if (id !== reqId.current) return;
        setAvailable(j.available);
        setRows(j.available ? (j.emails ?? []) : []);
        setCursor(j.available ? (j.nextCursor ?? "") : "");
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted || id !== reqId.current) return;
        setError(e instanceof Error ? e.message : "Failed to load");
        setLoading(false);
      });
    return () => controller.abort();
  }, [buildURL]);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    const id = reqId.current;
    fetch(buildURL(cursor))
      .then((r) => {
        if (!r.ok) throw new Error(`request failed (${r.status})`);
        return r.json();
      })
      .then((j: EmailsListResponse) => {
        if (id !== reqId.current) return; // a filter changed under us
        setRows((prev) => [...prev, ...(j.emails ?? [])]);
        setCursor(j.nextCursor ?? "");
        setLoadingMore(false);
      })
      .catch(() => setLoadingMore(false));
  }, [cursor, loadingMore, buildURL]);

  // Load a single email's detail (body + timeline) when its row is opened.
  const openEmail = useCallback(
    (e: EmailSummary) => {
      setSelected(e);
      setDetail(null);
      setDetailError(null);
      setDetailLoading(true);
      fetch(`/api/tenants/${enc}/emails/${encodeURIComponent(e.id)}`)
        .then((r) => {
          if (!r.ok) throw new Error(`request failed (${r.status})`);
          return r.json();
        })
        .then((j: EmailDetailResponse) => {
          if (j.available && j.email) {
            setDetail(j.email);
          } else {
            setDetailError("Email detail is unavailable.");
          }
          setDetailLoading(false);
        })
        .catch((err: unknown) => {
          setDetailError(err instanceof Error ? err.message : "Failed to load");
          setDetailLoading(false);
        });
    },
    [enc],
  );

  const toggleStatus = (s: string) =>
    setStatuses((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );

  const filtersActive = kind !== "" || statuses.length > 0 || debouncedQuery !== "";
  const drawerTitle =
    detail?.subject || (selected ? humanize(selected.templateId) : "Email");

  return (
    <section className="flex flex-col overflow-hidden rounded-lg bg-primary">
      <div className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div className="flex items-center gap-1.5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
            Emails
          </h2>
          <InfoIcon text="Transactional & marketing email sent to this tenant, from Ogen's email log (CON-298). Status, opens and clicks come from persisted Resend webhook events; open a row to see the rendered body (fetched live from Resend) and the full delivery timeline." />
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search recipient…"
          className="h-8 w-56 rounded-md border border-border bg-transparent px-2.5 text-sm text-foreground outline-none placeholder:text-tertiary-foreground focus-visible:border-foreground"
        />
        <KindFilter value={kind} onChange={setKind} />
        <StatusFilter selected={statuses} onToggle={toggleStatus} />
        {filtersActive && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setKind("");
              setStatuses([]);
            }}
            className="text-xs text-tertiary-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Clear
          </button>
        )}
      </div>

      {/* Body */}
      {loading ? (
        <div className="flex items-center gap-2 px-6 py-6 text-xs text-tertiary-foreground">
          <Loader className="size-3.5 border-[1.5px]" />
          Loading emails…
        </div>
      ) : error ? (
        <p className="px-6 py-6 text-xs text-tertiary-foreground">
          Emails unavailable — {error}
        </p>
      ) : !available ? (
        <p className="px-6 py-6 text-sm text-tertiary-foreground">
          Email data is unavailable — the Ogen email service isn&apos;t
          configured.
        </p>
      ) : rows.length === 0 ? (
        <p className="px-6 py-6 text-sm text-tertiary-foreground">
          {filtersActive
            ? "No emails match the current filters."
            : "No emails have been sent to this tenant yet."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={TH}>Recipient</th>
                <th className={TH}>Email</th>
                <th className={TH}>Type</th>
                <th className={TH}>Status</th>
                <th className={TH}>Opens · Clicks</th>
                <th className={TH}>Sent</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((e) => (
                <EmailRow key={e.id} email={e} onOpen={openEmail} />
              ))}
            </tbody>
          </table>

          {cursor && (
            <div className="flex justify-center border-t border-border px-6 py-4">
              <Button
                variant="ghost"
                size="sm"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? (
                  <>
                    <Loader className="size-3.5 border-[1.5px]" />
                    Loading…
                  </>
                ) : (
                  "Load more"
                )}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Detail drawer */}
      <Drawer
        open={selected !== null}
        onOpenChange={(o) => {
          if (!o) setSelected(null);
        }}
      >
        <DrawerContent className="max-w-[min(44rem,calc(100vw-2.5rem))]">
          <DrawerHeader>
            <DrawerTitle className="truncate">{drawerTitle}</DrawerTitle>
            <DrawerDescription className="truncate">
              {selected?.toEmail}
            </DrawerDescription>
          </DrawerHeader>
          <DrawerBody>
            {detailLoading ? (
              <div className="flex items-center gap-2 py-4 text-xs text-tertiary-foreground">
                <Loader className="size-3.5 border-[1.5px]" />
                Loading email…
              </div>
            ) : detailError ? (
              <p className="py-4 text-xs text-tertiary-foreground">
                Failed to load — {detailError}
              </p>
            ) : detail ? (
              <EmailDetailView detail={detail} />
            ) : null}
          </DrawerBody>
        </DrawerContent>
      </Drawer>
    </section>
  );
}
