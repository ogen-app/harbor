// Shared chart maths and money formatting for the revision-2 chart style
// (CON-413). Values are whole USD here; callers divide micros first.

export const MINUS = "−";

export interface Scale {
  min: number;
  max: number;
  ticks: number[];
}

const STEPS = [1, 2, 2.5, 5, 10];

// niceScale picks a rounded axis that always includes 0 and reaches below it
// when a value is negative, with about `target` evenly spaced steps.
export function niceScale(lo: number, hi: number, target = 5): Scale {
  const a = Math.min(0, lo);
  const b = Math.max(0, hi);
  if (a === 0 && b === 0) return { min: 0, max: 1, ticks: [0, 0.5, 1] };
  const rough = (b - a) / target;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = (STEPS.find((s) => s * mag >= rough) ?? 10) * mag;
  const min = Math.floor(a / step) * step;
  const max = Math.ceil(b / step) * step;
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return { min, max, ticks };
}

// linear maps a domain value onto a pixel range.
export function linear(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return (v: number) => r0 + (v - d0) * k;
}

function sign(v: number, signed: boolean): string {
  if (v < 0) return MINUS;
  return signed && v > 0 ? "+" : "";
}

// axisUSD: "$2.5k", "$2k", "$500", "−$500", "$0".
export function axisUSD(v: number): string {
  const abs = Math.abs(v);
  const body = abs >= 1000 ? `${Number((abs / 1000).toFixed(2))}k` : `${Number(abs.toFixed(2))}`;
  return `${sign(v, false)}$${body}`;
}

// compactUSD: value labels, "$2.45k", "$612", "+$1.07k", "−$136".
export function compactUSD(v: number, signed = false): string {
  const abs = Math.abs(v);
  if (abs >= 1000) return `${sign(v, signed)}$${(abs / 1000).toFixed(2)}k`;
  const whole = Math.round(v);
  return `${sign(whole, signed)}$${Math.abs(whole)}`;
}
