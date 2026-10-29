// Wire types for /api/pnl/* (CON-420), mirroring the Go handlers. Money is USD
// micros (1 USD = 1_000_000) unless a field says otherwise; dates are
// YYYY-MM-DD (UTC), months YYYY-MM, instants RFC 3339.

export type Direction = "revenue" | "tax" | "fee" | "refund" | "expense" | "prepayment";
export type Source = "receipt" | "token_pipeline" | "billing_v1" | "receipt_extraction";

export type VendorCategory = "ai" | "infra" | "email" | "domains" | "social" | "revenue";

export interface Vendor {
  id: string;
  name: string;
  category: VendorCategory;
  isAiPipeline: boolean;
}

export interface Effect {
  amountMicros: number;
  month: string;
  entries: number;
  summary: string;
}

export type CheckKey =
  | "forwarder"
  | "vendor"
  | "lines"
  | "totals"
  | "currency"
  | "duplicate"
  | "amount"
  | "date";

export interface Check {
  key: CheckKey;
  ok: boolean;
  label: string;
  detail: string;
}

// ── status ───────────────────────────────────────────────────────────────────

export type SyncState = "ok" | "stale" | "unavailable";

export interface PnlStatus {
  aiUsage: { state: SyncState; throughDate: string | null; lastRunAt: string | null; error: string };
  revenue: { state: SyncState; testMode: boolean; lastSyncAt: string | null; error: string };
  receipts: {
    inboxAddress: string;
    lastReceivedAt: string | null;
    pendingEmails: number;
    everReceived: boolean;
  };
  attention: { open: number; openAmountMicros: number; rejected: number };
}

// ── summary ──────────────────────────────────────────────────────────────────

export interface Period {
  from: string;
  to: string;
  label: string;
}

export interface Comparable {
  value: number | null;
  previous: number | null;
}

export interface PnlSummary {
  period: Period;
  compare: Period;
  netRevenue: Comparable;
  expenses: { value: number; previous: number };
  profit: Comparable;
  marginPct: Comparable;
  prepaidCredits: { value: number; previous: number };
  provisional: { count: number; amountMicros: number; month: string } | null;
  asOf: string;
}

// ── monthly ──────────────────────────────────────────────────────────────────

export interface Provenance {
  rows: number;
  models: number;
  tenants: number;
  receipts: number;
  payments: number;
}

export interface Drill {
  from: string;
  to: string;
  vendor?: string;
  direction?: Direction[];
  source?: Source[];
}

export interface Cell {
  value: number | null;
  unavailable: boolean;
  pending: { count: number; amountMicros: number } | null;
  provenance: Provenance;
  drill: Drill | null;
}

export interface MonthlyRow {
  key: string;
  section: "revenue" | "expenses" | "profit" | "memo";
  label: string;
  sourceLabel: string;
  kind: "line" | "total" | "margin";
  vendorId: string;
  cells: Cell[];
  total: Cell;
}

export interface PnlMonthly {
  months: string[];
  revenueAvailable: boolean;
  revenueError: string;
  rows: MonthlyRow[];
  provisional: { month: string; count: number; amountMicros: number }[];
}

// ── daily (CON-431) ──────────────────────────────────────────────────────────

export interface DailyTotals {
  netRevenue: number | null;
  expenses: number;
  profit: number | null;
}

export interface PnlDaily {
  month: string;
  period: Period;
  compare: Period;
  revenueAvailable: boolean;
  revenueError: string;
  testMode: boolean;
  // Expense vendors with spend this month, in P&L order (AI first).
  vendors: { id: string; name: string; isAiPipeline: boolean }[];
  days: {
    date: string;
    netRevenue: number | null;
    expenses: number;
    expensesByVendor: Record<string, number>;
    receipts: { vendorId: string; count: number; amountMicros: number }[];
  }[];
  totals: DailyTotals;
  previous: DailyTotals;
  provisional: { month: string; count: number; amountMicros: number } | null;
}

// ── ledger ───────────────────────────────────────────────────────────────────

export interface LedgerRow {
  key: string;
  kind: "ai_group" | "receipt" | "entry";
  bookedDate: string;
  vendorId: string;
  vendorName: string;
  description: string;
  source: Source;
  direction: Direction;
  amountMicros: number;
  currency: string;
  originalAmountMicros: number;
  fxRate: number | null;
  entries: number;
  expandable: boolean;
  receiptId: string;
  tenantId: string;
  tenantName: string;
  model: string;
  invoiceNumber: string;
  testMode: boolean;
}

export interface LedgerResponse {
  rows: LedgerRow[];
  nextCursor: string;
  totals: { rows: number; entries: number; amountMicros: number };
  pendingAttention: { count: number; amountMicros: number };
}

