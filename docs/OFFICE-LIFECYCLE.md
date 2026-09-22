# Office lifecycle: setup → weekday → offboarding

The one path an office walks, and what RealBud does at each end of it. Two ends
are easy to get wrong, so they are stated first.

- **Setup must not invent obstacles.** The office contract has eight fields.
  Only two change what the desk can do.
- **Offboarding must revoke, not hide.** Deleting access locally while the
  office's Google/Microsoft grants stay live is not an offboarding.

## The contract this is built on

`officeTicks()` in `shared/office.ts` is the single list of office fields. It is
eight: agency+PM, PMS brand, exporter, cadence, identity column, office OS,
jurisdictions, vendor test account.

Nothing may define a second list. The walkthrough labels and groups the contract
`officeTicks` already owns, so it cannot drift from the form that satisfies it.

## Setup (the walkthrough)

`src/lib/office-setup.ts` derives the walkthrough from the contract and the book.

| Field | Asked for? | Why |
|---|---|---|
| `agency-pm` | **essential** | Without a named agency and contact the book is still the demo |
| `jurisdictions` | **essential** | Location-specific rules cannot apply without states on the book |
| `pms-brand` | optional | A reference label; choosing software connects nothing |
| `exporter`, `cadence`, `identity` | optional | Belong to the CSV import that needs them |
| `vendor-test` | optional | Only during an assisted portal trial |
| `office-os` | **never asked** | The app derives the platform it runs on |

`complete` means *every essential is done*, not *all eight are done*. An office
that has named itself and placed its properties has a working desk. Demanding
eight would misreport that office as unfinished forever.

Surfaces:

- `You → This office` renders a **Finish setting up this office** strip listing
  only the outstanding essentials, each a button that opens that form group.
  It disappears once the essentials are done.
- `GoLiveCard` (`src/components/desk/GoLiveCard.tsx`) is the readiness card on
  Desk and You. Its agency row now stays open until the office contract's
  essentials are filled, and names which field is still empty.

`src/lib/go-live.ts` owns export + worker and borrows `officeSetup` for the agency
row, so there is one office model rather than two.

### Guards (mutation-tested)

- **No drift.** A test asserts the walkthrough names exactly the contract's
  fields, and that each label is the contract's own wording. Adding a field to
  `officeTicks` without surfacing it fails the suite.
- **No dead links.** A test reads `OfficeCard.tsx` and asserts every group id the
  walkthrough links to is actually rendered. Renaming a form group without
  updating `office-setup.ts` fails the suite.

Both were verified by deliberately breaking them and watching the tests fail.

## Weekday

`docs/PM-DAY.md` and `docs/SCHEDULE-STABILITY-REVIEW.md` own this. Setup does not
gate it: the sample book works before a real agency is named.

## Offboarding (end of life)

`server/composio-project.ts` talks to the Composio **organisation** surface
(`x-org-api-key`), not the project surface. One office = one Composio project.

| Step | Call | Effect |
|---|---|---|
| Provision | `POST /org/owner/project/new` | New project + `ak_…` key for that office's desk |
| Rotate | `POST …/{pr_…}/regenerate_api_key` | **Every existing key stops immediately** |
| Inspect | `GET …/project/{pr_…}`, `GET …/project/list` | Identify which project is which office |
| Decommission | `DELETE …/{pr_…}?revoke_on_delete=true` | Deletes the project **and revokes the upstream credentials of every connection** |

The delete is the only call in the product that actually revokes the office's
OAuth grants at the provider. It is therefore **fail-closed**: it reports success
only on HTTP 200 with `status:"success"` and a non-empty `revoke_job_id`, is never
retried, and throws otherwise. A partial success would tell an operator that
client access was revoked when it was not.

### Operator tool

`scripts/manage-composio-projects.mjs`, via `pnpm composio:projects`. Trusted
operator tooling: never exposed over HTTP, never run from the desk app, because
the organisation key can act on every office at once.

```
REALBUD_COMPOSIO_ORG_KEY=… pnpm composio:projects list
REALBUD_COMPOSIO_ORG_KEY=… pnpm composio:projects provision --name "Harbour PM"
REALBUD_COMPOSIO_ORG_KEY=… pnpm composio:projects rotate --project pr_… --confirm
REALBUD_COMPOSIO_ORG_KEY=… pnpm composio:projects decommission --project pr_… --confirm --revoke-upstream
```

- `provision` prints the `ak_` key **once**, because that is the only time
  Composio returns it. The key is never written to disk or a log, and `list`
  never prints keys.
