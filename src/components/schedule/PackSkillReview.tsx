import { InstructionComparison } from './InstructionComparison';
import type { PackSkillProposal, PackSkillRevisionMetadata, PackSkillHistorySummary } from '@shared/customer-packs';
import { PackSkillHistory } from './PackSkillHistory';

export interface PackSkillReviewState {
  proposals: PackSkillProposal[];
  revisions: PackSkillRevisionMetadata[];
  skillHistories: PackSkillHistorySummary[];
  hasMore: boolean;
  pendingUpgrades: { packId: string; digest: string }[];
  learning: { supported: boolean; policyReady: boolean; enabled: boolean };
}
const button = 'min-h-11 rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';

export function PackSkillReview({ state, busy, mutate, run, reload, notice }: {
  state: PackSkillReviewState; busy: boolean;
  mutate: (route: string, body: unknown, notice: string) => void;
  run: (work: () => Promise<void>) => Promise<void>;
  reload: () => Promise<void>; notice: (message: string) => void;
}) {
  return <section aria-label="Review Bud instruction improvements" className="space-y-3 border-t border-line pt-4">
    <h3 className="font-medium">Bud’s instruction improvements</h3>
    <p className="text-sm text-ink-secondary">Suggestions stay pending until you review them. Applying or reverting instructions pauses this pack’s plans, removes their approval and turns schedules off. Review the plans again before running them. Original pack instructions and revision history are retained.</p>
    <p className="text-sm text-ink-secondary">Only this pack’s instruction text can be approved here. Memory, other skills and scripts need separate service review.</p>
    <p className="text-sm">{!state.learning.supported ? 'Background suggestions need the supported managed worker version. Update Bud, restart it, then re-apply its profile in Settings.' : !state.learning.policyReady ? 'The worker’s instruction review safeguards need repair. Re-apply its profile in Settings before using background suggestions.' : !state.learning.enabled ? 'Instruction review safeguards are ready. Background suggestions are off; re-apply the worker profile in Settings to enable them on this supported worker.' : 'Background instruction suggestions are enabled with review required. This setting does not prove a model run or business result.'}</p>
    {state.pendingUpgrades.map(upgrade => <div key={upgrade.packId} role="alert" className="rounded border border-line p-3 space-y-2"><p className="text-sm">An approved instruction update for {upgrade.packId} was interrupted. Dependent work remains held until recovery finishes.</p><button className={button} disabled={busy} onClick={() => mutate(`/api/customer-packs/${upgrade.packId}/recover-instructions`, { expectedDigest: upgrade.digest }, 'The approved instruction update was recovered. Review the paused plans again.')}>Recover approved instruction update</button></div>)}
    {!state.proposals.length && <p className="text-sm text-ink-secondary">No pending instruction suggestions for review.</p>}
    {state.proposals.map(proposal => <article key={`${proposal.id}-${proposal.pendingDigest}`} className="rounded border border-line p-3 space-y-3">
      <div><h4 className="font-medium">{proposal.name}</h4><p className="mt-1 text-xs text-ink-secondary">{proposal.origin} · proposal {proposal.id}{proposal.packId ? ` · ${proposal.packId} / ${proposal.skillId} / SKILL.md` : ''}</p></div>
      <p className="text-sm">{proposal.reason}</p>
      {proposal.state === 'reviewable' && proposal.current !== null && proposal.proposed !== null && <details><summary className="min-h-11 cursor-pointer text-sm">Review active revision {proposal.activeRevision} and proposed text</summary><div className="space-y-3"><InstructionComparison current={proposal.current} proposed={proposal.proposed} /><p className="text-sm">This changes only this pack’s instruction text. It grants no new tools, account access, sending or payment authority.</p><div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={() => mutate('/api/customer-packs/skill-proposals/review', { id: proposal.id, pendingDigest: proposal.pendingDigest, currentDigest: proposal.currentDigest, decision: 'approve' }, 'Reviewed instructions are active. Dependent plans are paused and need fresh approval.')}>Apply reviewed instructions and pause plans</button><button className={button} disabled={busy} onClick={() => mutate('/api/customer-packs/skill-proposals/review', { id: proposal.id, pendingDigest: proposal.pendingDigest, currentDigest: proposal.currentDigest, decision: 'reject' }, 'Suggestion rejected. Active instructions are unchanged.')}>Reject suggestion</button></div></div></details>}
    </article>)}
    {state.hasMore && <p className="text-sm text-hold">More than 100 pending records exist. Service review is needed to reduce the backlog; no hidden record was approved.</p>}
    {!!state.skillHistories?.length && <details><summary className="min-h-11 cursor-pointer text-sm">Instruction revision history and revert</summary><div className="space-y-3">{state.skillHistories.map(summary => <PackSkillHistory
      key={[summary.packId, summary.skillId, summary.installedDigest, summary.installedRevision, summary.activeRevision, summary.activeDigest, summary.head, summary.pendingArchive?.expectedPreviewDigest].join('/')}
      summary={summary} busy={busy} run={run} reload={reload} notice={notice} />)}</div></details>}
  </section>;
}
