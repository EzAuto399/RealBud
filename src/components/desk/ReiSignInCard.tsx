import type { ReactNode } from "react";
import { CheckCircle2, KeyRound, Loader2, LogIn } from "lucide-react";

import { dismissReiSignedIn, reiWaitingLine, startReiSignIn, type ReiSignInStore } from "@/lib/rei-sign-in";

/**
 * The day's REI sign-in on Desk: when REI has signed the person out, one primary
 * action opens REI's own sign-in page in the work browser (or brings the one
 * already waiting there forward). Bud carries on by itself once they are signed
 * in. A recovery card: it is not one of Desk's arrangeable sections.
 */
export function ReiSignInCard({ rei, inert, menu }: { rei: ReiSignInStore; inert?: boolean; menu?: ReactNode }) {
  const { view, opening, justSignedIn, error } = rei;
  // Desk's card frame: the ⋯ menu beside the card says it is always shown.
  const frame = (card: ReactNode) => <div className="mb-3 flex items-start gap-2" inert={inert}><div className="min-w-0 flex-1">{card}</div>{menu}</div>;
  if (justSignedIn && view?.state === "signed_in") {
    return frame(
      <section aria-label="REI sign-in" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-sheet px-3.5 py-2">
        <p role="status" className="flex items-center gap-2 text-[13px] text-ink">
          <CheckCircle2 size={16} className="shrink-0 text-agency" aria-hidden />
          Signed in to REI. Bud is carrying on with today’s REI work.
        </p>
        <button type="button" onClick={dismissReiSignedIn} className="pm-control shrink-0 px-2 text-[12px] text-ink-muted hover:text-ink">Dismiss</button>
      </section>
    );
  }
  if (view?.state !== "needed") return null;
  const progress = opening ? "Opening REI’s sign-in page…"
    : view.signingIn ? "REI’s sign-in page is open in your work browser. Bud carries on by itself once you’re signed in." : "";
  return frame(
    <section aria-label="REI sign-in" className="rounded-lg border border-hold/40 bg-sheet px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <KeyRound size={18} className="shrink-0 text-hold" aria-hidden />
        <div className="min-w-0 flex-1 basis-[14rem]">
          <h2 className="text-[14px] font-medium text-ink">REI needs you to sign in</h2>
          <p className="mt-0.5 text-[13px] text-ink-secondary">{reiWaitingLine(view)}</p>
          <p className="mt-0.5 text-[12px] text-ink-muted">You type your password on REI’s own page. Bud never sees it.</p>
        </div>
        <button
          type="button"
          onClick={() => void startReiSignIn()}
          disabled={opening}
          aria-busy={opening || undefined}
          className="pm-decision flex shrink-0 items-center gap-2 rounded bg-agency px-4 text-[14px] font-medium text-white hover:bg-agency-hover disabled:cursor-progress disabled:opacity-80"
        >
          {opening ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <LogIn size={15} aria-hidden />}
          Sign in to REI
        </button>
      </div>
      <p role="status" aria-live="polite" className={progress ? "mt-2 text-[12.5px] text-ink-secondary" : "sr-only"}>{progress}</p>
      {error ? <p role="alert" className="mt-2 text-[12.5px] text-danger">{error}</p> : null}
    </section>
  );
}
