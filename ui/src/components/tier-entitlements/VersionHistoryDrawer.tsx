"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { WorkHistoryIcon } from "@hugeicons/core-free-icons";
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { cn } from "@/lib/utils";
import { formatMoney, headlinePrice, liveVersion, plural } from "./model";
import type { MatrixTier, TierVersion } from "./types";

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const fmtDate = (iso: string | null) => (iso ? dateFmt.format(new Date(iso)) : "—");

// VersionHistoryDrawer lists every version of a tier (CON-321 §5). Retired
// versions live here instead of as extra matrix columns, together with the
// change reason each one was published with.
export function VersionHistoryDrawer({
  open,
  onOpenChange,
  tier,
  onEditPrices,
  onRetire,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tier: MatrixTier | null;
  onEditPrices: (v: TierVersion) => void;
  onRetire: (v: TierVersion) => void;
}) {
  const versions = [...(tier?.versions ?? [])].sort((a, b) => b.version - a.version);
  const live = tier ? liveVersion(tier) : null;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle className="flex items-center gap-2">
            <HugeiconsIcon icon={WorkHistoryIcon} className="size-5 text-secondary-foreground" />
            {tier?.tierName} · versions
          </DrawerTitle>
          <DrawerDescription>
            Published versions never change. Tenants stay on their version until they are moved.
          </DrawerDescription>
        </DrawerHeader>
        <DrawerBody>
          <ul className="divide-y divide-border border-y border-border">
            {versions.map((v) => {
              const price = headlinePrice(v);
              const state =
                v.status === "draft"
                  ? { text: "draft", cls: "text-editable" }
                  : v.status === "retired"
                    ? { text: "retired", cls: "text-secondary-foreground" }
                    : v.id === live?.id
                      ? { text: v.purchasable ? "live" : "live · not sold", cls: "text-emerald-700" }
                      : { text: "active", cls: "text-secondary-foreground" };
              return (
                <li key={v.id} className="flex items-start gap-4 py-3.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px]">
                      <span className="font-semibold text-foreground">v{v.version}</span>
                      <span className={cn("ml-2 font-medium", state.cls)}>{state.text}</span>
                      {price && (
                        <span className="ml-2 text-secondary-foreground tabular-nums">
                          {formatMoney(price)}/{price.billingInterval === "year" ? "yr" : "mo"}
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-secondary-foreground">
                      {v.status === "draft"
                        ? `Created ${fmtDate(v.createdAt)}`
                        : v.status === "retired"
                          ? `${fmtDate(v.publishedAt)} – ${fmtDate(v.retiredAt)}`
                          : `Since ${fmtDate(v.publishedAt)}`}
                      {v.status !== "draft" && ` · ${plural(v.liveAssignmentCount, "tenant")}`}
                    </p>
                    {v.changeReason && (
                      <p className="mt-1 text-xs italic text-secondary-foreground">“{v.changeReason}”</p>
                    )}
                  </div>
                  {v.status === "draft" && (
                    <button
                      type="button"
                      onClick={() => onEditPrices(v)}
                      className="shrink-0 cursor-pointer text-xs font-medium text-editable hover:underline"
                    >
                      Prices and sale status…
                    </button>
                  )}
                  {v.status === "active" && (
                    <button
                      type="button"
                      onClick={() => onRetire(v)}
                      className="shrink-0 cursor-pointer text-xs font-medium text-foreground hover:underline"
                    >
                      Retire…
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}
