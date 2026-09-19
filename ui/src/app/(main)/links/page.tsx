"use client";

import { WavesIcon, ArrowSquareOutIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/ui/icon";

// External service dashboards Harbor integrates with — moved here from the
// sidebar's old "Services" group into a single table.
type ServiceIcon =
  | "ai_studio"
  | "claude"
  | "cloudflare"
  | "zernio"
  | "railway"
  | "github"
  | "sentry"
  | "waves";

type ServiceLink = {
  name: string;
  href: string;
  description: string;
  icon: ServiceIcon;
};

const LINKS: ServiceLink[] = [
  {
    name: "Google AI Studio",
    href: "https://aistudio.google.com/usage?timeRange=last-7-days&project=gen-lang-client-0756755976",
    description: "Gemini API usage",
    icon: "ai_studio",
  },
  {
    name: "Claude Console",
    href: "https://platform.claude.com/usage",
    description: "Anthropic API usage",
    icon: "claude",
  },
  {
    name: "Cloudflare R2",
    href: "https://dash.cloudflare.com/17efea3963b045025b9ecbdcad609273/r2/overview",
    description: "Object storage overview",
    icon: "cloudflare",
  },
  {
    name: "Zernio",
    href: "https://zernio.com/dashboard/connections",
    description: "Social connections",
    icon: "zernio",
  },
  {
    name: "Railway",
    href: "https://railway.com/project/e475ca33-45d9-4dd1-b996-b4292ff20378",
    description: "Deployments & services",
    icon: "railway",
  },
  {
    name: "River Queue",
    href: "https://riverui-development.up.railway.app/jobs",
    description: "Background job queue",
    icon: "waves",
  },
  {
    name: "GitHub",
    href: "https://github.com/ogen-app",
    description: "Source repositories",
    icon: "github",
  },
  {
    name: "Sentry",
    href: "https://ogen.sentry.io/issues/?project=4512106293100544",
    description: "Error monitoring & issues",
    icon: "sentry",
  },
];

function ServiceIconGlyph({ icon }: { icon: ServiceIcon }) {
  if (icon === "waves") return <WavesIcon className="size-5 shrink-0" />;
  return <Icon name={icon} className="size-5 shrink-0 stroke-[1.5]" />;
}

// Links is the operator's index of external service dashboards. Structurally it
// mirrors /platforms and /secrets: a page header + a single table card.
export default function LinksPage() {
  return (
    <main className="flex-1 overflow-auto flex flex-col">
      <header className="h-20 border-b border-border flex items-center px-6 shrink-0">
        <h1 className="text-2xl font-display font-medium">Links</h1>
      </header>

      <div className="p-6">
        <div className="rounded-xl bg-primary">
          <div className="border-b border-border px-6 py-4">
            <h2 className="text-sm font-medium text-foreground">
              External services
            </h2>
            <p className="mt-1 text-xs text-tertiary-foreground">
              Dashboards and consoles for the services Harbor integrates with —
              each opens in a new tab.
            </p>
          </div>

          <div className="divide-y divide-border">
            {LINKS.map((l) => (
              <a
                key={l.name}
                href={l.href}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex items-center gap-3 px-6 py-3.5 text-sm transition-colors hover:bg-secondary/40"
              >
                <span className="text-secondary-foreground">
                  <ServiceIconGlyph icon={l.icon} />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium text-foreground">{l.name}</span>
                  <span className="truncate text-xs text-tertiary-foreground">
                    {l.description}
                  </span>
                </span>
                <span className="ml-auto hidden max-w-[45%] truncate font-mono text-xs text-tertiary-foreground sm:block">
                  {l.href}
                </span>
                <ArrowSquareOutIcon className="size-4 shrink-0 text-tertiary-foreground transition-colors group-hover:text-foreground" />
              </a>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
