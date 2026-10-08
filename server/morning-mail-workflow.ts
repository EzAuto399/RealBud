import type { JobRun, LoopRun, Property, Recipe } from '../shared/contracts.ts';
import { recipeClockRunnable } from '../shared/contracts.ts';
import type { MailScanReceipt, MailThread, MailWorkspaceMetadata } from '../shared/mail-ingestion.ts';
import { matchSender, type SupplierDirectory } from '../shared/supplier-directory.ts';
import type { JevQuestion, JevRequest, JevResult } from './jev-client.ts';
import { senderAddress } from './maintenance-review.ts';
import { redactSecretsInText } from './redact.ts';
import type { LoopExecuteResult } from './routines.ts';
import type { RecordedRunUsage } from './run-cost.ts';

/** Two narrow questions per thread instead of one "is this noise?". */
const BULK_QUESTION: JevQuestion = { type: 'noul', instructions: 'Is it bulk, marketing, a newsletter or an automated notification not addressed to this office personally?',
  criteria: { true: 'Bulk, marketing, a newsletter or an automated notification, not written to this office personally.',
    false: 'Written to this office personally, or not clearly bulk or automated.' } };
const ACTION_QUESTION: JevQuestion = { type: 'noul', instructions: 'Does it ask the office to do something, or name a property, tenancy, payment, repair or deadline?',
  criteria: { true: 'It asks the office to do something, or names a property, tenancy, payment, repair or deadline.',
    false: 'It asks nothing of the office and names no property, tenancy, payment, repair or deadline.' } };
/** Screened only when Jev is near-sure it is bulk AND near-sure it asks for
 * nothing. Tune from a scripts/eval-jev live run (docs/QA-LIVE-DEBUG.md). */
export const SCREEN_BULK_MIN = 0.97, SCREEN_ACTION_MAX = 0.03;
/** Two questions per thread under jev-client's 8-question cap. */
const SCREEN_THREADS_PER_CALL = 4;
/** Under jev-client's 16 KiB state cap, so a batch is never refused for size. */
const SCREEN_STATE_BYTES = 15_000;
const SCREEN_CALLS_IN_FLIGHT = 3;

