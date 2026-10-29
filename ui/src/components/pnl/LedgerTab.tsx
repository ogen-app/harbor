"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import {
  SmartFilterBar,
  type SmartFilterField,
  type SmartFilterToken,
} from "@/components/ui/smart-filter-bar";
import { DateRangePicker, formatRangeShort, type DateRange } from "@/components/ui/date-range-picker";
import { Button } from "@/components/ui/button";
import { useRowKeyboardNav } from "@/lib/useRowKeyboardNav";
import { cn } from "@/lib/utils";
import { DIRECTIONS, SOURCES, SOURCE_LABEL, api, cash, dayLabel, money, parseMoney, usd } from "./format";
import { EmptyInbox } from "./EmptyInbox";
import { ErrorLine, KeyHint, PendingBanner, SkeletonBar, TypePill, pendingSentence } from "./shared";
import type {
  Direction,
  Drill,
  LedgerChild,
  LedgerResponse,
  LedgerRow,
  PnlStatus,
  Source,
  Vendor,
} from "./types";

// LedgerTab is tab 2 (CON-412 mockup 2): every entry behind the P&L. AI usage is
// grouped per vendor per day and expands to model × tenant; receipts are one row
// that expands to their lines; payments and receipt reading are single rows.
// Filtering is the shared smart filter; j/k move, ↵ opens the receipt, e expands.

export type LedgerFieldKey =
  | "vendor"
  | "type"
  | "source"
  | "tenant"
  | "model"
  | "amount"
  | "invoice"
  | "description";

export type LedgerToken = SmartFilterToken<LedgerFieldKey>;

// drillToTokens turns a P&L cell's drill filter into smart-filter chips.
export function drillToTokens(d: Drill): LedgerToken[] {
  const out: LedgerToken[] = [];
  if (d.vendor) out.push({ field: "vendor", operator: "is", value: d.vendor });
  d.direction?.forEach((v) => out.push({ field: "type", operator: "is", value: v }));
  d.source?.forEach((v) => out.push({ field: "source", operator: "is", value: v }));
  if (d.tenant) out.push({ field: "tenant", operator: "is", value: d.tenant });
  return out;
}

// drillHref links a drill from outside /pnl (the tenant Profit & loss tab) to
// the Ledger filtered to its entries; drillFromSearch reads it back.
export function drillHref(d: Drill): string {
  const q = new URLSearchParams({ tab: "ledger", from: d.from, to: d.to });
  if (d.vendor) q.set("vendor", d.vendor);
  d.direction?.forEach((v) => q.append("type", v));
  d.source?.forEach((v) => q.append("source", v));
  if (d.tenant) q.set("tenant", d.tenant);
  return `/pnl?${q}`;
}

export function drillFromSearch(q: URLSearchParams): Drill | null {
  const from = q.get("from");
  const to = q.get("to");
  if (!from || !to) return null;
  return {
    from,
    to,
    vendor: q.get("vendor") ?? undefined,
    direction: q.getAll("type").filter((v): v is Direction => (DIRECTIONS as string[]).includes(v)),
    source: q.getAll("source").filter((v): v is Source => (SOURCES as string[]).includes(v)),
    tenant: q.get("tenant") ?? undefined,
  };
}

// filterQuery maps chips to the ledger's query parameters. Repeated "is" chips
// of one field are alternatives (OR); "is not" chips each exclude.
function filterQuery(tokens: LedgerToken[], range: DateRange): URLSearchParams {
  const q = new URLSearchParams({ from: range.from, to: range.to });
  for (const t of tokens) {
    const not = t.operator === "is not";
    switch (t.field) {
      case "vendor":
      case "type":
      case "source":
        q.append(not ? `not_${t.field}` : t.field, t.value);
        break;
      case "tenant":
      case "model":
      case "invoice":
        q.append(t.field, t.value);
        break;
      case "description":
        q.append("q", t.value);
        break;
      case "amount": {
        const micros = parseMoney(t.value);
        if (micros != null) q.append(t.operator === "more than" ? "amount_min" : "amount_max", String(micros));
        break;
      }
    }
  }
  return q;
}

