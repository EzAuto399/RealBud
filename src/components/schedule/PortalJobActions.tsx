import { useState } from "react";
import { CheckCircle2, Link2, Loader2, Play } from "lucide-react";

import { fmtDate } from "@/lib/au";
import type { JobRun, Recipe } from "@/lib/desk";
import { attendedRunLabel, latestAttendedFor, queuedAttended, runningAttended } from "@/lib/job-run";
import {
  isLiveCapableHost,
  recipeAttachment,
  recipeCanAttach,
  recipeHasSubmitCapability,
  recipePlanApproved,
  recipePortalSiteLine,
  recipeSubmitAcknowledged,
} from "@/lib/portal-job";
import { api } from "@/state/store";
import { useDesktopCapabilities } from "../DesktopCapabilities";
import { StatusLabel } from "../pm";

function recipeFromPatch(body: { recipe?: Recipe; recipes?: Recipe[] }, id: string): Recipe | undefined {
  return body.recipe ?? body.recipes?.find((item) => item.id === id);
}

export function PortalJobActions({
  recipe,
  runs,
  onRecipe,
  onRun,
  onShowAsk,
}: {
  recipe: Recipe;
  runs: readonly JobRun[];
  onRecipe: (recipe: Recipe) => void;
  onRun: (run: JobRun) => void;
  onShowAsk: () => void;
}) {
  const { capabilities } = useDesktopCapabilities();
  const [ackOpen, setAckOpen] = useState(false);
  const [busy, setBusy] = useState<"attach" | "detach" | "attend" | "approve" | "submit" | null>(null);
  const [attendError, setAttendError] = useState("");
  const [announce, setAnnounce] = useState("");
  const attachment = recipeAttachment(recipe);
  const liveHost = isLiveCapableHost(capabilities.host.platform);
  const planOk = recipePlanApproved(recipe);
  const live = runningAttended(runs, recipe.id);
  const queued = queuedAttended(runs, recipe.id);
  const latestAttended = latestAttendedFor(runs, recipe.id);
  const statusRun = queued ?? latestAttended;
  const status = statusRun ? attendedRunLabel(statusRun) : null;
  const canRun = planOk && attachment != null && liveHost && !live && !queued && busy !== "attend";
  const canStartQueued = Boolean(queued) && liveHost && !live && busy !== "attend";
  const needsPlan = !planOk;
  const needsAttach = attachment == null && recipeCanAttach(recipe);
  const combineApproveAttach = needsPlan && needsAttach;
  const submitAt = recipeSubmitAcknowledged(recipe);
  const canSubmit = recipeHasSubmitCapability(recipe);

  const patchRecipe = async (body: Record<string, unknown>): Promise<Recipe> => {
    const nextBody = (await api(
      `/api/recipes/${recipe.id}`,
      { method: "PATCH", body: JSON.stringify(body) },
      { timeoutMs: 15_000 },
    )) as { recipe?: Recipe; recipes?: Recipe[] };
    const next = recipeFromPatch(nextBody, recipe.id);
    if (!next) throw new Error("RealBud could not update that job.");
    onRecipe(next);
    return next;
  };

  const patchAttach = async (attach: boolean) => {
    setBusy(attach ? "attach" : "detach");
    setAttendError("");
    try {
      const next = await patchRecipe({ attach });
      setAckOpen(false);
      const nextAttachment = recipeAttachment(next);
      setAnnounce(nextAttachment ? `Attached ${fmtDate(nextAttachment.attachedAt)}` : "Detached");
    } catch (cause) {
      setAttendError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const approvePlan = async () => {
    setBusy("approve");
    setAttendError("");
    try {
      await patchRecipe({ planApproved: true, status: "active" });
      setAnnounce("Plan approved");
    } catch (cause) {
      setAttendError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const approveAndAttach = async () => {
    setBusy("approve");
    setAttendError("");
    try {
      await patchRecipe({ planApproved: true, status: "active" });
      const next = await patchRecipe({ attach: true });
      setAckOpen(false);
      const nextAttachment = recipeAttachment(next);
      setAnnounce(nextAttachment ? `Approved and attached ${fmtDate(nextAttachment.attachedAt)}` : "Approved and attached");
    } catch (cause) {
      setAttendError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const patchSubmit = async (on: boolean) => {
    setBusy("submit");
    setAttendError("");
    try {
      await patchRecipe({ submitAcknowledged: on });
      setAnnounce(on ? "Submit asks on" : "Submit asks off");
    } catch (cause) {
      if (!on) {
        setAttendError("That could not be turned off here. Edit the job to clear Submit asks.");
      } else {
        setAttendError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setBusy(null);
    }
  };

  const attend = async (runId?: string) => {
    if (runId ? !canStartQueued : !canRun) return;
    setBusy("attend");
    setAttendError("");
    try {
      const body = (await api(
        `/api/recipes/${recipe.id}/attend`,
        { method: "POST", body: runId ? JSON.stringify({ runId }) : undefined },
      )) as { run?: JobRun };
      if (!body.run) throw new Error("Bud could not start that run.");
      onRun(body.run);
      const text = `Running ${recipe.title} beside you — answer Bud's requests in Ask; sign in when the page asks.`;
      setAnnounce(text);
      onShowAsk();
    } catch (cause) {
      setAttendError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-3 space-y-2">
      <p className="text-[12.5px] text-ink-muted">{recipePortalSiteLine(recipe)}</p>
      {status ? (
        <StatusLabel tone={status.tone}>
          {status.tone === "agency" && live ? (
            <Loader2 size={12} className="animate-spin motion-reduce:animate-none" aria-hidden />
          ) : status.tone === "agency" ? (
            <CheckCircle2 size={12} aria-hidden />
          ) : null}
          {status.label}
        </StatusLabel>
      ) : null}

      {combineApproveAttach ? (
        <div className="rounded-lg border border-line bg-inset/40 px-3 py-2.5">
          <p className="text-[13px] font-medium text-ink">Approve and attach</p>
          <ul className="mt-1.5 space-y-1 text-[12.5px] leading-relaxed text-ink-secondary">
            <li>You sign in yourself; Bud never types a password.</li>
            <li>Bud reads and prefills only.</li>
            <li>Submit, Pay and Send stay with you.</li>
            <li>This approves the current plan (revision shown on the card).</li>
          </ul>
          <button
            type="button"
            disabled={busy != null}
            onClick={() => void approveAndAttach()}
            className="pm-decision mt-2 inline-flex items-center gap-1.5 rounded-lg bg-agency px-3 text-[13px] font-medium text-white hover:bg-agency-hover disabled:opacity-40"
          >
            {busy === "approve" ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <CheckCircle2 size={13} aria-hidden />}
            Approve plan and attach site
          </button>
        </div>
      ) : null}

      {needsPlan && !needsAttach ? (
        <button
          type="button"
          disabled={busy != null}
          onClick={() => void approvePlan()}
          className="pm-decision inline-flex items-center gap-1.5 rounded-lg bg-agency px-3 text-[13px] font-medium text-white hover:bg-agency-hover disabled:opacity-40"
        >
          {busy === "approve" ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <CheckCircle2 size={13} aria-hidden />}
          Approve plan
        </button>
      ) : null}

      {!combineApproveAttach && attachment == null && recipeCanAttach(recipe) && !ackOpen ? (
        <button
          type="button"
          disabled={busy != null}
          onClick={() => setAckOpen(true)}
          className="pm-control inline-flex items-center gap-1.5 rounded-lg border border-line bg-sheet px-3 text-[12.5px] text-ink hover:bg-raised disabled:opacity-40"
        >
          <Link2 size={13} aria-hidden />
          Attach this site
        </button>
      ) : null}

      {!combineApproveAttach && attachment == null && recipeCanAttach(recipe) && ackOpen ? (
        <div className="rounded-lg border border-line bg-inset/40 px-3 py-2.5">
          <ul className="space-y-1 text-[12.5px] leading-relaxed text-ink-secondary">
            <li>You sign in yourself; Bud never types a password.</li>
            <li>Bud reads and prefills only.</li>
            <li>Submit, Pay and Send stay with you.</li>
          </ul>
          <button
            type="button"
            disabled={busy != null}
            onClick={() => void patchAttach(true)}
            className="pm-decision mt-2 inline-flex items-center gap-1.5 rounded-lg bg-agency px-3 text-[13px] font-medium text-white hover:bg-agency-hover disabled:opacity-40"
          >
            {busy === "attach" ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <CheckCircle2 size={13} aria-hidden />}
            I understand — attach
          </button>
        </div>
      ) : null}

      {attachment ? (
        <div className="flex flex-wrap items-center gap-2">
          <StatusLabel tone="agency">
            <CheckCircle2 size={12} aria-hidden />
            Attached {fmtDate(attachment.attachedAt)}
          </StatusLabel>
          <button
            type="button"
            disabled={busy != null || Boolean(live)}
            onClick={() => void patchAttach(false)}
            className="text-[12px] text-ink-muted underline-offset-2 hover:text-ink hover:underline disabled:opacity-40"
          >
            {busy === "detach" ? "Detaching…" : "Detach"}
          </button>
        </div>
      ) : null}

      {attachment ? (
        submitAt != null ? (
          <div className="flex flex-wrap items-center gap-2">
            <StatusLabel tone="hold">Submit asks on</StatusLabel>
            <button
              type="button"
              disabled={busy != null}
              onClick={() => void patchSubmit(false)}
              className="text-[12px] text-ink-muted underline-offset-2 hover:text-ink hover:underline disabled:opacity-40"
            >
              {busy === "submit" ? "Turning off…" : "Turn off"}
            </button>
          </div>
        ) : (
          <details className="rounded-lg border border-line bg-inset/30 px-3 py-2">
            <summary className="cursor-pointer text-[12.5px] font-medium text-ink">Bud may press Submit</summary>
            <ul className="mt-1.5 space-y-1 text-[12.5px] leading-relaxed text-ink-secondary">
              <li>Only forms that are not payments, transfers, notices or signatures.</li>
              <li>Bud shows you each form first and asks every time.</li>
              <li>Pay, Transfer, Sign, Send and Delete stay with you, always.</li>
            </ul>
            {canSubmit ? (
              <button
                type="button"
                disabled={busy != null}
                onClick={() => void patchSubmit(true)}
                className="pm-decision mt-2 inline-flex items-center gap-1.5 rounded-lg bg-agency px-3 text-[13px] font-medium text-white hover:bg-agency-hover disabled:opacity-40"
              >
                {busy === "submit" ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <CheckCircle2 size={13} aria-hidden />}
                I understand — allow Submit asks
              </button>
            ) : (
              <p className="mt-2 text-[12.5px] text-ink-muted">
                Add prefill and Submit to this job's capabilities on Schedule first.
              </p>
            )}
          </details>
        )
      ) : null}

      <div>
        {queued ? (
          <button
            type="button"
            disabled={!canStartQueued}
            onClick={() => void attend(queued.id)}
            className="pm-decision inline-flex items-center gap-1.5 rounded-lg bg-agency px-3.5 text-[13px] font-medium text-white hover:bg-agency-hover disabled:opacity-40"
          >
            {busy === "attend" || live ? (
              <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <Play size={13} aria-hidden />
            )}
            Start beside me
          </button>
        ) : (
          <button
            type="button"
            disabled={!canRun}
            onClick={() => void attend()}
            className="pm-decision inline-flex items-center gap-1.5 rounded-lg bg-agency px-3.5 text-[13px] font-medium text-white hover:bg-agency-hover disabled:opacity-40"
          >
            {busy === "attend" || live ? (
              <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <Play size={13} aria-hidden />
            )}
            Run beside me
          </button>
        )}
        {attendError ? (
          <p role="alert" className="mt-1.5 text-[12.5px] text-hold">
            {attendError}
          </p>
        ) : null}
      </div>
      {announce ? (
        <p role="status" aria-live="polite" className="text-[12.5px] text-ink-secondary">
          {announce}
        </p>
      ) : null}
    </div>
  );
}
