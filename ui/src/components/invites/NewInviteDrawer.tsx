"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { MailAdd01Icon } from "@hugeicons/core-free-icons";
import { PaperPlaneTiltIcon, PlusIcon } from "@phosphor-icons/react";
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader } from "@/components/ui/loader";
import { Field } from "@/components/platforms/fields";
import { cn } from "@/lib/utils";
import {
  DEFAULT_EXPIRY_DAYS,
  EXPIRY_PRESETS,
  Pill,
  inviteError,
  looksLikeEmail,
} from "./format";
import { PresetChip } from "./InviteActions";
import { useInviteCatalog, type InviteCatalog } from "./useInviteCatalog";
import type { InviteInput, InviteResponse } from "./types";

const FORM_TABS = ["One person", "Several at once"] as const;
type FormTab = (typeof FORM_TABS)[number];

const MAX_TEXT = 1000;
const MAX_BULK = 50;
const BULK_CONCURRENCY = 5;

// The cohort presets select the alpha / beta group (created on first use).
const COHORTS = [
  { key: "alpha", label: "Alpha" },
  { key: "beta", label: "Beta" },
] as const;
type Cohort = (typeof COHORTS)[number]["key"];

// NewInviteDrawer creates complimentary tester invites (CON-334 §2, wireframe
// 3): one person, or several at once with a result per email. The form lives
// in NewInviteForm, which Radix mounts fresh each open, so it resets between
// opens. onSent fires after anything was sent (msg is the toast, '' for bulk —
// whose results stay on screen).
export function NewInviteDrawer({
  open,
  onOpenChange,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent: (msg: string) => void;
}) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-w-[min(46rem,calc(100vw-2.5rem))] gap-0 p-0">
        <NewInviteForm onClose={() => onOpenChange(false)} onSent={onSent} />
      </DrawerContent>
    </Drawer>
  );
}

type BulkOutcome = "sent" | "replaced" | "failed" | "pending";
type BulkRow = { email: string; outcome: BulkOutcome; detail: string };

// parseEmails splits a pasted list on newlines, commas, semicolons or spaces,
// lower-cases and dedupes it, preserving order.
function parseEmails(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const e = part.trim().toLowerCase();
    if (e && !seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
  }
  return out;
}

async function createInvite(
  input: InviteInput,
): Promise<{ ok: true; replaced: boolean } | { ok: false; message: string; code?: string }> {
  try {
    const res = await fetch("/api/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) return { ok: false, ...(await inviteError(res)) };
    const j = (await res.json()) as InviteResponse;
    return { ok: true, replaced: j.replaced };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Request failed.",
    };
  }
}

