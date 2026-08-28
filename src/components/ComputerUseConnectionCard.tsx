import { useState } from "react";
import { Check, Circle, ExternalLink, Monitor, ShieldCheck } from "lucide-react";

import { useDesktopCapabilities } from "./DesktopCapabilities";
import { VerifiedConnectionCard, type VerifiedConnectionState } from "./VerifiedConnectionCard";

const PERMISSION_REASONS = new Set([
  "cua-accessibility-and-screen-required",
  "cua-accessibility-required",
  "cua-screen-recording-required",
]);

type SetupStepState = "ready" | "needed" | "pending";

export function computerUsePermissionSteps(
  computer: DesktopCapabilities["localComputer"],
): { accessibility: SetupStepState; screen: SetupStepState } {
  if (computer.available) return { accessibility: "ready", screen: "ready" };
  switch (computer.reasonCode) {
    case "cua-accessibility-and-screen-required":
      return { accessibility: "needed", screen: "needed" };
    case "cua-accessibility-required":
      return { accessibility: "needed", screen: "ready" };
    case "cua-screen-recording-required":
      return { accessibility: "ready", screen: "needed" };
    default:
      return { accessibility: "pending", screen: "pending" };
  }
}

function SetupRow({
  number,
  title,
  detail,
  state,
  action,
}: {
  number: number;
  title: string;
  detail: string;
  state: SetupStepState;
  action?: { label: string; onClick: () => void };
}) {
  const ready = state === "ready";
  return (
    <li className="flex min-w-0 gap-3 border-t border-line py-3 first:border-t-0 first:pt-0 last:pb-0">
      <span
        aria-hidden="true"
        className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${
          ready ? "border-agency/35 bg-selected text-agency" : state === "needed" ? "border-hold/45 bg-hold/10 text-hold" : "border-line bg-paper text-ink-muted"
        }`}
      >
        {ready ? <Check size={13} strokeWidth={2.4} /> : number}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className="text-[12.5px] font-semibold text-ink">{title}</p>
          <span className={`inline-flex items-center gap-1 text-[11.5px] font-medium ${ready ? "text-agency" : state === "needed" ? "text-hold" : "text-ink-muted"}`}>
            {ready ? <Check size={12} /> : <Circle size={10} />}
            {ready ? "Ready" : state === "needed" ? "Action needed" : "Checked during setup"}
          </span>
        </div>
        <p className="mt-0.5 max-w-[48rem] text-[12px] leading-relaxed text-ink-muted">{detail}</p>
        {action ? (
          <button
            type="button"
            onClick={action.onClick}
            className="pm-control pm-tactile mt-2 inline-flex items-center gap-1.5 rounded border border-line bg-sheet px-3 text-[12px] font-semibold text-ink hover:border-agency/60 hover:bg-selected/45"
          >
            {action.label} <ExternalLink size={12} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </li>
  );
}

export function ComputerUseSetupChecklist({
  computer,
  onOpenSettings,
}: {
  computer: DesktopCapabilities["localComputer"];
  onOpenSettings?: (pane: "accessibility" | "screen") => void;
}) {
  const permissions = computerUsePermissionSteps(computer);
  const included = computer.runtime === "bundled" || computer.runtime === "development";
  const runtimeDetail = computer.runtime === "bundled"
    ? "Included with RealBud. No separate driver download or installation is needed."
    : computer.runtime === "development"
      ? "This source build found its checkout-owned runtime. An installed RealBud build carries its own private copy."
      : "This RealBud installation is missing its private runtime and must be repaired before permissions are requested.";
  const permissionDetail = (kind: "accessibility" | "screen", state: SetupStepState) => {
    if (!included) return "Checked only after the private RealBud runtime is repaired.";
    if (state === "ready") return `macOS reported ${kind === "accessibility" ? "Accessibility" : "screen recording"} access for RealBud.`;
    if (kind === "accessibility") {
      return state === "needed"
        ? "In System Settings → Privacy & Security → Accessibility, switch on RealBud."
        : "macOS will ask before RealBud controls an approved browser window.";
    }
    return state === "needed"
      ? "In System Settings → Privacy & Security → Screen & System Audio Recording, switch on RealBud. Older macOS versions call this Screen Recording."
      : "macOS will ask before RealBud can read the approved browser window.";
  };
  return (
    <div aria-label="Computer use setup steps">
      <div className="mb-3 flex items-start gap-2.5">
        <ShieldCheck size={16} className="mt-0.5 shrink-0 text-agency" aria-hidden="true" />
        <div>
          <p className="text-[12.5px] font-semibold text-ink">Set up on this Mac</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">
            RealBud checks two macOS permissions. Setup does not start a property task or grant background approval.
          </p>
        </div>
      </div>
      <ol>
        <SetupRow
          number={1}
          title="Private computer-use runtime"
          state={included ? "ready" : "needed"}
          detail={runtimeDetail}
        />
        <SetupRow
          number={2}
          title="Accessibility"
          state={permissions.accessibility}
          detail={permissionDetail("accessibility", permissions.accessibility)}
          action={permissions.accessibility === "needed" && onOpenSettings
            ? { label: "Open Accessibility", onClick: () => onOpenSettings("accessibility") }
            : undefined}
        />
        <SetupRow
          number={3}
          title="Screen & System Audio Recording"
          state={permissions.screen}
          detail={permissionDetail("screen", permissions.screen)}
          action={permissions.screen === "needed" && onOpenSettings
            ? { label: "Open Screen Recording", onClick: () => onOpenSettings("screen") }
            : undefined}
        />
      </ol>
      <div className="mt-3 border-l-2 border-agency/35 pl-3 text-[11.5px] leading-relaxed text-ink-muted">
        Choose <strong className="font-semibold text-ink">RealBud</strong> in Privacy & Security. App Management is not part of this setup; leave any separate helper or personal automation entry unchanged.
      </div>
      {PERMISSION_REASONS.has(computer.reasonCode ?? "") ? (
        <p className="mt-2 text-[11.5px] leading-relaxed text-ink-muted">
          After switching access on, return here and choose <strong className="font-semibold text-ink">Check again</strong>. If macOS still reports it missing, quit and reopen RealBud once.
        </p>
      ) : null}
    </div>
  );
}

export function ComputerUseConnectionCard() {
  const desktop = useDesktopCapabilities();
  const [busy, setBusy] = useState(false);
  const [enableFailed, setEnableFailed] = useState(false);
  const capabilities = desktop.capabilities;
  const ready = desktop.ready;
  const computer = capabilities.localComputer;
  const mac = capabilities.host.platform === "darwin";
  const permissionNeeded = PERMISSION_REASONS.has(computer.reasonCode ?? "");
  const desktopBridge = typeof window === "undefined" ? undefined : window.ogb;

  let state: VerifiedConnectionState = "checking";
  let status = "Checking…";
  let description = "Checking RealBud's private computer-use runtime.";
  let meta = "No separate personal automation or worker installation is inspected or changed.";

  if (busy) {
    state = "checking";
    status = computer.available ? "Turning off…" : "Starting…";
    description = computer.available
      ? "Stopping RealBud's private computer-use host and revoking its current case-scoped policy."
      : "macOS may ask for Accessibility and Screen & System Audio Recording. RealBud continues only after both grants are present.";
  } else if (enableFailed) {
    state = "attention";
    status = "Could not start";
    description = "RealBud could not start computer-use setup. Reopen the app and try again; Desk, Ask and Schedule are unaffected.";
  } else if (ready) {
    if (computer.available) {
      state = "ready";
      status = "Ready";
      description = "Computer use is set up. RealBud starts a fresh case-scoped browser session only for an approved check.";
      meta = "Permission check only while idle · case-scoped browser access · no broad desktop control";
    } else if (!mac) {
      state = "off";
      status = capabilities.host.label === "Browser" ? "Desktop app only" : "macOS pilot only";
      description = "Local computer use is unavailable on this platform. Desk, Ask, Schedule and file intake still work.";
    } else if (computer.reasonCode === "cua-bundle-missing") {
      state = "attention";
      status = "Repair install";
      description = "RealBud's bundled computer-use runtime is missing. Reinstall this RealBud build; a separate personal copy will not be used.";
    } else if (computer.reasonCode === "cua-not-enabled") {
      state = "off";
      status = computer.runtime === "bundled" ? "Included" : "Developer setup";
      description = "Computer use is included but off. Set it up only when you want RealBud to prepare a visible, approved browser handoff.";
      meta = "First setup requests macOS permission · no background actions · you make the final Submit";
    } else if (computer.reasonCode === "cua-session-expired") {
      state = "attention";
      status = "Session expired";
      description = "The previous permission-check session expired. Restart it before RealBud prepares another approved browser handoff.";
      meta = "Expired grants are never treated as ready · restarting creates a new bounded policy";
    } else if (permissionNeeded) {
      state = "attention";
      status = "Permissions needed";
      description = "Grant the missing access to RealBud in macOS System Settings, then return here to check it.";
      meta = "The grants belong to RealBud · permissions from other automation apps are neither read nor reused";
    } else if (computer.reasonCode === "package-smoke-disabled") {
      state = "off";
      status = "QA launch disabled";
      description = "The bundled runtime is present. This isolated package check deliberately did not request macOS control permissions.";
    } else {
      state = "attention";
      status = "Needs attention";
      description = "RealBud could not start its private computer-use runtime. Reopen the app; if it continues, use Advanced diagnostics.";
    }
  }

  const enable = async () => {
    if (!desktopBridge?.enableComputerUse || busy) return;
    setBusy(true);
    setEnableFailed(false);
    try {
      desktop.replace(await desktopBridge.enableComputerUse());
    } catch {
      setEnableFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const disable = async () => {
    if (!desktopBridge?.disableComputerUse || busy) return;
    setBusy(true);
    setEnableFailed(false);
    try {
      desktop.replace(await desktopBridge.disableComputerUse());
    } catch {
      setEnableFailed(true);
      await desktop.refresh();
    } finally {
      setBusy(false);
    }
  };
  const openSettings = (pane: "accessibility" | "screen") => {
    void desktopBridge?.permOpenSettings(pane);
  };
  const showChecklist = ready && mac && (
    computer.reasonCode === "cua-not-enabled" || permissionNeeded || computer.reasonCode === "cua-bundle-missing"
  );
  const action = ready && mac && desktopBridge?.enableComputerUse
    ? enableFailed
      ? { label: "Try again", onClick: () => void enable(), disabled: busy }
      : computer.available
        ? { label: "Turn off", onClick: () => void disable(), disabled: busy }
      : computer.reasonCode === "cua-not-enabled"
        ? { label: "Set up", onClick: () => void enable(), disabled: busy }
        : permissionNeeded || computer.reasonCode === "cua-session-expired"
          ? { label: "Check again", onClick: () => void enable(), disabled: busy }
          : undefined
    : undefined;
  return (
    <VerifiedConnectionCard
      icon={<Monitor size={18} />}
      title="Computer use"
      description={description}
      meta={meta}
      state={state}
      status={status}
      action={action}
      details={showChecklist
        ? <ComputerUseSetupChecklist computer={computer} onOpenSettings={desktopBridge?.permOpenSettings ? openSettings : undefined} />
        : undefined}
    />
  );
}
