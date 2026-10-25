"use client";

import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Clock01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Loader } from "@/components/ui/loader";
import { Switch } from "@/components/ui/switch";
import { Field } from "@/components/platforms/fields";
import { formatDateTime, inviteError } from "./format";
import { setSignupSettings, useSignupSettings } from "./useSignupSettings";
import type {
  SignupMode,
  SignupSettings,
  SignupSettingsResponse,
} from "./types";

// What each mode means, spelled out under the switch (CON-333 §6.1). The modes
// govern self-registration only: tester invites work in both.
const CONSEQUENCES: Record<SignupMode, { label: string; value: string }[]> = {
  invite_only: [
    {
      label: "Self-registration",
      value: "Off — strangers see “Ogen is in private beta”",
    },
    { label: "Tester invites", value: "On — the only way in for new people" },
    { label: "Extra workspaces per account", value: "" }, // filled from the cap
  ],
  open: [
    { label: "Self-registration", value: "On, as today" },
    { label: "Tester invites", value: "On — testers can still be invited" },
    { label: "Extra workspaces per account", value: "Unlimited" },
  ],
};

// The confirmation copy for each flip (CON-334 §1).
const CONFIRM: Record<
  SignupMode,
  { title: string; body: string; action: string }
> = {
  invite_only: {
    title: "Turn on invite-only mode?",
    body: "Self-registration will be turned off. Only people you invite will be able to create an Ogen workspace. Existing users keep access.",
    action: "Turn on",
  },
  open: {
    title: "Turn off invite-only mode?",
    body: "Anyone will be able to sign up again. Tester invites keep working — pending ones stay valid until they expire.",
    action: "Turn off",
  },
};

// SignupModeCard is the Signup mode page body (CON-334 §1, wireframe 1): one
// hero card whose control is the invite-only switch, the three consequences,
// the last change, and — only while invite-only is on — the workspace cap.
// Every flip asks first; saving is whole-resource (mode + cap together).
export function SignupModeCard() {
  const { loading, available, settings, error } = useSignupSettings();
  const [pending, setPending] = useState<SignupMode | null>(null);

  if (loading) {
    return (
      <Card>
        <div className="flex items-center gap-2 p-6 text-sm text-tertiary-foreground">
          <Loader className="size-4" />
          Loading signup mode…
        </div>
      </Card>
    );
  }
  if (error) {
    return (
      <Card>
        <p className="p-6 text-sm text-destructive">{error}</p>
      </Card>
    );
  }
  if (!available || !settings) {
    return (
      <Card>
        <p className="p-6 text-sm text-tertiary-foreground">
          The tenant-invite service is unavailable. Check that Ogen is running
          and that Harbor’s <code className="font-mono">OGEN_GRPC_ADDR</code> /{" "}
          <code className="font-mono">OGEN_GRPC_TOKEN</code> are configured.
        </p>
      </Card>
    );
  }

  const on = settings.mode === "invite_only";
  const cap = settings.maxOwnedWorkspaces;
  const consequences = CONSEQUENCES[settings.mode].map((c) =>
    c.value
      ? c
      : { ...c, value: cap > 0 ? `Capped at ${cap}` : "Unlimited (no cap set)" },
  );

  return (
    <div className="space-y-6">
      <Card>
        <div className="px-8 pt-8 pb-6">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
            Ogen invite-only mode
          </h2>
          <div className="mt-3 flex items-center gap-4">
            <span className="font-display text-[28px] leading-none font-medium tracking-tight text-foreground">
              {on ? "On" : "Off"}
            </span>
            <p className="min-w-0 flex-1 text-base text-secondary-foreground">
              {on
                ? "Self-registration is off. Only people you invite can create an Ogen workspace."
                : "Anyone can sign up. Tester invites still work."}
            </p>
            <Switch
              checked={on}
              onChange={(next) => setPending(next ? "invite_only" : "open")}
              label="Ogen invite-only mode"
              size="lg"
              variant="warning"
            />
          </div>
        </div>

        <dl className="mx-8 grid gap-6 border-t border-border py-6 sm:grid-cols-3">
          {consequences.map((c) => (
            <div key={c.label} className="min-w-0">
              <dt className="text-xs font-semibold uppercase tracking-wide text-tertiary-foreground">
                {c.label}
              </dt>
              <dd className="mt-2 text-sm font-medium text-foreground">
                {c.value}
              </dd>
            </div>
          ))}
        </dl>

        <div className="mx-8 flex items-center gap-2 border-t border-border py-5 text-[13px] text-tertiary-foreground">
          <HugeiconsIcon icon={Clock01Icon} className="size-4 shrink-0" />
          {settings.updatedAt ? (
            <span>
              Turned {on ? "on" : "off"}
              {settings.updatedBy && ` by ${settings.updatedBy}`} ·{" "}
              {formatDateTime(settings.updatedAt)}
            </span>
          ) : (
            <span>Never changed — Ogen starts in open mode.</span>
          )}
        </div>
      </Card>

      {on && <WorkspaceCapCard settings={settings} />}

      <ConfirmFlip
        target={pending}
        settings={settings}
        onClose={() => setPending(null)}
      />
    </div>
  );
}

