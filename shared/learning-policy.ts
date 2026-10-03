/** Decides which staged worker preferences Bud may keep without a person.
 * Conservative positive rule: only one short, plain added preference about
 * how Bud writes (spelling, tone, length, format, greetings) is kept, and only
 * if it names no money, recipients, authority, legal matters, numbers, contact
 * details, and does not change what Bud does, skips, hides or whom it involves.
 * A blocklist alone misses rephrasings ("can be acted on straight away"), so a
 * style term is required as well. Everything else waits for a person. Pure and
 * dependency-free. */
import type { MemoryReviewPreview } from './hermes-memory-review.ts';

export const LEARNING_POLICY_VERSION = 1 as const;
export const LEARNING_MAX_CODE_POINTS = 280;
/** The admitted native store joins entries with this exact delimiter. */
export const LEARNING_ENTRY_DELIMITER = '\n§\n';

/** Fixed sentences only; the page parser rejects any other reason text. */
export const LEARNING_HOLD_REASONS = {
  'not-single-add': 'Changes or removes saved memory, so it waits for you.',
  'no-change': 'Is already saved or changes nothing, so it waits for you.',
  'unsafe-characters': 'Contains hidden or unusual characters, so it waits for you.',
  'unchecked-script': 'Uses characters Bud cannot check yet, so it waits for you.',
  credential: 'Looks like it contains a secret, so it waits for you.',
  'too-long': 'Is longer than a short preference, so it waits for you.',
  'contact-details': 'Includes an email, link, phone number or handle, so it waits for you.',
  money: 'Mentions money, so it waits for you.',
  recipients: 'Mentions who to send, forward or reply to, so it waits for you.',
  authority: 'Mentions approvals, permissions or sign-in details, so it waits for you.',
  legal: 'Mentions tenancy, notices or legal matters, so it waits for you.',
  numbers: 'Contains numbers, so it waits for you.',
  behaviour: 'Changes what Bud does, leaves out or involves, so it waits for you.',
  'not-style': 'Is not only about how Bud writes, so it waits for you.',
  undone: 'You undid this before, so it waits for you.',
  // Service holds, not classifier outcomes.
  uncertain: 'Bud could not confirm keeping this, so it waits for you.',
  unchecked: 'Bud could not check this change, so it waits for you.',
  capacity: 'Bud has kept many learnings recently, so this waits for you.',
} as const;
export type LearningHoldCode = keyof typeof LEARNING_HOLD_REASONS;
export interface LearningHold { code: LearningHoldCode; reason: string }
export type LearningClassification =
  | { decision: 'keep'; policyVersion: typeof LEARNING_POLICY_VERSION }
  | { decision: 'hold'; reason: string; code: LearningHoldCode };
export type LearningPreview = Pick<MemoryReviewPreview, 'action' | 'operationCount' | 'before' | 'after'>;

export const learningHold = (code: LearningHoldCode): LearningHold => ({ code, reason: LEARNING_HOLD_REASONS[code] });
export const isLearningHold = (value: unknown): value is LearningHold => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 2 && typeof v.code === 'string' && Object.hasOwn(LEARNING_HOLD_REASONS, v.code) &&
    v.reason === LEARNING_HOLD_REASONS[v.code as LearningHoldCode];
};

const entries = (text: string) => text === '' ? [] : text.split(LEARNING_ENTRY_DELIMITER);
/** The single entry an add appended, exactly as it will be saved; otherwise null. */
export function addedLearningText(preview: LearningPreview): string | null {
  if (preview.action !== 'add' || preview.operationCount !== 1) return null;
  const before = entries(preview.before), after = entries(preview.after);
  if (after.length !== before.length + 1 || before.some((entry, index) => after[index] !== entry)) return null;
  return after[after.length - 1];
}

/** True when `after` is `before` with exactly one entry equal to `text` removed. */
export function exactLearningRemoval(before: string, after: string, text: string): boolean {
  const saved = entries(before);
  return saved.filter(entry => entry === text).length === 1 && after === saved.filter(entry => entry !== text).join(LEARNING_ENTRY_DELIMITER);
}

