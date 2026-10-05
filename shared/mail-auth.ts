// Reads the Authentication-Results header Gmail stamps on mail it receives
// (RFC 8601). Only Gmail's own stamp (authserv-id mx.google.com) counts: a
// header with any other authserv-id may have been written by the sender and is
// ignored. The collector keeps only the topmost header, which is Gmail's, so
// there is exactly one authserv-id to check. Anything ambiguous fails closed
// (null = unverified): unbalanced quotes or comments, a value with spaces,
// two DMARC or SPF results, or DKIM/DMARC results that disagree for a domain.
export interface MailAuthResult { result: string; domain: string | null }
export interface MailAuth { dmarc: MailAuthResult | null; dkim: MailAuthResult[]; spf: MailAuthResult | null }

const GOOGLE = 'mx.google.com';
const domainOf = (value: string | undefined): string | null => {
  const domain = value?.slice(value.lastIndexOf('@') + 1).toLowerCase().replace(/\.$/, '');
  return domain && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? domain : null;
};

/** One left-to-right pass: comments become a space and quoted strings become
 * "", so a ';' or "dmarc=pass" inside either can never be read as a result.
 * Null when a quote or parenthesis is unbalanced. */
function neutralise(header: string): string | null {
  let out = '', depth = 0, quoted = false;
  for (let i = 0; i < header.length; i++) {
    const c = header[i]!;
    if (c === '\\' && (quoted || depth)) { i++; continue; }
    if (depth) { if (c === '(') depth++; else if (c === ')' && --depth === 0) out += ' '; continue; }
    if (quoted) { if (c === '"') { quoted = false; out += '""'; } continue; }
    if (c === '"') quoted = true;
    else if (c === '(') depth = 1;
    else if (c === ')') return null;
    else out += c;
  }
  return depth || quoted ? null : out;
}

/** Null when the header is absent, was not stamped by Gmail, or is ambiguous. */
export function parseMailAuth(header: string | undefined): MailAuth | null {
  const text = header ? neutralise(header) : null;
  if (!text) return null;
  const [id = '', ...rest] = text.split(';');
  const idTokens = id.trim().split(/\s+/);
  // authserv-id, optionally followed by a version number.
  if (idTokens[0]?.toLowerCase() !== GOOGLE || idTokens.length > 2 || (idTokens[1] !== undefined && !/^\d+$/.test(idTokens[1]))) return null;
  const auth: MailAuth = { dmarc: null, dkim: [], spf: null };
  if (rest.length === 1 && rest[0]!.trim().toLowerCase() === 'none') return auth;
  for (const part of rest) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    // Every token is key=value with no spaces in the value; anything else is ambiguous.
    if (!tokens.every(t => /^[a-z0-9._-]+=\S*$/i.test(t))) return null;
    const [method, ...props] = tokens as [string, ...string[]];
    const m = /^(dmarc|dkim|spf)=([a-z]+)$/i.exec(method);
    if (!m) continue;
    const prop = (name: string) => props.find(p => p.toLowerCase().startsWith(`${name}=`))?.slice(name.length + 1);
    const kind = m[1]!.toLowerCase(), result = m[2]!.toLowerCase();
    if (kind === 'dkim') auth.dkim.push({ result, domain: domainOf(prop('header.d') ?? prop('header.i')) });
    else if (kind === 'dmarc') { if (auth.dmarc) return null; auth.dmarc = { result, domain: domainOf(prop('header.from')) }; }
    else { if (auth.spf) return null; auth.spf = { result, domain: domainOf(prop('smtp.mailfrom')) }; }
  }
  for (const k of auth.dkim) {
    if (!k.domain) continue;
    if (auth.dkim.some(o => o.domain === k.domain && (o.result === 'pass') !== (k.result === 'pass'))) return null;
    // DMARC cannot fail while a DKIM signature for the exact From domain passed.
    if (k.result === 'pass' && auth.dmarc && auth.dmarc.domain === k.domain && auth.dmarc.result !== 'pass') return null;
  }
  return auth;
}

/** Gmail confirmed the mail came from `domain`: DMARC passed for that From
 * domain, or a DKIM signature passed for it or a parent domain. SPF alone
 * never counts, because it checks the envelope sender, not the From address.
 * A DMARC result other than pass for that domain is final: Gmail's alignment
 * check (which knows public suffixes) overrules a parent-domain signature. */
export function mailAuthConfirms(auth: MailAuth | null, domain: string): boolean {
  const d = domain.toLowerCase();
  if (!auth || !d || (auth.dmarc?.domain === d && auth.dmarc.result !== 'pass')) return false;
  return (auth.dmarc?.result === 'pass' && auth.dmarc.domain === d) ||
    auth.dkim.some(k => k.result === 'pass' && !!k.domain && (k.domain === d || d.endsWith(`.${k.domain}`)));
}

/** Short result words for a finding note, never the raw header. */
export function mailAuthWords(auth: MailAuth | null): string {
  if (!auth) return 'no Gmail authentication result';
  return `DMARC ${auth.dmarc?.result ?? 'none'}, DKIM ${auth.dkim.length ? [...new Set(auth.dkim.map(k => k.result))].join('/') : 'none'}`;
}
