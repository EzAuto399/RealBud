// The pack's plain plan for one Schedule job. The setup steps themselves live
// in Desk's Get started card; each job keeps its own "Needs" list here.
import type { AustinPackView } from "@shared/austin-pack";

/** The pack's plain plan for one workflow, shown in its job details. */
export function AustinPlanDetail({ view, loopId }: { view: AustinPackView | null; loopId: string }) {
  const item = view?.installed ? view.loops.find(loop => loop.loopId === loopId) : undefined;
  if (!item) return null;
  const rows: Array<[string, string]> = [["Reads", item.plan.reads], ["Waits for", item.plan.waitsFor], ["Tells", item.plan.notifies], ["Approval", item.plan.approval]];
  const needs = item.needs.flatMap(id => view!.checklist.filter(check => check.id === id));
  return (
    <section aria-label="What this job does" className="border-t border-line pt-3">
      <h3 className="text-[14px] font-medium text-ink">What this job does · {item.owner}</h3>
      {item.note ? <p className="mt-1 text-[13px] text-ink-muted">{item.note}</p> : null}
      <dl className="mt-2 grid gap-x-3 gap-y-1.5 text-[13px] min-[720px]:grid-cols-[8rem_1fr]">
        {rows.map(([term, text]) => <div key={term} className="contents"><dt className="text-ink-muted">{term}</dt><dd className="text-ink-secondary">{text}</dd></div>)}
        {needs.length ? <div className="contents"><dt className="text-ink-muted">Needs</dt><dd>
          <ul className="space-y-1">{needs.map(check => (
            <li key={check.id} className="text-ink-secondary">{check.done ? "Done: " : "Not yet: "}{check.label}{check.done ? "" : `. ${check.detail}`}</li>
          ))}</ul>
        </dd></div> : null}
      </dl>
    </section>
  );
}
