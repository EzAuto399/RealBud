export const SESSION_HEAL_RETRY_MS = [200, 600, 1_500] as const;

export type SessionHealKind = "transport" | "origin" | "other";

export interface SessionHealCopy {
  kind: SessionHealKind;
  title: string;
  detail: string;
}

function rawErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

export function isRetryableApiFailure(error: unknown): boolean {
  const status = (error as { status?: number } | undefined)?.status;
  if (status === 401 || status === 502 || status === 503) return true;
  return /failed to fetch|networkerror|load failed|econnrefused|session refused|realbud dropped|502|503/i.test(
    rawErrorMessage(error),
  );
}

export function describeSessionHeal(error: unknown): SessionHealCopy {
  const raw = rawErrorMessage(error);
  if (/refused origin|refused host/i.test(raw)) {
    return {
      kind: "origin",
      title: "This window cannot reach RealBud",
      detail: "The UI port is not allowed. Desk and Ask stay on this page.",
    };
  }
  if (isRetryableApiFailure(error) || /failed to fetch/i.test(raw)) {
    return {
      kind: "transport",
      title: "RealBud dropped",
      detail: "Ask and Desk stay here. The draft is still in the composer. Retry — this page keeps trying.",
    };
  }
  return {
    kind: "other",
    title: "That step did not finish",
    detail: raw || "Try again.",
  };
}

export async function runWithTransportRetry<T>(
  task: (attempt: number) => Promise<T>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < SESSION_HEAL_RETRY_MS.length; attempt++) {
    try {
      return await task(attempt);
    } catch (error) {
      last = error;
      const lastAttempt = attempt === SESSION_HEAL_RETRY_MS.length - 1;
      if (!isRetryableApiFailure(error) || lastAttempt) {
        const copy = describeSessionHeal(error);
        throw Object.assign(new Error(copy.detail), {
          cause: error,
          status: (error as { status?: number } | undefined)?.status,
          body: (error as { body?: unknown } | undefined)?.body,
          heal: copy,
        });
      }
      await wait(SESSION_HEAL_RETRY_MS[attempt]!);
    }
  }
  throw last;
}
