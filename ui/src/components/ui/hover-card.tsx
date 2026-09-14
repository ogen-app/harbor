"use client";

import * as React from "react";
import * as HoverCardPrimitive from "@radix-ui/react-hover-card";
import { cn } from "@/lib/utils";

function HoverCard({
    ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
    return <HoverCardPrimitive.Root data-slot="hover-card" {...props} />;
}

function HoverCardTrigger({
    ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
    return (
        <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
    );
}

function HoverCardContent({
    className,
    align = "center",
    sideOffset = 6,
    ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
    return (
        <HoverCardPrimitive.Portal>
            <HoverCardPrimitive.Content
                data-slot="hover-card-content"
                align={align}
                sideOffset={sideOffset}
                className={cn(
                    "z-50 w-72 rounded-lg border border-border bg-primary p-4 text-sm text-foreground shadow-xl outline-none",
                    className,
                )}
                {...props}
            />
        </HoverCardPrimitive.Portal>
    );
}

export { HoverCard, HoverCardTrigger, HoverCardContent };