// Controls, format characters (zero-width, bidi, soft hyphen), private use,
// unassigned, surrogates and line/paragraph separators.
const unsafe = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/u;
const word = (body: string) => new RegExp(`(?<![a-z])(?:${body})(?![a-z])`);
const rules: [LearningHoldCode, RegExp][] = [
  ['contact-details', /@|https?:|:\/\/|www\.|mailto:|[a-z0-9-]+\.[a-z]{2,}(?![a-z])/],
  ['money', /\p{Sc}/u],
  ['money', word('money|cash|dollars?|cents?|aud|usd|pay|pays|paid|paying|payments?|payee\\w*|payer\\w*|payable|payouts?|payroll|bank\\w*|bsb|account\\w*|acct|invoic\\w*|bills?|billing|billed|refund\\w*|transfer\\w*|deposit\\w*|withdraw\\w*|pric\\w*|cost\\w*|fees?|rent|rents|rental\\w*|rented|renting|arrears|bonds?|amounts?|owe|owed|owes|owing|debt\\w*|credit\\w*|debit\\w*|cards?|wire|wired|funds?|funding|salar\\w*|wages?|budget\\w*|charg\\w*|tax\\w*|gst|discount\\w*|commission\\w*|expens\\w*|receipts?|financ\\w*|loans?|mortgage\\w*|statements?')],
  ['recipients', word('send\\w*|sent|forward\\w*|repl(?:y|ies|ied|ying)|recipient\\w*|contact\\w*|e-?mail\\w*|mail|mails|mailed|mailing|cc|bcc|cc\'?d|address\\w*|deliver\\w*|phone\\w*|mobile|sms|whatsapp|inbox\\w*|text me|call me')],
  ['authority', word('approv\\w*|permission\\w*|permit\\w*|authori[sz]\\w*|authorit\\w*|overrid\\w*|ignor\\w*|bypass\\w*|skip\\w*|disregard\\w*|circumvent\\w*|unlock\\w*|allow\\w*|grant\\w*|consent\\w*|password\\w*|passcode\\w*|passphrase\\w*|login\\w*|logon|log in|log-in|sign in|sign-in|signin|credential\\w*|tokens?|keys?|api|secrets?|pin|pins|otp|2fa|mfa|admin\\w*|sudo|root|verif\\w*|confirm\\w*|instruction\\w*|prompt\\w*|jailbreak\\w*|pretend\\w*|forget\\w*|trust\\w*|never ask|don\'?t ask|do not ask|without (?:asking|checking|approval|review\\w*|confirm\\w*)|no need to (?:ask|check|confirm)|auto-?approv\\w*')],
  ['legal', word('tenanc\\w*|leases?|leased|leasing|notices?|legal\\w*|law|laws|lawyer\\w*|solicitor\\w*|attorney\\w*|courts?|tribunal\\w*|ncat|qcat|vcat|evict\\w*|terminat\\w*|breach\\w*|vacat\\w*|contract\\w*|agreement\\w*|signature\\w*|signed|complian\\w*|regulat\\w*|liabil\\w*|liable|sue|sued|suing|lawsuit\\w*|disputes?|claims?|warrant\\w*|insur\\w*|rta')],
];
// Changes to what Bud does, skips, hides, whom it involves or how it treats
// people and money states. Checked after the topic rules above.
const behaviour = word('mention\\w*|omit\\w*|hide|hides|hiding|hid|hidden|conceal\\w*|leave out|leaves out|leave off|exclud\\w*|withhold\\w*|remov\\w*|delet\\w*|' +
  'act|acts|acted|acting|action\\w*|proceed\\w*|go ahead|goes ahead|straight away|right away|immediately|automatic\\w*|unnecessary|no need|needn\'?t|' +
  'reliable|reliably|treat|treats|treated|believe|assume\\w*|copy|copies|copied|include \\w+ on|loop in|loop \\w+ in|notif\\w*|tell|tells|inform\\w*|' +
  'escalat\\w*|follow-?ups?|follow up|chase\\w*|remind\\w*|schedul\\w*|limit\\w*|threshold\\w*|overdue|balance\\w*|outstanding|urgent\\w*|' +
  'priorit\\w*|stop|stops|stopped|block\\w*|cancel\\w*|accept\\w*|reject\\w*|refus\\w*|decid\\w*|decision\\w*');
// Required: the learning must be about how Bud writes.
const style = word('spelling|spelt|spelled|english|tone|tones|warm|warmer|friendly|formal|informal|casual|polite|plain|concise|short|shorter|brief|briefer|' +
  'detailed|length|wording|phrasing|greetings?|sign-?offs?|salutations?|headings?|bullets?|bullet points?|paragraphs?|format\\w*|layout|fonts?|' +
  'capitali[sz]\\w*|punctuation|style|voice|emojis?|exclamation\\w*|subject lines?|summar\\w*|lists?|tables?|bold|italic\\w*|sentences?|jargon|wordy|chatty');

