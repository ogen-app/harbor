import { HugeiconsIcon } from "@hugeicons/react";
import {
  SquareArrowDown02Icon,
  SquareArrowUp02Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import type { Capability, Flow, Model } from "./types";

// SYSTEM_FLOW_KEYS are flows that run for Harbor itself rather than on behalf
// of tenants, so their cost is not tenant AI usage and they have no tier
// overrides. Stopgap until modelconfig/v1 Flow carries a system flag (CON-320).
const SYSTEM_FLOW_KEYS = new Set(["receipt_extraction"]);

export function isSystemFlow(flow: Flow): boolean {
  return SYSTEM_FLOW_KEYS.has(flow.key);
}

// relativeShort renders an ISO timestamp as a compact age for dense table
// cells: "now", "12m", "3h", "5d", "2mo", "1y".
export function relativeShort(iso: string): string {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "—"; // empty or malformed timestamp
  const secs = Math.max(0, (Date.now() - ms) / 1000);
  if (secs < 60) return "now";
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(mo / 12)}y`;
}

// humanize turns a snake_case flow/slot key into a title ("content_plan" →
// "Content plan").
export function humanize(key: string): string {
  const s = key.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// claude-{family}-{major}[-{minor}][-yyyymmdd], e.g. claude-haiku-4-5-20251001.
const CLAUDE_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;
// Pre-4 naming put the version first: claude-3-7-sonnet-20250219.
const CLAUDE_LEGACY_ID = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/;
// gemini-{version}-{family}, e.g. gemini-2.5-flash, gemini-2.5-flash-lite.
const GEMINI_ID = /^gemini-(\d+(?:\.\d+)?)-([a-z]+(?:-[a-z]+)*)$/;
// gemini-embedding-{version}.
const GEMINI_EMBED_ID = /^gemini-embedding-(\d+(?:\.\d+)?)$/;

interface ParsedModel {
  name: string;
  family: string;
  version: number[];
}

function parseModelId(id: string): ParsedModel | null {
  let m = CLAUDE_ID.exec(id);
  if (m) {
    const version = m[3] ? [Number(m[2]), Number(m[3])] : [Number(m[2])];
    const family = titleCase(m[1]);
    return { name: `Claude ${family} ${version.join(".")}`, family, version };
  }
  m = CLAUDE_LEGACY_ID.exec(id);
  if (m) {
    const version = m[2] ? [Number(m[1]), Number(m[2])] : [Number(m[1])];
    const family = titleCase(m[3]);
    return { name: `Claude ${family} ${version.join(".")}`, family, version };
  }
  m = GEMINI_EMBED_ID.exec(id);
  if (m) {
    return {
      name: `Gemini Embedding ${m[1]}`,
      family: "Embedding",
      version: m[1].split(".").map(Number),
    };
  }
  m = GEMINI_ID.exec(id);
  if (m) {
    const family = m[2].split("-").map(titleCase).join("-");
    return {
      name: `Gemini ${m[1]} ${family}`,
      family,
      version: m[1].split(".").map(Number),
    };
  }
  return null;
}

// friendlyModel maps a model id to its human name ("claude-haiku-4-5-20251001"
// → "Claude Haiku 4.5", "gemini-2.5-flash" → "Gemini 2.5 Flash"). Unknown id
// shapes fall back to the raw id, so retired / unexpected ids still render.
export function friendlyModel(id: string): string {
  return parseModelId(id)?.name ?? id;
}

// modelFamily is the picker group within a vendor: Haiku, Sonnet, Opus, Flash,
// Pro, Embedding… Unknown shapes land in "Other".
export function modelFamily(id: string): string {
  return parseModelId(id)?.family ?? "Other";
}

// compareModelVersionDesc orders newer versions first (4.5 before 4, 4 before
// 3.7), then by id for a stable order.
export function compareModelVersionDesc(a: string, b: string): number {
  const va = parseModelId(a)?.version ?? [];
  const vb = parseModelId(b)?.version ?? [];
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] ?? 0) - (va[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.localeCompare(b);
}

export function rate(model: Model, kind: string): number | undefined {
  return model.rates.find((r) => r.kind === kind)?.microsPerMillion;
}

// usd formats micros-per-million as a fixed two-decimal dollar figure so a
// column of prices lines up ($3.00, $0.30); sub-cent rates keep a third digit
// ($0.075) rather than rounding to a misleading value.
export function usd(micros: number): string {
  return (micros / 1_000_000).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  });
}

// priceIn / priceOut are the per-1M input and output cells. Embed models have
// no output rate.
export function priceIn(model: Model | undefined): string {
  const v = model ? rate(model, "input") : undefined;
  return v === undefined ? "—" : usd(v);
}

export function priceOut(model: Model | undefined): string {
  if (!model || model.capability === "embed") return "—";
  const v = rate(model, "output");
  return v === undefined ? "—" : usd(v);
}

// priceDelta is the relative change of a candidate's rate against the current
// model's ("−67%", "+25%"); empty when either is missing or they're equal.
export function priceDelta(
  candidate: Model,
  current: Model | undefined,
  kind: "input" | "output",
): { label: string; cheaper: boolean } | null {
  if (!current || candidate.id === current.id) return null;
  const a = rate(candidate, kind);
  const b = rate(current, kind);
  if (a === undefined || b === undefined || b === 0 || a === b) return null;
  const pct = Math.round(((a - b) / b) * 100);
  if (pct === 0) return null;
  return {
    label: `${pct < 0 ? "−" : "+"}${Math.abs(pct)}%`,
    cheaper: pct < 0,
  };
}

// PriceHead is a right-aligned In / Out column header carrying the arrow glyph
// that used to repeat in every price cell.
export function PriceHead({
  kind,
  className,
}: {
  kind: "input" | "output";
  className?: string;
}) {
  return (
    <span
      className={cn("inline-flex items-center justify-end gap-1.5", className)}
    >
      <HugeiconsIcon
        icon={kind === "input" ? SquareArrowDown02Icon : SquareArrowUp02Icon}
        className="size-3.5 shrink-0"
        aria-hidden
      />
      {kind === "input" ? "In" : "Out"}
    </span>
  );
}

// modelDetail is the picker's second line: context, max output (or embedding
// dims) and the price-list version.
export function modelDetail(model: Model): string {
  const c = model.capabilities;
  const parts: string[] = [];
  if (model.capability === "embed") {
    if (c.embedDims) parts.push(`${c.embedDims} dims`);
  } else {
    if (c.contextWindow) parts.push(`${tokens(c.contextWindow)} context`);
    if (c.maxOutputTokens) parts.push(`${tokens(c.maxOutputTokens)} output`);
  }
  if (model.priceVersion) parts.push(`prices v${model.priceVersion}`);
  if (!c.live) parts.push("not live");
  return parts.join(" · ");
}

function tokens(n: number): string {
  return n >= 1_000_000
    ? `${Math.round(n / 100_000) / 10}M`
    : `${Math.round(n / 1000)}k`;
}

const CAPABILITY_BADGE: Record<Capability, { label: string; tint: string }> = {
  chat: { label: "Chat", tint: "bg-indigo-500/10 text-indigo-700" },
  embed: { label: "Embed", tint: "bg-teal-500/10 text-teal-700" },
  vision: { label: "Vision", tint: "bg-amber-500/10 text-amber-700" },
  transcribe: { label: "Transcribe", tint: "bg-rose-500/10 text-rose-700" },
};

// CapabilityBadge marks a slot's capability. Chat is the norm, so callers show
// it only for the exceptions (Embed, Vision, Transcribe).
export function CapabilityBadge({ capability }: { capability: Capability }) {
  const badge = CAPABILITY_BADGE[capability] ?? {
    label: humanize(capability),
    tint: "bg-secondary text-secondary-foreground",
  };
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        badge.tint,
      )}
    >
      {badge.label}
    </span>
  );
}

// servesCapability mirrors ogen's ModelCapabilities.Supports: vision and
// transcribe slots are filled by chat models with image / audio input; every
// other capability must match exactly.
export function servesCapability(model: Model, capability: Capability) {
  switch (capability) {
    case "vision":
      return model.capability === "chat" && model.capabilities.visionInput;
    case "transcribe":
      return model.capability === "chat" && model.capabilities.audioInput;
    default:
      return model.capability === capability;
  }
}