const PAGE = 50;
const CHILDREN_SHOWN = 6;

export function LedgerTab({
  status,
  range,
  onRangeChange,
  tokens,
  onTokensChange,
  version,
  onOpenReceipt,
  onReviewAttention,
}: {
  status: PnlStatus | null;
  range: DateRange;
  onRangeChange: (r: DateRange) => void;
  tokens: LedgerToken[];
  onTokensChange: (t: LedgerToken[]) => void;
  version: number;
  onOpenReceipt: (id: string) => void;
  onReviewAttention: () => void;
}) {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [data, setData] = useState<LedgerResponse | null>(null);
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, ChildState>>({});
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<{ vendors: Vendor[] }>("/api/pnl/vendors", { signal: controller.signal })
      .then((j) => setVendors(j.vendors))
      .catch(() => {});
    return () => controller.abort();
  }, [version]);

  const query = useMemo(() => filterQuery(tokens, range), [tokens, range]);

  useEffect(() => {
    const controller = new AbortController();
    /* eslint-disable react-hooks/set-state-in-effect */
    setLoading(true);
    setExpanded({});
    /* eslint-enable react-hooks/set-state-in-effect */
    const q = new URLSearchParams(query);
    q.set("limit", String(PAGE));
    api<LedgerResponse>(`/api/pnl/ledger?${q}`, { signal: controller.signal })
      .then((j) => {
        setData(j);
        setRows(j.rows);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "The ledger could not be loaded");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [query, version]);

  // A page belongs to the query that asked for it: when the filters or range
  // change (or the ledger reloads) while it is in flight, it is aborted and
  // dropped rather than appended to the new results.
  const activeQuery = useRef(query);
  const moreController = useRef<AbortController | null>(null);
  useEffect(() => {
    activeQuery.current = query;
    moreController.current?.abort();
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setLoadingMore(false);
  }, [query, version]);

  const loadMore = () => {
    if (!data?.nextCursor) return;
    moreController.current?.abort();
    const controller = new AbortController();
    moreController.current = controller;
    const issuedFor = query;
    setLoadingMore(true);
    const q = new URLSearchParams(query);
    q.set("limit", String(PAGE));
    q.set("cursor", data.nextCursor);
    const current = () => !controller.signal.aborted && activeQuery.current === issuedFor;
    api<LedgerResponse>(`/api/pnl/ledger?${q}`, { signal: controller.signal })
      .then((j) => {
        if (!current()) return;
        setData(j);
        setRows((r) => [...r, ...j.rows]);
      })
      .catch((e: unknown) => {
        if (current()) setError(e instanceof Error ? e.message : "Loading more failed");
      })
      .finally(() => {
        if (current()) setLoadingMore(false);
      });
  };

  const toggle = useCallback(
    (row: LedgerRow) => {
      if (!row.expandable) return;
      setExpanded((prev) => {
        if (prev[row.key]) {
          const next = { ...prev };
          delete next[row.key];
          return next;
        }
        return { ...prev, [row.key]: { loading: true, rows: [], showAll: false, error: null } };
      });
      if (expanded[row.key]) return;
      const q = new URLSearchParams(query);
      q.set("key", row.key);
      api<{ rows: LedgerChild[] }>(`/api/pnl/ledger/children?${q}`)
        .then((j) =>
          setExpanded((prev) =>
            prev[row.key] ? { ...prev, [row.key]: { ...prev[row.key], loading: false, rows: j.rows } } : prev,
          ),
        )
        .catch((e: unknown) =>
          setExpanded((prev) =>
            prev[row.key]
              ? {
                  ...prev,
                  [row.key]: {
                    ...prev[row.key],
                    loading: false,
                    error: e instanceof Error ? e.message : "Could not load the entries",
                  },
                }
              : prev,
          ),
        );
    },
    [expanded, query],
  );

  const open = useCallback(
    (i: number) => {
      const row = rows[i];
      if (!row) return;
      if (row.receiptId) onOpenReceipt(row.receiptId);
      else toggle(row);
    },
    [rows, onOpenReceipt, toggle],
  );

  const { activeIndex, setActiveIndex, containerRef } = useRowKeyboardNav({ count: rows.length, onOpen: open });

  // "e" expands or collapses the highlighted row.
  const latest = useRef({ rows, activeIndex, toggle });
  useEffect(() => {
    latest.current = { rows, activeIndex, toggle };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "e" || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          target.closest?.('input, textarea, select, [role="combobox"], [role="dialog"], [role="listbox"], [role="menu"]'))
      ) {
        return;
      }
      const { rows, activeIndex, toggle } = latest.current;
      const row = rows[activeIndex];
      if (row?.expandable) {
        e.preventDefault();
        toggle(row);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const fields = useMemo<SmartFilterField<LedgerFieldKey>[]>(() => {
    const vendorName = new Map(vendors.map((v) => [v.id, v.name]));
    return [
      {
        key: "vendor",
        label: "Vendor",
        type: "enum",
        operators: ["is", "is not"],
        options: vendors.map((v) => v.id),
        optionLabel: (id) => vendorName.get(id) ?? id,
        displayValue: (id) => vendorName.get(id) ?? id,
      },
      {
        key: "type",
        label: "Type",
        type: "enum",
        operators: ["is", "is not"],
        options: DIRECTIONS,
      },
      {
        key: "source",
        label: "Source",
        type: "enum",
        operators: ["is", "is not"],
        options: SOURCES,
        optionLabel: (s) => SOURCE_LABEL[s as keyof typeof SOURCE_LABEL] ?? s,
        displayValue: (s) => SOURCE_LABEL[s as keyof typeof SOURCE_LABEL] ?? s,
      },
      { key: "tenant", label: "Tenant", type: "text", operators: ["is"], valuePlaceholder: "tenant id" },
      { key: "model", label: "Model", type: "text", operators: ["is"], valuePlaceholder: "model id" },
      {
        key: "amount",
        label: "Amount",
        type: "number",
        operators: ["more than", "less than"],
        valuePrefix: "$",
        valuePlaceholder: "amount in USD",
        displayValue: (v) => `$${v}`,
      },
      { key: "invoice", label: "Invoice #", type: "text", operators: ["contains"], valuePlaceholder: "invoice number" },
      {
        key: "description",
        label: "Description",
        type: "text",
        operators: ["contains"],
        valuePlaceholder: "words in the description",
      },
    ];
  }, [vendors]);

  const filtered = tokens.length > 0;
  const pending = data?.pendingAttention;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <SmartFilterBar
          className="min-w-[320px] flex-1"
          fields={fields}
          tokens={tokens}
          onTokensChange={onTokensChange}
          inputRef={filterRef}
          emptyPlaceholder="Filter by vendor, type, source, tenant, model, amount…"
        />
        <DateRangePicker value={range} onChange={(r) => onRangeChange(r)} className="h-[42px]" />
      </div>

      {pending && pending.count > 0 && (
        <PendingBanner onReview={onReviewAttention}>
          {pendingSentence(pending.count, pending.amountMicros)} {pending.count === 1 ? "is" : "are"} waiting in Needs
          attention and {pending.count === 1 ? "isn’t" : "aren’t"} in the ledger yet.
        </PendingBanner>
      )}

      <section className="overflow-hidden rounded-[3px] border border-border bg-primary">
        {error ? (
          <div className="px-6 py-5">
            <ErrorLine>{error}</ErrorLine>
          </div>
        ) : !loading && rows.length === 0 ? (
          filtered ? (
            <div className="flex flex-col items-center gap-3 px-6 py-12 text-center text-[13px]">
              <p className="text-[15px] font-medium">No entries match these filters</p>
              <p className="text-secondary-foreground">{formatRangeShort(range)}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => onTokensChange([])}>
                Clear filters
              </Button>
            </div>
          ) : (
            <EmptyInbox status={status} title={`No entries for ${formatRangeShort(range)}`} />
          )
        ) : (
          <div ref={containerRef} className="overflow-x-auto">
            <table className="w-full min-w-[960px] table-fixed border-collapse text-[13px]">
              <colgroup>
                <col className="w-9" />
                <col className="w-24" />
                <col className="w-36" />
                <col />
                <col className="w-36" />
                <col className="w-32" />
                <col className="w-28" />
                <col className="w-36" />
              </colgroup>
              <thead>
                <tr className="h-[34px] bg-table-header text-left text-[11px] uppercase tracking-[0.06em] text-secondary-foreground">
                  <th scope="col">
                    <span className="sr-only">Expand</span>
                  </th>
                  <th scope="col" className="px-3 font-medium">
                    Booked
                  </th>
                  <th scope="col" className="px-3 font-medium">
                    Vendor
                  </th>
                  <th scope="col" className="px-3 font-medium">
                    Description
                  </th>
                  <th scope="col" className="px-3 font-medium">
                    Tenant
                  </th>
                  <th scope="col" className="px-3 font-medium">
                    Source
                  </th>
                  <th scope="col" className="px-3 font-medium">
                    Type
                  </th>
                  <th scope="col" className="px-3 pr-6 text-right font-medium">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody className={cn(loading && "opacity-60")}>
                {loading && rows.length === 0
                  ? Array.from({ length: 12 }, (_, i) => (
                      <tr key={i} className="h-9 border-t border-border">
                        <td />
                        {["w-12", "w-20", "w-48", "w-16", "w-16", "w-14"].map((w, j) => (
                          <td key={j} className="px-3">
                            <SkeletonBar className={w} />
                          </td>
                        ))}
                        <td className="px-3 pr-6">
                          <SkeletonBar className="ml-auto w-16" />
                        </td>
                      </tr>
                    ))
                  : rows.map((row, i) => (
                      <Fragment key={row.key}>
                        <LedgerRowView
                          row={row}
                          index={i}
                          active={i === activeIndex}
                          expanded={!!expanded[row.key]}
                          onToggle={() => toggle(row)}
                          onSelect={() => setActiveIndex(i)}
                          onOpen={() => open(i)}
                        />
                        {expanded[row.key] && (
                          <ChildRows
                            row={row}
                            state={expanded[row.key]}
                            onShowAll={() =>
                              setExpanded((prev) => ({ ...prev, [row.key]: { ...prev[row.key], showAll: true } }))
                            }
                          />
                        )}
                      </Fragment>
                    ))}
              </tbody>
            </table>
            {data?.nextCursor && (
              <div className="flex justify-center border-t border-border py-3">
                <Button type="button" variant="ghost" size="sm" disabled={loadingMore} onClick={loadMore}>
                  {loadingMore ? "Loading…" : "Load more"}
                </Button>
              </div>
            )}
          </div>
        )}

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-6 py-3 text-xs text-secondary-foreground">
          <span className="tabular-nums">
            {formatRangeShort(range)}
            {filtered && ` · ${tokens.length} filter${tokens.length === 1 ? "" : "s"}`}
            {data &&
              ` · ${data.totals.rows.toLocaleString("en-US")} rows · ${data.totals.entries.toLocaleString("en-US")} entries`}
          </span>
          <span className="flex flex-wrap gap-4">
            <KeyHint keys={["/"]} label="filter" />
            <KeyHint keys={["j", "k"]} label="move" />
            <KeyHint keys={["↵"]} label="open" />
            <KeyHint keys={["e"]} label="expand" />
          </span>
        </footer>
      </section>
    </div>
  );
}

