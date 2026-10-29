"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Cancel01Icon,
  InformationSquareIcon,
  KeyboardIcon,
} from "@hugeicons/core-free-icons";
import { Squircle } from "@squircle-js/react";
import { cn } from "@/lib/utils";

// HelpPanel is the inverted (ink) explainer that floats at the right edge of a
// page, opened from a HelpButton in the page header or with the "?" key
// (CON-320). It replaces always-on "About this page" side panels: the page gets
// its full width back, and the explanation is one keystroke away.
//
// Motion follows the Pallada body-of-knowledge panel: the panel and a
// right-edge backdrop gradient fade/slide in over 400ms, then the body's
// children rise in one after another (see .help-panel in globals.css). Closing
// is twice as fast and the contents don't animate out.

export interface HelpItem {
  title: string;
  body: ReactNode;
}

export interface HelpShortcut {
  // Keys shown as chips. A range is written as ["1", "–", "4"]: an en dash
  // renders as a plain separator, not a chip.
  keys: string[];
  label: string;
}

const RANGE_SEPARATOR = "–";

// useHelpPanel owns the open state and the page-level "?" toggle. The "?" key
// is ignored while typing or when a modifier other than Shift is held.
export function useHelpPanel() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.isContentEditable ||
          /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) ||
          el.closest?.('[role="combobox"],[role="textbox"]'))
      ) {
        return;
      }
      e.preventDefault();
      setOpen((o) => !o);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return { open, setOpen, triggerRef };
}

// HelpButton is the borderless InformationSquare trigger for a page header:
// secondary at rest, foreground on hover and while its panel is open.
export function HelpButton({
  open,
  onToggle,
  ref,
  controls = "help-panel",
  label = "About this page",
}: {
  open: boolean;
  onToggle: () => void;
  ref?: RefObject<HTMLButtonElement | null>;
  controls?: string;
  label?: string;
}) {
  return (
    <button
      ref={ref}
      type="button"
      // Mark the trigger so the panel's outside-click handler leaves toggling
      // to this button.
      data-help-trigger=""
      aria-label={label}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className={cn(
        "inline-flex size-8 cursor-pointer items-center justify-center rounded-sm transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-editable/60",
        open
          ? "text-foreground"
          : "text-secondary-foreground hover:text-foreground",
      )}
    >
      <HugeiconsIcon icon={InformationSquareIcon} className="size-7" />
    </button>
  );
}

export function HelpPanel({
  open,
  onClose,
  triggerRef,
  icon,
  title,
  lead,
  items,
  shortcuts,
  id = "help-panel",
}: {
  open: boolean;
  onClose: () => void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  icon: IconSvgElement;
  title: string;
  lead?: ReactNode;
  items: HelpItem[];
  shortcuts?: HelpShortcut[];
  id?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  // Portal target exists only on the client.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
  }, []);

  const close = useCallback(
    (restoreFocus: boolean) => {
      onClose();
      if (restoreFocus) triggerRef?.current?.focus({ preventScroll: true });
    },
    [onClose, triggerRef],
  );

  // On open: restart the staggered reveal and move focus to the close button.
  useEffect(() => {
    const body = bodyRef.current;
    if (!open || !body) return;
    body.classList.remove("help-panel-reveal");
    void body.offsetWidth; // reflow so the animation replays on every open
    body.classList.add("help-panel-reveal");
    closeRef.current?.focus({ preventScroll: true });
  }, [open]);

  // While open: Esc closes; a pointer-down outside the panel (and outside its
  // trigger, which toggles by itself) closes without stealing focus back.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(true);
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t || panelRef.current?.contains(t)) return;
      if (t.closest("[data-help-trigger]")) return;
      close(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, close]);

  if (!mounted) return null;

  return createPortal(
    <>
      <div aria-hidden className="help-panel-shade" data-open={open} />
      <div
        ref={panelRef}
        id={id}
        role="dialog"
        aria-modal="false"
        aria-labelledby={`${id}-title`}
        aria-hidden={!open}
        inert={!open}
        data-open={open}
        className="help-panel"
      >
        <Squircle
          cornerRadius={24}
          cornerSmoothing={0.6}
          className="flex max-h-[calc(100dvh-96px)] flex-col bg-foreground text-[#f5f4f2]"
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 py-4 pr-4 pl-6">
            <h2
              id={`${id}-title`}
              className="flex min-w-0 items-center gap-3 text-base font-semibold tracking-[-0.01em]"
            >
              <HugeiconsIcon icon={icon} className="size-5 shrink-0 text-[#bcbab6]" />
              <span className="truncate">{title}</span>
            </h2>
            <button
              ref={closeRef}
              type="button"
              aria-label="Close"
              onClick={() => close(true)}
              className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-white/[0.06] text-[#bcbab6] transition-colors duration-150 outline-none hover:bg-white/[0.12] hover:text-[#f5f4f2] focus-visible:ring-2 focus-visible:ring-white/30"
            >
              <HugeiconsIcon icon={Cancel01Icon} className="size-4" />
            </button>
          </div>

          <div
            ref={bodyRef}
            className="flex min-h-0 flex-col gap-4 overflow-y-auto p-6"
          >
            {lead && (
              <p className="mb-2 border-l border-white/[0.18] pl-4 text-sm leading-relaxed text-[#bcbab6]">
                {lead}
              </p>
            )}
            {items.map((item) => (
              <div key={item.title}>
                <div className="text-sm leading-snug font-semibold">
                  {item.title}
                </div>
                <div className="mt-0.5 text-[13px] leading-normal text-[#a3a19d]">
                  {item.body}
                </div>
              </div>
            ))}
            {shortcuts && shortcuts.length > 0 && (
              <div className="mt-1 flex flex-col gap-2 border-t border-white/10 pt-4">
                <div className="mb-1 flex items-center gap-2.5 text-sm font-semibold">
                  <HugeiconsIcon icon={KeyboardIcon} className="size-4 text-[#bcbab6]" />
                  Shortcuts on this page
                </div>
                {shortcuts.map((s) => (
                  <div
                    key={s.label}
                    className="grid grid-cols-[92px_1fr] items-center text-[13px] text-[#bcbab6]"
                  >
                    <span className="flex items-center gap-1">
                      {s.keys.map((k, i) =>
                        k === RANGE_SEPARATOR ? (
                          <span key={i} className="text-[#a3a19d]">
                            {k}
                          </span>
                        ) : (
                          <kbd
                            key={i}
                            className="inline-flex min-w-[22px] items-center justify-center rounded-[5px] bg-[#2b2b2b] px-1.5 py-0.5 font-sans text-xs font-medium text-[#f5f4f2]"
                          >
                            {k}
                          </kbd>
                        ),
                      )}
                    </span>
                    {s.label}
                  </div>
                ))}
              </div>
            )}
          </div>
        </Squircle>
      </div>
    </>,
    document.body,
  );
}
