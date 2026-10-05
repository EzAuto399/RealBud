# REI Cloud as source of truth, daily refresh, signed client packs (owner, 2026-10-06)

**Decision.** REI Cloud is RealBud's source of truth for property, tenancy, owner and ledger facts. Bud refreshes Desk from REI Cloud every morning, read-only. The REI know-how ships as a signed, installable and exportable client pack.

## Rules
1. **Precedence: REI wins; Desk edits are held.** A refresh updates every field REI provides. A field a person changed in Desk is never silently overwritten. It is held as "Differs from REI: <REI value> vs <Desk value>" until a person picks one. Every field records its source (REI / Desk / import) and `observedAt`.
2. **Daily refresh is read-only and unattended.** A morning loop runs only read recipes (tenants, arrears, ledger, tasks due) in the person's already signed-in REI session.
   - If the session is signed out or expired, the loop records "Missed: sign in to REI" and leaves Desk marked stale. It never shows old data as fresh, and Bud never signs in.
   - Anything that writes to REI (upload, receipt, notice, payment) still needs per-instance approval showing the real recipient, amount or content, as `docs/decisions/2026-09-23-browser-task-authority.md` requires.
   - Loops stay off until the office enables them.
3. **New properties are proposed, not added.** A property REI shows that Desk doesn't have becomes a card (address, tenant, owner, rent). One click adds it.
4. **Client pack contents.** A pack ships:
   - workflows, recipes and the REI site map
   - office settings: REI business code, column mappings, and loop schedules, which stay off on install
   - a RealBud publisher signature, verified before install

   It **never** includes client data, credentials, sessions or ledgers. Export of an installed pack strips office-specific secrets and data.
5. **Signing key custody.** The publisher private key lives outside the repo, outside customer storage and outside Hermes storage. Only the public key is pinned in the app. A pack that fails verification is refused, with a plain message.

## Unchanged
- Bud reaches REI only through the person's signed-in browser session. Credentials never pass through Bud. There is no REI API until REI grants one (`docs/decisions/2026-09-24-rei-browser-first-api-when-approved.md`).
- Live REI reads against a real client account need that client's written authority. Development and QA use the fictional REI portal (`server/testing/fictional-rei-portal.ts`) only.

## Build order
See `docs/REI-SOURCE-OF-TRUTH-PLAN-2026-10-06.md`.
