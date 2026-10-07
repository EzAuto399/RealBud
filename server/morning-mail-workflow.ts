import type { JobRun, LoopRun, Property, Recipe } from '../shared/contracts.ts';
import { recipeClockRunnable } from '../shared/contracts.ts';
import type { MailScanReceipt, MailThread, MailWorkspaceMetadata } from '../shared/mail-ingestion.ts';
import { matchSender, type SupplierDirectory } from '../shared/supplier-directory.ts';
import type { JevQuestion, JevRequest, JevResult } from './jev-client.ts';
import { senderAddress } from './maintenance-review.ts';
import { redactSecretsInText } from './redact.ts';
import type { LoopExecuteResult } from './routines.ts';

const NOISE_QUESTION: JevQuestion = { type: 'noul', instructions: 'Is this thread noise: a newsletter, marketing, automated notification with no action, or spam?',
  criteria: { true: 'It is a newsletter, marketing, an automated notification that needs no action, or spam.',
    false: 'It needs a person or is about a property, tenant, owner, supplier, payment, maintenance or a legal matter.' } };
export const NOISE_THRESHOLD = 0.97;
/** Under jev-client's 16 KiB state cap, so a batch is never refused for size. */
const SCREEN_STATE_BYTES = 15_000;

/** Addresses on the office's lists: supplier emails and approved aliases (from
 * REI's Suppliers list) and owner contacts in Desk. Tenants have no email on file. */
export function knownMailSenders(suppliers: SupplierDirectory, properties: readonly Pick<Property, 'owner'>[]): (address: string) => boolean {
  const owners = new Set(properties.map(p => senderAddress(p.owner?.contact ?? '')).filter(Boolean));
  return address => owners.has(address) || matchSender(suppliers, address).kind !== 'unlisted';
}

/** Jev pre-screen: one noul question per conversation, up to 8 per call. Only
 * incoming-only conversations with full history, no attachment, and every
 * sender unambiguous and not on a known list are asked about. Jev sees the
 * sender domain, the subject and the first 600 characters of the latest
 * message, redacted; never addresses, recipients, attachments or full bodies.
 * Any failed call screens nothing. */
export async function screenMailNoise(threads: MailThread[], options: {
  decide: (request: JevRequest) => Promise<JevResult>; known: (address: string) => boolean;
}): Promise<{ noise: string[]; model: string } | null> {
  const rows = threads.flatMap(thread => {
    const latest = thread.messages.at(-1), address = latest ? senderAddress(latest.from) : '';
    if (!latest || !address || !thread.historyComplete || thread.messages.some(m => {
      const from = senderAddress(m.from);
      return m.direction !== 'incoming' || m.attachments.length || !from || options.known(from);
    })) return [];
    return [{ id: thread.id, state: { senderDomain: address.slice(address.lastIndexOf('@') + 1),
      subject: redactSecretsInText(latest.subject).slice(0, 200),
      snippet: redactSecretsInText(latest.body).replace(/\s+/g, ' ').trim().slice(0, 600) } }];
  });
  if (!rows.length) return null;
  const noise: string[] = [];
  let model = '';
  // ponytail: sequential calls, stopping at the first failure; parallelise if screen latency matters.
  for (let at = 0; at < rows.length;) {
    const state: Record<string, unknown> = {}, questions: Record<string, JevQuestion> = {}, ids: string[] = [];
    while (at < rows.length && ids.length < 8) {
      const key = `t${ids.length}`;
      if (ids.length && Buffer.byteLength(JSON.stringify({ ...state, [key]: rows[at]!.state })) > SCREEN_STATE_BYTES) break;
      state[key] = rows[at]!.state;
      questions[key] = { ...NOISE_QUESTION, instructions: `Thread ${key} in the state. ${NOISE_QUESTION.instructions}` };
      ids.push(rows[at++]!.id);
    }
    const result = await options.decide({ state, questions });
    if (!result.ok) return null;
    model = /^[\w.:/-]{1,100}$/.test(result.model) ? result.model : 'unrecognised';
    ids.forEach((id, n) => { const answer = result.answers[`t${n}`]; if (answer?.type === 'noul' && answer.noul >= NOISE_THRESHOLD) noise.push(id); });
  }
  return { noise, model };
}

interface Dependencies {
  collect: () => Promise<MailWorkspaceMetadata>;
  /** Optional Jev pre-screen before batching; any failure screens nothing. */
  screen?: (scan: MailScanReceipt) => Promise<void>;
  prepareInput: (scan: MailScanReceipt) => Promise<(MailScanReceipt & { batchThreadCount: number }) | null>;
  applyReview: (run: JobRun) => Promise<MailWorkspaceMetadata>;
  recipe: () => Recipe | undefined | Promise<Recipe | undefined>;
  admitPack: (recipeId: string) => Promise<void>;
  execute: (recipe: Recipe, request: { mode: 'prepare'; trigger: 'manual' | 'schedule'; scheduledFor: number; loopRunId: string; idempotencyKey: string }) => Promise<{ run: JobRun }>;
}
/** Bounded batches keep a busy inbox inside the worker's established output
 * contract. Each batch has its own durable job receipt under one clock run. */
export async function runMorningMailWorkflow(run: LoopRun, deps: Dependencies): Promise<LoopExecuteResult> {
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
    const result = await deps.execute(recipe, { mode: 'prepare', trigger: run.manual ? 'manual' : 'schedule', scheduledFor: run.scheduledFor,
      loopRunId: run.id, idempotencyKey: `morning-mail:${run.id}:${source.id}:${batch}` });
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
