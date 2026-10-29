"use client";

import { useMemo } from "react";
import {
  SmartFilterBar,
  type SmartFilterField,
  type SmartFilterToken,
} from "@/components/ui/smart-filter-bar";
import { billingStatusLabel } from "@/components/billing/format";

// ── model ─────────────────────────────────────────────────────────────────────

export type FieldKey =
  | "name"
  | "status"
  | "billing"
  | "spend"
  | "revenue"
  | "margin"
  | "zernio"
  | "tier"
  | "group";

type FilterField = SmartFilterField<FieldKey>;

export type FilterToken = SmartFilterToken<FieldKey>;

// Base field defs. Status options are injected at render time from live data.
const FIELDS: FilterField[] = [
  {
    key: "name",
    label: "Name",
    type: "text",
    operators: ["contains", "does not contain"],
    valuePlaceholder: "tenant name",
  },
  {
    key: "status",
    label: "Status",
    type: "enum",
    operators: ["is", "is not"],
    options: [],
  },
  {
    key: "billing",
    label: "Billing",
    type: "enum",
    operators: ["is", "is not"],
    options: [],
  },
  {
    key: "tier",
    label: "Tier",
    type: "enum",
    operators: ["is", "is not"],
    options: [],
  },
  {
    key: "group",
    label: "Group",
    type: "enum",
    operators: ["includes", "excludes"],
    options: [],
  },
  {
    key: "spend",
    label: "AI spend",
    type: "number",
    operators: ["more than", "less than"],
    valuePrefix: "$",
    valuePlaceholder: "amount in USD",
  },
  // Month to date, from the Harbor ledger (CON-434). Ignored server-side while
  // revenue is unavailable; a tenant without revenue never matches a margin.
  {
    key: "revenue",
    label: "Revenue",
    type: "number",
    operators: ["more than", "less than"],
    valuePrefix: "$",
    valuePlaceholder: "net revenue in USD",
  },
  {
    key: "margin",
    label: "Margin",
    type: "number",
    operators: ["less than", "more than"],
    valuePlaceholder: "percent, e.g. 10",
  },
  {
    key: "zernio",
    label: "Zernio profiles",
    type: "number",
    operators: ["more than", "less than", "equals"],
    valuePlaceholder: "count",
  },
];

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

// How a committed value reads inside a chip.
function displayValue(field: FieldKey, value: string): string {
  if (field === "spend" || field === "revenue") return `$${value}`;
  if (field === "margin") return `${value}%`;
  if (field === "status") return cap(value);
  if (field === "billing") return billingStatusLabel(value);
  return value;
}

// Matching runs server-side (GET /api/tenants?filters=…); this component only
// builds the tokens and hands them up via onTokensChange. The bar itself is the
// shared SmartFilterBar.

// ── component ─────────────────────────────────────────────────────────────────

export function TenantsFilterBar({
  tokens,
  onTokensChange,
  statusOptions,
  billingOptions = [],
  tierOptions = [],
  groupOptions = [],
}: {
  tokens: FilterToken[];
  onTokensChange: (t: FilterToken[]) => void;
  statusOptions: string[];
  billingOptions?: string[];
  tierOptions?: string[];
  groupOptions?: string[];
}) {
  // Inject live options into the enum fields (status / tier / group). Status
  // is a lowercase enum, so it reads better capitalized; tier/group names are
  // proper catalog labels — shown verbatim. Typed text matches the raw value.
  const fields = useMemo(
    () =>
      FIELDS.map((f): FilterField => {
        const shown = (v: string) => displayValue(f.key, v);
        const base = { ...f, displayValue: shown, matchOn: "value" as const };
        if (f.key === "status") return { ...base, options: statusOptions, optionLabel: shown };
        if (f.key === "billing") return { ...base, options: billingOptions, optionLabel: shown };
        if (f.key === "tier") return { ...base, options: tierOptions };
        if (f.key === "group") return { ...base, options: groupOptions };
        return base;
      }),
    [statusOptions, billingOptions, tierOptions, groupOptions],
  );

  return (
    <SmartFilterBar
      fields={fields}
      tokens={tokens}
      onTokensChange={onTokensChange}
      emptyPlaceholder="Filter by name, status, tier, group, AI spend, margin…"
    />
  );
}
