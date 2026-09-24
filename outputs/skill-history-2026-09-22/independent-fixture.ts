import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CustomerPack, CustomerPackChangePreview } from '../../shared/customer-packs.ts';
import { createCustomerPackService } from '../../server/customer-packs.ts';

export const reviewRoots: string[] = [];
export const reviewPack = (): CustomerPack => ({
  format: 'realbud-customer-pack', version: 1, id: 'review-office', revision: 1,
  title: 'Fictional independent review office',
  recipes: [{ id: 'wf-review-inbox', title: 'Read supplied fictional inbox', description: 'Fictional review description.',
    steps: ['Read the supplied fictional source.'], evidence: 'Supplied source references.',
    capabilities: ['read-files', 'analyse', 'draft'], limits: { maxRuntimeMinutes: 2, maxTurns: 6 },
    siteNotes: null, schedule: null, allowedOrigins: [] }],
  workflows: [{ id: 'inbox', title: 'Review fictional sources', recipeIds: ['wf-review-inbox'], checks: ['input-coverage'] }],
  skills: [{ id: 'review-guidance', name: 'Fictional review guidance', description: 'Read fictional supplied source.',
    instructions: '# Fictional guidance\nPreserve the supplied evidence.\n', license: 'Fictional test license.' }],
  dependencies: { runtime: 'hermes-property', mode: 'supplied-source-preparation', schedules: 'off', permissions: 'local-review-required' },
});
export const packChangeRequest = (p: CustomerPackChangePreview) => ({ pack: p.pack, expectedInstalledDigest: p.installedDigest,
  expectedInstalledRevision: p.installedRevision, expectedDigest: p.digest, expectedPreviewDigest: p.previewDigest });
export async function reviewFixture(initial = reviewPack()) {
  const root = await mkdtemp(join(realpathSync(tmpdir()), 'rb-independent-skill-history-')); reviewRoots.push(root);
  let selectedProfile = join(root, 'profile'), selectedWorkroom = join(root, 'vault');
  const options = { directory: root, profileDirectory: () => selectedProfile, workroomDirectory: () => selectedWorkroom,
    learningStatus: () => ({ supported: true, policyReady: true, enabled: true }) };
  const service = createCustomerPackService(options), preview = await service.preview(initial);
  await service.install(initial, preview.digest);
  const native = join(root, 'profile', 'skills', `realbud-${initial.id}-${initial.skills[0].id}`, 'SKILL.md');
  const journalPath = join(root, 'customer-packs.json');
  return { root, initial, options, native, journalPath, service,
    reopen: () => createCustomerPackService(options),
    changeProfile: () => { selectedProfile = join(root, 'other-profile'); },
    changeWorkroom: () => { selectedWorkroom = join(root, 'other-vault'); },
    originalScope: () => { selectedProfile = join(root, 'profile'); selectedWorkroom = join(root, 'vault'); },
    journal: async () => JSON.parse(await readFile(journalPath, 'utf8')),
    nativeText: () => readFile(native, 'utf8'),
    route: (action: string) => `/api/customer-packs/${initial.id}/${action}`,
  };
}
export async function stageReviewProposal(root: string, content: string, id = '1234abcd') {
  const directory = join(root, 'profile', 'pending', 'skills'); await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, `${id}.json`), JSON.stringify({ id, subsystem: 'skills', action: 'edit',
    summary: 'Fictional independent review suggestion', origin: 'background_review', created_at: '2026-09-22T00:00:00Z',
    payload: { action: 'edit', name: 'realbud-review-office-review-guidance', content, replace_all: false } }), { mode: 0o600 });
}
export async function clearReviewRoots() {
  for (const root of reviewRoots.splice(0)) await rm(root, { recursive: true, force: true });
}