function NewInviteForm({
  onClose,
  onSent,
}: {
  onClose: () => void;
  onSent: (msg: string) => void;
}) {
  const catalog = useInviteCatalog();
  const [tab, setTab] = useState<FormTab>("One person");

  const [email, setEmail] = useState("");
  const [emails, setEmails] = useState("");
  const [tierId, setTierId] = useState("");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [cohort, setCohort] = useState<Cohort | null>(null);
  const [days, setDays] = useState<number>(DEFAULT_EXPIRY_DAYS);
  const [message, setMessage] = useState("");
  const [note, setNote] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [bulk, setBulk] = useState<BulkRow[] | null>(null);
  const bulkDone = !!bulk && bulk.every((r) => r.outcome !== "pending");

  // Number keys 1..N switch the drawer's tabs (mirrors the announcements
  // drawer). Ignored while typing in a field, and once bulk results show.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
          target.closest?.('[role="combobox"],[role="textbox"]'))
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= FORM_TABS.length) {
        e.preventDefault();
        setTab(FORM_TABS[n - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // pickCohort selects the alpha/beta group (creating it on first use) and
  // drops the other cohort's group; picking the active cohort clears it.
  const pickCohort = async (next: Cohort) => {
    setError(null);
    const findGroup = (key: string) =>
      catalog.groups.find((g) => g.name.trim().toLowerCase() === key);
    const other = COHORTS.find((c) => c.key !== next)!.key;
    const otherId = findGroup(other)?.id;
    if (cohort === next) {
      const id = findGroup(next)?.id;
      setCohort(null);
      setGroupIds((ids) => ids.filter((x) => x !== id));
      return;
    }
    try {
      const g = findGroup(next) ?? (await catalog.createGroup(next));
      setCohort(next);
      setGroupIds((ids) => [
        ...ids.filter((x) => x !== otherId && x !== g.id),
        g.id,
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t create the group.");
    }
  };

  const toggleGroup = (id: string) => {
    setGroupIds((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
    );
    // A manual change to a cohort group detaches the preset highlight.
    const g = catalog.groups.find((x) => x.id === id);
    if (g && g.name.trim().toLowerCase() === cohort) setCohort(null);
  };

  const base = (): Omit<InviteInput, "email"> => ({
    tierId,
    groupIds,
    expiresInHours: days * 24,
    message: tab === "One person" ? message.trim() : "",
    note: tab === "One person" ? note.trim() : "",
  });

  const submitOne = async () => {
    const addr = email.trim();
    if (!addr) {
      setEmailError("An email is required.");
      return;
    }
    if (!tierId) {
      setError("Pick a tier.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setEmailError(null);
    const r = await createInvite({ ...base(), email: addr });
    if (r.ok) {
      onSent(
        r.replaced
          ? "Existing pending invite for this email was replaced — the old link no longer works."
          : `Invite sent to ${addr}.`,
      );
      onClose();
      return;
    }
    // account_exists and invalid addresses belong under the Email field.
    if (r.code === "account_exists" || /email/i.test(r.message)) {
      setEmailError(r.message);
    } else {
      setError(r.message);
    }
    setSubmitting(false);
  };

  const submitBulk = async () => {
    const list = parseEmails(emails);
    if (list.length === 0) {
      setEmailError("Paste at least one email.");
      return;
    }
    if (list.length > MAX_BULK) {
      setEmailError(`Up to ${MAX_BULK} at a time — this list has ${list.length}.`);
      return;
    }
    if (!tierId) {
      setError("Pick a tier.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setEmailError(null);

    const rows: BulkRow[] = list.map((e) =>
      looksLikeEmail(e)
        ? { email: e, outcome: "pending", detail: "" }
        : { email: e, outcome: "failed", detail: "Not a valid email address" },
    );
    setBulk(rows);
    const update = (i: number, row: Partial<BulkRow>) =>
      setBulk((cur) =>
        cur ? cur.map((r, j) => (j === i ? { ...r, ...row } : r)) : cur,
      );

    // Fan out CreateTenantInvite, BULK_CONCURRENCY at a time, never stopping on
    // an error; each row fills in as its answer arrives.
    const queue = rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.outcome === "pending");
    const input = base();
    let sentAny = false;
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const res = await createInvite({ ...input, email: next.r.email });
        if (res.ok) {
          sentAny = true;
          update(next.i, {
            outcome: res.replaced ? "replaced" : "sent",
            detail: res.replaced ? "Pending invite replaced, old link stopped" : "",
          });
        } else {
          update(next.i, {
            outcome: "failed",
            detail:
              res.code === "account_exists"
                ? "Has an account — comp their workspace instead"
                : res.message,
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(BULK_CONCURRENCY, queue.length) }, worker),
    );
    setSubmitting(false);
    if (sentAny) onSent("");
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (tab === "One person") void submitOne();
    else void submitBulk();
  };

  const bulkCount = parseEmails(emails).length;

  return (
    <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-6 pt-6 pr-12">
        <DrawerTitle className="flex items-center gap-2">
          <HugeiconsIcon
            icon={MailAdd01Icon}
            className="size-5 text-tertiary-foreground"
          />
          New tester invite
        </DrawerTitle>
        <DrawerDescription className="mt-1">
          Invited workspaces are complimentary: never billed, on the tier you
          pick, and the tester can switch between public tiers themselves.
        </DrawerDescription>
      </div>

      <div className="mt-4 shrink-0 border-b border-border" />

      <div className="shrink-0 px-6 pt-4">
        <div role="tablist" className="flex gap-6 border-b border-border">
          {FORM_TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={t === tab}
              disabled={submitting || !!bulk}
              onClick={() => {
                setTab(t);
                setError(null);
                setEmailError(null);
              }}
              className={cn(
                "relative -mb-px border-b-2 py-2.5 text-sm whitespace-nowrap transition-colors outline-none disabled:cursor-not-allowed",
                t === tab
                  ? "border-foreground font-semibold text-foreground"
                  : "border-transparent font-medium text-tertiary-foreground hover:text-secondary-foreground",
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {catalog.loading ? (
          <div className="flex items-center gap-2 text-sm text-tertiary-foreground">
            <Loader className="size-4" />
            Loading tiers and groups…
          </div>
        ) : !catalog.available ? (
          <p className="text-sm text-destructive">
            Tiers and groups can’t be loaded right now (the tenant-admin or plans
            service is unavailable), so an invite can’t be built. Try again once
            it’s back.
          </p>
        ) : (
          <div className="grid gap-5">
            {tab === "One person" ? (
              <Field
                label="Email"
                htmlFor="inv-email"
                hint={
                  emailError && (
                    <span className="text-destructive" role="alert">
                      {emailError}
                    </span>
                  )
                }
              >
                <Input
                  id="inv-email"
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setEmailError(null);
                  }}
                  placeholder="jane@acme.com"
                  autoComplete="off"
                  autoFocus
                />
              </Field>
            ) : (
              <Field
                label="Emails"
                htmlFor="inv-emails"
                hint={
                  emailError ? (
                    <span className="text-destructive" role="alert">
                      {emailError}
                    </span>
                  ) : (
                    `One per line or comma-separated. Up to ${MAX_BULK}.${bulkCount ? ` ${bulkCount} address${bulkCount === 1 ? "" : "es"}.` : ""}`
                  )
                }
              >
                <textarea
                  id="inv-emails"
                  value={emails}
                  onChange={(e) => {
                    setEmails(e.target.value);
                    setEmailError(null);
                  }}
                  rows={3}
                  readOnly={!!bulk}
                  placeholder="jane@acme.com, tom@northwind.io"
                  className="w-full resize-y rounded-none border-b border-quaternary bg-input px-4 py-2 text-sm text-foreground outline-none focus:border-foreground"
                />
              </Field>
            )}

            <PickerSection label="Cohort" aside="presets the group">
              {COHORTS.map((c) => {
                const g = catalog.groups.find(
                  (x) => x.name.trim().toLowerCase() === c.key,
                );
                return (
                  <PresetChip
                    key={c.key}
                    on={cohort === c.key}
                    onClick={() => void pickCohort(c.key)}
                    disabled={!!bulk}
                    title={g ? undefined : `Creates the “${c.key}” group`}
                  >
                    <Dot color={g?.color} />
                    {c.label}
                  </PresetChip>
                );
              })}
            </PickerSection>

            <TierPicker
              catalog={catalog}
              tierId={tierId}
              onChange={setTierId}
              disabled={!!bulk}
            />

            <GroupPicker
              catalog={catalog}
              selected={groupIds}
              onToggle={toggleGroup}
              onCreated={(id) => setGroupIds((ids) => [...ids, id])}
              disabled={!!bulk}
            />

            <PickerSection label="Expires in">
              {EXPIRY_PRESETS.map((d) => (
                <PresetChip
                  key={d}
                  on={days === d}
                  onClick={() => setDays(d)}
                  disabled={!!bulk}
                >
                  {d} days
                </PresetChip>
              ))}
            </PickerSection>

            {tab === "One person" && (
              <div className="grid grid-cols-2 items-start gap-x-4 gap-y-5">
                <TextArea
                  id="inv-message"
                  label="Personal message"
                  value={message}
                  onChange={setMessage}
                  hint="Shown in the email."
                  placeholder="Hey Jane — here’s the alpha we talked about."
                />
                <TextArea
                  id="inv-note"
                  label="Internal note"
                  value={note}
                  onChange={setNote}
                  hint="Only operators see this."
                  placeholder="Where you met, what they’ll test."
                />
              </div>
            )}

            {bulk && <BulkResults rows={bulk} />}
          </div>
        )}
      </div>

      {error && (
        <div className="shrink-0 px-6 pt-3">
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        </div>
      )}

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-6 py-4">
        {bulkDone ? (
          <Button
            type="button"
            variant="defaultInverted"
            size="sm"
            className="font-semibold"
            onClick={onClose}
          >
            Done
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="defaultInverted"
              size="sm"
              className="font-semibold"
              disabled={submitting || catalog.loading || !catalog.available}
            >
              <PaperPlaneTiltIcon className="size-4" />
              {submitting
                ? "Sending…"
                : tab === "Several at once" && bulkCount > 1
                  ? `Send ${bulkCount} invites`
                  : "Send invite"}
            </Button>
          </>
        )}
      </div>
    </form>
  );
}

// TierPicker: single-select over every tier. A tier without a published
// version is disabled (Ogen would refuse it); a hidden one carries NOT SOLD.
function TierPicker({
  catalog,
  tierId,
  onChange,
  disabled,
}: {
  catalog: InviteCatalog;
  tierId: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const unpublished = catalog.tiers.some((t) => !t.active);
  return (
    <PickerSection
      label="Tier"
      hint={
        <>
          Any tier with a published version. Tiers marked NOT SOLD aren’t on
          the pricing page — only you can put someone on them.
          {unpublished && (
            <>
              {" "}
              Greyed-out tiers have no published version yet —{" "}
              <Link
                href="/tier-entitlements"
                className="underline hover:text-foreground"
              >
                publish one in Tier entitlements
              </Link>
              .
            </>
          )}
        </>
      }
    >
      {catalog.tiers.length === 0 ? (
        <p className="text-xs text-tertiary-foreground">No tiers in the catalog.</p>
      ) : (
        catalog.tiers.map((t) => (
          <PresetChip
            key={t.id}
            on={tierId === t.id}
            onClick={() => onChange(t.id)}
            disabled={disabled || !t.active}
            title={t.active ? undefined : "No published version"}
          >
            <Dot color={t.color} />
            {t.name}
            {t.active && !t.purchasable && (
              <span
                className={cn(
                  "text-[10px] font-semibold tracking-wide uppercase",
                  tierId === t.id ? "text-primary/70" : "text-tertiary-foreground",
                )}
              >
                Not sold
              </span>
            )}
          </PresetChip>
        ))
      )}
    </PickerSection>
  );
}

// GroupPicker: multi-select over the group catalog, with an inline "New group"
// shortcut (cohorts are groups).
function GroupPicker({
  catalog,
  selected,
  onToggle,
  onCreated,
  disabled,
}: {
  catalog: InviteCatalog;
  selected: string[];
  onToggle: (id: string) => void;
  onCreated: (id: string) => void;
  disabled?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const create = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    setError(null);
    try {
      const g = await catalog.createGroup(n);
      onCreated(g.id);
      setName("");
      setAdding(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t create the group.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <PickerSection
      label="Groups"
      hint={error && <span className="text-destructive">{error}</span>}
    >
      {catalog.groups.map((g) => (
        <PresetChip
          key={g.id}
          on={selected.includes(g.id)}
          onClick={() => onToggle(g.id)}
          disabled={disabled}
        >
          <Dot color={g.color} />
          {g.name}
        </PresetChip>
      ))}
      {adding ? (
        <span className="inline-flex items-center gap-1.5">
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              // Enter creates the group instead of submitting the invite form.
              if (e.key === "Enter") {
                e.preventDefault();
                void create();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setAdding(false);
              }
            }}
            placeholder="Group name"
            aria-label="New group name"
            className="w-36 border-b border-quaternary bg-input px-2 py-1 text-xs text-foreground outline-none focus:border-foreground"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7"
            onClick={() => void create()}
            disabled={busy || !name.trim()}
          >
            {busy ? "Adding…" : "Add"}
          </Button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          disabled={disabled}
          className="inline-flex items-center gap-1 px-1 py-1 text-xs font-medium text-secondary-foreground hover:text-foreground disabled:opacity-50"
        >
          <PlusIcon className="size-3.5" weight="bold" />
          New group
        </button>
      )}
    </PickerSection>
  );
}

const OUTCOME: Record<BulkOutcome, { tone: "good" | "warn" | "bad" | "neutral"; label: string }> = {
  sent: { tone: "good", label: "Sent" },
  replaced: { tone: "warn", label: "Replaced" },
  failed: { tone: "bad", label: "Not sent" },
  pending: { tone: "neutral", label: "Sending…" },
};

// BulkResults lists one row per address as the answers arrive, with a summary.
function BulkResults({ rows }: { rows: BulkRow[] }) {
  const n = (o: BulkOutcome) => rows.filter((r) => r.outcome === o).length;
  const ref = useRef<HTMLElement>(null);
  // The results land below the (now read-only) form; bring them into view.
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);
  return (
    <section ref={ref} className="grid gap-2 border-t border-border pt-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
          Results
        </h3>
        <span className="text-xs text-tertiary-foreground">
          {n("sent")} sent · {n("replaced")} replaced · {n("failed")} not sent
          {n("pending") > 0 && ` · ${n("pending")} sending`}
        </span>
      </div>
      <ul className="divide-y divide-border">
        {rows.map((r) => {
          const o = OUTCOME[r.outcome];
          return (
            <li
              key={r.email}
              className="grid grid-cols-[minmax(0,1.4fr)_auto_minmax(0,2fr)] items-center gap-4 py-2.5 text-sm"
            >
              <span className="truncate text-foreground">{r.email}</span>
              <Pill tone={o.tone} label={o.label} />
              <span className="truncate text-right text-xs text-tertiary-foreground" title={r.detail}>
                {r.detail}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PickerSection({
  label,
  aside,
  hint,
  children,
}: {
  label: string;
  aside?: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <span className="flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
        {label}
        {aside && (
          <span className="font-normal tracking-normal normal-case">{aside}</span>
        )}
      </span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      {hint && <p className="text-xs text-tertiary-foreground">{hint}</p>}
    </div>
  );
}

function TextArea({
  id,
  label,
  value,
  onChange,
  hint,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint: string;
  placeholder?: string;
}) {
  const over = value.length > MAX_TEXT;
  return (
    <Field
      label={label}
      htmlFor={id}
      hint={
        <span className={cn(over && "text-destructive")}>
          {hint} {value.length}/{MAX_TEXT}
        </span>
      }
    >
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        maxLength={MAX_TEXT}
        placeholder={placeholder}
        className="w-full resize-y rounded-none border-b border-quaternary bg-input px-4 py-2 text-sm text-foreground outline-none focus:border-foreground"
      />
    </Field>
  );
}

function Dot({ color }: { color?: string }) {
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return null;
  return (
    // The ring keeps a dark dot visible on a selected (black) chip.
    <span
      className="size-2 rounded-full ring-1 ring-white/50"
      style={{ backgroundColor: color }}
      aria-hidden
    />
  );
}
