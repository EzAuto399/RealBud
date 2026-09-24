# Browser task authority — owner decision, 23 September 2026

Status: accepted by the owner in conversation on 23 September 2026. Supersedes the portal rule
"Bud reads and prefills; Submit is a per-instance ask only on opted-in jobs; pay/sign/notice/send
never" in `CLAUDE.md` and `docs/PORTAL-WORK.md`. This record is the direction; the implementation
below is not built yet and no part of it is customer-proven.

## Decision

RealBud's target is full browser task completion in the person's selected, signed-in browser
session. The browser fence is permission enforcement, not a capability limit.

1. **The person signs in; Bud uses that session.** The browser keeps the cookies. Bud works on the
   signed-in site without reading or receiving cookie values or passwords. When a login or MFA
   expires, Bud hands that step back to the person and resumes after it.
2. **Full browser actions.** Navigate, click, type, search, read, download, upload, fill forms and
   submit authorised work.
3. **The request authorises the task.** "Download this month's invoices" lets Bud take the steps
   needed without asking about every click. "Submit this maintenance request" authorises that
   specific submission.
4. **Consequential actions need explicit approval of the actual action.** A payment shows the real
   recipient and amount; signing, sending and legal notices show the exact document or message.
   These actions are approval-gated, no longer permanently removed.
5. **One set of rules on every route.** Ask, a delegated worker, a scheduled job, or any browser
   tool uses the intended account, stays inside the task's scope, and honours Stop. A browser path
   that bypasses these controls is not allowed, which is why Hermes' own browser and credential
   vault tools are kept out of the worker: they would operate outside account scope, task
   permission and Stop.

## What stays true

Nothing is paid, signed, sent or filed without the person's explicit approval of that instance.
Credentials never pass through Bud or its model. Every browser action is recorded against the task
that authorised it. Stop ends the task on every route.

## What this changes next

- The fenced browser (`server/portal-fence.ts`, `server/browser-runtime.ts`, attended runs) grows
  from read/prefill to the full action set, with task-level scopes (sites, account, action classes)
  and per-instance approvals for consequential actions.
- Ask and delegated workers reach browser work only through RealBud's broker, with the same scope
  and Stop.
- `CLAUDE.md` and `docs/PORTAL-WORK.md` point here; the old "never" list becomes an
  "approval required" list.
