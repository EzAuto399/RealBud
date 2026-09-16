/** Presentation only: historical phone messages include a transport label in
 * their saved text. This is not verified identity or permission to send a reply.
 * Keep the original record intact; strip only one complete, leading label. */
export function channelMessage(text: string) {
  const match = /^\[(Telegram|Discord|Slack) · ([^\]\r\n]{1,200})\](?:[ \t]*\r?\n|[ \t]+|$)/.exec(text);
  if (!match || !match[2].trim()) return null;
  return {
    channel: match[1] as "Telegram" | "Discord" | "Slack",
    sender: match[2].trim(),
    body: text.slice(match[0].length),
  };
}