export interface LedgerChild {
  id: string;
  description: string;
  model: string;
  tenantId: string;
  tenantName: string;
  amountMicros: number;
  direction: Direction;
}

// ── receipts ─────────────────────────────────────────────────────────────────

export type ReceiptStatus = "parsed" | "needs_attention" | "approved" | "rejected" | "voided";
export type ReceiptKind = "invoice" | "receipt" | "prepayment" | "refund" | "credit_note" | "unknown";

export interface ReceiptLine {
  description: string;
  quantityMicros: number | null;
  unitPriceMicros: number | null;
  amountMicros: number | null;
}

export interface Receipt {
  id: string;
  status: ReceiptStatus;
  vendorId: string;
  vendorName: string;
  merchantName: string;
  invoiceNumber: string;
  kind: ReceiptKind;
  issueDate: string | null;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  bookedMonth: string;
  bookingReason: string;
  currency: string;
  subtotalMicros: number | null;
  taxMicros: number | null;
  totalMicros: number | null;
  fxRate: number | null;
  suggestedFxRate: number | null;
  totalUsdMicros: number | null;
  lines: ReceiptLine[];
  checks: Check[];
  attentionReason: string;
  attentionDetail: string;
  rejectedReason: string;
  edited: boolean;
  receivedAt: string;
  forwardedBy: string;
  from: string;
  subject: string;
  rejectedAt: string | null;
  purgeAt: string | null;
  voidedAt: string | null;
}

export interface Email {
  id: string;
  subject: string;
  from: string;
  forwardedFrom: string;
  to: string[];
  date: string | null;
  messageId: string;
  textBody: string;
  htmlBody: string;
  receivedAt: string;
}

export interface ReceiptDetail {
  receipt: Receipt;
  email: Email | null;
  attachments: {
    id: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    stored: boolean;
  }[];
  extractions: {
    id: string;
    version: number;
    modelId: string;
    promptVersion: string;
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
    createdAt: string;
    confidenceNotes: string;
    current: boolean;
  }[];
  entries: {
    id: string;
    description: string;
    direction: Direction;
    amountMicros: number;
    bookedDate: string;
    voidedAt: string | null;
  }[];
  history: { at: string; actor: string; action: string; summary: string }[];
}

export interface ReceiptMutation {
  receipt: Receipt;
  effect: Effect;
}

export type ReceiptPatch = Partial<
  Pick<
    Receipt,
    | "vendorId"
    | "invoiceNumber"
    | "kind"
    | "issueDate"
    | "servicePeriodStart"
    | "servicePeriodEnd"
    | "currency"
    | "fxRate"
    | "subtotalMicros"
    | "taxMicros"
    | "totalMicros"
    | "lines"
  >
>;

// ── attention ────────────────────────────────────────────────────────────────

export interface AttentionItem {
  kind: "receipt" | "email";
  id: string;
  receivedAt: string;
  subject: string;
  from: string;
  totalMicros: number | null;
  currency: string;
  reason: string;
  reasonLabel: string;
  detail: string;
  nextStep: string;
  rejectedReason: string;
  purgeAt: string | null;
}

export interface AttentionResponse {
  open: AttentionItem[];
  rejected: AttentionItem[];
}

// ── shared cost allocation (CON-432) ─────────────────────────────────────────

export type AllocationRule = "even" | "ai_cost" | "active_users" | "posts" | "emails" | "none";
export type AllocationDriver = "active_tenants" | "ai_cost" | "active_users" | "posts" | "emails";

export interface AllocationRuleOption {
  key: AllocationRule;
  label: string;
  driver: AllocationDriver | "";
}

export interface AllocationPreview {
  available: boolean;
  driver: AllocationDriver | "";
  fallback: boolean;
  tenantQuantity: number;
  driverTotal: number;
  driverTenants: number;
  shareMicros: number;
}

export interface AllocationVendor {
  vendorId: string;
  name: string;
  category: VendorCategory;
  rule: AllocationRule;
  billMicros: number;
  pending: boolean;
  stored: {
    rule: AllocationRule;
    fallback: boolean;
    shareMicros: number;
    computedAt: string;
    stale: boolean;
  } | null;
  previews: Record<AllocationRule, AllocationPreview>;
}

export interface RuleChange {
  vendorId: string;
  from: AllocationRule;
  to: AllocationRule;
}

export interface AllocationView {
  month: string;
  tenantId: string;
  tenants: { id: string; name: string; shareMicros: number }[];
  rules: AllocationRuleOption[];
  vendors: AllocationVendor[];
  changes: { at: string; actor: string; changes: RuleChange[]; from: string; to: string }[];
  shareMicros: number;
}

export interface RulesSaved {
  months: string[];
  changes: RuleChange[];
  skipped: string[];
  summary: string;
}