const people = word('director\\w*|manager\\w*|boss\\w*|staff|team\\w*|partner\\w*|agent\\w*|landlord\\w*|principal\\w*|colleague\\w*|' +
  'he|she|they|him|her|them|his|hers|their|theirs|someone|anyone|everyone|everything|nobody|who|whom|whose|which|' +
  'handl\\w*|responsib\\w*|in charge|signs? off on|signed off on|works? for|reports? to');
// Closed vocabulary: every word must be one of these, so an extra clause that
// changes what Bud does cannot ride along with a style word.
const styleWords = 'spelling spelt spelled english british australian tone tones warm warmer friendly formal informal casual polite plain clear ' +
  'simple concise short shorter long longer brief briefer detailed length wording phrasing greeting greetings sign-off sign-offs signoff signoffs ' +
  'salutation salutations heading headings bullet bullets paragraph paragraphs format formats formatting formatted layout font fonts ' +
  'capitalisation capitalization punctuation style voice emoji emojis exclamation exclamations list lists table tables bold italic italics ' +
  'sentence sentences jargon wordy chatty';
const functionWords = 'a an the and or with without in on for of to over than more less very rather instead no not please always never it its';
const preferenceVerbs = 'use uses prefer prefers preferred like likes keep keeps write writes written avoid avoids start starts';
const documentNouns = 'letter letters update updates note notes message messages report reports summary summaries draft drafts document documents ' +
  'point points line lines subject owner tenant office';
export const LEARNING_VOCABULARY: ReadonlySet<string> = new Set(`${styleWords} ${functionWords} ${preferenceVerbs} ${documentNouns}`.split(' '));

const allowedCapitals = /^(?:I|Australian|British|English|American|Dear|Hi|Hello|Kind|Regards|Thanks|Cheers)$/u;

// Long stems also checked with separators removed ("p a s s w o r d").
const squashed: [LearningHoldCode, RegExp][] = [
  ['authority', /password|passcode|approv|permission|authori[sz]|override|bypass|credential|disregard|instruction/],
  ['money', /payment|invoice|refund|transfer|deposit|account/],
  ['recipients', /recipient|forward/],
  ['legal', /tenanc|evict|terminat/],
];

/** Normalize width, compatibility forms, case and diacritics before matching. */
export function normalizeLearningText(text: string): string {
  return text.normalize('NFKC').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[‘’ʼ`´]/g, '\'').normalize('NFC');
}

export function classifyLearning(preview: LearningPreview, options: { containsCredential?: (text: string) => boolean } = {}): LearningClassification {
  const hold = (code: LearningHoldCode): LearningClassification => ({ decision: 'hold', reason: LEARNING_HOLD_REASONS[code], code });
  if (preview.action !== 'add' || preview.operationCount !== 1) return hold('not-single-add');
  const text = addedLearningText(preview);
  if (text === null) return preview.after === preview.before ? hold('no-change') : hold('not-single-add');
  if (!text.trim()) return hold('no-change');
  if (unsafe.test(text)) return hold('unsafe-characters');
  const normal = normalizeLearningText(text);
  if (unsafe.test(normal) || /\p{L}/u.test(normal.replace(/\p{Script=Latin}/gu, ''))) return hold('unchecked-script');
  if (options.containsCredential?.(text) || options.containsCredential?.(normal) || normal.split(/\s+/).some(token => token.length > 40)) return hold('credential');
  if ([...text].length > LEARNING_MAX_CODE_POINTS) return hold('too-long');
  for (const [code, pattern] of rules) if (pattern.test(normal)) return hold(code);
  const letters = normal.replace(/[^a-z]/g, '');
  for (const [code, pattern] of squashed) if (pattern.test(letters)) return hold(code);
  if (/\p{N}/u.test(normal) || /\p{N}/u.test(text)) return hold('numbers');
  if (behaviour.test(normal)) return hold('behaviour');
  // One plain sentence about writing: no second clause or sentence that could
  // carry a fact, no people or roles, no names mid-sentence.
  if (/[;:]|[.!?]\s*\S/u.test(text.trim()) || people.test(normal)) return hold('not-style');
  if (text.trim().split(/\s+/).slice(1).some(token => /^\p{Lu}/u.test(token) && !allowedCapitals.test(token.replace(/[^\p{L}]/gu, '')))) return hold('not-style');
  // Look-alike letters (small capitals, dotless i) survive normalization; plain ASCII only.
  if (!/^[a-z ,.'-]+$/.test(normal)) return hold('unchecked-script');
  if (normal.split(/[ ,.]+/).some(token => token && !LEARNING_VOCABULARY.has(token))) return hold('not-style');
  if (!style.test(normal)) return hold('not-style');
  return { decision: 'keep', policyVersion: LEARNING_POLICY_VERSION };
}