// putSettings writes the whole resource and publishes the result to the shared
// store (the sidebar pill updates with it).
async function putSettings(
  mode: SignupMode,
  maxOwnedWorkspaces: number,
): Promise<SignupSettings> {
  const res = await fetch("/api/signup-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, maxOwnedWorkspaces }),
  });
  if (!res.ok) throw new Error((await inviteError(res)).message);
  const j = (await res.json()) as SignupSettingsResponse;
  setSignupSettings(j.settings);
  return j.settings;
}

function ConfirmFlip({
  target,
  settings,
  onClose,
}: {
  target: SignupMode | null;
  settings: SignupSettings;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        {target && (
          <ConfirmFlipBody
            target={target}
            settings={settings}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConfirmFlipBody({
  target,
  settings,
  onClose,
}: {
  target: SignupMode;
  settings: SignupSettings;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = CONFIRM[target];

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await putSettings(target, settings.maxOwnedWorkspaces);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t change the mode.");
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.body}</DialogDescription>
      </DialogHeader>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="defaultInverted" onClick={confirm} disabled={busy}>
          {busy ? "Saving…" : copy.action}
        </Button>
      </DialogFooter>
    </>
  );
}

// WorkspaceCapCard edits max owned workspaces per account (0 = unlimited). Only
// rendered while invite-only is on; Save sends mode + cap together.
function WorkspaceCapCard({ settings }: { settings: SignupSettings }) {
  const [value, setValue] = useState(String(settings.maxOwnedWorkspaces));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ msg: string; error?: boolean } | null>(
    null,
  );

  const parsed = Number(value);
  const valid = value.trim() !== "" && Number.isInteger(parsed) && parsed >= 0;
  const dirty = valid && parsed !== settings.maxOwnedWorkspaces;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty) return;
    setBusy(true);
    setNotice(null);
    try {
      const s = await putSettings(settings.mode, parsed);
      setValue(String(s.maxOwnedWorkspaces));
      setNotice({ msg: "Saved." });
    } catch (err) {
      setNotice({
        msg: err instanceof Error ? err.message : "Couldn’t save the cap.",
        error: true,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="border-b border-border px-6 py-4">
        <h2 className="text-sm font-medium text-foreground">Workspace cap</h2>
        <p className="mt-1 max-w-xl text-xs text-tertiary-foreground">
          While invite-only mode is on, an account can own this many
          workspaces. Workspaces from tester invites count; deleted ones don’t.
        </p>
      </div>
      <form
        onSubmit={save}
        className="flex flex-wrap items-end justify-between gap-4 px-6 py-5"
      >
        <Field
          label="Max owned workspaces per account"
          htmlFor="signup-cap"
          hint={
            !valid ? (
              <span className="text-destructive">
                A whole number, 0 or more.
              </span>
            ) : (
              "0 = unlimited"
            )
          }
          className="w-80"
        >
          <Input
            id="signup-cap"
            type="number"
            inputMode="numeric"
            min={0}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
          />
        </Field>
        <div className="flex items-center gap-3 pb-6">
          {notice && (
            <span
              role={notice.error ? "alert" : "status"}
              className={
                notice.error
                  ? "text-xs text-destructive"
                  : "text-xs text-tertiary-foreground"
              }
            >
              {notice.msg}
            </span>
          )}
          <Button
            type="submit"
            variant="defaultInverted"
            size="sm"
            className="font-semibold"
            disabled={!dirty || busy}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl bg-primary">{children}</div>;
}
