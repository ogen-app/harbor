import type { Direction, Source } from "./types";

// Presentation helpers for the /pnl page (CON-420). Every figure is USD micros
// unless a helper says otherwise; every date is a UTC calendar date, so they
// are parsed and printed in UTC to keep "Oct 1" from becoming "Sep 30" west of
// Greenwich.

const MICROS = 1_000_000;
// U+2212, the typographic minus: same width as "+" in tabular figures.
export const MINUS = "−";

const usdFmt = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// usd renders micros as "$1,234.56"; negatives read "−$1,234.56". With
// sign="always" positives get a "+" (profit, change).
export function usd(micros: number, sign: "auto" | "always" = "auto"): string {
  // A non-zero amount under half a cent (one receipt reading costs ~$0.004)
  // would round to "$0.00" and read as free.
  if (micros !== 0 && Math.abs(micros) < MICROS / 200) {
    return `${micros < 0 ? MINUS : sign === "always" ? "+" : ""}<$0.01`;
  }
  const abs = usdFmt.format(Math.abs(micros) / MICROS);
  if (micros < 0) return `${MINUS}$${abs}`;
  if (sign === "always" && micros > 0) return `+$${abs}`;
  return `$${abs}`;
}

// cash turns a stored ledger amount into its cash effect for display. The books
// store expenses and prepayments positive (fees, tax and refunds are already
// negative, deductions from revenue), but the ledger reads as money in (+) and
// money out (−), so a vendor credit note shows as +.
export function cash(direction: Direction, micros: number): number {
  return direction === "expense" || direction === "prepayment" ? -micros : micros;
}

// money renders micros of any currency, e.g. "€20.88" or "20.88 CHF" when Intl
// does not know the code. An empty currency prints the bare figure.
export function money(micros: number, currency: string): string {
  const cur = (currency || "").toUpperCase();
  if (!cur) return usdFmt.format(micros / MICROS).replace("-", MINUS);
  if (cur === "USD") return usd(micros);
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: cur })
      .format(micros / MICROS)
      .replace("-", MINUS);
  } catch {
    return `${usdFmt.format(micros / MICROS)} ${cur}`.replace("-", MINUS);
  }
}

// parseMoney reads a typed amount ("19.80", "$1,000") into micros, or null.
export function parseMoney(text: string): number | null {
  const clean = text.replace(/[$,\s]/g, "").replace(MINUS, "-");
  if (clean === "" || clean === "-") return null;
  const n = Number(clean);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * MICROS);
}

// microsToInput renders micros for an editable field ("19.80").
export function microsToInput(micros: number | null): string {
  if (micros == null) return "";
  return (micros / MICROS).toFixed(2);
}

export function pct(value: number, digits = 1): string {
  const s = Math.abs(value).toFixed(digits);
  return value < 0 ? `${MINUS}${s}%` : `${s}%`;
}

// ── dates (UTC) ──────────────────────────────────────────────────────────────

export function parseDate(iso: string): Date {
  // "YYYY-MM-DD" → UTC midnight; "YYYY-MM" → the 1st.
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function isoMonth(d: Date): string {
  return d.toISOString().slice(0, 7);
}

export function todayUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// "2026-10" → "Oct 2026"
export function monthLabel(month: string): string {
  if (!month) return "";
  const d = parseDate(month);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// "2026-10" → "October 2026"
export function monthLong(month: string): string {
  if (!month) return "";
  const d = parseDate(month);
  return `${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function monthName(d: Date): string {
  return MONTHS_LONG[d.getUTCMonth()];
}

export function monthShort(d: Date): string {
  return MONTHS[d.getUTCMonth()];
}

// "2026-10-26" → "Oct 26"
export function dayLabel(date: string | null | undefined): string {
  if (!date) return "—";
  const d = parseDate(date);
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, "0")}`;
}

// "2026-10-26" → "Oct 26, 2026"
export function dateLong(date: string | null | undefined): string {
  if (!date) return "—";
  const d = parseDate(date);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// An RFC 3339 instant → "Oct 27, 09:14" in the viewer's zone.
export function instantLabel(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

// "2 min ago", "3 h ago", "Oct 2".
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "never";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return instantLabel(iso);
}

// Month of a date string, "2026-10-26" → "2026-10".
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

// Last day of a month, "2026-02" → "2026-02-28".
export function monthEnd(month: string): string {
  const d = parseDate(month);
  return isoDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

// ── vocabulary ───────────────────────────────────────────────────────────────

// Plain language for ops staff (Appendix A.1.4): never the raw source names.
export const SOURCE_LABEL: Record<Source, string> = {
  receipt: "Receipts",
  token_pipeline: "AI usage",
  billing_v1: "Payments",
  receipt_extraction: "Receipt reading",
  reconciliation: "Reconciliation",
};

export const DIRECTION_LABEL: Record<Direction, string> = {
  revenue: "revenue",
  tax: "tax",
  fee: "fee",
  refund: "refund",
  expense: "expense",
  prepayment: "prepayment",
};

export const CATEGORY_LABEL: Record<string, string> = {
  ai: "AI",
  infra: "Infra",
  email: "Email",
  domains: "Domains",
  social: "Social",
  revenue: "Revenue",
};

export const DIRECTIONS: Direction[] = ["revenue", "fee", "tax", "refund", "expense", "prepayment"];
export const SOURCES: Source[] = ["billing_v1", "token_pipeline", "receipt", "receipt_extraction", "reconciliation"];

// ── fetch ────────────────────────────────────────────────────────────────────

// errorText pulls Fiber's {error} message out of a failed response.
export async function errorText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error || `Request failed (${res.status})`;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
  }
}

// api performs a JSON request and throws HttpError (with the parsed body, so a
// 422 can hand back its failing checks) on a non-2xx.
export async function api<T>(
  url: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    ...rest,
    headers: json !== undefined ? { "Content-Type": "application/json", ...rest.headers } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new HttpError(body?.error || `Request failed (${res.status})`, res.status, body);
  }
  return (await res.json()) as T;
}
