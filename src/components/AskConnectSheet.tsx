import { useEffect, useRef } from "react";
import { BellRing, Cable, ChevronLeft, CircleAlert, Mail, X } from "lucide-react";

import type { AskConnectRequest } from "@shared/ask-actions";
import { ASK_CONNECTION_OPTIONS, askConnectionOption, resolveAskOfficeTool } from "@shared/ask-connections";
import { cn } from "@/lib/cn";
import { askConnectBookSubtitle, askConnectHeading, askConnectMailSubtitle, askConnectPanel, suggestedOfficeName } from "@/lib/ask-connect";
import { workerSetupStep, workerVerified } from "@/lib/onboarding";
import { useStore } from "@/state/store";
import { AskConnectionPicker } from "./AskConnectionPicker";
import { ComposioAccountCard } from "./ComposioAccountCard";
import { ComputerUseConnectionCard } from "./ComputerUseConnectionCard";
import { AskBookConnectCard } from "./AskBookConnectCard";
import { AskToolConnectCard } from "./AskToolConnectCard";
import { PocketConnectionCard } from "./PocketConnectionCard";
import { VerifiedConnectionCard } from "./VerifiedConnectionCard";

function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((node) => !node.hasAttribute("disabled") && node.offsetParent !== null);
}

function ConnectNote({ children }: { children: string }) {
  return <p className="text-[13px] leading-relaxed text-ink-muted">{children}</p>;
}

function WorkerConnectPanel({
  onOpenSetupJourney,
  onClose,
}: {
  onOpenSetupJourney?: () => void;
  onClose: () => void;
}) {
  const { state } = useStore();
  const step = workerSetupStep({
    worker: state.hermes,
    workerIsVerified: workerVerified(state.hermes),
  });
  return (
    <div className="space-y-3">
      <ConnectNote>{step.detail}</ConnectNote>
      {step.state !== "done" && onOpenSetupJourney ? (
        <button
          type="button"
          onClick={() => {
            onClose();
            onOpenSetupJourney();
          }}
          className="pm-control pm-tactile min-h-11 rounded bg-agency px-3 text-[13px] font-semibold text-white hover:bg-agency-hover"
        >
          {step.title}
        </button>
      ) : null}
    </div>
  );
}

function RemindersConnectPanel() {
  const { state, dispatch } = useStore();
  const bud = state.bots.find((bot) => bot.id === "bud" || bot.name === "Bud") ?? state.bots[0];
  const available = Boolean(window.ogb?.notifyRoutine);
  const on = Boolean(bud?.notifications);
  return (
    <VerifiedConnectionCard
      icon={<BellRing size={18} />}
      title="Desktop reminders"
      description="Alerts only when a routine fails, is missed, is interrupted, or leaves held work. The banner contains no property, tenant or balance details."
      meta="Local desktop only · never messages a tenant, owner or tradie"
      state={!available ? "off" : on ? "ready" : "off"}
      status={!available ? "Desktop app only" : on ? "On" : "Off"}
      action={!available || !bud
        ? undefined
        : { label: on ? "Turn off" : "Turn on", onClick: () => dispatch({ type: "updateBot", botId: bud.id, patch: { notifications: !bud.notifications } }) }}
    />
  );
}

function UnsupportedConnectPanel() {
  const { dispatch } = useStore();
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-ink-muted">
        RealBud connects the property book, inbox, calendar, portals on this Mac, and the PM's own Pocket channel. Social accounts stay out. Nothing connected.
      </p>
      <p className="text-[12px] font-semibold text-ink">If you meant an office source</p>
      <AskConnectionPicker
        collapseMore
        options={ASK_CONNECTION_OPTIONS.map(({ id, label, detail, target, service }) => ({
          id, label, detail, target, service,
        }))}
        onChoose={(id) => {
          const option = askConnectionOption(id);
          if (!option) return;
          dispatch({ type: "pushAskConnect", target: option.target, service: option.service });
        }}
      />
    </div>
  );
}

