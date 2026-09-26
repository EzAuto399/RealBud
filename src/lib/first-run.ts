import { parseOnboardingState, type OnboardingStage, type OnboardingState } from '@shared/onboarding';

export function firstRunDone(state: OnboardingState | null): boolean {
  return state?.stage === 'complete';
}

/** Browser flags cannot identify an installation or member, and disappear when
 * the loopback port changes. Only an explicit server receipt completes setup. */
export function createFirstRunApi(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  return {
    async read(): Promise<OnboardingState> { return parseOnboardingState(await request('/api/onboarding')); },
    async save(current: OnboardingState, stage: OnboardingStage): Promise<OnboardingState> {
      const next = parseOnboardingState(await request('/api/onboarding', {
        method: 'PUT', body: JSON.stringify({ expectedScope: current.scope, expectedRevision: current.revision, stage }),
      }));
      if (next.scope !== current.scope || next.stage !== stage || next.revision < current.revision) {
        throw new Error('Your workspace changed. Reopen setup before continuing.');
      }
      return next;
    },
  };
}

/** How long the first screen waits for the saved setup before offering Try again. */
export const SAVED_SETUP_TIMEOUT_MS = 20_000;
export const SAVED_SETUP_SLOW =
  'Your saved setup did not answer in time. The office service may still be starting. Try again in a moment.';

/**
 * The first screen's one read, bounded: a busy or restarting office service
 * must surface as a message with Try again, never an endless "Checking…".
 * A timeout reads nothing into completion; the saved state stays on the server.
 */
export async function readSavedSetup(
  request: (path: string, init?: RequestInit, opts?: { timeoutMs?: number }) => Promise<unknown>,
  timeoutMs = SAVED_SETUP_TIMEOUT_MS,
): Promise<OnboardingState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(SAVED_SETUP_SLOW)), timeoutMs); });
  try {
    return await Promise.race([createFirstRunApi((path, init) => request(path, init, { timeoutMs })).read(), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Person names RealBud writes for itself while someone explores the sample
 * book. They identify a fixture, not the office, so they never count as a
 * recorded contact. Keep in step with SAMPLE_PROFILE_NAME in
 * src/components/Onboarding.tsx.
 */
const TRAINING_PERSON = new Set(["sample pm", "demo pm"]);

/**
 * Just the one saved field first run would otherwise write over. `agency` is
 * declared because a real snapshot and the cases below carry it, and is
 * deliberately never read: the agency name is not what the write touches.
 */
export interface OfficeContactSnapshot {
  book?: { office?: { pmUser?: string }; agency?: { name?: string } } | null;
}

/**
 * True when the saved book already records a real person as the office contact.
 *
 * A restored book may precede the saved setup receipt, so first run can still
 * replay over it. This reads exactly the field that
 * replay would write — `office.pmUser`, and nothing else. A named agency with no
 * contact yet is a blank to fill, not a value to protect: skipping the write
 * there would drop the name the person just typed instead of saving it.
 */
export function officeContactNamed(snapshot: OfficeContactSnapshot | null | undefined): boolean {
  const person = String(snapshot?.book?.office?.pmUser ?? "").trim();
  return person.length > 0 && !TRAINING_PERSON.has(person.toLowerCase());
}
