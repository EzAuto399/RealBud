/** Ephemeral answer recovery only. Durable messages remain the source of truth. */
export interface LiveStreamRow { threadId: string; turnId: string; text: string; reasoning: string }
export interface LiveStreamState { streaming: Record<string, string>; reasoning: Record<string, string> }
const MAX_STREAMS = 64;
const MAX_TEXT = 262_144;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[\w:-]{1,128}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);

export function parseLiveStreamSnapshot(value: unknown): LiveStreamRow[] | null {
  if (!Array.isArray(value) || value.length > MAX_STREAMS) return null;
  const result: LiveStreamRow[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    if (!record(row) || Object.keys(row).sort().join(",") !== "reasoning,text,threadId,turnId" ||
      !id(row.threadId) || !id(row.turnId) || seen.has(row.threadId) ||
      typeof row.text !== "string" || typeof row.reasoning !== "string" || row.text.length + row.reasoning.length > MAX_TEXT) return null;
    seen.add(row.threadId);
    result.push({ threadId: row.threadId, turnId: row.turnId, text: row.text, reasoning: row.reasoning });
  }
  return result;
}

/** A reconnect replaces every previous preview, including missing/completed ones. */
export function restoredLiveStreams(value: unknown): LiveStreamState {
  const result: LiveStreamState = { streaming: {}, reasoning: {} };
  for (const row of parseLiveStreamSnapshot(value) ?? []) {
    if (row.text) result.streaming[row.threadId] = row.text;
    if (row.reasoning) result.reasoning[row.threadId] = row.reasoning;
  }
  return result;
}

/** Fold only already-projected public frames, never private provider reasoning. */
export class LiveStreamRecovery {
  private rows = new Map<string, LiveStreamRow & { overflow?: boolean }>();
  accept(value: unknown): void {
    if (!record(value)) return;
    if ((value.kind === "thread" || (value.kind === "message" && record(value.message) && value.message.role === "bot" && value.message.kind === "text")) && id(value.threadId)) {
      this.rows.delete(value.threadId); return;
    }
    if (value.kind === "bot" && record(value.bot) && value.bot.busy === false && id(value.bot.threadId)) {
      this.rows.delete(value.bot.threadId); return;
    }
    if (value.kind !== "runtime" || !record(value.event)) return;
    const event = value.event;
    if (!id(event.threadId) || !id(event.turnId)) return;
    const previous = this.rows.get(event.threadId);
    if (event.type === "turn.completed") {
      if (previous?.turnId === event.turnId) this.rows.delete(event.threadId);
      return;
    }
    if (event.type === "turn.started" || (event.type === "item.started" && event.itemType === "tool")) {
      this.rows.delete(event.threadId); return;
    }
    if (event.type !== "content.delta" || typeof event.delta !== "string" || !["assistant_text", "reasoning_text"].includes(String(event.streamKind))) return;
    const row = previous?.turnId === event.turnId ? previous : { threadId: event.threadId, turnId: event.turnId, text: "", reasoning: "" };
    if (!previous && this.rows.size >= MAX_STREAMS) return;
    if (row.text.length + row.reasoning.length + event.delta.length > MAX_TEXT) {
      // Do not fabricate a continuous answer from a dropped middle. The final
      // durable message will replace this preview even when recovery is too big.
      row.text = ""; row.reasoning = ""; row.overflow = true;
    }
    if (!row.overflow) {
      if (event.streamKind === "assistant_text") row.text += event.delta;
      else row.reasoning += event.delta;
    }
    this.rows.set(event.threadId, row);
  }
  snapshot(): LiveStreamRow[] {
    return [...this.rows.values()].filter(row => !row.overflow).map(({ threadId, turnId, text, reasoning }) => ({ threadId, turnId, text, reasoning }));
  }
}
