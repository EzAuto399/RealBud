/** The same envelope limit applies to the composed request and the API. */
export const ASK_MESSAGE_MAX_CHARS = 50_000;

export function askMessageSizeError(text: string): string | null {
  return text.length > ASK_MESSAGE_MAX_CHARS
    ? "This request is too long. Shorten the pasted text or send fewer attachments."
    : null;
}