const contactName = (name: string) => name.replace(/["']/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
/** Contacts in the book, by sender: supplier emails and approved aliases (from
 * REI's Suppliers list), Desk owner contact addresses, and the display name of
 * a tenant or owner in Desk (tenants have no email on file). Takes the raw From
 * header. A spoofed name only keeps a thread out of the screen (shown to Bud).
 * ponytail: exact display-name match; add fuzzy matching only if live misses show it. */
export function knownMailSenders(suppliers: SupplierDirectory, properties: readonly Partial<Pick<Property, 'owner' | 'tenantName'>>[]): (from: string) => boolean {
  const owners = new Set(properties.map(p => senderAddress(p.owner?.contact ?? '')).filter(Boolean));
  const names = new Set(properties.flatMap(p => [p.tenantName ?? '', p.owner?.name ?? '']).map(contactName).filter(name => name.length >= 3));
  return from => {
    const address = senderAddress(from), angle = from.indexOf('<');
    return !!address && (owners.has(address) || matchSender(suppliers, address).kind !== 'unlisted') || angle > 0 && names.has(contactName(from.slice(0, angle)));
  };
}

/** Jev pre-screen: code first, then two noul questions per conversation
 * (`bulk`, `asks_action`), 4 conversations per call. Only incoming-only
 * conversations with full history, no attachment, and every sender unambiguous
 * and not a known contact are asked about (the caller also keeps open work out).
 * Jev sees the sender domain, the subject and the first 600 characters of the
 * latest message, redacted; never addresses, recipients, attachments or full
 * bodies. Up to 3 calls run at a time; a failed call leaves its own threads
 * unscreened (sent to Bud), and only when every call failed is nothing screened
 * (null). `considered` has both probabilities for each answered thread. */
export async function screenMailNoise(threads: MailThread[], options: {
  decide: (request: JevRequest) => Promise<JevResult>; known: (from: string) => boolean;
}): Promise<{ noise: string[]; model: string; considered: { id: string; bulk: number; action: number }[] } | null> {
  const rows = threads.flatMap(thread => {
    const latest = thread.messages.at(-1), address = latest ? senderAddress(latest.from) : '';
    if (!latest || !address || !thread.historyComplete || thread.messages.some(m =>
      m.direction !== 'incoming' || m.attachments.length || !senderAddress(m.from) || options.known(m.from))) return [];
    return [{ id: thread.id, state: { senderDomain: address.slice(address.lastIndexOf('@') + 1),
      subject: redactSecretsInText(latest.subject).slice(0, 200),
      snippet: redactSecretsInText(latest.body).replace(/\s+/g, ' ').trim().slice(0, 600) } }];
  });
  if (!rows.length) return null;
  const batches: { state: Record<string, unknown>; questions: Record<string, JevQuestion>; ids: string[] }[] = [];
  for (let at = 0; at < rows.length;) {
    const state: Record<string, unknown> = {}, questions: Record<string, JevQuestion> = {}, ids: string[] = [];
    while (at < rows.length && ids.length < SCREEN_THREADS_PER_CALL) {
      const key = `t${ids.length}`;
      if (ids.length && Buffer.byteLength(JSON.stringify({ ...state, [key]: rows[at]!.state })) > SCREEN_STATE_BYTES) break;
      state[key] = rows[at]!.state;
      questions[`${key}.bulk`] = { ...BULK_QUESTION, instructions: `Thread ${key} in the state. ${BULK_QUESTION.instructions}` };
      questions[`${key}.asks_action`] = { ...ACTION_QUESTION, instructions: `Thread ${key} in the state. ${ACTION_QUESTION.instructions}` };
      ids.push(rows[at++]!.id);
    }
    batches.push({ state, questions, ids });
  }
  const answered = new Map<string, { bulk: number; action: number }>();
  let model = '', next = 0, any = false;
  const worker = async () => {
    while (next < batches.length) {
      const { state, questions, ids } = batches[next++]!;
      let result: JevResult | null = null;
      try { result = await options.decide({ state, questions }); } catch { /* this call's threads stay unscreened */ }
      if (!result?.ok) continue;
      any = true;
      model = /^[\w.:/-]{1,100}$/.test(result.model) ? result.model : 'unrecognised';
      const { answers } = result;
      ids.forEach((id, n) => {
        const bulk = answers[`t${n}.bulk`], action = answers[`t${n}.asks_action`];
        if (bulk?.type === 'noul' && action?.type === 'noul') answered.set(id, { bulk: bulk.noul, action: action.noul });
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(SCREEN_CALLS_IN_FLIGHT, batches.length) }, worker));
  if (!any) return null;
  const considered = rows.flatMap(row => { const p = answered.get(row.id); return p ? [{ id: row.id, ...p }] : []; });
  return { noise: considered.filter(row => row.bulk >= SCREEN_BULK_MIN && row.action <= SCREEN_ACTION_MAX).map(row => row.id), model, considered };
}

interface Dependencies {
  collect: () => Promise<MailWorkspaceMetadata>;
  /** Optional Jev pre-screen before batching; any failure screens nothing. */
  screen?: (scan: MailScanReceipt) => Promise<void>;
  prepareInput: (scan: MailScanReceipt) => Promise<(MailScanReceipt & { batchThreadCount: number }) | null>;
  applyReview: (run: JobRun) => Promise<MailWorkspaceMetadata>;
  recipe: () => Recipe | undefined | Promise<Recipe | undefined>;
  admitPack: (recipeId: string) => Promise<void>;
  /** The screen's Jev usage: handed to the first batch's job run, or, when no batch runs, kept on the loop's own result. */
  screenUsage?: RecordedRunUsage;
  execute: (recipe: Recipe, request: { mode: 'prepare'; trigger: 'manual' | 'schedule'; scheduledFor: number; loopRunId: string; idempotencyKey: string }, usage?: RecordedRunUsage) => Promise<{ run: JobRun }>;
}
/** Bounded batches keep a busy inbox inside the worker's established output
 * contract. Each batch has its own durable job receipt under one clock run. */
export async function runMorningMailWorkflow(run: LoopRun, deps: Dependencies): Promise<LoopExecuteResult> {
  const counted = { done: false };
  const result = await prepareMorningMail(run, deps, counted);
  return !counted.done && deps.screenUsage?.calls ? { ...result, usage: deps.screenUsage } : result;
}

async function prepareMorningMail(run: LoopRun, deps: Dependencies, counted: { done: boolean }): Promise<LoopExecuteResult> {
  const first = await deps.recipe();
  if (!first || !recipeClockRunnable(first)) return { ok: false, detail: 'Approve the current morning plan in Schedule before collecting and preparing mail.' };
  await deps.admitPack(first.id);
  const state = await deps.collect(), scan = state.latestScan;
  if (!scan || !['complete','partial'].includes(scan.status)) return { ok: false, detail: 'Mail collection did not produce a usable source receipt.' };
  let jobRunId: string | undefined, reviewed = 0;
  // Screened noise leaves the batches; a failed screen leaves every thread in them.
  await deps.screen?.(scan).catch(() => undefined);
  try {
  for (let batch = 0; batch < 5; batch++) {
    const source = await deps.prepareInput(scan);
    if (!source) return { ok: true, status: scan.status === 'partial' ? 'partial' : state.counts.open + state.counts.waiting > 0 ? 'awaiting-approval' : 'completed',
      detail: `${scan.threadCount} conversations collected; ${reviewed} prepared for internal review. Existing staff decisions were kept.${scan.status === 'partial' ? ' Source coverage is partial; check the scan receipt.' : ''}`, ...(jobRunId ? { jobRunId } : {}) };
    // A manual collection can replace the shared latest receipt between
    // batches. Keep this clock run bound to the collection it started with.
    if (source.id !== scan.id || source.accountId !== scan.accountId || source.bindingRevision !== scan.bindingRevision) return {
      ok: false, status: reviewed ? 'partial' : 'failed',
      detail: 'The Gmail source changed during preparation. Saved sources and completed review batches were kept. Start a fresh review for the current source.',
      ...(jobRunId ? { jobRunId } : {}),
    };
    const recipe = await deps.recipe();
    if (!recipe || recipe.id !== first.id || !recipeClockRunnable(recipe) || recipe.revision !== first.revision) return { ok: false, status: reviewed ? 'partial' : 'failed', detail: 'The morning plan changed during preparation. Saved sources and completed review batches were kept.', ...(jobRunId ? { jobRunId } : {}) };
    await deps.admitPack(recipe.id);
    const usage = !counted.done && deps.screenUsage?.calls ? deps.screenUsage : undefined;
    counted.done = true;
    const result = await deps.execute(recipe, { mode: 'prepare', trigger: run.manual ? 'manual' : 'schedule', scheduledFor: run.scheduledFor,
      loopRunId: run.id, idempotencyKey: `morning-mail:${run.id}:${source.id}:${batch}` }, usage);
    jobRunId = result.run.id;
    if (!['completed','awaiting-approval'].includes(result.run.status)) return { ok: false, status: reviewed ? 'partial' : 'failed', detail: result.run.detail, jobRunId };
    await deps.applyReview(result.run); reviewed += source.batchThreadCount;
  }
  // The collector admits at most 100 threads, at 20 per batch. Verify that no
  // input appeared concurrently instead of claiming all work was reviewed.
  if (await deps.prepareInput(scan)) return { ok: false, status: 'partial', detail: 'Five bounded review batches finished. Additional evidence remains for the next review.', jobRunId };
  return { ok: true, status: scan.status === 'partial' ? 'partial' : 'awaiting-approval', detail: `${scan.threadCount} conversations collected; ${reviewed} prepared for internal review.${scan.status === 'partial' ? ' Source coverage is partial; check the scan receipt.' : ''}`, jobRunId };
  } catch {
    return { ok: false, status: reviewed ? 'partial' : 'failed', detail: reviewed
      ? `${reviewed} conversations were saved for review before a later batch was held. Check the source and current plan before continuing.`
      : 'Morning preparation could not be confirmed. Collected evidence and prior task decisions were kept; check the source and current plan.', ...(jobRunId ? { jobRunId } : {}) };
  }
}
