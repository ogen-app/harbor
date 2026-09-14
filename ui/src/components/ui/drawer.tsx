"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";

// A right-side drawer (sheet) built on Radix Dialog — consistent with the
// Radix-based dialog/popover/tooltip primitives, styled after the shadcn
// drawer. Slides in from the right; the body scrolls while the header/footer
// stay pinned.
function Drawer({
    ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
    return <DialogPrimitive.Root data-slot="drawer" {...props} />;
}

function DrawerTrigger({
    ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
    return <DialogPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerClose({
    ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
    return <DialogPrimitive.Close data-slot="drawer-close" {...props} />;
}

function DrawerContent({
    className,
    children,
    ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
    return (
        <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay
                data-slot="drawer-overlay"
                className="fixed inset-0 z-[200] bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
            />
            <DialogPrimitive.Content
                data-slot="drawer-content"
                className={cn(
                    "fixed inset-y-0 right-8 z-[200] flex h-full w-full max-w-xl flex-col border-l border-border bg-primary text-foreground shadow-xl outline-none " +
                        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right data-[state=open]:duration-300 data-[state=closed]:duration-200",
                    className,
                )}
                {...props}
            >
                {children}
                <DialogPrimitive.Close
                    aria-label="Close"
                    className="absolute right-4 top-4 rounded-xs text-tertiary-foreground outline-none transition-colors hover:text-foreground focus-visible:inset-ring-[2px] focus-visible:inset-ring-ring"
                >
                    <Icon name="x_mark" className="size-4" />
                </DialogPrimitive.Close>
            </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
    );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="drawer-header"
            className={cn(
                "flex flex-col gap-1 border-b border-border px-6 py-4 pr-12",
                className,
            )}
            {...props}
        />
    );
}

function DrawerBody({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="drawer-body"
            className={cn("min-h-0 flex-1 overflow-y-auto px-6 py-4", className)}
            {...props}
        />
    );
}

function DrawerFooter({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="drawer-footer"
            className={cn(
                "flex items-center justify-end gap-2 border-t border-border px-6 py-4",
                className,
            )}
            {...props}
        />
    );
}

function DrawerTitle({
    className,
    ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
    return (
        <DialogPrimitive.Title
            data-slot="drawer-title"
            className={cn(
                "font-display text-lg font-medium text-foreground",
                className,
            )}
            {...props}
        />
    );
}

function DrawerDescription({
    className,
    ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
    return (
        <DialogPrimitive.Description
            data-slot="drawer-description"
            className={cn("text-sm text-tertiary-foreground", className)}
            {...props}
        />
    );
}

export {
    Drawer,
    DrawerTrigger,
    DrawerClose,
    DrawerContent,
    DrawerHeader,
    DrawerBody,
    DrawerFooter,
    DrawerTitle,
    DrawerDescription,
};
