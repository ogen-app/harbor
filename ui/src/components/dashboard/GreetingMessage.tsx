"use client";

import { useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";

function firstName(full?: string): string {
    const n = (full ?? "").trim().split(/\s+/)[0];
    return n || "there";
}

// Time-of-day salutation from the local hour.
function salutation(hour: number): string {
    if (hour < 5) return "Still up";
    if (hour < 12) return "Good morning";
    if (hour < 17) return "Good afternoon";
    if (hour < 22) return "Good evening";
    return "Working late";
}

// Claude-app-style greetings: coffee + the day's admin/chores/overview, lightly
// personalised. `hello` is the time-of-day salutation, `name` the first name.
function greetingsFor(hello: string, name: string): string[] {
    return [
        `${hello}, ${name} — coffee's on, let's run the checks.`,
        `${hello}, ${name}. Coffee poured, chores queued.`,
        `${hello}, ${name} — time for coffee and a quick overview.`,
        `${hello}, ${name}. Let's keep the operation humming.`,
        `${hello}, ${name} — the control center is all yours.`,
        `${hello}, ${name}. Coffee first, then the housekeeping.`,
        `${hello}, ${name} — a fresh cup and a fresh to-do list.`,
        `${hello}, ${name}. Let's see what needs a look today.`,
        `${hello}, ${name} — coffee in hand, dashboards ahead.`,
        `${hello}, ${name}. Tidy queues, happy tenants — let's tidy up.`,
        `${hello}, ${name} — grab a coffee, we'll do the rounds.`,
        `${hello}, ${name}. Another day of keeping Ogen shipshape.`,
        `${hello}, ${name} — coffee brewed, a few chores to clear.`,
        `${hello}, ${name}. Small chores now, smooth sailing later.`,
        `${hello}, ${name} — steady coffee, steady operations.`,
        `${hello}, ${name}. The overview's ready when you are.`,
        `${hello}, ${name} — coffee, then a calm sweep of the console.`,
        `${hello}, ${name}. Let's clear the queue and sip slow.`,
        `${hello}, ${name} — keep the tenants running, keep the coffee flowing.`,
        `${hello}, ${name}. Coffee up; the campaigns can wait a minute.`,
    ];
}

export function GreetingMessage() {
    const { user } = useAuth();
    const name = firstName(user?.name);
    // Sample the hour + a greeting once on mount; the name fills in reactively.
    const [pick] = useState(() => ({
        hour: new Date().getHours(),
        index: Math.floor(Math.random() * greetingsFor("", "").length),
    }));
    return <>{greetingsFor(salutation(pick.hour), name)[pick.index]}</>;
}
