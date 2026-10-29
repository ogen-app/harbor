// Response shapes of the AI credits tab (CON-435): GET /api/pnl/credits,
// /api/pnl/reconciliation and the Review drawer. Amounts are USD micros, dates
// "YYYY-MM-DD", months "YYYY-MM".

export interface TopUp {
  date: string;
  amountMicros: number;
  receiptId: string;
}

export interface CreditVendor {
  vendorId: string;
  name: string;
  // False until an opening balance and date are entered.
  configured: boolean;
  openingBalanceMicros: number | null;
  openingDate: string | null;
  alertDays: number;
  balanceMicros: number | null;
  // Average over the last 7 full days; null without usage.
  dailyRateMicros: number | null;
  runwayDays: number | null;
  runOutDate: string | null;
  belowAlert: boolean;
  lastTopUp: TopUp | null;
}

export interface CreditAlert {
  vendorId: string;
  name: string;
  runwayDays: number;
  runOutDate: string;
  alertDays: number;
  message: string;
}

export interface Projection {
  from: string;
  startMicros: number;
  rateMicros: number;
  runOutDate: string;
  runwayDays: number;
  alreadyEmpty: boolean;
}

export interface SeriesVendor {
  vendorId: string;
  name: string;
  // One per series day; null before the opening date.
  balances: (number | null)[];
  topUps: TopUp[];
  projection: Projection | null;
}

export interface Credits {
  today: string;
  vendors: CreditVendor[];
  alerts: CreditAlert[];
  series: { from: string; today: string; days: string[]; vendors: SeriesVendor[] };
}

export type ChargeSource = "admin_api" | "billing_export" | "manual";

export type ReconStatus =
  | "open"
  | "not_connected"
  | "awaiting"
  | "awaiting_check"
  | "auto_accepted"
  | "pending_review"
  | "accepted"
  | "dismissed";

export interface ReconRow {
  vendorId: string;
  vendorName: string;
  month: string;
  estimateMicros: number;
  chargedMicros: number | null;
  chargedToDateMicros: number | null;
  diffMicros: number | null;
  // Relative to the estimate.
  diffPct: number | null;
  overThreshold: boolean;
  source: ChargeSource;
  status: ReconStatus;
  adjustmentMicros: number | null;
  note: string;
  reviewedBy: string;
  reviewedAt: string | null;
}

export interface VendorConnection {
  vendorId: string;
  name: string;
  source: ChargeSource;
  connected: boolean;
  lastFetchedAt: string | null;
  error: string;
  hint: string;
}

export interface Reconciliation {
  thresholdPct: number;
  thresholds: number[];
  months: string[];
  rows: ReconRow[];
  vendors: VendorConnection[];
}

export interface ReconDetail {
  row: ReconRow;
  thresholdPct: number;
  hasBreakdown: boolean;
  days: { date: string; estimateMicros: number; chargedMicros: number | null }[];
  models: { model: string; estimateMicros: number; chargedMicros: number | null }[];
  audit: { at: string; actor: string; action: string; status: string; note: string }[];
}

export interface Effect {
  amountMicros: number;
  month: string;
  entries: number;
  summary: string;
}