function SourcePanel({
  request,
  onClose,
}: {
  request: AskConnectRequest;
  onClose: () => void;
}) {
  const { dispatch } = useStore();
  const panel = askConnectPanel(request);
  const suggested = suggestedOfficeName(request.service);
  const closeToAsk = () => {
    onClose();
    requestAnimationFrame(() => {
      const attach = document.getElementById("ask-attach-files") as HTMLButtonElement | null;
      if (attach) attach.click();
      else document.getElementById("ask-bud-composer")?.focus();
    });
  };
  if (panel === "mail") {
    return (
      <AskToolConnectCard
        service={request.service}
        onAttachInAsk={closeToAsk}
      />
    );
  }
  if (panel === "book") {
    return <AskBookConnectCard suggestedName={suggested} onAttachInAsk={closeToAsk} />;
  }
  if (panel === "api") {
    return (
      <div className="space-y-3">
        <ConnectNote>Governed read adapters only. Raw tools and pasted server URLs stay out.</ConnectNote>
        <AskConnectionPicker
          collapseMore
          options={ASK_CONNECTION_OPTIONS.filter((item) => item.id === "api-mcp" || item.id === "composio-account").map(({ id, label, detail, target, service }) => ({
            id, label, detail, target, service,
          }))}
          onChoose={(id) => {
            const option = askConnectionOption(id);
            if (!option) return;
            dispatch({ type: "pushAskConnect", target: option.target, service: option.service });
          }}
        />
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <ConnectNote>Pick the book, inbox or portal this office already uses.</ConnectNote>
      <AskConnectionPicker
        collapseMore
        options={ASK_CONNECTION_OPTIONS.map(({ id, label, detail, target, service }) => ({
          id, label, detail, target, service,
        }))}
        onChoose={(id) => {
          const option = askConnectionOption(id);
          if (!option) return;
          dispatch({ type: "pushAskConnect", target: option.target, service: option.service });
        }}
      />
    </div>
  );
}

export function AskConnectSheet({
  request,
  onClose,
  onBack,
  canBack = false,
  onOpenSetupJourney,
}: {
  request: AskConnectRequest;
  onClose: () => void;
  onBack?: () => void;
  canBack?: boolean;
  onOpenSetupJourney?: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const { state } = useStore();
  const panel = askConnectPanel(request);
  const heading = askConnectHeading(request);
  const subtitle = panel === "mail"
    ? askConnectMailSubtitle(
      Boolean(state.config?.composio.configured),
      Boolean(resolveAskOfficeTool(request.service ?? "")?.composioSlug),
    )
    : panel === "book"
      ? askConnectBookSubtitle()
      : panel === "pocket-whatsapp" || panel === "pocket-telegram"
        ? "One named PM channel. Keys stay on this device."
        : panel === "computer-use"
          ? "Case-scoped browser handoffs. You keep Submit."
          : panel === "reminders"
            ? "Local alerts only. Never a message."
            : panel === "worker"
              ? "Private worker and model. Keys stay on this device."
              : panel === "composio"
                ? "Sign in, then paste the Connect key. Not a marketplace."
                : panel === "unsupported"
                  ? "That name is not a RealBud source. Nothing connected."
                  : "Keys stay on this device. Nothing connects automatically.";

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = dialogRef.current;
    const first = root ? focusable(root)[0] : null;
    (first ?? root)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (canBack && onBack) onBack();
        else onClose();
        return;
      }
      if (event.key !== "Tab" || !root) return;
      const nodes = focusable(root);
      if (!nodes.length) return;
      const firstNode = nodes[0]!;
      const lastNode = nodes[nodes.length - 1]!;
      if (event.shiftKey && document.activeElement === firstNode) {
        event.preventDefault();
        lastNode.focus();
      } else if (!event.shiftKey && document.activeElement === lastNode) {
        event.preventDefault();
        firstNode.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus({ preventScroll: true });
    };
  }, [canBack, onBack, onClose, request.target, request.service]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-ink/25"
        role="presentation"
        onMouseDown={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ask-connect-title"
        aria-describedby="ask-connect-description"
        tabIndex={-1}
        className="relative z-[1] flex max-h-[min(44rem,calc(100vh-2rem))] w-full max-w-[36rem] flex-col overflow-hidden rounded-lg border border-line bg-sheet shadow-[0_18px_60px_rgb(37_35_31/0.16)] outline-none"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-line px-4 py-3.5">
          <span className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded border",
            panel === "unsupported" ? "border-hold/40 bg-hold/10 text-hold" : "border-line bg-paper text-agency",
          )}>
            {panel === "unsupported"
              ? <CircleAlert size={17} aria-hidden="true" />
              : panel === "mail" ? <Mail size={17} aria-hidden="true" /> : <Cable size={17} aria-hidden="true" />}
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="ask-connect-title" className="text-[16px] font-semibold text-ink">{heading}</h2>
            <p id="ask-connect-description" className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">{subtitle}</p>
          </div>
          {canBack && onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="pm-control pm-tactile inline-flex min-h-10 shrink-0 items-center gap-1 rounded px-2 text-[13px] font-medium text-ink hover:bg-paper"
            >
              <ChevronLeft size={16} aria-hidden="true" /> Back
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close connection card"
            className="pm-control pm-tactile flex size-10 shrink-0 items-center justify-center rounded text-ink-muted hover:bg-paper hover:text-ink"
          >
            <X size={17} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {panel === "pocket-whatsapp" ? <PocketConnectionCard visibleChannels={["whatsapp-business"]} /> : null}
          {panel === "pocket-telegram" ? <PocketConnectionCard visibleChannels={["telegram"]} /> : null}
          {panel === "computer-use" ? <ComputerUseConnectionCard /> : null}
          {panel === "reminders" ? <RemindersConnectPanel /> : null}
          {panel === "worker" ? <WorkerConnectPanel onOpenSetupJourney={onOpenSetupJourney} onClose={onClose} /> : null}
          {panel === "composio" ? <ComposioAccountCard /> : null}
          {panel === "unsupported" ? <UnsupportedConnectPanel /> : null}
          {panel === "mail" || panel === "book" || panel === "sources" || panel === "api"
            ? <SourcePanel request={request} onClose={onClose} />
            : null}
        </div>

        <footer className="flex shrink-0 justify-end border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="pm-control pm-tactile min-h-10 rounded bg-agency px-3.5 text-[13px] font-semibold text-white hover:bg-agency-hover"
          >
            {panel === "unsupported" ? "Close" : "Done"}
          </button>
        </footer>
      </div>
    </div>
  );
}
