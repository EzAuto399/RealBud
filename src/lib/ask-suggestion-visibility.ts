export const ASK_SUGGESTIONS_HIDDEN_KEY = "realbud.ask.suggestions.hidden.v1";

interface SuggestionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserSessionStorage(): SuggestionStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function readRecord(
  storage: SuggestionStorage | undefined,
): { threadId: string; revision: number | null } | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(ASK_SUGGESTIONS_HIDDEN_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as { threadId?: unknown; revision?: unknown };
    if (typeof value.threadId !== "string" || !value.threadId) return null;
    if (value.revision !== null && (typeof value.revision !== "number" || !Number.isInteger(value.revision))) {
      return null;
    }
    return { threadId: value.threadId, revision: value.revision };
  } catch {
    return null;
  }
}

/** Hidden only for this thread and book revision. A Recheck or book write brings the row back. */
export function readAskSuggestionsHidden(
  threadId: string,
  revision: number | null,
  storage: SuggestionStorage | undefined = browserSessionStorage(),
): boolean {
  const record = readRecord(storage);
  return Boolean(record && record.threadId === threadId && record.revision === revision);
}

export function hideAskSuggestions(
  threadId: string,
  revision: number | null,
  storage: SuggestionStorage | undefined = browserSessionStorage(),
): void {
  if (!storage || !threadId) return;
  try {
    storage.setItem(ASK_SUGGESTIONS_HIDDEN_KEY, JSON.stringify({ threadId, revision }));
  } catch {
    // Ask stays usable if storage is blocked.
  }
}
