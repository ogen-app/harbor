import type { ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AiChemistry02Icon,
  InformationDiamondIcon,
} from "@hugeicons/core-free-icons";

// AboutPanel is the right-hand explainer for /model-assignment: what the page
// does, how flows/slots and pricing work, and — the part operators most need —
// how the per-model "Test" probe works.
export function AboutPanel() {
  return (
    <div className="flex h-full flex-col gap-5 overflow-auto p-5">
      <div>
        <h2 className="flex items-center gap-2 font-display text-base font-medium">
          <HugeiconsIcon
            icon={InformationDiamondIcon}
            className="size-5 text-tertiary-foreground"
          />
          About this page
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-secondary-foreground">
          Assign a foundation model to every generation flow. Each flow declares
          one or more <span className="font-medium text-foreground">slots</span>;
          the table shows the{" "}
          <span className="font-medium text-foreground">global default</span> for
          each. Open a slot to override it per tier and compare pricing — changes
          take effect with no deploy.
        </p>
      </div>

      <Section title="Flows &amp; slots">
        A single-model flow has one slot (Main). Orchestrated flows split into
        several — e.g. <span className="font-medium text-foreground">Post
        assistant</span> has a cheap{" "}
        <span className="font-medium text-foreground">Planner</span> and a capable{" "}
        <span className="font-medium text-foreground">Writer</span>, each assigned
        independently. The embed slot is global-only (a tenant’s vectors must stay
        homogeneous), so it can’t be overridden per tier.
      </Section>

      <Section title="Pricing">
        Every model shows its per-token pricing (input / output / cache) and price
        version, so a model change is an eyes-open cost decision.
      </Section>

      <Section
        title={
          <span className="inline-flex items-center gap-1.5">
            <HugeiconsIcon icon={AiChemistry02Icon} className="size-4" />
            Testing a model (probe)
          </span>
        }
      >
        In the editing drawer,{" "}
        <span className="font-medium text-foreground">Test</span> runs the flow’s
        golden probe against a candidate model in two steps:
        <ul className="mt-2 list-disc space-y-1.5 pl-4">
          <li>
            <span className="font-medium text-foreground">Static check</span> —
            matches the model’s declared capabilities (tools, structured output,
            streaming, context window, embed dims) against what the slot needs.
            Instant, no API call; a red <em>“needs …”</em> means it failed here.
          </li>
          <li>
            <span className="font-medium text-foreground">Live probe</span> — the
            smallest real invocation that exercises the flow’s actual features (a
            tool round-trip, a tiny schema-constrained generation, or a one-token
            stream). Returns pass / fail, latency, and a short output sample — one
            real, billed model call.
          </li>
        </ul>
        <span className="mt-2 block">
          Probing is on-demand and non-blocking: it never gates saving. Hard
          compatibility is still enforced server-side when you save.
        </span>
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-secondary-foreground">
        {title}
      </h3>
      <div className="mt-1.5 text-sm leading-relaxed text-secondary-foreground">
        {children}
      </div>
    </div>
  );
}