type ChildState = { loading: boolean; rows: LedgerChild[]; showAll: boolean; error: string | null };

function LedgerRowView({
  row,
  index,
  active,
  expanded,
  onToggle,
  onSelect,
  onOpen,
}: {
  row: LedgerRow;
  index: number;
  active: boolean;
  expanded: boolean;
  onToggle: () => void;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const foreign = row.currency && row.currency.toUpperCase() !== "USD";
  return (
    <tr
      data-row-index={index}
      onClick={() => {
        onSelect();
        onOpen();
      }}
      className={cn(
        "h-9 cursor-pointer border-t border-border",
        active
          ? "bg-secondary outline outline-1 -outline-offset-1 outline-foreground"
          : "hover:bg-table-row-hover",
        expanded && !active && "bg-secondary",
      )}
    >
      <td className="pl-3">
        {row.expandable && (
          <button
            type="button"
            aria-label={expanded ? "Collapse" : "Expand"}
            aria-expanded={expanded}
            onClick={(e) => {
              e.stopPropagation();
              onSelect();
              onToggle();
            }}
            className="flex size-6 items-center justify-center rounded-[3px] text-secondary-foreground hover:bg-quaternary hover:text-foreground"
          >
            {expanded ? <CaretDownIcon className="size-3.5" weight="bold" /> : <CaretRightIcon className="size-3.5" weight="bold" />}
          </button>
        )}
      </td>
      <td className="px-3 whitespace-nowrap tabular-nums text-secondary-foreground">{dayLabel(row.bookedDate)}</td>
      <td className="truncate px-3 font-medium">{row.vendorName || "—"}</td>
      <td className="truncate px-3" title={row.description}>
        {row.description}
        {row.testMode && <span className="ml-2 text-xs text-amber-900">test mode</span>}
      </td>
      <td className="truncate px-3 text-secondary-foreground">{row.tenantName || row.tenantId || ""}</td>
      <td className="px-3 whitespace-nowrap text-secondary-foreground">{SOURCE_LABEL[row.source] ?? row.source}</td>
      <td className="px-3">
        <TypePill direction={row.direction} />
      </td>
      <td className="px-3 pr-6 text-right whitespace-nowrap tabular-nums">
        {usd(cash(row.direction, row.amountMicros), "always")}
        {foreign && (
          <span className="block text-[11px] leading-3 text-secondary-foreground">
            {money(row.originalAmountMicros, row.currency)}
            {row.fxRate != null && ` at ${row.fxRate}`}
          </span>
        )}
      </td>
    </tr>
  );
}

function ChildRows({
  row,
  state,
  onShowAll,
}: {
  row: LedgerRow;
  state: ChildState;
  onShowAll: () => void;
}) {
  if (state.loading) {
    return (
      <tr className="h-9 bg-secondary">
        <td colSpan={3} />
        <td colSpan={5} className="px-3 text-secondary-foreground">
          Loading entries…
        </td>
      </tr>
    );
  }
  if (state.error) {
    return (
      <tr className="h-9 bg-secondary">
        <td colSpan={3} />
        <td colSpan={5} className="px-3 text-red-800">
          {state.error}
        </td>
      </tr>
    );
  }
  const shown = state.showAll ? state.rows : state.rows.slice(0, CHILDREN_SHOWN);
  const more = state.rows.length - shown.length;
  return (
    <>
      {shown.map((c) => (
        <tr key={c.id} className="h-9 border-t border-border/60 bg-secondary">
          <td colSpan={3} />
          <td className="truncate px-3 pl-8 text-secondary-foreground" title={c.description}>
            {c.model || c.description}
          </td>
          <td className="truncate px-3 text-secondary-foreground">{c.tenantName || c.tenantId || "—"}</td>
          <td />
          <td />
          <td className="px-3 pr-6 text-right tabular-nums text-secondary-foreground">{usd(cash(c.direction, c.amountMicros), "always")}</td>
        </tr>
      ))}
      {more > 0 && (
        <tr className="h-9 border-t border-border/60 bg-secondary">
          <td colSpan={8} className="text-center">
            <button
              type="button"
              onClick={onShowAll}
              className="text-[13px] text-[var(--editable)] underline-offset-2 hover:underline"
            >
              {more} more {row.key.startsWith("ai:") ? "tenants" : row.key.startsWith("reading:") ? "receipts" : "lines"} →
            </button>
          </td>
        </tr>
      )}
    </>
  );
}
