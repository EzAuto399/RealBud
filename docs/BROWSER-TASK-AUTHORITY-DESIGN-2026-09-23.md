# Browser task authority — design, 23 September 2026

What this does not establish: nothing below is built yet except where a slice says so. Source
reading only; no customer or live portal run. Direction: [owner decision](decisions/2026-09-23-browser-task-authority.md).

## Today (source, 23 September)

- Browser work runs only in attended saved jobs; plain Ask has no browser; prepare jobs get none.
- Navigate is same-origin; read after a confirmed tab borrow; fill needs `portal-prefill` and never
  touches password/OTP/BSB/card fields; every click asks; submit asks once on opted-in jobs.
- Pay/sign/send/notice are hard-denied (`server/portal-fence.ts:38`, `server/browser-broker.ts:27`,
  `server/attended-run.ts:155`), with no approval path.
- Two evaluators can drift: the broker decides without site rules, `server/index.ts` re-decides
  with rules. Evidence per action is a short phrase; pending approvals live in memory.
- No upload, no keys/Enter, downloads not captured, one browser profile per install, login
  handoff restarts one step instead of resuming.
- Stop exists on the attended route (interrupt → broker close; browser stop).

## Model

- **Task grant** (`shared/browser-task.ts`, versioned, `exact()` validator): id, run, route
  (ask/job/schedule/recovery), request text and hash, sites, selected browser and account marker,
  action classes (read, navigate, fill, click, download, upload, keys, submit), consequential
  policy fixed to `ask-each` for pay/sign/send/notice/delete/account-change, allowed upload files,
  expiry, action budget. Legacy `portal-*` capabilities map onto it.
- **Classifier** (`classifyBrowserAction`) → routine | consequential(kind) | credential |
  out-of-scope | unknown, from the observed control and page (amounts, payee, recipients,
  signature and notice words), URL and tool arguments. Site rules can only add strictness.
  Anything uncertain asks. Credential fields stay denied.
- **Approval record**, persisted before the card shows: kind, site, control, verified facts
  (recipient, amount, currency, reference | document title + hash | to, subject, body hash),
  observation hash, short expiry, decision. Facts the page does not confirm cannot be approved.
  The broker re-observes before dispatch and requires the same facts and control.
- **One enforcement point**: `authorizeBrowserAction` in `server/browser-authority.ts`, called by
  the broker; `server/index.ts` only displays the broker's decision.
- **Routes**: Ask asks for a task grant (sites, account, actions, expiry) and then uses the same
  broker; delegated children use the parent's broker or get no browser; Hermes' own browser stays
  refused.
- **Stop**: persisted revocation, then broker close, turn interrupt and runtime release; a revoked
  grant never restarts after a restart.
- **Action log**: time, grant, run, tool, origin, path, label, class, decision, field, value hash,
  outcome, read-back hash — redacted.

## Slices

1. Grant and classifier (pure) — local tests.
2. Broker enforces the authority; persisted approvals; consequential = approval, not deny — local tests.
3. Approval card and Stop in the UI — rendered fixture.
4. Fictional pay/send form on the real helper — local helper + Playwright.
5. Ask one-off grants — local tests.
6. Keys, download capture with hash, upload of granted files — depends on helper support.
7. Login resume with the remaining grant; delegated-child broker check — local tests.
8. Docs (`PORTAL-WORK.md`) after 1–3.

Must stay true: no credentials through the model; no silent consequential action (approvals are
once-only, bound to the observation, never rules or session-wide); an unknown outcome of a
consequential action is never replayed; scheduled browser tasks stay attended until the owner
decides otherwise.
