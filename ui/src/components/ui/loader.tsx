import { cn } from "@/lib/utils";

// Loader is a ring spinner that inherits the current text colour, so it stays
// visible on any background.
export function Loader({ className }: { className?: string }) {
    return (
        <span
            role="status"
            aria-label="Loading"
            className={cn(
                "inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent",
                className,
            )}
        />
    );
}