- `decommission` needs **both** `--confirm` and `--revoke-upstream`. Without the
  second flag the project would be deleted while the office's upstream grants
  stayed live, which is not a real offboarding, so the tool refuses.

### Base URL seam

`REALBUD_COMPOSIO_API_BASE` points the module at a fixture server. It is a test
and self-hosted seam, not a user setting: nothing in the desk UI, the office
config or a request body can write it, and a value that is set but unusable fails
closed rather than quietly falling back to Composio.

## Retention and the wind-down (in progress)

`retentionDays` is the office's own window, **not a statutory period**. RealBud
must never invent a legal clock, so the default is an operational choice the
office can change, and `null` means keep until a person decides.

`shared/office.ts` now owns `DEFAULT_RETENTION_DAYS` (90), a floor of
`MIN_RETENTION_DAYS` (7) and a ceiling of `MAX_RETENTION_DAYS` (3650), plus
`parseRetentionDays`. The floor is a safety property, not a preference: the
number decides when a book becomes unreadable, so a typo of `0` must fail rather
than mean "destroy now".

`src/lib/office-wind-down.ts` sequences a closed office:

    open -> stopped -> exported -> archived -> destroyed

- Stages cannot be **skipped** (archiving a book that was never exported would
  claim work that was not done) and cannot **rewind**.
- `closedAt` is recorded when work stops, not when the last stage runs, so the
  retention window is measured from the right moment.
- `destructionEligibility` computes whether the key may be destroyed. It fails
  closed at every branch: an unparseable window is not zero, an unarchived book
  is never eligible however long ago it closed, and `null` retention never
  destroys on a timer.

Why a key and not a delete: the book is AES-256-GCM (`server/desk-crypto.ts`)
and its key is wrapped by the OS keychain and passed in as `REALBUD_DESK_KEY`
(`electron/main.mjs:151-196`), so in production the key is not on disk. Ending an
office means destroying that one key — which is verifiable, unlike trusting a
recursive delete.

### Honest state of this

- **Built and tested:** the retention validator (6 tests) and the wind-down
  sequence and eligibility guard (13 tests, with the archive-before-destroy
  guard mutation-tested).
- **Not built:** persistence of a wind-down stage, an operator command to
  destroy the key, and any pruning by age. Verified: nothing in the server
  prunes by age today, so `retentionDays` is currently read only to be
  displayed. A UI control for it would therefore be a knob that does nothing,
  which is why there is not one yet. It is deliberately absent rather than
  half-wired.

## Department access administration (2026-09-21)

You → Company setup → Departments and access lets the current office owner
create explicitly identified departments and give active members read-only,
read-and-edit, or no access to department records. Members see only departments
they can access. These settings govern shared company records; each installation
keeps its private Bud, browser accounts, Desk, conversations and schedules.
They do not start or move work between computers.

The host checks current membership and ownership on every request. Access edits
use a saved revision; a stale or uncertain change requires a refresh, not an
automatic retry. Removing edit access holds any active department claim for
review. Ownership transfer moves administration to the new office owner without
exposing private scopes. The GUI discards cached department authority when the
signed-in member's role changes. Changes made on another computer are checked
when the person presses Refresh departments; displayed access is a snapshot.

This release provides department access administration and a paged case review
screen. The current office owner can reconcile expired or revoked claims with a
mandatory review note, expected fence and durable request receipt. Recovery
invalidates the old token before recording completion or releasing fresh work;
it cannot take over a live claim. Ownership transfer also fences claims that lose
implicit department write access. Reviewed handoffs remain on Desk → Shared work.

The department screen does not yet create or assign cases, launch workers, rename,
retire or delete departments. Existing generic scopes and reviewed handoffs are
not automatically converted into department cases. Those lifecycle extensions
need their own authority, migration and recovery acceptance.

Verification covers real PostgreSQL isolation, ownership changes, revocation,
stale edits and recovery holds, plus authenticated routes over pinned TLS and
client response validation. Installed-device and real-office acceptance remain
separate delivery checks.

## Not built yet

- Website-triggered provisioning on client onboarding. The tool is operated by
  hand; the module is ready to be called from a server route when the org key has
  a decided home and the client key hand-off has a decided path.
- Client-leaving checklists beyond Composio: harness/MCP teardown and local
  office-data retention are still open (`docs/GRADUATE-RELEASE.md`).
- Backfill/restore of a deleted project. Deletion is irreversible by design.

## Verification

```
npx vitest run src/lib/office-setup.test.ts src/lib/go-live.test.ts
npx vitest run server/composio-project.test.ts server/composio-projects-cli.test.ts
```

The CLI suite drives the real script as a child process against a local fake
Composio, so the gates are tested as an operator experiences them.
