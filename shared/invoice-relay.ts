/** Invoicing platforms that send on a supplier's behalf. Their signature proves
 * the platform sent it, not who the Reply-To belongs to, so the review screen
 * asks staff to compare bank details with REI before paying. */
const RELAYS: ReadonlyMap<string, string> = new Map([['post.xero.com', 'Xero']]);

function address(header: string): string {
  const angle = header.match(/<([^<>]*)>/g);
  const raw = angle?.length === 1 ? angle[0]!.slice(1, -1) : header;
  return raw.trim().toLowerCase();
}

export function relayNotice(from: string, replyTo?: string | null): string | null {
  const sender = address(from);
  const platform = RELAYS.get(sender.slice(sender.lastIndexOf('@') + 1));
  if (!platform) return null;
  const forWhom = replyTo ? address(replyTo) : 'an unnamed sender';
  return `Sent via ${platform} for ${forWhom}. ${platform} doesn't verify this address — check the bank details match REI before paying.`;
}
