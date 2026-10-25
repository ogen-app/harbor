"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { SignupSettings, SignupSettingsResponse } from "./types";

// A tiny shared store for the signup settings, so the sidebar's mode pill and
// the Signup mode page read the same value: the page writes the settings it
// saved back here and the pill updates without its own refetch. The first
// subscriber triggers one fetch; later ones reuse it.

export interface SignupSettingsState {
  loading: boolean;
  available: boolean;
  settings: SignupSettings | null;
  error: string | null;
}

let state: SignupSettingsState = {
  loading: true,
  available: false,
  settings: null,
  error: null,
};
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(next: SignupSettingsState) {
  state = next;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const getSnapshot = () => state;

// loadSignupSettings (re)fetches the settings; concurrent callers share one
// request. A refetch keeps showing the current snapshot (no loading flash).
export function loadSignupSettings(): Promise<void> {
  if (inflight) return inflight;
  lastLoad = Date.now();
  inflight = fetch("/api/signup-settings")
    .then(async (r) => {
      if (!r.ok) throw new Error(`Request failed (${r.status})`);
      return (await r.json()) as SignupSettingsResponse;
    })
    .then((j) =>
      emit({
        loading: false,
        available: j.available,
        settings: j.available ? j.settings : null,
        error: null,
      }),
    )
    .catch((e: unknown) =>
      emit({
        ...state,
        loading: false,
        error: e instanceof Error ? e.message : "Failed to load signup mode.",
      }),
    )
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// setSignupSettings publishes settings the page just saved (or the current
// ones Harbor returned when it refused a stale write).
export function setSignupSettings(settings: SignupSettings) {
  emit({ loading: false, available: true, settings, error: null });
}

// Another operator may flip the mode at any time: revalidate when the tab
// regains focus, at most every REVALIDATE_MS. Installed once, on first use.
const REVALIDATE_MS = 30_000;
let lastLoad = 0;
let focusListener = false;

function revalidateIfStale() {
  if (Date.now() - lastLoad >= REVALIDATE_MS) void loadSignupSettings();
}

// useSignupSettings reads the shared snapshot. The first subscriber loads it; a
// failed or unavailable read is retried by the next mount. revalidate (the
// Signup mode page) always refetches on mount, so the page never acts on a
// stale mode.
export function useSignupSettings(opts?: {
  revalidate?: boolean;
}): SignupSettingsState {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const revalidate = opts?.revalidate ?? false;
  useEffect(() => {
    if (!focusListener) {
      focusListener = true;
      window.addEventListener("focus", revalidateIfStale);
    }
    const ok = state.available && state.settings !== null && !state.error;
    if (revalidate || !ok || lastLoad === 0) void loadSignupSettings();
  }, [revalidate]);
  return snap;
}
