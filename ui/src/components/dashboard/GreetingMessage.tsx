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
// personalised.
function greetingsFor(): string[] {
    return [
        ` — coffee's on, let's run the checks.`,
        `. Coffee poured, chores queued.`,
        ` — time for coffee and a quick overview.`,
        `. Let's keep the operation humming.`,
        ` — the control center is all yours.`,
        `. Coffee first, then the housekeeping.`,
        ` — a fresh cup and a fresh to-do list.`,
        `. Let's see what needs a look today.`,
        ` — coffee in hand, dashboards ahead.`,
        `. Tidy queues, happy tenants — let's tidy up.`,
        ` — grab a coffee, we'll do the rounds.`,
        `. Another day of keeping Ogen shipshape.`,
        ` — coffee brewed, a few chores to clear.`,
        `. Small chores now, smooth sailing later.`,
        ` — steady coffee, steady operations.`,
        `. The overview's ready when you are.`,
        ` — coffee, then a calm sweep of the console.`,
        `. Let's clear the queue and sip slow.`,
        ` — keep the tenants running, keep the coffee flowing.`,
        `. Coffee up; the campaigns can wait a minute.`,
    ];
}

export function GreetingMessage() {
    const { user } = useAuth();
    const name = firstName(user?.name);
    // Sample the hour + a greeting once on mount; the name fills in reactively.
    const [pick] = useState(() => ({
        hour: new Date().getHours(),
        index: Math.floor(Math.random() * greetingsFor().length),
    }));
    return (
        <div>
            <span className="font-semibold">{salutation(pick.hour)}, {name}</span>
            <span className="font-light">{greetingsFor()[pick.index]}</span>
        </div>
    );
}
