import { useEffect, useRef, useState } from "react";

// useRowKeyboardNav adds vim-style keyboard navigation to a page's list/table:
//   • j / ArrowDown  → move the highlighted "active" row down
//   • k / ArrowUp    → move it up
//   • o / O / Enter  → open the active row (via onOpen)
//
// Enter only opens the active row when nothing interactive is focused, so a
// focused link/button/row keeps its native Enter behaviour; o / O always open.
//
// The listener is page-level (window), so it works immediately without first
// clicking or focusing the table — the app has at most one table per page. It
// stays out of the way while the user is typing or driving another keyboard
// widget (inputs, the filter combobox, dropdown menus, dialogs).
//
// The rendering component owns the visuals: highlight the row whose index ===
// activeIndex, and tag each row element with data-row-index={index} so the
// active row can be scrolled into view.
export interface UseRowKeyboardNav {
    activeIndex: number;
    setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
    containerRef: React.RefObject<HTMLDivElement | null>;
}

// Elements whose own keyboard handling must win over row navigation.
const GUARDED_SELECTOR =
    'input, textarea, select, [role="combobox"], [role="textbox"], [role="menu"], [role="listbox"], [role="dialog"], [role="grid"], [role="tree"]';

export function useRowKeyboardNav({
    count,
    onOpen,
}: {
    count: number;
    onOpen: (index: number) => void;
}): UseRowKeyboardNav {
    const [activeIndex, setActiveIndex] = useState(-1);
    const containerRef = useRef<HTMLDivElement | null>(null);

    // Latest count/active/onOpen for the window listener, so it can subscribe
    // once (in a []-deps effect) instead of re-binding on every keypress. Kept
    // current via an after-render effect (writing a ref during render is unsafe).
    const latest = useRef({ count, activeIndex, onOpen });
    useEffect(() => {
        latest.current = { count, activeIndex, onOpen };
    });

    // Keep the active row within bounds as the list grows or shrinks (filtering,
    // refetches). -1 (nothing active) is preserved; the updater no-ops when the
    // index is already in range, so this re-renders only on an actual clamp.
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setActiveIndex((i) => (i >= count ? count - 1 : i));
    }, [count]);

    // Scroll the active row into view when it moves off-screen.
    useEffect(() => {
        if (activeIndex < 0) return;
        containerRef.current
            ?.querySelector<HTMLElement>(`[data-row-index="${activeIndex}"]`)
            ?.scrollIntoView({ block: "nearest" });
    }, [activeIndex]);

    useEffect(() => {
        const handle = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            // Skip while typing or when another widget owns the keyboard.
            if (
                target &&
                (target.isContentEditable ||
                    (typeof target.closest === "function" &&
                        target.closest(GUARDED_SELECTOR)))
            ) {
                return;
            }
            if (e.metaKey || e.ctrlKey || e.altKey) return;

            const { count, activeIndex, onOpen } = latest.current;
            if (count === 0) return;

            switch (e.key) {
                case "j":
                case "ArrowDown":
                    e.preventDefault();
                    setActiveIndex((i) => Math.min(i < 0 ? 0 : i + 1, count - 1));
                    break;
                case "k":
                case "ArrowUp":
                    e.preventDefault();
                    setActiveIndex((i) => (i <= 0 ? 0 : i - 1));
                    break;
                case "Enter":
                    // Let a focused link/button/row handle Enter itself (native
                    // activation / row expand); only open the highlighted row when
                    // nothing interactive is focused, i.e. pure keyboard nav.
                    if (
                        target &&
                        typeof target.closest === "function" &&
                        target.closest('a[href], button, [role="button"]')
                    ) {
                        return;
                    }
                // falls through
                case "o":
                case "O":
                    if (activeIndex >= 0 && activeIndex < count) {
                        e.preventDefault();
                        onOpen(activeIndex);
                    }
                    break;
            }
        };
        window.addEventListener("keydown", handle);
        return () => window.removeEventListener("keydown", handle);
    }, []);

    return { activeIndex, setActiveIndex, containerRef };
}
