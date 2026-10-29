// Fixed chart colours (CON-413 revision 2). A vendor keeps its colour on every
// chart; vendors an operator added get neutral greys in the order they appear.

export const SERIES = {
  netRevenue: "#84BB4C",
  profit: "#5B5EA6",
  expenses: "#E07A5F",
  // Area fills: the line colours at ~15% on white, opaque so areas can overlap.
  netRevenueTint: "#EBF4E2",
  expensesTint: "#FBECE9",
} as const;

// Light text colours for figures on the inverted tooltip.
export const TOOLTIP_TONE = {
  positive: "#9BD27A",
  negative: "#F4A3A3",
} as const;

const VENDOR: Record<string, string> = {
  anthropic: "#F2A86F",
  google: "#509EE3",
  railway: "#A989C5",
  resend: "#F4CF5A",
  cloudflare: "#EF8C8C",
  zernio: "#7CCFCF",
};

const GREYS = ["#A39E97", "#C4BFB8", "#86817A", "#D6D1CA", "#6E6963"];

// vendorColors assigns every id its colour: the fixed one, else the next grey.
export function vendorColors(ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  let grey = 0;
  for (const id of ids) {
    out.set(id, VENDOR[id] ?? GREYS[grey++ % GREYS.length]);
  }
  return out;
}
