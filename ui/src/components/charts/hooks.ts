"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

// useElementWidth tracks an element's content width, so an SVG chart can draw
// in real pixels (crisp hairlines, fixed-size labels) instead of scaling.
export function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

// useChartKeyboard keeps the active column of a chart. Hover sets it; with the
// chart focused, ←/→ move it, Home/End jump and Esc clears, so every tooltip
// is reachable without a mouse.
export function useChartKeyboard(count: number) {
  const [active, setActive] = useState<number | null>(null);
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (count === 0) return;
      let next: number | null | undefined;
      switch (e.key) {
        case "ArrowRight":
          next = active == null ? 0 : Math.min(count - 1, active + 1);
          break;
        case "ArrowLeft":
          next = active == null ? count - 1 : Math.max(0, active - 1);
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = count - 1;
          break;
        case "Escape":
          next = null;
          break;
        default:
          return;
      }
      e.preventDefault();
      setActive(next);
    },
    [active, count],
  );
  const clamped = active != null && active < count ? active : null;
  return { active: clamped, setActive, onKeyDown, onBlur: () => setActive(null) };
}
