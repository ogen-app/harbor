import { cn } from "@/lib/utils";
import type { Capability, Model, ModelRate } from "./types";

// humanize turns a snake_case flow/slot key into a title ("content_plan" →
// "Content plan"). Used for flow band headers.
export function humanize(key: string): string {
  const s = key.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// friendlyModel maps a known model id to a short display name, falling back to
// the raw id (so retired / unknown ids still render, flagged as drift elsewhere).
export function friendlyModel(id: string): string {
  if (id.startsWith("claude-sonnet-4-5")) return "Claude Sonnet 4.5";
  if (id.startsWith("claude-haiku-4-5")) return "Claude Haiku 4.5";
  if (id === "gemini-2.5-flash") return "Gemini 2.5 Flash";
  if (id === "gemini-2.5-pro") return "Gemini 2.5 Pro";
  if (id === "gemini-embedding-2") return "Gemini Embedding 2";
  return id;
}

function rate(model: Model, kind: string): number | undefined {
  return model.rates.find((r: ModelRate) => r.kind === kind)?.microsPerMillion;
}

// usd formats micros-per-million as a dollar-per-million string. 3_000_000
// micros ⇒ "$3", 300_000 ⇒ "$0.30".
export function usd(micros: number): string {
  const dollars = micros / 1_000_000;
  const s =
    dollars >= 1 || dollars === 0
      ? dollars.toFixed(dollars % 1 === 0 ? 0 : 2)
      : dollars.toFixed(2);
  return `$${s}`;
}

// headlinePrice is the compact per-1M cost shown next to a model: input/output
// for chat, a single rate for embed. The full per-kind breakdown lives in the
// drawer's PriceTable.
export function headlinePrice(model: Model): string {
  const inp = rate(model, "input");
  if (model.capability === "embed") {
    return inp === undefined ? "—" : `${usd(inp)} / 1M`;
  }
  const out = rate(model, "output");
  if (inp === undefined && out === undefined) return "—";
  return `${inp === undefined ? "—" : usd(inp)} in · ${
    out === undefined ? "—" : usd(out)
  } out`;
}

// PRICE_KINDS is the ordered, human-labelled set of per-kind rates for the
// drawer's price breakdown.
export const PRICE_KINDS: { kind: string; label: string }[] = [
  { kind: "input", label: "Input" },
  { kind: "output", label: "Output" },
  { kind: "cache_read", label: "Cache read" },
  { kind: "cache_write", label: "Cache write" },
];

export function CapabilityBadge({ capability }: { capability: Capability }) {
  const chat = capability === "chat";
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        chat
          ? "bg-indigo-500/10 text-indigo-700"
          : "bg-teal-500/10 text-teal-700",
      )}
    >
      {chat ? "Chat" : "Embed"}
    </span>
  );
}

// VendorGlyph is the small icon-square shown at the head of each model row
// (screenshot-inspired resource list). A tinted rounded square with the
// vendor's initial — no brand SVGs needed.
export function VendorGlyph({
  vendor,
  className,
}: {
  vendor: string;
  className?: string;
}) {
  const tint =
    vendor === "anthropic"
      ? "bg-orange-500/10 text-orange-700"
      : vendor === "gemini"
        ? "bg-blue-500/10 text-blue-700"
        : "bg-secondary text-secondary-foreground";
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-md text-sm font-semibold uppercase",
        tint,
        className,
      )}
      aria-hidden
    >
      {vendor.charAt(0) || "?"}
    </span>
  );
}

// ModelCapabilityBadges renders the model's supported features as small pills so
// an operator can see compatibility at a glance before assigning (CON-308 §8a).
export function ModelCapabilityBadges({ model }: { model: Model }) {
  const caps = model.capabilities;
  const pills: string[] = [];
  if (model.capability === "chat") {
    if (caps.tools) pills.push("Tools");
    if (caps.structuredOutput) pills.push("Structured");
    if (caps.streaming) pills.push("Streaming");
    if (caps.contextWindow)
      pills.push(`${Math.round(caps.contextWindow / 1000)}k ctx`);
    if (caps.maxOutputTokens)
      pills.push(`${Math.round(caps.maxOutputTokens / 1000)}k out`);
  } else {
    if (caps.embedDims) pills.push(`${caps.embedDims} dims`);
  }
  if (!caps.live) pills.push("Not live");
  return (
    <div className="flex flex-wrap gap-1">
      {pills.map((p) => (
        <span
          key={p}
          className={cn(
            "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium",
            p === "Not live"
              ? "bg-destructive/10 text-destructive"
              : "bg-secondary text-secondary-foreground",
          )}
        >
          {p}
        </span>
      ))}
    </div>
  );
}
