import type { ReactNode } from "react";

/** The same small reference follows a task; status describes this reference,
 * never grants permission or claims that old evidence is still current. */
export function WorkContextCard({ title, detail, status, children }: { title: string; detail: string; status: string; children?: ReactNode }) {
  return <section className="workspace-work-context" aria-label="Work context">
    <div><strong>{title}</strong><span className="workspace-context-status">{status}</span></div>
    <p>{detail}</p>
    {children}
  </section>;
}
