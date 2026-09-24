import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { SkillArchiveReview, SkillRevertReview } from './PackSkillHistory';
import type { PackSkillArchivePreview, PackSkillRevertPreview } from '@shared/customer-packs';
const revision = { packId: 'office-core', skillId: 'inbox-review', revision: 1, digest: 'a'.repeat(64), active: false, createdAt: '2026-09-22T00:00:00Z', reason: 'Original reviewed instructions' };
const archive: PackSkillArchivePreview = { packId: revision.packId, skillId: revision.skillId, name: 'Inbox review', installedDigest: 'b'.repeat(64), installedRevision: 1, activeRevision: 3, activeDigest: 'c'.repeat(64), head: null, previewDigest: 'd'.repeat(64), archive: [revision], keep: [{ ...revision, revision: 2 }, { ...revision, revision: 3, active: true }], archivedRevisions: 0, conflicts: [], canArchive: true };
const revert: PackSkillRevertPreview = { ...archive, selection: { installationRevision: 1, head: null, sourceDigest: 'e'.repeat(64), revision: 1, digest: revision.digest }, reviewDigest: 'f'.repeat(64), current: 'Current instructions\n  Keep indentation.', proposed: '<script>fictional literal instruction</script>\n' + 'Retained complete text.\n'.repeat(1800) + 'Last saved line.', target: revision, canRevert: true };
const callbacks = { busy: false, apply: () => {}, cancel: () => {} };
describe('reviewed instruction history controls', () => {
  it('shows full escaped saved text and requires a separate confirmation before reverting and pausing plans', () => {
    const html = renderToStaticMarkup(createElement(SkillRevertReview, { ...callbacks, preview: revert }));
    expect(html).toContain('&lt;script&gt;fictional literal instruction&lt;/script&gt;'); expect(html).not.toContain('<script>');
    expect(html).toContain('Last saved line.'); expect(html).toContain('Current instructions\n  Keep indentation.');
    expect(html).toContain('clears their approval and turns schedules off'); expect(html).toMatch(/disabled=""[^>]*>Confirm reviewed revert and pause plans/);
  });
  it('shows the archive boundary, keeps confirmation disabled initially and exposes conflicts', () => {
    const html = renderToStaticMarkup(createElement(SkillArchiveReview, { ...callbacks, preview: archive }));
    expect(html).toContain('Move 1 older revision'); expect(html).toContain('Revision 3 · Active');
    expect(html).toContain('Current instructions, plan approvals, schedules and saved work stay in place.'); expect(html).toMatch(/disabled=""[^>]*>Archive reviewed instruction history/);
    const blocked = renderToStaticMarkup(createElement(SkillArchiveReview, { ...callbacks, preview: { ...archive, canArchive: false, conflicts: ['Finish the interrupted pack change first.'] } }));
    expect(blocked).toContain('Finish the interrupted pack change first.'); expect(blocked).toMatch(/type="checkbox"[^>]*disabled=""/);
    const heldRevert = renderToStaticMarkup(createElement(SkillRevertReview, { ...callbacks, preview: { ...revert, canRevert: false, conflicts: ['The instruction file has local edits.'] } }));
    expect(heldRevert).toContain('The instruction file has local edits.'); expect(heldRevert).toMatch(/type="checkbox"[^>]*disabled=""/);
  });
});
