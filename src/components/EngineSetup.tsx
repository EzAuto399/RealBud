// Setup UI for an engine that isn't ready — shared by the model picker
// and the chat's "engine missing" card so both say the same thing from
// the same data. First-run onboarding does not list engines.
//
// Everything here is driven by the driver-declared install descriptor
// (server/contracts.ts EngineInstall), never by per-engine copy in the UI.
// An engine with no command for this platform shows its docs link instead of
// an instruction that cannot run there.
//
// Installing is only half the job: most CLIs then need an interactive
// sign-in, which is why the terminal is the destination rather than a
// background `npm install` the user never sees.
import { useState } from "react";
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import type { EngineInstall, InstanceInfo } from "@/state/store";
import { cn } from "@/lib/cn";

type Platform = "darwin" | "win32" | "linux";

function hostPlatform(): Platform {
  const p = window.ogb?.platform;
  if (p === "darwin" || p === "win32" || p === "linux") return p;
  // browser/dev shell — guess from the UA so the copy button still offers
  // something sensible, since there's no bridge to ask
  const ua = navigator.userAgent;
  if (ua.includes("Mac")) return "darwin";
  if (ua.includes("Win")) return "win32";
  return "linux";
}

/** The install command for this machine, or null when the engine has none
 * here (a GUI download, or a POSIX-only installer viewed on Windows). */
export function installCommandFor(install: EngineInstall | undefined): string | null {
  return install?.command?.[hostPlatform()] ?? null;
}

/** True when the engine is installed but not yet signed in — the state that
 * looks ready in the picker but still can't answer a message. */
export function needsSignIn(instance: InstanceInfo | undefined): boolean {
  return instance?.snapshot.state === "available" && instance.snapshot.authenticated === false;
}

function CommandRow({ command, instanceId }: { command: string; instanceId: string }) {
  const [done, setDone] = useState<"ran" | "copied" | "failed" | null>(null);
  const [busy, setBusy] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setDone("copied");
      setTimeout(() => setDone(null), 2000);
    } catch {
      /* clipboard blocked — the command is on screen to select by hand */
    }
  };

  const allow = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
      if (res.ok && body.ok) {
        setDone("ran");
      } else {
        await navigator.clipboard.writeText(command).catch(() => {});
        setDone("failed");
      }
    } catch {
      await navigator.clipboard.writeText(command).catch(() => {});
      setDone("failed");
    } finally {
      setBusy(false);
      setTimeout(() => setDone(null), 4000);
    }
  };

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={allow}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
          {done === "ran" ? "Opened Terminal" : done === "failed" ? "Copied — paste in Terminal" : "Allow"}
        </button>
        <button
          onClick={copy}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          {done === "copied" ? <Check size={13} /> : <Copy size={13} />}
          {done === "copied" ? "Copied" : "Copy"}
        </button>
      </div>
      <code className="block overflow-x-auto font-mono text-[11px] leading-relaxed text-ink-secondary/70">
        {command}
      </code>
    </div>
  );
}

export function EngineSetup({
  instance,
  className,
}: {
  instance: InstanceInfo;
  className?: string;
}) {
  const install = instance.install;
  const command = installCommandFor(install);
  const signIn = install?.signInCommand;
  const signInOnly = needsSignIn(instance);

  // No install descriptor at all means this isn't something you install —
  // the Box cloud runner is configured with a token in settings, not a CLI.
  // Claiming it "isn't installed" would send the user hunting for a package
  // that doesn't exist, so defer to whatever the driver reported instead.
  if (!install) {
    return (
      <div className={cn("text-[12.5px] leading-relaxed text-ink-secondary", className)}>
        {instance.snapshot.reason ?? "Not available on this machine."}
      </div>
    );
  }

  return (
    <div className={cn("text-[12.5px] leading-relaxed text-ink-secondary", className)}>
      {signInOnly ? (
        <>
          <p>
            {instance.displayName} is installed but not signed in yet. Allow RealBud to open Terminal and run the sign-in, then come back.
          </p>
          {signIn && <CommandRow command={signIn} instanceId={instance.instanceId} />}
        </>
      ) : (
        <>
          {command ? (
            <>
              <p>
                {instance.displayName} isn&rsquo;t installed. Allow RealBud to open Terminal and run the installer
                {signIn ? `, then \`${signIn}\` to sign in` : ""}.
              </p>
              <CommandRow command={command} instanceId={instance.instanceId} />
              {install?.needsNode && (
                <p className="mt-1.5 text-[11.5px] text-ink-secondary/70">
                  Needs Node.js — install it first if <code className="font-mono">npm</code> isn&rsquo;t
                  found.
                </p>
              )}
            </>
          ) : (
            <p>
              {instance.displayName} isn&rsquo;t installed, and has no one-line installer for this
              platform.
            </p>
          )}
        </>
      )}

      {install?.docsUrl && (
        <a
          href={install.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1.5 text-[12.5px] text-accent hover:underline"
        >
          <ExternalLink size={12} /> Setup guide
        </a>
      )}
    </div>
  );
}
