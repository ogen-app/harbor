"use client";

import { CheckIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

// Switch is the button-based toggle used by the /tenants column selector, made
// reusable. `size` scales the track/thumb; the `success` variant fills green
// when on (used for the purchasable toggle).
export function Switch({
    checked,
    onChange,
    disabled,
    label,
    size = "sm",
    variant = "default",
}: {
    checked: boolean;
    onChange: (v: boolean) => void;
    disabled?: boolean;
    label: string;
    size?: "sm" | "lg";
    variant?: "default" | "success" | "warning";
}) {
    const dims =
        size === "lg"
            ? {
                  track: "h-6 w-11",
                  thumb: "size-5",
                  on: "translate-x-[22px]",
                  off: "translate-x-0.5",
                  icon: "size-3",
              }
            : {
                  track: "h-5 w-9",
                  thumb: "size-4",
                  on: "translate-x-[18px]",
                  off: "translate-x-0.5",
                  icon: "size-2.5",
              };
    const onBg =
        variant === "success"
            ? "bg-[#6B8068]"
            : variant === "warning"
              ? "bg-amber-500"
              : "bg-foreground";
    const iconColor =
        variant === "success"
            ? "text-[#6B8068]"
            : variant === "warning"
              ? "text-amber-600"
              : "text-foreground";
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            className={cn(
                "relative inline-flex shrink-0 cursor-pointer items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-foreground/30 disabled:cursor-not-allowed disabled:opacity-50",
                dims.track,
                checked ? onBg : "bg-quaternary",
            )}
        >
            <span
                className={cn(
                    "inline-flex items-center justify-center rounded-full bg-primary shadow-sm transition-transform",
                    dims.thumb,
                    checked ? dims.on : dims.off,
                )}
            >
                {checked && (
                    <CheckIcon className={cn(dims.icon, iconColor)} weight="bold" />
                )}
            </span>
        </button>
    );
}
